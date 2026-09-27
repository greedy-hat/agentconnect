import type { StandingWorkRunReport } from '@agentconnect.md/protocol'

export interface StandingWorkDestination {
  platform: string
  integrationId: string
  channel: string
  thread?: string
}

export interface StandingWorkConversationRef {
  platform: string
  integrationId: string
  channel: string
  thread?: string
}

export interface FixedStandingWorkInput {
  agentId: string
  principalId: string
  name: string
  objective: string
  schedule: string
  timezone: string
  startAt: Date
  expiresAt: Date
  scheduleMode: 'fixed' | 'adaptive'
  minIntervalSeconds: number
  maxIntervalSeconds: number
  wakeOnConversation: boolean
  maxRunsPerDay: number
  maxNotificationsPerDay: number
  conversationRef: StandingWorkConversationRef | null
  targetDestination: StandingWorkDestination
  budgetPolicyRef: string
  toolPolicyRef: string
  notificationPolicy: { mode: 'changes' | 'all'; includeCompletion: boolean }
  visibilityPolicyRef: string
  sourceSessionId: string | null
}

export interface StandingWorkRecord extends FixedStandingWorkInput {
  id: string
  orgId: string
  state: 'active' | 'paused' | 'completed' | 'expired' | 'cancelled'
  definitionVersion: number
  createdByActorId: string
  lastModifiedByActorId: string
  authorizationRevision: number
  approvalState: 'pending' | 'approved' | 'denied'
  approvalVersion: number | null
  approvedByActorId: string | null
  createIdempotencyKey: string
  createRequestHash: string
  createdAt: Date
  updatedAt: Date
}

export interface StandingWorkDefinitionRepo {
  create(
    input: FixedStandingWorkInput & {
      orgId: string
      actorId: string
      authorizationRevision: number
      idempotencyKey: string
      requestHash: string
    }
  ): Promise<{ record: StandingWorkRecord; duplicate: boolean } | 'conflict'>
  get(orgId: string, id: string): Promise<StandingWorkRecord | null>
  list(orgId: string, limit: number): Promise<StandingWorkRecord[]>
  listForAgents(agentIds: readonly string[]): Promise<StandingWorkRecord[]>
  replace(input: {
    orgId: string
    id: string
    expectedVersion: number
    actorId: string
    authorizationRevision: number
    definition: FixedStandingWorkInput
  }): Promise<StandingWorkRecord | null>
  transition(input: {
    orgId: string
    id: string
    expectedVersion: number
    actorId: string
    state: StandingWorkRecord['state']
  }): Promise<StandingWorkRecord | null>
  approve(input: {
    orgId: string
    id: string
    expectedVersion: number
    actorId: string
  }): Promise<StandingWorkRecord | null>
}

/** A run's delivery outcome, projected from the daemon's outbox. Never carries the notification body. */
export interface StandingWorkNotificationRecord {
  notificationIndex: number
  effectId: string
  status: 'pending' | 'sending' | 'delivered' | 'uncertain' | 'failed' | 'suppressed'
  providerReceipt: string | null
  error: string | null
}

/** One ambient run as the executing daemon reported it. `notification` is a separate fact from
 *  `outcome`: a committed `notify` run can still have an unsettled or uncertain delivery. */
export interface StandingWorkRunRecord {
  runId: string
  workId: string
  definitionVersion: number
  executionEpoch: number
  attempt: number
  outcome: 'no_change' | 'notify' | 'blocked' | 'complete' | 'failed'
  startedAt: Date
  finishedAt: Date | null
  sessionId: string | null
  errorCode: string | null
  suggestedNextCheckAt: Date | null
  wakeSource: 'scheduled' | 'conversation'
  notification: StandingWorkNotificationRecord | null
}

/** Exclusive cursor for the newest-first run timeline. */
export interface StandingWorkRunCursor {
  startedAt: Date
  runId: string
}

/** The daemon's `standing-work/report` projection. The daemon stays authoritative on its data plane;
 *  these rows exist so an operator can inspect and stop durable work from the console. */
export interface StandingWorkRunRepo {
  /** Fence and apply one report. `false` means it was dropped — an unknown/out-of-org work, or a
   *  version, epoch or attempt behind what is already stored. Never throws for a stale report. */
  recordReport(orgId: string, workId: string, report: StandingWorkRunReport): Promise<boolean>
  listRuns(
    orgId: string,
    workId: string,
    limit?: number,
    before?: StandingWorkRunCursor
  ): Promise<StandingWorkRunRecord[]>
}

export interface StandingWorkExpiryRepo {
  /** Transition `active`/`paused` defs past their `expiresAt` to `expired`, suppressing their
   *  pending CP-side notifications. Returns the count of defs reaped. */
  expireStandingWork(now: Date): Promise<number>
}

export type StandingWorkRepo = StandingWorkDefinitionRepo & StandingWorkRunRepo & StandingWorkExpiryRepo
