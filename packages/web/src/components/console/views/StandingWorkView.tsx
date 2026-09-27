'use client'

// Standing work (`/standing-work`) — design "isStandingWork". Durable ambient
// commitments: an agent keeps working a goal on a fixed schedule until it reports
// `complete` or the window expires. Where a schedule fires a prompt and forgets, a
// standing item carries state across runs, so this page is the operator's stop
// switch — inspect what it decided, pause it, cancel it. Creating and editing a
// definition lives with whoever holds the policies it names, not here.
//
// The CP stores definitions and the daemon-reported run history; the executing
// daemon stays authoritative on its data plane. An empty list is the normal answer
// where no daemon has standing work enabled.

import { useRouter } from 'next/navigation'
import { agentLabel } from '@/lib/data'
import type { StandingWorkDto } from '@/lib/api'
import { fmtDate } from '@/lib/api'
import { cronHuman } from '@/lib/cron'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { useIsMobile } from '@/lib/use-is-mobile'
import { LoadingState } from '@/components/marks'
import { Icon } from '@/components/ui'

const GRID = 'grid-cols-[2.2fr_1.1fr_1.5fr_1fr_1.1fr_1fr] gap-3'

// `active` is the only state that still spends agent turns; the rest are terminal
// or parked, and the badge says which.
const STATE_STYLE = {
  active: {
    label: 'Active',
    dot: 'bg-(--status-online)',
    text: 'text-(--status-online-text)',
    soft: 'bg-(--status-online-soft)'
  },
  paused: {
    label: 'Paused',
    dot: 'bg-(--status-paused)',
    text: 'text-(--text-secondary)',
    soft: 'bg-(--surface-active)'
  },
  completed: {
    label: 'Completed',
    dot: 'bg-(--text-disabled)',
    text: 'text-(--text-secondary)',
    soft: 'bg-(--surface-active)'
  },
  expired: {
    label: 'Expired',
    dot: 'bg-(--text-disabled)',
    text: 'text-(--text-secondary)',
    soft: 'bg-(--surface-active)'
  },
  cancelled: {
    label: 'Cancelled',
    dot: 'bg-(--status-error)',
    text: 'text-(--status-error)',
    soft: 'bg-(--surface-active)'
  }
} as const

export function StandingWorkStateBadge({ w }: { w: StandingWorkDto }) {
  const st = STATE_STYLE[w.state]
  return (
    <span className={`badge ${st.soft} ${st.text}`}>
      <span className={`dot h-[6px] w-[6px] ${st.dot}`} />
      {st.label}
    </span>
  )
}

/** Whether an owner has authorized THIS version to run. Any edit or state change
 *  re-opens it, so a pending badge is normal — not an error. */
export function StandingWorkApprovalBadge({ w }: { w: StandingWorkDto }) {
  if (w.approvalState === 'approved') return null
  return (
    <span
      className={`badge bg-(--surface-active) text-(--text-secondary) ${w.state === 'active' ? '' : 'opacity-60'}`}
      title={
        w.approvalState === 'pending' ? 'Waiting for an owner to approve this version' : 'An owner denied this version'
      }
    >
      <Icon name={w.approvalState === 'denied' ? 'shield-alert' : 'circle-question-mark'} size={11} />
      {w.approvalState === 'pending' ? 'Awaiting approval' : 'Denied'}
    </span>
  )
}

function fmtExpires(iso: string): string {
  const until = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(until)) return '—'
  if (until <= 0) return 'expired'
  const d = Math.ceil(until / 86_400_000)
  if (d <= 1) return '≤ 1 day'
  return `${d} days left`
}

export default function StandingWorkView() {
  const { standingWork, standingWorkLoading, agents } = useConsoleData()
  const router = useRouter()
  const { orgPath } = useOrgs()
  const isMobile = useIsMobile()

  const agentName = (w: StandingWorkDto) => {
    const owner = agents.find((a) => a.id === w.agentId)
    return owner ? agentLabel(owner) : w.agentId.slice(0, 8)
  }

  if (isMobile) {
    if (standingWorkLoading && standingWork.length === 0) return <LoadingState fill />
    if (standingWork.length === 0) return <EmptyState mobile />
    return (
      <div className="pb-6">
        <div className="mx-4 mt-3 overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs)">
          {standingWork.map((w, i) => (
            <button
              key={w.id}
              onClick={() => router.push(orgPath(`/standing-work/${w.id}`))}
              className={`flex w-full cursor-pointer items-start gap-3 bg-(--surface-card) px-4 py-3 text-left ${
                i === 0 ? '' : 'border-t border-(--border-subtle)'
              }`}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                <span className="truncate font-sans text-[14px] font-semibold leading-normal">{w.name}</span>
                <span className="truncate font-mono text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  {agentName(w)} · {cronHuman(w.schedule) ?? w.schedule}
                </span>
                <span className="truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                  {w.objective}
                </span>
              </span>
              <span className="flex flex-none flex-col items-end gap-[4px]">
                <StandingWorkStateBadge w={w} />
                <StandingWorkApprovalBadge w={w} />
              </span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="wrap">
      <div className="mb-4 flex min-h-[34px] items-center gap-4">
        <div className="flex-1">
          <p className="psub mt-0">
            Ambient work an agent carries on between runs — it keeps its goal, reports only what changed, and stops when
            it is done or its window expires.
          </p>
        </div>
      </div>

      {standingWorkLoading && standingWork.length === 0 ? (
        <LoadingState fill />
      ) : standingWork.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="card">
          <div className={`row h ${GRID}`}>
            <span>Work</span>
            <span>Agent</span>
            <span>Schedule</span>
            <span>State</span>
            <span>Window ends</span>
            <span>Updated</span>
          </div>
          {standingWork.map((w) => {
            const human = cronHuman(w.schedule)
            return (
              <div
                key={w.id}
                className={`row click ${GRID}`}
                onClick={() => router.push(orgPath(`/standing-work/${w.id}`))}
              >
                <div className="min-w-0">
                  <div className="truncate font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                    {w.name}
                  </div>
                  <div
                    className="mt-[2px] truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)"
                    title={w.objective}
                  >
                    {w.objective}
                  </div>
                </div>
                <span className="mono min-w-0 truncate text-[12px] text-(--text-secondary)">{agentName(w)}</span>
                <div className="min-w-0">
                  <span className="mono text-[12px] text-(--text-primary)">{w.schedule}</span>
                  <div className="mt-[2px] flex items-center gap-1 font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                    <span>{human ? `${human} · ${w.timezone}` : 'invalid expression'}</span>
                    {w.scheduleMode === 'adaptive' && (
                      <span className="rounded-sm bg-(--brand-soft) px-1 text-[10px] text-(--brand-soft-text)">
                        adaptive
                      </span>
                    )}
                    {w.wakeOnConversation && (
                      <span className="rounded-sm bg-(--brand-soft) px-1 text-[10px] text-(--brand-soft-text)">
                        wake
                      </span>
                    )}
                  </div>
                </div>
                <span className="inline-flex min-w-0 flex-wrap items-center gap-[6px]">
                  <StandingWorkStateBadge w={w} />
                  <StandingWorkApprovalBadge w={w} />
                </span>
                <span className="font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
                  {fmtExpires(w.expiresAt)}
                </span>
                <span className="mono text-[11.5px] text-(--text-tertiary)">{fmtDate(w.updatedAt)}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function EmptyState({ mobile }: { mobile?: boolean }) {
  const body = (
    <>
      <span className="flex h-[46px] w-[46px] items-center justify-center rounded-[11px] border border-(--border-subtle) bg-(--surface-sunken)">
        <Icon name="repeat" size={22} color="var(--text-tertiary)" />
      </span>
      <div className="font-sans text-[15px] font-semibold leading-normal">No standing work</div>
      <div className="max-w-[420px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
        Nothing is running ambient work for this organization. Agents take standing work from a conversation or an API
        call that commits them to a goal over time.
      </div>
    </>
  )
  return mobile ? (
    <div className="px-4 py-3">
      <div className="card flex flex-col items-center gap-3 px-6 py-[44px] text-center">{body}</div>
    </div>
  ) : (
    <div className="card flex flex-col items-center gap-3 px-6 py-[44px] text-center">{body}</div>
  )
}
