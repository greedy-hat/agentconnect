import { createHash } from 'node:crypto'
import { Cron } from 'croner'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import type { HttpDeps } from '../deps.js'
import { ctxOf, denyNonOwner, denyViewerWrite, orgOf } from '../rbac.js'
import { canView } from '../../authorization/policy.js'
import { AgentId } from '../../domain/ids.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import type { StandingWorkControl } from '@agentconnect.md/protocol'
import type {
  FixedStandingWorkInput,
  StandingWorkRecord,
  StandingWorkRunRecord
} from '../../standing-work/contracts.js'

const Destination = z
  .object({
    platform: z.string().min(1).max(64),
    integrationId: z.uuid(),
    channel: z.string().min(1).max(512),
    thread: z.string().min(1).max(512).optional()
  })
  .strict()
const Context = Destination
const Definition = z
  .object({
    agentId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    objective: z.string().trim().min(1).max(16_000),
    schedule: z.string().trim().min(1).max(200),
    timezone: z.string().min(1).max(100),
    startAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    scheduleMode: z.enum(['fixed', 'adaptive']).default('fixed'),
    minIntervalSeconds: z.number().int().min(60).max(86_400).default(60),
    maxIntervalSeconds: z.number().int().min(60).max(2_592_000).default(86_400),
    wakeOnConversation: z.boolean().default(false),
    maxRunsPerDay: z.number().int().min(1).max(1_440).default(24),
    maxNotificationsPerDay: z.number().int().min(0).max(1_440).default(2),
    conversationRef: Context.nullable().default(null),
    targetDestination: Destination,
    budgetPolicyRef: z.string().min(1).max(200),
    toolPolicyRef: z.string().min(1).max(200),
    notificationPolicy: z.object({ mode: z.enum(['changes', 'all']), includeCompletion: z.boolean() }).strict(),
    visibilityPolicyRef: z.string().min(1).max(200),
    sourceSessionId: z.string().min(1).max(200).nullable().default(null),
    principalId: z.uuid().optional()
  })
  .strict()
const Create = z.object({ idempotencyKey: z.string().min(8).max(200), definition: Definition }).strict()
const Edit = z.object({ expectedVersion: z.number().int().positive(), definition: Definition }).strict()
const Action = z.object({ expectedVersion: z.number().int().positive() }).strict()
const Id = z.object({ id: z.uuid() })
const RunsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    beforeStartedAt: z.iso.datetime().optional(),
    beforeRunId: z.uuid().optional()
  })
  .strict()
const Problem = z.object({ error: z.string(), statusCode: z.number(), message: z.string() })
const Response = z.object({
  id: z.uuid(),
  orgId: z.string(),
  agentId: z.uuid(),
  principalId: z.string(),
  name: z.string(),
  objective: z.string(),
  state: z.enum(['active', 'paused', 'completed', 'expired', 'cancelled']),
  definitionVersion: z.number(),
  approvalState: z.enum(['pending', 'approved', 'denied']),
  approvalVersion: z.number().nullable(),
  schedule: z.string(),
  timezone: z.string(),
  startAt: z.string(),
  expiresAt: z.string(),
  scheduleMode: z.enum(['fixed', 'adaptive']),
  minIntervalSeconds: z.number(),
  maxIntervalSeconds: z.number(),
  wakeOnConversation: z.boolean(),
  maxRunsPerDay: z.number(),
  maxNotificationsPerDay: z.number(),
  conversationRef: Context.nullable(),
  targetDestination: Destination,
  budgetPolicyRef: z.string(),
  toolPolicyRef: z.string(),
  notificationPolicy: z.object({ mode: z.enum(['changes', 'all']), includeCompletion: z.boolean() }),
  visibilityPolicyRef: z.string(),
  sourceSessionId: z.string().nullable(),
  createdByActorId: z.string(),
  lastModifiedByActorId: z.string(),
  approvedByActorId: z.string().nullable(),
  authorizationRevision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string()
})
/** One run's delivery fact, kept separate from `Run.outcome`: a committed `notify` run can still
 *  have a `pending`/`sending`/`uncertain` delivery. Status + receipt + error code only — a
 *  notification body never leaves the daemon. */
const NotificationDto = z.object({
  notificationIndex: z.number().int().nonnegative(),
  effectId: z.string(),
  status: z.enum(['pending', 'sending', 'delivered', 'uncertain', 'failed', 'suppressed']),
  providerReceipt: z.string().nullable(),
  error: z.string().nullable()
})
const RunDto = z.object({
  runId: z.string(),
  workId: z.string(),
  definitionVersion: z.number(),
  executionEpoch: z.number(),
  attempt: z.number(),
  outcome: z.enum(['no_change', 'notify', 'blocked', 'complete', 'failed']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  sessionId: z.string().nullable(),
  errorCode: z.string().nullable(),
  suggestedNextCheckAt: z.string().nullable(),
  wakeSource: z.enum(['scheduled', 'conversation']),
  notification: NotificationDto.nullable()
})

function problem(
  reply: { code(code: number): { send(value: unknown): unknown } },
  code: number,
  message: string
): void {
  const error = code === 403 ? 'Forbidden' : code === 404 ? 'Not Found' : code === 409 ? 'Conflict' : 'Bad Request'
  void reply.code(code).send({ error, statusCode: code, message })
}

function dto(row: StandingWorkRecord): z.infer<typeof Response> {
  return {
    ...row,
    startAt: row.startAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

function runDto(row: StandingWorkRunRecord): z.infer<typeof RunDto> {
  return {
    ...row,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    suggestedNextCheckAt: row.suggestedNextCheckAt ? row.suggestedNextCheckAt.toISOString() : null
  }
}

function parseDefinition(value: z.infer<typeof Definition>, now: number): FixedStandingWorkInput | null {
  const startAt = new Date(value.startAt)
  const expiresAt = new Date(value.expiresAt)
  if (startAt.getTime() > now || expiresAt.getTime() <= now || expiresAt.getTime() <= startAt.getTime()) return null
  if (expiresAt.getTime() - now > 90 * 86_400_000) return null
  if (value.schedule.trim().split(/\s+/).length !== 5) return null
  let first: number | undefined
  let second: number | undefined
  try {
    const cron = new Cron(value.schedule, { timezone: value.timezone })
    first = cron.nextRun(new Date(now))?.getTime()
    second = first === undefined ? undefined : cron.nextRun(new Date(first))?.getTime()
  } catch {
    return null
  }
  if (!first || !second || first >= expiresAt.getTime() || second - first < value.minIntervalSeconds * 1_000)
    return null
  if (value.scheduleMode === 'adaptive' && value.maxIntervalSeconds < value.minIntervalSeconds) return null
  return { ...value, principalId: '', startAt, expiresAt }
}

export function standingWorkRoutes(deps: HttpDeps) {
  return async function standingWorkPlugin(app: FastifyInstance): Promise<void> {
    const repo = deps.repos.standingWork
    const r = app.withTypeProvider<ZodTypeProvider>()
    const getVisible = async (req: FastifyRequest, id: string) => {
      const row = await repo?.get(orgOf(req), id)
      if (!row) return null
      const agent = await deps.repos.agent.get(orgOf(req), AgentId(row.agentId))
      return agent && canView(agent, ctxOf(req)) ? row : null
    }
    const validateAccess = async (req: FastifyRequest, value: z.infer<typeof Definition>) => {
      const agent = await deps.repos.agent.get(orgOf(req), AgentId(value.agentId))
      if (!agent || !canView(agent, ctxOf(req))) return false
      const destination = await deps.repos.integration.get(
        orgOf(req),
        value.targetDestination.integrationId as Parameters<typeof deps.repos.integration.get>[1]
      )
      if (
        !destination ||
        destination.agentId !== agent.id ||
        destination.platform !== value.targetDestination.platform ||
        destination.status !== 'active'
      )
        return false
      if (!deps.standingWorkGrant) return false
      return deps.standingWorkGrant({
        request: req,
        orgId: orgOf(req),
        actorId: ctxOf(req).userId,
        agentId: agent.id,
        destination: value.targetDestination,
        context: value.conversationRef
      })
    }

    r.post(
      '/standing-work',
      {
        schema: {
          tags: [Tag.StandingWork],
          summary: 'Create a Standing Work item',
          description:
            'Declares fixed, time-boxed ambient work for one agent: a cron schedule with a hard expiry, a delivery destination, and the policy refs the daemon enforces. The creating member must be able to see the agent and send to the destination, and an owner must approve the definition before it runs.',
          operationId: 'createStandingWork',
          body: Create,
          response: { 200: Response, 400: Problem, 403: Problem, 409: Problem }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        if (!repo) return problem(reply, 409, 'Standing Work is unavailable')
        const definition = parseDefinition(req.body.definition, deps.clock.now())
        if (!definition) return problem(reply, 400, 'invalid fixed schedule or finite expiry')
        if (!(await validateAccess(req, req.body.definition)))
          return problem(reply, 403, 'destination or context access denied')
        const actorId = ctxOf(req).userId
        const requestedPrincipalId = req.body.definition.principalId
        let resolvedPrincipalId = `standing-work:${orgOf(req)}`
        let authorizationRevision = 1
        if (requestedPrincipalId) {
          const principal = await deps.principals.get(orgOf(req), requestedPrincipalId)
          if (!principal) return problem(reply, 400, 'principal not found')
          if (principal.state === 'disabled') return problem(reply, 409, 'principal is disabled')
          resolvedPrincipalId = principal.id
          authorizationRevision = principal.authorizationRevision
        }
        const requestHash = createHash('sha256').update(JSON.stringify(req.body.definition)).digest('hex')
        const result = await repo.create({
          ...definition,
          orgId: orgOf(req),
          principalId: resolvedPrincipalId,
          actorId,
          authorizationRevision,
          idempotencyKey: req.body.idempotencyKey,
          requestHash
        })
        if (result === 'conflict') return problem(reply, 409, 'idempotency key was used for another definition')
        return dto(result.record)
      }
    )

    r.get(
      '/standing-work',
      {
        schema: {
          tags: [Tag.StandingWork],
          summary: 'List Standing Work items',
          description:
            'Every Standing Work definition in the caller’s active organization that they may view, newest change first.',
          operationId: 'listStandingWork',
          response: { 200: z.array(Response), 409: Problem }
        }
      },
      async (req, reply) => {
        if (!repo) return problem(reply, 409, 'Standing Work is unavailable')
        const rows = await repo.list(orgOf(req), 100)
        const visible = await Promise.all(
          rows.map(async (row) => {
            const agent = await deps.repos.agent.get(orgOf(req), AgentId(row.agentId))
            return agent && canView(agent, ctxOf(req)) ? dto(row) : null
          })
        )
        return visible.filter((row): row is z.infer<typeof Response> => row !== null)
      }
    )

    r.get(
      '/standing-work/:id',
      {
        schema: {
          tags: [Tag.StandingWork],
          summary: 'Get a Standing Work item',
          description: 'One Standing Work definition by id. A definition the caller may not view answers 404, not 403.',
          operationId: 'getStandingWork',
          params: Id,
          response: { 200: Response, 404: Problem }
        }
      },
      async (req, reply) => {
        const row = await getVisible(req, req.params.id)
        return row ? dto(row) : problem(reply, 404, 'Standing Work item not found')
      }
    )

    // Run history the executing daemon pushed via `standing-work/report`, newest first — the
    // console detail page's Runs card. `beforeStartedAt` + `beforeRunId` form an exclusive cursor.
    // Pure DB read; the CP never sits on the execution path.
    r.get(
      '/standing-work/:id/runs',
      {
        schema: {
          tags: [Tag.StandingWork],
          summary: 'List Standing Work runs',
          description:
            'Daemon-reported run history for a Standing Work item, newest first. Each row carries the run outcome and, separately, its notification delivery status — a delivered run is not a notified run, and an `uncertain` delivery stays visible as such. Pass both beforeStartedAt and beforeRunId to read the next older page. Objectives and message bodies stay in the daemon.',
          operationId: 'listStandingWorkRuns',
          params: Id,
          querystring: RunsQuery,
          response: { 200: z.array(RunDto), 404: Problem }
        }
      },
      async (req, reply) => {
        const row = await getVisible(req, req.params.id)
        if (!row || !repo) return problem(reply, 404, 'Standing Work item not found')
        if (Boolean(req.query.beforeStartedAt) !== Boolean(req.query.beforeRunId)) {
          return problem(reply, 400, 'beforeStartedAt and beforeRunId must be supplied together')
        }
        const before =
          req.query.beforeStartedAt && req.query.beforeRunId
            ? { startedAt: new Date(req.query.beforeStartedAt), runId: req.query.beforeRunId }
            : undefined
        return (await repo.listRuns(orgOf(req), row.id, req.query.limit, before)).map(runDto)
      }
    )

    r.put(
      '/standing-work/:id',
      {
        schema: {
          tags: [Tag.StandingWork],
          summary: 'Replace a Standing Work definition',
          description:
            'Rewrites the whole definition at `expectedVersion`; the stored version must match or the write 409s. Any edit re-opens approval, because a changed objective, schedule or destination is a different commitment.',
          operationId: 'replaceStandingWork',
          params: Id,
          body: Edit,
          response: { 200: Response, 400: Problem, 403: Problem, 404: Problem, 409: Problem }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const previous = await getVisible(req, req.params.id)
        if (!previous || !repo) return problem(reply, 404, 'Standing Work item not found')
        if (previous.agentId !== req.body.definition.agentId) return problem(reply, 400, 'agent cannot change')
        const definition = parseDefinition(req.body.definition, deps.clock.now())
        if (!definition) return problem(reply, 400, 'invalid fixed schedule or finite expiry')
        if (!(await validateAccess(req, req.body.definition)))
          return problem(reply, 403, 'destination or context access denied')
        const requestedPrincipalId = req.body.definition.principalId
        let resolvedPrincipalId = previous.principalId
        let nextRevision = previous.authorizationRevision + 1
        if (requestedPrincipalId && requestedPrincipalId !== previous.principalId) {
          const principal = await deps.principals.get(orgOf(req), requestedPrincipalId)
          if (!principal) return problem(reply, 400, 'principal not found')
          if (principal.state === 'disabled') return problem(reply, 409, 'principal is disabled')
          resolvedPrincipalId = principal.id
          nextRevision = principal.authorizationRevision
        }
        const row = await repo.replace({
          orgId: orgOf(req),
          id: previous.id,
          expectedVersion: req.body.expectedVersion,
          actorId: ctxOf(req).userId,
          authorizationRevision: nextRevision,
          definition: { ...definition, principalId: resolvedPrincipalId }
        })
        return row ? dto(row) : problem(reply, 409, 'definition version changed')
      }
    )

    const controlPushFailed =
      (what: string) =>
      (err: unknown, daemonId: string): void => {
        if (err instanceof NoConnection) {
          app.log.debug({ daemonId }, `${what} skipped: daemon offline`)
          return
        }
        app.log.warn({ daemonId, err }, `${what} live push failed — daemon converges on next register`)
      }
    const pushControl = async (
      req: FastifyRequest,
      row: StandingWorkRecord,
      action: StandingWorkControl['action'],
      canApprove: boolean
    ) => {
      const agent = await deps.repos.agent.get(orgOf(req), AgentId(row.agentId))
      if (!agent) return
      const wire: StandingWorkControl = {
        authority: {
          actorId: ctxOf(req).userId,
          canManage: true,
          canApprove,
          authorizationRevision: row.authorizationRevision
        },
        action,
        orgId: orgOf(req),
        workId: row.id,
        version: row.definitionVersion
      }
      await deps.agentDelivery.standingWorkControl(agent, wire, controlPushFailed(`standing-work/${action}`))
    }
    const ACTIONS = {
      pause: {
        state: 'paused',
        summary: 'Pause a Standing Work item',
        description:
          'Stop the schedule firing, keeping the definition for a later resume. Any pending approval is re-opened.'
      },
      resume: {
        state: 'active',
        summary: 'Resume a Standing Work item',
        description:
          'Restart a paused schedule. Refused unless the caller still authorizes the agent and destination and the window has not expired — resume re-checks, it does not inherit.'
      },
      cancel: {
        state: 'cancelled',
        summary: 'Cancel a Standing Work item',
        description:
          'Terminate the definition for good. A cancelled item cannot be resumed; it stays readable with its run history.'
      }
    } as const
    for (const [action, meta] of Object.entries(ACTIONS)) {
      const state = meta.state
      r.post(
        `/standing-work/:id/${action}`,
        {
          schema: {
            tags: [Tag.StandingWork],
            summary: meta.summary,
            description: meta.description,
            operationId: `${action}StandingWork`,
            params: Id,
            body: Action,
            response: { 200: Response, 403: Problem, 404: Problem, 409: Problem }
          }
        },
        async (req, reply) => {
          if (denyViewerWrite(req, reply)) return
          const previous = await getVisible(req, req.params.id)
          if (!previous || !repo) return problem(reply, 404, 'Standing Work item not found')
          if (
            state === 'active' &&
            (!(await deps.standingWorkGrant?.({
              request: req,
              orgId: orgOf(req),
              actorId: ctxOf(req).userId,
              agentId: previous.agentId,
              destination: previous.targetDestination,
              context: previous.conversationRef
            })) ||
              previous.expiresAt.getTime() <= deps.clock.now())
          )
            return problem(reply, 403, 'current authorization or expiry prevents resume')
          const row = await repo.transition({
            orgId: orgOf(req),
            id: previous.id,
            expectedVersion: req.body.expectedVersion,
            actorId: ctxOf(req).userId,
            state
          })
          if (row) await pushControl(req, row, action as StandingWorkControl['action'], false)
          return row ? dto(row) : problem(reply, 409, 'definition version changed')
        }
      )
    }

    r.post(
      '/standing-work/:id/approve',
      {
        schema: {
          tags: [Tag.StandingWork],
          summary: 'Approve a Standing Work definition',
          description:
            'Owner-only: records that the current definition version is authorized to run. Any later edit or state transition clears the approval.',
          operationId: 'approveStandingWork',
          params: Id,
          body: Action,
          response: { 200: Response, 403: Problem, 404: Problem, 409: Problem }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const previous = await getVisible(req, req.params.id)
        if (!previous || !repo) return problem(reply, 404, 'Standing Work item not found')
        if (
          !(await deps.standingWorkGrant?.({
            request: req,
            orgId: orgOf(req),
            actorId: ctxOf(req).userId,
            agentId: previous.agentId,
            destination: previous.targetDestination,
            context: previous.conversationRef
          }))
        )
          return problem(reply, 403, 'destination or context access denied')
        const row = await repo.approve({
          orgId: orgOf(req),
          id: previous.id,
          expectedVersion: req.body.expectedVersion,
          actorId: ctxOf(req).userId
        })
        if (row) await pushControl(req, row, 'approve', true)
        return row ? dto(row) : problem(reply, 409, 'definition version changed')
      }
    )
  }
}
