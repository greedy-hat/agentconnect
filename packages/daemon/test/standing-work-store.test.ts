import { describe, expect, it, vi } from 'vitest'
import { memoryStoreDatabase, openTestStore, tempStorePath, usingPostgresStore } from './store-support.js'
import type { StandingWorkProjection } from '@agentconnect.md/protocol'
import { StandingWorkRunReport } from '@agentconnect.md/protocol'
import { LocalStore, type StandingWorkRow, type StandingWorkStateRow } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import {
  admitStandingWorkExecution,
  parseStandingWorkOutput,
  encodeStandingWorkDestination,
  StandingWorkAmbientExecutor,
  StandingWorkControlPlane,
  StandingWorkGatewayDestinationResolver,
  StandingWorkMessageDispatcher,
  StandingWorkPump,
  StandingWorkService,
  standingWorkReportCatchup,
  type AmbientTurnRunner
} from '../src/execution/standing-work.js'

const ambientRow = {
  orgId: 'org',
  workId: 'work',
  agentId: 'agent',
  principalId: 'p',
  name: 'watch',
  objective: 'observe the deploy',
  state: 'active',
  definitionVersion: 1,
  schedule: '* * * * *',
  timezone: 'UTC',
  scheduleMode: 'fixed',
  maxIntervalSeconds: 86400,
  wakeOnConversation: false,
  targetDestination: 'slack:channel',
  expiresAt: 10 ** 12,
  maxRunsPerDay: 3,
  maxNotificationsPerDay: 2,
  approvalVersion: 1,
  approvalState: 'approved',
  authorizationRevision: 1,
  createdAt: 1,
  updatedAt: 1
} as unknown as StandingWorkRow

describe('ambient executor + notification dispatcher', () => {
  it('parses one JSON report and threads observationState through without trusting a model cursor', async () => {
    const runner = vi.fn<AmbientTurnRunner['run']>(async () => ({
      output:
        '{"outcome":"notify","summary":"deploy failed","notification":"prod is down","observationState":{"last":"red"},"contextCursor":"evt-9"}'
    }))
    const exec = new StandingWorkAmbientExecutor({ run: runner })
    const out = await exec.execute({
      work: ambientRow,
      runId: 'run',
      executionEpoch: 1,
      signal: new AbortController().signal,
      observationState: { last: 'green' }
    })
    expect(out.report).toEqual({ outcome: 'notify', summary: 'deploy failed', notification: 'prod is down' })
    expect(out.observationState).toEqual({ last: 'red' })
    // The model cannot advance the authorized transcript cursor in its output.
    expect(out.contextCursor).toBeUndefined()
    // The objective and prior state reach the ambient turn; the run/occurrence ride for provenance.
    const arg = runner.mock.calls[0]![0]
    expect(arg.prompt).toContain('observe the deploy')
    expect(arg.prompt).toContain('"last":"green"')
    expect(arg).toMatchObject({ agentId: 'agent', workId: 'work', runId: 'run', executionEpoch: 1 })
  })

  it('falls back to the prior observation when the model omits an updated state', async () => {
    const exec = new StandingWorkAmbientExecutor({ run: async () => ({ output: '{"outcome":"no_change"}' }) })
    const out = await exec.execute({
      work: ambientRow,
      runId: 'run',
      executionEpoch: 1,
      signal: new AbortController().signal,
      contextCursor: 'c1',
      observationState: { keep: true }
    })
    expect(out).toEqual({ report: { outcome: 'no_change' }, observationState: { keep: true }, contextCursor: 'c1' })
  })

  it('rejects a turn that yields no structured report or violates the notify contract', async () => {
    await expect(
      new StandingWorkAmbientExecutor({ run: async () => ({ output: 'all good, no change' }) }).execute({
        work: ambientRow,
        runId: 'r',
        executionEpoch: 1,
        signal: new AbortController().signal,
        observationState: {}
      })
    ).rejects.toThrow('single JSON report')
    await expect(
      new StandingWorkAmbientExecutor({
        run: async () => ({ output: 'Here is the report: {"outcome":"no_change"}' })
      }).execute({
        work: ambientRow,
        runId: 'r',
        executionEpoch: 1,
        signal: new AbortController().signal,
        observationState: {}
      })
    ).rejects.toThrow('single JSON report')
    await expect(
      new StandingWorkAmbientExecutor({ run: async () => ({ output: '{"outcome":"notify"}' }) }).execute({
        work: ambientRow,
        runId: 'r',
        executionEpoch: 1,
        signal: new AbortController().signal,
        observationState: {}
      })
    ).rejects.toThrow('requires a notification')
  })

  it('reports a missing destination route as a retryable failure', async () => {
    let now = 1_000
    const d = new StandingWorkMessageDispatcher({ resolve: () => undefined }, () => now, 500)
    expect(await d.send({ destination: 'slack:gone', payload: 'x', effectId: 'e1' })).toEqual({
      status: 'failed',
      error: 'no_destination_route',
      retryAt: 1_500
    })
    now = 9_000
    expect((await d.send({ destination: 'slack:gone', payload: 'x', effectId: 'e1' })).retryAt).toBe(9_500)
  })

  it('delivers with a receipt when the gateway accepts the post', async () => {
    const post = vi.fn(async () => ({ receipt: 'msg-1' }))
    const d = new StandingWorkMessageDispatcher({
      resolve: (dest) => (dest === 'slack:channel' ? { post } : undefined)
    })
    expect(await d.send({ destination: 'slack:channel', payload: 'prod is down', effectId: 'e1' })).toEqual({
      status: 'delivered',
      receipt: 'msg-1'
    })
    expect(post).toHaveBeenCalledWith('prod is down', 'e1')
  })

  it('treats a mid-send throw as uncertain so the outbox reconciles instead of double-posting', async () => {
    const now = 2_000
    const d = new StandingWorkMessageDispatcher(
      {
        resolve: () => ({
          post: async () => {
            throw new Error('timeout')
          }
        })
      },
      () => now,
      60_000
    )
    expect(await d.send({ destination: 'slack:channel', payload: 'x', effectId: 'e1' })).toEqual({
      status: 'uncertain',
      error: 'timeout',
      retryAt: 62_000
    })
  })
})

describe('gateway destination resolver', () => {
  it('resolves a well-formed destination to a live post and delivers through the dispatcher', async () => {
    const postMessage = vi.fn(async () => 'ts-9')
    const resolver = new StandingWorkGatewayDestinationResolver({
      connForIntegration: (id) => (id === 'i-1' ? { postMessage } : undefined)
    })
    const destination = encodeStandingWorkDestination({ integrationId: 'i-1', channel: 'C123', thread: 'ts-1' })
    const dispatcher = new StandingWorkMessageDispatcher(resolver)
    expect(await dispatcher.send({ destination, payload: 'prod is down', effectId: 'e1' })).toEqual({
      status: 'delivered'
    })
    expect(postMessage).toHaveBeenCalledWith('C123', 'prod is down', 'ts-1')
  })

  it('threads a thread-less channel post and reports an unreachable integration as retryable', async () => {
    const postMessage = vi.fn(async () => undefined)
    const resolver = new StandingWorkGatewayDestinationResolver({
      connForIntegration: (id) => (id === 'up' ? { postMessage } : undefined)
    })
    expect(await resolver.resolve(encodeStandingWorkDestination({ integrationId: 'up', channel: 'G1' }))).toBeDefined()
    expect(resolver.resolve(encodeStandingWorkDestination({ integrationId: 'down', channel: 'G1' }))).toBeUndefined()
  })

  it('refuses a malformed or identity-less destination rather than guessing a route', () => {
    const resolver = new StandingWorkGatewayDestinationResolver({
      connForIntegration: () => ({ postMessage: async () => undefined })
    })
    expect(resolver.resolve('slack:channel')).toBeUndefined()
    expect(resolver.resolve('{"integrationId":"i"}')).toBeUndefined()
    expect(resolver.resolve('{"channel":"C"}')).toBeUndefined()
  })
})

describe('standing work store', () => {
  it('fails closed on normal output and mutating ambient tools', () => {
    const provenance = {
      orgId: 'org',
      agentId: 'agent',
      principalId: 'principal',
      authorizationRevision: 1,
      sessionId: 'session',
      runId: 'run',
      executionEpoch: 1,
      traceId: 'trace',
      workId: 'work'
    }
    const policy = {
      audience: new Set<string>(),
      allowedTools: new Set(['read_file', 'sendMessage']),
      requireSandbox: true,
      maxToolCalls: 1
    }
    const caps = { sandbox: true, tools: new Set(['read_file', 'sendMessage']) }
    expect(admitStandingWorkExecution(provenance, policy, caps, ['read_file'])).toEqual({ allowed: true })
    expect(admitStandingWorkExecution(provenance, policy, caps, ['sendMessage'])).toEqual({
      allowed: false,
      reason: 'non_readonly_tool'
    })
    expect(() => parseStandingWorkOutput('ordinary final')).toThrow('structured report')
    expect(() => parseStandingWorkOutput({ outcome: 'notify' })).toThrow('requires a notification')
  })

  it('fences stale holders and makes terminal reports idempotent', async () => {
    const store = await openTestStore()
    try {
      await store.createStandingWork(
        {
          orgId: 'org',
          workId: 'work',
          agentId: 'agent',
          principalId: 'principal',
          name: 'watch',
          objective: 'observe',
          state: 'active',
          definitionVersion: 1,
          schedule: '* * * * *',
          timezone: 'UTC',
          scheduleMode: 'fixed',
          maxIntervalSeconds: 86400,
          wakeOnConversation: false,
          targetDestination: 'slack:channel',
          expiresAt: 10_000,
          maxRunsPerDay: 3,
          maxNotificationsPerDay: 2,
          approvalVersion: 1,
          approvalState: 'approved',
          authorizationRevision: 1,
          createdAt: 1,
          updatedAt: 1
        },
        {
          orgId: 'org',
          workId: 'work',
          appliedDefinitionVersion: 1,
          nextCheckAt: 10,
          lastRunAt: null,
          lastNotifiedAt: null,
          contextCursor: null,
          observationState: '{}',
          observationSchemaVersion: 1,
          executionEpoch: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          blockedReason: null,
          suggestedNextCheckAt: null,
          wakeSource: 'scheduled'
        }
      )
      const run = await store.claimStandingWorkRun({
        orgId: 'org',
        workId: 'work',
        definitionVersion: 1,
        occurrenceId: '1:10',
        dueAt: 10,
        runId: 'run',
        ownerId: 'one',
        now: 10,
        leaseMs: 100
      })
      expect(run?.executionEpoch).toBe(1)
      expect(
        await store.reportStandingWork({
          orgId: 'org',
          workId: 'work',
          runId: 'run',
          ownerId: 'other',
          epoch: 1,
          definitionVersion: 1,
          outcome: 'notify',
          now: 11,
          nextCheckAt: 60,
          observationState: '{}',
          notification: { effectId: 'effect', destination: 'slack:channel', payload: 'changed', payloadHash: 'hash' }
        })
      ).toEqual({ status: 'stale' })
      const input = {
        orgId: 'org',
        workId: 'work',
        runId: 'run',
        ownerId: 'one',
        epoch: 1,
        definitionVersion: 1,
        outcome: 'notify' as const,
        now: 11,
        nextCheckAt: 60,
        observationState: '{}',
        notification: { effectId: 'effect', destination: 'slack:channel', payload: 'changed', payloadHash: 'hash' }
      }
      expect(await store.reportStandingWork(input)).toEqual({ status: 'committed' })
      expect(await store.reportStandingWork(input)).toEqual({ status: 'duplicate' })
    } finally {
      await store.close()
    }
  })

  it('reclaims an expired lease as a bounded retry of the same occurrence', async () => {
    const store = await openTestStore()
    try {
      await store.createStandingWork(
        {
          orgId: 'org',
          workId: 'work',
          agentId: 'agent',
          principalId: 'principal',
          name: 'watch',
          objective: 'observe',
          state: 'active',
          definitionVersion: 1,
          schedule: '* * * * *',
          timezone: 'UTC',
          scheduleMode: 'fixed',
          maxIntervalSeconds: 86400,
          wakeOnConversation: false,
          targetDestination: 'slack:channel',
          expiresAt: 10_000,
          maxRunsPerDay: 3,
          maxNotificationsPerDay: 2,
          approvalVersion: 1,
          approvalState: 'approved',
          authorizationRevision: 1,
          createdAt: 1,
          updatedAt: 1
        },
        {
          orgId: 'org',
          workId: 'work',
          appliedDefinitionVersion: 1,
          nextCheckAt: 10,
          lastRunAt: null,
          lastNotifiedAt: null,
          contextCursor: null,
          observationState: '{}',
          observationSchemaVersion: 1,
          executionEpoch: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          blockedReason: null,
          suggestedNextCheckAt: null,
          wakeSource: 'scheduled'
        }
      )
      const first = await store.claimStandingWorkRun({
        orgId: 'org',
        workId: 'work',
        definitionVersion: 1,
        occurrenceId: '1:10',
        dueAt: 10,
        runId: 'first',
        ownerId: 'one',
        now: 10,
        leaseMs: 5
      })
      const retry = await store.claimStandingWorkRun({
        orgId: 'org',
        workId: 'work',
        definitionVersion: 1,
        occurrenceId: '1:10',
        dueAt: 10,
        runId: 'second',
        ownerId: 'two',
        now: 16,
        leaseMs: 5
      })
      expect(retry).toMatchObject({ runId: first?.runId, attempt: 2, executionEpoch: 2, status: 'running' })
    } finally {
      await store.close()
    }
  })

  it('makes exhausted lease recovery visibly blocked instead of claiming forever', async () => {
    const store = await openTestStore()
    try {
      await store.createStandingWork(
        {
          orgId: 'org',
          workId: 'work',
          agentId: 'agent',
          principalId: 'principal',
          name: 'watch',
          objective: 'observe',
          state: 'active',
          definitionVersion: 1,
          schedule: '* * * * *',
          timezone: 'UTC',
          scheduleMode: 'fixed',
          maxIntervalSeconds: 86400,
          wakeOnConversation: false,
          targetDestination: 'slack:channel',
          expiresAt: 10_000,
          maxRunsPerDay: 3,
          maxNotificationsPerDay: 2,
          approvalVersion: 1,
          approvalState: 'approved',
          authorizationRevision: 1,
          createdAt: 1,
          updatedAt: 1
        },
        {
          orgId: 'org',
          workId: 'work',
          appliedDefinitionVersion: 1,
          nextCheckAt: 10,
          lastRunAt: null,
          lastNotifiedAt: null,
          contextCursor: null,
          observationState: '{}',
          observationSchemaVersion: 1,
          executionEpoch: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          blockedReason: null,
          suggestedNextCheckAt: null,
          wakeSource: 'scheduled'
        }
      )
      for (const now of [10, 16, 22]) {
        await store.claimStandingWorkRun({
          orgId: 'org',
          workId: 'work',
          definitionVersion: 1,
          occurrenceId: '1:10',
          dueAt: 10,
          runId: `run-${now}`,
          ownerId: 'holder',
          now,
          leaseMs: 5
        })
      }
      expect(
        await store.claimStandingWorkRun({
          orgId: 'org',
          workId: 'work',
          definitionVersion: 1,
          occurrenceId: '1:10',
          dueAt: 10,
          runId: 'run-28',
          ownerId: 'holder',
          now: 28,
          leaseMs: 5
        })
      ).toBeUndefined()
      expect((await store.getStandingWork('org', 'work'))?.state.blockedReason).toBe('retry_exhausted')
    } finally {
      await store.close()
    }
  })

  it('recovers work from the persisted due list and emits no normal output', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z')
    const store = await openTestStore()
    try {
      const service = new StandingWorkService(store, () => now)
      const { workId } = await service.create(
        {
          orgId: 'org',
          agentId: 'agent',
          principalId: 'principal',
          actorId: 'actor',
          name: 'watch',
          objective: 'observe',
          schedule: '* * * * *',
          timezone: 'UTC',
          targetDestination: 'slack:channel',
          expiresAt: now + 3_600_000,
          authorizationRevision: 1
        },
        'allow'
      )
      now += 60_000
      const execute = vi.fn(async () => ({
        report: { outcome: 'no_change' as const },
        observationState: { checked: true },
        contextCursor: 'event-1'
      }))
      const pump = new StandingWorkPump(store, service, 'daemon-a', { execute }, { send: vi.fn() }, () => now)
      await pump.tick()
      expect(execute).toHaveBeenCalledOnce()
      expect((await store.getStandingWork('org', workId))?.state.contextCursor).toBe('event-1')
    } finally {
      await store.close()
    }
  })

  it('requires a new approval after a lifecycle version change', async () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    const store = await openTestStore()
    try {
      const service = new StandingWorkService(store, () => now)
      const { workId } = await service.create(
        {
          orgId: 'org',
          agentId: 'agent',
          principalId: 'principal',
          actorId: 'actor',
          name: 'watch',
          objective: 'observe',
          schedule: '* * * * *',
          timezone: 'UTC',
          targetDestination: 'slack:channel',
          expiresAt: now + 3_600_000,
          authorizationRevision: 1
        },
        'allow'
      )
      expect(await service.pause('org', workId, 1)).toBe(true)
      expect(await service.resume('org', workId, 2)).toEqual({ version: 3, approvalRequired: true })
      expect(await service.claimDue('org', workId, 'daemon')).toBeUndefined()
      expect(await service.approve('org', workId, 3)).toBe(true)
    } finally {
      await store.close()
    }
  })

  it('fences edits behind a new approval and exposes a separated console timeline', async () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    const store = await openTestStore()
    try {
      const service = new StandingWorkService(store, () => now)
      const authority = {
        actorId: 'operator',
        canManage: true,
        canApprove: true,
        canUseDestination: (d: string) => d === 'slack:channel',
        authorizationRevision: 8
      }
      const cp = new StandingWorkControlPlane(service)
      const { workId } = await cp.create(authority, {
        orgId: 'org',
        agentId: 'agent',
        principalId: 'principal',
        name: 'watch',
        objective: 'observe',
        schedule: '* * * * *',
        timezone: 'UTC',
        targetDestination: 'slack:channel',
        expiresAt: now + 3_600_000,
        maxRunsPerDay: 4,
        maxNotificationsPerDay: 2
      })
      expect(await cp.approve(authority, 'org', workId, 1)).toBe(true)
      expect(
        await cp.edit(authority, 'org', workId, 1, {
          agentId: 'agent',
          principalId: 'principal',
          name: 'watch edited',
          objective: 'observe safely',
          schedule: '*/2 * * * *',
          timezone: 'UTC',
          targetDestination: 'slack:channel',
          expiresAt: now + 3_600_000,
          maxRunsPerDay: 4,
          maxNotificationsPerDay: 2
        })
      ).toEqual({ version: 2, approvalRequired: true })
      expect(await service.claimDue('org', workId, 'daemon')).toBeUndefined()
      const timeline = await store.standingWorkTimeline('org', workId)
      expect(timeline).toEqual({ runs: [], notifications: [] })
    } finally {
      await store.close()
    }
  })

  it('refuses ungranted destinations and durably expires work', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z')
    const store = await openTestStore()
    try {
      const service = new StandingWorkService(store, () => now)
      const cp = new StandingWorkControlPlane(service)
      const denied = {
        actorId: 'operator',
        canManage: true,
        canApprove: false,
        canUseDestination: () => false,
        authorizationRevision: 1
      }
      await expect(
        cp.create(denied, {
          orgId: 'org',
          agentId: 'agent',
          principalId: 'principal',
          name: 'watch',
          objective: 'observe',
          schedule: '* * * * *',
          timezone: 'UTC',
          targetDestination: 'slack:channel',
          expiresAt: now + 60_000
        })
      ).rejects.toThrow('destination permission denied')
      const allowed = { ...denied, canUseDestination: () => true }
      const { workId } = await cp.create(allowed, {
        orgId: 'org',
        agentId: 'agent',
        principalId: 'principal',
        name: 'watch',
        objective: 'observe',
        schedule: '* * * * *',
        timezone: 'UTC',
        targetDestination: 'slack:channel',
        expiresAt: now + 120_000
      })
      now += 120_000
      expect(await store.expireStandingWork(now)).toBe(1)
      expect((await store.getStandingWork('org', workId))?.work.state).toBe('expired')
    } finally {
      await store.close()
    }
  })

  it('binds the sweep to duty placement: a non-holder claims nothing', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z')
    const store = await openTestStore()
    try {
      const service = new StandingWorkService(store, () => now)
      const { workId } = await service.create(
        {
          orgId: 'org',
          agentId: 'agent',
          principalId: 'principal',
          actorId: 'actor',
          name: 'watch',
          objective: 'observe',
          schedule: '* * * * *',
          timezone: 'UTC',
          targetDestination: 'slack:channel',
          expiresAt: now + 3_600_000,
          authorizationRevision: 1
        },
        'allow'
      )
      now += 60_000
      const execute = vi.fn(async () => ({
        report: { outcome: 'no_change' as const },
        observationState: {},
        contextCursor: 'e'
      }))
      const denied = new StandingWorkPump(
        store,
        service,
        'daemon-b',
        { execute },
        { send: vi.fn() },
        () => now,
        () => false
      )
      await denied.tick()
      expect(execute).not.toHaveBeenCalled()
      expect((await store.getStandingWork('org', workId))?.state.leaseOwner).toBeNull()
      const holder = new StandingWorkPump(
        store,
        service,
        'daemon-a',
        { execute },
        { send: vi.fn() },
        () => now,
        () => true
      )
      await holder.tick()
      expect(execute).toHaveBeenCalledOnce()
    } finally {
      await store.close()
    }
  })

  it('defers a new occurrence once the daily run quota is spent', async () => {
    const store = await openTestStore()
    try {
      await store.createStandingWork(
        {
          orgId: 'org',
          workId: 'work',
          agentId: 'agent',
          principalId: 'principal',
          name: 'watch',
          objective: 'observe',
          state: 'active',
          definitionVersion: 1,
          schedule: '* * * * *',
          timezone: 'UTC',
          scheduleMode: 'fixed',
          maxIntervalSeconds: 86400,
          wakeOnConversation: false,
          targetDestination: 'slack:channel',
          expiresAt: 10 ** 12,
          maxRunsPerDay: 1,
          maxNotificationsPerDay: 2,
          approvalVersion: 1,
          approvalState: 'approved',
          authorizationRevision: 1,
          createdAt: 1,
          updatedAt: 1
        },
        {
          orgId: 'org',
          workId: 'work',
          appliedDefinitionVersion: 1,
          nextCheckAt: 10,
          lastRunAt: null,
          lastNotifiedAt: null,
          contextCursor: null,
          observationState: '{}',
          observationSchemaVersion: 1,
          executionEpoch: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          blockedReason: null,
          suggestedNextCheckAt: null,
          wakeSource: 'scheduled'
        }
      )
      const run = await store.claimStandingWorkRun({
        orgId: 'org',
        workId: 'work',
        definitionVersion: 1,
        occurrenceId: '1:10',
        dueAt: 10,
        runId: 'run',
        ownerId: 'one',
        now: 10,
        leaseMs: 100
      })
      expect(run?.runId).toBe('run')
      await store.reportStandingWork({
        orgId: 'org',
        workId: 'work',
        runId: 'run',
        ownerId: 'one',
        epoch: 1,
        definitionVersion: 1,
        outcome: 'no_change',
        now: 11,
        nextCheckAt: 20,
        observationState: '{}'
      })
      expect(
        await store.claimStandingWorkRun({
          orgId: 'org',
          workId: 'work',
          definitionVersion: 1,
          occurrenceId: '1:20',
          dueAt: 20,
          runId: 'next',
          ownerId: 'one',
          now: 20,
          leaseMs: 100
        })
      ).toBeUndefined()
      expect((await store.getStandingWork('org', 'work'))?.state.nextCheckAt).toBe(86_400_000)
    } finally {
      await store.close()
    }
  })

  it('reserves the daily notification allowance before delivery and defers the overflow', async () => {
    const store = await openTestStore()
    try {
      await store.createStandingWork(
        {
          orgId: 'org',
          workId: 'work',
          agentId: 'agent',
          principalId: 'principal',
          name: 'watch',
          objective: 'observe',
          state: 'active',
          definitionVersion: 1,
          schedule: '* * * * *',
          timezone: 'UTC',
          scheduleMode: 'fixed',
          maxIntervalSeconds: 86400,
          wakeOnConversation: false,
          targetDestination: 'slack:channel',
          expiresAt: 10 ** 12,
          maxRunsPerDay: 8,
          maxNotificationsPerDay: 1,
          approvalVersion: 1,
          approvalState: 'approved',
          authorizationRevision: 1,
          createdAt: 1,
          updatedAt: 1
        },
        {
          orgId: 'org',
          workId: 'work',
          appliedDefinitionVersion: 1,
          nextCheckAt: 10,
          lastRunAt: null,
          lastNotifiedAt: null,
          contextCursor: null,
          observationState: '{}',
          observationSchemaVersion: 1,
          executionEpoch: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          blockedReason: null,
          suggestedNextCheckAt: null,
          wakeSource: 'scheduled'
        }
      )
      let epoch = 0
      for (const [occ, id, at] of [
        ['1:10', 'runA', 10],
        ['1:20', 'runB', 20]
      ] as const) {
        epoch += 1
        await store.claimStandingWorkRun({
          orgId: 'org',
          workId: 'work',
          definitionVersion: 1,
          occurrenceId: occ,
          dueAt: at,
          runId: id,
          ownerId: 'one',
          now: at,
          leaseMs: 100
        })
        await store.reportStandingWork({
          orgId: 'org',
          workId: 'work',
          runId: id,
          ownerId: 'one',
          epoch,
          definitionVersion: 1,
          outcome: 'notify',
          now: at + 1,
          nextCheckAt: at + 10,
          observationState: '{}',
          notification: { effectId: `e-${id}`, destination: 'slack:channel', payload: `p-${id}`, payloadHash: 'hash' }
        })
      }
      const first = await store.claimStandingWorkNotification(30)
      expect(first?.runId).toBe('runA')
      expect(
        await store.settleStandingWorkNotification({
          orgId: 'org',
          runId: 'runA',
          notificationIndex: 0,
          status: 'delivered',
          now: 31,
          receipt: 'msg-1'
        })
      ).toBe(true)
      expect(await store.claimStandingWorkNotification(31)).toBeUndefined()
      const timeline = await store.standingWorkTimeline('org', 'work')
      expect(timeline.notifications.find((n) => n.runId === 'runB')).toMatchObject({
        status: 'pending',
        nextAttemptAt: 86_400_000
      })
    } finally {
      await store.close()
    }
  })

  it('limits a shared-store notification claim to the holder’s serving agents', async () => {
    const store = await openTestStore({
      ...(usingPostgresStore() ? {} : { database: memoryStoreDatabase() }),
      shared: true,
      ownerId: 'holder-a',
      orgForAgent: () => 'org'
    })
    try {
      await store.createStandingWork(
        { ...ambientRow, workId: 'shared-work', agentId: 'agent-b', expiresAt: 10 ** 12 },
        {
          orgId: 'org',
          workId: 'shared-work',
          appliedDefinitionVersion: 1,
          nextCheckAt: 10,
          lastRunAt: null,
          lastNotifiedAt: null,
          contextCursor: null,
          observationState: '{}',
          observationSchemaVersion: 1,
          executionEpoch: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          blockedReason: null,
          suggestedNextCheckAt: null,
          wakeSource: 'scheduled'
        }
      )
      await store.claimStandingWorkRun({
        orgId: 'org',
        workId: 'shared-work',
        definitionVersion: 1,
        occurrenceId: '1:10',
        dueAt: 10,
        runId: 'shared-run',
        ownerId: 'holder-b',
        now: 10,
        leaseMs: 100
      })
      await store.reportStandingWork({
        orgId: 'org',
        workId: 'shared-work',
        runId: 'shared-run',
        ownerId: 'holder-b',
        epoch: 1,
        definitionVersion: 1,
        outcome: 'notify',
        now: 11,
        nextCheckAt: 20,
        observationState: '{}',
        notification: {
          effectId: 'shared-effect',
          destination: 'slack:channel',
          payload: 'changed',
          payloadHash: 'hash'
        }
      })
      expect(await store.claimStandingWorkNotification(15)).toBeUndefined()
      expect(await store.claimStandingWorkNotification(15, ['agent-a'])).toBeUndefined()
      expect((await store.standingWorkTimeline('org', 'shared-work')).notifications[0]?.status).toBe('pending')
      expect((await store.claimStandingWorkNotification(15, ['agent-b']))?.runId).toBe('shared-run')
    } finally {
      await store.close()
    }
  })

  it('recovers a send with no committed receipt as uncertain without resending', async () => {
    const store = await openTestStore()
    try {
      await store.createStandingWork(
        { ...ambientRow, workId: 'uncertain-send', expiresAt: 10 ** 12 },
        {
          orgId: 'org',
          workId: 'uncertain-send',
          appliedDefinitionVersion: 1,
          nextCheckAt: 10,
          lastRunAt: null,
          lastNotifiedAt: null,
          contextCursor: null,
          observationState: '{}',
          observationSchemaVersion: 1,
          executionEpoch: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          blockedReason: null,
          suggestedNextCheckAt: null,
          wakeSource: 'scheduled'
        }
      )
      await store.claimStandingWorkRun({
        orgId: 'org',
        workId: 'uncertain-send',
        definitionVersion: 1,
        occurrenceId: '1:10',
        dueAt: 10,
        runId: 'run',
        ownerId: 'holder',
        now: 10,
        leaseMs: 100
      })
      await store.reportStandingWork({
        orgId: 'org',
        workId: 'uncertain-send',
        runId: 'run',
        ownerId: 'holder',
        epoch: 1,
        definitionVersion: 1,
        outcome: 'notify',
        now: 11,
        nextCheckAt: 20,
        observationState: '{}',
        notification: { effectId: 'effect', destination: 'slack:channel', payload: 'changed', payloadHash: 'hash' }
      })
      expect((await store.claimStandingWorkNotification(20))?.status).toBe('sending')
      expect(await store.recoverStaleStandingWorkSends(60_019)).toEqual([])
      expect(await store.recoverStaleStandingWorkSends(60_020)).toEqual([
        { orgId: 'org', workId: 'uncertain-send', runId: 'run', agentId: 'agent' }
      ])
      expect((await store.standingWorkTimeline('org', 'uncertain-send')).notifications[0]).toMatchObject({
        status: 'uncertain',
        lastError: 'receipt_missing_after_send'
      })
      expect(await store.claimStandingWorkNotification(60_021)).toBeUndefined()
    } finally {
      await store.close()
    }
  })

  it('fences two holders on one store and lets the successor recover an expired claim', async () => {
    const path = tempStorePath('sw-two-holders-')
    const open = (ownerId: string) =>
      usingPostgresStore()
        ? openTestStore({ shared: true, ownerId, orgForAgent: () => 'org' })
        : LocalStore.open({ database: SqliteAsyncDatabase.open(path), shared: true, ownerId, orgForAgent: () => 'org' })
    const first = await open('holder-a')
    const second = await open('holder-b')
    try {
      await first.createStandingWork(
        { ...ambientRow, workId: 'handoff', expiresAt: 10 ** 12 },
        {
          orgId: 'org',
          workId: 'handoff',
          appliedDefinitionVersion: 1,
          nextCheckAt: 10,
          lastRunAt: null,
          lastNotifiedAt: null,
          contextCursor: null,
          observationState: '{}',
          observationSchemaVersion: 1,
          executionEpoch: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          blockedReason: null,
          suggestedNextCheckAt: null,
          wakeSource: 'scheduled'
        }
      )
      const a = await first.claimStandingWorkRun({
        orgId: 'org',
        workId: 'handoff',
        definitionVersion: 1,
        occurrenceId: '1:10',
        dueAt: 10,
        runId: 'run-a',
        ownerId: 'holder-a',
        now: 10,
        leaseMs: 30
      })
      expect(a).toMatchObject({ attempt: 1, executionEpoch: 1 })
      expect(
        await second.claimStandingWorkRun({
          orgId: 'org',
          workId: 'handoff',
          definitionVersion: 1,
          occurrenceId: '1:10',
          dueAt: 10,
          runId: 'run-b',
          ownerId: 'holder-b',
          now: 11,
          leaseMs: 30
        })
      ).toBeUndefined()
      const b = await second.claimStandingWorkRun({
        orgId: 'org',
        workId: 'handoff',
        definitionVersion: 1,
        occurrenceId: '1:10',
        dueAt: 10,
        runId: 'run-b',
        ownerId: 'holder-b',
        now: 41,
        leaseMs: 30
      })
      expect(b).toMatchObject({ runId: 'run-a', attempt: 2, executionEpoch: 2 })
      expect(
        (
          await first.reportStandingWork({
            orgId: 'org',
            workId: 'handoff',
            runId: 'run-a',
            ownerId: 'holder-a',
            epoch: 1,
            definitionVersion: 1,
            outcome: 'no_change',
            now: 42,
            nextCheckAt: 60,
            observationState: '{}'
          })
        ).status
      ).toBe('stale')
      expect(
        (
          await second.reportStandingWork({
            orgId: 'org',
            workId: 'handoff',
            runId: 'run-a',
            ownerId: 'holder-b',
            epoch: 2,
            definitionVersion: 1,
            outcome: 'no_change',
            now: 42,
            nextCheckAt: 60,
            observationState: '{}'
          })
        ).status
      ).toBe('committed')
    } finally {
      await first.close()
      await second.close()
    }
  })
})

const row = (over: Partial<StandingWorkRow> = {}): StandingWorkRow =>
  ({
    orgId: 'org',
    workId: 'work',
    agentId: 'agent',
    principalId: 'p',
    name: 'watch',
    objective: 'observe',
    state: 'active',
    definitionVersion: 1,
    schedule: '* * * * *',
    timezone: 'UTC',
    scheduleMode: 'fixed',
    maxIntervalSeconds: 86400,
    wakeOnConversation: false,
    targetDestination: '{"integrationId":"i-1","channel":"C1"}',
    expiresAt: 10 ** 12,
    maxRunsPerDay: 3,
    maxNotificationsPerDay: 2,
    approvalVersion: null,
    approvalState: 'pending',
    authorizationRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over
  }) as StandingWorkRow

const state = (over: Partial<StandingWorkStateRow> = {}): StandingWorkStateRow =>
  ({
    orgId: 'org',
    workId: 'work',
    appliedDefinitionVersion: 1,
    nextCheckAt: 5,
    lastRunAt: null,
    lastNotifiedAt: null,
    contextCursor: null,
    observationState: '{}',
    observationSchemaVersion: 1,
    executionEpoch: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    blockedReason: null,
    suggestedNextCheckAt: null,
    wakeSource: 'scheduled',
    ...over
  }) as StandingWorkStateRow

const projection = (over: Partial<StandingWorkProjection> = {}): StandingWorkProjection =>
  ({
    orgId: 'org',
    workId: 'work',
    agentId: 'agent',
    principalId: 'p',
    createdByActorId: 'c',
    lastModifiedByActorId: 'm',
    name: 'watch',
    objective: 'observe',
    state: 'active',
    definitionVersion: 1,
    schedule: '* * * * *',
    timezone: 'UTC',
    startAt: 1,
    expiresAt: 10 ** 12,
    scheduleMode: 'fixed',
    minIntervalSeconds: 60,
    maxIntervalSeconds: 86400,
    maxRunsPerDay: 3,
    maxNotificationsPerDay: 2,
    conversationRef: null,
    targetDestination: { platform: 'slack', integrationId: 'i-1', channel: 'C1' },
    budgetPolicyRef: 'b',
    toolPolicyRef: 't',
    notificationPolicy: { mode: 'changes', includeCompletion: false },
    visibilityPolicyRef: 'v',
    sourceSessionId: null,
    approvalState: 'pending',
    approvalVersion: null,
    authorizationRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over
  }) as unknown as StandingWorkProjection

describe('CP standing-work projection ingestion', () => {
  it('creates a durable row from a first projection and lands the encoded destination', async () => {
    const store = await openTestStore()
    try {
      const service = new StandingWorkService(store, () => 0)
      expect(await service.ingestFromProjection(projection())).toBe('created')
      const landed = await store.getStandingWork('org', 'work')
      expect(landed?.work.targetDestination).toBe('{"platform":"slack","integrationId":"i-1","channel":"C1"}')
      // A valid every-minute schedule yields a real future next-check, not a parked expiry.
      expect(landed?.state.nextCheckAt).toBe(60_000)
      expect(landed?.state.appliedDefinitionVersion).toBe(1)
    } finally {
      await store.close()
    }
  })

  it('parks an expired or unparseable schedule at expiry so the frame still lands', async () => {
    const store = await openTestStore()
    try {
      const service = new StandingWorkService(store, () => 0)
      await service.ingestFromProjection(projection({ workId: 'gone', expiresAt: 500 }))
      expect((await store.getStandingWork('org', 'gone'))?.state.nextCheckAt).toBe(500)
    } finally {
      await store.close()
    }
  })

  it('replaces on a higher authoritative version: re-fences the schedule, clears the lease, keeps the epoch', async () => {
    const store = await openTestStore()
    try {
      await store.createStandingWork(
        row({ approvalState: 'approved', approvalVersion: 1 }),
        state({ nextCheckAt: 10, executionEpoch: 4, leaseOwner: 'one', leaseExpiresAt: 9_999 })
      )
      const service = new StandingWorkService(store, () => 0)
      expect(
        await service.ingestFromProjection(
          projection({
            definitionVersion: 2,
            name: 'watch edited',
            objective: 'observe safely',
            schedule: '*/5 * * * *',
            approvalState: 'pending',
            approvalVersion: null
          })
        )
      ).toBe('replaced')
      const after = await store.getStandingWork('org', 'work')
      expect(after?.work).toMatchObject({
        definitionVersion: 2,
        name: 'watch edited',
        objective: 'observe safely',
        approvalState: 'pending',
        approvalVersion: null
      })
      // The new version re-fences nextCheckAt (5-min cron) and drops the in-flight lease, but the fencing
      // epoch survives so the abandoned old-version run's report is fenced out rather than accepted.
      expect(after?.state).toMatchObject({
        appliedDefinitionVersion: 2,
        nextCheckAt: 300_000,
        executionEpoch: 4,
        leaseOwner: null
      })
    } finally {
      await store.close()
    }
  })

  it('suppresses the retired version’s pending notifications on replace', async () => {
    const store = await openTestStore()
    try {
      await store.createStandingWork(row({ approvalState: 'approved', approvalVersion: 1 }), state({ nextCheckAt: 10 }))
      await store.claimStandingWorkRun({
        orgId: 'org',
        workId: 'work',
        definitionVersion: 1,
        occurrenceId: '1:10',
        dueAt: 10,
        runId: 'run',
        ownerId: 'one',
        now: 10,
        leaseMs: 100
      })
      await store.reportStandingWork({
        orgId: 'org',
        workId: 'work',
        runId: 'run',
        ownerId: 'one',
        epoch: 1,
        definitionVersion: 1,
        outcome: 'notify',
        now: 11,
        nextCheckAt: 20,
        observationState: '{}',
        notification: {
          effectId: 'effect',
          destination: row().targetDestination,
          payload: 'changed',
          payloadHash: 'hash'
        }
      })
      const before = await store.claimStandingWorkNotification(15)
      expect(before?.runId).toBe('run')
      await store.settleStandingWorkNotification({
        orgId: 'org',
        runId: 'run',
        notificationIndex: 0,
        status: 'failed',
        now: 16,
        retryAt: 30
      })
      const service = new StandingWorkService(store, () => 0)
      expect(await service.ingestFromProjection(projection({ definitionVersion: 2 }))).toBe('replaced')
      expect(
        (await store.standingWorkTimeline('org', 'work')).notifications.find((n) => n.runId === 'run')?.status
      ).toBe('suppressed')
    } finally {
      await store.close()
    }
  })

  it('mirrors approval at the same version but never reopens a daemon-terminal row', async () => {
    const store = await openTestStore()
    try {
      // Completion is a daemon-local fact that does not bump the version; the CP may still project `active`.
      await store.createStandingWork(
        row({ state: 'completed', approvalState: 'approved', approvalVersion: 1 }),
        state({ nextCheckAt: 10 })
      )
      const service = new StandingWorkService(store, () => 0)
      expect(
        await service.ingestFromProjection(
          projection({ state: 'active', approvalState: 'approved', approvalVersion: 1 })
        )
      ).toBe('noop')
      const after = await store.getStandingWork('org', 'work')
      expect(after?.work.state).toBe('completed')
      expect(after?.state.nextCheckAt).toBe(10)
    } finally {
      await store.close()
    }
  })

  it('lands a CP approval the live control frame missed', async () => {
    const store = await openTestStore()
    try {
      await store.createStandingWork(
        row({ approvalState: 'pending', approvalVersion: null }),
        state({ nextCheckAt: 10 })
      )
      const service = new StandingWorkService(store, () => 0)
      expect(await service.ingestFromProjection(projection({ approvalState: 'approved', approvalVersion: 1 }))).toBe(
        'noop'
      )
      expect(await store.getStandingWork('org', 'work')).toMatchObject({
        work: { approvalState: 'approved', approvalVersion: 1 }
      })
    } finally {
      await store.close()
    }
  })

  it('ignores a stale projection behind the local version', async () => {
    const store = await openTestStore()
    try {
      await store.createStandingWork(row({ definitionVersion: 3, name: 'current' }), state({}))
      const service = new StandingWorkService(store, () => 0)
      expect(await service.ingestFromProjection(projection({ definitionVersion: 2, name: 'ancient' }))).toBe('stale')
      expect((await store.getStandingWork('org', 'work'))?.work.name).toBe('current')
    } finally {
      await store.close()
    }
  })
})

describe('standing-work/report emission', () => {
  const agentId = '9a3f5b6c-1d2e-4f30-8a1b-2c3d4e5f6071'
  const definition = {
    orgId: 'org',
    agentId,
    principalId: 'principal',
    actorId: 'actor',
    name: 'watch',
    objective: 'observe',
    schedule: '* * * * *',
    timezone: 'UTC',
    targetDestination: 'slack:channel',
    authorizationRevision: 1
  }

  it('renews the durable lease while an ambient turn is still running', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z')
    const store = await openTestStore()
    const originalSetInterval = globalThis.setInterval
    let heartbeat: (() => void) | undefined
    const intervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      callback: () => void,
      delay: number
    ) => {
      if (delay === 10_000) {
        heartbeat = callback
        return originalSetInterval(() => {}, 1_000_000)
      }
      return originalSetInterval(callback, delay)
    }) as typeof setInterval)
    let finish!: (value: { report: { outcome: 'no_change' }; observationState: object }) => void
    const inFlight = new Promise<{ report: { outcome: 'no_change' }; observationState: object }>((resolve) => {
      finish = resolve
    })
    try {
      const service = new StandingWorkService(store, () => now)
      const { workId } = await service.create({ ...definition, expiresAt: now + 3_600_000 }, 'allow')
      now += 60_000
      const pump = new StandingWorkPump(
        store,
        service,
        'daemon-a',
        { execute: () => inFlight },
        { send: async () => ({ status: 'delivered' }) },
        () => now
      )
      const sweep = pump.tick()
      await vi.waitFor(() => expect(heartbeat).toBeTypeOf('function'))
      now += 20_000
      heartbeat!()
      await vi.waitFor(async () =>
        expect((await store.getStandingWork('org', workId))?.state.leaseExpiresAt).toBe(now + 30_000)
      )
      now += 20_000 // past the original 30-second lease, within the renewed one
      finish({ report: { outcome: 'no_change' }, observationState: {} })
      await sweep
      expect((await store.standingWorkTimeline('org', workId)).runs[0]?.status).toBe('no_change')
      pump.stop()
    } finally {
      intervalSpy.mockRestore()
      await store.close()
    }
  })

  it('reports a committed run and, separately, its unsettled delivery', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z')
    const store = await openTestStore()
    try {
      const service = new StandingWorkService(store, () => now)
      const { workId } = await service.create({ ...definition, expiresAt: now + 3_600_000 }, 'allow')
      now += 60_000
      const emitted: StandingWorkRunReport[] = []
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
        { send: async () => ({ status: 'uncertain' as const, receipt: 'msg-1', error: 'provider timeout' }) },
        () => now,
        () => true,
        { emit: (report) => emitted.push(report) }
      )
      await pump.tick()
      expect(emitted).toHaveLength(2)
      const [committed, settled] = emitted as [StandingWorkRunReport, StandingWorkRunReport]
      expect(StandingWorkRunReport.parse(committed)).toMatchObject({
        workId,
        agentId,
        outcome: 'notify',
        attempt: 1,
        notification: { status: 'pending' }
      })
      expect(committed.runId).toBe(settled.runId)
      // The delivery transition is its own fact: the run's outcome never rewrites, only delivery moves.
      expect(settled.outcome).toBe('notify')
      expect(settled.notification).toMatchObject({ status: 'uncertain', receipt: 'msg-1', error: 'provider timeout' })
      expect(JSON.stringify([committed, settled])).not.toContain('prod is down')
    } finally {
      await store.close()
    }
  })

  it('reports a failed attempt when the turn throws, without committing the occurrence', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z')
    const store = await openTestStore()
    try {
      const service = new StandingWorkService(store, () => now)
      const { workId } = await service.create({ ...definition, expiresAt: now + 3_600_000 }, 'allow')
      now += 60_000
      const emitted: StandingWorkRunReport[] = []
      const pump = new StandingWorkPump(
        store,
        service,
        'daemon-a',
        {
          execute: async () => {
            throw new Error('runtime exploded')
          }
        },
        { send: async () => ({ status: 'delivered' as const }) },
        () => now,
        () => true,
        { emit: (report) => emitted.push(report) }
      )
      await pump.tick()
      expect(StandingWorkRunReport.parse(emitted[0]!)).toMatchObject({
        workId,
        outcome: 'failed',
        errorCode: 'turn_error'
      })
      expect((await store.standingWorkTimeline('org', workId)).runs[0]?.status).toBe('running')
    } finally {
      await store.close()
    }
  })

  it('re-asserts persisted terminal runs on reconnect and skips a row still in flight', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z')
    const store = await openTestStore()
    try {
      const service = new StandingWorkService(store, () => now)
      const { workId } = await service.create({ ...definition, expiresAt: now + 3_600_000 }, 'allow')
      now += 60_000
      const pump = new StandingWorkPump(
        store,
        service,
        'daemon-a',
        { execute: async () => ({ report: { outcome: 'no_change' as const }, observationState: {} }) },
        { send: async () => ({ status: 'delivered' as const }) },
        () => now,
        () => true,
        { emit: () => {} }
      )
      await pump.tick()
      const inFlight = await store.claimStandingWorkRun({
        orgId: 'org',
        workId,
        definitionVersion: 1,
        occurrenceId: 'next',
        dueAt: now + 60_000,
        runId: 'in-flight',
        ownerId: 'daemon-b',
        now: now + 60_000,
        leaseMs: 5_000
      })
      expect(inFlight?.status).toBe('running')
      const feed = standingWorkReportCatchup(await store.standingWorkReportFeed())
      expect(feed).toHaveLength(1)
      expect(feed[0]).toMatchObject({ workId, agentId, outcome: 'no_change' })
    } finally {
      await store.close()
    }
  })
})
