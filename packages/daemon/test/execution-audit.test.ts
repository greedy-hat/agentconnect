import { describe, expect, it } from 'vitest'
import { openTestStore } from './store-support.js'
import { DaemonAuditRecorder } from '../src/execution/audit-recorder.js'
import {
  StandingWorkPump,
  StandingWorkService,
  type FixedStandingWorkDefinition
} from '../src/execution/standing-work.js'
import type { DurableAuditEvent } from '../src/execution/governance.js'
import type {
  LocalStore,
  StandingWorkNotificationRow,
  StandingWorkRow,
  StandingWorkRunRow
} from '../src/store/local-store.js'

const workRow = {
  orgId: 'org',
  workId: 'work-1',
  agentId: 'agent-1',
  principalId: 'principal-1',
  name: 'watch',
  objective: 'observe',
  state: 'active',
  definitionVersion: 1,
  schedule: '* * * * *',
  timezone: 'UTC',
  scheduleMode: 'fixed',
  maxIntervalSeconds: 86_400,
  targetDestination: 'dest',
  expiresAt: 10 ** 12,
  maxRunsPerDay: 3,
  maxNotificationsPerDay: 2,
  approvalVersion: 1,
  approvalState: 'approved',
  authorizationRevision: 7,
  createdAt: 1,
  updatedAt: 1
} as unknown as StandingWorkRow

const runRow = {
  orgId: 'org',
  workId: 'work-1',
  runId: 'run-1',
  definitionVersion: 1,
  occurrenceId: '1:1000',
  dueAt: 1000,
  executionEpoch: 3,
  attempt: 1,
  status: 'running',
  startedAt: 1000,
  finishedAt: null,
  outcome: null,
  sessionId: null,
  budgetReservationId: null,
  errorCode: null,
  wakeSource: 'scheduled',
  suggestedNextCheckAt: null
} as unknown as StandingWorkRunRow

const notificationRow = {
  orgId: 'org',
  workId: 'work-1',
  runId: 'run-1',
  notificationIndex: 0,
  effectId: 'effect-1',
  definitionVersion: 1,
  authorizationRevision: 7,
  destination: '{"integrationId":"i-1","channel":"C1"}',
  payload: 'prod is down',
  payloadHash: 'hash-1',
  status: 'sending',
  attempt: 1,
  nextAttemptAt: null,
  providerReceipt: null,
  lastError: null
} as unknown as StandingWorkNotificationRow

/** Everything the outbox holds for one org, parsed back into events. */
async function flushed(store: LocalStore): Promise<Array<{ eventId: string; event: DurableAuditEvent }>> {
  return (await store.pendingExecutionAudit('org', 50)).map((row) => ({
    eventId: row.eventId,
    event: row.event as DurableAuditEvent
  }))
}

/** The outbox orders by timestamp then id, so tests identify events by shape rather than by position. */
const eventShapes = (rows: Array<{ event: DurableAuditEvent }>): string[] =>
  rows
    .map((row) => `${row.event.kind}:${typeof row.event.details?.phase === 'string' ? row.event.details.phase : '-'}`)
    .sort()

const definition = (now: number): FixedStandingWorkDefinition => ({
  orgId: 'org',
  agentId: 'agent-1',
  principalId: 'principal-1',
  actorId: 'actor-1',
  name: 'watch',
  objective: 'observe',
  schedule: '* * * * *',
  timezone: 'UTC',
  targetDestination: '{"integrationId":"i-1","channel":"C1"}',
  expiresAt: now + 3_600_000,
  authorizationRevision: 7
})

describe('DaemonAuditRecorder', () => {
  it('writes nothing while the operator gate is off', async () => {
    const store = await openTestStore()
    try {
      const recorder = new DaemonAuditRecorder(store, () => false)
      expect(await recorder.recordAdmission(workRow, runRow)).toBeNull()
      expect(await recorder.recordEffectIntent(workRow, notificationRow)).toBeNull()
      expect(await recorder.recordEffectResult(workRow, notificationRow, 'delivered')).toBeNull()
      expect(await flushed(store)).toEqual([])
    } finally {
      await store.close()
    }
  })

  it('records an admission carrying the full causal envelope', async () => {
    const store = await openTestStore()
    try {
      const recorder = new DaemonAuditRecorder(
        store,
        () => true,
        () => 5_000
      )
      const eventId = await recorder.recordAdmission(workRow, runRow)
      expect(eventId).toMatch(/^[0-9a-f]{64}$/)
      const [row] = await flushed(store)
      expect(row?.eventId).toBe(eventId)
      expect(row?.event).toEqual({
        eventId,
        kind: 'admission',
        occurredAt: 5_000,
        provenance: {
          orgId: 'org',
          agentId: 'agent-1',
          principalId: 'principal-1',
          authorizationRevision: 7,
          workId: 'work-1',
          runId: 'run-1',
          executionEpoch: 3,
          traceId: DaemonAuditRecorder.traceId('run-1')
        },
        details: {
          workId: 'work-1',
          definitionVersion: 1,
          occurrenceId: '1:1000',
          attempt: 1,
          wakeSource: 'scheduled',
          scheduleMode: 'fixed'
        }
      })
      // An ambient run has no session when it is admitted, so the record says nothing rather than guessing.
      expect(JSON.stringify(row?.event)).not.toContain('sessionId')
    } finally {
      await store.close()
    }
  })

  it('is idempotent across instances: a retried attempt rewrites one row', async () => {
    const store = await openTestStore()
    try {
      const first = await new DaemonAuditRecorder(store, () => true).recordAdmission(workRow, runRow)
      // A different process, a re-claimed fence: the id comes from persisted facts, not from this instance.
      const second = await new DaemonAuditRecorder(store, () => true).recordAdmission(workRow, {
        ...runRow,
        status: 'pending'
      } as StandingWorkRunRow)
      expect(second).toBe(first)
      const rows = await flushed(store)
      expect(rows).toHaveLength(1)
      // A new epoch is a genuinely different attempt, so it is a new event.
      expect(
        await new DaemonAuditRecorder(store, () => true).recordAdmission(workRow, {
          ...runRow,
          executionEpoch: 4
        } as StandingWorkRunRow)
      ).not.toBe(first)
      expect(await flushed(store)).toHaveLength(2)
    } finally {
      await store.close()
    }
  })

  it('links a delivery result to its intent and records the destination, never the payload', async () => {
    const store = await openTestStore()
    try {
      const recorder = new DaemonAuditRecorder(store, () => true)
      const intent = await recorder.recordEffectIntent(workRow, notificationRow)
      const result = await recorder.recordEffectResult(workRow, notificationRow, 'uncertain', {
        error: 'provider timeout',
        intentEventId: intent ?? undefined
      })
      const rows = await flushed(store)
      expect(rows).toHaveLength(2)
      const intentRow = rows.find((row) => row.eventId === intent)
      const resultRow = rows.find((row) => row.eventId === result)
      expect(intentRow?.event.details).toMatchObject({ phase: 'intent', payloadHash: 'hash-1' })
      // The causal ids are the event's own, so the ingest can index them without reading details.
      expect(intentRow?.event.effectId).toBe('effect-1')
      expect(intentRow?.event.parentEventId).toBeUndefined()
      expect(resultRow?.event.effectId).toBe('effect-1')
      expect(resultRow?.event.parentEventId).toBe(intent)
      expect(resultRow?.event.details).toMatchObject({
        phase: 'result',
        status: 'uncertain',
        error: 'provider timeout'
      })
      // Both belong to the run's trace, so a search on one traceId returns the whole attempt.
      expect(new Set(rows.map((row) => row.event.provenance.traceId)).size).toBe(1)
      expect(JSON.stringify(rows)).not.toContain('prod is down')
    } finally {
      await store.close()
    }
  })

  it('refuses to record a subject it cannot attribute', async () => {
    const store = await openTestStore()
    try {
      const recorder = new DaemonAuditRecorder(store, () => true)
      expect(await recorder.recordAdmission({ ...workRow, principalId: '' } as StandingWorkRow, runRow)).toBeNull()
      expect(await recorder.recordAdmission(workRow, { ...runRow, runId: '' } as StandingWorkRunRow)).toBeNull()
      expect(await flushed(store)).toEqual([])
    } finally {
      await store.close()
    }
  })

  it('loses an audit row rather than throwing into the swept work', async () => {
    const recorder = new DaemonAuditRecorder(
      {
        appendExecutionAudit: async () => {
          throw new Error('disk gone')
        }
      },
      () => true
    )
    expect(await recorder.recordAdmission(workRow, runRow)).toBeNull()
  })
})

describe('standing work pump audit sites', () => {
  const buildPump = (store: LocalStore, service: StandingWorkService, now: () => number, audit?: DaemonAuditRecorder) =>
    new StandingWorkPump(
      store,
      service,
      'daemon-a',
      {
        execute: async () => ({
          report: { outcome: 'notify' as const, notification: 'prod is down' },
          observationState: {}
        })
      },
      { send: async () => ({ status: 'delivered' as const, receipt: 'msg-1' }) },
      now,
      () => true,
      { emit: () => {} },
      () => true,
      async () => 'allow',
      () => [],
      audit
    )

  it('stays silent by default, so a daemon that never opted in has an empty outbox', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z')
    const store = await openTestStore()
    try {
      const service = new StandingWorkService(store, () => now)
      await service.create(definition(now), 'allow')
      now += 60_000
      await buildPump(store, service, () => now).tick()
      expect(await flushed(store)).toEqual([])
    } finally {
      await store.close()
    }
  })

  it('records one admission per claimed run and both halves of the delivery', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z')
    const store = await openTestStore()
    try {
      const service = new StandingWorkService(store, () => now)
      const { workId } = await service.create(definition(now), 'allow')
      now += 60_000
      await buildPump(
        store,
        service,
        () => now,
        new DaemonAuditRecorder(
          store,
          () => true,
          () => now
        )
      ).tick()
      const rows = await flushed(store)
      expect(eventShapes(rows)).toEqual(['admission:-', 'external_effect:intent', 'external_effect:result'])
      expect(new Set(rows.map((row) => row.event.provenance.workId)).size).toBe(1)
      expect(
        rows.every((row) => row.event.provenance.workId === workId && row.event.provenance.authorizationRevision === 7)
      ).toBe(true)
      // The delivery outcome is auditable in its own right, and the message body is not.
      expect(
        rows.find((row) => row.event.kind === 'external_effect' && row.event.details?.phase === 'result')?.event.details
      ).toMatchObject({ status: 'delivered' })
      expect(JSON.stringify(rows)).not.toContain('prod is down')
    } finally {
      await store.close()
    }
  })

  it('records a refused delivery as an outcome with no intent behind it', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z')
    const store = await openTestStore()
    try {
      const service = new StandingWorkService(store, () => now)
      await service.create(definition(now), 'allow')
      now += 60_000
      const pump = new StandingWorkPump(
        store,
        service,
        'daemon-a',
        {
          execute: async () => ({
            report: { outcome: 'notify' as const, notification: 'prod is down' },
            observationState: {}
          })
        },
        { send: async () => ({ status: 'delivered' as const }) },
        () => now,
        () => true,
        { emit: () => {} },
        () => true,
        async () => 'suppress',
        () => [],
        new DaemonAuditRecorder(
          store,
          () => true,
          () => now
        )
      )
      await pump.tick()
      const rows = await flushed(store)
      // Nothing was sent, so there is no intent row — only the refusal itself.
      expect(eventShapes(rows)).toEqual(['admission:-', 'external_effect:result'])
      const effect = rows.find((row) => row.event.kind === 'external_effect')
      expect(effect?.event.parentEventId).toBeUndefined()
      expect(effect?.event.details).toMatchObject({ phase: 'result', status: 'suppressed', error: 'authority_revoked' })
    } finally {
      await store.close()
    }
  })
})
