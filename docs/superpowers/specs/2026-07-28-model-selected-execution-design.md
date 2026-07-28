# Model-selected OpenCode execution design

## Decision

Expose one bounded execution choice through MeshFleet: a caller may optionally
set `model` on an agent passed to `spawn_fleet` or `attach_agent`. MeshFleet
persists that request as `Agent.requested_model`, launches OpenCode with
`--model <provider/model>`, and keeps the existing observed runtime banner in
`Agent.runtime_model`.

The existing requested-model classifier remains the fail-closed authority. A
selected model requires a parseable runtime banner and a match under the
existing `runtimeModelsMatch()` rule. Selection is therefore a real execution
input, while the banner remains observed evidence rather than attestation.

The same selection follows the agent through legacy retries, durable lifecycle
recovery, and Discussion wakeups. Discussion launches use the default
`RuntimeAdapter` instead of spawning `opencode` directly.

Omitting `model` preserves the current launch and classification behavior:
there is no `--model` argument, no banner requirement, and no new failure.

## Why this slice

MeshFleet can already observe and validate a requested model internally, but no
public producer supplies that request and the default OpenCode adapter does not
select it. That makes routing recommendations advisory rather than executable.
This slice closes that exact gap without adding a provider SDK, provider
catalog, credentials, a generic command adapter, or budget policy.

OpenCode's current CLI accepts `opencode run --model provider/model`, including
model identifiers with additional slashes after the provider. The installed
catalog includes both `opencode-go/...` and `kilo/...` namespaces, so this
single provider-neutral selector immediately makes those paid pools usable.

## Public contract

`spawn_fleet` accepts:

```ts
{
  agents: Array<{
    role: string;
    prompt: string;
    agent?: string;
    model?: string;
  }>;
}
```

`attach_agent` accepts:

```ts
{
  fleet_id: string;
  role: string;
  prompt: string;
  agent?: string;
  model?: string;
}
```

The field is named `model` at the MCP boundary and `requestedModel` or
`requested_model` inside the runtime and ledger layers. It must never be
inferred from `Capability.model`; capability model data is routing
self-description, not an execution request or observed identity.

## Validation

Validation occurs before a ledger write or process start.

A supplied model selector:

- is a string;
- has a JavaScript string length of at most 256 UTF-16 code units;
- contains no whitespace;
- contains a non-empty provider before its first `/`;
- contains a non-empty model identifier after its first `/`; and
- may contain additional `/` characters in the model identifier.

Examples:

- accepted: `opencode-go/minimax-m3`
- accepted: `kilo/kilo-auto/free`
- rejected: `minimax-m3`
- rejected: `/minimax-m3`
- rejected: `kilo/`
- rejected: `kilo /minimax`

MeshFleet does not trim, normalize, rewrite, or catalog-check the value.
`undefined` alone means omitted. `null`, empty, whitespace, and malformed
values are refusals rather than aliases for omission.

## Storage and evidence

`Agent` gains:

```ts
requested_model?: string;
```

`requested_model` is immutable request evidence written when the Agent row is
registered. `runtime_model` remains terminal observed evidence projected from
the runtime banner. The two fields are deliberately separate.

The Agent is stored in the existing JSON data column, so this additive optional
field requires no physical SQLite migration. Old ledgers remain readable.

The verifier adds only local consistency checks:

- a `complete` agent with `requested_model` but no `runtime_model` is an error;
- a `complete` agent whose two fields fail `runtimeModelsMatch()` is an error.

A failed or interrupted agent may lack `runtime_model`: spawn failure, timeout,
cancellation, or unparsable output can prevent observation. A matching pair
does not upgrade evidence above `observed` and does not prove authentication,
account ownership, provider availability, billing, or attestation.

## Runtime construction

`RunArgsInput` gains `requestedModel?: string`. `buildRunArgs()` constructs:

```text
run [--model <provider/model>] [--agent <agent-file>] <prompt>
```

The order is deterministic:

1. `run`
2. optional `--model`, value
3. optional `--agent`, value
4. prompt

`OpenCodeRuntimeAdapter` passes `ExecutionSpec.requestedModel` into
`buildRunArgs()`. Its existing result classifier already passes the same value
to `classifySpawnResult()`, so a successful child that reports a different or
missing banner fails normally with the raw output and observed identity
preserved.

No free-form arguments or environment variables are accepted from the caller.

## Legacy and durable lifecycle

Legacy `SpawnAgentInput` gains `requestedModel?: string`. Every call to
`trySpawn()` puts it on `ExecutionSpec`. Scheduled retries reuse the complete
input, so they cannot silently fall back to the default model.

`DurableAgentSpec` gains `requestedModel?: string`. `createFleet()` and
`attachAgent()` persist it on the Agent row. Every durable launch and recovered
retry reconstructs `ExecutionSpec.requestedModel` from
`state.agent.requested_model`, not from process memory. Recovery therefore
survives a server restart.

The request is not rewritten from a result. Terminal projection only writes
the existing `runtime_model`.

## Discussion runtime unification

`LedgerTx` gains a narrow, read-only launch lookup:

```ts
agentLaunchConfig(
  agentId: string,
  fleetId: string
): { requestedAgent?: string; requestedModel?: string } | undefined;
```

The reservation/start transaction reads the participant's persisted launch
configuration and copies it into `SpawnJob`, together with `fleet_id`. It
obtains that fleet id from the canonical head message already read in the
transaction, then refuses if the Agent row does not belong to that fleet. A
wake therefore inherits the same agent file and requested model as its Agent
row; the caller cannot override either through Discussion tools.

The production bridge constructs a complete `ExecutionSpec` as follows:

```ts
{
  fleetId: job.fleet_id,
  agentId: job.agent_id,
  prompt: buildDiscussionPrompt(job),
  requestedAgent: job.requested_agent,
  requestedModel: job.requested_model,
  cwd: process.cwd(),
  timeoutMs: Math.max(1, job.deadline - Date.now()),
}
```

The remaining deadline is a second containment bound; the Discussion store's
receipt-derived deadman remains authoritative.

The production Discussion spawn seam continues to satisfy the store's
synchronous `SpawnFn` contract by returning a deferred handle immediately:

1. construct an `ExecutionSpec` from the `SpawnJob`;
2. begin `RuntimeAdapter.start(spec)`;
3. return a synchronous proxy `SpawnHandle`;
4. once start resolves, honor any remembered cancellation and always call
   `RuntimeAdapter.wait(handle)` to drain the runtime;
5. map success to exit code `0` and every failure, cancellation, timeout, or
   wait rejection to a non-zero/null exit before invoking the existing
   `onExit` callback exactly once; and
6. make `killFn` mark cancellation immediately and delegate to
   `RuntimeAdapter.cancel()` as soon as a runtime handle exists.

This proxy is required because `RuntimeAdapter.start()` is asynchronous while
Discussion reservation and handle registration are deliberately synchronous.
It also closes the race where a deadman fires before adapter start resolves:
the proxy remembers cancellation and cancels the late handle rather than
orphaning it. Cancellation never skips `wait()` or the single `onExit`
settlement.

Discussion still launches once per reserved attempt and never automatically
retries. Reply admission and receipt-derived settlement remain authoritative.
A runtime failure or model mismatch invokes the existing exit path; it does not
synthesize a reply.

## Compatibility

- Callers that omit `model` produce the same OpenCode argv as before.
- Old Agent rows without `requested_model` continue to load and run.
- Existing requested-agent selection and classifier precedence are unchanged.
- Existing custom runtime builders still receive the full `ExecutionSpec`.
- Templates remain unchanged in this slice.
- Capability registration and route recommendation formats remain unchanged.
- The default runtime adapter remains OpenCode; there is no public adapter
  selector.

Adding `model` changes the advertised MCP catalog. After rebuilding `dist/`,
the black-box conformance catalog must be captured from the live stdio server,
the manifest pin updated to that observed SHA, `attach_agent`'s advertised
members updated, and the conformance runner re-run normally. The SHA must not
be guessed from source.

## Security and privacy

- The selector is data, never shell text; it is passed as one argv element.
- Validation rejects whitespace and missing provider/model components.
- No credential, token, account, endpoint, or provider configuration enters
  the MCP input or ledger.
- No provider catalog or network probe runs during validation.
- Existing child environment handling and redaction remain unchanged.
- Model selection does not authorize disclosure of task content. Existing
  portfolio information-trust rules remain the disclosure boundary.

## Non-claims and explicit exclusions

This slice does not:

- choose a model automatically;
- measure or drain subscription budgets;
- prove a request consumed a particular paid account;
- authenticate the observed banner;
- add Ollama Cloud's direct API;
- add Grok or MiniMax provider SDKs;
- add a generic argv or arbitrary-command adapter;
- change capability scoring or routing;
- modify templates;
- add multi-host execution;
- publish npm, deploy, or activate an autonomous drain.

Those are later slices. Budget-aware normal routing and pre-approved
speculative drain must remain separate policies so expiring-token pressure
cannot silently lower quality or privacy gates.

## TDD matrix

| Surface | Required proof |
|---|---|
| selector validation | valid `opencode-go/...` and multi-slash `kilo/...` accepted; non-string, blank, whitespace, missing provider/model, and overlength rejected before writes |
| argv | model-only and model-plus-agent exact vectors; omission exact regression |
| adapter | selected model reaches default argv; matching banner succeeds; missing/mismatched banner fails with observed data |
| public persistence | `spawn_fleet` and `attach_agent` store `requested_model`; omission leaves it absent |
| legacy retry | each retry receives the same `ExecutionSpec.requestedModel` |
| durable recovery | create/attach persist the selector; recovered launch reads it from the Agent row |
| verifier | complete selected run missing or contradicting `runtime_model` is an error; failed/interrupted absence is allowed |
| Discussion inheritance | selected participant produces an adapter spec with stored agent/model; omitted fields stay absent |
| Discussion cancellation race | deadman before async start resolution cancels the late runtime handle exactly once |
| Discussion result mapping | runtime failure/model mismatch follows existing failed-exit path; no retry or synthesized reply |
| conformance | rebuilt live catalog captured, manifest re-pinned, normal runner green |
| compatibility | full current suite remains green with omitted model |

## Acceptance

An optional valid `model` on `spawn_fleet` or `attach_agent` is persisted as
request evidence, executed by OpenCode, preserved through retries and
Discussion wakeups, and failed closed against observed runtime identity.
Omitting it remains behaviorally compatible, the catalog pin is regenerated
from the rebuilt server, and no broader routing, provider, budget, publication,
or deployment capability is claimed.
