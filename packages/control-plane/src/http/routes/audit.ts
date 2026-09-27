/**
 * `http/routes/audit.ts` — org-isolated audit trail search + export
 * (A1 Unified Audit, roadmap §6).
 *
 * The audit trail is a security-sensitive provenance record, so reads are
 * OWNER-ONLY (`denyNonOwner`) — the fail-closed default. Every query is scoped
 * to the caller's org at the repository layer (`search` requires `orgId`);
 * there is no global tail. Export is bounded so a large org cannot ask the CP
 * to materialize its whole history in memory.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { AuditRecord, AuditSearchFilter } from '../../persistence/ports.js'
import type { AuditKind } from '../../generated/prisma/client.js'
import { orgOf, denyNonOwner } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import { AuditSearchQuery, AuditSearchResponseDto, AuditExportResponseDto, ErrorDto } from '../dto/index.js'

// Hard ceiling on a single export request. Beyond this the caller must page the
// search endpoint; `truncated` reports whether the cap was hit.
const MAX_EXPORT_ROWS = 5000
const EXPORT_PAGE_SIZE = 200

function toDto(r: AuditRecord) {
  return {
    id: r.id.toString(),
    kind: r.kind,
    orgId: r.orgId ?? null,
    daemonId: r.daemonId ?? null,
    agentId: r.agentId ?? null,
    sessionId: r.sessionId ?? null,
    actorUserId: r.actorUserId ?? null,
    message: r.message ?? null,
    details: r.details,
    eventId: r.eventId ?? null,
    traceId: r.traceId ?? null,
    parentEventId: r.parentEventId ?? null,
    effectId: r.effectId ?? null,
    principalId: r.principalId ?? null,
    source: r.source,
    occurredAt: r.occurredAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString()
  }
}

// Turn the validated querystring into a repository filter. `orgId` is always
// the path org; the caller cannot widen it.
function toFilter(orgId: AuditSearchFilter['orgId'], q: z.infer<typeof AuditSearchQuery>): AuditSearchFilter {
  const kinds = q.kinds
    ?.split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
  return {
    orgId,
    ...(kinds && kinds.length ? { kinds: kinds as AuditKind[] } : {}),
    ...(q.principalId ? { principalId: q.principalId } : {}),
    ...(q.traceId ? { traceId: q.traceId } : {}),
    ...(q.effectId ? { effectId: q.effectId } : {}),
    ...(q.agentId ? { agentId: q.agentId as AuditSearchFilter['agentId'] } : {}),
    ...(q.daemonId ? { daemonId: q.daemonId as AuditSearchFilter['daemonId'] } : {}),
    ...(q.sessionId ? { sessionId: q.sessionId as AuditSearchFilter['sessionId'] } : {}),
    ...(q.from ? { from: new Date(q.from) } : {}),
    ...(q.to ? { to: new Date(q.to) } : {}),
    ...(q.cursor ? { cursor: BigInt(q.cursor) } : {}),
    ...(q.limit ? { limit: q.limit } : {})
  }
}

export function auditRoutes(deps: HttpDeps) {
  return async function auditRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const repo = deps.repos.audit

    r.get(
      '/audit',
      {
        schema: {
          tags: [Tag.Audit],
          summary: 'Search the audit trail',
          description:
            'Organization-isolated audit events, newest-first by ingestion id, narrowed by kind, principal, causal identifiers, and an ingestion-time window. Cursor-paginated. Owner-only.',
          operationId: 'searchAudit',
          querystring: AuditSearchQuery,
          response: { 200: AuditSearchResponseDto, 403: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const page = await repo.search(toFilter(orgOf(req), req.query))
        return { events: page.events.map(toDto), nextCursor: page.nextCursor?.toString() ?? null }
      }
    )

    r.get(
      '/audit/export',
      {
        schema: {
          tags: [Tag.Audit],
          summary: 'Export the audit trail as JSON',
          description: `Bounded JSON export of the filtered audit trail (up to ${MAX_EXPORT_ROWS} events). Cursor pagination is ignored; \`truncated\` reports whether the ceiling was reached. Owner-only.`,
          operationId: 'exportAudit',
          querystring: AuditSearchQuery,
          response: { 200: AuditExportResponseDto, 403: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const base = toFilter(orgOf(req), req.query)
        const events: ReturnType<typeof toDto>[] = []
        let cursor: bigint | undefined
        let truncated = false
        while (events.length < MAX_EXPORT_ROWS) {
          const page = await repo.search({ ...base, cursor, limit: EXPORT_PAGE_SIZE })
          for (const e of page.events) events.push(toDto(e))
          if (page.nextCursor === null) break
          cursor = page.nextCursor
          if (events.length >= MAX_EXPORT_ROWS) truncated = true
        }
        return { events: events.slice(0, MAX_EXPORT_ROWS), truncated, exportedAt: new Date().toISOString() }
      }
    )
  }
}
