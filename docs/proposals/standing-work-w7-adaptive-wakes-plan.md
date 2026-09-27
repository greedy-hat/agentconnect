# W7: Adaptive Scheduling and Conversation/Webhook Wakes

Status: partially implemented in the local working tree, inspected 2026-09-26.
Execution remains OFF by default. W6 release gates are open; W7 is not complete.
This document separates the code that exists from the remaining target contract.

## 1. Current implementation and evidence

| Area                 | Present in code                                                                                                                                               | Missing or incomplete                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adaptive scheduling  | `StandingWorkService.report()` parses suggestions; `computeAdaptiveNextCheckAt()` clamps time and applies a backoff calculation; suggested time is persisted. | The caller derives the minimum as `min(maxIntervalSeconds, 60)` instead of carrying the configured `minIntervalSeconds`. A distinct cooldown policy is not wired through this path.                                         |
| Conversation ingress | `daemon.ts` calls `StandingWorkWakeCoordinator.onConversationEvent()` with platform, integration and channel.                                                 | It runs before the subsequent message deduplication and supplies no trusted originating-work provenance.                                                                                                                    |
| Coalescing           | An in-memory timer is reset per work item.                                                                                                                    | No maximum coalescing deadline; continuous traffic can postpone this wake indefinitely. Pending wake state is not durable across restart or handoff.                                                                        |
| Admission limits     | Wake code checks recent runs and an interval before advancing `nextCheckAt`; normal run claims enforce their own fences.                                      | Wake minimum is also derived from max interval; the precheck counts at most 500 history rows against a UTC day. Quota/interval failures return without retaining a deferred wake.                                           |
| Loop control         | Optional causal-hop map and an hourly timestamp list exist.                                                                                                   | Production ingress omits the optional causal source; no explicit same-work rejection. The timestamp limit is coordinator-wide rather than per work. Trusted cross-work lineage and durable/deduplicated events are missing. |
| Webhooks             | Existing general webhook infrastructure remains available.                                                                                                    | No dedicated authenticated/deduplicated Standing Work webhook-wake integration or acceptance suite was found. Report `wakeSource` only supports `scheduled` and `conversation`.                                             |
| Console              | Schedule mode, suggested time and scheduled/chat source are rendered.                                                                                         | Full effective next-check/constraint/blocked-wake visibility and webhook source remain incomplete; no live lease projection.                                                                                                |

Relevant implementation files:

- `packages/daemon/src/execution/standing-work.ts`: service, adaptive helper, pump and wake coordinator.
- `packages/daemon/src/daemon.ts`: pump construction and conversation ingress call.
- `packages/daemon/src/store/local-store.ts`: durable definition/state/run/outbox storage.
- `packages/protocol/src/frames/standing-work.ts`: projected definitions and run reports.
- `packages/control-plane/src/standing-work/{contracts,projection}.ts` and `src/http/routes/standing-work.ts`.
- `packages/web/src/components/console/views/StandingWorkDetailView.tsx`.

The earlier plan's separate `src/standing-work/pump.ts`, `wake.ts` and
`loop-breaker.ts` paths do not describe the current daemon implementation.

## 2. Required behavior

A model may suggest a next check but cannot widen policy. Carry the configured
minimum, maximum, cooldown, timezone, expiry and quota policy through CP validation,
wire projection and daemon storage. Clamp suggestions, apply bounded retry backoff,
and revalidate at actual admission. Persist both suggested and effective time.
Missing or malformed suggestions use a deterministic bounded default.

Authorized conversation events coalesce into one durable pending occurrence with
a maximum delay. An active run records pending context for a later occurrence;
quota/interval/cooldown deferral retains the wake. Preserve the fixed schedule and
select the earlier eligible scheduled or wake time. Commit the context cursor with
the run outcome, not at receipt of an unprocessed event.

Webhook events enter through provider authentication and trusted deduplication,
then use the same bounded admission path. Provider text must not mint authority or
causal provenance. Include event identity and source in the durable admission facts.

Reject a work item's own notification as a wake. Carry trusted causal lineage for
cross-work events and enforce bounded hops and per-work rates. Restart, shared-store
handoff and provider redelivery must not erase the limits or duplicate an occurrence.

The console must distinguish model suggestion, effective due time, wake source,
and the reason a wake was deferred. Notification uncertainty remains independent
from run outcome.

## 3. Ordered implementation plan

1. Repair policy plumbing: persist/project configured minimum and cooldown; use
   them in adaptive reports and wake admission. Test a configured minimum greater
   than 60 seconds through CP projection into the real service path, not only the
   pure helper. Cover timezone quotas, retries and expiry.
2. Implement durable wake admission after authorization/deduplication with event
   ids, pending context, bounded coalescing, active-run deferral and restart recovery.
3. Connect trusted notification provenance to ingress; reject self wakes and enforce
   per-work rates and cross-work hop bounds. Test through the production ingress seam.
4. Connect authenticated GitHub/GitLab/generic webhook admission to the same path
   and extend report/console source contracts. Add redelivery and forged-source tests.
5. Expose effective scheduling and blocked reasons in the console. Verify mobile
   and desktop behavior and old report compatibility.
6. Run integration, shared-store and failure-injection acceptance; update status
   only when these gates and the applicable W6 prerequisites pass.

## 4. Rollout and dependencies

Fixed remains the default schedule mode and conversation waking defaults false.
These fields are not capability negotiation. The current `standing-work-fixed-v1`
name alone does not prove an older daemon supports adaptive/wake behavior. Add
explicit negotiated capabilities or an equivalently verified compatibility fence;
reject unsupported definitions at API, placement, snapshot and live-push boundaries.
Do not silently treat an unsupported adaptive objective as fixed-schedule work.

W7 depends on the W1–W5 core and the applicable W6 authority, audit, quota, sandbox
and recovery gates. It may be developed while fixed-schedule release work proceeds,
but fixed-only rollout must fence adaptive and wake definitions. No gate should be
enabled merely to make this implementation reachable in a demo.

## 5. Verification scope

On 2026-09-26, the existing adaptive suite (14 tests) and wake suite (8 tests)
passed, alongside the Standing Work store, audit and console suites listed in the
[W1–W6 plan](standing-work-w1-w6-completion-plan.md). Passing these tests does not
establish webhook integration, bounded coalescing, configured-minimum propagation,
or trusted loop control through production ingress. Those remain acceptance work.

Release acceptance must cover continuous traffic, duplicate events, active runs,
restart/handoff, per-work quota isolation, same-work notifications, A→B→A cycles,
forged provenance, webhook authentication, mixed peers and existing fixed schedules.
