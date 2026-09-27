# AgentConnect: Next Steps from the Current Code

Status: local code inspection, 2026-09-26. This is an implementation and acceptance
plan, not a release announcement. The inspected branch is
`proposal/conversation-session-and-standing-work`, HEAD `0a8416cb`. Its Standing
Work, Principal and Audit additions include uncommitted and untracked files.
Local remote-tracking refs were inspected; no remote refresh or merge verification
was performed. See the [roadmap](agentconnect-improvement-roadmap.md).

## 1. First: close authority and effect-recording gaps

### Principal and grant enforcement (I1 / F1 / W6)

Current evidence: `PrincipalService.disable()` changes the principal state/revision
and appends audit metadata. `checkGrant()` has no production caller; tests call it
directly. Existing Standing Work definitions carry copied principal/revision facts,
so updating the principal alone does not refresh daemon execution authority.

Implement authoritative principal/grant checks at definition approval, run admission
and before notification delivery. Propagate revision changes/revocation to affected
work and reconcile active runs/pending effects. Bound disconnected authority with
leases. Grant revocation/expiry and provider permissions must also invalidate use;
re-enabling a principal must not silently approve an obsolete work definition.
Connect provider identity/token issuance to these checks instead of treating a
Principal row as proof of a provider binding.

Acceptance: disable/revoke during an active run and after notification enqueue;
verify no new effect is authorized under the stale revision, including after a
reconnect or handoff. Cover expired grants, cross-org access and provider-side
permission removal through the production path.

### Mandatory durable effect intent (A1 / F1 / W6)

Current evidence: `DaemonAuditRecorder.append()` catches storage errors and returns
null; `StandingWorkPump.tick()` calls the dispatcher regardless of that result.
The current recorder therefore supplies best-effort evidence, not the roadmap's
required durable-intent boundary. Principal management audit writes also swallow
failures and need review against the lifecycle-audit contract.

Require a durably recorded authorized effect intent before provider send in the
released execution policy. Distinguish intentionally disabled diagnostic recording
from required effect evidence; do not allow execution configuration to bypass the
latter. Preserve idempotent outbox upload and uncertain delivery recovery.

Acceptance: inject a local audit-write failure before send and assert zero provider
calls; crash after intent/before send and after send/before receipt. Verify retry,
replay, redaction and uncertain outcomes without claiming universal exactly-once
provider delivery.

## 2. Complete fixed-schedule release prerequisites (W1–W6)

- Wire `budgetPolicyRef` to a real policy/reservation path. Existing daily run and
  notification caps and F1 quota helpers are not monetary budget enforcement.
  Reserve atomically before spend, settle idempotently, retain uncertainty, and
  reject strict-cap work on runtimes lacking enforceable bounds. Full budget UI
  and alerts can follow, but do not waive the currently recorded W6 budget gate.
- Verify real runtime/sandbox credential isolation and enforce required network
  policy. A requested read-only mode or an empty MCP list is not proof that every
  adapter blocks writes, shell/network escape or credential access. Define an
  explicitly supported backend matrix and reject incompatible placement.
- Complete shared PostgreSQL holder/restart/handoff acceptance and crash injection
  around claim, report commit, notification send and receipt. Keep SQLite local
  recovery distinct from fleet-wide storage/ownership guarantees.
- Project current lease owner/expiry, active run and effective due/blocked state to
  CP and console. Reported historical runs cannot substitute for live ownership.
  Keep create/edit UI separate from the minimum inspect/stop release surface;
  document that reduced scope if it is the intended first release.
- Add a supported configuration path for `standingWorkExecution` and
  `executionAudit`; currently only daemon constructor options were found. Validate
  policy/capability prerequisites before activation. Console flags control UI,
  not API authorization or daemon execution. Prove mixed-version snapshot/live-push
  rejection and rollback that preserves definition/run/outbox records.

Acceptance: run the remaining [W6 gate suite](standing-work-w1-w6-completion-plan.md)
on the intended topology with real adapters, migrated storage and current provider
grants. Record commands, environment, outcomes and limitations before enabling.

## 3. Repair adaptive scheduling and event wakes (W7)

Follow the [W7 plan](standing-work-w7-adaptive-wakes-plan.md):

1. Carry the configured minimum interval and cooldown into daemon storage and
   scheduling; replace the current minimum derived from max interval.
2. Admit authorized, deduplicated events into durable pending wakes with bounded
   coalescing, deferred occurrences and restart/handoff recovery.
3. Carry trusted notification lineage, reject self wakes and enforce per-work
   rates and bounded cross-work hops through the real ingress path.
4. Wire authenticated webhook wake admission and report sources; complete effective
   due-time/blocked-reason UI and feature-specific compatibility fencing.

This work can proceed before W6 acceptance finishes, but must not widen a fixed-only
release. Existing helper/coordinator tests are insufficient evidence for these gates.

## 4. Expand the remaining roadmap after the release boundary is sound

- **A1:** cover tool calls/results, credential issuance, process/network decisions,
  lifecycle changes and budget settlement with causal provenance and administrative
  retention controls. Keep coverage limits explicit per backend.
- **B1:** finish Org → Agent → Conversation/Schedule/Standing Work policies, shared
  ancestor accounting, reserved/spent/remaining UI, threshold alerts and offline
  allowance leases. The minimal monetary reservation needed by W6 precedes this UI.
- **M1:** add independently authorized conversation/workspace/org memory scopes,
  promotion provenance, revocation/cache invalidation and deletion tombstones.
- **S1:** finish remaining backend parity, network egress and shared workspace
  mutation coordination. Relevant isolation gaps already block corresponding W6
  workloads; the rest need not delay a release on a verified supported backend.
- **P1:** inventory actual runtime capabilities, define adapters/parity tests and
  negotiate a compatibility window before migrating ACP operations.

## 5. Evidence and change discipline

On 2026-09-26, nine focused files / 113 tests passed: daemon Standing Work store
(34), adaptive (14), wakes (8), audit recorder (9), audit flush (14); web Standing
Work list/detail (6/10), Principal (7), Audit (11). Full typechecks, database
integration and deployed acceptance were not rerun in this inspection. Earlier
plan results are historical evidence and are labeled as such.

Group subsequent changes by the boundaries above, include additive migration and
rollback checks, and keep unrelated local changes intact. Commit/review the current
work in coherent units before describing it as merged. Update roadmap statuses
only with implementation and acceptance evidence, distinguishing code present,
targeted tests passed, release gates passed and deployed.
