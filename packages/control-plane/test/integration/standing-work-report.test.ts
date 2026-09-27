/**
 * `standing-work/report` (D→C EVT) → the console's run timeline, end to end on the CP side.
 *
 * Same shape as `cron-report.test.ts`: the real handler over the real repos, so the fences are the
 * ones production runs.
 *
 *  - Serve fence: only a daemon that acts for the definition's OWN agent may report its runs. The
 *    agent comes from the stored definition, never from the payload.
 *  - Org fence: no resolvable org ⇒ the report is inert.
 *  - Version/epoch/attempt fence: a stale executor's re-assert drops silently instead of regressing
 *    a newer truth.
 *  - A settled delivery is never reopened, and `uncertain` in particular survives — the daemon
 *    could not prove the post, and that is the honest answer the console must keep seeing.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { PgStandingWorkRepo } from '../../src/persistence/repositories/standing-work.repo.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgDutyGroupRepo } from '../../src/persistence/repositories/duty-group.repo.js'
import { PlacementResolver } from '../../src/orchestrator/placementResolver.js'
import { systemClock } from '../../src/domain/clock.js'
import { handleStandingWorkReport } from '../../src/ws/handlers/standing-work-report.js'
import { OrgId } from '../../src/domain/ids.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import type { AnyFrame, StandingWorkRunReport } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OTHER_DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const BASE = Date.parse('2026-09-22T09:00:00.000Z')

const definition = (agentId: string) => ({
  orgId: DEFAULT_ORG_ID,
  actorId: 'human-1',
  authorizationRevision: 1,
  idempotencyKey: `create-${randomUUID()}`,
  requestHash: 'hash-1',
  agentId,
  principalId: `standing-work:${DEFAULT_ORG_ID}`,
  name: 'Watch rollout',
  objective: 'Observe the rollout',
  schedule: '0 9 * * *',
  timezone: 'UTC',
  startAt: new Date(BASE),
  expiresAt: new Date(BASE + 86_400_000),
  minIntervalSeconds: 60,
  maxRunsPerDay: 24,
  maxNotificationsPerDay: 2,
  conversationRef: null,
  targetDestination: {
    platform: 'slack',
    integrationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    channel: 'C1'
  },
  budgetPolicyRef: 'default',
  toolPolicyRef: 'read-only',
  notificationPolicy: { mode: 'changes' as const, includeCompletion: true },
  visibilityPolicyRef: 'agent',
  sourceSessionId: null,
  scheduleMode: 'fixed' as const,
  maxIntervalSeconds: 86400,
  wakeOnConversation: false
})

function deps(): DaemonWsDeps {
  return {
    standingWork: new PgStandingWorkRepo(prisma),
    agent: new PgAgentRepo(prisma),
    placementResolver: new PlacementResolver({ duties: new PgDutyGroupRepo(prisma), clock: systemClock })
  } as unknown as DaemonWsDeps
}

/** Dispatch a report through the real handler as if `daemonId` sent it. */
async function report(
  daemonId: string,
  payload: Partial<StandingWorkRunReport> & { workId: string; agentId: string; runId: string },
  orgId: string | null = DEFAULT_ORG_ID
): Promise<void> {
  const frame = {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: 'standing-work/report',
    orgId,
    payload: {
      definitionVersion: 1,
      executionEpoch: 0,
      attempt: 1,
      outcome: 'no_change',
      startedAt: BASE,
      ...payload
    }
  } as unknown as AnyFrame
  await handleStandingWorkReport(frame, { daemonId } as DaemonConnection, deps())
}

/** Seed a daemon-placed agent plus one Standing Work definition for it. */
async function seeded(): Promise<{ agentId: string; workId: string; repo: PgStandingWorkRepo }> {
  await seedDaemon(prisma, DAEMON)
  await seedDaemon(prisma, OTHER_DAEMON)
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON })
  const repo = new PgStandingWorkRepo(prisma)
  const created = await repo.create(definition(agentId))
  if (created === 'conflict') throw new Error('unexpected idempotency conflict')
  return { agentId, workId: created.record.id, repo }
}

const runs = (workId: string) => new PgStandingWorkRepo(prisma).listRuns(OrgId(DEFAULT_ORG_ID), workId)

describe('standing-work/report EVT → run timeline', () => {
  it('records a run from the serving daemon; a foreign daemon’s report never lands', async () => {
    const { agentId, workId } = await seeded()

    await report(OTHER_DAEMON, { workId, agentId, runId: randomUUID(), outcome: 'notify' })
    expect(await runs(workId)).toEqual([])

    const runId = randomUUID()
    await report(DAEMON, { workId, agentId, runId, outcome: 'notify', finishedAt: BASE + 4200, sessionId: 'ses_1' })
    expect(await runs(workId)).toMatchObject([{ runId, outcome: 'notify', sessionId: 'ses_1', notification: null }])
  })

  it('fences on the definition’s own agent, not the agent the payload names', async () => {
    const { agentId, workId } = await seeded()
    // A second agent placed on the OTHER daemon: reporting under its id is a claim about who the
    // run belongs to. The fence reads the stored definition's agent, so the claim buys nothing —
    // and it must not cost the legitimate report either.
    const claimedAgent = randomUUID()
    await seedAgent(prisma, claimedAgent, { daemonId: OTHER_DAEMON })
    await report(DAEMON, { workId, agentId: claimedAgent, runId: randomUUID() })
    expect(await runs(workId)).toHaveLength(1)

    // The mirror case: the right agent in the payload, the wrong sender.
    await report(OTHER_DAEMON, { workId, agentId, runId: randomUUID() })
    expect(await runs(workId)).toHaveLength(1)
  })

  it('an unknown work id and an unresolvable org both drop silently', async () => {
    const { agentId, workId } = await seeded()
    await expect(report(DAEMON, { workId: randomUUID(), agentId, runId: randomUUID() })).resolves.toBeUndefined()

    // A pool-less read with no org anywhere on the frame or connection has nothing to fence on.
    await report(DAEMON, { workId, agentId, runId: randomUUID() }, null)
    expect(await runs(workId)).toEqual([])
  })

  it('a report into another organization never touches this one’s runs', async () => {
    const { agentId, workId } = await seeded()
    await report(DAEMON, { workId, agentId, runId: randomUUID() }, 'other-org')
    expect(await runs(workId)).toEqual([])
  })

  it('the fences are ordered: an older version, epoch or attempt never regresses the stored run', async () => {
    const { agentId, workId } = await seeded()
    const runId = randomUUID()

    await report(DAEMON, {
      workId,
      agentId,
      runId,
      definitionVersion: 2,
      executionEpoch: 3,
      attempt: 2,
      outcome: 'failed',
      errorCode: 'turn_error'
    })
    await report(DAEMON, { workId, agentId, runId, definitionVersion: 1, outcome: 'no_change' }) // stale definition version
    expect((await runs(workId))[0]).toMatchObject({ outcome: 'failed', definitionVersion: 2 })

    await report(DAEMON, { workId, agentId, runId, definitionVersion: 2, executionEpoch: 1, outcome: 'no_change' }) // stale epoch
    expect((await runs(workId))[0]).toMatchObject({ outcome: 'failed', executionEpoch: 3 })

    await report(DAEMON, {
      workId,
      agentId,
      runId,
      definitionVersion: 2,
      executionEpoch: 3,
      attempt: 1,
      outcome: 'no_change'
    }) // stale attempt
    expect((await runs(workId))[0]).toMatchObject({ outcome: 'failed', attempt: 2 })

    // A newer attempt within the same occurrence — the retry after a lease reclaim — does land.
    await report(DAEMON, {
      workId,
      agentId,
      runId,
      definitionVersion: 2,
      executionEpoch: 3,
      attempt: 3,
      outcome: 'complete',
      finishedAt: BASE + 9000
    })
    expect((await runs(workId))[0]).toMatchObject({
      outcome: 'complete',
      attempt: 3,
      finishedAt: new Date(BASE + 9000)
    })
  })

  it('keeps run outcome and delivery separate, and never reopens a settled delivery', async () => {
    const { agentId, workId } = await seeded()
    const runId = randomUUID()

    // The committed `notify` run reports first, with the send still in flight.
    await report(DAEMON, {
      workId,
      agentId,
      runId,
      outcome: 'notify',
      finishedAt: BASE + 4200,
      notification: { index: 0, effectId: 'eff_1', status: 'sending' }
    })
    expect((await runs(workId))[0]).toMatchObject({
      outcome: 'notify',
      notification: { status: 'sending', effectId: 'eff_1' }
    })

    // A re-assert of the same run with a late `pending` cannot pull the settled row backwards.
    await report(DAEMON, {
      workId,
      agentId,
      runId,
      outcome: 'notify',
      notification: { index: 0, effectId: 'eff_1', status: 'delivered', receipt: 'slack-123' }
    })
    expect((await runs(workId))[0]!.notification).toMatchObject({ status: 'delivered', providerReceipt: 'slack-123' })
    await report(DAEMON, {
      workId,
      agentId,
      runId,
      outcome: 'notify',
      notification: { index: 0, effectId: 'eff_1', status: 'pending' }
    })
    expect((await runs(workId))[0]!.notification).toMatchObject({ status: 'delivered' })
  })

  it('an `uncertain` delivery survives every later report — it is the honest end state, not a failure', async () => {
    const { agentId, workId } = await seeded()
    const runId = randomUUID()

    await report(DAEMON, {
      workId,
      agentId,
      runId,
      outcome: 'notify',
      notification: { index: 0, effectId: 'eff_1', status: 'uncertain', error: 'provider_timeout' }
    })
    expect((await runs(workId))[0]!.notification).toMatchObject({ status: 'uncertain', error: 'provider_timeout' })

    await report(DAEMON, {
      workId,
      agentId,
      runId,
      outcome: 'notify',
      notification: { index: 0, effectId: 'eff_1', status: 'failed', error: 'no route' }
    })
    expect((await runs(workId))[0]!.notification).toMatchObject({ status: 'uncertain', error: 'provider_timeout' })
  })

  it('a second notification effect is its own row, and the timeline reads newest first', async () => {
    const { agentId, workId } = await seeded()
    const first = randomUUID()
    const second = randomUUID()

    await report(DAEMON, { workId, agentId, runId: first, startedAt: BASE })
    await report(DAEMON, { workId, agentId, runId: second, startedAt: BASE + 3_600_000, outcome: 'notify' })
    // Two effects for one run — the daily allowance can split a run's posts.
    await report(DAEMON, {
      workId,
      agentId,
      runId: second,
      startedAt: BASE + 3_600_000,
      outcome: 'notify',
      notification: { index: 1, effectId: 'eff_2', status: 'suppressed' }
    })

    const rows = await runs(workId)
    expect(rows.map((r) => r.runId)).toEqual([second, first])
    expect(rows[0]!.notification).toMatchObject({ notificationIndex: 1, status: 'suppressed' })

    // `limit` is the console's page size, not a filter that hides the newest fire.
    expect(await new PgStandingWorkRepo(prisma).listRuns(OrgId(DEFAULT_ORG_ID), workId, 1)).toHaveLength(1)
  })
})
