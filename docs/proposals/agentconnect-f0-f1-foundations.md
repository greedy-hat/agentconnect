# AgentConnect F0/F1 foundations

Status: implemented foundation; not a Standing Work release gate.

## Contracts

`packages/daemon/src/execution/governance.ts` defines the daemon-side admission envelope.
It separates organization, agent, execution principal, actor, session/run, authorization
revision, trace, and fencing epoch. Provider input is not an authority source. Audience,
tool, and sandbox checks fail closed; an unknown tool or absent sandbox cannot be admitted.

The daemon store persists idempotent audit intents and bounded quota reservations. A
reservation is made before work begins, settles actual use once, and retains uncertainty
for later reconciliation. Audit metadata is redacted before it enters the durable outbox;
credentials, tokens, authorization data, raw input, arguments, and bodies are excluded.

## Verified production-blocker inventory

| Boundary                           | Current verified behavior                                                                            | Release implication                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Requested OS sandbox               | `prepareRuntimeLaunch` rejects a requested sandbox with no supported backend or trusted daemon root. | Fail closed for workloads that require isolation.                                                            |
| Codex inner tools                  | Daemon-owned permission profiles restrict filesystem/network access and protect credential roots.    | Existing profile tests cover protected-root and socket-channel cases.                                        |
| Execution audit                    | F1 persists idempotent intent records locally before forwarding.                                     | Full provider/effect forwarding and search remain A1 work.                                                   |
| Quotas                             | F1 reserves a finite allowance atomically and settles/reclaims only known use.                       | Hierarchical limits, billing, and offline leases remain B1 work.                                             |
| Arbitrary process/network coverage | No universal process or proxy instrumentation exists.                                                | Do not represent audit coverage as complete; autonomous releases require explicit backend capability checks. |

No Standing Work schema, scheduler, approval lifecycle, or notification behavior is enabled
by this foundation. W1--W6 remain intentionally out of scope.
