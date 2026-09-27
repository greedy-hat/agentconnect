'use client'

// Standing work detail (`/standing-work/[id]`) — the operator's view of one durable
// commitment: what it was told to do, what it decided on each run, and the controls
// to approve it, park it, or end it.
//
// The Runs card is a pure DB read polled every 10s. Runs arrive here only because the
// executing daemon pushed them (`standing-work/report`); the CP never sits on the
// execution path, so this page shows what has already happened, never a live tail.
// A run's OUTCOME and its notification DELIVERY are two columns for a reason: an
// agent can decide to notify and still have the send land `uncertain` — that state is
// displayed, not resolved into success or failure.

import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { agentLabel, platName } from '@/lib/data'
import { chatRoomSigil } from '@/lib/platform-labels'
import { creatorLabel, fetchStandingWorkRuns, fmtDate, type StandingWorkRunDto } from '@/lib/api'
import { cronHuman, cronNext, fmtNextRun } from '@/lib/cron'
import { useScheduleTimeZone } from '@/lib/schedule-timezone'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import { useOrgs } from '@/lib/org-context'
import { useIsMobile } from '@/lib/use-is-mobile'
import { consoleKeys } from '@/lib/swr-keys'
import { AgentIconView, LoadingState, PlatformMark } from '@/components/marks'
import { NotFound } from '@/components/console/NotFound'
import { Button, Icon } from '@/components/ui'
import { StandingWorkApprovalBadge, StandingWorkStateBadge } from './StandingWorkView'

const RUN_REFRESH_MS = 10_000
const RUN_PAGE_SIZE = 50
const RUN_GRID = 'grid-cols-[1.4fr_1.1fr_1.2fr_0.9fr_0.8fr_1.2fr]'

// What the agent decided. `no_change` is the point of the feature — it worked and
// stayed quiet — so it reads as a normal outcome, not a skipped run.
const OUTCOME_STYLE: Record<StandingWorkRunDto['outcome'], { dot: string; color: string; label: string }> = {
  no_change: { dot: 'var(--text-disabled)', color: 'var(--text-tertiary)', label: 'No change' },
  notify: { dot: 'var(--status-info)', color: 'var(--text-primary)', label: 'Notified' },
  blocked: { dot: 'var(--status-paused)', color: 'var(--status-paused)', label: 'Blocked' },
  complete: { dot: 'var(--status-online)', color: 'var(--text-primary)', label: 'Complete' },
  failed: { dot: 'var(--status-error)', color: 'var(--status-error)', label: 'Failed' }
}

// Delivery is reported separately from the outcome, and `uncertain` is its own end
// state: the send may or may not have reached the platform, and nothing here may
// quietly resolve that either way.
const DELIVERY_STYLE: Record<
  NonNullable<StandingWorkRunDto['notification']>['status'],
  { dot: string; color: string; label: string }
> = {
  pending: { dot: 'var(--text-disabled)', color: 'var(--text-tertiary)', label: 'Queued' },
  sending: { dot: 'var(--status-paused)', color: 'var(--status-paused)', label: 'Sending' },
  delivered: { dot: 'var(--status-online)', color: 'var(--text-secondary)', label: 'Delivered' },
  uncertain: { dot: 'var(--status-paused)', color: 'var(--status-paused)', label: 'Delivery uncertain' },
  failed: { dot: 'var(--status-error)', color: 'var(--status-error)', label: 'Delivery failed' },
  suppressed: { dot: 'var(--text-disabled)', color: 'var(--text-tertiary)', label: 'Suppressed by budget' }
}

function fmtStarted(iso: string, timeZone?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone })
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone })} · ${time}`
}

function fmtSpan(run: StandingWorkRunDto, timeZone?: string): string {
  if (!run.finishedAt) return 'running'
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
  if (Number.isNaN(ms) || ms < 0) return fmtStarted(run.startedAt, timeZone)
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}

export default function StandingWorkDetailView() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { me } = useProfile()
  const { orgPath, activeOrg, myRole } = useOrgs()
  const { standingWork, standingWorkLoading, agents, integrations, allSessions, transitionStandingWork } =
    useConsoleData()
  const isMobile = useIsMobile()
  const clock = useScheduleTimeZone()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [olderPage, setOlderPage] = useState<{ workId: string; rows: StandingWorkRunDto[]; hasMore: boolean } | null>(
    null
  )
  const [olderLoadingId, setOlderLoadingId] = useState<string | null>(null)
  const [olderErrorId, setOlderErrorId] = useState<string | null>(null)
  const latestRunsRef = useRef<{ workId: string; runs: StandingWorkRunDto[] } | null>(null)

  const w = standingWork.find((x) => x.id === id)

  const runsKey = consoleKeys.standingWorkRuns(activeOrg?.id, id)
  const {
    data: runsData,
    error: runsError,
    mutate: mutateRuns
  } = useSWR(runsKey, ([, orgId, , workId]) => fetchStandingWorkRuns(workId, orgId), {
    refreshInterval: RUN_REFRESH_MS
  })
  const latestRuns = runsData ?? null
  const storedOlderPage = olderPage?.workId === id ? olderPage : null
  const runs =
    latestRuns === null
      ? null
      : [
          ...new Map([...(storedOlderPage?.rows ?? []), ...latestRuns].map((run) => [run.runId, run] as const)).values()
        ].sort(
          (a, b) =>
            Date.parse(b.startedAt) - Date.parse(a.startedAt) || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0)
        )
  const canLoadOlder = latestRuns !== null && latestRuns.length === RUN_PAGE_SIZE && (storedOlderPage?.hasMore ?? true)
  const runsLoadError = runsData === undefined && runsError

  useEffect(() => {
    if (latestRuns === null) return
    const previous = latestRunsRef.current
    latestRunsRef.current = { workId: id, runs: latestRuns }
    if (!previous || previous.workId !== id) return
    const currentIds = new Set(latestRuns.map((run) => run.runId))
    const shiftedOut = previous.runs.filter((run) => !currentIds.has(run.runId))
    if (shiftedOut.length === 0) return
    setOlderPage((current) => {
      const existing = current?.workId === id ? current.rows : []
      const merged = [...new Map([...existing, ...shiftedOut].map((run) => [run.runId, run] as const)).values()]
      return { workId: id, rows: merged, hasMore: current?.workId === id ? current.hasMore : true }
    })
  }, [id, latestRuns])

  const loadOlderRuns = async () => {
    if (!runs?.length || !canLoadOlder || olderLoadingId === id) return
    const cursor = runs[runs.length - 1]!
    setOlderLoadingId(id)
    setOlderErrorId(null)
    try {
      const page = await fetchStandingWorkRuns(id, activeOrg?.id, {
        limit: RUN_PAGE_SIZE + 1,
        before: { startedAt: cursor.startedAt, runId: cursor.runId }
      })
      const incoming = page.slice(0, RUN_PAGE_SIZE)
      setOlderPage((current) => {
        const existing = current?.workId === id ? current.rows : []
        const merged = [...new Map([...existing, ...incoming].map((run) => [run.runId, run] as const)).values()]
        return { workId: id, rows: merged, hasMore: page.length > RUN_PAGE_SIZE }
      })
    } catch {
      setOlderErrorId(id)
    } finally {
      setOlderLoadingId((current) => (current === id ? null : current))
    }
  }

  if (!w) {
    return (
      <div className="wrap">
        {standingWorkLoading ? (
          <LoadingState fill />
        ) : (
          <NotFound
            icon="repeat"
            kind="STANDING WORK"
            title="Standing work not found"
            pre="No standing work "
            chip={id}
            post=" in this organization, or it belongs to an agent you cannot see."
            actionLabel="Back to standing work"
            actionHref={orgPath('/standing-work')}
            searchLabel="Search standing work"
          />
        )}
      </div>
    )
  }

  const owner = agents.find((a) => a.id === w.agentId)
  const agentName = owner ? agentLabel(owner) : w.agentId.slice(0, 8)
  const agentRuntime = owner?.runtime || owner?.model || ''
  const human = cronHuman(w.schedule)
  const zone = clock.zoneFor(w.timezone)
  const open = w.state === 'active' || w.state === 'paused'
  // Approve is owner-only server-side; hide it rather than offer a button that 403s.
  const canApprove = myRole === 'owner' && w.approvalState === 'pending' && w.state === 'active'
  const sigil = chatRoomSigil(w.targetDestination.platform)
  const dest = w.targetDestination
  const channelName =
    integrations
      .filter((i) => i.id === dest.integrationId)
      .flatMap((i) => i.channels)
      .find((ch) => ch.channelId === dest.channel)?.name ?? dest.channel
  const sessionName = (sid: string): string | undefined => allSessions.find((s) => s.id === sid)?.title
  const notified = (runs ?? []).filter((r) => r.notification?.status === 'delivered').length
  const runSummary =
    runs === null
      ? ''
      : `${runs.length} runs · ${notified} notified · ${runs.filter((r) => r.outcome === 'no_change').length} quiet`

  const act = async (action: 'approve' | 'pause' | 'resume' | 'cancel') => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      await transitionStandingWork(w.id, action, w.definitionVersion)
      void mutateRuns().catch(() => undefined)
    } catch (e) {
      // A 409 means the definition moved under this page; the list re-pulled, so say
      // so rather than replaying the change against the new version.
      setNotice(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setConfirmCancel(false)
    }
  }

  const meta = (
    <div className="mt-[9px] mb-5 flex flex-wrap items-center gap-x-4 gap-y-2">
      {owner ? (
        <Link
          className="lnk inline-flex items-center gap-[6px] font-mono text-[12px] font-normal leading-normal text-(--text-secondary)"
          href={orgPath(`/agents/${w.agentId}`)}
        >
          <span className="av h-4 w-4 rounded-xs">
            <AgentIconView icon={owner.icon} runtime={agentRuntime} size={16} />
          </span>
          {agentName}
        </Link>
      ) : (
        <span className="mono text-[12px] text-(--text-secondary)">{agentName}</span>
      )}
      <span className="inline-flex items-center gap-[6px]">
        <Icon name="calendar-clock" size={13} color="var(--text-tertiary)" />
        <span className="mono text-[12px] text-(--text-secondary)">{w.schedule}</span>
        <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {human ? `${human} · ${w.timezone}` : ''}
        </span>
      </span>
      {w.state === 'active' && (
        <span className="inline-flex items-center gap-[6px]">
          <Icon name="clock" size={13} color="var(--text-tertiary)" />
          <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">next run</span>
          <span className="mono text-[12px] text-(--text-secondary)">
            {fmtNextRun(cronNext(w.schedule, w.timezone), zone)}
          </span>
        </span>
      )}
      <span className="inline-flex items-center gap-[6px]">
        <span className="imark h-[13px] w-[13px]">
          <PlatformMark platform={dest.platform} />
        </span>
        <span className="mono text-[12px] text-(--text-secondary)">
          {sigil}
          {channelName}
          {dest.thread ? ` · thread ${dest.thread.slice(0, 12)}…` : ''}
        </span>
      </span>
      <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
        {platName(dest.platform)}
      </span>
      <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
        v{w.definitionVersion} · window {fmtDate(w.startAt)} → {fmtDate(w.expiresAt)}
      </span>
      <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
        Created by {creatorLabel(w.createdByActorId, me)} · Modified by {creatorLabel(w.lastModifiedByActorId, me)}
      </span>
    </div>
  )

  const actions = (
    <div className="flex flex-none items-center gap-2">
      {canApprove && (
        <Button size="sm" onClick={() => void act('approve')} className={busy ? 'opacity-60' : undefined}>
          <Icon name="shield-check" size={14} />
          Approve
        </Button>
      )}
      {w.state === 'active' && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void act('pause')}
          className={busy ? 'opacity-60' : undefined}
        >
          <Icon name="pause" size={14} />
          Pause
        </Button>
      )}
      {w.state === 'paused' && (
        <Button size="sm" onClick={() => void act('resume')} className={busy ? 'opacity-60' : undefined}>
          <Icon name="play" size={14} />
          Resume
        </Button>
      )}
      {open &&
        (confirmCancel ? (
          <>
            <Button size="sm" variant="secondary" onClick={() => setConfirmCancel(false)}>
              Keep
            </Button>
            <Button size="sm" onClick={() => void act('cancel')} className={busy ? 'opacity-60' : undefined}>
              <Icon name="circle-slash" size={14} />
              Confirm cancel
            </Button>
          </>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setConfirmCancel(true)}>
            <Icon name="circle-slash" size={14} />
            Cancel work
          </Button>
        ))}
    </div>
  )

  const runsCard = (
    <div className="card">
      <div className="cardhead justify-between">
        <span className="cardtitle">Runs</span>
        <span className="mono text-[11px] text-(--text-tertiary)">{runSummary}</span>
      </div>
      {runsLoadError ? (
        <div className="px-4 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
          Couldn’t load recent runs.
        </div>
      ) : runs === null ? (
        <LoadingState />
      ) : runs.length === 0 ? (
        <div className="px-4 py-7 text-center font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          No runs reported yet — the executing daemon reports each one when it finishes.
        </div>
      ) : (
        <>
          <div className={`row h ${RUN_GRID}`}>
            <span>Started</span>
            <span>Outcome</span>
            <span>Notification</span>
            <span>Took</span>
            <span>Wake</span>
            <span>Session</span>
          </div>
          {runs.map((r) => {
            const out = OUTCOME_STYLE[r.outcome]
            const del = r.notification ? DELIVERY_STYLE[r.notification.status] : null
            return (
              <div key={r.runId} className={`row items-center ${RUN_GRID}`}>
                <div className="min-w-0">
                  <span className="mono text-[12px] text-(--text-primary)">
                    {fmtStarted(r.startedAt, zone)}
                    {r.attempt > 1 && <span className="ml-[5px] text-(--text-tertiary)">#{r.attempt}</span>}
                  </span>
                  {r.suggestedNextCheckAt && w.scheduleMode === 'adaptive' && (
                    <div
                      className="mt-[2px] font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)"
                      title="Model suggested next check"
                    >
                      suggested: {fmtDate(r.suggestedNextCheckAt)}
                    </div>
                  )}
                </div>
                <div className="min-w-0">
                  <span className="inline-flex items-center gap-[6px]">
                    <span className="dot h-[6px] w-[6px]" style={{ background: out.dot }} />
                    <span className="font-sans text-[12px] font-medium leading-normal" style={{ color: out.color }}>
                      {out.label}
                    </span>
                  </span>
                  {r.errorCode && (
                    <div className="mt-[2px] font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">
                      {r.errorCode}
                    </div>
                  )}
                  {r.definitionVersion !== w.definitionVersion && (
                    <div className="mt-[2px] font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                      on v{r.definitionVersion}
                    </div>
                  )}
                </div>
                {del ? (
                  <div className="min-w-0">
                    <span className="inline-flex items-center gap-[6px]">
                      <span className="dot h-[6px] w-[6px]" style={{ background: del.dot }} />
                      <span className="font-sans text-[12px] font-normal leading-normal" style={{ color: del.color }}>
                        {del.label}
                      </span>
                    </span>
                    {r.notification?.error && (
                      <div className="mt-[2px] truncate font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">
                        {r.notification.error}
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="font-sans text-[12px] font-normal leading-normal text-(--text-disabled)">—</span>
                )}
                <span className="mono text-[12px] text-(--text-secondary)">{fmtSpan(r, zone)}</span>
                <span className="font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
                  {r.wakeSource === 'conversation' ? 'Chat' : 'Scheduled'}
                </span>
                {r.sessionId ? (
                  <button
                    onClick={() => router.push(orgPath(`/sessions/${r.sessionId}`))}
                    title="Open session"
                    className="inline-flex min-w-0 max-w-full cursor-pointer items-center justify-self-start gap-[5px] border-0 bg-transparent p-0 font-sans text-[12px] font-medium leading-normal text-(--brand)"
                  >
                    <span className="truncate">{sessionName(r.sessionId) ?? `${r.sessionId.slice(0, 8)}…`}</span>
                    <Icon name="arrow-up-right" size={12} className="flex-none" />
                  </button>
                ) : (
                  <span className="font-sans text-[12px] font-normal leading-normal text-(--text-disabled)">—</span>
                )}
              </div>
            )
          })}
          {(canLoadOlder || olderErrorId === id) && (
            <div className="flex flex-col items-center gap-2 border-t border-(--border-subtle) px-4 py-3">
              {olderErrorId === id && (
                <span className="font-sans text-[12px] text-(--status-error)">Couldn’t load older runs.</span>
              )}
              <Button
                size="sm"
                variant="secondary"
                disabled={olderLoadingId === id}
                onClick={() => void loadOlderRuns()}
              >
                {olderLoadingId === id ? 'Loading…' : olderErrorId === id ? 'Retry' : 'Load older runs'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )

  const termsCard = (
    <div className="card mb-[18px]">
      <div className="cardhead">
        <span className="cardtitle">Objective</span>
      </div>
      <div className="whitespace-pre-wrap px-4 py-[14px] font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-primary)">
        {w.objective}
      </div>
      <div className="border-t border-(--border-subtle) px-4 py-3">
        <div className="grid grid-cols-2 gap-y-2 desktop:grid-cols-4">
          <Term label="Schedule" value={w.scheduleMode === 'adaptive' ? 'Adaptive' : 'Fixed'} />
          <Term label="Runs / day" value={String(w.maxRunsPerDay)} />
          <Term label="Notices / day" value={String(w.maxNotificationsPerDay)} />
          <Term label="Notify" value={w.notificationPolicy.mode === 'changes' ? 'On change' : 'Every run'} />
          <Term label="Min gap" value={`${Math.round(w.minIntervalSeconds / 60)} min`} />
          {w.scheduleMode === 'adaptive' && (
            <Term
              label="Max interval"
              value={
                w.maxIntervalSeconds >= 86400
                  ? `${Math.round(w.maxIntervalSeconds / 86400)} day`
                  : `${Math.round(w.maxIntervalSeconds / 3600)} hr`
              }
            />
          )}
          <Term label="Wake on chat" value={w.wakeOnConversation ? 'On' : 'Off'} />
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          <Policy label="budget" name={w.budgetPolicyRef} />
          <Policy label="tools" name={w.toolPolicyRef} />
          <Policy label="visibility" name={w.visibilityPolicyRef} />
          {w.conversationRef && (
            <Policy
              label="context"
              name={`${w.conversationRef.platform}:${w.conversationRef.channel}${w.conversationRef.thread ? `/${w.conversationRef.thread}` : ''}`}
            />
          )}
          {w.sourceSessionId && <Policy label="from session" name={w.sourceSessionId} />}
        </div>
      </div>
    </div>
  )

  if (isMobile) {
    return (
      <div className="pb-6">
        <div className="flex items-start gap-3 border-b border-(--border-subtle) bg-(--surface-card) p-4">
          <span className="flex min-w-0 flex-1 flex-col gap-[4px]">
            <span className="truncate font-sans text-[15px] font-semibold leading-normal">{w.name}</span>
            <span className="flex flex-wrap items-center gap-[6px]">
              <StandingWorkStateBadge w={w} />
              <StandingWorkApprovalBadge w={w} />
            </span>
          </span>
        </div>
        <div className="flex flex-col gap-4 p-4">
          {notice && <Notice text={notice} />}
          {actions}
          {termsCard}
          {runsCard}
        </div>
      </div>
    )
  }

  return (
    <div className="wrap">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-[10px]">
            <h1 className="ptitle">{w.name}</h1>
            <StandingWorkStateBadge w={w} />
            <StandingWorkApprovalBadge w={w} />
          </div>
        </div>
        {actions}
      </div>
      {meta}
      {notice && <Notice text={notice} />}
      {termsCard}
      {runsCard}
    </div>
  )
}

function Term({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-[2px]">
      <span className="font-sans text-[11px] font-normal uppercase leading-normal text-(--text-tertiary)">{label}</span>
      <span className="font-sans text-[13px] font-medium leading-normal">{value}</span>
    </span>
  )
}

// Policy refs are opaque names the executing daemon resolves against its own config —
// the console shows WHICH applies, never a decoded value it has no claim on.
function Policy({ label, name }: { label: string; name: string }) {
  return (
    <span className="inline-flex items-center gap-[5px]">
      <span className="font-sans text-[11px] font-normal uppercase leading-normal text-(--text-tertiary)">{label}</span>
      <span className="mono truncate text-[11.5px] text-(--text-secondary)">{name}</span>
    </span>
  )
}

function Notice({ text }: { text: string }) {
  return (
    <div className="mb-[14px] flex items-center gap-2 rounded-md bg-(--surface-sunken) px-3 py-[10px] font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
      <Icon name="info" size={14} />
      {text}
    </div>
  )
}
