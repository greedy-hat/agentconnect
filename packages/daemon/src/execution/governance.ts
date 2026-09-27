import type { ExecutionAuditKind } from '@agentconnect.md/protocol'

/**
 * The small, daemon-owned execution contract used before autonomous work is
 * admitted.  It deliberately has no provider payloads: those are untrusted
 * inputs and cannot create authority, broaden an audience, or select tools.
 */
export interface ExecutionSubject {
  readonly orgId: string
  readonly agentId: string
  readonly principalId: string
  readonly authorizationRevision: number
}

export interface ExecutionProvenance extends ExecutionSubject {
  readonly sessionId: string
  readonly runId: string
  readonly executionEpoch: number
  readonly traceId: string
  readonly actorId?: string
  readonly conversationRef?: string
  readonly workId?: string
  readonly parentEventId?: string
}

export interface ExecutionPolicy {
  /** The complete authorized audience, resolved by the control plane. */
  readonly audience: ReadonlySet<string>
  readonly allowedTools: ReadonlySet<string>
  readonly requireSandbox: boolean
  readonly maxToolCalls: number
}

export interface ExecutionCapabilities {
  readonly sandbox: boolean
  readonly tools: ReadonlySet<string>
}

export type AdmissionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'invalid_context' | 'audience_denied' | 'sandbox_unavailable' }

const nonEmpty = (value: string | undefined): value is string => typeof value === 'string' && value.trim().length > 0

/** Validate the trusted envelope before an execution is allowed to start. */
export function admitExecution(
  provenance: ExecutionProvenance,
  policy: ExecutionPolicy,
  capabilities: ExecutionCapabilities
): AdmissionDecision {
  if (
    !nonEmpty(provenance.orgId) ||
    !nonEmpty(provenance.agentId) ||
    !nonEmpty(provenance.principalId) ||
    !nonEmpty(provenance.sessionId) ||
    !nonEmpty(provenance.runId) ||
    !nonEmpty(provenance.traceId) ||
    !Number.isSafeInteger(provenance.authorizationRevision) ||
    provenance.authorizationRevision < 0 ||
    !Number.isSafeInteger(provenance.executionEpoch) ||
    provenance.executionEpoch < 0
  )
    return { allowed: false, reason: 'invalid_context' }
  if (provenance.actorId !== undefined && !policy.audience.has(provenance.actorId))
    return { allowed: false, reason: 'audience_denied' }
  if (policy.requireSandbox && !capabilities.sandbox) return { allowed: false, reason: 'sandbox_unavailable' }
  return { allowed: true }
}

/** Tool authorization stays capability-based and fails closed for unknown tools. */
export function authorizeTool(policy: ExecutionPolicy, capabilities: ExecutionCapabilities, tool: string): boolean {
  return nonEmpty(tool) && policy.allowedTools.has(tool) && capabilities.tools.has(tool)
}

/** What an audit record may truthfully state. An ambient run is admitted before its session exists and
 *  its external effect is swept on a later tick, so a session is a fact that may still be absent —
 *  omitted, never fabricated. Admission itself stays strict on {@link ExecutionProvenance}.
 *  `parentEventId` is NOT provenance: it names another audit row, so it belongs to the event. */
export type AuditProvenance = Omit<ExecutionProvenance, 'sessionId' | 'executionEpoch' | 'parentEventId'> & {
  readonly sessionId?: string
  readonly executionEpoch?: number
}

/** Every identity dimension an audit row is keyed by must be present; a partial subject is not auditable. */
export function isAuditableProvenance(provenance: AuditProvenance): boolean {
  return (
    nonEmpty(provenance.orgId) &&
    nonEmpty(provenance.agentId) &&
    nonEmpty(provenance.principalId) &&
    nonEmpty(provenance.traceId) &&
    nonEmpty(provenance.runId) &&
    (provenance.executionEpoch === undefined ||
      (Number.isSafeInteger(provenance.executionEpoch) && provenance.executionEpoch >= 0))
  )
}

/** One fact about a daemon-owned execution, as it enters the durable outbox. The kind vocabulary and the
 *  wire shape are the protocol's, so a record cannot be written that the control plane would refuse. */
export interface DurableAuditEvent {
  readonly eventId: string
  readonly kind: ExecutionAuditKind
  readonly provenance: AuditProvenance
  readonly occurredAt: number
  /** Causal pointers to other audit rows; both are plain ids, never foreign keys. */
  readonly effectId?: string
  readonly parentEventId?: string
  readonly details?: Record<string, unknown>
}

const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|secret|token|body|rawinput|arguments)$/i

/** Audit metadata is useful only when it is safe to persist and forward. */
export function redactAuditDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined
  const redact = (value: unknown, key = ''): unknown => {
    if (SENSITIVE_KEY.test(key)) return '[redacted]'
    if (Array.isArray(value)) return value.map((item) => redact(item))
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, k)]))
    return value
  }
  return redact(details) as Record<string, unknown>
}
