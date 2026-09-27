/**
 * The Principal console REST surface (I1 Agent Identity v1): who may change what, and — the load
 * bearing promise — that a disable actually fences execution.
 *
 * The whole point of a named principal is the one control an operator can trust: disable it here,
 * and NOTHING may act through it any more, even a grant that is live, unexpired and un-revoked.
 * So these tests pin:
 *  - reads are org-scoped (a foreign / malformed id is 404 / 400, never a leak);
 *  - viewers keep reads and lose every write (403);
 *  - disable/enable bump the authorization revision (the fencing counter) and are idempotent —
 *    re-disabling an already-disabled principal does NOT advance the counter again;
 *  - a grant cannot be minted against a disabled principal (409) or a missing one (404);
 *  - revoke is soft (the row survives, marked), and re-revoking is idempotent;
 *  - `checkGrant` — the seam the executor hits — answers true for a live grant and FALSE the instant
 *    the principal is disabled, with no grant change at all. That asymmetry IS the fence.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgPrincipalRepo } from '../../src/persistence/repositories/principal.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { OrgId } from '../../src/domain/ids.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

function app(opts: { userId?: string } = {}): HttpApp {
  const built = buildHttpApp(prisma, opts.userId ? { DEFAULT_OWNER_ID: opts.userId } : undefined)
  opened.push(built)
  return built
}

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@principal.test`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

type PrincipalJson = {
  id: string
  name: string
  kind: string
  state: string
  authorizationRevision: number
}
type GrantJson = { id: string; principalId: string; capability: string; revokedAt: string | null }

async function createPrincipal(
  http: HttpApp,
  name = `nightly-${randomUUID().slice(0, 8)}d`,
  kind = 'service'
): Promise<PrincipalJson> {
  const res = await http.app.inject({ method: 'POST', url: `${ORG}/principals`, payload: { name, kind } })
  expect(res.statusCode).toBe(201)
  return res.json() as PrincipalJson
}

describe('Principal console routes', () => {
  it('creates a principal and reads it back scoped to the org', async () => {
    const http = app()
    const made = await createPrincipal(http, 'audit-bot', 'agent')

    const listed = await http.app.inject({ method: 'GET', url: `${ORG}/principals` })
    expect(listed.statusCode).toBe(200)
    expect((listed.json() as { principals: PrincipalJson[] }).principals).toMatchObject([
      { id: made.id, name: 'audit-bot', kind: 'agent', state: 'active', authorizationRevision: 1 }
    ])

    const one = await http.app.inject({ method: 'GET', url: `${ORG}/principals/${made.id}` })
    expect(one.statusCode).toBe(200)
    expect(one.json()).toMatchObject({ id: made.id, name: 'audit-bot', state: 'active' })

    // A random uuid is not this org's principal: 404, and a non-uuid is a rejected request.
    expect((await http.app.inject({ method: 'GET', url: `${ORG}/principals/${randomUUID()}` })).statusCode).toBe(404)
    expect((await http.app.inject({ method: 'GET', url: `${ORG}/principals/not-a-uuid` })).statusCode).toBe(400)
  })

  it('refuses a duplicate principal name within the org', async () => {
    const http = app()
    await createPrincipal(http, 'only-once')
    const dupe = await http.app.inject({
      method: 'POST',
      url: `${ORG}/principals`,
      payload: { name: 'only-once', kind: 'service' }
    })
    expect(dupe.statusCode).toBe(409)
  })

  it('keeps a viewer read-only across the whole surface', async () => {
    const owner = app()
    const made = await createPrincipal(owner, 'watcher')
    const grantId = (
      (await owner.app.inject({
        method: 'POST',
        url: `${ORG}/principals/${made.id}/grants`,
        payload: { resourceType: 'repo', resourceId: 'acme/api', capability: 'read' }
      })) as { json: () => GrantJson }
    ).json()

    const viewerId = await makeUser(`principal-viewer-${randomUUID()}`, 'viewer')
    const viewer = app({ userId: viewerId })
    expect((await viewer.app.inject({ method: 'GET', url: `${ORG}/principals` })).statusCode).toBe(200)
    expect((await viewer.app.inject({ method: 'GET', url: `${ORG}/principals/${made.id}/grants` })).statusCode).toBe(
      200
    )
    expect(
      (await viewer.app.inject({ method: 'POST', url: `${ORG}/principals`, payload: { name: 'x', kind: 'service' } }))
        .statusCode
    ).toBe(403)
    expect(
      (await viewer.app.inject({ method: 'POST', url: `${ORG}/principals/${made.id}/disable`, payload: {} })).statusCode
    ).toBe(403)
    expect(
      (
        await viewer.app.inject({
          method: 'POST',
          url: `${ORG}/principals/${made.id}/grants`,
          payload: { resourceType: 'repo', resourceId: 'acme/web', capability: 'write' }
        })
      ).statusCode
    ).toBe(403)
    expect(
      (
        await viewer.app.inject({
          method: 'POST',
          url: `${ORG}/principals/${made.id}/grants/${grantId.id}/revoke`,
          payload: {}
        })
      ).statusCode
    ).toBe(403)
    // The blocked writes left no trace: still one active principal, still one live grant.
    expect((await owner.app.inject({ method: 'GET', url: `${ORG}/principals/${made.id}` })).json()).toMatchObject({
      state: 'active'
    })
    const grants = (await owner.app.inject({ method: 'GET', url: `${ORG}/principals/${made.id}/grants` })).json() as {
      grants: GrantJson[]
    }
    expect(grants.grants).toHaveLength(1)
    expect(grants.grants[0]?.revokedAt).toBeNull()
  })

  it('bumps the authorization revision on disable/enable, and is idempotent on a repeat', async () => {
    const http = app()
    const made = await createPrincipal(http, 'fenced')
    expect(made.authorizationRevision).toBe(1)

    const disabled = await http.app.inject({ method: 'POST', url: `${ORG}/principals/${made.id}/disable`, payload: {} })
    expect(disabled.json()).toMatchObject({ state: 'disabled', authorizationRevision: 2 })
    // Disabling an already-disabled principal is a no-op read, NOT a second bump: a re-entrant call
    // must not silently advance the fence out from under a legitimate concurrent disable.
    const again = await http.app.inject({ method: 'POST', url: `${ORG}/principals/${made.id}/disable`, payload: {} })
    expect(again.json()).toMatchObject({ state: 'disabled', authorizationRevision: 2 })

    const reenabled = await http.app.inject({ method: 'POST', url: `${ORG}/principals/${made.id}/enable`, payload: {} })
    expect(reenabled.json()).toMatchObject({ state: 'active', authorizationRevision: 3 })
    expect(
      (await http.app.inject({ method: 'POST', url: `${ORG}/principals/${made.id}/enable`, payload: {} })).json()
    ).toMatchObject({
      state: 'active',
      authorizationRevision: 3
    })
  })

  it('mints grants against a live principal, and refuses a disabled or missing one', async () => {
    const http = app()
    const made = await createPrincipal(http, 'grant-target')

    const ok = await http.app.inject({
      method: 'POST',
      url: `${ORG}/principals/${made.id}/grants`,
      payload: { resourceType: 'tool', resourceId: 'git.push', capability: 'execute' }
    })
    expect(ok.statusCode).toBe(201)
    expect(ok.json()).toMatchObject({
      principalId: made.id,
      resourceType: 'tool',
      capability: 'execute',
      revokedAt: null
    })

    // Grant on a principal that does not exist is 404, and on a disabled one is 409 (not 404 — the
    // row is there, it is simply barred).
    expect(
      (
        await http.app.inject({
          method: 'POST',
          url: `${ORG}/principals/${randomUUID()}/grants`,
          payload: { resourceType: 'tool', resourceId: 'x', capability: 'read' }
        })
      ).statusCode
    ).toBe(404)

    await http.app.inject({ method: 'POST', url: `${ORG}/principals/${made.id}/disable`, payload: {} })
    expect(
      (
        await http.app.inject({
          method: 'POST',
          url: `${ORG}/principals/${made.id}/grants`,
          payload: { resourceType: 'repo', resourceId: 'acme/api', capability: 'write' }
        })
      ).statusCode
    ).toBe(409)
  })

  it('revokes a grant softly and idempotently', async () => {
    const http = app()
    const made = await createPrincipal(http, 'revoker')
    const grant = (
      await http.app.inject({
        method: 'POST',
        url: `${ORG}/principals/${made.id}/grants`,
        payload: { resourceType: 'destination', resourceId: 'slack:C123', capability: 'notify' }
      })
    ).json() as GrantJson

    const revoked = await http.app.inject({
      method: 'POST',
      url: `${ORG}/principals/${made.id}/grants/${grant.id}/revoke`,
      payload: {}
    })
    expect(revoked.statusCode).toBe(200)
    expect(revoked.json()).toMatchObject({ id: grant.id, revokedAt: expect.any(String) })
    // The row survives as a soft marker (audit trail), and re-revoking does not error or change it.
    const list = (await http.app.inject({ method: 'GET', url: `${ORG}/principals/${made.id}/grants` })).json() as {
      grants: GrantJson[]
    }
    expect(list.grants).toHaveLength(1)
    expect(list.grants[0]?.revokedAt).not.toBeNull()
    const second = await http.app.inject({
      method: 'POST',
      url: `${ORG}/principals/${made.id}/grants/${grant.id}/revoke`,
      payload: {}
    })
    expect(second.statusCode).toBe(200)
    expect((second.json() as GrantJson).revokedAt).toBe(list.grants[0]?.revokedAt)
    // Revoking a grant that is not this org's is 404, never a cross-tenant touch.
    expect(
      (
        await http.app.inject({
          method: 'POST',
          url: `${ORG}/principals/${made.id}/grants/${randomUUID()}/revoke`,
          payload: {}
        })
      ).statusCode
    ).toBe(404)
  })

  it('FENCES execution: checkGrant is true for a live grant and false the moment the principal is disabled', async () => {
    const http = app()
    const principals = http.deps.principals
    const made = await createPrincipal(http, 'the-fence')
    await http.app.inject({
      method: 'POST',
      url: `${ORG}/principals/${made.id}/grants`,
      payload: { resourceType: 'repo', resourceId: 'acme/api', capability: 'write' }
    })

    // While active with a live grant, the executor seam authorizes.
    await expect(principals.checkGrant(OrgId(DEFAULT_ORG_ID), made.id, 'repo', 'acme/api', 'write')).resolves.toBe(true)
    // A capability that was never granted does not authorize, even for an active principal.
    await expect(principals.checkGrant(OrgId(DEFAULT_ORG_ID), made.id, 'repo', 'acme/api', 'read')).resolves.toBe(false)

    // Disable — WITHOUT touching the grant. The grant row is still un-revoked and un-expired.
    await principals.disable(OrgId(DEFAULT_ORG_ID), made.id, 'actor-1')
    // Now the same live grant answers false. This is the entire security property: the fence is the
    // principal's state, checked ahead of the grant, not the grant itself.
    await expect(principals.checkGrant(OrgId(DEFAULT_ORG_ID), made.id, 'repo', 'acme/api', 'write')).resolves.toBe(
      false
    )

    // Re-enable restores it — the grant was never lost, only suspended behind the state.
    await principals.enable(OrgId(DEFAULT_ORG_ID), made.id, 'actor-1')
    await expect(principals.checkGrant(OrgId(DEFAULT_ORG_ID), made.id, 'repo', 'acme/api', 'write')).resolves.toBe(true)
  })

  it('fences a grant at its expiry and never leaks across orgs', async () => {
    const repo = new PgPrincipalRepo(prisma)
    // Expired grant: minted with a past expiresAt, so getActiveGrant must not honor it.
    const made = await repo.create({
      orgId: OrgId(DEFAULT_ORG_ID),
      name: 'expiry',
      kind: 'service',
      agentId: undefined,
      createdByActorId: 'a'
    })
    await repo.createGrant({
      orgId: OrgId(DEFAULT_ORG_ID),
      principalId: made.id,
      resourceType: 'tool',
      resourceId: 'shell',
      capability: 'execute',
      expiresAt: new Date(Date.now() - 60_000),
      createdByActorId: 'a'
    })
    const principals = app().deps.principals
    await expect(principals.checkGrant(OrgId(DEFAULT_ORG_ID), made.id, 'tool', 'shell', 'execute')).resolves.toBe(false)

    // Org fencing at the repo seam: a principal minted for this org is invisible to another org id.
    const foreign = OrgId(randomUUID())
    await expect(repo.get(foreign, made.id)).resolves.toBeNull()
    await expect(repo.listForOrg(foreign)).resolves.toEqual([])
  })
})
