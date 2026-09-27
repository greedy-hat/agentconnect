// @vitest-environment happy-dom
/**
 * The Standing Work detail page is the operator's stop switch, so the things these tests pin are the
 * ones that would otherwise let an operator mis-read the page:
 *  - a run's OUTCOME and its notification DELIVERY are separate facts — a `notify` run whose post the
 *    daemon could not prove must not read as delivered (or as failed);
 *  - the timeline is polled from the CP's stored projection, never fetched from the daemon;
 *  - Approve is shown only where the server would accept it (an owner, a pending version, still active);
 *  - every action carries the `definitionVersion` this page last read, and a refused write is
 *    reported, not swallowed.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StandingWorkDto, StandingWorkRunDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  work: [] as unknown[],
  runs: null as unknown[] | null,
  loading: false,
  myRole: 'owner',
  transition: vi.fn(async () => undefined),
  keys: [] as unknown[][],
  options: [] as unknown[],
  push: vi.fn(),
  mutateRuns: vi.fn(async () => undefined)
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'w1' }),
  useRouter: () => ({ push: mocks.push })
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, myRole: mocks.myRole, orgPath: (p: string) => `/acme${p}` })
}))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: { id: 'u1', name: 'Mike', email: 'mike@test' } }) }))
vi.mock('@/lib/use-is-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/lib/schedule-timezone', () => ({ useScheduleTimeZone: () => ({ zoneFor: (tz: string) => tz }) }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    standingWork: mocks.work,
    standingWorkLoading: mocks.loading,
    agents: [],
    integrations: [],
    allSessions: [],
    transitionStandingWork: mocks.transition
  })
}))
// The Runs card is the page's only fetcher; the stub answers so the fence and the poll interval are
// observable, and no test reaches the network.
vi.mock('swr', () => ({
  default: (key: unknown, _fetcher: unknown, options: unknown) => {
    if (Array.isArray(key)) mocks.keys.push(key)
    mocks.options.push(options)
    return { data: mocks.runs, error: undefined, mutate: mocks.mutateRuns }
  }
}))

const View = (await import('./StandingWorkDetailView')).default
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const START = Date.parse('2026-09-22T09:00:00.000Z')

function work(over: Partial<StandingWorkDto> = {}): StandingWorkDto {
  return {
    id: 'w1',
    orgId: 'org-1',
    agentId: 'a1',
    principalId: 'standing-work:org-1',
    name: 'Watch the rollout',
    objective: 'Observe the rollout and report what changed',
    state: 'active',
    definitionVersion: 3,
    approvalState: 'pending',
    approvalVersion: null,
    schedule: '0 9 * * *',
    timezone: 'UTC',
    startAt: new Date(START - 86_400_000).toISOString(),
    expiresAt: new Date(START + 6 * 86_400_000).toISOString(),
    minIntervalSeconds: 60,
    maxRunsPerDay: 24,
    maxNotificationsPerDay: 2,
    conversationRef: null,
    targetDestination: { platform: 'slack', integrationId: 'i1', channel: 'C123' },
    budgetPolicyRef: 'default',
    toolPolicyRef: 'read-only',
    notificationPolicy: { mode: 'changes', includeCompletion: true },
    visibilityPolicyRef: 'agent',
    sourceSessionId: null,
    createdByActorId: 'u1',
    lastModifiedByActorId: 'u1',
    approvedByActorId: null,
    authorizationRevision: 1,
    createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(),
    ...over
  } as StandingWorkDto
}

const run = (over: Partial<StandingWorkRunDto> = {}): StandingWorkRunDto =>
  ({
    runId: 'r1',
    workId: 'w1',
    definitionVersion: 3,
    executionEpoch: 0,
    attempt: 1,
    outcome: 'no_change',
    startedAt: new Date(START).toISOString(),
    finishedAt: new Date(START + 4200).toISOString(),
    sessionId: null,
    errorCode: null,
    notification: null,
    ...over
  }) as StandingWorkRunDto

function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  act(() => root.render(<View />))
  const click = (label: string) => {
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(label))
    if (!button) throw new Error(`no button labelled ${label}`)
    return act(async () => {
      button.click()
    })
  }
  const unmount = () => {
    act(() => root.unmount())
    host.remove()
  }
  return { host, click, unmount }
}

beforeEach(() => {
  mocks.work = [work()]
  mocks.runs = []
  mocks.loading = false
  mocks.myRole = 'owner'
  mocks.keys = []
  mocks.options = []
  mocks.transition.mockReset()
  mocks.transition.mockResolvedValue(undefined)
  mocks.mutateRuns.mockReset()
  mocks.mutateRuns.mockResolvedValue(undefined)
  mocks.push.mockClear()
})

describe('StandingWorkDetailView', () => {
  it('keeps a run’s outcome and its delivery as two separate facts', () => {
    mocks.work = [work({ approvalState: 'approved', approvalVersion: 3 })]
    mocks.runs = [
      run({ runId: 'r-quiet', outcome: 'no_change' }),
      run({
        runId: 'r-unproven',
        outcome: 'notify',
        notification: {
          notificationIndex: 0,
          effectId: 'e1',
          status: 'uncertain',
          providerReceipt: null,
          error: 'provider_timeout'
        }
      })
    ]
    const { host, unmount } = mount()
    const html = host.innerHTML
    unmount()

    expect(html).toContain('No change')
    expect(html).toContain('Notified')
    // The honest answer about the send: neither delivered nor failed.
    expect(html).toContain('Delivery uncertain')
    expect(html).not.toContain('Delivered')
    expect(html).not.toContain('Delivery failed')
    expect(html).toContain('provider_timeout')
  })

  it('renders a run still in flight as running, not as a zero-length span', () => {
    mocks.runs = [run({ finishedAt: null })]
    const { host, unmount } = mount()
    const html = host.innerHTML
    unmount()
    expect(html).toContain('running')
  })

  it('polls the CP’s stored timeline rather than reading it once', () => {
    mount().unmount()
    // The key is the console's org-scoped one, so a switch of organizations re-pulls.
    expect(mocks.keys.some((k) => k.includes('standing-work-runs') && k.includes('w1'))).toBe(true)
    expect(mocks.options[0]).toMatchObject({ refreshInterval: 10_000 })
  })

  it('says the timeline is empty because nothing has reported yet', () => {
    const { host, unmount } = mount()
    const html = host.innerHTML
    unmount()
    expect(html).toContain('No runs reported yet')
  })

  it('shows Approve only to an owner, only while the current version still awaits', () => {
    mocks.myRole = 'collaborator'
    let m = mount()
    const asCollaborator = m.host.innerHTML
    m.unmount()
    expect(asCollaborator).not.toContain('Approve')
    // Pause is any write role, so the stop switch stays reachable.
    expect(asCollaborator).toContain('Pause')

    mocks.myRole = 'owner'
    m = mount()
    expect(m.host.innerHTML).toContain('Approve')
    m.unmount()

    // An approved version has nothing left to approve.
    mocks.work = [work({ approvalState: 'approved', approvalVersion: 3 })]
    m = mount()
    expect(m.host.innerHTML).not.toContain('Approve')
    m.unmount()
  })

  it('sends the version this page last read, and re-pulls after it lands', async () => {
    const { click, unmount } = mount()
    await click('Pause')
    expect(mocks.transition).toHaveBeenCalledWith('w1', 'pause', 3)
    // The timeline re-pull is what makes the page converge instead of trusting its own optimism.
    expect(mocks.mutateRuns).toHaveBeenCalled()
    unmount()
  })

  it('surfaces a refused action instead of leaving the operator guessing', async () => {
    mocks.transition.mockRejectedValueOnce(new Error('someone changed this definition'))
    const { click, host, unmount } = mount()
    await click('Pause')
    expect(host.innerHTML).toContain('someone changed this definition')
    unmount()
  })

  it('makes cancel a two-step, and never fires it on the first click', async () => {
    const { click, host, unmount } = mount()
    await click('Cancel work')
    expect(mocks.transition).not.toHaveBeenCalled()
    expect(host.innerHTML).toContain('Confirm cancel')

    await click('Confirm cancel')
    expect(mocks.transition).toHaveBeenCalledWith('w1', 'cancel', 3)
    unmount()
  })

  it('keeps the terms it shows opaque: policy names, never decoded values', () => {
    const { host, unmount } = mount()
    const html = host.innerHTML
    unmount()
    expect(html).toContain('read-only')
    expect(html).toContain('Observe the rollout and report what changed')
    // The destination channel is the operator's own; the agent's tools are the daemon's config.
    expect(html).toContain('C123')
  })

  it('treats a vanished or unviewable item as not found, not as an empty timeline', () => {
    mocks.work = []
    const { host, unmount } = mount()
    const html = host.innerHTML
    unmount()
    expect(html).toContain('Standing work not found')
    expect(html).not.toContain('No runs reported yet')
  })
})
