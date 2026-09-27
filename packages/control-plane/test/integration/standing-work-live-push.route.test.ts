/**
 * The live-push half of the Standing Work console routes: every lifecycle action
 * (approve/pause/resume/cancel) pushes a `standing-work/control` frame to the
 * daemon the agent is placed on, so a connected daemon converges immediately
 * instead of waiting for the next register/reconcile.
 *
 * Push is best-effort: an offline daemon logs and moves on (the reconnect
 * roster is the backstop), and a missing agent row is silently skipped — the
 * CRUD never fails over the push.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { StandingWorkControl } from '@agentconnect.md/protocol'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

/** A ControlSender spy recording the standing-work/control pushes the route makes. */
class SpyControl {
  readonly pushes: Array<{ daemonId: string; wire: StandingWorkControl }> = []
  async standingWorkControl(daemonId: string, p: StandingWorkControl): Promise<{ ok: boolean }> {
    this.pushes.push({ daemonId, wire: p })
    return { ok: true }
  }
  // The AgentDelivery fan-out also probes these on integration/agent upserts — stubs so the spy
  // satisfies the Pick<ControlSender, …> the delivery layer requires.
  async agentUpsert(): Promise<void> {}
  async agentRemove(): Promise<void> {}
  async integrationUpsert(): Promise<void> {}
  async integrationRemove(): Promise<void> {}
  async cronUpsert(): Promise<void> {}
  async cronRemove(): Promise<void> {}
}

function withSpy(): { http: HttpApp; spy: SpyControl } {
  const spy = new SpyControl()
  const built = buildHttpApp(prisma, undefined, undefined, spy as unknown as ControlSender, {
    standingWorkGrant: async () => true
  })
  opened.push(built)
  return { http: built, spy }
}

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

async function createDefinition(http: HttpApp, agentId: string, integrationId: string): Promise<string> {
  const res = await http.app.inject({
    method: 'POST',
    url: `${ORG}/standing-work`,
    payload: { idempotencyKey: `create-${randomUUID()}`, definition: definition(agentId, integrationId) }
  })
  if (res.statusCode !== 200) throw new Error(`create failed: ${res.statusCode} ${res.body}`)
  return (res.json() as { id: string }).id
}

describe('Standing Work live push to daemon', () => {
  it('pushes approve/pause/resume/cancel with the correct action and authority', async () => {
    const { agentId, integrationId } = await seededAgent()
    const { http, spy } = withSpy()
    const id = await createDefinition(http, agentId, integrationId)

    // Approve — owner-only, canApprove=true
    const approved = await http.app.inject({
      method: 'POST',
      url: `${ORG}/standing-work/${id}/approve`,
      payload: { expectedVersion: 1 }
    })
    expect(approved.statusCode).toBe(200)
    expect(spy.pushes).toHaveLength(1)
    expect(spy.pushes[0]!.daemonId).toBe(DAEMON)
    expect(spy.pushes[0]!.wire).toMatchObject({
      action: 'approve',
      orgId: DEFAULT_ORG_ID,
      workId: id,
      version: 1,
      authority: { canManage: true, canApprove: true }
    })

    // Pause — any write role, canApprove=false
    const paused = await http.app.inject({
      method: 'POST',
      url: `${ORG}/standing-work/${id}/pause`,
      payload: { expectedVersion: 1 }
    })
    expect(paused.statusCode).toBe(200)
    expect(spy.pushes).toHaveLength(2)
    expect(spy.pushes[1]!.wire.action).toBe('pause')
    expect(spy.pushes[1]!.wire.authority.canApprove).toBe(false)
    expect(spy.pushes[1]!.wire.version).toBe(2)

    // Resume — re-checks grant, canApprove=false
    const resumed = await http.app.inject({
      method: 'POST',
      url: `${ORG}/standing-work/${id}/resume`,
      payload: { expectedVersion: 2 }
    })
    expect(resumed.statusCode).toBe(200)
    expect(spy.pushes).toHaveLength(3)
    expect(spy.pushes[2]!.wire.action).toBe('resume')
    expect(spy.pushes[2]!.wire.version).toBe(3)

    // Cancel — terminal, canApprove=false
    const cancelled = await http.app.inject({
      method: 'POST',
      url: `${ORG}/standing-work/${id}/cancel`,
      payload: { expectedVersion: 3 }
    })
    expect(cancelled.statusCode).toBe(200)
    expect(spy.pushes).toHaveLength(4)
    expect(spy.pushes[3]!.wire.action).toBe('cancel')
    expect(spy.pushes[3]!.wire.version).toBe(4)
  })

  it('does not push when the CRUD fails (version mismatch)', async () => {
    const { agentId, integrationId } = await seededAgent()
    const { http, spy } = withSpy()
    const id = await createDefinition(http, agentId, integrationId)

    // Approve at version 1 succeeds
    await http.app.inject({
      method: 'POST',
      url: `${ORG}/standing-work/${id}/approve`,
      payload: { expectedVersion: 1 }
    })
    expect(spy.pushes).toHaveLength(1)

    // Approve again at version 1 — stale, 409s, no push
    const stale = await http.app.inject({
      method: 'POST',
      url: `${ORG}/standing-work/${id}/approve`,
      payload: { expectedVersion: 1 }
    })
    expect(stale.statusCode).toBe(409)
    expect(spy.pushes).toHaveLength(1) // No second push
  })

  it('does not push on create (no live control frame for a new definition)', async () => {
    const { agentId, integrationId } = await seededAgent()
    const { http, spy } = withSpy()
    await createDefinition(http, agentId, integrationId)
    expect(spy.pushes).toHaveLength(0)
  })
})
