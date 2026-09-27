-- A1 Unified Audit — Phase 5: the daemon execution-trail kinds.
-- Purely additive enum labels; no backfill and no data mutation. Postgres forbids
-- using a value added in the same transaction, and nothing here does.

ALTER TYPE "AuditKind" ADD VALUE IF NOT EXISTS 'admission';
ALTER TYPE "AuditKind" ADD VALUE IF NOT EXISTS 'admission_denied';
ALTER TYPE "AuditKind" ADD VALUE IF NOT EXISTS 'tool_intent';
ALTER TYPE "AuditKind" ADD VALUE IF NOT EXISTS 'tool_result';
ALTER TYPE "AuditKind" ADD VALUE IF NOT EXISTS 'budget_reserved';
ALTER TYPE "AuditKind" ADD VALUE IF NOT EXISTS 'budget_settled';
ALTER TYPE "AuditKind" ADD VALUE IF NOT EXISTS 'external_effect';
