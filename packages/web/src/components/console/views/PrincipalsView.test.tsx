// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrincipalDto, PrincipalGrantDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  flagOn: true,
  mobile: false,
  loading: false,
  principals: [] as PrincipalDto[],
  grants: [] as PrincipalGrantDto[]
}))

const api = vi.hoisted(() => ({
  fetchPrincipals: vi.fn(),
  fetchPrincipalGrants: vi.fn(),
  createPrincipal: vi.fn(),
  disablePrincipal: vi.fn(),
  enablePrincipal: vi.fn(),
  createPrincipalGrant: vi.fn(),
  revokePrincipalGrant: vi.fn(),
  fmtDate: (iso: string) => iso
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({
    activeOrg: { id: 'org-1' },
    orgs: [{ id: 'org-1' }],
    loading: false,
    orgPath: (p: string) => `/o${p}`
  })
}))
vi.mock('@/lib/use-is-mobile', () => ({ useIsMobile: () => mocks.mobile }))
vi.mock('@/lib/feature-flags', () => ({ featureFlagEnabled: (id: string) => id === 'principals' && mocks.flagOn }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ agents: [{ id: 'a-1', name: 'Sentry', runtime: 'claude' }] })
}))
vi.mock('@/lib/api', () => api)
// SWR is dispatched purely off the key so a mount never reaches a real fetcher.
vi.mock('swr', () => ({
  default: (key: readonly unknown[] | null) => {
    if (!key) return { data: [], isLoading: false, mutate: vi.fn() }
    const kind = key[2]
    if (kind === 'principal-grants') {
      return { data: mocks.grants, isLoading: false, mutate: vi.fn() }
    }
    return { data: mocks.principals, isLoading: mocks.loading, mutate: vi.fn() }
  }
}))

import PrincipalsView from './PrincipalsView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const principal = (over: Partial<PrincipalDto> = {}): PrincipalDto => ({
  id: 'p-1',
  orgId: 'org-1',
  name: 'nightly-audit',
  kind: 'service',
  agentId: null,
  state: 'active',
  disabledAt: null,
  disabledBy: null,
  authorizationRevision: 1,
  createdByActorId: 'actor-1',
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
  ...over
})

const grant = (over: Partial<PrincipalGrantDto> = {}): PrincipalGrantDto => ({
  id: 'g-1',
  orgId: 'org-1',
  principalId: 'p-1',
  resourceType: 'repo',
  resourceId: 'acme/api',
  capability: 'read',
  expiresAt: null,
  revokedAt: null,
  revokedBy: null,
  createdByActorId: 'actor-1',
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
  ...over
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.flagOn = true
  mocks.mobile = false
  mocks.loading = false
  mocks.principals = []
  mocks.grants = []
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const render = () => act(async () => root.render(<PrincipalsView />))
const button = (text: string) =>
  Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === text)
const byAria = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

describe('PrincipalsView', () => {
  it('renders the "not enabled" card when the feature flag is off, without fetching', async () => {
    mocks.flagOn = false
    await render()
    expect(host.textContent).toContain('Principals are not enabled')
    expect(api.fetchPrincipals).not.toHaveBeenCalled()
  })

  it('shows the loading state on first fetch of an empty list', async () => {
    mocks.loading = true
    await render()
    // Neither the empty-state copy nor any data row is up yet — the body is a spinner.
    expect(host.textContent).not.toContain('No principals yet')
    expect(host.textContent).not.toContain('nightly-audit')
  })

  it('shows the empty state with a create affordance when there are none', async () => {
    await render()
    expect(host.textContent).toContain('No principals yet')
    expect(host.textContent).toContain('New principal')
  })

  it('lists principals with kind, state and the authorization revision', async () => {
    mocks.principals = [principal(), principal({ id: 'p-2', name: 'deploy-bot', kind: 'agent', agentId: 'a-1' })]
    await render()
    expect(host.textContent).toContain('nightly-audit')
    expect(host.textContent).toContain('deploy-bot')
    expect(host.textContent).toContain('Active')
    // The agent-bound row resolves its label from the console agent roster.
    expect(host.textContent).toContain('Sentry')
    expect(host.textContent).toContain('1') // authorizationRevision
  })

  it('reveals the create form and posts a new principal through the API', async () => {
    api.createPrincipal.mockResolvedValue(principal({ id: 'p-9' }))
    await render()
    await act(async () => button('New principal')?.click())
    // The form is now present; fill name, choose the "service" kind (no agent binding needed), submit.
    const nameInput = host.querySelector<HTMLInputElement>('input')
    expect(nameInput).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(nameInput, 'ci-runner')
      nameInput!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const kindSelect = host.querySelector<HTMLSelectElement>('select')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
      setter.call(kindSelect, 'service')
      kindSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const createBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Create principal')
    )
    expect(createBtn).toBeTruthy()
    await act(async () => createBtn?.click())
    expect(api.createPrincipal).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ci-runner', kind: 'service' }),
      'org-1'
    )
  })

  it('disables an active principal via the API and enables a disabled one', async () => {
    api.disablePrincipal.mockResolvedValue(principal({ state: 'disabled' }))
    api.enablePrincipal.mockResolvedValue(principal({ state: 'active' }))
    mocks.principals = [principal({ id: 'on' }), principal({ id: 'off', name: 'retired', state: 'disabled' })]
    await render()
    await act(async () => button('Disable')?.click())
    expect(api.disablePrincipal).toHaveBeenCalledWith('on')
    await act(async () => button('Enable')?.click())
    expect(api.enablePrincipal).toHaveBeenCalledWith('off')
  })

  it('expands a row to list its grants and revokes one', async () => {
    mocks.principals = [principal()]
    mocks.grants = [grant()]
    api.revokePrincipalGrant.mockResolvedValue(grant({ revokedAt: '2026-09-21T00:00:00.000Z' }))
    await render()
    await act(async () => byAria('Show grants')?.click())
    expect(host.textContent).toContain('acme/api')
    await act(async () => button('Revoke')?.click())
    expect(api.revokePrincipalGrant).toHaveBeenCalledWith('p-1', 'g-1')
  })
})
