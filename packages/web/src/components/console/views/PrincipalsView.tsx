'use client'

// Principals (`/principals`) — design "isIdentity" (I1 Agent Identity v1). An
// org-owned execution identity: a named actor a run can be attributed to and
// that an operator can disable in one place. Where a schedule or standing item
// fires work, the principal is WHO the work runs as, and its grants are WHAT it
// may touch. Disabling bumps an authorization revision, so a stale executor
// still holding the old number is refused at the CP.
//
// Gated OFF by default (`principals` feature flag). An empty list is the normal
// answer for an org that has not adopted named identities yet — legacy synthetic
// principals never appear here; only the ones an operator creates do.

import { useState } from 'react'
import useSWR from 'swr'
import {
  createPrincipal,
  createPrincipalGrant,
  disablePrincipal,
  enablePrincipal,
  fetchPrincipalGrants,
  fetchPrincipals,
  revokePrincipalGrant,
  fmtDate,
  type PrincipalDto,
  type PrincipalGrantDto
} from '@/lib/api'
import { agentLabel } from '@/lib/data'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { useIsMobile } from '@/lib/use-is-mobile'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

const GRID = 'grid-cols-[2.2fr_1fr_1.3fr_1.2fr_0.9fr_auto] gap-3'
const GRANT_GRID = 'grid-cols-[1fr_2fr_1fr_1fr_52px] gap-3'

const KIND_LABEL: Record<PrincipalDto['kind'], string> = {
  agent: 'Agent',
  service: 'Service',
  delegated: 'Delegated'
}

function PrincipalStateBadge({ p }: { p: PrincipalDto }) {
  const on = p.state === 'active'
  return (
    <span
      className={`badge ${on ? 'bg-(--status-online-soft) text-(--status-online-text)' : 'bg-(--surface-active) text-(--text-secondary)'}`}
    >
      <span className={`dot h-[6px] w-[6px] ${on ? 'bg-(--status-online)' : 'bg-(--text-disabled)'}`} />
      {on ? 'Active' : 'Disabled'}
    </span>
  )
}

export default function PrincipalsView() {
  const isMobile = useIsMobile()
  if (!featureFlagEnabled('principals')) {
    return (
      <div className="card flex flex-col items-center gap-3 px-6 py-[44px] text-center">
        <span className="flex h-[46px] w-[46px] items-center justify-center rounded-[11px] border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon name="shield-check" size={22} color="var(--text-tertiary)" />
        </span>
        <div className="font-sans text-[15px] font-semibold leading-normal">Principals are not enabled</div>
        <div className="max-w-[420px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
          Named execution identities are an opt-in capability. Set the <span className="mono">principals</span> feature
          flag to manage who agent runs execute as and what they are granted.
        </div>
      </div>
    )
  }
  return isMobile ? <PrincipalsMobile /> : <PrincipalsDesktop />
}

function usePrincipals() {
  const { activeOrg, orgs, loading: orgLoading } = useOrgs()
  const waitingForOrg = orgLoading || (!activeOrg && orgs.length > 0)
  const orgKey = waitingForOrg ? null : (activeOrg?.id ?? null)
  const {
    data: principals = [],
    isLoading,
    mutate
  } = useSWR<PrincipalDto[]>(consoleKeys.principals(orgKey), ([, orgId]) => fetchPrincipals(orgId as string))
  return { orgKey, principals, loading: waitingForOrg || isLoading, mutate }
}

function useAgentName() {
  const { agents } = useConsoleData()
  return (p: PrincipalDto) => {
    if (!p.agentId) return '—'
    const owner = agents.find((a) => a.id === p.agentId)
    return owner ? agentLabel(owner) : p.agentId.slice(0, 8)
  }
}

function PrincipalsDesktop() {
  const { orgKey, principals, loading, mutate } = usePrincipals()
  const agentName = useAgentName()
  const [creating, setCreating] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <div className="wrap">
      <div className="mb-4 flex min-h-[34px] items-center gap-4">
        <div className="flex-1">
          <p className="psub mt-0">
            Named execution identities the organization owns. Each principal is who a run executes as; its grants are
            what that run may touch. Disabling one fences out any executor still running under its old authorization.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating((v) => !v)}>
          <Icon name={creating ? 'x' : 'plus'} size={15} />
          {creating ? 'Cancel' : 'New principal'}
        </Button>
      </div>

      {creating && (
        <CreateForm
          orgKey={orgKey}
          onDone={() => {
            setCreating(false)
            void mutate()
          }}
        />
      )}

      {loading && principals.length === 0 ? (
        <LoadingState fill />
      ) : principals.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="card">
          <div className={`row h ${GRID}`}>
            <span>Principal</span>
            <span>Kind</span>
            <span>Agent</span>
            <span>State</span>
            <span>Auth rev</span>
            <span>Actions</span>
          </div>
          {principals.map((p) => {
            const open = expanded === p.id
            return (
              <div key={p.id}>
                <div className={`row ${GRID}`}>
                  <div className="min-w-0">
                    <div className="truncate font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                      {p.name}
                    </div>
                    <div className="mt-[2px] truncate font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">
                      {p.id}
                    </div>
                  </div>
                  <span className="font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
                    {KIND_LABEL[p.kind]}
                  </span>
                  <span className="mono min-w-0 truncate text-[12px] text-(--text-secondary)">{agentName(p)}</span>
                  <span className="inline-flex min-w-0 flex-wrap items-center gap-[6px]">
                    <PrincipalStateBadge p={p} />
                  </span>
                  <span className="mono text-[12px] text-(--text-secondary)">{p.authorizationRevision}</span>
                  <div className="flex items-center justify-end gap-1">
                    <PrincipalActions p={p} onDone={() => void mutate()} />
                    <button
                      type="button"
                      aria-label={open ? 'Hide grants' : 'Show grants'}
                      onClick={() => setExpanded(open ? null : p.id)}
                      className="cursor-pointer border-0 bg-transparent p-1 text-(--text-tertiary)"
                    >
                      <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} />
                    </button>
                  </div>
                </div>
                {open && <GrantsPanel orgKey={orgKey} principal={p} onMutate={() => void mutate()} />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function PrincipalsMobile() {
  const { orgKey, principals, loading, mutate } = usePrincipals()
  const agentName = useAgentName()
  const [creating, setCreating] = useState(false)

  if (loading && principals.length === 0) return <LoadingState fill />
  if (principals.length === 0)
    return (
      <div className="px-4 py-3">
        <div className="mb-3">
          <Button size="sm" onClick={() => setCreating((v) => !v)}>
            <Icon name={creating ? 'x' : 'plus'} size={15} />
            {creating ? 'Cancel' : 'New principal'}
          </Button>
        </div>
        {creating && (
          <CreateForm
            orgKey={orgKey}
            onDone={() => {
              setCreating(false)
              void mutate()
            }}
          />
        )}
        <EmptyState />
      </div>
    )

  return (
    <div className="pb-6">
      <div className="flex items-center gap-2 px-4 pt-[14px] pb-1">
        <div className="flex-1" />
        <Button size="sm" onClick={() => setCreating((v) => !v)}>
          <Icon name={creating ? 'x' : 'plus'} size={15} />
          {creating ? 'Cancel' : 'New'}
        </Button>
      </div>
      {creating && (
        <div className="px-4">
          <CreateForm
            orgKey={orgKey}
            onDone={() => {
              setCreating(false)
              void mutate()
            }}
          />
        </div>
      )}
      <div className="mx-4 mt-3 overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs)">
        {principals.map((p, i) => (
          <div key={p.id} className={i === 0 ? '' : 'border-t border-(--border-subtle)'}>
            <div className="flex items-start gap-3 px-4 py-3">
              <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                <span className="truncate font-sans text-[14px] font-semibold leading-normal">{p.name}</span>
                <span className="truncate font-mono text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  {KIND_LABEL[p.kind]} · {agentName(p)}
                </span>
              </span>
              <span className="flex flex-none flex-col items-end gap-[4px]">
                <PrincipalStateBadge p={p} />
                <PrincipalActions p={p} onDone={() => void mutate()} />
              </span>
            </div>
            <GrantsPanel orgKey={orgKey} principal={p} onMutate={() => void mutate()} />
          </div>
        ))}
      </div>
    </div>
  )
}

function PrincipalActions({ p, onDone }: { p: PrincipalDto; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const toggle = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (p.state === 'active') await disablePrincipal(p.id)
      else await enablePrincipal(p.id)
      onDone()
    } finally {
      setBusy(false)
    }
  }
  const on = p.state === 'active'
  return (
    <Button variant={on ? 'danger' : 'secondary'} size="xs" disabled={busy} onClick={toggle}>
      <Icon name={on ? 'ban' : 'power'} size={13} />
      {on ? 'Disable' : 'Enable'}
    </Button>
  )
}

function CreateForm({ orgKey, onDone }: { orgKey: string | null; onDone: () => void }) {
  const { agents } = useConsoleData()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<PrincipalDto['kind']>('agent')
  const [agentId, setAgentId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = name.trim().length > 0 && (kind !== 'agent' || agentId.length > 0)

  const submit = async () => {
    if (!valid || busy || !orgKey) return
    setBusy(true)
    setError(null)
    try {
      await createPrincipal({ name: name.trim(), kind, agentId: kind === 'agent' ? agentId : undefined }, orgKey)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create principal')
      setBusy(false)
    }
  }

  return (
    <div className="card mb-4 p-4">
      <div className="fld">
        <span className="fldlbl">Name</span>
        <input
          className="inp"
          placeholder="nightly-audit-bot"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={128}
        />
      </div>
      <div className="fld mt-3">
        <span className="fldlbl">Kind</span>
        <select className="inp" value={kind} onChange={(e) => setKind(e.target.value as PrincipalDto['kind'])}>
          <option value="agent">Agent — bound to one agent</option>
          <option value="service">Service — a workload or integration</option>
          <option value="delegated">Delegated — acts on a human's behalf</option>
        </select>
      </div>
      {kind === 'agent' && (
        <div className="fld mt-3">
          <span className="fldlbl">Agent</span>
          <select className="inp" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">{agents.length === 0 ? 'No agents' : 'Choose an agent…'}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {agentLabel(a)}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && (
        <div className="mt-3 rounded-md border border-(--status-error) px-3 py-2 font-sans text-[12px] text-(--status-error)">
          {error}
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" disabled={!valid || busy} onClick={submit}>
          {busy ? 'Creating…' : 'Create principal'}
        </Button>
      </div>
    </div>
  )
}

function GrantsPanel({
  orgKey,
  principal,
  onMutate
}: {
  orgKey: string | null
  principal: PrincipalDto
  onMutate: () => void
}) {
  const {
    data: grants = [],
    mutate: mutateGrants,
    isLoading
  } = useSWR<PrincipalGrantDto[]>(consoleKeys.principalGrants(orgKey, principal.id), ([, orgId, , pid]) =>
    fetchPrincipalGrants(pid as string, orgId as string)
  )
  const refresh = () => {
    void mutateGrants()
    onMutate()
  }
  return (
    <div className="border-t border-(--border-subtle) bg-(--surface-sunken) px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <Icon name="key-round" size={13} color="var(--text-tertiary)" />
        <span className="font-sans text-[11.5px] font-semibold uppercase tracking-wide text-(--text-tertiary)">
          Grants
        </span>
      </div>
      {isLoading && grants.length === 0 ? (
        <div className="font-sans text-[12px] text-(--text-tertiary)">Loading grants…</div>
      ) : grants.length === 0 ? (
        <div className="font-sans text-[12px] text-(--text-tertiary)">
          No grants — this principal can act, but is bound to no resource yet.
        </div>
      ) : (
        <div className={`row h ${GRANT_GRID} !border-0 !bg-transparent px-0 py-0`}>
          <span>Resource</span>
          <span>Id</span>
          <span>Capability</span>
          <span>Expires</span>
          <span />
        </div>
      )}
      {grants.map((g) => (
        <GrantRow key={g.id} grant={g} onChanged={refresh} />
      ))}
      {principal.state === 'active' && (
        <AddGrantForm
          principalId={principal.id}
          onAdded={() => {
            void mutateGrants()
            onMutate()
          }}
        />
      )}
    </div>
  )
}

function GrantRow({ grant, onChanged }: { grant: PrincipalGrantDto; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const live = !grant.revokedAt
  const revoke = async () => {
    if (busy) return
    setBusy(true)
    try {
      await revokePrincipalGrant(grant.principalId, grant.id)
      onChanged()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={`row ${GRANT_GRID} !border-0 !bg-transparent px-0 py-[6px] ${live ? '' : 'opacity-55'}`}>
      <span className="font-sans text-[12px] font-normal leading-normal text-(--text-primary)">
        {grant.resourceType}
      </span>
      <span className="mono min-w-0 truncate text-[11.5px] text-(--text-secondary)" title={grant.resourceId}>
        {grant.resourceId}
      </span>
      <span className="font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
        {grant.capability}
      </span>
      <span className="mono text-[11px] text-(--text-tertiary)">
        {grant.revokedAt ? 'revoked' : grant.expiresAt ? fmtDate(grant.expiresAt) : 'never'}
      </span>
      <div className="flex items-center justify-end">
        {live ? (
          <Button variant="ghost" size="xs" disabled={busy} onClick={revoke}>
            <Icon name="ban" size={13} />
            Revoke
          </Button>
        ) : (
          <Icon name="check" size={14} color="var(--text-disabled)" />
        )}
      </div>
    </div>
  )
}

function AddGrantForm({ principalId, onAdded }: { principalId: string; onAdded: () => void }) {
  const [resourceType, setResourceType] = useState<PrincipalGrantDto['resourceType']>('repo')
  const [resourceId, setResourceId] = useState('')
  const [capability, setCapability] = useState<PrincipalGrantDto['capability']>('read')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = resourceId.trim().length > 0

  const add = async () => {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      await createPrincipalGrant(principalId, { resourceType, resourceId: resourceId.trim(), capability })
      setResourceId('')
      onAdded()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add grant')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-end gap-2">
        <select
          className="inp w-[130px]"
          value={resourceType}
          onChange={(e) => setResourceType(e.target.value as PrincipalGrantDto['resourceType'])}
          aria-label="Resource type"
        >
          <option value="repo">repo</option>
          <option value="destination">destination</option>
          <option value="tool">tool</option>
        </select>
        <input
          className="inp mn min-w-[160px] flex-1"
          placeholder="resource id"
          value={resourceId}
          onChange={(e) => setResourceId(e.target.value)}
          aria-label="Resource id"
        />
        <select
          className="inp w-[140px]"
          value={capability}
          onChange={(e) => setCapability(e.target.value as PrincipalGrantDto['capability'])}
          aria-label="Capability"
        >
          <option value="read">read</option>
          <option value="comment">comment</option>
          <option value="write">write</option>
          <option value="execute">execute</option>
          <option value="notify">notify</option>
        </select>
        <Button size="sm" disabled={!valid || busy} onClick={add}>
          <Icon name="plus" size={14} />
          {busy ? 'Adding…' : 'Add grant'}
        </Button>
      </div>
      {error && <div className="mt-2 font-sans text-[12px] text-(--status-error)">{error}</div>}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="card flex flex-col items-center gap-3 px-6 py-[44px] text-center">
      <span className="flex h-[46px] w-[46px] items-center justify-center rounded-[11px] border border-(--border-subtle) bg-(--surface-sunken)">
        <Icon name="shield-check" size={22} color="var(--text-tertiary)" />
      </span>
      <div className="font-sans text-[15px] font-semibold leading-normal">No principals yet</div>
      <div className="max-w-[420px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
        Create a named execution identity to attribute runs to an actor you can disable or grant from one place, rather
        than per schedule.
      </div>
    </div>
  )
}
