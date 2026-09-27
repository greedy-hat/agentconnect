# Standing Work — W5 operator console (timeline / manage surface)

Companion to `standing-work-w1-w6-completion-plan.md`. Status as of 2026-09-26:
the inspect/approve/pause/resume/cancel console and paginated reported-run history
are implemented in the local working tree. Live lease/in-flight state is not
projected and create/edit forms are absent, so the full roadmap W5 target remains
partial. Schedule mode, suggested next-check time and scheduled/chat run source
are now displayed as part of partial W7 work.

The two Standing Work view suites were rerun on 2026-09-26 (16 tests passed).
Earlier protocol/daemon/CP/web typechecks and PostgreSQL integration results are
historical 2026-09-23 evidence, not rerun by this inspection. Execution requires the
daemon constructor option `standingWorkExecution` (default OFF); the console flag
only controls UI visibility. W6 release gates remain open.

Goal (from the W6 release-gate rationale): give an operator an **inspect + stop** surface for durable
Standing Work so autonomous scheduled execution can be safely turned on. Approve/pause/cancel + run
history is the blocking capability; create/edit-in-UI is secondary.

---

## The one architectural decision that shapes everything

Definitions + operator lifecycle are **CP-authoritative** (Postgres, `standing_work_def`). Run history and
notification outcomes originate in the daemon's local `standing_work_run` and
`standing_work_notification_outbox` in `packages/daemon/src/store/local-store.ts`, then flow through the
`standing-work/report` event into CP persistence for offline-readable console history. The CP stores outcome,
status, receipt and error metadata, not notification bodies.

**Decision implemented: mirror the `cron/report` pattern (push → persist → poll).** Cron already solved
this shape — append-only, pollable, and readable when the daemon is offline:

- daemon emits fire-and-forget `cron/report` via `emitCronReport()` (`packages/daemon/src/cp/client.ts:824`,
  gated on `state==='READY'|'DRAINING'`, sent with `this.scopedFrame(...)`), staying authoritative locally;
- CP handler `handleCronReport` (`packages/control-plane/src/ws/handlers/cron-report.ts`, registered
  `ws/handlers/index.ts:94`) fences on org + `resolver.mayAct(agent, daemonId)`, drops stale reports silently,
  latest-wins;
- stored in `model CronRun` (`prisma/schema.prisma:1790`, `@@map("cron_run")`, unique `(cronId, startedAt)`)
  with a `CronRunReaper` for orphaned `running` rows;
- served by a pure DB read `GET /crons/:id/runs` (`packages/control-plane/src/http/routes/crons.ts:275`),
  polled every 10s by the console.

This implementation uses push/persist/poll; no live-proxy path is mixed into run history.

Decision recorded: push/persist/poll is implemented. The console scope is inspect + approve/pause/resume/cancel;
create/edit APIs exist, but no create/edit form is part of this surface.

---

## Phase plan (each phase exits with typecheck + tests; do not skip ahead)

### Phase 0 — Decide + spike (complete)

- Report-frame approach: push/persist/poll.
- UI scope: inspect and stop/approve; create/edit forms omitted.

### Phase 1 — Protocol: `standing-work/report` EVT (D→C) (implemented; targeted historical verification, full release acceptance open)

File: `packages/protocol/src/frames/standing-work.ts` (+ re-export in `index.ts`, register kind in `frame.ts`).

- Add `StandingWorkRunReport` strict zod. Fenced fields so a stale executor can't overwrite a newer truth:
  `orgId, workId, runId, definitionVersion, executionEpoch, occurrenceId, outcome
('no_change'|'notify'|'blocked'|'complete'|'failed'), startedAt, finishedAt?, durationMs?, sessionId?,
errorCode?, notification?: { effectId, status ('delivered'|'uncertain'|'failed'|'suppressed'),
receipt?, error? }`.
- Key invariant to preserve: **run outcome and notification delivery are separate facts** — never collapse
  an `uncertain` send into the run's success. (Repo comment at `local-store.ts:2352` — "uncertainty cannot
  be hidden".) The frame must be able to express a committed `notify` run whose notification is still
  `pending`/`uncertain`.
- Keep it a pure EVT (fire-and-forget), consistent with `cron/report`.

### Phase 2 — Daemon emission (implemented; targeted historical verification, full release acceptance open)

Files: `packages/daemon/src/execution/standing-work.ts` (pump), `packages/daemon/src/cp/client.ts`
(`emitStandingWorkReport` beside `emitCronReport`), the daemon wiring in `armStandingWorkPump()`
(`daemon.ts:6218`).

- Inject a `StandingWorkReporter` sink (`report(run): void`) into `StandingWorkPump` — default a no-op so the
  pump stays unit-testable without a client (same discipline as the executor/dispatcher seams).
- Emit after `reportStandingWork()` returns `committed` and again when the notification settles
  (`settleStandingWorkNotification`) so the outbox status transition reaches the CP. Carry
  `definitionVersion`+`executionEpoch` from the claim so the CP can fence.
- Client method mirrors `emitCronReport`: `if (this.state!=='READY'&&this.state!=='DRAINING') return` then
  `transport.send(encode(this.scopedFrame('standing-work/report', report)))`.
- Must remain inert while `standingWorkExecution` is off (pump never built ⇒ nothing to emit).

### Phase 3 — CP persistence + WS handler (implemented; targeted historical verification, full release acceptance open)

Files: `packages/control-plane/prisma/schema.prisma` (new `model StandingWorkRun`, `@@map("standing_work_run")`;
decide one table with an embedded notification JSON vs. a second `StandingWorkNotification` row — prefer a
second table so delivery is independently queryable and `uncertain` is first-class), a new migration under
`prisma/migrations/`, a repo (`persistence/repositories/`), `ws/handlers/standing-work-report.ts` + register in
`ws/handlers/index.ts`.

- Handler fences identical in spirit to `handleCronReport`: row's org must match the frame org; reporting
  daemon must currently serve the agent (`resolver.mayAct`); stale `definitionVersion`/`executionEpoch` dropped;
  latest-wins upsert keyed on `(workId, runId)` and `(runId, notificationIndex)`.
- Add a reaper equivalent for `running` rows if we open a row on fire (optional for V1 since standing-work
  runs are short ambient turns; decide).

### Phase 4 — CP read + action endpoints (implemented; targeted historical verification, full release acceptance open)

File: `packages/control-plane/src/http/routes/standing-work.ts`, DTOs into `http/dto/index.ts`.

- `GET /standing-work/:id/runs` (newest-first, cursor-paged) returning run + notification status per row.
- `GET /standing-work/:id/notifications` OR fold into `/runs` items (match how the UI wants to render; the
  daemon timeline already returns both arrays).
- Reuse the existing `getVisible`/`canView`/`denyViewerWrite`/`denyNonOwner` stack already in the file; the
  run read is view-scoped (no new write).
- OpenAPI tags, summaries, descriptions and operation IDs are present on the Standing Work routes, including
  the cursor parameters for run history.

### Phase 5 — Web console (implemented; targeted historical verification, full release acceptance open)

Files: `packages/web/src/app/(app)/[slug]/standing-work/page.tsx` + `[id]/page.tsx` shells → views in
`packages/web/src/components/console/views/` (`StandingWorkView.tsx`, `StandingWorkDetailView.tsx`),
`lib/api.ts` (DTOs + `fetchStandingWork(s)`, `fetchStandingWorkRuns`, `approveStandingWork`,
`pauseStandingWork`, `resumeStandingWork`, `cancelStandingWork`), `lib/swr-keys.ts` (`consoleKeys.standingWork*`),
`lib/data-context.tsx` (list fetch + `settleInBackground(mutate)` mutation pattern at `:1577`), nav entry, and
`components/console/ModalProvider.tsx` if an edit modal is added.

- Detail view: header state + approve/pause/resume/cancel actions, and a **Runs card** polled every 10 seconds;
  each run shows outcome and, separately, notification status. Older history loads by timestamp/run-id cursor;
  `uncertain` remains a separate visible state. Live lease/in-flight state still needs a daemon-to-CP projection
  before the current-lease acceptance criterion is met.
  Deep-link `sessionId` when present (`/sessions/${id}`) like cron runs do.
- Follow `packages/web/STYLE.md` + the card/row classes used in `CronsView.tsx`.

### Phase 6 — Tests + gates (targeted suites passed; release gates remain open)

- Protocol: frame parse/reject tests. Daemon: pump emits a fenced report on commit + on settle (fake reporter);
  a stale-epoch report is not emitted/overwrites nothing. CP: `standing-work-report` handler (org fence,
  serve fence, latest-wins, uncertain-notification preserved), repo round-trip, route RBAC + paged `/runs`
  (Prisma integration tests need Docker — flag env dependency). Web: view render + action wiring.
- Full `pnpm --filter @agentconnect.md/{protocol,daemon,control-plane,web} typecheck` and the touched unit suites.

---

## Invariants to protect (carry the current-session constraints forward)

- Control-Plane stays OFF the message hot path; Standing Work execution stays gated + un-advertised by
  default. W5 adds an inspect/stop surface, NOT an auto-enable.
- Never put notification bodies or unrestricted tool output into CP-persisted run rows or audit — persist
  status/receipt/error-code/summary only. The report frame's `payload`/`notification` text stays in the daemon.
- Platform names must not become core knowledge; run rows reference `workId`/`agentId`, not platform strings.
- Fail closed on mixed/unknown peers: a daemon that doesn't advertise `standing-work-fixed-v1` never sends
  reports; a CP that doesn't recognize the frame must not break the connection (unknown-EVT no-op).
- Keep `standingWorkExecution` default OFF. The management UI can ship dark (list is empty until the feature is
  on somewhere) — do not flip it to make the UI demoable.

## Verification still required

- Run the remaining cross-holder, runtime credential, provider authorization, monetary budget,
  live lease projection, and failure-injection release suites in the W1–W6 plan.
- Historical 2026-09-23 results report targeted typechecks, daemon store/ambient, CP
  report/route/repository and PostgreSQL suites passing. Only the focused view suites
  were rerun for this console inspection on 2026-09-26.
- Complete the W6 gates in `standing-work-w1-w6-completion-plan.md` before enabling execution beyond development.
