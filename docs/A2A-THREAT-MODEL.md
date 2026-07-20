# A2A Threat Model

Agent Mesh is currently a local trusted control plane. It is not yet a secure
cross-boundary A2A network. Any remote transport must establish a new trust
boundary rather than inherit local MCP assumptions.

## Trust zones

```text
Zone 0  Operator host: filesystem, credentials, environment, ledger
Zone 1  Inbound clients: MCP stdio, local SSE, future remote callers
Zone 2  Agent Mesh core: routing, receipts, capabilities, lifecycle authority
Zone 3  Worker runtimes: OpenCode today, future adapters later
Zone 4  External providers and remote mesh peers
Zone 5  Audit and recovery: SQLite, events, receipts, inspection, verification
```

The current practical boundary is between the trusted local caller and the
local core. SSE can use a bearer token when configured, but that token is not a
per-agent principal. Stdio relies on the OS process boundary.

## Threats and required controls

### Spoofed agents and receipts

Caller-supplied sender IDs and locally recorded receipts can attribute work to
the wrong actor. Future transports MUST bind an authenticated principal to the
sender, recipient, send, receive, acknowledge, capability, and lifecycle
operations. Conflicts MUST fail closed. Receipts MUST distinguish ledger
observation from authenticated actor evidence.

### Capability poisoning

Capabilities are self-described routing hints. A compromised agent can claim
skills or a model to attract work. Capabilities MUST carry provenance, scope,
expiry, and confidence before they influence authorization. They MUST NOT be
authorization by themselves.

### Replay and duplicate delivery

At-least-once delivery can repeat messages and external side effects. Canonical
message IDs, dedupe keys, audience, issued and expiry times, durable duplicate
detection, and conflicting-ID rejection are required. Idempotency MUST NOT be
called exactly-once execution.

### Stale workers and late settlement

PID liveness is local process evidence and cannot fence a restarted worker. The
durable lifecycle kernel requires work IDs, immutable attempt IDs, owner IDs,
owner epochs, lease expiry, conditional renewal and settlement, cancellation,
and transactional lifecycle events. A stale or cancelled settlement MUST be
rejected.

### Confused deputy and unauthorized execution

The mesh can spawn processes, route work, write the ledger, and pass prompts to
external providers. A message MUST NOT be treated as authorization. The system
needs explicit action scopes, destination policy, authorization decisions, and
audit provenance separating requested action from authorized action.

### Secret and data egress

Prompts, outputs, file paths, and inherited environment variables may cross
provider or host boundaries. Worker environments MUST be allowlisted. Sensitive
payloads and artifacts MUST have a classification and explicit egress policy.
Credentials, secrets, personal data, and production data MUST remain excluded
unless an explicit human and policy gate authorizes the transfer. Receipts,
events, diagnostics, and inspector output MUST redact secrets.

### Cross-host false confidence

SQLite WAL and `BEGIN IMMEDIATE` provide same-host write exclusion only. A
shared SQLite file is not a multi-host ownership protocol. Actual cross-host
operation requires a shared transactional coordinator, authenticated workers,
lease-time authority, clock-skew policy, transport authentication, and remote
failure semantics.

### Audit overclaiming

Structural verification can detect malformed or inconsistent local records. It
cannot prove who wrote a record, whether a runtime claim is genuine, whether a
side effect happened exactly once, or whether post-transaction event projection
lost an event. Evidence labels must preserve those limits.

## Required invariant substitutions

The architecture MUST preserve these distinctions:

```text
capability claim        != authorization
model string            != runtime attestation
receipt row             != actor authenticity
PID liveness            != durable ownership
message acknowledgment  != task completion
MCP reachability        != cross-host trust
```

## Security gates for the program

- Slice 1 must reject invalid versions, recipients, timestamps, expiry, body
  size, duplicate IDs, and conflicting ID reuse without provider metadata.
- Slice 2 must prove fencing, cancellation races, terminal immutability,
  transaction/event atomicity, migration safety, and replay.
- Slice 3 must prove argv safety, environment policy, child isolation,
  normalized evidence levels, and no MCP stdout contamination.
- Any real vendor or remote adapter requires explicit review of credentials,
  network access, spend, private-data egress, authentication, audience, and
  replay protection.
# Slice 4 ingress trust boundary

The envelope sender is a routing claim, not authenticated identity. A future
adapter-derived opaque principal must be bound to the exact sender before
authorization, identity lookup, or persistence. Message text, capabilities,
model/runtime/PID assertions, scope, audience, and receipts never grant
authority. Canonical fan-out must authorize all concrete recipients atomically
and must not expand any metadata selector.

An accepted future ingress decision means durable local commit only. It never
proves recipient receipt, runtime execution, external side effect, exactly-once
behavior, signature, attestation, remote trust, or multi-host coordination.
Detailed policy diagnostics stay in protected local audit evidence; public
errors must be stable and non-enumerating.

