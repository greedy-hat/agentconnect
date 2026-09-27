-- Standing Work run history: the daemon executes and stays authoritative, and ships each run over
-- `standing-work/report` so an operator can inspect and stop durable work. Notification delivery is its
-- own row because an `uncertain` send must never be folded into the run's outcome. Neither table stores
-- objective output or a notification body — outcome, timing, receipt and error code only.
CREATE TYPE "StandingWorkRunOutcome" AS ENUM ('no_change', 'notify', 'blocked', 'complete', 'failed');
CREATE TYPE "StandingWorkNotificationStatus" AS ENUM ('pending', 'sending', 'delivered', 'uncertain', 'failed', 'suppressed');

CREATE TABLE "standing_work_run" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "definitionVersion" INTEGER NOT NULL,
    "executionEpoch" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "outcome" "StandingWorkRunOutcome" NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "finishedAt" TIMESTAMPTZ(6),
    "sessionId" TEXT,
    "errorCode" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "standing_work_run_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "standing_work_run_fence_check" CHECK ("definitionVersion" > 0 AND "executionEpoch" >= 0 AND "attempt" > 0),
    CONSTRAINT "standing_work_run_span_check" CHECK ("finishedAt" IS NULL OR "finishedAt" >= "startedAt")
);

CREATE UNIQUE INDEX "standing_work_run_workId_runId_key" ON "standing_work_run"("workId", "runId");
CREATE INDEX "standing_work_run_orgId_workId_startedAt_idx" ON "standing_work_run"("orgId", "workId", "startedAt" DESC);
ALTER TABLE "standing_work_run" ADD CONSTRAINT "standing_work_run_workId_fkey" FOREIGN KEY ("workId") REFERENCES "standing_work_def"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "standing_work_notification" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "workId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "notificationIndex" INTEGER NOT NULL,
    "effectId" TEXT NOT NULL,
    "status" "StandingWorkNotificationStatus" NOT NULL,
    "providerReceipt" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "standing_work_notification_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "standing_work_notification_index_check" CHECK ("notificationIndex" >= 0)
);

CREATE UNIQUE INDEX "standing_work_notification_runId_notificationIndex_key" ON "standing_work_notification"("runId", "notificationIndex");
CREATE INDEX "standing_work_notification_orgId_workId_idx" ON "standing_work_notification"("orgId", "workId");
ALTER TABLE "standing_work_notification" ADD CONSTRAINT "standing_work_notification_run_fkey" FOREIGN KEY ("workId", "runId") REFERENCES "standing_work_run"("workId", "runId") ON DELETE CASCADE ON UPDATE CASCADE;
