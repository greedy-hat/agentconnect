'use client'

// Audit (`/audit`) — the organization's execution trail (A1 Unified Audit, roadmap §6).
// One searchable, exportable record of what ran, who it ran as, and what it did
// outside: admission, tool intent and result, external effects and their receipts.
// Rows come from two writers — the Control Plane records its own decisions, a daemon
// drains its durable outbox — so `source` is a fact per row and one trace can cross
// both.
//
// Gated OFF by default (`audit` feature flag). Reads are owner-only at the CP: a
// non-owner's 403 surfaces as the error it is, never as an empty list.

import { useCallback, useMemo, useState } from 'react'
import useSWRInfinite from 'swr/infinite'
import { EXECUTION_AUDIT_KINDS } from '@agentconnect.md/protocol/execution-audit'
import { exportAuditEvents, fetchAuditEvents, type AuditEventDto, type AuditFilters, type AuditPage } from '@/lib/api'
import { agentLabel } from '@/lib/data'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { useIsMobile } from '@/lib/use-is-mobile'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

const GRID = 'grid-cols-[1.1fr_1.6fr_0.8fr_1.2fr_52px] gap-3'
const PAGE_LIMIT = 50

/** A kind is an enum slug, not a label; the console spells it out instead of mapping a table
 *  it would have to keep in step with two producers. */
function kindLabel(kind: string): string {
  const words = kind.replaceAll('_', ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Which kinds a daemon asserts about its own execution. The Control Plane's own control events
 *  appear in the table too — they are reached by trace or agent, not by this picker, because their
 *  enum lives in the CP's schema and a copy here would be a second source of truth. */
const DAEMON_KINDS: readonly string[] = EXECUTION_AUDIT_KINDS

/** Read to the second: which run fired, and in what order, is the question this page answers. */
function stamp(iso: string | null, fallback: string): string {
  const at = new Date(iso ?? fallback)
  if (Number.isNaN(at.getTime())) return '—'
  return `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${at.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })}`
}

type AuditPageKey = NonNullable<ReturnType<typeof consoleKeys.audit>>

/** The trail, paged by the CP's ingestion-id cursor. */
function useAuditList(orgId: string | null, filters: AuditFilters) {
  const kinds = filters.kinds ?? ''
  const traceId = filters.traceId ?? ''
  const agentId = filters.agentId ?? ''
  const getKey = useCallback(
    (pageIndex: number, previousPage: AuditPage | null) => {
      if (!orgId) return null
      if (previousPage && !previousPage.nextCursor) return null
      return consoleKeys.audit(
        orgId,
        pageIndex === 0 ? '' : (previousPage?.nextCursor ?? ''),
        String(PAGE_LIMIT),
        kinds,
        traceId,
        agentId
      )
    },
    [agentId, kinds, orgId, traceId]
  )
  const {
    data: pages = [],
    error,
    isLoading,
    isValidating,
    size,
    setSize
  } = useSWRInfinite<AuditPage>(
    getKey,
    (args) => {
      const [, keyOrgId, , cursor, limit, keyKinds, keyTraceId, keyAgentId] = args as AuditPageKey
      return fetchAuditEvents(cursor || undefined, Number(limit), keyOrgId, {
        ...(keyKinds ? { kinds: keyKinds } : {}),
        ...(keyTraceId ? { traceId: keyTraceId } : {}),
        ...(keyAgentId ? { agentId: keyAgentId } : {})
      })
    },
    {
      // The feed only grows, so revalidating from page one cannot change a row it already
      // answered — but it keeps a cursor boundary from pointing past a page that has shifted.
      revalidateAll: true,
      persistSize: false,
      parallel: false
    }
  )
  const events = useMemo(() => {
    const byId = new Map<string, AuditEventDto>()
    for (const page of pages) for (const event of page.events) byId.set(event.id, event)
    return [...byId.values()]
  }, [pages])
  const hasMore = pages.at(-1)?.nextCursor != null
  const loadingMore = isValidating && size > pages.length
  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore) return
    try {
      await setSize(pages.length + 1)
    } catch {
      // SWR keeps the loaded rows and surfaces the failed page through `error`.
    }
  }, [hasMore, loadingMore, pages.length, setSize])
  return { events, error, isLoading, hasMore, loadingMore, loadMore }
}

export default function AuditView() {
  const isMobile = useIsMobile()
  if (!featureFlagEnabled('audit')) return <NotEnabled />
  return isMobile ? <AuditMobile /> : <AuditDesktop />
}

function useOrgKey(): string | null {
  const { activeOrg, orgs, loading } = useOrgs()
  return loading || (!activeOrg && orgs.length > 0) ? null : (activeOrg?.id ?? null)
}

function AuditDesktop() {
  const orgKey = useOrgKey()
  const [filters, setFilters] = useState<AuditFilters>({})
  const { events, error, isLoading, hasMore, loadingMore, loadMore } = useAuditList(orgKey, filters)
  const [open, setOpen] = useState<string | null>(null)

  return (
    <div className="wrap">
      <div className="mb-4 flex min-h-[34px] items-center gap-4">
        <div className="flex-1">
          <p className="psub mt-0">
            What ran, who it ran as, and what it did outside. Organization owners only. Search by kind, agent or trace
            id, or export the filtered trail as JSON.
          </p>
        </div>
      </div>
      <FilterBar orgKey={orgKey} filters={filters} onChange={setFilters} />
      {error && <ErrorBox error={error} />}
      {orgKey && isLoading && events.length === 0 ? (
        <LoadingState fill />
      ) : events.length === 0 ? (
        // A failed read has already said so above; claiming "no events" underneath it would
        // tell an owner their trail is empty when the real answer is that they cannot see it.
        error ? null : (
          <EmptyState filtered={Object.values(filters).some(Boolean)} />
        )
      ) : (
        <div className="card">
          <div className={`row h ${GRID}`}>
            <span>When</span>
            <span>Event</span>
            <span>Source</span>
            <span>Attribution</span>
            <span />
          </div>
          {events.map((e) => {
            const expanded = open === e.id
            return (
              <div key={e.id}>
                <div className={`row ${GRID}`}>
                  <span className="mono truncate text-[12px] text-(--text-secondary)">
                    {stamp(e.occurredAt, e.createdAt)}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                      {kindLabel(e.kind)}
                    </div>
                    {e.message && e.message !== e.kind && (
                      <div className="mt-[2px] truncate font-sans text-[11px] text-(--text-tertiary)">{e.message}</div>
                    )}
                  </div>
                  <SourceBadge source={e.source} />
                  <Attribution event={e} />
                  <div className="flex justify-end">
                    <button
                      type="button"
                      aria-label={expanded ? 'Hide event detail' : 'Show event detail'}
                      onClick={() => setOpen(expanded ? null : e.id)}
                      className="cursor-pointer border-0 bg-transparent p-1 text-(--text-tertiary)"
                    >
                      <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={16} />
                    </button>
                  </div>
                </div>
                {expanded && <EventDetail event={e} />}
              </div>
            )
          })}
          {hasMore && (
            <div className="mt-3 flex justify-center pb-3">
              <button className="lnk text-[12px]" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function AuditMobile() {
  const orgKey = useOrgKey()
  const [filters, setFilters] = useState<AuditFilters>({})
  const { events, error, isLoading, hasMore, loadingMore, loadMore } = useAuditList(orgKey, filters)

  if (orgKey && isLoading && events.length === 0) return <LoadingState fill />
  return (
    <div className="pb-6">
      <div className="px-4 pt-[14px]">
        <FilterBar orgKey={orgKey} filters={filters} onChange={setFilters} />
      </div>
      {error && (
        <div className="px-4">
          <ErrorBox error={error} />
        </div>
      )}
      {events.length === 0 ? (
        error ? null : (
          <div className="px-4">
            <EmptyState filtered={Object.values(filters).some(Boolean)} />
          </div>
        )
      ) : (
        <>
          <div className="mx-4 mt-3 overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs)">
            {events.map((e, i) => (
              <div key={e.id} className={i === 0 ? '' : 'border-t border-(--border-subtle)'}>
                <div className="flex items-start gap-3 px-4 py-3">
                  <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                    <span className="truncate font-sans text-[14px] font-semibold leading-normal">
                      {kindLabel(e.kind)}
                    </span>
                    <span className="truncate font-mono text-[12px] font-normal leading-normal text-(--text-tertiary)">
                      {stamp(e.occurredAt, e.createdAt)} · {e.source === 'daemon' ? 'Daemon' : 'Control plane'}
                    </span>
                    <Attribution event={e} />
                  </span>
                </div>
                <EventDetail event={e} compact />
              </div>
            ))}
          </div>
          {hasMore && (
            <div className="mt-3 flex justify-center">
              <Button variant="secondary" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function FilterBar({
  orgKey,
  filters,
  onChange
}: {
  orgKey: string | null
  filters: AuditFilters
  onChange: (next: AuditFilters) => void
}) {
  const { agents } = useConsoleData()
  const [trace, setTrace] = useState(filters.traceId ?? '')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const set = (next: Partial<AuditFilters>) => onChange({ ...filters, ...next })
  const runExport = async () => {
    if (!orgKey || exporting) return
    setExporting(true)
    setExportError(null)
    try {
      const dump = await exportAuditEvents(orgKey, filters)
      downloadJson(dump)
      if (dump.truncated) setExportError('The export hit the server ceiling; narrow the search for the rest.')
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="card mb-4 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="fld min-w-[190px] flex-1">
          <span className="fldlbl">Kind</span>
          <select
            className="inp"
            value={filters.kinds ?? ''}
            onChange={(e) => set({ kinds: e.target.value || undefined })}
          >
            <option value="">All events</option>
            <optgroup label="Daemon execution">
              {DAEMON_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kindLabel(kind)}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        <div className="fld min-w-[190px] flex-1">
          <span className="fldlbl">Agent</span>
          <select
            className="inp"
            value={filters.agentId ?? ''}
            onChange={(e) => set({ agentId: e.target.value || undefined })}
          >
            <option value="">{agents.length === 0 ? 'No agents' : 'Any agent'}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {agentLabel(a)}
              </option>
            ))}
          </select>
        </div>
        <div className="fld min-w-[220px] flex-[1.4]">
          <span className="fldlbl">Trace id</span>
          <div className="flex gap-2">
            <input
              className="inp"
              placeholder="one run, end to end"
              value={trace}
              onChange={(e) => setTrace(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') set({ traceId: trace.trim() || undefined })
              }}
            />
            <Button variant="secondary" size="sm" onClick={() => set({ traceId: trace.trim() || undefined })}>
              Search
            </Button>
          </div>
        </div>
        <Button size="sm" disabled={!orgKey || exporting} onClick={() => void runExport()}>
          <Icon name="download" size={15} />
          {exporting ? 'Exporting…' : 'Export JSON'}
        </Button>
      </div>
      {exportError && <div className="mt-3 font-sans text-[12px] text-(--status-error)">{exportError}</div>}
    </div>
  )
}

/** The whole causal envelope, in the open — a row is only useful if its parent and its effect are. */
function EventDetail({ event, compact = false }: { event: AuditEventDto; compact?: boolean }) {
  const ids: Array<[string, string | null]> = [
    ['Event', event.eventId],
    ['Trace', event.traceId],
    ['Parent', event.parentEventId],
    ['Effect', event.effectId],
    ['Session', event.sessionId],
    ['Daemon', event.daemonId]
  ]
  return (
    <div className={`grid ${GRID} px-4 pb-3`}>
      <div className="col-span-full flex flex-col gap-[3px] rounded-md border border-(--border-subtle) bg-(--surface-sunken) p-3">
        {ids
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label} className="flex min-w-0 gap-2">
              <span className="w-[62px] flex-none font-sans text-[11px] uppercase text-(--text-tertiary)">{label}</span>
              <span className={`mono min-w-0 truncate text-[11px] text-(--text-secondary)`}>
                {compact && value ? value.slice(0, 12) : value}
              </span>
            </div>
          ))}
        {event.details !== null && event.details !== undefined && (
          <pre className="mono mt-1 max-h-[180px] overflow-auto whitespace-pre-wrap break-all text-[11px] leading-[1.5] text-(--text-secondary)">
            {JSON.stringify(event.details, null, 2)}
          </pre>
        )}
      </div>
    </div>
  )
}

function Attribution({ event }: { event: AuditEventDto }) {
  const { agents } = useConsoleData()
  const agent = event.agentId ? agents.find((a) => a.id === event.agentId) : undefined
  const who = agent ? agentLabel(agent) : (event.agentId ?? event.actorUserId ?? event.principalId)
  if (!who) return <span className="text-[12px] text-(--text-disabled)">Unattributed</span>
  return (
    <div className="min-w-0">
      <div className="truncate font-sans text-[12px] leading-normal text-(--text-secondary)">{who}</div>
      {event.principalId && (
        <div className="mt-[2px] truncate font-mono text-[11px] text-(--text-tertiary)">
          as {event.principalId.slice(0, 8)}
        </div>
      )}
    </div>
  )
}

function SourceBadge({ source }: { source: AuditEventDto['source'] }) {
  const daemon = source === 'daemon'
  return (
    <span
      className={`badge ${daemon ? 'bg-(--status-online-soft) text-(--status-online-text)' : 'bg-(--surface-active) text-(--text-secondary)'}`}
    >
      <span className={`dot h-[6px] w-[6px] ${daemon ? 'bg-(--status-online)' : 'bg-(--text-disabled)'}`} />
      {daemon ? 'Daemon' : 'CP'}
    </span>
  )
}

function ErrorBox({ error }: { error: unknown }) {
  return (
    <div className="mb-4 rounded-md border border-(--status-error) px-3 py-2 font-sans text-[12px] text-(--status-error)">
      {error instanceof Error ? error.message : 'The audit trail could not be read.'}
    </div>
  )
}

function downloadJson(dump: { events: AuditEventDto[]; truncated: boolean; exportedAt: string }): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `agentconnect-audit-${dump.exportedAt.slice(0, 10)}.json`
  link.click()
  URL.revokeObjectURL(url)
}

function NotEnabled() {
  return (
    <div className="wrap">
      <div className="card flex flex-col items-center gap-3 px-6 py-[44px] text-center">
        <span className="flex h-[46px] w-[46px] items-center justify-center rounded-[11px] border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon name="scroll-text" size={22} color="var(--text-tertiary)" />
        </span>
        <div className="font-sans text-[15px] font-semibold leading-normal">Audit is not enabled</div>
        <div className="max-w-[420px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
          The execution trail API is served either way; this deployment has not offered the console surface. Set the{' '}
          <span className="mono">audit</span> feature flag to search and export it.
        </div>
      </div>
    </div>
  )
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="card flex flex-col items-center gap-3 px-6 py-[44px] text-center">
      <span className="flex h-[46px] w-[46px] items-center justify-center rounded-[11px] border border-(--border-subtle) bg-(--surface-sunken)">
        <Icon name="scroll-text" size={22} color="var(--text-tertiary)" />
      </span>
      <div className="font-sans text-[15px] font-semibold leading-normal">
        {filtered ? 'Nothing matches this search' : 'No audit events yet'}
      </div>
      <div className="max-w-[440px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
        {filtered
          ? 'Widen the kind, clear the agent, or search a trace id from a run you already know about.'
          : 'The trail records control-plane decisions now, and an agent execution as soon as its daemon drains its audit outbox.'}
      </div>
    </div>
  )
}
