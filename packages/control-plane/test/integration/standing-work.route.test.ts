/**
 * The Standing Work console REST surface: who may change what, and what the operator can read.
 *
 * W5's promise is inspect + stop, and this is where it is enforced:
 *  - reads are view-scoped — a definition the caller may not view answers 404, not 403, and the run
 *    timeline is served from the CP's own projection of what the daemon reported, never by asking the
 *    daemon at request time;
 *  - approve is owner-only; pause/resume/cancel need any write role; viewers get reads only;
 *  - every write is fenced on `expectedVersion`, so a stale page 409s instead of overwriting what
 *    someone else changed;
 *  - resume re-checks the grant and the expiry window instead of inheriting the last one.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgStandingWorkRepo } from '../../src/persistence/repositories/standing-work.repo.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'
import type { StandingWorkRunReport } from '@agentconnect.md/protocol'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

function app(opts: { userId?: string; grant?: boolean } = {}): HttpApp {
  const built = buildHttpApp(
    prisma,
    opts.userId ? { DEFAULT_OWNER_ID: opts.userId } : undefined,
    undefined,
    undefined,
    {
      standingWorkGrant: async () => opts.grant !== false
    }
  )
  opened.push(built)
  return built
}

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@standing-work.test`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

/** Seed an agent placed on a real daemon, plus the active install its destination points at. */
async function seededAgent(): Promise<{ agentId: string; integrationId: string }> {
  await seedDaemon(prisma, DAEMON)
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON })
  const botId = randomUUID()
  await prisma.bot.create({
    data: { id: botId, orgId: DEFAULT_ORG_ID, platform: 'slack', name: `bot-${botId.slice(0, 8)}` }
  })
  const integrationId = randomUUID()
  await prisma.integration.create({
    data: {
      id: integrationId,
      orgId: DEFAULT_ORG_ID,
      agentId,
      botId,
      platform: 'slack',
      name: `install-${integrationId.slice(0, 8)}`
    }
  })
  return { agentId, integrationId }
}

const definition = (agentId: string, integrationId: string) => ({
  agentId,
  name: 'Watch the rollout',
  objective: 'Observe the rollout and report what changed',
  schedule: '0 9 * * *',
  timezone: 'UTC',
  startAt: new Date(Date.now() - 3_600_000).toISOString(),
  expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  minIntervalSeconds: 60,
  maxRunsPerDay: 24,
  maxNotificationsPerDay: 2,
  conversationRef: null,
  targetDestination: { platform: 'slack', integrationId, channel: 'C123' },
  budgetPolicyRef: 'default',
  toolPolicyRef: 'read-only',
  notificationPolicy: { mode: 'changes', includeCompletion: true },
  visibilityPolicyRef: 'agent',
  sourceSessionId: null
})

async function created(
  over: { userId?: string; grant?: boolean } = {}
): Promise<{ http: HttpApp; id: string; agentId: string }> {
  const { agentId, integrationId } = await seededAgent()
  const http = app(over)
  const res = await http.app.inject({
    method: 'POST',
    url: `${ORG}/standing-work`,
    payload: { idempotencyKey: `create-${randomUUID()}`, definition: definition(agentId, integrationId) }
  })
  if (res.statusCode !== 200) throw new Error(`create failed: ${res.statusCode} ${res.body}`)
  return { http, id: (res.json() as { id: string }).id, agentId }
}

/** Act on a work item — optionally as a different member (a fresh app impersonates them). */
function act(http: HttpApp, id: string, action: string, expectedVersion: number, as?: string) {
  return (as ? app({ userId: as }) : http).app.inject({
    method: 'POST',
    url: `${ORG}/standing-work/${id}/${action}`,
    payload: { expectedVersion }
  })
}

describe('Standing Work console routes', () => {
  it('creates a definition awaiting approval, and reads it back scoped to the org', async () => {
    const { http, id } = await created()

    const listed = await http.app.inject({ method: 'GET', url: `${ORG}/standing-work` })
    expect(listed.statusCode).toBe(200)
    // A new definition is never already authorized: it lands pending, and the daemon will not run
    // it until an owner approves THIS version.
    expect(listed.json()).toMatchObject([
      { id, state: 'active', approvalState: 'pending', approvalVersion: null, definitionVersion: 1 }
    ])

    const one = await http.app.inject({ method: 'GET', url: `${ORG}/standing-work/${id}` })
    expect(one.json()).toMatchObject({ id, schedule: '0 9 * * *', timezone: 'UTC', toolPolicyRef: 'read-only' })

    expect((await http.app.inject({ method: 'GET', url: `${ORG}/standing-work/${randomUUID()}` })).statusCode).toBe(404)
    expect((await http.app.inject({ method: 'GET', url: `${ORG}/standing-work/not-a-uuid` })).statusCode).toBe(400)
  })

  it('refuses a creation the grant seam denies and one from a read-only member', async () => {
    const { agentId, integrationId } = await seededAgent()
    const body = (key: string) => ({ idempotencyKey: key, definition: definition(agentId, integrationId) })

    const denied = app({ grant: false })
    expect(
      (
        await denied.app.inject({
          method: 'POST',
          url: `${ORG}/standing-work`,
          payload: body(`denied-${randomUUID()}`)
        })
      ).statusCode
    ).toBe(403)
    expect((await denied.app.inject({ method: 'GET', url: `${ORG}/standing-work` })).json()).toEqual([])

    const viewerId = await makeUser(`sw-viewer-${randomUUID()}`, 'viewer')
    const asViewer = app({ userId: viewerId })
    expect(
      (
        await asViewer.app.inject({
          method: 'POST',
          url: `${ORG}/standing-work`,
          payload: body(`viewer-${randomUUID()}`)
        })
      ).statusCode
    ).toBe(403)
    // A viewer keeps the read half of the surface.
    expect((await asViewer.app.inject({ method: 'GET', url: `${ORG}/standing-work` })).statusCode).toBe(200)
  })

  it('rejects a definition with no real fixed cadence inside its window', async () => {
    const { agentId, integrationId } = await seededAgent()
    const http = app()
    // Every minute, but a 10-minute minimum gap between fires: nothing can satisfy both, so this is
    // a request error rather than a definition the daemon would refuse to load.
    const res = await http.app.inject({
      method: 'POST',
      url: `${ORG}/standing-work`,
      payload: {
        idempotencyKey: `fast-${randomUUID()}`,
        definition: { ...definition(agentId, integrationId), schedule: '* * * * *', minIntervalSeconds: 600 }
      }
    })
    expect(res.statusCode).toBe(400)
    expect((await http.app.inject({ method: 'GET', url: `${ORG}/standing-work` })).json()).toEqual([])
  })

  it('keeps approval owner-only and every state change fenced on the version the caller read', async () => {
    const { http, id } = await created()

    const collaboratorId = await makeUser(`sw-collab-${randomUUID()}`, 'collaborator')
    expect((await act(http, id, 'approve', 1, collaboratorId)).statusCode).toBe(403)

    const approved = await act(http, id, 'approve', 1)
    expect(approved.json()).toMatchObject({ approvalState: 'approved', approvalVersion: 1, definitionVersion: 1 })
    // Approving twice is not an idempotent re-read — there is nothing left to approve at that version.
    expect((await act(http, id, 'approve', 1)).statusCode).toBe(409)

    const paused = await act(http, id, 'pause', 1)
    expect(paused.json()).toMatchObject({ state: 'paused', definitionVersion: 2, approvalState: 'pending' })
    // The page that still believes version 1 is current can no longer write at all.
    expect((await act(http, id, 'pause', 1)).statusCode).toBe(409)
  })

  it('walks pause → resume → cancel, re-checking the grant on resume, and keeps a cancelled item readable', async () => {
    const { http, id } = await created()
    const repo = new PgStandingWorkRepo(prisma)
    const state = async () => (await repo.get(DEFAULT_ORG_ID, id))!

    expect((await act(http, id, 'pause', 1)).json()).toMatchObject({
      state: 'paused',
      definitionVersion: 2,
      approvalState: 'pending'
    })
    expect((await act(http, id, 'resume', 2)).json()).toMatchObject({ state: 'active', definitionVersion: 3 })

    // Resume does not inherit the old authorization: with the grant gone, the pause still lands and
    // the resume does not.
    const grantless = app({ grant: false })
    expect((await act(grantless, id, 'pause', 3)).statusCode).toBe(200)
    expect((await act(grantless, id, 'resume', 4)).statusCode).toBe(403)
    expect((await state()).state).toBe('paused')

    expect((await act(http, id, 'cancel', 4)).json()).toMatchObject({ state: 'cancelled' })
    // Cancelled is terminal — it stays readable with its history, and it never runs again.
    expect((await act(http, id, 'resume', 5)).statusCode).toBe(409)
    expect((await http.app.inject({ method: 'GET', url: `${ORG}/standing-work/${id}` })).statusCode).toBe(200)
  })

  it('serves the daemon-reported run timeline, with delivery as its own fact', async () => {
    const { http, id, agentId } = await created()
    const repo = new PgStandingWorkRepo(prisma)
    const BASE = Date.parse('2026-09-22T09:00:00.000Z')
    const earlyRunId = randomUUID()
    const lateRunId = randomUUID()
    const report = (over: Partial<StandingWorkRunReport> & { runId: string }): Promise<boolean> =>
      repo.recordReport(DEFAULT_ORG_ID, id, {
        workId: id,
        agentId,
        definitionVersion: 1,
        executionEpoch: 0,
        attempt: 1,
        outcome: 'no_change',
        wakeSource: 'scheduled',
        startedAt: BASE,
        ...over
      })

    await report({ runId: earlyRunId })
    await report({
      runId: lateRunId,
      startedAt: BASE + 3_600_000,
      finishedAt: BASE + 3_604_200,
      outcome: 'notify',
      sessionId: 'ses_1',
      notification: { index: 0, effectId: 'eff_1', status: 'uncertain', error: 'provider_timeout' }
    })

    const res = await http.app.inject({ method: 'GET', url: `${ORG}/standing-work/${id}/runs` })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<Record<string, unknown>>
    expect(rows.map((r) => r.runId)).toEqual([lateRunId, earlyRunId])
    // Outcome and delivery are two facts, never one: a `notify` run whose post the daemon could not
    // prove reads as exactly that.
    expect(rows[0]).toMatchObject({
      runId: lateRunId,
      outcome: 'notify',
      sessionId: 'ses_1',
      finishedAt: new Date(BASE + 3_604_200).toISOString(),
      notification: { status: 'uncertain', error: 'provider_timeout', providerReceipt: null }
    })
    expect(rows[1]).toMatchObject({
      outcome: 'no_change',
      wakeSource: 'scheduled',
      finishedAt: null,
      notification: null
    })

    // `limit` is the console's page size; an out-of-range one is a rejected request, not a clamp.
    expect(
      ((await http.app.inject({ method: 'GET', url: `${ORG}/standing-work/${id}/runs?limit=1` })).json() as unknown[])
        .length
    ).toBe(1)
    expect((await http.app.inject({ method: 'GET', url: `${ORG}/standing-work/${id}/runs?limit=0` })).statusCode).toBe(
      400
    )
    expect(
      (await http.app.inject({ method: 'GET', url: `${ORG}/standing-work/${randomUUID()}/runs` })).statusCode
    ).toBe(404)
  })
})
