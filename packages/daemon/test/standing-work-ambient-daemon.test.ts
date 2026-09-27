import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { openTestStore } from './store-support.js'
import { pendingTurnKey } from '../src/daemon/turn-types.js'
import { encodeStandingWorkDestination } from '../src/execution/standing-work.js'
import type { StandingWorkProjection } from '@agentconnect.md/protocol'
import type { StandingWorkRow, StandingWorkStateRow } from '../src/store/local-store.js'

// A minimal ACP host for the ambient pass; callers override the permission-mode arms per case.
const hostBase = () => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  usesMetaSystemPrompt: () => false,
  modelOptions: () => null,
  permissionModeOptions: () => ({ modes: ['plan'] }),
  setSessionPermissionMode: vi.fn(async () => true),
  newSession: vi.fn(async () => 'acp-1'),
  prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
  cancel: vi.fn(async () => {}),
  discardSession: vi.fn()
})

/** A constructed (not booted) daemon wired to serve one agent from `host`, with the ambient turn's two
 *  external dependencies — host acquisition and config rematerialization — replaced by fakes. */
function daemonWith(host: ReturnType<typeof hostBase>) {
  const daemon = new Daemon({
    slackAppFactory: fakeSlackAppFactory(),
    sandboxMechanism: null,
    standingWorkExecution: true
  } as never)
  ;(daemon as any).agents = new Map([
    [
      'agent-1',
      {
        id: 'agent-1',
        runtime: 'claude',
        dir: mkdtempSync(join(tmpdir(), 'sw-agent-')),
        integrations: [{ id: 'i-1', platform: 'slack' }]
      }
    ]
  ])
  ;(daemon as any).cpClient = { state: 'READY', emitStandingWorkReport: vi.fn() }
  ;(daemon as any).modelSessions = { enabled: false }
  ;(daemon as any).agentRunsInSandbox = () => true
  ;(daemon as any).buildDreamHost = vi.fn(async (_agent: unknown, _cwd: string, owner: unknown) => {
    ;(daemon as any).standingWorkTestOwner = owner
    return host
  })
  return daemon
}

const run = (daemon: Daemon) =>
  (daemon as any).runStandingWorkAmbientTurn(
    'agent-1',
    'system',
    'objective',
    new AbortController().signal
  ) as Promise<{ output: string }>

describe('ambient standing-work turn (daemon)', () => {
  it('builds a dedicated sandboxed host without agent tool credentials', async () => {
    const host = hostBase()
    const daemon = daemonWith(host)
    const build = vi.fn((_agent: unknown, _cfg: unknown, _opts: unknown) => ({ host }))
    ;(daemon as any).buildAcpHost = build
    const owner = (daemon as any).dreamOwnerKey('agent-1', 'standing-test')
    await (Daemon.prototype as any).buildDreamHost.call(
      daemon,
      (daemon as any).agents.get('agent-1'),
      '/tmp/standing-test',
      owner
    )
    expect(build.mock.calls[0]?.[2]).toMatchObject({
      hostKey: owner,
      runInSandbox: true,
      excludeAgentToolCredentials: true
    })
    expect(host.start).toHaveBeenCalledTimes(1)
  })

  it('refuses a runtime without a sandbox before opening a host', async () => {
    const host = hostBase()
    const daemon = daemonWith(host)
    ;(daemon as any).agentRunsInSandbox = () => false
    await expect(run(daemon)).rejects.toThrow('requires an available sandbox')
    expect((daemon as any).buildDreamHost).not.toHaveBeenCalled()
  })

  it('fails closed when the runtime offers no read-only/plan mode — no session, no prompt', async () => {
    const host = hostBase()
    host.permissionModeOptions = () => ({ modes: ['default'] })
    const daemon = daemonWith(host)
    await expect(run(daemon)).rejects.toThrow(/read-only\/plan mode/)
    expect(host.newSession).not.toHaveBeenCalled()
    expect(host.prompt).not.toHaveBeenCalled()
  })

  it('rejects the run when the runtime refuses the read-only switch, and still discards the session', async () => {
    const host = hostBase()
    host.setSessionPermissionMode = vi.fn(async () => false)
    const daemon = daemonWith(host)
    await expect(run(daemon)).rejects.toThrow(/rejected the read-only/)
    expect(host.prompt).not.toHaveBeenCalled()
    expect(host.discardSession).toHaveBeenCalledWith('acp-1')
  })

  it('opens a tool-less, disallowed-tools session on the verified mode and dispatches once', async () => {
    const host = hostBase()
    const daemon = daemonWith(host)
    await run(daemon)
    // No MCP servers ([]), and the headless disallow-list, are what keep the ambient turn read/write-free.
    expect(host.newSession).toHaveBeenCalledTimes(1)
    const [cwd, mcpServers, effort, sysAppend, addDirs, announce, disallowed] = host.newSession.mock
      .calls[0] as unknown[]
    expect(mcpServers).toEqual([])
    expect(cwd).toBeTruthy()
    expect(effort).toBeUndefined()
    expect(sysAppend).toBeUndefined() // usesMetaSystemPrompt() === false ⇒ policy rides the inline prompt
    expect(addDirs).toEqual([])
    expect(announce).toBeUndefined()
    expect(Array.isArray(disallowed) && disallowed.length).toBeGreaterThan(0)
    expect(host.setSessionPermissionMode).toHaveBeenCalledWith('acp-1', 'plan')
    expect(host.prompt).toHaveBeenCalledTimes(1)
    expect(host.discardSession).toHaveBeenCalledWith('acp-1')
    expect((daemon as any).buildDreamHost).toHaveBeenCalledTimes(1)
    expect(host.stop).toHaveBeenCalledTimes(1)
  })

  it('is silent: streams the turn into the collector and leaves no live turn behind', async () => {
    const host = hostBase()
    const daemon = daemonWith(host)
    // The runtime answers over session/update, exactly as an ordinary turn does; the ambient collector
    // is the only thing that consumes it (no session row, no transcript, no platform delivery).
    host.prompt = vi.fn(async () => {
      await (daemon as any).enqueueAcpUpdate((daemon as any).standingWorkTestOwner, 'acp-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '{"outcome":"no_change"}' }
      })
      return { stopReason: 'end_turn' }
    })
    const { output } = await run(daemon)
    expect(output).toContain('"outcome":"no_change"')
    // The collector is torn down with the turn — a stray key would let a later session/update leak in.
    expect(
      (daemon as any).memoryExtractionCollectors.has(pendingTurnKey((daemon as any).standingWorkTestOwner, 'acp-1'))
    ).toBe(false)
  })

  it('does not construct or start the pump while execution is opted out (feature stays dark)', () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null } as never)
    expect((daemon as any).standingWorkExecutionAllowed()).toBe(false)
    ;(daemon as any).store = { cacheOwner: 'c' }
    expect(() => (daemon as any).armStandingWorkPump()).not.toThrow()
    expect((daemon as any).standingWorkPump).toBeUndefined()
  })
})

describe('end-to-end ambient standing work (daemon pump)', () => {
  it('claims a due occurrence, runs a read-only ambient turn, and delivers the resulting notification', async () => {
    const host = hostBase()
    const daemon = daemonWith(host)
    const store = await openTestStore()
    try {
      const now = Date.parse('2026-01-01T00:00:00Z')
      ;(daemon as any).store = store
      ;(daemon as any).clock = { now: () => now }
      ;(daemon as any).servesAgent = () => true
      const postMessage = vi.fn(async () => 'ts-1')
      ;(daemon as any).connForIntegration = (id: string) => (id === 'i-1' ? { postMessage } : undefined)

      // Seed one authoritative, approved, already-due fixed occurrence — what projection ingestion lands.
      const workId = 'work-e2e'
      const work = {
        orgId: 'org',
        workId,
        agentId: 'agent-1',
        principalId: 'p',
        name: 'watch',
        objective: 'observe the deploy',
        state: 'active',
        definitionVersion: 1,
        schedule: '* * * * *',
        timezone: 'UTC',
        scheduleMode: 'fixed',
        maxIntervalSeconds: 86400,
        targetDestination: encodeStandingWorkDestination({ platform: 'slack', integrationId: 'i-1', channel: 'C1' }),
        expiresAt: now + 3_600_000,
        maxRunsPerDay: 5,
        maxNotificationsPerDay: 5,
        approvalVersion: 1,
        approvalState: 'approved',
        authorizationRevision: 1,
        createdAt: now,
        updatedAt: now
      } as unknown as StandingWorkRow
      const state = {
        orgId: 'org',
        workId,
        appliedDefinitionVersion: 1,
        nextCheckAt: now - 5_000,
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
      } as unknown as StandingWorkStateRow
      await store.createStandingWork(work, state)

      // The runtime answers the read-only turn with a notify report, streamed over session/update like any turn.
      host.prompt = vi.fn(async () => {
        await (daemon as any).enqueueAcpUpdate((daemon as any).standingWorkTestOwner, 'acp-1', {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: '{"outcome":"notify","summary":"deploy failed","notification":"prod is down"}'
          }
        })
        return { stopReason: 'end_turn' }
      })

      ;(daemon as any).armStandingWorkPump()
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith('C1', 'prod is down', undefined), {
        timeout: 2_000
      })
      ;(daemon as any).standingWorkPump.stop()

      // The whole chain left durable facts, not just an in-memory delivery: a committed run and a delivered outbox row.
      const timeline = await store.standingWorkTimeline('org', workId)
      expect(timeline.runs[0]).toMatchObject({ status: 'notify', outcome: 'notify' })
      expect(timeline.notifications[0]).toMatchObject({ status: 'delivered', payload: 'prod is down' })
      // The run re-fenced to the next fixed occurrence and released its lease — no autonomous write occurred.
      expect((await store.getStandingWork('org', workId))?.state).toMatchObject({ leaseOwner: null })
      expect((await store.getStandingWork('org', workId))?.state.nextCheckAt).toBeGreaterThan(now)
    } finally {
      ;(daemon as any).standingWorkPump?.stop()
      await store.close()
    }
  })

  it('lands a CP projection through ingestion and sweeps it end to end', async () => {
    const host = hostBase()
    const daemon = daemonWith(host)
    const store = await openTestStore()
    try {
      const now = Date.parse('2026-01-01T00:00:00Z')
      let clock = now
      ;(daemon as any).store = store
      ;(daemon as any).clock = { now: () => clock }
      ;(daemon as any).servesAgent = () => true
      const postMessage = vi.fn(async () => undefined)
      ;(daemon as any).connForIntegration = (id: string) => (id === 'i-1' ? { postMessage } : undefined)

      // Feed the snapshot exactly as applyReconcileSnapshot does after a create.
      const projection = {
        orgId: 'org',
        workId: 'work-ingest',
        agentId: 'agent-1',
        principalId: 'p',
        name: 'watch',
        objective: 'observe',
        state: 'active',
        definitionVersion: 1,
        schedule: '* * * * *',
        timezone: 'UTC',
        expiresAt: now + 86_400_000,
        maxRunsPerDay: 5,
        maxNotificationsPerDay: 5,
        targetDestination: { platform: 'slack', integrationId: 'i-1', channel: 'C1' },
        approvalState: 'pending',
        approvalVersion: null,
        authorizationRevision: 1,
        createdAt: now,
        updatedAt: now
      } as unknown as StandingWorkProjection
      await (daemon as any).ingestStandingWorks([projection])
      // Ingestion landed the row with the encoded destination and a future next-check.
      const landed = await store.getStandingWork('org', 'work-ingest')
      expect(landed?.work.targetDestination).toBe('{"platform":"slack","integrationId":"i-1","channel":"C1"}')
      // A pending approval is not due: the pump must claim nothing until the CP approves.
      expect(landed?.work.approvalState).toBe('pending')

      // Mirror the CP approval (same version → noop-but-approve), arm the pump, then move the clock to the occurrence.
      await (daemon as any).ingestStandingWorks([{ ...projection, approvalState: 'approved', approvalVersion: 1 }])
      host.prompt = vi.fn(async () => {
        await (daemon as any).enqueueAcpUpdate((daemon as any).standingWorkTestOwner, 'acp-1', {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '{"outcome":"no_change"}' }
        })
        return { stopReason: 'end_turn' }
      })
      clock = landed!.state.nextCheckAt
      ;(daemon as any).armStandingWorkPump()
      await vi.waitFor(async () =>
        expect((await store.standingWorkTimeline('org', 'work-ingest')).runs[0]).toMatchObject({ status: 'no_change' })
      )
      expect(postMessage).not.toHaveBeenCalled() // no_change emits no notification
      const run = (await store.standingWorkTimeline('org', 'work-ingest')).runs
      expect(run[0]).toMatchObject({ status: 'no_change' })
    } finally {
      ;(daemon as any).standingWorkPump?.stop()
      await store.close()
    }
  })
})
