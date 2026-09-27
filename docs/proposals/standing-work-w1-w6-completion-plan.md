# Standing Work W1–W6 Completion Plan

Status: code inspection snapshot, 2026-09-26. W1–W5 core code is present in
the current worktree; W6 is not release-ready. Execution is default OFF through
the daemon constructor option `standingWorkExecution`; a production CLI/environment
activation path was not found. W7 code now exists but is only partially implemented;
its remaining work is tracked in [the W7 plan](standing-work-w7-adaptive-wakes-plan.md).
The requirements below remain exit criteria, not a claim that every step passed.

## Current baseline

The current tree contains the CP definition API and approval flow, daemon projection
and fixed-schedule pump, daemon run/outbox reporting, CP-persisted run history, and a
console list/detail stop surface. Ambient runs now read a bounded authorized transcript
page when a context is configured, and notification delivery rechecks the current local
definition/version/authorization projection before sending. The console run timeline
uses a newest-first cursor for older history.

This is still a development snapshot, not a W6 release. Before enablement, close or
verify these gates:

- Connect Principal disable/grant revocation to run admission, active execution,
  CP-to-daemon authorization projection, and notification delivery. A direct test
  of `PrincipalService.checkGrant()` does not prove a running daemon is fenced.
- Make durable external-effect intent mandatory for released autonomous work.
  The current audit recorder returns null on write failure and the pump still
  dispatches. Test storage failure immediately before provider send.
- Add supported operator configuration and required-capability validation. Console
  feature flags do not activate daemon execution or secure CP API endpoints.

- Prove fleet duty-placement and recovery after restart/handoff in the deployed topology.
  Store tests now cover two holders on one durable store, lease expiry, stale completion,
  and scoped shared-store notification claims; an end-to-end pool handoff remains open.
- Project the daemon's current lease/in-flight run state to CP for the console. The
  timeline currently shows reported runs and delivery states, not a live lease owner or
  lease expiry; do not infer current execution from the newest historical run.
- Verify the dedicated sandboxed runtime and credential-broker policy across real
  runtime adapters. The daemon now requires a sandbox, starts a one-off host without
  agent tool credentials, requests read-only mode, and supplies no MCP tools; adapter
  escape and credential tests remain open.
- Recheck provider-side grants against an authoritative current source before delivery;
  the present daemon check uses its latest CP projection and retries while CP is not
  ready, but does not independently query provider membership.
- Wire and reserve the referenced monetary budget policy atomically; current per-day
  run and notification caps do not replace monetary budget enforcement.
- Complete the remaining failure-injection and authorization suites. The targeted
  SQLite/PostgreSQL, CP API/repository, protocol, and console suites have been run;
  the full CP unit suite also passed with loopback access.

## Historical verification reported on 2026-09-23

These are retained historical results, not rerun by the 2026-09-26 inspection.

- Protocol, daemon, control-plane, and web typechecks passed; Prisma schema validation passed.
- Daemon Standing Work store and ambient suites passed on SQLite (43 tests).
  The shared-store suite passed on PostgreSQL (34 tests), including two-holder
  lease-expiry recovery, notification-claim isolation, and stale-send uncertainty.
- CP Standing Work definition, report, and route integration suites passed (17 tests)
  against Testcontainers PostgreSQL. All 77 migrations, including both Standing Work
  migrations, applied successfully to a fresh database.
- Console Standing Work list/detail suites passed (16 tests). The full CP unit suite
  passed with loopback access (2,583 tests).
- Fixed a projected destination that lost its platform before delivery authorization,
  wired 10-second renewal of a 30-second lease with cancellation on authority/duty loss and a five-minute
  turn deadline, scoped shared-store notification claims to serving agents, recovered
  receipt-less sends as `uncertain`, and fixed PostgreSQL case-folded quota aliases.
  These changes have targeted regression tests.

## Verification rerun on 2026-09-26

Nine files / 113 tests passed: daemon `standing-work-store` (34),
`standing-work-adaptive` (14), `standing-work-wake` (8), `execution-audit` (9),
`execution-audit-flush` (14); web StandingWorkView (6), StandingWorkDetailView (10),
PrincipalsView (7), AuditView (11). These are focused component/store tests, not
proof of real-adapter isolation, PostgreSQL fleet handoff, current provider grants,
or a complete production authority/audit path. Full typechecks, database integration
and deployed acceptance suites were not rerun in this inspection.

## Implementation snapshot

| Phase                       | Current state                                                                                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W1 definitions and approval | CP persistence, fixed-schedule validation, destination/context grant checks, lifecycle endpoints, version fences and owner approval are present. Historical targeted verification exists; complete release acceptance remains open.                                                  |
| W2 lifecycle and scheduling | Daemon service, durable claims, lease renewal, bounded turn deadline, lease fences, pump and report catch-up are wired behind explicit opt-in. Two-holder store recovery is tested; deployed fleet handoff evidence remains open.                                                    |
| W3 ambient execution        | Configured context is read in bounded pages under transcript delivery visibility; unavailable context blocks the run. Each run now requires a dedicated sandboxed host without agent tool credentials and read-only mode. Real-adapter escape and credential tests remain open.      |
| W4 reports and delivery     | Run reports and notification outbox are projected to CP; daily run/notification caps, shared-store claim scoping, stale-send uncertainty recovery, and local projection revision/version checks exist. Monetary budget reservation and live provider grant revalidation remain open. |
| W5 console                  | List/detail, approval/pause/resume/cancel, run and delivery timeline are present. Older runs use cursor pagination. Live lease/in-flight state is not yet projected. No create/edit form is exposed in the console.                                                                  |
| W6 release                  | Not complete. Feature remains off by default; runtime credential isolation, monetary budget, provider grant, live state, and deployment gates have not been demonstrated.                                                                                                            |

## Phase 1 — W1: authoritative definition and approval API

1. Make the control plane the sole writer of definitions and actor grants. Define
   create, inspect, edit, pause, resume, cancel, and approve request/reply schemas,
   all scoped to `orgId` and idempotency keys.
2. Persist the complete fixed-schedule definition contract, including source context,
   tool/budget/visibility policy references and immutable actor/principal provenance.
3. Validate destination access, fixed cron/timezone/minimum frequency, finite expiry,
   finite inherited limits, and version CAS. Any edit or lifecycle authority widening
   creates a pending version and suppresses stale notification intents.
4. Add CP permission-policy tests: denied creator, denied approver, destination change,
   stale version, duplicate create, and cross-org attempts.

Exit: a CP-approved definition can be projected to a daemon, and no daemon-local or
model-originated request can create or broaden one.

## Phase 2 — W2: daemon lifecycle, durable scheduling, and handoff

1. Construct `StandingWorkService` and `StandingWorkPump` in daemon startup only
   when the required fixed-schedule capability, shared store/transfer contract,
   execution principal, and policy backend are available. Otherwise advertise no
   capability and reject control frames.
2. Bind the pump to duty placement. A holder must possess the applicable serving
   placement before claiming; duty loss stops new claims and fences active work.
3. Finish lease recovery: bounded attempts, explicit blocked terminal reason,
   coalesced catch-up after downtime, and no catch-up after expiry/cancel.
4. Add two-holder, crash-before/after-claim, duty-loss, lease-expiry, restart, and
   shared-store tests. Do not promise fleet uniqueness with isolated SQLite.

Exit: a fixed occurrence has one fenced active attempt and a successor can recover it
from durable state without duplicate execution claims.

## Phase 3 — W3: independent, silent, read-only execution

1. Add an isolated Standing Work session factory. It reads a bounded, authorized
   context slice after the committed cursor and supplies prior observation state.
2. Advance context cursor only in the report transaction. Unavailable/revoked context
   is a visible blocked result, not an empty successful read.
3. Enforce ambient policy in the runtime and credential broker, not only by tool name:
   no ordinary final renderer, `sendMessage`, shell, network, write tools, or mutable
   credential route. The sole external path is the notification dispatcher.
4. Test revocation during a run, context pagination, silent default output, sandbox
   capability denial, and attempts to escape through aliases/MCP tools.

Exit: an ambient run can observe and report but cannot produce ordinary conversation
output or an unmediated external effect.

## Phase 4 — W4: reports, notification outbox, and quota enforcement

1. Require exactly one structured terminal report; classify missing/malformed/timeout
   as bounded failed attempts. Persist outcome, observation state, cursor, next fixed
   occurrence, and notification intent atomically.
2. Enforce run and notification daily limits at claim time using the defined policy
   timezone. Reserve notification quota atomically before provider delivery.
3. Before delivery, revalidate lifecycle, definition version, authorization revision,
   destination grant, and budget reservation. Suppress stale pending entries.
4. Use provider idempotency keys or reconciliation. Send/receipt crash ambiguity becomes
   `uncertain`; it is never automatically resent. Add capped retry backoff only for
   definitive retryable failures.
5. Add failure injection around report commit, send, and receipt commit, plus quota
   exhaustion, duplicate report, uncertain provider result, and revoke-after-enqueue.

Exit: evaluation completion and notification delivery are independently durable and
visible, with no claim of universal exactly-once provider delivery.

## Phase 5 — W5: management surface and timeline

1. Add console API routes and UI for list/detail/create/edit/approve/pause/resume/cancel.
   Authorization is enforced by the control plane; the daemon only projects its local
   execution state.
2. Render lifecycle, version/approval, next check, blocked reason, current lease,
   run history, quota usage, and each notification state, especially `uncertain`.
3. Provide optimistic-version conflict handling and confirmation for cancellation or
   explicit uncertain-delivery retry. Do not expose adaptive/wake controls.
4. Add UI/API tests for audience/org isolation, stale actions, unknown delivery, and
   pause/cancel while a run is active.

Exit: operators can inspect and stop every production work item before W6 is enabled.

## Phase 6 — W6 release gate and rollout

1. Add a `standing-work-fixed-v1` capability, advertised only after Phases 1–5 and
   all required runtime/sandbox/shared-storage capabilities are live. Mixed or unknown
   peers fail closed.
2. Run the full failure-injection suite on both supported store dialects, including
   two holders, stale completion, edit/pause/cancel during runs, permission revocation,
   budget exhaustion, handoff without state, notification uncertainty, and catch-up.
3. Roll out behind the capability gate with finite organization defaults. Start with
   fixed cron only; collect audit/operational evidence before widening availability.
4. Rollback disables capability advertisement and new admissions, pauses work, and
   suppresses pending notifications. It never deletes definition/run/outbox rows;
   migration is additive and recovery remains available after re-enable.

Exit: W6 is complete only when the release-gate suite passes and fixed-schedule work is
operationally observable, bounded, revocable, silent, and safely recoverable.

## Explicit exclusions

Do not implement adaptive intervals, model-proposed scheduling, conversation-triggered
wakes, webhook wakes, causal loop handling for wakes, or wake-specific debounce logic.
Those are W7 and require a separate plan and acceptance suite.
