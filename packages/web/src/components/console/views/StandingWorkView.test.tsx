// @vitest-environment happy-dom
/**
 * The Standing Work list is an index, not a control panel: it exists so an operator can find the one
 * item that still spends agent turns and open it. So these tests are about what the page must NOT do
 * — invent rows, hide that something awaits approval, or offer to create work it cannot authorize.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StandingWorkDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  work: [] as unknown[],
  loading: false,
  mobile: false,
  push: vi.fn()
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (p: string) => `/acme${p}` })
}))
vi.mock('@/lib/use-is-mobile', () => ({ useIsMobile: () => mocks.mobile }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ standingWork: mocks.work, standingWorkLoading: mocks.loading, agents: [] })
}))

const View = (await import('./StandingWorkView')).default
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function work(over: Partial<StandingWorkDto> = {}): StandingWorkDto {
  return {
    id: 'w1',
    orgId: 'org-1',
    agentId: 'a1',
    name: 'Watch the rollout',
    objective: 'Observe the rollout and report what changed',
    state: 'active',
    definitionVersion: 3,
    approvalState: 'pending',
    schedule: '0 9 * * *',
    timezone: 'UTC',
    expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    targetDestination: { platform: 'slack', integrationId: 'i1', channel: 'C123' },
    updatedAt: new Date().toISOString(),
    ...over
  } as unknown as StandingWorkDto
}

function render(): string {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  act(() => root.render(<View />))
  const html = host.innerHTML
  act(() => root.unmount())
  host.remove()
  return html
}

beforeEach(() => {
  mocks.work = []
  mocks.loading = false
  mocks.push.mockClear()
})

describe('StandingWorkView', () => {
  it('says so when nothing is running, instead of showing a demo roster', () => {
    const html = render()
    expect(html).toContain('No standing work')
    expect(html).toContain('Agents take standing work from a conversation or an')
    // Inspect + stop only: this surface never offers to create a definition, because a definition
    // names policies only the executing daemon can resolve.
    expect(html).not.toContain('New standing work')
    expect(html).not.toContain('Create')
  })

  it('lists a live item with its state and the approval it still awaits', () => {
    mocks.work = [work()]
    const html = render()
    expect(html).toContain('Watch the rollout')
    expect(html).toContain('Active')
    expect(html).toContain('Awaiting approval')
    expect(html).toContain('3 days left')
    expect(html).toContain('Observe the rollout and report what changed')
  })

  it('marks a parked, ended, or denied item as such', () => {
    mocks.work = [
      work({ state: 'paused', approvalState: 'approved' }),
      work({ id: 'w2', state: 'cancelled', approvalState: 'denied' })
    ]
    const html = render()
    expect(html).toContain('Paused')
    expect(html).toContain('Cancelled')
    expect(html).toContain('Denied')
    // An approved version carries no approval badge — the absence IS the answer.
    expect(html.match(/Awaiting approval/g)).toBeNull()
  })

  it('treats a window that already closed as closed', () => {
    mocks.work = [work({ expiresAt: new Date(Date.now() - 60_000).toISOString() })]
    expect(render()).toContain('expired')
  })

  it('opens the detail route on click, under the org path', () => {
    mocks.work = [work()]
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => root.render(<View />))
    act(() =>
      host.querySelector<HTMLDivElement>('div.row.click')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    )
    act(() => root.unmount())
    host.remove()
    expect(mocks.push).toHaveBeenCalledWith('/acme/standing-work/w1')
  })

  it('keeps the same facts, and the same way in, on the phone fork', () => {
    mocks.work = [work()]
    mocks.mobile = true
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => root.render(<View />))
    const html = host.innerHTML
    act(() => host.querySelector('button')?.click())
    act(() => root.unmount())
    host.remove()
    mocks.mobile = false

    expect(html).toContain('Watch the rollout')
    expect(html).toContain('Active')
    expect(html).toContain('Awaiting approval')
    expect(mocks.push).toHaveBeenCalledWith('/acme/standing-work/w1')
  })
})
