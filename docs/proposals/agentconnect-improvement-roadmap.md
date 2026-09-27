# AgentConnect Improvement Roadmap

> Status: branch inspection snapshot, 2026-09-27, for
> `proposal/conversation-session-and-standing-work`. This is implementation state,
> not a production-release claim. C1–C7 are implementation-complete and now need
> release evidence rather than architectural rework. W1–W5 form a real Standing Work
> vertical slice; W6 remains blocked by contract correctness, live authority/policy
> enforcement, production enablement, and failure-injection evidence. W7 is an
> experimental follow-on and does not block fixed-schedule V1. Principal management
> exists but runtime enforcement is not closed. Audit has a durable pipeline and
> console, but production enablement, fail-closed effect intent, and wider coverage
> remain open. Execution and execution audit are OFF by default, and no production
> CLI/environment wiring was found. Requirements below describe the target contract
> unless explicitly identified as implemented. See
> [next steps and acceptance evidence](agentconnect-next-steps.md).

## 1. Product goals and delivery strategy

The complete roadmap has eight product tracks:

1. **Conversation-native persistent sessions** ✅ (implementation complete; release evidence pending): make channel/thread continuity a supported product.
2. **Ambient / standing work** 🟡 (W1–W5 core implemented; W6 release blocked; W7 experimental; execution OFF): durable objectives built on scheduler, conversation, and webhook primitives.
3. **Agent Identity v1** 🟡 (management plane implemented; enforcement plane incomplete): organization-owned principals, grants, provider bindings, and revocation.
4. **Unified Audit** 🟡 (durable pipeline/search/export/UI implemented; fail-closed intent, production enablement, and broader coverage open): provenance from task admission through tools, network access, and external effects.
5. **Budgets & quotas** 🔴 (flat limits only, no hierarchy): Org → Agent → Conversation / Schedule / Standing Work, with hard caps and alerts.
6. **Memory scopes + provenance** 🟡 (agent-scoped done, scope hierarchy missing): conversation, workspace, and organization memory with administrative controls.
7. **Sandbox hardening** 🟡 (3 backends done, network policy + macOS remain): close production blockers and enforce execution and credential boundaries.
8. **ACP v2 convergence** 🔴 (not started): use negotiated standard runtime capabilities and reduce proprietary remote protocol.

Product priority is not the same as the immediate release order. Before adding more autonomous
surface area, the current branch should close these cross-cutting gates in order:

1. **Correctness closure** — preserve and enforce every safety-relevant projected field,
   starting with `minIntervalSeconds`.
2. **Authority closure** — Principal/Grant state must fence creation, admission, context reads,
   and external effects, including disable/revoke races.
3. **Policy enforcement closure** — resolve and enforce budget/tool/notification/visibility
   policy references, or remove claims that the runtime enforces them.
4. **Production enablement** — wire explicit operator configuration and advertise capabilities
   only when the corresponding runtime path is actually enabled.
5. **Release evidence** — fault-injection, takeover, stale-executor, uncertain-effect, revocation,
   and mixed-version tests become release gates.
6. **Engineering hardening** — split current complexity hotspots along existing domain seams
   without changing the deployment model or rewriting working state machines.

This is product priority, not an instruction to defer all safety and reliability work until
its numbered track. Minimal identity, audit, budget, audience, and sandbox contracts are
prerequisites for releasing autonomous work. Their full management products can follow.
Production-blocking sandbox issues are release blockers from the beginning. References
such as #2176, #1874, and #2013 are motivation, not evidence that an issue is still open;
verify their current status when planning an implementation or release.

Reuse daemon-owned execution, durable inboxes, serial admission, scheduler infrastructure,
proactive messaging, memory, duty placement, and self-hosted execution. Each release must
work independently; do not require all eight tracks to ship before delivering sessions.

## 2. Shared contracts

### Identity and provenance

Use stable identifiers for organization, agent, execution principal, conversation, session,
work definition, run, tool call, and external effect. Distinguish the requesting human,
the organization principal executing the work, and the credential used at the provider.
Never treat an agent display name or the first conversation sender as authorization.

Every admitted run carries trusted context equivalent to:

```text
orgId, agentId, principalId
conversationRef?, sessionId, workId?, runId
actorId?, authorizationRevision, definitionVersion?
traceId, parentEventId?, budgetReservationId?, executionEpoch
```

A conversation reference includes provider/platform, integration or physical transport
scope, and channel; a delivery destination additionally includes the physical thread.
Neither a logical session id nor a user-supplied tool argument grants destination access.
All persistence keys must be isolated by organization and provider/transport namespace,
whether explicitly in columns or through an established scoped store/key encoding.

### Authority and lifecycle

The control plane owns definitions, principals, policy revisions, grants, and desired
lifecycle state. Daemons own execution under a valid serving placement and execution
lease. Completion is a durable, idempotent event reconciled to the control plane; an old
run cannot reactivate or complete a newly edited definition.

Authorization is checked at creation, run admission, and before an external effect.
Permission revocation, pause, cancellation, expiration, and definition changes invalidate
old execution authority. Provider operations already accepted cannot be recalled; audit
such races. No new operation may be authorized using a stale revision once invalidated.
For disconnected operation, bounded leases define the maximum revocation delay. When a
lease expires or authority cannot be established, defer effects and new autonomous runs.

### Rollout

Feature-gate each new wire behavior. Check all eligible placements and shared-bot siblings,
and fence both register snapshots and live pushes. Unsupported or unknown capability
fails closed. Do not silently reinterpret a configured feature as legacy behavior.

### Contract fidelity and module boundaries

A safety-relevant concept may have distinct HTTP, domain, persistence, wire, daemon-domain,
and daemon-persistence representations, but every boundary crossing is an explicit mapping.
No projected field may disappear silently. Add mapping/round-trip contract tests for authority,
intervals, budgets, policies, expiry, destination, and effect identity so schema evolution
fails loudly instead of degrading semantics.

Keep the current monorepo/process boundaries. Engineering hardening means smaller cohesive
modules, not microservices or framework-heavy indirection. In particular:

- `LocalStore` keeps the shared database/transaction seam but domain persistence moves behind
  focused stores/repositories for sessions, transcripts, append reservations, Standing Work,
  audit outbox, memory, and related concerns.
- `daemon.ts` is a composition root: lifecycle and dependency wiring belong there; provider/
  Claude ambient execution details belong in runtime adapters.
- Standing Work keeps its existing state machine, leases, epochs, and outbox semantics while
  definition/scheduling/execution/delivery/wake code moves into cohesive modules.
- Control-plane HTTP routes validate transport input and delegate business orchestration to
  application services instead of accumulating lifecycle, authorization, persistence, and
  projection logic in one route file.
- Web data access becomes feature-local queries/mutations instead of continuing to expand a
  single `api.ts` and global `ConsoleData` context.

Security policy is capability-based. Tool/effect metadata should become typed and bounded;
tool names or regex matching may remain defense-in-depth but cannot be the primary authority
model. Audit detail bags must be size-bounded and increasingly typed/allow-listed rather than
depending only on blacklist redaction.

## 3. Conversation-native persistent sessions — IMPLEMENTATION COMPLETE / RELEASE EVIDENCE PENDING

> Status 2026-09-27: C1–C7 are implemented. The daemon advertises
> `conversation-session-mode-v1`; delivery/session coordinate separation,
> append reservation with a persisted monotonic clock, durable replay, reset CAS,
> and physical-thread affinity are present in code. Do not redesign this subsystem
> for the Claude Tag transition. Remaining work is release evidence: migration and
> replay matrices, concurrent first-admission/reset races, retention/GC interactions,
> multi-agent fan-out, mode transitions with queued work, mixed-version rollout, and
> provider-specific physical-thread affinity. This inspection does not establish
> deployment or production rollout status.

### Coordinates and defaults

```ts
interface SessionCoordinates {
  readonly deliveryThread: string
  readonly sessionThread: string
}
```

`createNew` preserves today's physical-thread session identity. `append` resolves one
logical `append:<monotonic timestamp>` coordinate per agent and conversation while each
reply/status goes to the physical thread that triggered it. Trigger policy
`off | mention | any` remains independent of session policy `createNew | append`.

Keep **Per thread** as the default, including Slack. **Continuous** is opt-in for dedicated
project or operations channels. One continuous session has one serial queue, so unrelated
threads share context and may wait behind a long turn. Explain this in the control's help
and show queue state. Do not expose the control for DMs/group DMs in the first release.
Topic classification or automatic session selection is a separate later design.

### Reservation and admission

The durable reservation is keyed by `(agentId, channel, transportScope)` within the store's
organization/provider namespace. Resolve atomically with insert-if-absent then read the
winner. Mint using `max(now, previousMax + 1)` with a persisted high-water mark that survives
session and reservation deletion; wall time alone is not a uniqueness guarantee.

Resolve once per target, after routing and before durable admission or serial gate
selection. Carry coordinates in trusted `QueueEntry` metadata, never in provider-authored
`NormalizedMessage`. Session keys, transcript identity, observer matching, commands, and
runtime ownership consume the carried logical coordinate.

Persist both resolved coordinates in the inbox. Replay uses the admitted coordinate even
if the mode or reservation has since changed. Legacy rows without coordinates retain
legacy per-thread semantics; never resolve them against today's append reservation.
Migration and replay must preserve existing ordering and hook delivery fences.

### Physical participation and history

Record `(channel, physicalThread, agentId, transportScope)` participation on delivered
inbound messages and successful outbound posts. For providers that create a thread while
posting, record the returned physical thread. Resolve affinity independently of the
logical session row, including after `!new`; test routing and multi-agent peer fan-out.

Append transcripts use the logical coordinate, with original provider message, sender,
physical thread, transport scope, and event identity retained as provenance. Observation
must honor the agent's audience and routing permissions; append does not authorize reading
all organization conversations. Deduplicate provider redeliveries before transcript fan-out.
Do not query a provider using an `append:` coordinate as a physical thread id.

Bound prompt refresh, transcript API reads, and console rendering through cursor pagination.
Define transcript retention separately from runtime-session retention. Delete a reservation
only if it still names the deleted session, in the same transaction. Protect admitted or
running work from GC until it drains. Do not infer stale reservations from a missing
session row: reservation creation legitimately precedes session creation.

### Reset, mode transitions, and audience

`!new` in append mode rotates the reservation using CAS. A loser rereads the winner without
retrying the advance. This coalesces resets that observed the same generation; a later
command that observed a new generation is a separate reset. Stable command-event deduplication
prevents a retried command from advancing twice.

Already admitted and running turns retain their old coordinate and finish in their own
physical destinations. Later admissions use the new coordinate. This can temporarily leave
old and new generations executing concurrently; shared workspace writes must retain their
existing independent workspace/resource locking. Reset does not grant concurrent write safety.
Reply text explains that the reset affects this agent's whole continuous channel. Commands
must expose old outstanding work by explicit session/run identity so it remains cancellable.

In createNew, clear context in place only while idle, retain workspace and session identity,
and set a reset boundary that prevents replay of pre-reset messages. Record a reset event
visible in the session timeline. Reset does not delete memory or cancel Standing Work.

Mode changes do not migrate transcripts or retarget admitted messages. Switching back to
append resumes the existing reservation if retained; if GC removed it, resolve a fresh one.
The UI explains this and offers `!new` for a fresh generation. Audit every change/reset.

Append sessions are labeled by conversation and generation start, not attributed as owned
by the first speaker. Their audience follows the authorized conversation policy, including
private channels and membership changes. An individual sender cannot privatize or broaden
a shared append session. Reuse existing audience enforcement; do not assume every channel
is organization-public. Enforce the same restrictions on console reads, continuation, and
memory capture.

### Implementation baseline — release evidence scope

`conversation-session-mode-v1` is advertised. Coordinate persistence/replay,
physical participation, command/reset semantics, audience enforcement, bounded
history, and mixed-version fences are in place. Existing createNew routing
remains the intended compatibility contract. The complete session acceptance suite
was not rerun in the 2026-09-26 inspection.

## 4. Ambient / standing work

> Status 2026-09-27: W1–W5 are a real vertical slice rather than a design-only
> proposal: CP definitions/projections, daemon durable scheduling, claims/leases,
> isolated ambient execution, structured reports, notification outbox/delivery,
> run reporting, and console inspection/control are present. W6 is not release-ready.
> A concrete correctness blocker exists: CP/wire carry `minIntervalSeconds`, but the
> daemon durable definition does not persist it and current adaptive/wake code derives
> an effective minimum from `maxIntervalSeconds` with a 60-second cap. Policy refs are
> projected but not fully resolved/enforced at runtime. Execution requires
> `standingWorkExecution === true`; no production CLI/environment wiring was found.
> W7 has adaptive scheduling and a conversation-wake entry point, but bounded
> coalescing, durable pending wakes, trusted loop provenance, webhook admission, and
> configured interval enforcement remain incomplete. W7 does not block fixed-schedule
> V1. The `standing-work` console flag only hides/shows UI, not CP APIs.
> See [W1–W6 gates](standing-work-w1-w6-completion-plan.md) and
> [W7 implementation gaps](standing-work-w7-adaptive-wakes-plan.md).

### Product contract

A Standing Work item is a durable objective with lifecycle, execution state, bounded spend,
and explicit notification policy. Cron and webhooks remain trigger primitives; they do not
become the objective itself. Example: “Watch this rollout; warn on failure or an hour without
progress; stop when it recovers.” The condition and observation state must survive restart.

V1 ships fixed schedules, explicit finite expiry, pause/resume/cancel, a run timeline, and
one approved notification destination. Adaptive scheduling and conversation wakes are later
increments using the same contracts. The complete design below covers both.

### Fixed V1 release-critical gaps

Before W6 can ship, preserve `minIntervalSeconds` in daemon durable state and use the configured
value in both adaptive scheduling and conversation-wake admission. Add migration/restart tests
that prove values such as min=3600/max=86400 survive projection, persistence, restart, and wake.

Close authority at three points: definition create/edit, run admission/context read, and every
external effect. Principal disable or grant revoke must advance/reconcile authority so stale
work cannot continue solely because it has an older projected revision.

The CP/wire fields `budgetPolicyRef`, `toolPolicyRef`, `notificationPolicy`, and
`visibilityPolicyRef` currently promise more semantics than the daemon demonstrably enforces.
Either resolve and enforce them for V1 or narrow the V1 contract. Do not add more policy fields
until existing references have executable meaning.

Add production operator wiring for `standingWorkExecution` and `executionAudit`, while
retaining fail-closed capability advertisement. Fixed V1 then requires crash/takeover,
pause/cancel/edit/revoke-during-run, notification-uncertainty, and shared-store fencing tests.

### Control-plane definition

The control plane and wire already implement the core logical fields below. Daemon mappings
must preserve their semantics rather than silently dropping fields:

```text
StandingWork
  id, orgId, agentId, principalId
  name, objective
  state: active | paused | completed | expired | cancelled
  definitionVersion                 # incremented on edits and lifecycle changes
  conversationRef?                   # authorized context source
  targetDestination                  # provider, integration, channel, optional thread
  scheduleMode: fixed | adaptive
  fixedSchedule?, timezone
  startAt, expiresAt                 # finite by default; org policy caps lifetime
  minIntervalSeconds, maxIntervalSeconds
  maxRunsPerDay, maxNotificationsPerDay
  budgetPolicyRef, toolPolicyRef, notificationPolicy
  wakeOnConversation: false          # opt-in after wake support ships
  visibilityPolicyRef
  createdByActorId, lastModifiedByActorId, sourceSessionId?
  createdAt, updatedAt
```

Validate positive intervals, min ≤ max, future expiry, valid timezone/schedule, destination
access, and compatible schedule fields. Fixed schedules must respect minimum frequency too.
Missing numerical limits inherit finite organization defaults, never implicit unlimited spend.
Approval binds to the definition version and effective limits; widening authority, destination,
lifetime, or spend requires policy evaluation and renewed approval when policy requires it.

### Durable execution and handoff

```text
standing_work_state
  orgId, workId, appliedDefinitionVersion
  nextCheckAt, lastRunAt, lastNotifiedAt
  contextCursor, observationState, observationSchemaVersion
  executionEpoch, leaseOwner, leaseExpiresAt

standing_work_run
  orgId, workId, runId, definitionVersion, occurrenceId, dueAt
  executionEpoch, attempt, status, startedAt, finishedAt
  outcome, sessionId, budgetReservationId, errorCode?
  UNIQUE(orgId, workId, definitionVersion, occurrenceId)
```

`occurrenceId` is a persisted schedule occurrence/generation; changing a debounce timestamp
does not create a new occurrence on every message. A unique key deduplicates records, not
execution. Claim a run atomically under the current duty holder, lease, and fencing epoch.
Lease renewal and takeover must use the existing placement authority. A stale executor may
not commit results, enqueue notifications, or consume new authority after takeover.

State required for deduplication, observation, outbox delivery, and accounting must be
available to the successor: shared durable storage or acknowledged fenced transfer. Separate
local SQLite files do not provide fleet-wide uniqueness. If state is unavailable, suspend
handoff execution rather than claiming exactly-once recovery.

Allow at most one active run per work. A wake during a run records pending context and one
coalesced next occurrence. Persist state and outcome transactionally. Retry failed attempts
under the same logical run/occurrence with bounded backoff; reuse effect identities and do
not repeat an uncertain effect blindly. Recover expired leases; cap retries and expose a
blocked reason rather than spinning. Across downtime, run at most one coalesced catch-up,
then return to the current schedule. Expired/cancelled work never catches up.

### Scheduling

Generalize the existing scheduler to support durable one-shot due jobs as well as cron.
The persisted next due time is authoritative; an in-memory timer is only a wake mechanism.
In adaptive mode accept the model's time as a suggestion, parse it, and clamp it to:

```text
now + minIntervalSeconds <= nextCheckAt <= now + maxIntervalSeconds
```

Then apply cooldown, budget availability, retry backoff, and expiry. These constraints take
precedence over the maximum interval: if no legal run exists, expose the delay or expiry.
Use a deterministic default for absent/invalid suggestions. Revalidate at admission.

### Context and silent execution

Bind work to a conversation without requiring the same live ACP session. Each work has an
independent execution session and durable observation state. Read a bounded, authorized
slice of human context after `contextCursor`, together with relevant previous observations.
This supports both createNew and append and avoids blocking a human session with polling.
Advance the cursor with committed observation state, not merely after reading messages.
Record source event ids and timestamps; unavailable context is reported as unavailable.

A conversation `!new` resets human session context; it neither cancels work nor erases its
objective/state. Conversation-bound work continues following authorized new conversation
events. Users stop it with pause/cancel. Revoked access blocks further context reads/effects.

Ambient execution has no normal outward final reply, status chatter, or unrestricted
`sendMessage`. Enforce this in turn output and tool/credential policy. Shell, network, and
other tools must not provide an alternate unauthorized write path. V1 is read-only checking
plus the controlled notification dispatcher. Future mutating work requires explicit grants,
effect-specific policy, and the same audit/budget boundaries.

```ts
reportStandingWork({
  outcome: 'no_change' | 'notify' | 'blocked' | 'complete',
  summary?: string,
  notification?: string,
  nextCheckAt?: string
})
```

Work/run identity comes from trusted execution context. Accept one terminal report per run;
retries return its recorded result. `no_change` stays silent; `notify` creates a notification
intent; `blocked` records a reason and may notify under policy; `complete` disarms further
checks and may create a final notification. Missing reports, malformed output, and timeouts
are bounded failed attempts, not implicit success or permission to publish final model text.

### Notification outbox and delivery semantics

Commit outcome, observation state, next schedule/completion event, and any notification
intent in one storage transaction. Network delivery is outside that transaction.

```text
notification_outbox
  orgId, workId, runId, notificationIndex, effectId
  definitionVersion, destination, payload, payloadHash
  status: pending | sending | delivered | uncertain | failed | suppressed
  attempt, nextAttemptAt, providerReceipt?, lastError?
  UNIQUE(orgId, runId, notificationIndex)
```

Before sending, revalidate lifecycle, version, destination authorization, and budget; reserve
notification quota atomically. Suppress stale pending intents after pause, cancellation,
expiry, or definition replacement. A completion report's own final notification remains
eligible under that exact completed version; later cancellation/revocation still suppresses it.

Use a stable provider idempotency key when supported. A send followed by a crash before
receipt persistence is ambiguous: local uniqueness cannot prove whether the provider accepted
it. Reconcile by provider receipt/key when possible. Without provider deduplication or reliable
reconciliation, default to `uncertain`, surface it in the console, and do not automatically
resend. An explicit retry warns of possible duplication and remains audited and quota-bound.
This avoids blind duplicates but may miss a notification; do not advertise universal
exactly-once delivery. Definitively failed, retryable sends use capped backoff. Completion
of evaluation and completion of notification delivery are separately visible states.

### Management and approval

`manageStandingWork` supports create, inspect, edit, pause, resume, and cancel under the
requesting actor's permissions. Creation policy is `deny | ask | allow`, default `ask`.
The approval shows objective, principal, context scope, tool/effect permissions, check range,
expiry, spending limits, and destination. An approval grants only that version's scope;
model-generated content cannot expand it. Idempotent management requests prevent duplicate
work creation. Resume revalidates authorization, limits, and expiry.

The console exposes lifecycle, next check, blocked reason, run history, spending, notification
status including uncertain delivery, and pause/cancel before the first production release.
Basic controls are not deferred behind adaptive scheduling.

### Conversation wakes and loop control

Opt-in conversation wake debounces authorized new events, advances one pending occurrence,
and respects the same minimum interval, quotas, and cooldowns as scheduled runs. Continuous
chat must neither cause a run per message nor postpone checks indefinitely: use a maximum
coalescing delay. Webhooks use the same authenticated/deduplicated admission path.

Stamp trusted provenance `kind=standing_work`, `workId`, `runId`, `effectId`, and causal parent.
A work item does not wake from its own notifications. Cross-work cycles use the shared loop
breaker and bounded causal-hop/rate policies; provider text cannot forge trusted provenance.

### Release gate

Inject crashes before/after claim, outcome commit, provider send, and receipt commit. Test
two holders, lease expiry, stale completion, edits/pause/cancel during runs, missing state on
handoff, repeated reports, budget exhaustion, permission revocation, silent default output,
catch-up, and notification uncertainty. A timer firing successfully is not sufficient.

## 5. Agent Identity v1

> Status 2026-09-27: the **management plane is implemented; the enforcement plane
> is incomplete**. Org-scoped Principal/PrincipalGrant persistence, lifecycle/grant
> APIs, audit, and the `principals` console surface exist. Disable/enable advance
> the principal revision, and `checkGrant()` correctly checks active state and
> grant expiry/revocation. However, no production execution caller of
> `checkGrant()` was found. Standing Work create/edit only validates principal
> existence/state; disable/revoke does not yet reconcile affected definitions and
> fence later run/effect admission end-to-end. Provider binding/token lifecycle and
> live revocation still need to be connected and verified. The console flag defaults
> OFF; it does not disable the CP API.

An organization owns the execution principal. Agent instances and human creators reference
it; they are not the principal itself. Bind provider identities and credentials through
revocable grants with resource, action, expiry, and policy revision. Preserve actor versus
executor versus provider attribution in every effect.

Build on the existing GitHub App installation/token broker and repository grants. First
standardize organization-owned GitHub App/service-account bindings, scoped short-lived token
issuance, rotation, revocation, and explicit repository access. Do not introduce another
long-lived daemon secret store. The existing deployment-owned GitHub App can provide an
organization-scoped installation identity; per-org self-managed Apps are a separate adapter.
Human OAuth remains explicitly delegated human authority, never silently converted to an
organization identity.

Management includes principal owners, grants, provider bindings, and a disable action.
Disabling a principal blocks new runs and new effects and reconciles active work. Test
cross-org denial, removal of the creating user, expired/revoked credentials, and audit
attribution. The minimum principal/grant contract precedes Standing Work; richer UI follows.

### Authority closure (AUTH1)

Treat this as a release dependency of fixed Standing Work, not as optional identity polish.
Create/edit verifies the principal and all grants needed for the requested context/destination.
Run admission rechecks the current principal revision and read/execute authority. Immediately
before an external effect, recheck lifecycle, revision, destination, and effect grant. Principal
disable, grant revoke, or grant expiry reconciles affected work and prevents stale revisions
from authorizing new operations. Human actor conversation access and execution-principal grants
remain separate authorities; satisfying one never implies the other.

## 6. Unified Audit

> Status 2026-09-27: the **durable audit transport/persistence pipeline is implemented**,
> while production enablement and coverage are incomplete. The CP stores a causal envelope
> with stable event ids and exposes owner-only search/export; the daemon has a durable audit
> outbox and bounded `audit/flush` with idempotent CP ingestion. Standing Work records
> admission/effect facts and the console can inspect them. Recording remains OFF by default,
> with no production CLI/environment wiring found. Coverage is still concentrated around
> Standing Work rather than all tool/process/network/credential decisions. A release blocker
> remains: failure to durably record an authorized external-effect intent must block the
> effect. Audit metadata should also move toward typed/allow-listed, size-bounded detail
> shapes instead of relying only on generic `Record<string, unknown>` plus blacklist
> redaction. Console gates do not disable the read APIs.

Extend existing audit/trace infrastructure with versioned events and a common causal envelope:
`eventId`, organization, actor, principal, agent, conversation/session, work/run, tool call,
effect, parent event, time, policy revision, decision, and outcome. Use stable event ids for
idempotent ingestion and retain both event time and ingestion time for offline delivery.

Capture definition changes and approvals, admission/denial, reset, tool invocation/result,
credential issuance metadata, mediated network decisions, external effects and receipts,
budget reservation/settlement, lifecycle, and handoff. Record redacted metadata by default;
never put credentials or unrestricted tool bodies in audit payloads. Apply audience, retention,
and administrative access controls to audit search/export.

Use a durable local event outbox for interrupted CP connectivity. Failure to durably record
an authorized external-effect intent blocks that effect. Full arbitrary process/network
coverage requires sandbox/proxy instrumentation: report capability/coverage gaps explicitly,
not a falsely complete trace. Events cannot be rewritten through ordinary application APIs;
retention deletion is a separately authorized, audited operation.

Acceptance: trace one human request or scheduled occurrence through tools and final provider
receipt, including denied and uncertain actions, with correct organization isolation and
no secrets. Minimal provenance ships with sessions/work; full search, export, and network
coverage arrive incrementally.

## 7. Budgets & quotas

> Status 2026-09-23: Usage tracking and aggregation work. Standing Work has
> finite limits (`maxRunsPerDay`, `maxNotificationsPerDay`). Operational budgets
> (hop, wake, retry) are enforced. `budgetPolicyRef` is a placeholder string
> column with no backing entity. What is missing entirely: the hierarchical
> Org → Agent → Conversation budget system, atomic concurrent reservation,
> monetary hard caps, threshold alerts, and offline lease preallocation. B1 is
> not started.

Policy hierarchy is Org → Agent → Conversation / Schedule / Standing Work. A run may be
charged to both a work and its conversation, but only once to shared ancestors. Enforce all
applicable limits using a single usage attribution identity. Child policy cannot raise an
ancestor cap. Separate money/token limits from concurrency, runtime, run-count, tool-call,
and notification quotas.

Admission atomically reserves a bounded maximum allowance before model/tool execution.
Concurrent holders cannot each spend the same remaining balance. Settle actual usage and
release unused allowance idempotently; preserve uncertain reservations until reconciled.
Retries and failed attempts consume actual usage too. Daily periods have a defined policy
timezone and period key; rolling windows use their own explicit policy.

A true monetary hard cap requires enforceable per-call/run ceilings and known conservative
cost bounds. If a runtime cannot enforce or report those, do not label estimates as hard
caps: disallow it for strict-budget work or offer an explicitly soft policy. Offline agents
may spend only preallocated leased allowance; they cannot invent additional balance.
Expired execution must be fenced before unused allowance is reclaimed.

Expose reserved/spent/remaining usage, thresholds, block reasons, and reset time. Alert once
per threshold transition with deduplication. Raising limits requires authorization and an
audit event; it does not silently renew expired work. V1 Standing Work needs finite execution
and notification limits; hierarchical management and billing integrations can follow.

## 8. Memory scopes and provenance

> Status 2026-09-23: Agent-scoped memory is mature — `MemoryProvider` port with
> four provider kinds (none/native/managed/external), file-level provenance
> sidecar, plugin ABI, recall/capture, dreaming (D-1 through D-3), and
> `home: control-plane` storage. What is missing: the conversation/workspace/
> organization scope hierarchy, scope promotion with audit, independent grants
> for broader-scope reads, delete tombstones, and admin scope controls. M1 is
> not started.

Use explicit conversation, workspace, and organization scopes. Every entry records source
conversation/session/run/event references, creator principal, extraction method/version,
creation/update time, audience policy, and retention/expiry. Reading a broader scope requires
an independent grant; a useful conversation fact does not automatically become org memory.

Promotion between scopes is an authorized operation with audit and source attribution.
Treat retrieved content as data, never as tool authorization. Revocation and audience changes
must invalidate retrieval caches and prevent newly unauthorized reads. `!new` clears active
session context, not stored memory; the UI states this and provides separate memory controls.

Administrators with the appropriate scope can inspect, edit, and delete. Delete tombstones
prevent background extractors from recreating the same deleted entry from old source events;
propagate deletion to indexes, caches, and derived summaries under a documented retention
policy. Distinguish deletion of a memory entry from deletion of its source transcript and
backup retention. Acceptance covers cross-scope denial, promotion, source inspection,
revocation, and deletion/re-extraction, not only retrieval quality.

## 9. Sandbox hardening

> Status 2026-09-23: Three sandbox backends are implemented — SRT/bwrap
> (Linux), Kubernetes sandbox pods (full CRD surface with lease/identity/warm
> pool), and microVM (KVM-based with per-runtime credential brokering). Fail-
> closed on missing backend is enforced. Known gaps: network egress policy is
> not implemented (all domains approved; see issue #312), macOS sandbox is
> Linux-only by design, and shared workspace mutation coordination is not
> addressed. S1 is partially complete.

Production blockers gate releases as they are verified; they are not postponed to the seventh
feature release. Maintain a threat model for untrusted repositories, tool output, dependencies,
and model-issued commands. Isolate filesystem/workspaces and host sockets, constrain network
egress, broker scoped credentials, limit resources, and clean up orphaned executions.

An execution requiring isolation fails closed if the configured backend is unavailable.
Credential and network boundaries must enforce Standing Work's read-only policy rather than
relying on a prompt. Define capabilities per backend and prevent placement on one that cannot
meet the requested policy. Shared workspaces require mutation coordination even when two
sessions are individually sandboxed.

Acceptance includes host/other-tenant access attempts, unauthorized egress and credential use,
backend startup failure, resource exhaustion, cancellation, and cleanup after crashes. Close
or explicitly mitigate verified blockers before enabling corresponding production workloads.

## 10. ACP v2 convergence

> Status 2026-09-23: Not started. The system is deeply integrated with ACP v1
> (`PROTOCOL_VERSION = 1`) through 9 runtime-specific adapters. No capability
> inventory, formal adapter boundary, protocol version negotiation, or parity
> test suite exists. P1 is not started.

Start with an inventory mapping current proprietary runtime operations to capabilities in
the supported ACP versions: session lifecycle, streaming, cancellation, tools/permissions,
usage, and resumption. Verify the actual negotiated protocol and runtime support during
implementation; the “v2” goal does not assume every required primitive exists everywhere.

Introduce an adapter boundary and parity tests, then migrate supported operations one at a
time. Keep AgentConnect's organization policy, placement, durable work scheduling, budget
accounting, and external delivery as platform responsibilities. Standardizing the runtime
wire does not remove these responsibilities or weaken their fences.

Mixed runtimes negotiate capabilities; unsupported optional features are clearly unavailable,
and required ones block admission. Maintain a documented compatibility window, telemetry,
and rollback before deleting legacy paths. Acceptance requires lifecycle/cancellation,
permission, usage, and reconnect parity without losing provenance or budget enforcement.

## 11. Engineering hardening for long-term Claude Tag evolution

This branch already has the right macro-architecture: protocol contracts, control-plane
authority, daemon-owned execution, durable stores, and a separate console. Do not rewrite it.
Harden the current complexity hotspots before adding another large set of autonomous features.

**E1 module-boundary hardening** keeps behavior stable while changing physical ownership:

- Split `LocalStore` behind domain stores/repositories while preserving the existing shared
  database, transaction seam, migrations, and cross-domain transactional operations where
  they are genuinely required.
- Split `execution/standing-work.ts` into definition/report, scheduling/pump, executor/context,
  delivery, and wake modules. Preserve leases, execution epochs, occurrence identity, and outbox
  semantics.
- Move ambient Claude/runtime construction out of `daemon.ts` into a runtime adapter so
  `daemon.ts` primarily composes and starts/stops components.
- Move Standing Work business orchestration from the HTTP route into an application service;
  keep repositories persistence-focused and protocol projection explicit.
- Replace the expanding Web `ConsoleData`/single `api.ts` model with feature-local
  Standing Work, Principal, Audit, Session, Agent, and Integration query/mutation modules.
- Add contract-fidelity tests across CP domain → protocol projection → daemon domain →
  daemon persistence for every autonomous-work field.

This is not a microservice milestone. No network boundary, DI framework, or generic
event-sourcing/CQRS layer is required. The exit condition is that new Claude Tag capabilities
can be added as cohesive modules without extending a few god files or silently dropping
cross-layer contract fields.

## 12. Incremental implementation sequence

These work-package IDs replace the old prospective PR numbering. Existing PR1/PR2 documents
keep their names and scope; completed commits are not renumbered. A package may span several
PRs. “Foundation” means the shared contract and minimum enforcement, not the whole later UI.

| Package | Deliverable | Dependencies / exit condition | Status |
| --- | --- | --- | --- |
| F0 | Identity/provenance/audience/budget contracts; verified production-blocker inventory | Before autonomous release; use existing infrastructure | Foundation contracts/inventory present; not release certification |
| C1 | Coordinate plumbing (existing PR1) | No behavior change | ✅ Done |
| C2 | Config + capability fence (existing PR2) | No capability advertisement | ✅ Done |
| C3 | Reservation store and monotonic clock | Atomicity and GC tests | ✅ Done |
| C4 | Physical-thread participation writers/readers | Existing routing preserved; real physical ids | ✅ Done |
| C5 | Durable coordinates, replay, observation and runtime routing | C1–C4; restart/mode-change tests | ✅ Done |
| C6 | Reset commands, mode UX, audience and paginated history | C5; complete session acceptance suite | ✅ Done |
| C7 | Advertise append capability | C1–C6 pass; supported placements only | ✅ Done; release evidence pending |
| F1 | Minimal execution principal, durable audit, finite quotas, enforced tool/sandbox policy | F0; required before W release | Foundation primitives present; production enforcement incomplete |
| W1 | Versioned work schema/API and approval-bound lifecycle | F0; creation remains gated | Core implemented |
| W2 | Durable due scheduling, run claims, leases and handoff recovery | W1; shared/transfer storage contract | Core implemented; deployed handoff evidence open |
| W3 | Independent context/state and enforced silent read-only turns | W2 + F1 | Core implemented; execution OFF; isolation acceptance open |
| W4 | Idempotent report, transactional outbox and delivery recovery | W3; no universal exactly-once claim | Core implemented; live authority/policy/audit-intent gates open |
| W5 | Management/approval tools and console controls/timeline | W1–W4 | Inspect/actions/history implemented; create/edit UX and live lease detail remain |
| E1 | Module-boundary hardening for store, daemon, Standing Work, CP application layer, and Web data layer | Preserve behavior and deployment topology; add contract mapping tests | Open; architecture refactor, not product redesign |
| W6.1 | Standing Work contract correctness | Persist/enforce configured intervals; no silent projection field loss | **P0 blocker**: `minIntervalSeconds` daemon persistence/enforcement is incomplete |
| AUTH1 | Runtime authority closure | Principal/grants checked at create/edit, admission/context, and external effects; disable/revoke reconciles/fences | **P0 blocker** |
| POL1 | Runtime policy-reference enforcement | Resolve/enforce budget/tool/notification/visibility refs or narrow V1 contract | **P0 blocker** |
| OPS1 | Production enablement and capability wiring | Explicit CLI/env/deployment config; enabled feature advertises only when executable | **P0 blocker** |
| REL1 | Failure-injection and release evidence | Crash/takeover/stale executor/revoke/uncertain effect/shared-store/mixed-version suites | **P0 blocker** |
| W6 | Release fixed-schedule Standing Work V1 | W1–W5 + W6.1 + AUTH1 + POL1 + OPS1 + REL1 | Not complete |
| I1 | Complete Agent Identity v1 | AUTH1 plus provider binding/token lifecycle | Management implemented; provider/runtime lifecycle incomplete |
| A1 | Complete Unified Audit enforcement and coverage | Fail-closed effect intent, typed/bounded details, broader tool/process/network/credential coverage | Durable pipeline/search/export/UI implemented; coverage/enforcement open |
| B1 | Full hierarchical budgets, allocation and alerts | Extend F1/POL1; strict-cap runtime compatibility | Not started |
| W7 | Adaptive scheduling and conversation/webhook wakes | **After W6**; durable/coalesced wakes, trusted provenance, configured intervals, loop/webhook tests | Experimental/partial; does not block fixed V1 |
| M1 | Memory scope/provenance and administrative lifecycle | Identity/audience/audit foundations | Not started |
| S1 | Continued sandbox hardening and backend parity | Blockers handled throughout, not deferred here | Partial (network policy + macOS remain) |
| P1 | ACP capability mapping, adapters, migration and deprecation | Preserve identity/audit/budget/isolation contracts | Not started |

C1–C7 should now be treated as a release-evidence track, not an architectural design track.
W1–W5 should be preserved and hardened rather than rewritten. The immediate autonomous-work
sequence is W6.1 → AUTH1 → POL1 → OPS1 → REL1 → W6. E1 can run alongside those packages as
behavior-preserving modularization, prioritizing `LocalStore`, Standing Work execution,
`daemon.ts`, and the Web data layer.

Only after fixed V1 is release-ready should W7 adaptive/conversation/webhook wake semantics
expand. B1 monetary reservation, broader A1 coverage, M1, and P1 continue according to their
dependencies. See
[the ordered implementation and validation plan](agentconnect-next-steps.md).

## 13. Non-negotiable invariants

1. Physical delivery and logical session identity are separate, resolved once before admission.
2. Durable replay preserves the original admitted identity; resets and edits cannot retarget it.
3. Standing Work is a versioned objective with durable observation state, not merely a timer.
4. Autonomous execution is silent and bounded by enforced authority, budget, and isolation.
5. A unique database row is not proof of unique execution or exactly-once external delivery.
6. Stale holders and stale definition versions cannot commit new authorized effects.
7. Actor, execution principal, source context, tool use, and external effects remain traceable.
8. Conversation visibility, memory scope, and provider permissions are authorization boundaries.
9. Mixed-version deployments fail closed; capability advertisement follows complete release gates.
10. Each phase is independently usable; later feature ambition does not bypass current safeguards.
11. Safety-relevant fields survive every CP/domain/wire/daemon/store mapping; silent field loss is a release failure.
12. Composition roots compose, persistence modules persist, and application/UI facades do not accumulate unrelated domains indefinitely.
13. Tool/effect authorization is based on typed capabilities and policy, not naming conventions or model-generated intent.
