import type { StandingWorkProjection } from '@agentconnect.md/protocol'
import type { StandingWorkRecord } from './contracts.js'

export function standingWorkProjection(row: StandingWorkRecord): StandingWorkProjection {
  return {
    orgId: row.orgId,
    workId: row.id,
    agentId: row.agentId,
    principalId: row.principalId,
    createdByActorId: row.createdByActorId,
    lastModifiedByActorId: row.lastModifiedByActorId,
    name: row.name,
    objective: row.objective,
    state: row.state,
    definitionVersion: row.definitionVersion,
    schedule: row.schedule,
    timezone: row.timezone,
    startAt: row.startAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
    scheduleMode: row.scheduleMode,
    minIntervalSeconds: row.minIntervalSeconds,
    maxIntervalSeconds: row.maxIntervalSeconds,
    wakeOnConversation: row.wakeOnConversation,
    maxRunsPerDay: row.maxRunsPerDay,
    maxNotificationsPerDay: row.maxNotificationsPerDay,
    conversationRef: row.conversationRef,
    targetDestination: row.targetDestination,
    budgetPolicyRef: row.budgetPolicyRef,
    toolPolicyRef: row.toolPolicyRef,
    notificationPolicy: row.notificationPolicy,
    visibilityPolicyRef: row.visibilityPolicyRef,
    sourceSessionId: row.sourceSessionId,
    approvalState: row.approvalState,
    approvalVersion: row.approvalVersion,
    authorizationRevision: row.authorizationRevision,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime()
  }
}
