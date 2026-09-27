/**
 * A1 unified-audit wire frames (roadmap §6).
 *
 * A daemon records execution facts in its own durable outbox and drains them here, so the org's
 * audit trail survives the daemon that produced it. Metadata only — the same rule the run reports
 * follow: no message bodies, no tool arguments, no credentials. Everything crossing this wire is
 * either an identifier or a small redacted detail bag.
 */
import { z } from 'zod'

/** Every kind a daemon may assert about its own execution. Mirrors the CP's `AuditKind` members. */
export const EXECUTION_AUDIT_KINDS = [
  'admission',
  'admission_denied',
  'tool_intent',
  'tool_result',
  'budget_reserved',
  'budget_settled',
  'external_effect'
] as const
export type ExecutionAuditKind = (typeof EXECUTION_AUDIT_KINDS)[number]

/**
 * Who an audit event was about. `orgId` is deliberately absent: the organization rides the frame
 * envelope, resolved from the authenticated connection, so a daemon cannot audit into an org it does
 * not serve. `sessionId` and `executionEpoch` are optional because an ambient run is admitted before
 * its session exists and is swept on a later tick — an absent fact stays absent rather than invented.
 * Only `agentId` is typed as a uuid, because it is the fence the ingest resolves; the rest stay
 * opaque ids a daemon owns, and the control plane fills its typed columns only where one fits.
 */
export const AuditEventProvenance = z
  .object({
    agentId: z.string().uuid(),
    principalId: z.string().min(1).max(128),
    authorizationRevision: z.number().int().nonnegative(),
    runId: z.string().min(1).max(128),
    traceId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128).optional(),
    executionEpoch: z.number().int().nonnegative().optional(),
    workId: z.string().min(1).max(128).optional(),
    conversationRef: z.string().min(1).max(256).optional(),
    actorId: z.string().min(1).max(128).optional()
  })
  .strict()
export type AuditEventProvenance = z.infer<typeof AuditEventProvenance>

/** One already-persisted execution fact. `eventId` is the daemon's idempotency key for a retry. */
export const AuditEventEnvelope = z
  .object({
    eventId: z.string().min(1).max(128),
    kind: z.enum(EXECUTION_AUDIT_KINDS),
    provenance: AuditEventProvenance,
    /** When it happened at the daemon's clock, in epoch milliseconds. */
    occurredAt: z.number().int().nonnegative(),
    /** Small redacted identifier bag; the daemon strips payload-bearing keys before writing. */
    details: z.record(z.string(), z.unknown()).optional(),
    effectId: z.string().min(1).max(256).optional(),
    parentEventId: z.string().min(1).max(128).optional()
  })
  .strict()
export type AuditEventEnvelope = z.infer<typeof AuditEventEnvelope>

/**
 * `audit/flush` (D→C REQ → `audit/flush/ok`) — drain one org's unacknowledged audit rows. Batched
 * because the trail is high-volume and a per-event round trip would put the audit path on the
 * connection's hot path; bounded so one frame cannot dominate the reply. The daemon keeps every row
 * until its id comes back in `accepted`, so a lost reply is a duplicate write, never a lost fact.
 */
export const AuditFlush = z.object({ events: z.array(AuditEventEnvelope).min(1).max(100) }).strict()
export type AuditFlush = z.infer<typeof AuditFlush>

/**
 * What the control plane settled. `accepted` rows are durable (or were already there — an id
 * replayed is the same fact, not a conflict), so the daemon releases them. `rejected` rows can never
 * be attributed to this daemon's org and its agents, so it drops them rather than retrying forever.
 * An id in neither list was not processed; the daemon keeps it for the next pass.
 */
export const AuditFlushOk = z
  .object({
    accepted: z.array(z.string().min(1).max(128)).max(100),
    rejected: z.array(z.string().min(1).max(128)).max(100)
  })
  .strict()
export type AuditFlushOk = z.infer<typeof AuditFlushOk>
