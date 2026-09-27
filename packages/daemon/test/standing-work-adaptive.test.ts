import { describe, expect, it, vi } from 'vitest'
import { openTestStore } from './store-support.js'
import {
  computeAdaptiveNextCheckAt,
  StandingWorkService,
  StandingWorkAmbientExecutor,
  type AmbientTurnRunner,
  type FixedStandingWorkDefinition
} from '../src/execution/standing-work.js'
import type { StandingWorkRow, StandingWorkStateRow } from '../src/store/local-store.js'

const baseDefinition = (overrides?: Partial<FixedStandingWorkDefinition>): FixedStandingWorkDefinition => ({
  orgId: 'org',
  agentId: 'agent',
  principalId: 'p',
  actorId: 'actor',
  name: 'watch',
  objective: 'observe',
  schedule: '*/5 * * * *',
  timezone: 'UTC',
  targetDestination: '{"integrationId":"i-1","channel":"C1"}',
  expiresAt: Date.now() + 86_400_000,
  authorizationRevision: 1,
  ...overrides
})

describe('computeAdaptiveNextCheckAt', () => {
  const now = 1_000_000
  const minInterval = 60
  const maxInterval = 3600
  const expiresAt = now + 86_400_000

  it('clamps a valid suggestion to [now+min, now+max]', () => {
    const suggested = new Date(now + 120_000).toISOString()
    const result = computeAdaptiveNextCheckAt({
      suggestedIso: suggested,
      now,
      minIntervalSeconds: minInterval,
      maxIntervalSeconds: maxInterval,
      lastRunAt: null,
      lastRunFailed: false,
      expiresAt
    })
    expect(result.nextCheckAt).toBe(now + 120_000)
    expect(result.expired).toBe(false)
  })

  it('clamps a suggestion below minInterval up to now+min', () => {
    const suggested = new Date(now + 10_000).toISOString()
    const result = computeAdaptiveNextCheckAt({
      suggestedIso: suggested,
      now,
      minIntervalSeconds: minInterval,
      maxIntervalSeconds: maxInterval,
      lastRunAt: null,
      lastRunFailed: false,
      expiresAt
    })
    expect(result.nextCheckAt).toBe(now + minInterval * 1000)
  })

  it('clamps a suggestion above maxInterval down to now+max', () => {
    const suggested = new Date(now + 999_999_000).toISOString()
    const result = computeAdaptiveNextCheckAt({
      suggestedIso: suggested,
      now,
      minIntervalSeconds: minInterval,
      maxIntervalSeconds: maxInterval,
      lastRunAt: null,
      lastRunFailed: false,
      expiresAt
    })
    expect(result.nextCheckAt).toBe(now + maxInterval * 1000)
  })

  it('falls back to minInterval when suggestion is missing or unparseable', () => {
    expect(
      computeAdaptiveNextCheckAt({
        suggestedIso: undefined,
        now,
        minIntervalSeconds: minInterval,
        maxIntervalSeconds: maxInterval,
        lastRunAt: null,
        lastRunFailed: false,
        expiresAt
      }).nextCheckAt
    ).toBe(now + minInterval * 1000)
    expect(
      computeAdaptiveNextCheckAt({
        suggestedIso: 'not-a-date',
        now,
        minIntervalSeconds: minInterval,
        maxIntervalSeconds: maxInterval,
        lastRunAt: null,
        lastRunFailed: false,
        expiresAt
      }).nextCheckAt
    ).toBe(now + minInterval * 1000)
  })

  it('applies exponential backoff when lastRunFailed', () => {
    const lastRunAt = now - 5000
    const result = computeAdaptiveNextCheckAt({
      suggestedIso: undefined,
      now,
      minIntervalSeconds: minInterval,
      maxIntervalSeconds: maxInterval,
      lastRunAt,
      lastRunFailed: true,
      expiresAt
    })
    expect(result.nextCheckAt).toBeGreaterThanOrEqual(now + 10_000)
  })

  it('marks expired when nextCheckAt exceeds expiresAt', () => {
    const nearExpiry = now + 1000
    const result = computeAdaptiveNextCheckAt({
      suggestedIso: undefined,
      now,
      minIntervalSeconds: minInterval,
      maxIntervalSeconds: maxInterval,
      lastRunAt: null,
      lastRunFailed: false,
      expiresAt: nearExpiry
    })
    expect(result.expired).toBe(true)
  })
})

describe('StandingWorkService adaptive scheduling', () => {
  it('creates adaptive work with scheduleMode and maxIntervalSeconds', async () => {
    const store = await openTestStore()
    try {
      const now = Date.now()
      const service = new StandingWorkService(store, () => now)
      const def = baseDefinition({ scheduleMode: 'adaptive', maxIntervalSeconds: 7200 })
      const { workId } = await service.create(def, 'allow')
      const item = await store.getStandingWork('org', workId)
      expect(item).toBeDefined()
      expect(item!.work.scheduleMode).toBe('adaptive')
      expect(item!.work.maxIntervalSeconds).toBe(7200)
    } finally {
      await store.close()
    }
  })

  it('defaults to fixed scheduleMode when not specified', async () => {
    const store = await openTestStore()
    try {
      const now = Date.now()
      const service = new StandingWorkService(store, () => now)
      const { workId } = await service.create(baseDefinition())
      const item = await store.getStandingWork('org', workId)
      expect(item!.work.scheduleMode).toBe('fixed')
      expect(item!.work.maxIntervalSeconds).toBe(86_400)
    } finally {
      await store.close()
    }
  })

  it('rejects adaptive work with maxIntervalSeconds below 60', async () => {
    const store = await openTestStore()
    try {
      const service = new StandingWorkService(store, () => Date.now())
      await expect(
        service.create(baseDefinition({ scheduleMode: 'adaptive', maxIntervalSeconds: 30 }), 'allow')
      ).rejects.toThrow('maxIntervalSeconds')
    } finally {
      await store.close()
    }
  })

  it('fixed mode rejects a report with nextCheckAt', async () => {
    const store = await openTestStore()
    try {
      const now = Date.now()
      const service = new StandingWorkService(store, () => now)
      const workId = 'test-fixed-reject'
      await store.createStandingWork(
        {
          orgId: 'org',
          workId,
          agentId: 'agent',
          principalId: 'p',
          name: 'watch',
          objective: 'observe',
          state: 'active',
          definitionVersion: 1,
          schedule: '*/5 * * * *',
          timezone: 'UTC',
          scheduleMode: 'fixed',
          maxIntervalSeconds: 86400,
          targetDestination: '{"integrationId":"i-1","channel":"C1"}',
          expiresAt: now + 86_400_000,
          maxRunsPerDay: 3,
          maxNotificationsPerDay: 2,
          approvalVersion: 1,
          approvalState: 'approved',
          authorizationRevision: 1,
          createdAt: now,
          updatedAt: now
        } as StandingWorkRow,
        {
          orgId: 'org',
          workId,
          appliedDefinitionVersion: 1,
          nextCheckAt: now - 1000,
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
        } as StandingWorkStateRow
      )
      const claimed = await service.claimDue('org', workId, 'owner')
      if (!claimed) throw new Error('claim failed')
      await expect(
        service.report(
          'org',
          workId,
          claimed.runId,
          'owner',
          claimed.executionEpoch,
          { outcome: 'no_change', nextCheckAt: new Date(now + 120_000).toISOString() },
          {}
        )
      ).rejects.toThrow('fixed standing work does not accept report-controlled scheduling')
    } finally {
      await store.close()
    }
  })
})

describe('ambient executor adaptive passthrough', () => {
  const adaptiveRow = {
    orgId: 'org',
    workId: 'work',
    agentId: 'agent',
    principalId: 'p',
    name: 'watch',
    objective: 'observe',
    state: 'active',
    definitionVersion: 1,
    schedule: '*/5 * * * *',
    timezone: 'UTC',
    scheduleMode: 'adaptive' as const,
    maxIntervalSeconds: 3600,
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

  const fixedRow = { ...adaptiveRow, scheduleMode: 'fixed' as const } as unknown as StandingWorkRow

  it('passes nextCheckAt through for adaptive mode work', async () => {
    const nextCheck = new Date(Date.now() + 300_000).toISOString()
    const runner = vi.fn<AmbientTurnRunner['run']>(async () => ({
      output: `{"outcome":"no_change","nextCheckAt":"${nextCheck}","observationState":{}}`
    }))
    const exec = new StandingWorkAmbientExecutor({ run: runner })
    const out = await exec.execute({
      work: adaptiveRow,
      runId: 'run',
      executionEpoch: 1,
      signal: new AbortController().signal,
      observationState: {}
    })
    expect(out.report.nextCheckAt).toBe(nextCheck)
  })

  it('strips nextCheckAt for fixed mode work', async () => {
    const nextCheck = new Date(Date.now() + 300_000).toISOString()
    const runner = vi.fn<AmbientTurnRunner['run']>(async () => ({
      output: `{"outcome":"no_change","nextCheckAt":"${nextCheck}","observationState":{}}`
    }))
    const exec = new StandingWorkAmbientExecutor({ run: runner })
    const out = await exec.execute({
      work: fixedRow,
      runId: 'run',
      executionEpoch: 1,
      signal: new AbortController().signal,
      observationState: {}
    })
    expect(out.report.nextCheckAt).toBeUndefined()
  })

  it('uses the adaptive system prompt for adaptive work', async () => {
    const runner = vi.fn<AmbientTurnRunner['run']>(async () => ({
      output: '{"outcome":"no_change","observationState":{}}'
    }))
    const exec = new StandingWorkAmbientExecutor({ run: runner })
    await exec.execute({
      work: adaptiveRow,
      runId: 'run',
      executionEpoch: 1,
      signal: new AbortController().signal,
      observationState: {}
    })
    expect(runner.mock.calls[0]![0].systemPrompt).toContain('nextCheckAt')
  })

  it('uses the fixed system prompt for fixed work', async () => {
    const runner = vi.fn<AmbientTurnRunner['run']>(async () => ({
      output: '{"outcome":"no_change","observationState":{}}'
    }))
    const exec = new StandingWorkAmbientExecutor({ run: runner })
    await exec.execute({
      work: fixedRow,
      runId: 'run',
      executionEpoch: 1,
      signal: new AbortController().signal,
      observationState: {}
    })
    expect(runner.mock.calls[0]![0].systemPrompt).not.toContain('nextCheckAt')
  })
})
