import { describe, expect, it } from 'vitest'
import { isInstallWideFrameType } from '../frame-scope.js'
import { StandingWorkControl, StandingWorkProjection, StandingWorkRunReport } from './standing-work.js'

const WORK = '11111111-1111-4111-8111-111111111111'
const AGENT = '22222222-2222-4222-8222-222222222222'
const RUN = '33333333-3333-4333-8333-333333333333'
const INTEGRATION = '44444444-4444-4444-8444-444444444444'
const STARTED = Date.parse('2026-09-22T09:00:00.000Z')

const wireRun = {
  workId: WORK,
  agentId: AGENT,
  runId: RUN,
  definitionVersion: 1,
  executionEpoch: 0,
  attempt: 1,
  outcome: 'notify',
  startedAt: STARTED
}

describe('standing-work/report (StandingWorkRunReport)', () => {
  it('accepts the smallest honest report — a fired run, nothing settled yet', () => {
    const parsed = StandingWorkRunReport.parse(wireRun)
    expect(parsed.outcome).toBe('notify')
    // Absent, not zero: an unfinished run has no finish stamp, and a run with nothing to send
    // carries no delivery row at all.
    expect(parsed.finishedAt).toBeUndefined()
    expect(parsed.notification).toBeUndefined()
  })

  it('accepts a run with its delivery and a session to link back to', () => {
    expect(
      StandingWorkRunReport.parse({
        ...wireRun,
        finishedAt: STARTED + 4200,
        sessionId: 'ses_1',
        errorCode: 'provider_timeout',
        notification: { index: 0, effectId: 'eff_1', status: 'delivered', receipt: 'slack:123' }
      })
    ).toMatchObject({ notification: { status: 'delivered', receipt: 'slack:123' } })
  })

  it('keeps `uncertain` a first-class delivery state', () => {
    const parsed = StandingWorkRunReport.parse({
      ...wireRun,
      notification: { index: 0, effectId: 'eff_1', status: 'uncertain' }
    })
    expect(parsed.notification?.status).toBe('uncertain')
  })

  it('refuses an `orgId` in the payload — the org rides the envelope, not the daemon’s claim', () => {
    // The frame's org is resolved from `agentId` and fenced against the connection, so a payload
    // field would be a second, contradictable source of the same fact.
    expect(StandingWorkRunReport.safeParse({ ...wireRun, orgId: 'org-b' }).success).toBe(false)
  })

  it('refuses notification content — only status, receipt and error code cross the wire', () => {
    for (const body of [{ text: 'the message' }, { objective: 'what it decided' }, { toolOutput: '…' }]) {
      expect(
        StandingWorkRunReport.safeParse({
          ...wireRun,
          notification: { index: 0, effectId: 'eff_1', status: 'delivered', ...body }
        }).success
      ).toBe(false)
    }
    expect(StandingWorkRunReport.safeParse({ ...wireRun, output: 'prose' }).success).toBe(false)
  })

  it('requires the fences to be real numbers', () => {
    expect(StandingWorkRunReport.safeParse({ ...wireRun, agentId: 'not-a-uuid' }).success).toBe(false)
    expect(StandingWorkRunReport.safeParse({ ...wireRun, runId: 'not-a-uuid' }).success).toBe(false)
    expect(StandingWorkRunReport.safeParse({ ...wireRun, definitionVersion: 0 }).success).toBe(false)
    expect(StandingWorkRunReport.safeParse({ ...wireRun, attempt: 0 }).success).toBe(false)
    expect(StandingWorkRunReport.safeParse({ ...wireRun, executionEpoch: -1 }).success).toBe(false)
    const { attempt: _missing, ...withoutAttempt } = wireRun
    expect(StandingWorkRunReport.safeParse(withoutAttempt).success).toBe(false)
  })

  it('refuses an outcome or delivery status outside the known sets', () => {
    expect(StandingWorkRunReport.safeParse({ ...wireRun, outcome: 'maybe' }).success).toBe(false)
    expect(
      StandingWorkRunReport.safeParse({
        ...wireRun,
        notification: { index: 0, effectId: 'e', status: 'probably-sent' }
      }).success
    ).toBe(false)
  })

  it('caps the free-text fields it does carry', () => {
    expect(StandingWorkRunReport.safeParse({ ...wireRun, errorCode: 'x'.repeat(65) }).success).toBe(false)
    expect(
      StandingWorkRunReport.safeParse({
        ...wireRun,
        notification: { index: 0, effectId: 'e', status: 'failed', error: 'x'.repeat(513) }
      }).success
    ).toBe(false)
    expect(
      StandingWorkRunReport.safeParse({
        ...wireRun,
        notification: { index: 0, effectId: 'e', status: 'failed', receipt: 'x'.repeat(257) }
      }).success
    ).toBe(false)
  })

  it('is an org-scoped frame, like every report that resolves an agent', () => {
    expect(isInstallWideFrameType('standing-work/report')).toBe(false)
  })
})

describe('standing-work/control (StandingWorkControl)', () => {
  const authority = { actorId: 'actor-1', canManage: true, canApprove: true, authorizationRevision: 3 }

  it('carries the CP-resolved authority alongside the lifecycle action', () => {
    expect(
      StandingWorkControl.parse({ authority, action: 'cancel', orgId: 'org-a', workId: WORK, version: 2 })
    ).toMatchObject({
      action: 'cancel',
      version: 2
    })
  })

  it('refuses a control with no authority and one that invents its own action', () => {
    expect(StandingWorkControl.safeParse({ action: 'cancel', orgId: 'org-a', workId: WORK, version: 2 }).success).toBe(
      false
    )
    expect(
      StandingWorkControl.safeParse({ authority, action: 'delete', orgId: 'org-a', workId: WORK, version: 2 }).success
    ).toBe(false)
    expect(
      StandingWorkControl.safeParse({
        authority: { ...authority, canManage: 'yes' },
        action: 'pause',
        orgId: 'org-a',
        workId: WORK,
        version: 2
      }).success
    ).toBe(false)
  })

  it('requires the version it fences on', () => {
    expect(
      StandingWorkControl.safeParse({ authority, action: 'resume', orgId: 'org-a', workId: WORK, version: 0 }).success
    ).toBe(false)
  })
})

describe('StandingWorkProjection', () => {
  const projection = {
    orgId: 'org-a',
    workId: WORK,
    agentId: AGENT,
    principalId: 'standing-work:org-a',
    createdByActorId: 'actor-1',
    lastModifiedByActorId: 'actor-1',
    name: 'Watch the rollout',
    objective: 'Observe the rollout and report changes',
    state: 'active',
    definitionVersion: 1,
    schedule: '0 9 * * *',
    timezone: 'Asia/Singapore',
    startAt: STARTED,
    expiresAt: STARTED + 86_400_000,
    minIntervalSeconds: 60,
    maxRunsPerDay: 24,
    maxNotificationsPerDay: 2,
    conversationRef: null,
    targetDestination: { platform: 'slack', integrationId: INTEGRATION, channel: 'C1' },
    budgetPolicyRef: 'default',
    toolPolicyRef: 'read-only',
    notificationPolicy: { mode: 'changes', includeCompletion: true },
    visibilityPolicyRef: 'agent',
    sourceSessionId: null,
    approvalState: 'pending',
    approvalVersion: null,
    authorizationRevision: 3,
    createdAt: STARTED,
    updatedAt: STARTED
  }

  it('lands a full definition, including the approval it must not assume', () => {
    expect(StandingWorkProjection.parse(projection)).toMatchObject({
      workId: WORK,
      approvalState: 'pending',
      approvalVersion: null
    })
  })

  it('refuses a definition missing its approval or its destination', () => {
    const { approvalState: _a, approvalVersion: _v, ...unapproved } = projection
    expect(StandingWorkProjection.safeParse(unapproved).success).toBe(false)
    const { targetDestination: _d, ...destinationless } = projection
    expect(StandingWorkProjection.safeParse(destinationless).success).toBe(false)
  })

  it('refuses a schedule the daemon would fire too often to be durable work', () => {
    expect(StandingWorkProjection.safeParse({ ...projection, minIntervalSeconds: 5 }).success).toBe(false)
  })
})
