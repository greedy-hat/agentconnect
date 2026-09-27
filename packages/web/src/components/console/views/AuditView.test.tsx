// @vitest-environment happy-dom
// Audit is the one console surface whose read path can fail on permission rather
// than on emptiness: a non-owner gets a 403, and rendering that as "no events"
// would tell the operator the organization has nothing to review. So the error
// branch is the test that matters most here, alongside the causal detail that
// makes a row worth opening.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditEventDto, AuditPage } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  flagOn: true,
  mobile: false,
  loading: false,
  error: null as unknown,
  pages: [] as AuditPage[],
  hookCalls: 0
}))

const api = vi.hoisted(() => ({
  fetchAuditEvents: vi.fn(),
  exportAuditEvents: vi.fn()
}))

const setSize = vi.hoisted(() => vi.fn(async () => {}))

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
vi.mock('@/lib/feature-flags', () => ({ featureFlagEnabled: (id: string) => id === 'audit' && mocks.flagOn }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ agents: [{ id: 'a-1', name: 'Sentry', runtime: 'claude' }] })
}))
vi.mock('@/lib/api', () => api)
// The pages are the whole input: the view derives rows, `hasMore` and the cursor
// from them, so a mount never reaches a real fetcher.
vi.mock('swr/infinite', () => ({
  default: () => {
    mocks.hookCalls++
    return {
      data: mocks.pages,
      error: mocks.error,
      isLoading: mocks.loading,
      isValidating: false,
      size: mocks.pages.length,
      setSize
    }
  }
}))

import AuditView from './AuditView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const event = (over: Partial<AuditEventDto> = {}): AuditEventDto => ({
  id: 'e-1',
  kind: 'tool_intent',
  orgId: 'org-1',
  daemonId: 'd-1',
  agentId: 'a-1',
  sessionId: null,
  actorUserId: null,
  message: 'tool_intent',
  details: { tool: 'bash', args: { cmd: 'git status' } },
  eventId: '0e6f2f1c-0000-4000-8000-000000000001',
  traceId: '0e6f2f1c-0000-4000-8000-0000000000tr',
  parentEventId: null,
  effectId: '0e6f2f1c-0000-4000-8000-0000000000ef',
  principalId: '0e6f2f1c-0000-4000-8000-0000000000pr',
  source: 'daemon',
  occurredAt: '2026-09-21T08:30:00.000Z',
  createdAt: '2026-09-21T08:30:01.000Z',
  ...over
})

const page = (events: AuditEventDto[], nextCursor: string | null): AuditPage => ({ events, nextCursor })

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.flagOn = true
  mocks.mobile = false
  mocks.loading = false
  mocks.error = null
  mocks.pages = []
  mocks.hookCalls = 0
  vi.clearAllMocks()
  // downloadJson touches both; happy-dom implements neither.
  ;(URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:audit'
  ;(URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {}
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

const render = () => act(async () => root.render(<AuditView />))
const button = (text: string) =>
  Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === text)
const byAria = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const selectWithValue = (value: string) =>
  Array.from(host.querySelectorAll('select')).find((s) => Array.from(s.options).some((o) => o.value === value))

describe('AuditView', () => {
  it('renders the "not enabled" card when the feature flag is off, without subscribing', async () => {
    mocks.flagOn = false
    await render()
    expect(host.textContent).toContain('Audit is not enabled')
    expect(mocks.hookCalls).toBe(0)
  })

  it('shows the loading state on first fetch of an empty trail', async () => {
    mocks.loading = true
    await render()
    expect(host.textContent).not.toContain('No audit events yet')
  })

  it('shows the empty state when there is nothing to review', async () => {
    await render()
    expect(host.textContent).toContain('No audit events yet')
  })

  it('surfaces a read error instead of the empty state — a 403 is not "no events"', async () => {
    mocks.error = new Error('audit is restricted to the organization owner')
    await render()
    expect(host.textContent).toContain('audit is restricted to the organization owner')
    expect(host.textContent).not.toContain('No audit events yet')
  })

  it('lists rows with a spelled-out kind, the writing source and the resolved agent', async () => {
    mocks.pages = [
      page([event(), event({ id: 'e-2', kind: 'run_started', source: 'cp', agentId: null, actorUserId: 'u-9' })], null)
    ]
    await render()
    expect(host.textContent).toContain('Tool intent')
    expect(host.textContent).toContain('Run started')
    expect(host.textContent).toContain('Sentry')
    expect(host.textContent).toContain('Daemon')
    expect(host.textContent).toContain('CP')
    // A row with no agent falls back to the human actor rather than claiming nobody.
    expect(host.textContent).toContain('u-9')
  })

  it('opens a row to reveal its causal ids and redacted details', async () => {
    mocks.pages = [page([event()], null)]
    await render()
    expect(host.textContent).not.toContain('git status')
    await act(async () => byAria('Show event detail')?.click())
    expect(host.textContent).toContain('0e6f2f1c-0000-4000-8000-0000000000tr')
    expect(host.textContent).toContain('0e6f2f1c-0000-4000-8000-0000000000ef')
    expect(host.textContent).toContain('git status')
    // A null parent is not rendered as an empty row the reader has to scan past.
    expect(host.textContent).not.toContain('Parent')
    await act(async () => byAria('Hide event detail')?.click())
    expect(host.textContent).not.toContain('git status')
  })

  it('offers every daemon kind in the filter, under an "All events" default', async () => {
    await render()
    const kind = selectWithValue('tool_result')
    expect(kind).toBeTruthy()
    expect(Array.from(kind!.options).map((o) => o.value)).toContain('')
    expect(kind!.querySelector('optgroup')?.label).toBe('Daemon execution')
  })

  it('carries the searched trace into the export it triggers', async () => {
    api.exportAuditEvents.mockResolvedValue({
      events: [event()],
      truncated: false,
      exportedAt: '2026-09-21T09:00:00.000Z'
    })
    mocks.pages = [page([event()], null)]
    await render()
    const trace = host.querySelector<HTMLInputElement>('input')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(trace, 'trace-42')
      trace.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Search')?.click())
    await act(async () => button('Export JSON')?.click())
    expect(api.exportAuditEvents).toHaveBeenCalledWith('org-1', expect.objectContaining({ traceId: 'trace-42' }))
  })

  it('says so when the export was cut short by the server ceiling', async () => {
    api.exportAuditEvents.mockResolvedValue({ events: [], truncated: true, exportedAt: '2026-09-21T09:00:00.000Z' })
    await render()
    await act(async () => button('Export JSON')?.click())
    expect(host.textContent).toContain('narrow the search')
  })

  it('pages with the cursor the last page returned, and hides the affordance at the end', async () => {
    mocks.pages = [page([event()], 'cur-2')]
    await render()
    await act(async () => button('Load more')?.click())
    expect(setSize).toHaveBeenCalledWith(2)

    mocks.pages = [page([event()], null)]
    await render()
    expect(button('Load more')).toBeUndefined()
  })

  it('switches to the stacked mobile list', async () => {
    mocks.mobile = true
    mocks.pages = [page([event(), event({ id: 'e-2', kind: 'admission', source: 'cp' })], null)]
    await render()
    expect(host.textContent).toContain('Tool intent')
    // The sheet spells the writer out where the table had a badge column.
    expect(host.textContent).toContain('Control plane')
    // Detail ids are truncated to a prefix — enough to match against a run page.
    expect(host.textContent).toContain('0e6f2f1c-000')
  })
})
