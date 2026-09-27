import type { Principal, PrincipalGrant } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import { withAmbientTx } from '../prisma.js'
import type {
  PrincipalRecord,
  PrincipalGrantRecord,
  PrincipalRepo,
  CreatePrincipalInput,
  CreatePrincipalGrantInput,
  PrincipalKind,
  PrincipalState,
  PrincipalGrantResourceType,
  PrincipalGrantCapability
} from '../ports.js'
import { OrgId, AgentId } from '../../domain/ids.js'
import { randomUUID } from 'node:crypto'

function toPrincipalRecord(r: Principal): PrincipalRecord {
  return {
    id: r.id,
    orgId: OrgId(r.orgId),
    name: r.name,
    kind: r.kind as PrincipalKind,
    agentId: r.agentId ? AgentId(r.agentId) : null,
    state: r.state as PrincipalState,
    disabledAt: r.disabledAt,
    disabledBy: r.disabledBy,
    authorizationRevision: r.authorizationRevision,
    createdByActorId: r.createdByActorId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
}

function toGrantRecord(r: PrincipalGrant): PrincipalGrantRecord {
  return {
    id: r.id,
    orgId: OrgId(r.orgId),
    principalId: r.principalId,
    resourceType: r.resourceType as PrincipalGrantResourceType,
    resourceId: r.resourceId,
    capability: r.capability as PrincipalGrantCapability,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    revokedBy: r.revokedBy,
    createdByActorId: r.createdByActorId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
}

export class PgPrincipalRepo implements PrincipalRepo {
  constructor(private readonly db: PrismaLike) {}

  async create(input: CreatePrincipalInput): Promise<PrincipalRecord> {
    const row = await this.db.principal.create({
      data: {
        id: randomUUID(),
        orgId: input.orgId,
        name: input.name,
        kind: input.kind,
        agentId: input.agentId ?? null,
        createdByActorId: input.createdByActorId
      }
    })
    return toPrincipalRecord(row)
  }

  async get(orgId: OrgId, id: string): Promise<PrincipalRecord | null> {
    const row = await this.db.principal.findUnique({ where: { id } })
    if (!row || row.orgId !== orgId) return null
    return toPrincipalRecord(row)
  }

  async getByName(orgId: OrgId, name: string): Promise<PrincipalRecord | null> {
    const row = await this.db.principal.findUnique({ where: { orgId_name: { orgId, name } } })
    if (!row) return null
    return toPrincipalRecord(row)
  }

  async listForOrg(orgId: OrgId): Promise<PrincipalRecord[]> {
    const rows = await this.db.principal.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' }
    })
    return rows.map(toPrincipalRecord)
  }

  async disable(orgId: OrgId, id: string, actorId: string): Promise<PrincipalRecord | null> {
    return withAmbientTx(this.db, async (tx) => {
      const existing = await tx.principal.findUnique({ where: { id } })
      if (!existing || existing.orgId !== orgId) return null
      if (existing.state === 'disabled') return toPrincipalRecord(existing)
      const row = await tx.principal.update({
        where: { id },
        data: {
          state: 'disabled',
          disabledAt: new Date(),
          disabledBy: actorId,
          authorizationRevision: { increment: 1 }
        }
      })
      return toPrincipalRecord(row)
    })
  }

  async enable(orgId: OrgId, id: string, actorId: string): Promise<PrincipalRecord | null> {
    return withAmbientTx(this.db, async (tx) => {
      const existing = await tx.principal.findUnique({ where: { id } })
      if (!existing || existing.orgId !== orgId) return null
      if (existing.state === 'active') return toPrincipalRecord(existing)
      const row = await tx.principal.update({
        where: { id },
        data: {
          state: 'active',
          disabledAt: null,
          disabledBy: null,
          authorizationRevision: { increment: 1 }
        }
      })
      return toPrincipalRecord(row)
    })
  }

  async createGrant(input: CreatePrincipalGrantInput): Promise<PrincipalGrantRecord> {
    const row = await this.db.principalGrant.create({
      data: {
        orgId: input.orgId,
        principalId: input.principalId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        capability: input.capability,
        expiresAt: input.expiresAt ?? null,
        createdByActorId: input.createdByActorId
      }
    })
    return toGrantRecord(row)
  }

  async revokeGrant(orgId: OrgId, grantId: string, actorId: string): Promise<PrincipalGrantRecord | null> {
    const existing = await this.db.principalGrant.findUnique({ where: { id: grantId } })
    if (!existing || existing.orgId !== orgId) return null
    if (existing.revokedAt) return toGrantRecord(existing)
    const row = await this.db.principalGrant.update({
      where: { id: grantId },
      data: {
        revokedAt: new Date(),
        revokedBy: actorId
      }
    })
    return toGrantRecord(row)
  }

  async listGrantsForPrincipal(orgId: OrgId, principalId: string): Promise<PrincipalGrantRecord[]> {
    const rows = await this.db.principalGrant.findMany({
      where: { orgId, principalId },
      orderBy: { createdAt: 'desc' }
    })
    return rows.map(toGrantRecord)
  }

  async getActiveGrant(
    orgId: OrgId,
    principalId: string,
    resourceType: PrincipalGrantResourceType,
    resourceId: string,
    capability: PrincipalGrantCapability,
    now: Date
  ): Promise<PrincipalGrantRecord | null> {
    const row = await this.db.principalGrant.findFirst({
      where: {
        orgId,
        principalId,
        resourceType,
        resourceId,
        capability,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
      }
    })
    return row ? toGrantRecord(row) : null
  }
}
