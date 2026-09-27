import { createHash } from 'node:crypto'
import type { StandingWorkNotificationRow, StandingWorkRow, StandingWorkRunRow } from '../store/local-store.js'
import {
  isAuditableProvenance,
  redactAuditDetails,
  type AuditProvenance,
  type DurableAuditEvent
} from './governance.js'

/** The durable outbox seam. The recorder only intends; flushing to the control plane is that channel's job. */
export interface ExecutionAuditSink {
  appendExecutionAudit(eventId: string, orgId: string, agentId: string, event: unknown, now?: number): Promise<boolean>
}

/** What the autonomous paths promise to record. Every method resolves to the event id it persisted, or
 *  null when the gate is off, the subject is incomplete, or the write failed — none of which is fatal. */
export interface ExecutionAuditRecorder {
  recordAdmission(work: StandingWorkRow, run: StandingWorkRunRow): Promise<string | null>
  recordEffectIntent(work: StandingWorkRow, notification: StandingWorkNotificationRow): Promise<string | null>
  recordEffectResult(
    work: StandingWorkRow,
    notification: StandingWorkNotificationRow,
    status: string,
    outcome?: { error?: string; intentEventId?: string }
  ): Promise<string | null>
}

/**
 * Records what the autonomous paths actually did into the durable local outbox.
 *
 * Two properties hold this together. It is **dark**: with the operator gate off nothing is written, so a
 * default daemon keeps an empty outbox. And it is **idempotent**: every event id is derived from facts
 * already persisted (a run id and its fence epoch, a notification's effect id), so a retried claim or a
 * swept-again delivery rewrites the same row instead of duplicating it. Nothing here ever throws — losing
 * an audit row must not cost a run its outcome.
 */
export class DaemonAuditRecorder implements ExecutionAuditRecorder {
  constructor(
    private readonly sink: ExecutionAuditSink,
    private readonly enabled: () => boolean = () => false,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Whether an event would be persisted right now. */
  get active(): boolean {
    try {
      return this.enabled() === true
    } catch {
      return false
    }
  }

  /** One trace per run attempt, derivable on any later tick — no process keeps the trace to remember. */
  static traceId(runId: string): string {
    return digest(['trace', runId])
  }

  private async append(id: string, event: Omit<DurableAuditEvent, 'eventId' | 'occurredAt'>): Promise<string | null> {
    if (!this.active || !isAuditableProvenance(event.provenance)) return null
    try {
      const full: DurableAuditEvent = {
        eventId: id,
        ...event,
        occurredAt: this.now(),
        ...(event.details ? { details: redactAuditDetails(event.details) } : {})
      }
      await this.sink.appendExecutionAudit(id, event.provenance.orgId, event.provenance.agentId, full, full.occurredAt)
      return id
    } catch {
      return null
    }
  }

  /** This holder claimed an occurrence and is about to spend a model turn on it. */
  recordAdmission(work: StandingWorkRow, run: StandingWorkRunRow): Promise<string | null> {
    return this.append(eventId('admission', work.orgId, run.runId, String(run.executionEpoch)), {
      kind: 'admission',
      provenance: {
        ...subjectFor(work, run.runId),
        executionEpoch: run.executionEpoch,
        ...(run.sessionId ? { sessionId: run.sessionId } : {})
      },
      details: {
        workId: work.workId,
        definitionVersion: run.definitionVersion,
        occurrenceId: run.occurrenceId,
        attempt: run.attempt,
        wakeSource: run.wakeSource,
        scheduleMode: work.scheduleMode
      }
    })
  }

  /** The intent to notify, written before the effect; carries no payload, only its hash. */
  recordEffectIntent(work: StandingWorkRow, notification: StandingWorkNotificationRow): Promise<string | null> {
    return this.append(eventId('effect-intent', notification.effectId), {
      kind: 'external_effect',
      provenance: subjectFor(work, notification.runId, notification.authorizationRevision),
      effectId: notification.effectId,
      details: {
        workId: work.workId,
        destination: notification.destination,
        payloadHash: notification.payloadHash,
        notificationIndex: notification.notificationIndex,
        phase: 'intent'
      }
    })
  }

  /** How that effect resolved — a suppressed or failed dispatch is as auditable as a delivered one.
   *  `intentEventId` is the row this result follows, and is supplied only when one was actually written:
   *  a refused delivery has no intent, and a parent that does not exist would be a false trace. */
  recordEffectResult(
    work: StandingWorkRow,
    notification: StandingWorkNotificationRow,
    status: string,
    outcome: { error?: string; intentEventId?: string } = {}
  ): Promise<string | null> {
    return this.append(eventId('effect-result', notification.effectId, status, String(notification.attempt)), {
      kind: 'external_effect',
      provenance: subjectFor(work, notification.runId, notification.authorizationRevision),
      effectId: notification.effectId,
      ...(outcome.intentEventId ? { parentEventId: outcome.intentEventId } : {}),
      details: {
        workId: work.workId,
        destination: notification.destination,
        notificationIndex: notification.notificationIndex,
        attempt: notification.attempt,
        phase: 'result',
        status,
        ...(outcome.error ? { error: outcome.error } : {})
      }
    })
  }
}

/** A recorder that never writes, so every call site stays unit-testable without a store. */
export const NOOP_AUDIT_RECORDER: DaemonAuditRecorder = new DaemonAuditRecorder(
  { appendExecutionAudit: async () => false },
  () => false
)

function subjectFor(
  work: StandingWorkRow,
  runId: string,
  authorizationRevision = work.authorizationRevision
): AuditProvenance {
  return {
    orgId: work.orgId,
    agentId: work.agentId,
    principalId: work.principalId,
    authorizationRevision,
    runId,
    traceId: DaemonAuditRecorder.traceId(runId),
    workId: work.workId
  }
}

/** An event id is a pure function of the persisted facts that identify its moment, so rewriting the
 *  same fact lands on the same row instead of duplicating it. */
function eventId(...parts: string[]): string {
  return digest(parts)
}

function digest(parts: string[]): string {
  return createHash('sha256')
    .update(['agentconnect-execution-audit', ...parts].join('\0'))
    .digest('hex')
}
