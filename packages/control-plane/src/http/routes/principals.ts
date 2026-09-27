/**
 * `http/routes/principals.ts` — CRUD + lifecycle for org-owned execution principals
 * (I1 Agent Identity v1). Principals are the unified identity layer agents, service
 * accounts, and delegated executors act through. Every read scopes to the caller's
 * org; viewers are read-only (standard `denyViewerWrite` guard).
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { AgentId } from '../../domain/ids.js'
import { orgOf, denyViewerWrite } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import { PrincipalNameConflict, PrincipalNotFound, PrincipalDisabled } from '../../registry/principalService.js'
import {
  PrincipalDto,
  PrincipalGrantDto,
  CreatePrincipalBody,
  CreatePrincipalGrantBody,
  PrincipalListDto,
  PrincipalGrantListDto,
  ErrorDto
} from '../dto/index.js'
import type { PrincipalRecord, PrincipalGrantRecord } from '../../persistence/ports.js'

// Principal and grant ids are UUIDs. Validating them here means a malformed id is a 400 rejected
// before the handler, rather than a DB type error surfacing as a 500.
const IdParam = z.object({ id: z.uuid() })
// The principal id is a UUID; the grant id is a cuid (varchar PK), so a plain string reaches the
// lookup and simply misses (404) rather than erroring.
const GrantIdParam = z.object({ id: z.uuid(), grantId: z.string().min(1) })

function toPrincipalDto(r: PrincipalRecord) {
  return {
    id: r.id,
    orgId: r.orgId,
    name: r.name,
    kind: r.kind,
    agentId: r.agentId,
    state: r.state,
    disabledAt: r.disabledAt?.toISOString() ?? null,
    disabledBy: r.disabledBy ?? null,
    authorizationRevision: r.authorizationRevision,
    createdByActorId: r.createdByActorId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString()
  }
}

function toGrantDto(r: PrincipalGrantRecord) {
  return {
    id: r.id,
    orgId: r.orgId,
    principalId: r.principalId,
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    capability: r.capability,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    revokedBy: r.revokedBy ?? null,
    createdByActorId: r.createdByActorId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString()
  }
}

export function principalRoutes(deps: HttpDeps) {
  return async function principalRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/principals',
      {
        schema: {
          tags: [Tag.Principals],
          summary: 'List principals',
          description: 'All execution principals for the organization.',
          operationId: 'listPrincipals',
          response: { 200: PrincipalListDto }
        }
      },
      async (req) => {
        const rows = await deps.principals.list(orgOf(req))
        return { principals: rows.map(toPrincipalDto) }
      }
    )

    r.post(
      '/principals',
      {
        schema: {
          tags: [Tag.Principals],
          summary: 'Create a principal',
          description: 'Register a new execution identity (agent, service, or delegated) within the organization.',
          operationId: 'createPrincipal',
          body: CreatePrincipalBody,
          response: { 201: PrincipalDto, 400: ErrorDto, 403: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const { name, kind, agentId } = req.body
        try {
          const rec = await deps.principals.create(
            orgOf(req),
            name,
            kind,
            agentId ? AgentId(agentId) : undefined,
            req.orgCtx!.userId
          )
          return reply.code(201).send(toPrincipalDto(rec))
        } catch (err) {
          if (err instanceof PrincipalNameConflict) {
            return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: err.message })
          }
          throw err
        }
      }
    )

    r.get(
      '/principals/:id',
      {
        schema: {
          tags: [Tag.Principals],
          summary: 'Get a principal',
          operationId: 'getPrincipal',
          params: IdParam,
          response: { 200: PrincipalDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const rec = await deps.principals.get(orgOf(req), req.params.id)
        if (!rec) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'principal not found' })
        return toPrincipalDto(rec)
      }
    )

    r.post(
      '/principals/:id/disable',
      {
        schema: {
          tags: [Tag.Principals],
          summary: 'Disable a principal',
          description: 'Marks the principal disabled and bumps its authorization revision, fencing stale executors.',
          operationId: 'disablePrincipal',
          params: IdParam,
          response: { 200: PrincipalDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const rec = await deps.principals.disable(orgOf(req), req.params.id, req.orgCtx!.userId)
        if (!rec) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'principal not found' })
        return toPrincipalDto(rec)
      }
    )

    r.post(
      '/principals/:id/enable',
      {
        schema: {
          tags: [Tag.Principals],
          summary: 'Enable a principal',
          description: 'Re-activates a disabled principal and bumps its authorization revision.',
          operationId: 'enablePrincipal',
          params: IdParam,
          response: { 200: PrincipalDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const rec = await deps.principals.enable(orgOf(req), req.params.id, req.orgCtx!.userId)
        if (!rec) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'principal not found' })
        return toPrincipalDto(rec)
      }
    )

    r.get(
      '/principals/:id/grants',
      {
        schema: {
          tags: [Tag.Principals],
          summary: 'List grants for a principal',
          operationId: 'listPrincipalGrants',
          params: IdParam,
          response: { 200: PrincipalGrantListDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const principal = await deps.principals.get(orgOf(req), req.params.id)
        if (!principal)
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'principal not found' })
        const grants = await deps.principals.listGrants(orgOf(req), req.params.id)
        return { grants: grants.map(toGrantDto) }
      }
    )

    r.post(
      '/principals/:id/grants',
      {
        schema: {
          tags: [Tag.Principals],
          summary: 'Create a grant',
          description: 'Bind a capability (read/comment/write/execute/notify) on a resource to this principal.',
          operationId: 'createPrincipalGrant',
          params: IdParam,
          body: CreatePrincipalGrantBody,
          response: { 201: PrincipalGrantDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const { resourceType, resourceId, capability, expiresAt } = req.body
        try {
          const grant = await deps.principals.createGrant(
            orgOf(req),
            req.params.id,
            resourceType,
            resourceId,
            capability,
            expiresAt ? new Date(expiresAt) : undefined,
            req.orgCtx!.userId
          )
          return reply.code(201).send(toGrantDto(grant))
        } catch (err) {
          if (err instanceof PrincipalNotFound) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: err.message })
          }
          if (err instanceof PrincipalDisabled) {
            return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: err.message })
          }
          throw err
        }
      }
    )

    r.post(
      '/principals/:id/grants/:grantId/revoke',
      {
        schema: {
          tags: [Tag.Principals],
          summary: 'Revoke a grant',
          operationId: 'revokePrincipalGrant',
          params: GrantIdParam,
          response: { 200: PrincipalGrantDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const grant = await deps.principals.revokeGrant(orgOf(req), req.params.grantId, req.orgCtx!.userId)
        if (!grant) return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'grant not found' })
        return toGrantDto(grant)
      }
    )
  }
}
