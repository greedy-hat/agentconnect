-- A1 Unified Audit — Phase 1: causal envelope on audit_event
-- improvement-roadmap §6. Purely additive: no backfill, no data mutation, so
-- it is reversible by dropping the new columns/indexes.

-- CreateEnum: AuditSource
CREATE TYPE "AuditSource" AS ENUM ('cp', 'daemon');

-- Causal envelope columns (quoted camelCase: Prisma stores these exact-case).
ALTER TABLE "audit_event" ADD COLUMN "eventId" TEXT;
ALTER TABLE "audit_event" ADD COLUMN "traceId" TEXT;
ALTER TABLE "audit_event" ADD COLUMN "parentEventId" TEXT;
ALTER TABLE "audit_event" ADD COLUMN "effectId" TEXT;
ALTER TABLE "audit_event" ADD COLUMN "principalId" UUID;
ALTER TABLE "audit_event" ADD COLUMN "source" "AuditSource" NOT NULL DEFAULT 'cp';
ALTER TABLE "audit_event" ADD COLUMN "occurredAt" TIMESTAMPTZ(6);

-- Idempotent ingestion key for daemon outbox flushes (NULL allowed: CP-native
-- rows carry none, and Postgres unique indexes permit multiple NULLs).
CREATE UNIQUE INDEX "audit_event_eventId_key" ON "audit_event"("eventId");

-- Search indexes for the audit query/export surface.
CREATE INDEX "audit_event_orgId_kind_createdAt_idx" ON "audit_event"("orgId", "kind", "createdAt");
CREATE INDEX "audit_event_orgId_occurredAt_idx" ON "audit_event"("orgId", "occurredAt");
CREATE INDEX "audit_event_traceId_idx" ON "audit_event"("traceId");
CREATE INDEX "audit_event_effectId_idx" ON "audit_event"("effectId");
CREATE INDEX "audit_event_principalId_idx" ON "audit_event"("principalId");
