# PR 2 — Conversation Session Mode Config + Capability Fence

## Goal

Complete the configuration surface for conversation session mode and make mixed-version rollout safe, while still **not** activating append runtime behavior.

The current repository already contains most of the data model:

- protocol `ChannelSessionMode = createNew | append`;
- `IntegrationCoreEnvelope.sessionModes[]`;
- Prisma `IntegrationChannel.sessionMode`;
- migration;
- repository persistence;
- per-conversation PATCH support;
- shared-bot sibling replication;
- integration projection;
- daemon `integrationCore().sessionModes`.

This PR should finish:

1. daemon lookup API;
2. web API/data/UI support;
3. capability negotiation;
4. server-side rollout fencing.

## Critical rollout rule

The daemon must not advertise append support until append runtime behavior is actually complete.

Define the feature constant now:

```ts
export const CONVERSATION_SESSION_MODE_V1_FEATURE =
  'conversation-session-mode-v1'
```

but do **not** add it to `registrationFeatures()` in this PR.

That advertisement belongs in the later runtime-activation PR.

## Server-side capability gate

A client request to change a channel to:

```json
{
  "sessionMode": "append"
}
```

must be rejected unless all affected serving placements support:

```text
conversation-session-mode-v1
```

Suggested error:

```json
{
  "error": "Conflict",
  "statusCode": 409,
  "code": "CONVERSATION_SESSION_MODE_UNSUPPORTED",
  "message": "Continuous conversation requires an upgraded daemon."
}
```

`createNew` must always remain allowed because it is the pre-feature behavior.

The capability check must happen before persistence.

## Shared bots

Session mode is replicated across sibling integrations on a shared bot.

Therefore append is allowed only if every affected sibling's serving placement supports the feature.

Example:

```text
Agent A daemon → supports append
Agent B daemon → old

Result:
  reject append
```

Do not allow one shared conversation to behave continuously for one agent and per-thread for another.

## Sets / pools

A current holder check is not sufficient if the agent can fail over to another member later.

Preferred rule:

```text
Pinned daemon:
  pinned daemon must support

Member set:
  every eligible member must support

Pool:
  every eligible pool member must support
```

Unknown capability should fail closed.

If set-wide gating is too large for this PR, use current-holder validation plus a hard projection fence, but the long-term target should remain set-wide compatibility.

## Integration feature helper

Add a control-plane helper, for example:

```text
packages/control-plane/src/domain/integration-features.ts
```

Suggested functions:

```ts
export function requiredIntegrationFeatures(
  channels: readonly IntegrationChannelRecord[]
): readonly string[] {
  return channels.some(
    (channel) => channel.sessionMode === 'append'
  )
    ? [CONVERSATION_SESSION_MODE_V1_FEATURE]
    : []
}
```

and:

```ts
export function daemonSupportsIntegration(
  channels: readonly IntegrationChannelRecord[],
  advertisedFeatures: readonly string[] | undefined
): boolean
```

Reuse the existing feature-advertisement predicate where possible.

Do not overload `requiredDaemonFeatures(agent)`: session mode belongs to integration/channel state, not the Agent row.

## Projection safety

The HTTP PATCH check improves UX but is not the correctness boundary.

Correctness requires:

> An append-configured integration must never be projected or live-pushed to a daemon that does not advertise the feature.

Why:

- a daemon may downgrade after configuration;
- an agent may move;
- a set holder may change;
- DB may already contain append from a previous version.

### Register reconcile

When assembling `RegisterOk.integrations[]`:

```text
load integration channels
  ↓
requiredIntegrationFeatures(...)
  ↓
compare with req.capabilities.features
  ↓
unsupported → withhold integration
```

Log only metadata:

- integrationId;
- agentId;
- daemonId;
- required feature names.

Never log token-bearing specs.

### Live integration/upsert

Apply the same capability fence to the live push path.

The invariant should be:

```text
every IntegrationSpec → daemon transmission
must pass required-integration-feature checks
```

This prevents snapshot-safe/live-unsafe drift.

## Daemon lookup API

Add one canonical helper in:

```text
packages/daemon/src/platforms/integration-config.ts
```

Suggested:

```ts
import type {
  ChannelSessionMode
} from '@agentconnect.md/protocol'

export function integrationSessionMode(
  int: Integration,
  channel: string
): ChannelSessionMode {
  return (
    integrationCore(int)
      .sessionModes
      .find((entry) => entry.channel === channel)
      ?.mode ?? 'createNew'
  )
}
```

Do **not** put session mode on `RoutingRule`.

Activation policy and session identity policy are orthogonal:

```text
routing/trigger:
  should this message activate the agent?

session mode:
  which logical session should the activation join?
```

PR 2 should add this helper but should not yet use it to alter session routing.

## Web API type drift

The control-plane DTO already carries `sessionMode`, but the web client's `IntegrationChannelDto` currently needs to mirror it.

Add:

```ts
export type ChannelSessionMode =
  | 'createNew'
  | 'append'
```

and:

```ts
sessionMode: ChannelSessionMode
```

to `IntegrationChannelDto`.

Update:

```ts
updateIntegrationChannel(
  integrationId,
  channelId,
  patch: {
    trigger?: ChannelTrigger
    sessionMode?: ChannelSessionMode
    agentId?: string
  }
)
```

## Web data model

Update `IntegrationChannelRow`:

```ts
sessionMode?: 'createNew' | 'append'
```

Keep it optional in the UI model for demo fixtures and rolling-upgrade tolerance.

Read as:

```ts
channel.sessionMode ?? 'createNew'
```

## Data context

Add:

```ts
setChannelSessionMode(
  integrationId: string,
  channelId: string,
  sessionMode: ChannelSessionMode
): Promise<void>
```

Use the existing channel PATCH endpoint.

Prefer server-success-first local updates because append may return a 409 capability error.

## UI

In:

```text
packages/web/src/components/console/IntegrationChannelList.tsx
```

add a second select control for session behavior.

Suggested labels:

```text
Per thread
Continuous
```

Suggested hints:

```text
Per thread:
Each new conversation thread starts a separate agent
session. Replies in that thread continue it.

Continuous:
Messages across this channel continue the same agent
session. Replies still appear where each question was asked.
```

Trigger and session mode should remain visually separate:

```text
Respond when:
  Off | @ Mention | Any message

Session:
  Per thread | Continuous
```

## Direct conversations

For the first version, do not expose the session-mode control for:

- 1:1 DMs;
- group DMs / mpim.

Reuse the existing direct-conversation helper.

## Capability in the UI

Do not make the web app independently reproduce placement/capability logic.

Expose an effective capability from the control plane, for example:

```ts
supportsAppendSessionMode: boolean
```

on `IntegrationDto`.

For shared bots this should already reflect every sibling placement that must support the feature.

Then UI and PATCH use the same authoritative CP calculation.

Before append runtime ships, the current daemon does not advertise the feature, so the UI should either:

- hide the Continuous option; or
- render it disabled with an upgrade-required hint.

Recommended rollout:

1. before runtime-ready: hide;
2. after release, old daemon: disabled + upgrade hint;
3. upgraded daemon: enabled.

## Existing append rows

Because current code already contains persistence paths, assume an existing DB may contain `append`.

Do not rewrite it to `createNew`.

Instead:

```text
configured append
+
unsupported daemon
→ withhold/degrade integration
→ surface upgrade required
```

Never silently execute createNew.

## Tests

### Persistence / API

- default channel → `createNew`;
- PATCH append → stored append;
- PATCH back to createNew;
- invalid enum rejected;
- shared bot change replicated across sibling rows.

### Capability

- old daemon + append PATCH → 409;
- new daemon + append PATCH → success;
- old daemon + createNew PATCH → success;
- unplaced/unknown support → reject;
- shared bot mixed support → reject;
- all siblings supported → success.

### Projection

- append config + missing daemon feature → integration omitted from register snapshot;
- append config + feature present → projected with sparse `sessionModes`;
- all createNew → `sessionModes: []`.

### Live update

- append config must not be live-pushed to an unsupported daemon;
- supported daemon receives the spec.

### Daemon lookup

- missing channel entry → createNew;
- configured append channel → append;
- other channel remains createNew.

### Web

- normal channel shows session control;
- DM/mpim does not;
- createNew renders Per thread;
- append renders Continuous;
- changing value calls `setChannelSessionMode`;
- unsupported capability hides/disables Continuous.

## Acceptance criteria

- Existing createNew behavior is unchanged.
- No daemon advertises `conversation-session-mode-v1` in this PR.
- Append cannot be newly persisted unless affected placements support the feature.
- Append-configured integrations are never sent to unsupported daemons.
- `sessionModes` remains sparse.
- Daemon has one canonical session-mode lookup helper.
- Web DTO matches CP DTO.
- Existing per-channel PATCH updates session mode.
- Direct conversations do not expose the control.
- Shared-bot replication remains intact.
- No new Prisma migration in this PR.
- No session key, transcript, inbox, or ACP behavior changes.

## Activation boundary

A later runtime PR should be the only place that adds:

```ts
CONVERSATION_SESSION_MODE_V1_FEATURE
```

to the daemon's advertised registration features.

That single advertisement becomes the production feature switch.
