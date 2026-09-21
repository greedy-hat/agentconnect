# AgentConnect Improvement Roadmap

This proposal focuses on two product gaps that would materially improve AgentConnect as a long-running team agent platform:

1. **Conversation-native persistent sessions**
2. **Ambient / standing work**

The implementation strategy deliberately reuses AgentConnect's existing strengths: daemon-owned sessions, durable inboxes, serial admission, scheduler infrastructure, proactive messaging, memory, duty placement, and self-hosted execution.

## 1. Persistent conversation sessions

### Goal

Allow a team conversation to continue one long-lived agent session across multiple physical threads while still delivering each reply and status update to the physical thread where the user asked.

The core invariant is:

> **Physical delivery thread is not the same thing as logical session identity.**

Today, `msg.thread` effectively participates in both. The design should split them explicitly.

Recommended internal shape:

```ts
interface SessionCoordinates {
  readonly deliveryThread: string
  readonly sessionThread: string
}
```

For the existing behavior:

```text
deliveryThread == sessionThread == physical thread
```

For continuous conversation mode:

```text
deliveryThread = current provider thread
sessionThread  = append:<monotonic timestamp>
```

### Session modes

Per conversation:

```text
createNew  — current behavior
append     — one long-lived logical session for the conversation
```

Trigger policy and session policy stay orthogonal:

```text
Trigger:
  off | mention | any

Session:
  createNew | append
```

### Append reservation

A daemon-local reservation row should own the current logical coordinate for:

```text
(agentId, channel, transportScope)
```

Suggested table:

```text
append_session_reservation
  agentId
  channel
  transportScope
  coordinate
  updatedAt
  PRIMARY KEY(agentId, channel, transportScope)
```

First use is atomic:

1. Mint `append:<epochMs>`.
2. `INSERT OR IGNORE`.
3. Read the winner.

The mint must be monotonic:

```text
max(now, previousMax + 1)
```

### `!new`

In append mode, `!new` advances the reservation instead of changing the physical thread.

Use compare-and-swap:

1. Read current coordinate.
2. Mint next coordinate.
3. CAS current → next.
4. If CAS loses, re-read the winner and treat it as the reset.
5. Do not retry the advance.

This makes concurrent resets converge on one new session rather than skipping multiple generations.

### Transcript identity

Append-mode transcript rows must use the logical `sessionThread`, not the physical thread.

That ensures context from different physical threads forms one coherent conversation history.

### Physical thread participation

Once logical session identity is no longer equal to physical thread identity, session rows can no longer be used to infer thread ownership.

Add a participation record keyed by:

```text
(channel, physicalThread, agentId, transportScope)
```

Write it when:

- an inbound thread message is delivered to the agent;
- the agent posts into a physical thread.

Use that table for `threadOwner` / `threadParticipants`.

### Retention

When deleting a logical session, clear the append reservation only if it still points to the deleted coordinate, and do so in the same local-store transaction.

This prevents retention GC from accidentally clearing a newer reservation.

---

## 2. Ambient / standing work

### Goal

Let a user give an agent a durable objective such as:

> Watch this rollout. Tell us if it fails or if there is no progress for an hour. Stop when it recovers.

This is not just a cron job.

The important distinction is:

> **Cron is a schedule. Standing Work is a durable goal with state.**

### Control-plane model

Suggested shape:

```prisma
enum StandingWorkState {
  active
  paused
  completed
  expired
}

enum StandingWorkScheduleMode {
  adaptive
  fixed
}

model StandingWork {
  id                       String   @id
  orgId                    String
  agentId                  String

  name                     String
  objective                String   @db.Text
  state                    StandingWorkState
  scheduleMode             StandingWorkScheduleMode

  targetPlatform           String?
  targetIntegrationId      String?
  targetChannel            String?
  targetThread             String?

  fixedSchedule            String?
  timezone                 String?
  startAt                  DateTime?
  expiresAt                DateTime?

  minIntervalSeconds       Int
  maxIntervalSeconds       Int
  cooldownSeconds          Int
  maxRunsPerDay            Int?
  maxNotificationsPerDay   Int?

  wakeOnConversation       Boolean  @default(true)

  visibility               String
  sharedWith               Json?

  createdByUserId          String?
  lastModifiedByUserId     String?
  sourceSessionId          String?

  createdAt                DateTime
  updatedAt                DateTime
}
```

The control plane owns the definition. The daemon owns execution state.

### Daemon execution state

Suggested durable local state:

```text
standing_work_state
  workId
  agentId
  nextCheckAt
  lastRunAt
  lastNotifiedAt
  runsToday
  notificationsToday
  definitionVersion
```

and:

```text
standing_work_run
  workId
  runId
  dueAt
  status
  startedAt
  finishedAt
  outcome
  sessionId

  UNIQUE(workId, dueAt)
```

The unique due key prevents duplicate execution after restart or holder handoff.

### Scheduling

Reuse the current scheduler infrastructure instead of building a second scheduler.

Generalize the internal scheduler around:

```text
cron jobs
one-shot due jobs
```

Standing Work schedules the next one-shot due time.

In adaptive mode the model may suggest `nextCheckAt`, but the daemon must clamp it to server policy:

```text
minInterval <= nextCheckAt <= maxInterval
```

Never allow the model to create an unbounded tight loop.

### Silent ambient turns

Ambient evaluations should default to no outward reply.

Add a daemon-injected tool:

```ts
reportStandingWork({
  outcome:
    | 'no_change'
    | 'notify'
    | 'blocked'
    | 'complete',
  summary?: string,
  notification?: string,
  nextCheckAt?: string
})
```

The trusted work id comes from session context, not model arguments.

Semantics:

- `no_change`: no message, schedule next check.
- `notify`: send an outward notification, then schedule next check.
- `blocked`: optionally notify under cooldown policy.
- `complete`: optional final notification, mark complete, disarm.

### Exactly-once notification

The model should not separately call `sendMessage()` and then `reportStandingWork()`.

Instead, `reportStandingWork(outcome='notify')` should perform the durable notification transaction:

1. claim notification idempotency key;
2. send;
3. persist delivery receipt;
4. finalize run;
5. schedule next check.

Use:

```text
(runId, notificationIndex)
```

as the idempotency key.

### Agent-created work

Add a management tool such as:

```ts
manageStandingWork(...)
```

Creation policy:

```text
deny | ask | allow
```

Default should be `ask`, because standing work creates future model spend and future outward side effects.

The approval card should show at least:

- objective;
- check-frequency range;
- expiration;
- notification destination.

### Conversation wake

When `wakeOnConversation=true`, new conversation activity should debounce and advance `nextCheckAt` to a near-future time rather than immediately starting a model pass per message.

This lets standing work incorporate fresh human context without generating message storms.

### Loop protection

Standing-work notifications need trusted provenance:

```text
kind = standing_work
workId
runId
```

A work item must not wake itself from its own notification.

Reuse the existing loop breaker.

---

## 3. Relationship between the two features

Persistent conversation and Standing Work reinforce each other.

A conversation-bound Standing Work item can resume the same logical `append:<id>` session for each ambient evaluation. This means the agent can see:

- prior human instructions;
- earlier ambient checks;
- previous notifications;
- follow-up corrections from the team.

Example:

```text
#deployments

User:
  Keep watching this rollout. Tell us if it fails or
  if there has been no progress for an hour.

Agent:
  creates Standing Work after approval

Ambient run:
  no_change
  → silent

Ambient run:
  notify
  → posts warning in #deployments

User:
  We restarted shard 3 manually.

Next ambient run:
  resumes the same logical conversation session
  and sees that update.
```

---

## 4. Recommended implementation sequence

```text
PR 1  Coordinate plumbing
PR 2  sessionMode config + capability fence
PR 3  Append reservation store
PR 4  Append runtime activation
PR 5  Physical-thread participation
PR 6  !new + final session-mode UX

PR 7  StandingWork schema/API
PR 8  One-shot due scheduler
PR 9  Silent ambient turns
PR 10 reportStandingWork
PR 11 Exactly-once notification
PR 12 manageStandingWork + approval
PR 13 Conversation wake
PR 14 Console Standing Work UI
```

The first four PRs intentionally keep behavior changes isolated. Only the runtime activation PR should advertise the daemon capability and enable `append` in production.

## 5. Non-negotiable invariants

1. **Physical thread ≠ session identity.**
2. **Standing Work ≠ Cron.**
3. **Ambient evaluation is silent by default.**
4. **Session coordinates are resolved once per target and carried downstream.**
5. **Mixed-version deployments must fail closed rather than silently downgrade `append` to `createNew`.**
6. **Future side effects require deterministic daemon-side limits, not prompt-only policy.**
