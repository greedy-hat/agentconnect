import type { Clock } from '../domain/clock.js'
import type {
  AuditRepo,
  PrincipalGrantCapability,
  PrincipalGrantRecord,
  PrincipalGrantResourceType,
  PrincipalKind,
  PrincipalRecord,
  PrincipalRepo
} from '../persistence/ports.js'
import type { OrgId, AgentId } from '../domain/ids.js'

export class PrincipalService {
  constructor(
    private readonly repo: PrincipalRepo,
    private readonly audit: AuditRepo,
    private readonly clock: Clock
  ) {}

  async create(
    orgId: OrgId,
    name: string,
    kind: PrincipalKind,
    agentId: AgentId | undefined,
    actorId: string
  ): Promise<PrincipalRecord> {
    const existing = await this.repo.getByName(orgId, name)
    if (existing) throw new PrincipalNameConflict(name)
    const rec = await this.repo.create({ orgId, name, kind, agentId, createdByActorId: actorId })
    void this.audit
      .append({
        kind: 'principal_create',
        orgId,
        actorUserId: actorId,
        details: { principalId: rec.id, name: rec.name, kind: rec.kind }
      })
      .catch(() => {})
    return rec
  }

  async get(orgId: OrgId, id: string): Promise<PrincipalRecord | null> {
    return this.repo.get(orgId, id)
  }

  async list(orgId: OrgId): Promise<PrincipalRecord[]> {
    return this.repo.listForOrg(orgId)
  }

  async disable(orgId: OrgId, id: string, actorId: string): Promise<PrincipalRecord | null> {
    const rec = await this.repo.disable(orgId, id, actorId)
    if (rec) {
      void this.audit
        .append({
          kind: 'principal_disable',
          orgId,
          actorUserId: actorId,
          details: { principalId: rec.id, name: rec.name, authorizationRevision: rec.authorizationRevision }
        })
        .catch(() => {})
    }
    return rec
  }

  async enable(orgId: OrgId, id: string, actorId: string): Promise<PrincipalRecord | null> {
    const rec = await this.repo.enable(orgId, id, actorId)
    if (rec) {
      void this.audit
        .append({
          kind: 'principal_enable',
          orgId,
          actorUserId: actorId,
          details: { principalId: rec.id, name: rec.name, authorizationRevision: rec.authorizationRevision }
        })
        .catch(() => {})
    }
    return rec
  }

  async createGrant(
    orgId: OrgId,
    principalId: string,
    resourceType: PrincipalGrantResourceType,
    resourceId: string,
    capability: PrincipalGrantCapability,
    expiresAt: Date | undefined,
    actorId: string
  ): Promise<PrincipalGrantRecord> {
    const principal = await this.repo.get(orgId, principalId)
    if (!principal) throw new PrincipalNotFound(principalId)
    if (principal.state === 'disabled') throw new PrincipalDisabled(principalId)
    const grant = await this.repo.createGrant({
      orgId,
      principalId,
      resourceType,
      resourceId,
      capability,
      expiresAt,
      createdByActorId: actorId
    })
    void this.audit
      .append({
        kind: 'principal_grant_create',
        orgId,
        actorUserId: actorId,
        details: { principalId, grantId: grant.id, resourceType, resourceId, capability }
      })
      .catch(() => {})
    return grant
  }

  async revokeGrant(orgId: OrgId, grantId: string, actorId: string): Promise<PrincipalGrantRecord | null> {
    const rec = await this.repo.revokeGrant(orgId, grantId, actorId)
    if (rec) {
      void this.audit
        .append({
          kind: 'principal_grant_revoke',
          orgId,
          actorUserId: actorId,
          details: { grantId: rec.id, principalId: rec.principalId }
        })
        .catch(() => {})
    }
    return rec
  }

  async listGrants(orgId: OrgId, principalId: string): Promise<PrincipalGrantRecord[]> {
    return this.repo.listGrantsForPrincipal(orgId, principalId)
  }

  async checkGrant(
    orgId: OrgId,
    principalId: string,
    resourceType: PrincipalGrantResourceType,
    resourceId: string,
    capability: PrincipalGrantCapability
  ): Promise<boolean> {
    const principal = await this.repo.get(orgId, principalId)
    if (!principal || principal.state !== 'active') return false
    const grant = await this.repo.getActiveGrant(
      orgId,
      principalId,
      resourceType,
      resourceId,
      capability,
      new Date(this.clock.now())
    )
    return grant !== null
  }
}

export class PrincipalNameConflict extends Error {
  constructor(name: string) {
    super(`Principal name already taken: ${name}`)
  }
}

export class PrincipalNotFound extends Error {
  constructor(id: string) {
    super(`Principal not found: ${id}`)
  }
}

export class PrincipalDisabled extends Error {
  constructor(id: string) {
    super(`Principal is disabled: ${id}`)
  }
}
