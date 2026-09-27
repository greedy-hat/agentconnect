/**
 * The audit REST surface (A1 Unified Audit, roadmap §6): search + bounded export.
 *
 * The load-bearing promises here are access-control and isolation, not volume:
 *  - reads are OWNER-ONLY (a collaborator — who can write most org resources — is
 *    still denied the security trail);
 *  - every read is scoped to the path org; a foreign-org row never appears;
 *  - results are newest-first by ingestion id and cursor-paginated;
 *  - the causal envelope (traceId / effectId / principalId / source / occurredAt)
 *    round-trips;
 *  - export is bounded and reports `truncated`.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { OrgId } from '../../src/domain/ids.js'
import type { OrgMemberRole, AuditKind } from '../../src/persistence/ports.js'

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
  const email = `${sub}@audit.test`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

type AuditJson = {
  id: string
  kind: string
  orgId: string | null
  message: string | null
  traceId: string | null
  effectId: string | null
  principalId: string | null
  source: string
  occurredAt: string | null
  createdAt: string
}
type Page = { events: AuditJson[]; nextCursor: string | null }
type Export = { events: AuditJson[]; truncated: boolean; exportedAt: string }

// Append a row straight through the repo (the same seam services use). Returns
// the persisted record so a test can assert on its id / ordering.
function seed(http: HttpApp, kind: AuditKind, extra: Partial<Parameters<typeof http.deps.repos.audit.append>[0]> = {}) {
  return http.deps.repos.audit.append({ kind, orgId: OrgId(DEFAULT_ORG_ID), ...extra })
}

describe('Audit console routes', () => {
  it('searches org events newest-first and round-trips the causal envelope', async () => {
    const http = app()
    const trace = `trace-${randomUUID().slice(0, 8)}`
    const principal = randomUUID()
    await seed(http, 'api_key_create', { message: 'first' })
    await seed(http, 'mcp_tool_call', {
      message: 'second',
      traceId: trace,
      effectId: 'eff-1',
      principalId: principal,
      source: 'daemon',
      occurredAt: new Date('2026-01-01T00:00:00Z')
    })

    const res = await http.app.inject({ method: 'GET', url: `${ORG}/audit?limit=10` })
    expect(res.statusCode).toBe(200)
    const page = res.json() as Page
    // Newest-first: the second append has the higher ingestion id.
    expect(page.events[0]?.message).toBe('second')
    const second = page.events.find((e) => e.message === 'second')!
    expect(second).toMatchObject({
      kind: 'mcp_tool_call',
      traceId: trace,
      effectId: 'eff-1',
      principalId: principal,
      source: 'daemon',
      occurredAt: '2026-01-01T00:00:00.000Z'
    })
    // The CP-native row defaults to source=cp and carries no envelope ids.
    const first = page.events.find((e) => e.message === 'first')!
    expect(first).toMatchObject({ source: 'cp', traceId: null, eventId: null })
  })

  it('filters by kind', async () => {
    const http = app()
    await seed(http, 'api_key_create', { message: 'k1' })
    await seed(http, 'api_key_revoke', { message: 'k2' })
    await seed(http, 'hook_change', { message: 'k3' })

    const res = await http.app.inject({ method: 'GET', url: `${ORG}/audit?kinds=api_key_create,api_key_revoke` })
    const page = res.json() as Page
    expect(page.events.map((e) => e.message).sort()).toEqual(['k1', 'k2'])
  })

  it('paginates with an opaque cursor and never repeats a row', async () => {
    const http = app()
    for (let i = 0; i < 5; i++) await seed(http, 'protocol_error', { message: `p${i}` })

    const first = (await (await http.app.inject({ method: 'GET', url: `${ORG}/audit?limit=2` })).json()) as Page
    expect(first.events.map((e) => e.message)).toEqual(['p4', 'p3'])
    expect(first.nextCursor).not.toBeNull()

    const second = (await (
      await http.app.inject({ method: 'GET', url: `${ORG}/audit?limit=2&cursor=${first.nextCursor}` })
    ).json()) as Page
    expect(second.events.map((e) => e.message)).toEqual(['p2', 'p1'])

    const third = (await (
      await http.app.inject({ method: 'GET', url: `${ORG}/audit?limit=2&cursor=${second.nextCursor}` })
    ).json()) as Page
    expect(third.events.map((e) => e.message)).toEqual(['p0'])
    expect(third.nextCursor).toBeNull()
  })

  it('never surfaces another organization’s events', async () => {
    const http = app()
    await seed(http, 'api_key_create', { message: 'mine' })
    await http.deps.repos.audit.append({
      kind: 'api_key_create',
      orgId: OrgId('org_foreign0000000000000000000'),
      message: 'not-mine'
    })

    const page = (await (await http.app.inject({ method: 'GET', url: `${ORG}/audit?limit=50` })).json()) as Page
    expect(page.events.some((e) => e.message === 'not-mine')).toBe(false)
    expect(page.events.every((e) => e.orgId === DEFAULT_ORG_ID)).toBe(true)
  })

  it('is owner-only: a collaborator who can write org resources is denied the trail', async () => {
    const owner = app()
    await seed(owner, 'api_key_create', { message: 'secret-trail' })

    const collabId = await makeUser(`audit-collab-${randomUUID()}`, 'collaborator')
    const collab = app({ userId: collabId })
    expect((await collab.app.inject({ method: 'GET', url: `${ORG}/audit` })).statusCode).toBe(403)
    expect((await collab.app.inject({ method: 'GET', url: `${ORG}/audit/export` })).statusCode).toBe(403)

    // The owner sees it.
    expect((await owner.app.inject({ method: 'GET', url: `${ORG}/audit` })).statusCode).toBe(200)
  })

  it('exports filtered events as bounded JSON with a truncated flag', async () => {
    const http = app()
    for (let i = 0; i < 3; i++) await seed(http, 'drain', { message: `d${i}` })

    const res = await http.app.inject({ method: 'GET', url: `${ORG}/audit/export?kinds=drain` })
    expect(res.statusCode).toBe(200)
    const out = res.json() as Export
    expect(out.truncated).toBe(false)
    expect(out.events.map((e) => e.message).sort()).toEqual(['d0', 'd1', 'd2'])
    expect(out.exportedAt).toMatch(/^\d{4}-/)
  })
})
