import { AuditEventEnvelope, EXECUTION_AUDIT_V1_FEATURE, type AuditFlushOk } from '@agentconnect.md/protocol'
import type { Clock, TimerHandle } from '@agentconnect.md/connection'
import { formatErr } from '../daemon/text.js'

/** Rows one pass offers the wire; the protocol caps a frame at this many, so a backlog drains over ticks. */
export const AUDIT_FLUSH_BATCH = 100
const AUDIT_FLUSH_INTERVAL_MS = 5_000

/** The outbox as the flusher sees it. */
export interface ExecutionAuditSource {
  pendingExecutionAuditForAgents(
    agentIds: readonly string[],
    limit: number
  ): Promise<Array<{ eventId: string; orgId: string; event: unknown }>>
  acknowledgeExecutionAudit(eventId: string, orgId: string, now?: number): Promise<boolean>
}

/** The channel seam: a CP that does not advertise the feature never sees an audit frame. */
export interface ExecutionAuditChannel {
  supportsServerFeature(feature: string): boolean
  emitAuditFlush(orgId: string, events: AuditEventEnvelope[]): Promise<AuditFlushOk>
}

export interface ExecutionAuditFlushHost {
  source(): ExecutionAuditSource
  channel(): ExecutionAuditChannel | undefined
  clock(): Clock
  /** The operator gate. Off, the flusher neither reads the outbox nor sends a frame. */
  enabled(): boolean
  draining(): boolean
  /** Snapshot of the agents this process serves — its ownership claim on shared-outbox rows. */
  servingAgentIds(): string[]
  warn(message: string): void
  debug(message: string): void
}

/**
 * Drains the durable execution-audit outbox to the control plane (A1 Phase 5).
 *
 * A background convergence loop, not a write path: the row is durable locally before anything here
 * runs, so a failed flush costs delay and never the fact. A row is released only once the control
 * plane names it in its reply, which makes a retried flush a duplicate the ingest absorbs rather than
 * a second record. Nothing is sent unless the operator gate is on AND the connected control plane
 * advertises `execution-audit-v1`, and only about agents this process serves.
 */
export class ExecutionAuditFlusher {
  private timer?: TimerHandle
  private running?: Promise<void>
  private again = false

  constructor(private readonly host: ExecutionAuditFlushHost) {}

  /** Begin the loop. Safe on every (re)connect: an armed flusher ignores it, and a daemon that never
   *  opted into execution audit never runs this code at all. */
  arm(): void {
    if (!this.host.enabled() || this.timer !== undefined || this.host.draining()) return
    this.schedule(AUDIT_FLUSH_INTERVAL_MS)
  }

  dispose(): void {
    if (this.timer !== undefined) {
      this.host.clock().clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** One pass, single-flight: a concurrent caller is remembered and replayed after the live pass. */
  async flush(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    const pass = (async () => {
      try {
        await this.drain()
      } catch (err) {
        this.host.warn(`execution audit flush failed (${formatErr(err)})`)
      }
    })()
    this.running = pass
    try {
      await pass
    } finally {
      if (this.running === pass) this.running = undefined
    }
    if (this.again) {
      this.again = false
      void this.flush()
      return
    }
    this.schedule(AUDIT_FLUSH_INTERVAL_MS)
  }

  private schedule(delayMs: number): void {
    if (this.timer !== undefined || this.host.draining()) return
    this.timer = this.host.clock().setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, delayMs)
  }

  private async drain(): Promise<void> {
    if (!this.host.enabled() || this.host.draining()) return
    const channel = this.host.channel()
    if (!channel || !channel.supportsServerFeature(EXECUTION_AUDIT_V1_FEATURE)) return
    const agents = this.host.servingAgentIds()
    if (agents.length === 0) return
    const source = this.host.source()
    const rows = await source.pendingExecutionAuditForAgents(agents, AUDIT_FLUSH_BATCH)
    if (rows.length === 0) return

    const sendable = new Map<string, AuditEventEnvelope[]>()
    const corrupt: string[] = []
    for (const row of rows) {
      const parsed = AuditEventEnvelope.safeParse(wireForm(row.event))
      if (!parsed.success) {
        corrupt.push(row.eventId)
        continue
      }
      // One frame per org: the envelope's organization is what fences the ingest, so a batch cannot mix.
      const batch = sendable.get(row.orgId)
      if (batch) batch.push(parsed.data)
      else sendable.set(row.orgId, [parsed.data])
    }
    // A row the wire contract refuses can never be ingested; holding it would block the queue behind it.
    if (corrupt.length > 0) {
      this.host.warn(`execution audit dropped ${corrupt.length} outbox row(s) it can no longer describe`)
      await this.release(
        source,
        rows.filter((row) => corrupt.includes(row.eventId))
      )
    }
    for (const [orgId, events] of sendable) await this.flushOrg(channel, source, orgId, events)
  }

  private async flushOrg(
    channel: ExecutionAuditChannel,
    source: ExecutionAuditSource,
    orgId: string,
    events: AuditEventEnvelope[]
  ): Promise<void> {
    let ok: AuditFlushOk
    try {
      ok = await channel.emitAuditFlush(orgId, events)
    } catch (err) {
      this.host.debug(`execution audit flush deferred for ${orgId} (${formatErr(err)})`)
      return
    }
    if (ok.rejected.length > 0)
      this.host.warn(`execution audit dropped ${ok.rejected.length} event(s) the control plane cannot attribute here`)
    // An id named by neither list went unprocessed on the far side, so it stays queued for the next pass.
    const settled = new Set([...ok.accepted, ...ok.rejected])
    await this.release(
      source,
      events.filter((event) => settled.has(event.eventId)).map((event) => ({ eventId: event.eventId, orgId }))
    )
  }

  private async release(source: ExecutionAuditSource, rows: Array<{ eventId: string; orgId: string }>): Promise<void> {
    for (const { eventId, orgId } of rows) {
      try {
        await source.acknowledgeExecutionAudit(eventId, orgId)
      } catch (err) {
        // The row stays queued and a later flush re-sends a fact the ingest already holds; its id is
        // the dedup key, so the worst case is one redundant write.
        this.host.warn(`execution audit release failed for ${eventId} (${formatErr(err)})`)
      }
    }
  }
}

/** The daemon's stored record names its own organization so a shared outbox can be routed locally; on
 *  the wire that fact rides the frame envelope, so the copy in the provenance is dropped rather than
 *  crossing as a second org claim the ingest would have to reconcile. */
function wireForm(event: unknown): unknown {
  if (!event || typeof event !== 'object') return event
  const provenance = (event as { provenance?: unknown }).provenance
  if (!provenance || typeof provenance !== 'object') return event
  const subject = Object.fromEntries(
    Object.entries(provenance as Record<string, unknown>).filter(([key]) => key !== 'orgId')
  )
  return { ...(event as object), provenance: subject }
}
