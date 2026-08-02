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
```

Each layer owns its protocol and failure semantics. A transport MUST NOT write
the ledger directly. The codec MUST NOT import MCP or provider SDKs. The
delivery layer MUST NOT parse provider output. A runtime adapter MUST return a
normalized outcome rather than inventing a message schema. Inbound client
configuration examples are documentation, not a runtime layer.

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
models. An adapter MUST deliver a prompt either as one non-shell-interpolated
argv element or through controlled stdin, never both. Native harness adapters
SHOULD prefer stdin so prompt bytes do not appear in process listings. Child
stdin MUST be controlled, and bounded child output MUST NOT contaminate the MCP
stdout protocol channel.

### Inbound client configuration

`mcp.json` verifies the generic packaged stdio command shape. `README.md`
documents equivalent OpenCode, Claude Code, and Codex examples. The repository
does not implement a canonical config renderer or executable translators for
those target formats. See `docs/CONFIG-TRANSLATION.md`.

## Current compatibility state

| Boundary | Current status | Truthful claim |
|---|---|---|
| Generic MCP stdio | `process-handshake-verified` | Packaged `npx -y meshfleet` starts and completes MCP initialization at the process boundary |
| Claude Code, Codex, OpenCode config | `documented` | README examples use the packaged stdio command; no generated-config or live semantic client claim |
| SSE inbox projection | `implemented` | Optional local inbox push, not a general A2A HTTP transport |
| Offline delivery-trace normalization | `reference-conformance` | The pure TypeScript evaluator and independent stdlib-only Python witness agree that modeled stdio, mailbox, HTTP/SSE, and WebSocket labels preserve one canonical envelope binding and distinct delivery observations; no transport or live interoperability is implemented |
| Durable execution coordinator | `recovery-verified` | Durable-mode `spawn_fleet` and `attach_agent` use fenced leases, deterministic persisted retry, launch-intent quarantine, scheduled recovery, recorded-PID containment only, sequence-ordered outbox, and compatibility projections on one SQLite authority |
| Outbound worker launch | `runtime-launch-verified` | `spawn_fleet` defaults to OpenCode and accepts a per-agent registered runtime id; selected non-default runtimes require their own validation and are refused before execution when unconfigured |
| OpenCode result normalization | `runtime-launch-verified` | OpenCode command, banner parsing, fallback, and provider diagnostics are isolated behind `OpenCodeRuntimeAdapter` |
| Provider-neutral runtime SPI | `runtime-launch-verified` | Core orchestration uses normalized execution contracts and an internal registry; `spawn_fleet` exposes per-agent runtime selection while `model` remains an OpenCode-specific selector |
| Local-process proof adapter | `runtime-launch-verified` | Deterministic local argv-only adapter covers process lifecycle without a provider, network, or credentials |
| Kimi CLI native adapter | `fixture-verified` | An env-gated non-default adapter proves stdin-only prompts, scrubbed environment policy, bounded final-message JSONL, isolation-gated unattended edits, and descendant cleanup against a fake executable; no live provider execution, OAuth inspection, version attestation, account binding, or quota observation is claimed |
| Claude Code CLI native adapter | `fixture-verified` | An env-gated non-default adapter proves stdin-only prompts, current print-mode argv, scrubbed environment policy, two-key workspace admission, safe noninteractive permission modes, hollow-success refusal, bounded output, and diagnostic redaction against a fake executable; no public account identity, credential, effective-model, quota, or attestation claim is made |
| Multi-host coordinator | `deferred` | No shared remote ownership authority exists |

Runtime failover is a separate execution concern. `src/failover.ts`,
`test/failover-decision.test.ts`, and the fixture-driven end-to-end proof in
`test/failover-end-to-end.test.ts` verify bounded provider-refusal classification,
candidate exclusion, an alternate stub launch, and persisted attempt/event
evidence. They do not prove a real provider outage, account availability, or
spend authority.

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
default execution remains OpenCode. `spawn_fleet` may select a separately
registered runtime, but this field does not create a credential flow,
account-control plane, automatic model choice, default token-budget policy, or
remote relay.
Account-specific provider operations are outside this public adapter contract.
The separate pure
`recommend_route` surface may opt in to caller-evidenced near-reset tie-breaking;
it never selects or runs this adapter. Environment-local model observations are
operator evidence and are not part of this public compatibility contract.

## Runtime selection (public `runtime` on `spawn_fleet`)

Each `spawn_fleet` agent may name a registered runtime adapter. Unknown ids are
refused before any fleet or agent row is written. Omitting the field preserves
the OpenCode default. A selected non-default adapter receives an explicit
scrubbed environment, new-session request, unattended workspace-edit request,
and the caller's optional opaque `workspace_binding`; the adapter remains the
authority that accepts or rejects that spec. Durable lifecycle mode refuses
per-agent runtime selection because its persisted agent row does not yet retain
the runtime id.

Registration is operator configuration, not public machine state. The Kimi and
Claude Code adapters require absolute command paths and optional configured
version labels. Their workspace-binding admission lists live in environment
configuration and contain opaque identifiers, never paths or account names.
Neither registration nor selection proves login, availability, entitlement,
quota, spend authority, effective model, or provider identity.

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

The implemented offline local-admission evaluator accepts independent raw
UTF-8 `request_json` and `envelope_json` texts and defines no wrapper envelope
or public object-tree entrypoint. Its closed
adapter-issued evidence carrier has an explicit `trusted_local_adapter`
provenance marker. The marker records an assumed boundary; it verifies no
adapter, credential, signature, trust root, login, account, provider session,
PID, banner, model, or receipt.

The closed `StaticHarnessMapping` sidecar for Codex, Codex CLI, Claude Code,
OpenCode, Antigravity/Gemini, Grok, and unknown harnesses emits
`authentication_evidence: null` and `principal_binding_input: null`. It is
implemented and fixture-verified by `src/a2a/static-harness-mapping.ts` and
`test/a2a-local-admission.test.ts`. It is not a config-renderer result and does
not emit client configuration. No `TransportAdapter`,
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

Additional live vendor adapters remain separate work. Executable client-config
renderers would require their own implementation and schema evidence before
they could be added to the verified matrix.

## Native Claude Code CLI boundary

`ClaudeRuntimeAdapter` implements Claude Code's noninteractive text print
surface: the prompt arrives on stdin and the final text arrives on stdout under
`-p --input-format text --output-format text --no-session-persistence
--safe-mode --no-chrome`. The adapter:

- requires an absolute operator-resolved executable and a configured version
  label; it neither searches `PATH` nor probes or attests the version;
- refuses ambient environment inheritance and explicit Anthropic, Claude,
  Bedrock, Vertex, Foundry, Azure, Google, and AWS routing overrides;
- supplies an adapter-owned minimal host-profile locator to the otherwise
  scrubbed child (`HOME` + `USER` on POSIX, or `USERPROFILE` + `USERNAME` on
  Windows, with the standard drive/path pair used only to derive a missing
  Windows profile); callers cannot supply or allowlist those names, and a
  missing host locator fails closed;
- leaves OAuth login, refresh, account selection, and credential storage
  entirely to Claude Code;
- requires the caller's verified opaque workspace binding to match the
  operator's admission list; the binding is authorization metadata, not an OS
  sandbox or account proof;
- maps plan requests to Claude Code `plan` mode and unattended workspace work
  to `auto`, preserving background safety checks rather than bypassing them;
- supports new ephemeral print sessions only and rejects interactive or resume
  requests;
- rejects OpenCode agent-file and `provider/model` selectors rather than
  translating them into a different Claude contract; omission uses the
  authenticated CLI account's default model;
- refuses empty exit-zero output, bounds both child streams, terminates the
  process group on timeout/cancellation, and never projects raw stderr; and
- reports no observed runtime model or account identity because text print mode
  supplies no independent evidence for either.

An operator enables reachability with `MESHFLEET_CLAUDE_COMMAND`, may record a
configured compatibility label with `MESHFLEET_CLAUDE_VERSION`, and admits
comma-separated opaque workspace bindings with
`MESHFLEET_CLAUDE_WORKSPACE_BINDINGS`. These values are private deployment
configuration and never belong in public descriptors or receipts.

## Native Kimi CLI boundary

`KimiRuntimeAdapter` implements only the official Kimi CLI 1.49 print contract
verified from installed source: text arrives on stdin and final assistant output
is emitted as newline-delimited JSON under `--print --input-format text
--output-format stream-json --final-message-only`. The adapter:

- requires an absolute operator-resolved executable path and a configured
  harness version; it does not search `PATH` or attest that version itself;
- refuses ambient environment inheritance and all `KIMI_*` / `OPENAI_*`
  overrides so a Kimi Code subscription binding cannot silently become an API
  key or alternate-base-URL accounting lane;
- never reads, imports, refreshes, or serializes OAuth credentials—the official
  CLI remains their sole owner;
- permits plan mode only with workspace edits forbidden, and permits unattended
  workspace edits only when the request names an opaque workspace binding
  pre-admitted by the adapter owner; the binding is authorization metadata, not
  an OS sandbox or proof that `--work-dir` contains shell access, and CLI-owned
  OAuth/session state remains outside that workspace claim;
- supports new one-shot sessions only; resume and interactive permission are
  rejected rather than silently widened;
- returns the last bounded final assistant text while rejecting malformed,
  empty, oversized, partial, role-changed, or schema-drifted JSONL; and
- drops raw Kimi stderr from normalized results because vendor diagnostics may
  repeat prompts, paths, or authentication details;
- labels the requested model as request data only. Kimi print JSON does not
  prove the effective model, provider account, entitlement, or billing lane.

The private Operator must verify the exact executable and configured version
(for example through the official machine-readable `kimi info --json` command),
map an opaque runtime/workspace binding to an authenticated installation, and
observe quota windows. None of those machine/account facts belong in public
Core descriptors or receipts.

# Minimum interoperable implementation

A codec-only implementation is conforming at the protocol layer when it
implements the v0.1 interoperability profile: validate/normalize canonical
envelopes, preserve unknown extensions, and exchange fixtures offline. It need
not implement MCP, a coordinator, a provider adapter, runtime execution,
principal binding, durable persistence, or public ingress.

Adapters remain the only source of a future authenticated principal context.
They must supply it outside the envelope; the codec must not infer authority
from sender claims, capabilities, model/runtime metadata, PIDs, or receipts.
