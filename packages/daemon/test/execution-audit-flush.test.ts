import { describe, expect, it, vi } from 'vitest'
import { EXECUTION_AUDIT_V1_FEATURE, type AuditEventEnvelope, type AuditFlushOk } from '@agentconnect.md/protocol'
import type { Clock } from '@agentconnect.md/connection'
import { openTestStore } from './store-support.js'
import { DaemonAuditRecorder } from '../src/execution/audit-recorder.js'
import { ExecutionAuditFlusher, type ExecutionAuditFlushHost } from '../src/execution/audit-flush.js'
import type {
  LocalStore,
  StandingWorkNotificationRow,
  StandingWorkRow,
  StandingWorkRunRow
} from '../src/store/local-store.js'

// Real agents are uuids, and the wire contract only demands one of the agent — the fence it resolves.
const AGENT_A = 'a1a1a1a1-1111-4111-8111-111111111111'
const AGENT_B = 'b2b2b2b2-2222-4222-8222-222222222222'

const workRow = (orgId: string, agentId: string, workId: string): StandingWorkRow =>
  ({
    orgId,
    workId,
    agentId,
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
  }) as unknown as StandingWorkRow

const runRow = (orgId: string, workId: string, runId: string): StandingWorkRunRow =>
  ({
    orgId,
    workId,
    runId,
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
  }) as unknown as StandingWorkRunRow

const noteRow = (runId: string, effectId: string): StandingWorkNotificationRow =>
  ({
    orgId: 'org-a',
    workId: 'work-a',
    runId,
    notificationIndex: 0,
    effectId,
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
  }) as unknown as StandingWorkNotificationRow

/** Everything still queued for one org, oldest first. */
const pending = (store: LocalStore, orgId = 'org-a') => store.pendingExecutionAudit(orgId, 50)

interface WorldOptions {
  enabled?: boolean
  /** Whether the connected control plane advertises `execution-audit-v1`. */
  feature?: boolean
  agents?: string[]
  draining?: boolean
  channel?: boolean
  sendThrows?: boolean
  reply?: (orgId: string, events: AuditEventEnvelope[]) => AuditFlushOk
}

/** The flusher over a real outbox, a scripted channel and a clock that never fires on its own. */
async function world(options: WorldOptions = {}): Promise<{
  store: LocalStore
  flusher: ExecutionAuditFlusher
  sent: Array<{ orgId: string; events: AuditEventEnvelope[] }>
  reads: string[][]
  warnings: string[]
  scheduled: () => number
}> {
  const store = await openTestStore()
  const sent: Array<{ orgId: string; events: AuditEventEnvelope[] }> = []
  const reads: string[][] = []
  const warnings: string[] = []
  let timers = 0
  const clock: Clock = {
    now: () => 1_000,
    setTimeout: () => ++timers,
    clearTimeout: () => --timers
  }
  const host: ExecutionAuditFlushHost = {
    source: () => ({
      pendingExecutionAuditForAgents: async (agents, limit) => {
        reads.push([...agents])
        expect(limit).toBeGreaterThan(0)
        return store.pendingExecutionAuditForAgents(agents, limit)
      },
      acknowledgeExecutionAudit: (eventId, orgId, now) => store.acknowledgeExecutionAudit(eventId, orgId, now)
    }),
    channel: () =>
      options.channel === false
        ? undefined
        : {
            supportsServerFeature: (feature: string) =>
              options.feature !== false && feature === EXECUTION_AUDIT_V1_FEATURE,
            emitAuditFlush: async (orgId, events) => {
              if (options.sendThrows) throw new Error('socket closed')
              sent.push({ orgId, events })
              return options.reply
                ? options.reply(orgId, events)
                : { accepted: events.map((event) => event.eventId), rejected: [] }
            }
          },
    clock: () => clock,
    enabled: () => options.enabled !== false,
    draining: () => options.draining === true,
    servingAgentIds: () => options.agents ?? [AGENT_A],
    warn: (message) => warnings.push(message),
    debug: () => {}
  }
  return { store, flusher: new ExecutionAuditFlusher(host), sent, reads, warnings, scheduled: () => timers }
}

describe('ExecutionAuditFlusher', () => {
  it('neither reads the outbox nor sends a frame while the operator gate is off', async () => {
    const context = await world({ enabled: false })
    try {
      const recorder = new DaemonAuditRecorder(
        context.store,
        () => true,
        () => 5_000
      )
      const eventId = await recorder.recordAdmission(
        workRow('org-a', AGENT_A, 'work-a'),
        runRow('org-a', 'work-a', 'run-1')
      )
      await context.flusher.flush()
      expect(context.reads).toEqual([])
      expect(context.sent).toEqual([])
      // The fact is still durable locally; only its departure is deferred.
      expect((await pending(context.store)).map((row) => row.eventId)).toEqual([eventId])
    } finally {
      await context.store.close()
    }
  })

  it('holds every row when the connected control plane does not advertise the feature', async () => {
    const context = await world({ feature: false })
    try {
      const eventId = await new DaemonAuditRecorder(context.store, () => true).recordAdmission(
        workRow('org-a', AGENT_A, 'work-a'),
        runRow('org-a', 'work-a', 'run-1')
      )
      await context.flusher.flush()
      expect(context.sent).toEqual([])
      expect((await pending(context.store)).map((row) => row.eventId)).toEqual([eventId])
    } finally {
      await context.store.close()
    }
  })

  it('asks only for the agents this process serves', async () => {
    const context = await world({ agents: [AGENT_A] })
    try {
      const recorder = new DaemonAuditRecorder(context.store, () => true)
      // A peer member's row is in this shared outbox and must not be read, let alone reported.
      await recorder.recordAdmission(workRow('org-a', AGENT_B, 'work-b'), runRow('org-a', 'work-b', 'run-peer'))
      const mine = await recorder.recordAdmission(
        workRow('org-a', AGENT_A, 'work-a'),
        runRow('org-a', 'work-a', 'run-mine')
      )
      await context.flusher.flush()
      expect(context.reads).toEqual([[AGENT_A]])
      expect(context.sent.flatMap((batch) => batch.events.map((event) => event.eventId))).toEqual([mine])
      expect((await pending(context.store)).map((row) => row.eventId)).not.toContain(mine)
    } finally {
      await context.store.close()
    }
  })

  it('drains a whole run attempt and strips the organization from the provenance', async () => {
    const context = await world()
    try {
      const recorder = new DaemonAuditRecorder(
        context.store,
        () => true,
        () => 7_000
      )
      const work = workRow('org-a', AGENT_A, 'work-a')
      const admission = await recorder.recordAdmission(work, runRow('org-a', 'work-a', 'run-1'))
      const intent = await recorder.recordEffectIntent(work, noteRow('run-1', 'effect-1'))
      const result = await recorder.recordEffectResult(work, noteRow('run-1', 'effect-1'), 'delivered', {
        intentEventId: intent ?? undefined
      })
      await context.flusher.flush()
      expect(context.sent).toHaveLength(1)
      const [batch] = context.sent
      expect(batch?.orgId).toBe('org-a')
      expect(batch?.events.map((event) => event.eventId).sort()).toEqual([admission, intent, result].sort())
      // The org is the envelope's scope, never a payload field the ingest would have to reconcile.
      for (const event of batch?.events ?? []) {
        expect(event.provenance).not.toHaveProperty('orgId')
        expect(event.provenance.agentId).toBe(AGENT_A)
        expect(event.provenance.traceId).toBe(DaemonAuditRecorder.traceId('run-1'))
      }
      const parented = (batch?.events ?? []).find((event) => event.eventId === result)
      expect(parented?.parentEventId).toBe(intent)
      expect(parented?.effectId).toBe('effect-1')
      expect(await pending(context.store)).toEqual([])
    } finally {
      await context.store.close()
    }
  })

  it('releases only the ids the control plane named, keeping the rest for a later pass', async () => {
    const context = await world({
      reply: (_orgId, events) => ({
        accepted: events.slice(0, 1).map((event) => event.eventId),
        rejected: events.slice(1, 2).map((event) => event.eventId)
      })
    })
    try {
      const recorder = new DaemonAuditRecorder(context.store, () => true)
      const work = workRow('org-a', AGENT_A, 'work-a')
      const ids = [
        await recorder.recordAdmission(work, runRow('org-a', 'work-a', 'run-1')),
        await recorder.recordAdmission(work, runRow('org-a', 'work-a', 'run-2')),
        await recorder.recordAdmission(work, runRow('org-a', 'work-a', 'run-3'))
      ]
      await context.flusher.flush()
      // Accepted and rejected are both settled — one kept as history, one as unsalvageable. Untouched means unprocessed.
      const offered = context.sent[0]?.events ?? []
      expect(offered.map((event) => event.eventId).sort()).toEqual(ids.sort())
      expect((await pending(context.store)).map((row) => row.eventId)).toEqual([offered[2]?.eventId])
    } finally {
      await context.store.close()
    }
  })

  it('reads nothing at all while no control plane is connected', async () => {
    const context = await world({ channel: false })
    try {
      const eventId = await new DaemonAuditRecorder(context.store, () => true).recordAdmission(
        workRow('org-a', AGENT_A, 'work-a'),
        runRow('org-a', 'work-a', 'run-1')
      )
      await context.flusher.flush()
      expect(context.reads).toEqual([])
      expect((await pending(context.store)).map((row) => row.eventId)).toEqual([eventId])
    } finally {
      await context.store.close()
    }
  })

  it('defers a batch whose send throws instead of losing it', async () => {
    const context = await world({ sendThrows: true })
    try {
      const recorder = new DaemonAuditRecorder(context.store, () => true)
      const eventId = await recorder.recordAdmission(
        workRow('org-a', AGENT_A, 'work-a'),
        runRow('org-a', 'work-a', 'run-1')
      )
      await context.flusher.flush()
      expect(context.sent).toEqual([])
      expect((await pending(context.store)).map((row) => row.eventId)).toEqual([eventId])
    } finally {
      await context.store.close()
    }
  })

  it('sends one frame per organization, never a mixed batch', async () => {
    const context = await world({ agents: [AGENT_A, AGENT_B] })
    try {
      const recorder = new DaemonAuditRecorder(context.store, () => true)
      await recorder.recordAdmission(workRow('org-a', AGENT_A, 'work-a'), runRow('org-a', 'work-a', 'run-1'))
      await recorder.recordAdmission(workRow('org-b', AGENT_B, 'work-b'), runRow('org-b', 'work-b', 'run-2'))
      await context.flusher.flush()
      expect(context.sent.map((batch) => batch.orgId).sort()).toEqual(['org-a', 'org-b'])
      expect(context.sent.every((batch) => batch.events.length === 1)).toBe(true)
      expect(await pending(context.store, 'org-a')).toEqual([])
      expect(await pending(context.store, 'org-b')).toEqual([])
    } finally {
      await context.store.close()
    }
  })

  it('drops a row the wire contract refuses instead of wedging the queue behind it', async () => {
    const context = await world()
    try {
      // A row this release can no longer describe: an unknown kind would fail every ingest forever.
      await context.store.appendExecutionAudit('legacy-1', 'org-a', AGENT_A, {
        eventId: 'legacy-1',
        kind: 'session_created',
        occurredAt: 4_000,
        provenance: {
          orgId: 'org-a',
          agentId: AGENT_A,
          principalId: 'p',
          authorizationRevision: 1,
          runId: 'r',
          traceId: 't'
        }
      })
      const eventId = await new DaemonAuditRecorder(context.store, () => true).recordAdmission(
        workRow('org-a', AGENT_A, 'work-a'),
        runRow('org-a', 'work-a', 'run-1')
      )
      await context.flusher.flush()
      expect(context.warnings.join('\n')).toContain('can no longer describe')
      expect(context.sent.flatMap((batch) => batch.events.map((event) => event.eventId))).toEqual([eventId])
      expect((await pending(context.store)).map((row) => row.eventId)).toEqual([])
    } finally {
      await context.store.close()
    }
  })

  it('leaves a row that names no agent for a release that can attribute it', async () => {
    const context = await world()
    try {
      await context.store.appendExecutionAudit('unowned-1', 'org-a', '', {
        eventId: 'unowned-1',
        kind: 'admission',
        occurredAt: 4_000,
        provenance: {
          orgId: 'org-a',
          agentId: '',
          principalId: 'p',
          authorizationRevision: 1,
          runId: 'r',
          traceId: 't'
        }
      })
      await context.flusher.flush()
      expect(context.sent).toEqual([])
      expect((await pending(context.store)).map((row) => row.eventId)).toEqual(['unowned-1'])
    } finally {
      await context.store.close()
    }
  })

  it('arms once per connection and stops with the process', async () => {
    const context = await world()
    try {
      expect(context.scheduled()).toBe(0)
      context.flusher.arm()
      expect(context.scheduled()).toBe(1)
      // A second (re)connect must not double-schedule the same loop.
      context.flusher.arm()
      expect(context.scheduled()).toBe(1)
      context.flusher.dispose()
      expect(context.scheduled()).toBe(0)
    } finally {
      await context.store.close()
    }
  })

  it('never starts the loop at all while the operator gate is off', async () => {
    const context = await world({ enabled: false })
    try {
      context.flusher.arm()
      expect(context.scheduled()).toBe(0)
    } finally {
      await context.store.close()
    }
  })

  it('ignores arm while draining, so a shutting-down daemon starts no work', async () => {
    const context = await world({ draining: true })
    try {
      context.flusher.arm()
      expect(context.scheduled()).toBe(0)
      const eventId = await new DaemonAuditRecorder(context.store, () => true).recordAdmission(
        workRow('org-a', AGENT_A, 'work-a'),
        runRow('org-a', 'work-a', 'run-1')
      )
      await context.flusher.flush()
      expect(context.sent).toEqual([])
      expect((await pending(context.store)).map((row) => row.eventId)).toEqual([eventId])
    } finally {
      await context.store.close()
    }
  })

  it('replays a flush requested during a live pass, once', async () => {
    const context = await world()
    const other = vi.spyOn(context.store, 'pendingExecutionAuditForAgents')
    try {
      await new DaemonAuditRecorder(context.store, () => true).recordAdmission(
        workRow('org-a', AGENT_A, 'work-a'),
        runRow('org-a', 'work-a', 'run-1')
      )
      await Promise.all([context.flusher.flush(), context.flusher.flush(), context.flusher.flush()])
      expect(other).toHaveBeenCalledTimes(2)
      expect(context.sent).toHaveLength(1)
    } finally {
      other.mockRestore()
      await context.store.close()
    }
  })
})
