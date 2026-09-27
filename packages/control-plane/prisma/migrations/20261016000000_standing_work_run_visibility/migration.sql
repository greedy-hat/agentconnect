-- CreateEnum
CREATE TYPE "StandingWorkWakeSource" AS ENUM ('scheduled', 'conversation');

-- AlterTable
ALTER TABLE "standing_work_run" ADD COLUMN "suggestedNextCheckAt" TIMESTAMPTZ(6);
ALTER TABLE "standing_work_run" ADD COLUMN "wakeSource" "StandingWorkWakeSource" NOT NULL DEFAULT 'scheduled';
