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

### Tampered model channel

Zone 3 reaches Zone 4 over a channel this project does not verify. Anything on
that path — a relay service, an aggregating gateway, a local proxy installed to
add models to a vendor harness — can read and modify both the outbound request
and the inbound response. The specific move is to append or replace `tool_use`
blocks in a response, so a worker executes actions the operator never requested.
Data collected that way need not return to the model, so the visible output
reads as normal.

This threat is different in kind from every other entry above, and the
difference is the point. For a well-formed injection, `verify_ledger` correctly
reports `ok: true`: the worker really performed the recorded mesh actions, or left
none, and the forged thing — instruction authenticity on the Zone 3 → Zone 4 path
— is not a ledger field. The falsification corpus enumerates ledger *mutations*;
this attack is not one, so it sits outside that bucket rather than missing from
it.

Two sub-cases, and the distinction matters operationally:

```text
injected work that never calls this server   leaves NO ledger trace at all
injected work that calls this server WELL    leaves a consistent, passing ledger
injected work that calls this server BADLY   may trip existing checks by accident
```

Only the third is detectable, and it is detectable by luck rather than by design
— a forged `seen` receipt on a real message is already published as undetectable,
while the same forgery pointing at a message id that does not exist is caught as
`receipt.orphan_message`. An attacker who stays well-formed stays invisible.
Detection here is a property of the attacker's carelessness, not of the auditor,
and must never be described as coverage.

The published `undetectable` bucket therefore understates this class rather than
covering it. `undetectable-payload-swap-after-ack` is a mutation of ledger data;
this is an uncompromised ledger faithfully recording compromised instructions.

Required controls, none of which live in this repo's verification path:

```text
third-party relays      MUST be treated as Zone 4 and hostile
unauthenticated hops    MUST NOT carry worker traffic
any local proxy         MUST be operator-owned and auditable
tool calls              SHOULD be allow-listed client-side before execution
worker runtimes         SHOULD be sandboxed so an injected call is bounded
provider base URL       is a credential-class change, not a config tweak
```

A blanket ban on third-party relays would be ignored: real deployments front
providers with aggregating gateways and corporate proxies. The requirement is
therefore classification, not abstinence. Note also that a transparent
intermediary — a TLS-intercepting corporate proxy — needs no base-URL change to
occupy this position, so the base-URL rule above is necessary and not sufficient.

Record signing and hash-chaining do not repair this. A signed record of forged
intent is durably attributable, not true, so that guarantee stops at authorship
and integrity of the record and does not extend to the authenticity of the
instruction that produced it. Closing the gap itself would need evidence about the
Zone 3 → Zone 4 exchange — transcript attestation or an authenticated channel —
which is a different mechanism from ledger integrity, not a stronger version of
it.

## Required invariant substitutions

The architecture MUST preserve these distinctions:

```text
capability claim        != authorization
model string            != runtime attestation
receipt row             != actor authenticity
PID liveness            != durable ownership
message acknowledgment  != task completion
MCP reachability        != cross-host trust
model response          != operator intent
signed record           != truthful record
```

## Slice 4C-1 local admission threats

Slice 4C-1 has a bounded, dormant evidence-alpha evaluator with independent raw UTF-8
`request_json` and `envelope_json` inputs and no wrapper/object-input API. The
request parser cannot classify envelope failures; all envelope raw/semantic
failures project through 4A as `MALFORMED_ENVELOPE`. Its
`trusted_local_adapter` marker exposes an assumption and
is not self-authentication. It requires exact principal/session binding, one
fixed action, message type, all concrete recipients, and audience equality
before replay. Denials collapse to `AUTHORIZATION_DENIED`; only protected local
diagnostics may retain a closed cause.

Binding and authorization snapshots are caller-supplied fixtures with explicit
IDs, versions, provenance markers, and intervals. A decision is relative to the
fixtures and proves no operational freshness, provenance, revocation, or
administrative authority. The profile does not mitigate assumed-adapter
compromise, forged carriers, snapshot tampering, key lifecycle, replay-store
compromise, or plan-to-journal races. An admission plan is not durable
acceptance, receipt, delivery evidence, or lifecycle authority. Capabilities,
proofs, models, runtimes, receipts, provider state, and conformance cannot
influence authorization.

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
## Slice 4 ingress trust boundary

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

Unknown principals, sender mismatches, denied recipients, denied message types,
audience failures, and all other policy denials MUST collapse externally to
`AUTHORIZATION_DENIED`. Their distinct causes may appear only in protected
local audit records. Current binding and authorization checks MUST run before
request-replay and semantic-identity lookups, so revocation or current denial
cannot replay an old acceptance or disclose whether an identity exists.

Raw canonical JSON is an earlier trust boundary than object validation. A
future transport/public ingress MUST reject duplicate object names recursively
before parsing into the object-level codec. Protocol strings containing
unpaired UTF-16 surrogates are invalid; valid non-BMP Unicode scalars remain
allowed and are byte-limited as UTF-8. The existing MCP surface is not evidence
of either raw canonical parsing behavior or public ingress.

## Slice 4B dormant journal threats

- **Migration shadowing or partial schema:** v3-to-v4 preflights the reserved
  `a2a_` namespace, runs in the global `BEGIN IMMEDIATE` chain, sets version
  last, and rejects unknown/malformed/partial/tampered layouts. Reopen validates;
  it never repairs lazily.
- **Raw identity/content retention:** only domain-separated keyed tokens, key
  IDs, canonical digest, minimal acceptance provenance, request outcome, and one
  local-decision receipt may persist. Raw IDs, envelope bytes, payloads,
  extensions, recipients, `dedupe_key`, policy/denial, paths, and runtime data
  are forbidden.
- **Token/digest confidentiality overclaim:** tokens are pseudonymous equality
  handles, not encryption. Digests can permit guessing; timing, counts, and
  equality remain observable. A direct DB reader is trusted local.
- **Confused storage deputy:** the API accepts only pre-authorized/pre-tokenized
  inputs after current all-recipient authorization, but does not verify auth.
  No message content can call or authorize it.
- **Negative identity reservation:** conflict, expiry, denial, malformed input,
  and storage failure write nothing. Only accepted identities and accepted/
  duplicate request mappings persist.
- **Receipt inflation:** exactly one immutable `accepted` receipt at
  `internal_local_decision` exists per acceptance. Duplicate/replay paths never
  mint another receipt.
- **Rollback illusion:** old v3 binaries cannot reopen v4. A WAL-safe
  pre-migration backup is mandatory evidence; there is no automatic downgrade.
- **Retention erosion:** v1 has no deletion, tombstone, or retention job.
  Accepted rows remain permanent until a reviewed forward migration.

These controls remain design requirements. They do not prove public ingress,
authentication, authorization, delivery, confidentiality, or multi-host safety.

## Slice 4B verified storage boundary (2026-07-20)

Physical SQLite v4 is locally verified but dormant. It accepts no raw identities
or secrets: trusted callers provide canonical unpadded 32-byte base64url keyed
tokens and `key_id` values, while opaque acceptance and receipt IDs are generated
locally. The journal stores no raw envelope, payload, extension, policy, path,
runtime, denial, conflict, or delivery/outbox data. Exact schema validation runs
on open and first within each acceptance transaction, failing closed on partial,
tampered, squatted, or foreign-dependent layouts. This does not elevate
capability claims, model banners, evaluator metadata, or local receipts into
authentication, authorization, attestation, delivery, or execution evidence.

## Slice 4C-0 capability-profile threats

A discovery profile is a confused-deputy boundary. Capability claims,
provider/model banners, runtime observations, and durable local receipts MUST
remain non-authorizing and mutually non-promoting evidence. The profile rejects
raw identities, credentials, prompts, payloads, endpoint/path/environment data,
and global runtime fingerprints; protected diagnostics MUST not echo rejected
content. Reserved proof-carrier fields remain unsupported until a separately
reviewed verifier defines trust roots, issuer namespace, rotation, revocation,
audience/session binding, nonce replay, and privacy. See
[A2A Capability Profile v0.1](./A2A-CAPABILITY-PROFILE-v0.1.md) and
[ADR 0006](./adr/0006-capability-evidence-is-not-authority.md).
