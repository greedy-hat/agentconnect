-- Add wakeOnConversation field to standing_work_def
ALTER TABLE "standing_work_def" ADD COLUMN "wakeOnConversation" BOOLEAN NOT NULL DEFAULT false;
