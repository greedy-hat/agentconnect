import { randomUUID } from 'node:crypto'
import type { StandingWorkRunReport } from '@agentconnect.md/protocol'
import { Prisma, type StandingWorkDef } from '../../generated/prisma/client.js'
import type {
  FixedStandingWorkInput,
  StandingWorkNotificationRecord,
  StandingWorkRecord,
  StandingWorkRepo,
  StandingWorkRunCursor,
  StandingWorkRunRecord
} from '../../standing-work/contracts.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'

function toRecord(row: StandingWorkDef): StandingWorkRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    agentId: row.agentId,
    principalId: row.principalId,
    name: row.name,
    objective: row.objective,
    state: row.state as StandingWorkRecord['state'],
    definitionVersion: row.definitionVersion,
    schedule: row.schedule,
    timezone: row.timezone,
    startAt: row.startAt,
    expiresAt: row.expiresAt,
    scheduleMode: row.scheduleMode as 'fixed' | 'adaptive',
    minIntervalSeconds: row.minIntervalSeconds,
    maxIntervalSeconds: row.maxIntervalSeconds,
    wakeOnConversation: row.wakeOnConversation,
    maxRunsPerDay: row.maxRunsPerDay,
    maxNotificationsPerDay: row.maxNotificationsPerDay,
    conversationRef: row.conversationRef as StandingWorkRecord['conversationRef'],
    targetDestination: row.targetDestination as unknown as StandingWorkRecord['targetDestination'],
    budgetPolicyRef: row.budgetPolicyRef,
    toolPolicyRef: row.toolPolicyRef,
    notificationPolicy: row.notificationPolicy as StandingWorkRecord['notificationPolicy'],
    visibilityPolicyRef: row.visibilityPolicyRef,
    sourceSessionId: row.sourceSessionId,
    createdByActorId: row.createdByActorId,
    lastModifiedByActorId: row.lastModifiedByActorId,
    authorizationRevision: row.authorizationRevision,
    approvalState: row.approvalState as StandingWorkRecord['approvalState'],
    approvalVersion: row.approvalVersion,
    approvedByActorId: row.approvedByActorId,
    createIdempotencyKey: row.createIdempotencyKey,
    createRequestHash: row.createRequestHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function definitionData(input: FixedStandingWorkInput) {
  return {
    agentId: input.agentId,
    principalId: input.principalId,
    name: input.name,
    objective: input.objective,
    schedule: input.schedule,
    timezone: input.timezone,
    startAt: input.startAt,
    expiresAt: input.expiresAt,
    scheduleMode: input.scheduleMode,
    minIntervalSeconds: input.minIntervalSeconds,
    maxIntervalSeconds: input.maxIntervalSeconds,
    wakeOnConversation: input.wakeOnConversation,
    maxRunsPerDay: input.maxRunsPerDay,
    maxNotificationsPerDay: input.maxNotificationsPerDay,
    conversationRef:
      input.conversationRef === null ? Prisma.JsonNull : (input.conversationRef as unknown as Prisma.InputJsonObject),
    targetDestination: input.targetDestination as unknown as Prisma.InputJsonObject,
    budgetPolicyRef: input.budgetPolicyRef,
    toolPolicyRef: input.toolPolicyRef,
    notificationPolicy: input.notificationPolicy as unknown as Prisma.InputJsonObject,
    visibilityPolicyRef: input.visibilityPolicyRef,
    sourceSessionId: input.sourceSessionId
  }
}

export class PgStandingWorkRepo implements StandingWorkRepo {
  constructor(private readonly db: PrismaLike) {}

  async create(
    input: FixedStandingWorkInput & {
      orgId: string
      actorId: string
      authorizationRevision: number
      idempotencyKey: string
      requestHash: string
    }
  ): Promise<{ record: StandingWorkRecord; duplicate: boolean } | 'conflict'> {
    return withAmbientTx(this.db, async (tx) => {
      const key = JSON.stringify(['standing-work-create', input.orgId, input.idempotencyKey])
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"`)
      const existing = await tx.standingWorkDef.findUnique({
        where: { orgId_createIdempotencyKey: { orgId: input.orgId, createIdempotencyKey: input.idempotencyKey } }
      })
      if (existing)
        return existing.createRequestHash === input.requestHash
          ? { record: toRecord(existing), duplicate: true }
          : 'conflict'
      const row = await tx.standingWorkDef.create({
        data: {
          id: randomUUID(),
          orgId: input.orgId,
          ...definitionData(input),
          createdByActorId: input.actorId,
          lastModifiedByActorId: input.actorId,
          authorizationRevision: input.authorizationRevision,
          createIdempotencyKey: input.idempotencyKey,
          createRequestHash: input.requestHash,
          updatedAt: new Date()
        }
      })
      return { record: toRecord(row), duplicate: false }
    })
  }

  async get(orgId: string, id: string): Promise<StandingWorkRecord | null> {
    const row = await this.db.standingWorkDef.findFirst({ where: { orgId, id } })
    return row ? toRecord(row) : null
  }

  async list(orgId: string, limit: number): Promise<StandingWorkRecord[]> {
    const rows = await this.db.standingWorkDef.findMany({
      where: { orgId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: limit
    })
    return rows.map(toRecord)
  }

  async listForAgents(agentIds: readonly string[]): Promise<StandingWorkRecord[]> {
    if (agentIds.length === 0) return []
    const rows = await this.db.standingWorkDef.findMany({
      where: { agentId: { in: [...agentIds] } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }]
    })
    return rows.map(toRecord)
  }

  async replace(input: {
    orgId: string
    id: string
    expectedVersion: number
    actorId: string
    authorizationRevision: number
    definition: FixedStandingWorkInput
  }): Promise<StandingWorkRecord | null> {
    return withAmbientTx(this.db, async (tx) => {
      const updated = await tx.standingWorkDef.updateMany({
        where: {
          orgId: input.orgId,
          id: input.id,
          definitionVersion: input.expectedVersion,
          state: { in: ['active', 'paused'] }
        },
        data: {
          ...definitionData(input.definition),
          definitionVersion: { increment: 1 },
          approvalState: 'pending',
          approvalVersion: null,
          approvedByActorId: null,
          lastModifiedByActorId: input.actorId,
          authorizationRevision: input.authorizationRevision
        }
      })
      if (updated.count !== 1) return null
      const row = await tx.standingWorkDef.findUniqueOrThrow({ where: { id: input.id } })
      return toRecord(row)
    })
  }

  async transition(input: {
    orgId: string
    id: string
    expectedVersion: number
    actorId: string
    state: StandingWorkRecord['state']
  }): Promise<StandingWorkRecord | null> {
    return withAmbientTx(this.db, async (tx) => {
      const allowed =
        input.state === 'active'
          ? ['paused']
          : input.state === 'paused'
            ? ['active']
            : input.state === 'cancelled'
              ? ['active', 'paused']
              : []
      if (!allowed.length) return null
      const updated = await tx.standingWorkDef.updateMany({
        where: { orgId: input.orgId, id: input.id, definitionVersion: input.expectedVersion, state: { in: allowed } },
        data: {
          state: input.state,
          definitionVersion: { increment: 1 },
          approvalState: 'pending',
          approvalVersion: null,
          approvedByActorId: null,
          lastModifiedByActorId: input.actorId
        }
      })
      if (updated.count !== 1) return null
      return toRecord(await tx.standingWorkDef.findUniqueOrThrow({ where: { id: input.id } }))
    })
  }

  async approve(input: {
    orgId: string
    id: string
    expectedVersion: number
    actorId: string
  }): Promise<StandingWorkRecord | null> {
    return withAmbientTx(this.db, async (tx) => {
      const updated = await tx.standingWorkDef.updateMany({
        where: {
          orgId: input.orgId,
          id: input.id,
          definitionVersion: input.expectedVersion,
          approvalState: 'pending',
          state: 'active',
          expiresAt: { gt: new Date() }
        },
        data: { approvalState: 'approved', approvalVersion: input.expectedVersion, approvedByActorId: input.actorId }
      })
      if (updated.count !== 1) return null
      return toRecord(await tx.standingWorkDef.findUniqueOrThrow({ where: { id: input.id } }))
    })
  }

  /**
   * Apply one `standing-work/report`. The three fences are ordered — a report behind what is already
   * stored for this run is a stale executor's, so it drops silently rather than regressing the row.
   * A settled delivery is likewise never reopened by an earlier-phase report: `pending` arriving after
   * `delivered` says nothing new, and `uncertain` must survive because it is the honest answer.
   */
  async recordReport(orgId: string, workId: string, report: StandingWorkRunReport): Promise<boolean> {
    return withAmbientTx(this.db, async (tx) => {
      const def = await tx.standingWorkDef.findFirst({ where: { orgId, id: workId }, select: { id: true } })
      if (!def) return false
      const key = { workId_runId: { workId, runId: report.runId } } as const
      const existing = await tx.standingWorkRun.findUnique({ where: key })
      if (existing && isStaleRunReport(existing, report)) return false
      const stamp = {
        definitionVersion: report.definitionVersion,
        executionEpoch: report.executionEpoch,
        attempt: report.attempt,
        outcome: report.outcome,
        startedAt: new Date(report.startedAt),
        ...(report.finishedAt !== undefined ? { finishedAt: new Date(report.finishedAt) } : {}),
        ...(report.sessionId ? { sessionId: report.sessionId } : {}),
        errorCode: report.errorCode ?? null,
        ...(report.suggestedNextCheckAt !== undefined
          ? { suggestedNextCheckAt: new Date(report.suggestedNextCheckAt) }
          : {}),
        wakeSource: report.wakeSource ?? 'scheduled'
      }
      await tx.standingWorkRun.upsert({
        where: key,
        create: { orgId, workId, runId: report.runId, ...stamp },
        update: stamp
      })
      if (!report.notification) return true
      const noteKey = {
        runId_notificationIndex: { runId: report.runId, notificationIndex: report.notification.index }
      } as const
      const existingNote = await tx.standingWorkNotification.findUnique({ where: noteKey })
      if (
        existingNote &&
        SETTLED_DELIVERY.has(existingNote.status) &&
        !SETTLED_DELIVERY.has(report.notification.status)
      )
        return true
      const delivery = {
        effectId: report.notification.effectId,
        status: report.notification.status,
        ...(report.notification.receipt !== undefined ? { providerReceipt: report.notification.receipt } : {}),
        error: report.notification.error ?? null
      }
      await tx.standingWorkNotification.upsert({
        where: noteKey,
        create: { orgId, workId, runId: report.runId, notificationIndex: report.notification.index, ...delivery },
        update: delivery
      })
      // A `complete` outcome is terminal on the daemon — propagate to the def row so the
      // console reads `completed` without inferring it from run data. Idempotent: the WHERE
      // only fires on `active`/`paused`, so a second report or an already-expired def is a no-op.
      if (report.outcome === 'complete') {
        await tx.standingWorkDef.updateMany({
          where: { id: workId, state: { in: ['active', 'paused'] } },
          data: { state: 'completed' }
        })
      }
      return true
    })
  }

  async listRuns(
    orgId: string,
    workId: string,
    limit = 50,
    before?: StandingWorkRunCursor
  ): Promise<StandingWorkRunRecord[]> {
    // Run rows carry their own `orgId`, so the fence rides this query and not just the parent's
    // (org-scoped-data-layer.md §3.6). Newest first: the console polls the head of the timeline.
    const rows = await this.db.standingWorkRun.findMany({
      where: {
        orgId,
        workId,
        ...(before
          ? {
              OR: [
                { startedAt: { lt: before.startedAt } },
                { startedAt: before.startedAt, runId: { lt: before.runId } }
              ]
            }
          : {})
      },
      orderBy: [{ startedAt: 'desc' }, { runId: 'desc' }],
      take: limit,
      include: { notifications: { orderBy: { notificationIndex: 'desc' } } }
    })
    return rows.map((row) => ({
      runId: row.runId,
      workId: row.workId,
      definitionVersion: row.definitionVersion,
      executionEpoch: row.executionEpoch,
      attempt: row.attempt,
      outcome: row.outcome as StandingWorkRunRecord['outcome'],
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      sessionId: row.sessionId,
      errorCode: row.errorCode,
      suggestedNextCheckAt: row.suggestedNextCheckAt,
      wakeSource: row.wakeSource as StandingWorkRunRecord['wakeSource'],
      notification: row.notifications[0]
        ? {
            notificationIndex: row.notifications[0].notificationIndex,
            effectId: row.notifications[0].effectId,
            status: row.notifications[0].status as StandingWorkNotificationRecord['status'],
            providerReceipt: row.notifications[0].providerReceipt,
            error: row.notifications[0].error
          }
        : null
    }))
  }

  async expireStandingWork(now: Date): Promise<number> {
    return withAmbientTx(this.db, async (tx) => {
      const eligible = await tx.standingWorkDef.findMany({
        where: { state: { in: ['active', 'paused'] }, expiresAt: { lte: now } },
        select: { id: true }
      })
      if (eligible.length === 0) return 0
      const workIds = eligible.map((r) => r.id)
      await tx.standingWorkDef.updateMany({
        where: { id: { in: workIds } },
        data: { state: 'expired', approvalState: 'pending', approvalVersion: null }
      })
      await tx.standingWorkNotification.updateMany({
        where: { workId: { in: workIds }, status: { in: ['pending', 'failed'] } },
        data: { status: 'suppressed' }
      })
      return eligible.length
    })
  }
}

/** Deliveries the daemon will not re-open: a send is delivered, provably lost, or suppressed. */
const SETTLED_DELIVERY: ReadonlySet<string> = new Set(['delivered', 'uncertain', 'suppressed'])

/** True when a stored run row is ahead of an incoming report on the definition, epoch, or attempt fence. */
function isStaleRunReport(
  stored: { definitionVersion: number; executionEpoch: number; attempt: number },
  report: StandingWorkRunReport
): boolean {
  if (stored.definitionVersion !== report.definitionVersion) return stored.definitionVersion > report.definitionVersion
  if (stored.executionEpoch !== report.executionEpoch) return stored.executionEpoch > report.executionEpoch
  return stored.attempt > report.attempt
}
