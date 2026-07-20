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
| Durable execution coordinator | `recovery-verified` | Durable-mode `spawn_fleet` and `attach_agent` use fenced leases, deterministic persisted retry, scheduled recovery, diagnostic containment, sequence-ordered outbox, and compatibility projections on one SQLite authority |
| Outbound worker launch | `runtime-launch-verified` | `spawn_fleet` selects the internal OpenCode compatibility adapter; no public runtime selection exists |
| OpenCode result normalization | `runtime-launch-verified` | OpenCode command, banner parsing, fallback, and provider diagnostics are isolated behind `OpenCodeRuntimeAdapter` |
| Provider-neutral runtime SPI | `runtime-launch-verified` | Core orchestration uses normalized execution contracts and an internal registry; public runtime selection remains deferred |
| Local-process proof adapter | `runtime-launch-verified` | Deterministic local argv-only adapter covers process lifecycle without a provider, network, or credentials |
| Multi-host coordinator | `deferred` | No shared remote ownership authority exists |
| Slice 3B config renderers (generic/OpenCode/Claude/Codex) | `static-config-verified` | Canonical spec + 4 recursive-preflight renderers with deterministic tests; live client execution, Antigravity/Gemini/Grok schemas, real vendor outbound adapters, auth, network, remote relay remain unverified/deferred |

## Evidence levels

Implementations MUST label claims with one of these levels:

- `documented`: described or configured, with no executable proof.
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
