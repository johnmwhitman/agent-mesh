# A2A Adapter Contract

This document defines the boundaries required to translate Agent Mesh semantics
across clients, transports, runtimes, and future coordinators. The interfaces
below are design contracts; they are not claims that all adapters exist.

## Layer model

```text
TransportAdapter
  MCP stdio / SSE / HTTP / CLI / mailbox
        |
        v
EnvelopeCodec + DeliveryPort
  validate, normalize, route, deduplicate, project
        |
        v
DurableCoordinator
  attempts, leases, fencing, retry, cancellation, replay
        |
        v
RuntimeAdapter
  OpenCode / local process / Claude / Codex / future runtimes
        |
        v
ConfigRenderer
  canonical connection spec -> target harness configuration
```

Each layer owns its protocol and failure semantics. A transport MUST NOT write
the ledger directly. The codec MUST NOT import MCP or provider SDKs. The
delivery layer MUST NOT parse provider output. A runtime adapter MUST return a
normalized outcome rather than inventing a message schema. A renderer MUST NOT
emit credentials.

## Contracts

### TransportAdapter

Converts a client or wire transport into canonical envelopes and back into
transport-specific responses. It owns connection lifecycle, framing, transport
authentication hooks, backpressure, and transport errors. It does not decide
whether a message is authorized or how a worker is executed.

### EnvelopeCodec and DeliveryPort

`EnvelopeCodec` validates and serializes `meshfleet.a2a` envelopes. It is pure
and provider-neutral. `DeliveryPort` resolves concrete recipients, persists
deduplication identity, inserts inbox projections, and maps legacy MCP calls.
It owns message delivery semantics, not task execution semantics.

### DurableCoordinator

Owns logical work, immutable attempts, lease ownership, owner epochs,
cancellation, retry eligibility, transactional lifecycle events, and replay.
The current SQLite ledger is not this distributed coordinator. Slice 2 first
proves the kernel for one SQLite authority; a future multi-host coordinator
requires a shared transactional authority and authenticated worker identity.

### RuntimeAdapter

A runtime adapter accepts a provider-neutral execution request and returns a
normalized result. Its responsibilities include command construction,
authentication expectations, stdout/stderr capture, timeout and cancellation,
working-directory policy, environment allowlisting, runtime-specific parsing,
and evidence labeling.

```ts
interface RuntimeAdapter {
  readonly id: string;
  describe(): RuntimeDescriptor;
  validate(request: ExecutionRequest): ValidationResult;
  start(request: ExecutionRequest): Promise<ExecutionHandle>;
  wait(handle: ExecutionHandle, signal?: AbortSignal): Promise<RuntimeResult>;
  cancel(handle: ExecutionHandle, reason: string): Promise<CancelResult>;
}
```

The core MUST NOT branch on provider names, banners, commands, or requested
models. Prompts MUST be passed as argv data, never shell-interpolated. Child
stdin MUST be controlled, and child output MUST NOT contaminate the MCP stdout
protocol channel.

### ConfigRenderer

Renders one canonical connection descriptor into a target's configuration,
such as generic MCP JSON, OpenCode JSONC, Claude Code configuration, Codex
configuration, or a future harness manifest. A renderer reports unsupported
features instead of silently dropping them. Target schemas must be verified
before a renderer is called supported.

## Current compatibility state

| Boundary | Current status | Truthful claim |
|---|---|---|
| Generic MCP stdio | `process-handshake-verified` | Packaged `npx -y meshfleet` starts and completes MCP initialization at the process boundary |
| Claude Code, Codex, OpenCode config | `static-config-verified` | Slice 3B renderers produce proven shapes from README/mcp.json evidence; live semantic client execution remains unverified |
| SSE inbox projection | `implemented` | Optional local inbox push, not a general A2A HTTP transport |
| Offline delivery-trace normalization | `reference-conformance` | The pure TypeScript evaluator and independent stdlib-only Python witness agree that modeled stdio, mailbox, HTTP/SSE, and WebSocket labels preserve one canonical envelope binding and distinct delivery observations; no transport or live interoperability is implemented |
| Durable execution coordinator | `recovery-verified` | Durable-mode `spawn_fleet` and `attach_agent` use fenced leases, deterministic persisted retry, launch-intent quarantine, scheduled recovery, recorded-PID containment only, sequence-ordered outbox, and compatibility projections on one SQLite authority |
| Outbound worker launch | `runtime-launch-verified` | `spawn_fleet` uses the internal OpenCode compatibility adapter; callers may select its model, but there is no public runtime-adapter selector |
| OpenCode result normalization | `runtime-launch-verified` | OpenCode command, banner parsing, fallback, and provider diagnostics are isolated behind `OpenCodeRuntimeAdapter` |
| Provider-neutral runtime SPI | `runtime-launch-verified` | Core orchestration uses normalized execution contracts and an internal registry; there is no public runtime-adapter selector (a public `model` selector is exposed at the MCP boundary and flows through the default OpenCode adapter) |
| Local-process proof adapter | `runtime-launch-verified` | Deterministic local argv-only adapter covers process lifecycle without a provider, network, or credentials |
| Multi-host coordinator | `deferred` | No shared remote ownership authority exists |
| Slice 3B config renderers (generic/OpenCode/Claude/Codex) | `static-config-verified` | Canonical spec + 4 recursive-preflight renderers with deterministic tests; live client execution, Antigravity/Gemini/Grok schemas, real vendor outbound adapters, auth, network, remote relay remain unverified/deferred |

`ExecutionSpec.requestedModel` carries the validated public `model` selector to
the OpenCode adapter and fail-closes classification when the observed banner
model is missing or contradictory. This is still a raw-label check only: it
does not authenticate a provider, prove an account or billing path, or attest
runtime identity.

## Model selection (public `model` on `spawn_fleet` / `attach_agent`)

Callers may optionally pass a `model` selector (a `provider/model` string) on each
agent passed to `spawn_fleet` or `attach_agent`. The selector is an execution
input, not runtime identity:

- the value is validated before any ledger write or process start: it must be a
  string, at most 256 UTF-16 code units, contain no whitespace, and contain a
  non-empty provider and non-empty model identifier around a `/`;
- the validated selector is persisted on the Agent row as
  `Agent.requested_model`, an immutable request record;
- the default OpenCode adapter emits `opencode run --model <provider/model>`
  with the selector as a single argv element; legacy in-process retries reuse
  the original validated request, while durable retry/recovery, attach, and
  Discussion wakeups read the stored request back from the Agent row and place
  it on `ExecutionSpec.requestedModel`; and
- `Agent.runtime_model` remains the observed OpenCode banner, and
  `runtimeModelsMatch()` is the existing fail-closed check: a `complete`
  selected agent whose banner is missing or contradicts the request fails
  locally. Banner agreement is observed evidence only, not authentication,
  account ownership, provider availability, billing, or attestation.

Omitting `model` preserves the prior launch and classification behavior
exactly: no `--model` argument, no banner requirement, no new failure. The
default execution remains OpenCode; there is still no public runtime-adapter
selector, no vendor SDK or catalog, no credential flow, no account-control
plane, no automatic model choice, no default token-budget policy, no remote
relay, no publish, and no deploy in this slice.
Account-specific provider operations are outside this public adapter contract.
The separate pure
`recommend_route` surface may opt in to caller-evidenced near-reset tie-breaking;
it never selects or runs this adapter. Local smoke tests exercised
the installed OpenCode IDs `opencode-go/minimax-m3` and
`kilo/kilo-auto/free`; this is environment-local observed execution, not a
general provider-availability claim.

## Evidence levels

Implementations MUST label claims with one of these levels:

- `documented`: described or configured, with no executable proof.
- `fixture-verified`: pure executable fixtures prove a closed semantic mapping
  without a live process, peer, transport, or network boundary.
- `static-config-verified`: generated or checked configuration has the expected
  shape, without a live client.
- `process-handshake-verified`: a process starts and completes the protocol
  handshake at the boundary.
- `semantic-tool-verified`: representative tool calls and return shapes work
  through the target client or transport.
- `runtime-launch-verified`: a runtime adapter launches and settles work with a
  normalized result.
- `recovery-verified`: restart, expiry, fencing, cancellation, and replay have
  executable evidence.
- `observed`: an adapter observed runtime output or metadata.
- `reported`: a runtime reported its own identity.
- `attested`: an independently trusted, authenticated statement; no current
  Agent Mesh path provides this for worker identity.
- `ledger`: a local authority recorded a fact. Ledger evidence is not actor
  authentication.

Requested model, advertised capability, observed banner, reported runtime, and
attested identity MUST remain distinct fields. None may be silently promoted to
another evidence level.

## Slice 4C-1 adapter-evidence design boundary

The designed-not-implemented local admission profile accepts independent raw
UTF-8 `request_json` and `envelope_json` texts and defines no wrapper envelope
or public object-tree entrypoint. Its closed
adapter-issued evidence carrier has an explicit `trusted_local_adapter`
provenance marker. The marker records an assumed boundary; it verifies no
adapter, credential, signature, trust root, login, account, provider session,
PID, banner, model, or receipt.

The closed `StaticHarnessMapping` sidecar for Codex, Codex CLI, Claude Code,
OpenCode, Antigravity/Gemini, Grok, and unknown harnesses emits
`authentication_evidence: null` and `principal_binding_input: null`. It is not
part of `RendererResult`. Its validator and executable seven-target positive
and required negative fixtures are a future 4C-1 implementation gate outside
the admission corpus; no current conformance evidence exists. No `TransportAdapter`,
`RuntimeAdapter`, renderer, MCP session, or process receipt implements this
trust boundary. The sole success is an ephemeral plan, not adapter acceptance
or lifecycle state.

## Adoption sequence

1. Define the pure envelope and conformance fixtures.
2. Build the isolated durable lifecycle kernel.
3. Extract OpenCode behind the runtime contract.
4. Prove a deterministic local process adapter without credentials or network.
5. Gate exactly one real vendor adapter on authentication, spend, network, and
   private-data policy.
6. Design a shared coordinator before using the phrase multi-host.

Real vendor adapters remain separate work. Additional target renderers require
separate schema evidence before they can be added to the verified matrix.
# Minimum interoperable implementation

A codec-only implementation is conforming at the protocol layer when it
implements the v0.1 interoperability profile: validate/normalize canonical
envelopes, preserve unknown extensions, and exchange fixtures offline. It need
not implement MCP, a coordinator, a provider adapter, runtime execution,
principal binding, durable persistence, or public ingress.

Adapters remain the only source of a future authenticated principal context.
They must supply it outside the envelope; the codec must not infer authority
from sender claims, capabilities, model/runtime metadata, PIDs, or receipts.
