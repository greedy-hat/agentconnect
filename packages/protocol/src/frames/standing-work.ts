import { z } from 'zod'

/** CP→daemon lifecycle command. Definition creation/edit is admitted by the CP API; daemons only apply fenced lifecycle decisions. */
export const StandingWorkControl = z
  .object({
    authority: z
      .object({
        actorId: z.string().min(1),
        canManage: z.boolean(),
        canApprove: z.boolean(),
        authorizationRevision: z.number().int().nonnegative()
      })
      .passthrough(),
    action: z.enum(['approve', 'pause', 'resume', 'cancel']),
    orgId: z.string().min(1),
    workId: z.string().min(1),
    version: z.number().int().positive()
  })
  .strict()
export type StandingWorkControl = z.infer<typeof StandingWorkControl>

/** Complete CP-owned definition projected to an eligible daemon. scheduleMode='adaptive' lets the
 *  model suggest nextCheckAt in its report; 'fixed' (default) uses the cron schedule alone. */
export const StandingWorkProjection = z
  .object({
    orgId: z.string().min(1),
    workId: z.uuid(),
    agentId: z.uuid(),
    principalId: z.string().min(1),
    createdByActorId: z.string().min(1),
    lastModifiedByActorId: z.string().min(1),
    name: z.string().min(1),
    objective: z.string().min(1),
    state: z.enum(['active', 'paused', 'completed', 'expired', 'cancelled']),
    definitionVersion: z.number().int().positive(),
    schedule: z.string().min(1),
    timezone: z.string().min(1),
    startAt: z.number().int(),
    expiresAt: z.number().int(),
    scheduleMode: z.enum(['fixed', 'adaptive']).default('fixed'),
    minIntervalSeconds: z.number().int().min(60),
    maxIntervalSeconds: z.number().int().min(60).max(2_592_000).default(86_400),
    wakeOnConversation: z.boolean().default(false),
    maxRunsPerDay: z.number().int().positive(),
    maxNotificationsPerDay: z.number().int().nonnegative(),
    conversationRef: z
      .object({ platform: z.string(), integrationId: z.uuid(), channel: z.string(), thread: z.string().optional() })
      .nullable(),
    targetDestination: z.object({
      platform: z.string(),
      integrationId: z.uuid(),
      channel: z.string(),
      thread: z.string().optional()
    }),
    budgetPolicyRef: z.string().min(1),
    toolPolicyRef: z.string().min(1),
    notificationPolicy: z.object({ mode: z.enum(['changes', 'all']), includeCompletion: z.boolean() }),
    visibilityPolicyRef: z.string().min(1),
    sourceSessionId: z.string().nullable(),
    approvalState: z.enum(['pending', 'approved', 'denied']),
    approvalVersion: z.number().int().positive().nullable(),
    authorizationRevision: z.number().int().nonnegative(),
    createdAt: z.number().int(),
    updatedAt: z.number().int()
  })
  .strict()
export type StandingWorkProjection = z.infer<typeof StandingWorkProjection>

/**
 * Notification delivery as the daemon's outbox last knew it. `uncertain` means a provider may have
 * accepted the post without the daemon being able to prove it — it is never folded into delivered/failed,
 * and `pending`/`sending` let a committed `notify` run report its outcome before delivery settles.
 * Status/receipt/error-code only: the notification body stays in the daemon.
 */
export const StandingWorkNotificationReport = z
  .object({
    index: z.number().int().nonnegative(),
    effectId: z.string().min(1),
    status: z.enum(['pending', 'sending', 'delivered', 'uncertain', 'failed', 'suppressed']),
    receipt: z.string().max(256).optional(),
    error: z.string().max(512).optional()
  })
  .strict()
export type StandingWorkNotificationReport = z.infer<typeof StandingWorkNotificationReport>

/**
 * `standing-work/report` (D→C EVT, fire-and-forget) — one ambient run reached a state the console
 * should see, mirroring `cron/report`: the daemon stamps its local run row first and stays
 * authoritative, so the CP write is latest-wins and a dropped report is a delay, never a loss.
 *
 * Emitted when a run commits, again when its notification settles, and on a turn error (which leaves
 * the occurrence running for a fenced retry, so the attempt becomes observable here). The CP fences on
 * `definitionVersion` + `executionEpoch`, so a stale executor's report drops silently instead of
 * overwriting a newer truth; `attempt` breaks ties within one occurrence. Duration is derived from the
 * two stamps rather than carried as a third, redundant fact.
 *
 * `orgId` deliberately is NOT a payload field — the organization rides the frame envelope, resolved
 * from `agentId`, so a daemon cannot report into an org it does not serve. Timestamps are epoch
 * milliseconds, matching the sibling fixed-schedule frames.
 */
export const StandingWorkRunReport = z
  .object({
    workId: z.string().uuid(),
    agentId: z.string().uuid(),
    runId: z.string().uuid(),
    definitionVersion: z.number().int().positive(),
    executionEpoch: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    outcome: z.enum(['no_change', 'notify', 'blocked', 'complete', 'failed']),
    startedAt: z.number().int().nonnegative(),
    finishedAt: z.number().int().nonnegative().optional(),
    sessionId: z.string().min(1).optional(),
    errorCode: z.string().max(64).optional(),
    notification: StandingWorkNotificationReport.optional(),
    suggestedNextCheckAt: z.number().int().nonnegative().optional(),
    wakeSource: z.enum(['scheduled', 'conversation']).default('scheduled')
  })
  .strict()
export type StandingWorkRunReport = z.infer<typeof StandingWorkRunReport>
