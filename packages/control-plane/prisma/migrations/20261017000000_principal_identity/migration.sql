-- I1: Agent Identity v1 — org-owned execution principals
-- improvement-roadmap §5

-- Extend AuditKind enum with principal lifecycle events
ALTER TYPE "AuditKind" ADD VALUE 'principal_create';
ALTER TYPE "AuditKind" ADD VALUE 'principal_disable';
ALTER TYPE "AuditKind" ADD VALUE 'principal_enable';
ALTER TYPE "AuditKind" ADD VALUE 'principal_grant_create';
ALTER TYPE "AuditKind" ADD VALUE 'principal_grant_revoke';

-- CreateEnum: PrincipalKind
CREATE TYPE "PrincipalKind" AS ENUM ('agent', 'service', 'delegated');

-- CreateEnum: PrincipalState
CREATE TYPE "PrincipalState" AS ENUM ('active', 'disabled');

-- CreateEnum: PrincipalGrantResourceType
CREATE TYPE "PrincipalGrantResourceType" AS ENUM ('repo', 'destination', 'tool');

-- CreateEnum: PrincipalGrantCapability
CREATE TYPE "PrincipalGrantCapability" AS ENUM ('read', 'comment', 'write', 'execute', 'notify');

-- CreateTable: principal
CREATE TABLE "principal" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PrincipalKind" NOT NULL,
    "agentId" UUID,
    "state" "PrincipalState" NOT NULL DEFAULT 'active',
    "disabledAt" TIMESTAMPTZ(6),
    "disabledBy" TEXT,
    "authorizationRevision" INTEGER NOT NULL DEFAULT 1,
    "createdByActorId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "principal_pkey" PRIMARY KEY ("id")
);

-- CreateTable: principal_grant
CREATE TABLE "principal_grant" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "principalId" UUID NOT NULL,
    "resourceType" "PrincipalGrantResourceType" NOT NULL,
    "resourceId" TEXT NOT NULL,
    "capability" "PrincipalGrantCapability" NOT NULL,
    "expiresAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "revokedBy" TEXT,
    "createdByActorId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "principal_grant_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey: principal → org
ALTER TABLE "principal" ADD CONSTRAINT "principal_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: principal → agent (optional)
ALTER TABLE "principal" ADD CONSTRAINT "principal_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: principal_grant → principal
ALTER TABLE "principal_grant" ADD CONSTRAINT "principal_grant_principalId_fkey"
    FOREIGN KEY ("principalId") REFERENCES "principal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Unique: principal name per org
CREATE UNIQUE INDEX "principal_orgId_name_key" ON "principal"("orgId", "name");

-- Index: principal lookup by org
CREATE INDEX "principal_orgId_idx" ON "principal"("orgId");

-- Index: principal lookup by org + state (for admission checks)
CREATE INDEX "principal_orgId_state_idx" ON "principal"("orgId", "state");

-- Unique: one grant per (org, principal, resource, capability)
CREATE UNIQUE INDEX "principal_grant_orgId_principalId_resourceType_resourceId_cap_key"
    ON "principal_grant"("orgId", "principalId", "resourceType", "resourceId", "capability");

-- Index: grant lookup by org + principal
CREATE INDEX "principal_grant_orgId_principalId_idx" ON "principal_grant"("orgId", "principalId");

-- Index: grant lookup by principal + resource type
CREATE INDEX "principal_grant_principalId_resourceType_idx" ON "principal_grant"("principalId", "resourceType");
