import { describe, expect, it, vi } from 'vitest'
import { EXECUTION_AUDIT_KINDS, type AnyFrame, type AuditEventEnvelope } from '@agentconnect.md/protocol'
import { AuditKind } from '../../generated/prisma/enums.js'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { PlacementResolver } from '../../orchestrator/placementResolver.js'
import { systemClock } from '../../domain/clock.js'
import type { DaemonId } from '../../domain/ids.js'
import { handleAuditFlush } from './audit-flush.js'

const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-dddddddddddd'
const OTHER = 'e1e1e1e1-eeee-4eee-8eee-eeeeeeeeeeee'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PRINCIPAL = '1b1b1b1b-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ORG = '0e0e0e0e-eeee-4eee-8eee-eeeeeeeeeeee'
const OCCURRED_AT = Date.parse('2026-09-24T09:00:00.000Z')

function event(overrides: Partial<AuditEventEnvelope> = {}): AuditEventEnvelope {
  return {
    eventId: 'a'.repeat(64),
    kind: 'admission',
    provenance: {
      agentId: AGENT,
      principalId: PRINCIPAL,
      authorizationRevision: 7,
      runId: 'run-1',
      traceId: 'trace-1',
      workId: 'work-1',
      executionEpoch: 3
    },
    occurredAt: OCCURRED_AT,
    details: { workId: 'work-1', attempt: 1, wakeSource: 'scheduled' },
    ...overrides
  }
}

/** The org rides the envelope, exactly as the daemon's `scopedFrame` puts it there. */
function flushFrame(events: AuditEventEnvelope[], orgId: string | null = ORG): AnyFrame {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: new Date(OCCURRED_AT).toISOString(),
    type: 'audit/flush',
    orgId,
    payload: { events }
  } as AnyFrame
}

function conn(): DaemonConnection & { replyTo: ReturnType<typeof vi.fn>; sendError: ReturnType<typeof vi.fn> } {
  return { daemonId: DAEMON, orgId: null, replyTo: vi.fn(), sendError: vi.fn() } as unknown as DaemonConnection & {
    replyTo: ReturnType<typeof vi.fn>
    sendError: ReturnType<typeof vi.fn>
  }
}

/** The live seam, keyed by who holds each agent's duty right now. */
function holderOf(holds: Record<string, string[]>): PlacementResolver {
  const of = async (agentId: string) => (holds[String(agentId)] ?? []) as DaemonId[]
  return new PlacementResolver({ duties: { holdersOf: of, confirmedHoldersOf: of }, clock: systemClock })
}

function deps(
  overrides: Partial<Record<keyof DaemonWsDeps, unknown>> = {}
): DaemonWsDeps & { audit: { appendOnce: ReturnType<typeof vi.fn> } } {
  return {
    log: { error: vi.fn() },
    agent: { get: async () => ({ id: AGENT, orgId: ORG, placementKind: 'set', daemonId: null, setId: OTHER }) },
    placementResolver: holderOf({ [AGENT]: [DAEMON] }),
    audit: { appendOnce: vi.fn(async () => true) },
    ...overrides
  } as unknown as DaemonWsDeps & { audit: { appendOnce: ReturnType<typeof vi.fn> } }
}

const replyOf = (c: ReturnType<typeof conn>): { accepted: string[]; rejected: string[] } => {
  const call = c.replyTo.mock.calls.at(-1)
  expect(call?.[1]).toBe('audit/flush/ok')
  return call?.[2] as { accepted: string[]; rejected: string[] }
}

describe('handleAuditFlush', () => {
  it('records a fenced event under the envelope organization and accepts it by id', async () => {
    const d = deps()
    const c = conn()
    await handleAuditFlush(flushFrame([event()]), c, d)
    expect(d.audit.appendOnce).toHaveBeenCalledWith({
      kind: 'admission',
      orgId: ORG,
      agentId: AGENT,
      daemonId: DAEMON,
      message: 'admission',
      details: { workId: 'work-1', attempt: 1, wakeSource: 'scheduled' },
      eventId: 'a'.repeat(64),
      traceId: 'trace-1',
      principalId: PRINCIPAL,
      occurredAt: new Date(OCCURRED_AT),
      source: 'daemon'
    })
    expect(replyOf(c)).toEqual({ accepted: ['a'.repeat(64)], rejected: [] })
  })

  it('carries the causal links into the row so a trace can be walked without reading details', async () => {
    const d = deps()
    const intent = event({ eventId: 'b'.repeat(64), effectId: 'effect-1', parentEventId: 'a'.repeat(64) })
    await handleAuditFlush(flushFrame([intent]), conn(), d)
    const input = d.audit.appendOnce.mock.calls[0]?.[0] as Record<string, unknown>
    expect(input).toMatchObject({ eventId: 'b'.repeat(64), effectId: 'effect-1', parentEventId: 'a'.repeat(64) })
  })

  it('absorbs a replayed flush as one accepted row, not a conflict', async () => {
    // The daemon retries whenever a reply is lost, so the same id arrives twice by design.
    const d = deps({ audit: { appendOnce: vi.fn(async () => false) } })
    const c = conn()
    await handleAuditFlush(flushFrame([event()]), c, d)
    expect(replyOf(c).accepted).toEqual(['a'.repeat(64)])
    expect(replyOf(c).rejected).toEqual([])
  })

  it('rejects an agent this daemon does not serve, and writes nothing for it', async () => {
    const d = deps({ placementResolver: holderOf({ [AGENT]: [OTHER] }) })
    const c = conn()
    await handleAuditFlush(flushFrame([event()]), c, d)
    expect(d.audit.appendOnce).not.toHaveBeenCalled()
    expect(replyOf(c)).toEqual({ accepted: [], rejected: ['a'.repeat(64)] })
  })

  it('rejects an agent the organization does not have', async () => {
    const d = deps({ agent: { get: async () => null } })
    const c = conn()
    await handleAuditFlush(flushFrame([event()]), c, d)
    expect(d.audit.appendOnce).not.toHaveBeenCalled()
    expect(replyOf(c).rejected).toEqual(['a'.repeat(64)])
  })

  it('names a failed write in neither list, so the daemon keeps the row', async () => {
    // Reporting it as rejected would delete an auditable fact over a transient database fault.
    const d = deps({
      audit: {
        appendOnce: vi.fn(async () => {
          throw new Error('db down')
        })
      }
    })
    const c = conn()
    await handleAuditFlush(flushFrame([event()]), c, d)
    expect(d.log.error).toHaveBeenCalled()
    expect(replyOf(c)).toEqual({ accepted: [], rejected: [] })
  })

  it('settles each event of a batch on its own, so one bad row cannot cost the rest', async () => {
    let written = 0
    const d = deps({
      audit: {
        appendOnce: vi.fn(async () => {
          if (++written === 1) throw new Error('write failed')
          return true
        })
      }
    })
    const c = conn()
    await handleAuditFlush(flushFrame([event(), event({ eventId: 'c'.repeat(64), kind: 'external_effect' })]), c, d)
    expect(written).toBe(2)
    expect(replyOf(c)).toEqual({ accepted: ['c'.repeat(64)], rejected: [] })
  })

  it('fills the uuid columns only from an id that is one, keeping the row otherwise', async () => {
    const d = deps()
    await handleAuditFlush(
      flushFrame([
        event({
          provenance: {
            agentId: AGENT,
            principalId: 'acp-principal-not-a-uuid',
            authorizationRevision: 7,
            runId: 'run-1',
            traceId: 'trace-1',
            sessionId: 'acp-session-1'
          }
        })
      ]),
      conn(),
      d
    )
    const input = d.audit.appendOnce.mock.calls[0]?.[0] as Record<string, unknown>
    // A trail correlated by traceId beats a row dropped because one id was shaped for the daemon's runtime.
    expect(input.principalId).toBeUndefined()
    expect(input.sessionId).toBeUndefined()
    expect(input).toMatchObject({ traceId: 'trace-1', occurredAt: new Date(OCCURRED_AT) })
  })

  it('drops payload-bearing details keys at the boundary', async () => {
    const d = deps()
    await handleAuditFlush(
      flushFrame([event({ details: { status: 'delivered', token: 'sk-live', arguments: '{"path":"/etc"}' } })]),
      conn(),
      d
    )
    expect(d.audit.appendOnce.mock.calls[0]?.[0]).toMatchObject({ details: { status: 'delivered' } })
  })

  it('refuses a frame with no organization to write into', async () => {
    const d = deps()
    const c = conn()
    const frame = flushFrame([event()], null)
    await handleAuditFlush(frame, c, d)
    expect(c.sendError).toHaveBeenCalledWith(frame.id, 'SCOPE_DENIED', 'organization is required', false)
    expect(c.replyTo).not.toHaveBeenCalled()
    expect(d.audit.appendOnce).not.toHaveBeenCalled()
  })

  it('describes every kind a daemon may assert as an audit row the schema can hold', () => {
    // The two enums are declared in different packages; drift would fail ingest at runtime, per row.
    for (const kind of EXECUTION_AUDIT_KINDS) expect(AuditKind[kind]).toBe(kind)
  })
})
