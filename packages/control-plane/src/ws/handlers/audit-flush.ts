/**
 * `audit/flush` handler — ingest a daemon's execution-audit outbox (A1 Phase 5).
 *
 * A correlated REQ so the daemon releases rows only once they are durable here; a long CP outage
 * delays the trail instead of losing it. Every event is fenced twice: the organization comes from the
 * frame envelope (never the payload), and the agent it names must be one this authenticated daemon
 * actually serves — so a daemon can report its own executions and nothing else. `eventId` is the
 * dedup key, which is what lets the daemon retry a flush whose reply it never saw.
 *
 * Rows that cannot be attributed are named in `rejected` and dropped at the source; a row the write
 * simply failed on is named by neither list, so the daemon keeps it. An empty batch is therefore a
 * normal outcome, never an error — the connection stays usable either way.
 */
import { isFrame, type AuditEventEnvelope } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, OrgId, SessionId } from '../../domain/ids.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import type { AuditInput } from '../../persistence/ports.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// The daemon strips these before writing; this is the boundary check, not a second opinion.
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|secret|token|body|rawinput|arguments)$/i

/** Only a uuid fits the typed columns, and the trail is worth keeping when one id does not. */
function uuidOrUndefined(value: string | undefined): string | undefined {
  return value && UUID_RE.test(value) ? value : undefined
}

function safeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined
  return Object.fromEntries(Object.entries(details).filter(([key]) => !SENSITIVE_KEY.test(key)))
}

function toInput(event: AuditEventEnvelope, orgId: OrgId, agentId: AgentId, daemonId: DaemonId): AuditInput {
  const details = safeDetails(event.details)
  return {
    kind: event.kind,
    orgId,
    agentId,
    daemonId,
    message: event.kind,
    ...(details ? { details } : {}),
    eventId: event.eventId,
    traceId: event.provenance.traceId,
    effectId: event.effectId,
    parentEventId: event.parentEventId,
    principalId: uuidOrUndefined(event.provenance.principalId),
    // A daemon knows its ACP session id, which is not necessarily the CP's uuid; a row that
    // correlates by traceId is worth keeping, so an unshaped id is dropped rather than forced.
    ...(event.provenance.sessionId && UUID_RE.test(event.provenance.sessionId)
      ? { sessionId: SessionId(event.provenance.sessionId) }
      : {}),
    source: 'daemon',
    occurredAt: new Date(event.occurredAt)
  }
}

export const handleAuditFlush: Handler = async (frame, conn, deps) => {
  if (!isFrame('audit/flush')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'organization is required', false)
    return
  }
  const daemonId = DaemonId(conn.daemonId)
  const resolver = deps.placementResolver ?? PLACEMENT_ONLY
  const accepted: string[] = []
  const rejected: string[] = []
  for (const event of frame.payload.events) {
    // The agent rides an untrusted payload, so it is resolved as a lookup, not taken as a claim.
    const agent = await deps.agent.get(orgId, AgentId(event.provenance.agentId))
    if (!agent || !(await resolver.mayAct(agent, daemonId))) {
      rejected.push(event.eventId)
      continue
    }
    try {
      await deps.audit.appendOnce(toInput(event, orgId, agent.id, daemonId))
      accepted.push(event.eventId)
    } catch (err) {
      deps.log.error({ err, daemonId, eventId: event.eventId }, 'audit/flush: execution audit ingest failed')
    }
  }
  conn.replyTo(frame, 'audit/flush/ok', { accepted, rejected })
}
