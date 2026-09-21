# PR 1 — Session / Delivery Coordinate Plumbing

## Goal

Separate provider delivery coordinates from logical session identity without changing any user-visible behavior.

Current behavior overloads the physical thread for:

- reply destination;
- status destination;
- session key;
- serial admission;
- ACP session ownership;
- transcript identity.

PR 1 introduces an explicit trusted coordinate object and carries it through admission.

```ts
export interface SessionCoordinates {
  readonly deliveryThread: string
  readonly sessionThread: string
}
```

For this PR:

```text
deliveryThread === sessionThread === msg.thread ?? msg.msgId
```

So existing behavior stays exactly the same.

## Non-goals

This PR does **not** implement:

- `append` behavior;
- control-plane `sessionMode`;
- append reservations;
- thread participation;
- `!new`;
- UI.

## New module

Add:

```text
packages/daemon/src/session/session-coordinate.ts
```

Suggested API:

```ts
import type { NormalizedMessage } from '../messages/normalized.js'

export interface SessionCoordinates {
  readonly deliveryThread: string
  readonly sessionThread: string
}

export function currentSessionCoordinates(
  msg: NormalizedMessage
): SessionCoordinates {
  const thread = msg.thread ?? msg.msgId
  return {
    deliveryThread: thread,
    sessionThread: thread
  }
}
```

Optionally also add:

```ts
export function sessionKeyForCoordinates(
  agentId: string,
  msg: NormalizedMessage,
  coordinates: Pick<SessionCoordinates, 'sessionThread'>
): string
```

to centralize session-key construction.

## QueueEntry becomes the carrier

Update:

```text
packages/daemon/src/daemon/turn-types.ts
```

Add:

```ts
coordinates: SessionCoordinates
```

to `QueueEntry`.

This is the right seam because `QueueEntry` already represents the complete trusted admitted dispatch context and flows through:

- durable inbox;
- serial gate;
- immediate execution;
- queued execution;
- replay;
- webchat;
- A2A;
- hooks.

Do **not** store logical session coordinates inside `NormalizedMessage`. They are target-specific, not provider-authored message data.

## Resolve once before admission

The order should become:

```text
route target
  ↓
currentSessionCoordinates(msg)
  ↓
sessionKeyForCoordinates(...)
  ↓
construct QueueEntry
  ↓
durable inbox
  ↓
serial gate
  ↓
SessionManager
```

The long-term invariant is:

> Resolve coordinates once per target, carry them everywhere, never re-derive them downstream.

## transcriptCoords

Today `transcriptCoords(msg)` derives:

```ts
msg.thread ?? msg.msgId
```

Change it to consume the carried logical coordinate:

```ts
export function transcriptCoords(
  msg: NormalizedMessage,
  coordinates: Pick<SessionCoordinates, 'sessionThread'>
): {
  thread: string
  ts: string
}
```

The returned transcript thread must be:

```ts
coordinates.sessionThread
```

not the physical delivery thread.

## SessionManager.handle

Do not add another positional argument to the already-large signature.

Prefer extracting an options type:

```ts
type SessionHandleOptions = {
  coordinates: SessionCoordinates
  initializeOnly?: boolean
  directAgentCall?: boolean
  host?: AcpHost
  additionalMcpServers?: McpServer[]
  workspaceIsolation?: 'shared' | 'session'
  forceWorkspaceIsolation?: boolean
  preparedWorkspaceCwd?: string
}
```

Then inside `SessionManager.handle()`:

```ts
const coordinates = options.coordinates

const { thread: transcriptThread, ts } =
  transcriptCoords(msg, coordinates)

const key = sessionKeyForCoordinates(
  agentId,
  msg,
  coordinates
)
```

All session/transcript semantics should now use `coordinates.sessionThread`.

## TurnPlan

Update:

```text
packages/daemon/src/daemon/turn-plan.ts
```

Add:

```ts
readonly sessionThread: string
```

Keep existing `thread` and `statusThread` provider-facing.

Suggested meaning:

```text
sessionThread  → logical session/transcript coordinate
thread         → provider-visible physical reply thread
statusThread   → provider-visible status/chrome target
```

Build the plan with:

```ts
sessionThread: entry.coordinates.sessionThread
statusThread: entry.coordinates.deliveryThread
```

Do not rename `plan.thread` in this PR; that would produce a large low-value diff across platform renderers.

## recordObservedInbound

This is a critical seam.

Where observer matching currently compares a transcript/session coordinate against `statusThread`, switch it to `plan.sessionThread`.

Once append mode exists:

```text
statusThread  = physical thread
sessionThread = append:<id>
```

so comparing against `statusThread` would become incorrect.

## Commands

Audit command code for direct re-derivation of:

```ts
msg.thread ?? msg.msgId
```

when looking up or controlling a session.

Commands should operate on the logical session coordinate but reply in the physical command thread.

This matters especially for:

- `!stop`;
- `!cancel`;
- `!queue`;
- `/status`;
- `/models`;
- `/effort`;
- `/permission`.

### !queue

Avoid rewriting `payload.thread` to point at a logical session.

Instead, pass explicit coordinates into the queue-dispatch path.

The message should remain provider-physical; the session coordinate should stay trusted daemon metadata.

## Durable inbox

PR 1 should **not** add a database migration.

Because current semantics make logical and physical coordinates identical, restart replay can still reconstruct them from the persisted message.

However, this is intentionally temporary.

When append mode is implemented, the durable inbox must persist the resolved logical session coordinate because:

```text
append:<id>
```

cannot be safely re-derived from the physical message after a crash.

## Webchat, A2A and code-host paths

Search all direct `sessionKey(... msg.thread ...)` construction in:

- webchat;
- evaluation hooks;
- collaboration coordinator;
- GitHub review orchestration;
- code-host review paths.

If a path already has an admitted `QueueEntry`, use its carried coordinate.

If it is creating a new target delivery, resolve coordinates before admission.

## Suggested files

Primary:

```text
packages/daemon/src/session/session-coordinate.ts
packages/daemon/src/daemon/turn-types.ts
packages/daemon/src/daemon/turn-plan.ts
packages/daemon/src/session/session-manager.ts
packages/daemon/src/daemon.ts
packages/daemon/src/commands/handlers.ts
```

Audit:

```text
packages/daemon/src/webchat/transport.ts
packages/daemon/src/evaluation/daemon-hooks.ts
packages/daemon/src/collab/coordinator.ts
packages/daemon/src/github/review-orchestrator.ts
packages/daemon/src/codehost/review-adapter.ts
```

## Tests

Add a synthetic case where:

```text
deliveryThread != sessionThread
```

even though the production resolver in PR 1 never emits that.

That proves the plumbing is real.

Key tests:

1. `currentSessionCoordinates` preserves current behavior.
2. `transcriptCoords` uses `sessionThread`.
3. `TurnPlan` carries separate physical and logical coordinates.
4. SessionManager stores session/transcript state under the logical coordinate.
5. Provider reply/status output still uses the physical coordinate.
6. `recordObservedInbound` matches by `sessionThread`.
7. Durable queue ordering uses the logical session key.
8. Existing Slack/Telegram/Discord/Feishu/Webchat routing tests remain unchanged.

## Acceptance criteria

- Every admitted `QueueEntry` carries explicit `SessionCoordinates`.
- The current resolver preserves today's semantics.
- Main-path session keys are derived from `sessionThread`.
- Transcript identity uses `sessionThread`.
- TurnPlan separates logical session and physical delivery coordinates.
- No DB/schema migration.
- No provider output destination changes.
- No user-visible behavior changes.
