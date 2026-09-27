-- Standing Work definitions are CP-owned; execution rows remain on the daemon data plane.
CREATE TABLE "standing_work_def" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "principalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "definitionVersion" INTEGER NOT NULL DEFAULT 1,
    "schedule" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "startAt" TIMESTAMPTZ(6) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "minIntervalSeconds" INTEGER NOT NULL,
    "maxRunsPerDay" INTEGER NOT NULL,
    "maxNotificationsPerDay" INTEGER NOT NULL,
    "conversationRef" JSONB,
    "targetDestination" JSONB NOT NULL,
    "budgetPolicyRef" TEXT NOT NULL,
    "toolPolicyRef" TEXT NOT NULL,
    "notificationPolicy" JSONB NOT NULL,
    "visibilityPolicyRef" TEXT NOT NULL,
    "sourceSessionId" TEXT,
    "createdByActorId" TEXT NOT NULL,
    "lastModifiedByActorId" TEXT NOT NULL,
    "authorizationRevision" INTEGER NOT NULL,
    "approvalState" TEXT NOT NULL DEFAULT 'pending',
    "approvalVersion" INTEGER,
    "approvedByActorId" TEXT,
    "createIdempotencyKey" TEXT NOT NULL,
    "createRequestHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "standing_work_def_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "standing_work_def_lifecycle_check" CHECK ("state" IN ('active', 'paused', 'completed', 'expired', 'cancelled')),
    CONSTRAINT "standing_work_def_approval_check" CHECK ("approvalState" IN ('pending', 'approved', 'denied')),
    CONSTRAINT "standing_work_def_limits_check" CHECK ("minIntervalSeconds" >= 60 AND "maxRunsPerDay" > 0 AND "maxNotificationsPerDay" >= 0 AND "expiresAt" > "startAt")
);

CREATE UNIQUE INDEX "standing_work_def_orgId_createIdempotencyKey_key" ON "standing_work_def"("orgId", "createIdempotencyKey");
CREATE INDEX "standing_work_def_orgId_agentId_state_idx" ON "standing_work_def"("orgId", "agentId", "state");
ALTER TABLE "standing_work_def" ADD CONSTRAINT "standing_work_def_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "standing_work_def" ADD CONSTRAINT "standing_work_def_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
