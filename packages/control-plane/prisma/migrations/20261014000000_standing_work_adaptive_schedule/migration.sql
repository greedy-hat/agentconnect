-- W7: adaptive scheduling adds scheduleMode and maxIntervalSeconds to standing_work_def.
ALTER TABLE "standing_work_def" ADD COLUMN "scheduleMode" TEXT NOT NULL DEFAULT 'fixed';
ALTER TABLE "standing_work_def" ADD COLUMN "maxIntervalSeconds" INTEGER NOT NULL DEFAULT 86400;

ALTER TABLE "standing_work_def" DROP CONSTRAINT "standing_work_def_limits_check";
ALTER TABLE "standing_work_def" ADD CONSTRAINT "standing_work_def_limits_check" CHECK (
  "minIntervalSeconds" >= 60
  AND "maxIntervalSeconds" >= 60
  AND "maxRunsPerDay" > 0
  AND "maxNotificationsPerDay" >= 0
  AND "expiresAt" > "startAt"
  AND ("scheduleMode" = 'fixed' OR "maxIntervalSeconds" >= "minIntervalSeconds")
);
