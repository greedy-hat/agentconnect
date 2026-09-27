/**
 * PgAuditRepo — append-only audit / events feed (design §3.12, §3.14).
 *
 * METADATA ONLY: `details` is a small JSONB of identifiers, never bodies.
 * `append` writes one row, `appendOnce` writes one keyed by a daemon's `eventId` and
 * reports a replay instead of duplicating it. `search` reads an org-isolated, filtered,
 * cursor-paginated page newest-first. There is deliberately no unscoped global tail.
 */
import type { Prisma, AuditEvent } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type { AuditRepo, AuditRecord, AuditInput, AuditKind, AuditSearchFilter, AuditSearchPage } from '../ports.js'
import { AgentId, DaemonId, OrgId, SessionId } from '../../domain/ids.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)))
}

function toRecord(e: AuditEvent): AuditRecord {
  return {
    id: e.id,
    kind: e.kind as AuditKind,
    orgId: e.orgId ? OrgId(e.orgId) : null,
    daemonId: e.daemonId ? DaemonId(e.daemonId) : null,
    agentId: e.agentId ? AgentId(e.agentId) : null,
    sessionId: e.sessionId ? SessionId(e.sessionId) : null,
    actorUserId: e.actorUserId,
    message: e.message,
    details: e.details,
    eventId: e.eventId,
    traceId: e.traceId,
    parentEventId: e.parentEventId,
    effectId: e.effectId,
    principalId: e.principalId,
    source: e.source,
    occurredAt: e.occurredAt,
    createdAt: e.createdAt
  }
}

export class PgAuditRepo implements AuditRepo {
  constructor(private readonly db: PrismaLike) {}

  async append(input: AuditInput): Promise<AuditRecord> {
    const e = await this.db.auditEvent.create({
      data: {
        kind: input.kind,
        orgId: input.orgId,
        daemonId: input.daemonId,
        agentId: input.agentId,
        sessionId: input.sessionId,
        actorUserId: input.actorUserId,
        frameType: input.frameType,
        frameCorr: input.frameCorr,
        message: input.message,
        details: input.details as Prisma.InputJsonValue | undefined,
        eventId: input.eventId,
        traceId: input.traceId,
        parentEventId: input.parentEventId,
        effectId: input.effectId,
        principalId: input.principalId,
        source: input.source,
        occurredAt: input.occurredAt
      }
    })
    return toRecord(e)
  }

  /** The unique index on `eventId` is the dedup: a flush the daemon retried because it never saw our
   *  reply lands on the same key and is reported as already-recorded rather than written twice. */
  async appendOnce(input: AuditInput): Promise<boolean> {
    if (!input.eventId) {
      await this.append(input)
      return true
    }
    try {
      await this.append(input)
      return true
    } catch (err) {
      if (Reflect.get(err ?? {}, 'code') === 'P2002') return false
      throw err
    }
  }

  async search(filter: AuditSearchFilter): Promise<AuditSearchPage> {
    const limit = clampLimit(filter.limit)
    const where: Prisma.AuditEventWhereInput = {
      orgId: filter.orgId,
      ...(filter.kinds?.length ? { kind: { in: filter.kinds } } : {}),
      ...(filter.principalId ? { principalId: filter.principalId } : {}),
      ...(filter.traceId ? { traceId: filter.traceId } : {}),
      ...(filter.effectId ? { effectId: filter.effectId } : {}),
      ...(filter.agentId ? { agentId: filter.agentId } : {}),
      ...(filter.daemonId ? { daemonId: filter.daemonId } : {}),
      ...(filter.sessionId ? { sessionId: filter.sessionId } : {}),
      ...(filter.from || filter.to
        ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
        : {}),
      ...(filter.cursor !== undefined ? { id: { lt: filter.cursor } } : {})
    }
    const rows = await this.db.auditEvent.findMany({ where, orderBy: { id: 'desc' }, take: limit + 1 })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    return { events: page.map(toRecord), nextCursor: hasMore && last ? last.id : null }
  }
}
