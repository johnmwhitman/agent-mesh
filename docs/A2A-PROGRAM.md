# Agent-to-Agent Program

This is the canonical strategy and sequencing document for the next Agent Mesh
A2A program. It describes work that is planned or designed; it does not turn a
design into an implementation claim.

## Current position

Agent Mesh currently provides a local coordination control plane with these
verified boundaries:

- The packaged `meshfleet` command provides a process-level MCP stdio handshake.
  Claude Code, Codex, OpenCode, and generic MCP clients are documented against
  the same inbound server shape, but live semantic conformance for each client
  is not yet claimed.
- Worker execution is still coupled to `opencode run`. A different provider
  selected inside OpenCode is not a second runtime adapter.
- SQLite provides same-host transactional write exclusion. It is not a
  multi-host lease or ownership protocol.
- Messages, receipts, and capabilities are local ledger records. They are not
  authenticated identity claims or runtime attestations.
- The `meshfleet.a2a` v0.1 codec, language-neutral fixture corpus, and internal
  legacy mapping are implemented, verified, and independently reviewed.
- The durable attempt lifecycle is integrated with `spawn_fleet` and
  `attach_agent` only for explicitly durable, single-host fleets. It persists
  deterministic retries, launch-intent quarantine, scheduled lease recovery, and a sequence-ordered
  NDJSON-repair outbox without changing MCP
  inputs or outputs.
- Public canonical-envelope ingress and its durable duplicate persistence,
  authenticated principals, public lifecycle controls, and public runtime
  selection remain unimplemented. Private durable duplicate persistence is
  implemented and verified only in the dormant Slice 4B journal. The
  provider-neutral RuntimeAdapter SPI plus isolated
  OpenCode and deterministic local-process adapters are implemented and
  runtime-launch-verified; they are not yet public multi-runtime orchestration.
- Slice 4A is reference-conformance verified. Slice 4B is implemented and
  locally verified, dormant, and not activated: physical SQLite v4, the private
  acceptance journal, and its migration/privacy/atomicity evidence exist only
  on this unmerged branch.

## Ranked program

### Slice 1: Canonical A2A envelope and conformance

**Objective:** Give every transport and harness one small provider-neutral
semantic language without changing existing MCP APIs.

**Exact scope:**

- Define `meshfleet.a2a` version `0.1` in
  [A2A-PROTOCOL-v0.1.md](./A2A-PROTOCOL-v0.1.md).
- Use namespace-aware agent references, stable `message_id`, explicit concrete
  recipients, finite integer times, content-typed payloads, and extension data.
- Expand legacy `to_agent_id: "*"` before canonical encoding; never put a
  wildcard on the wire.
- Add a pure codec and legacy mapping layer with no MCP or provider imports.
- Define a fixture corpus usable by a generic JSON client and future language
  implementations.
- Keep existing `send_message`, `send_messages`, `get_inbox`, `ack_message`,
  and receipt shapes unchanged.
- Defer public `send_a2a` until namespace, deduplication, authorization, and
  compatibility semantics have passed review.

**Evidence gate:** A focused conformance suite must prove valid round trips,
unknown-major rejection, timestamp and payload limits, duplicate and conflicting
ID behavior, deterministic broadcast expansion, legacy projection, and provider-
independent imports. Existing MCP compatibility tests must remain unchanged.

**Status:** Codec, fixture corpus, and legacy internal mapping implemented and
covered by focused conformance plus existing API-compatibility tests. Public
canonical-envelope ingress, its durable duplicate detection, remote transport,
and authenticated principals are not implemented. The private dormant Slice 4B
journal's durable duplicate detection is implemented and locally verified.

### Slice 2: Durable lifecycle kernel

**Objective:** Replace process-local attempt assumptions with a crash-safe,
replayable state machine before wiring durability into spawning or claiming
distributed execution.

**Exact scope:**

- Add an independent SQLite storage-schema migration path while preserving
  logical ledger `schema_version` compatibility.
- Add logical `work_items`, immutable `attempts`, and transactional lifecycle
  events with database-allocated monotonic sequence numbers.
- Define `attempt_id`, `owner_id`, `owner_epoch`, `lease_until`, cancellation,
  terminal immutability, conditional settlement, and replay.
- Inject time for deterministic tests and make stale settlement fail closed.
- Keep the first slice isolated from `spawn_fleet`, timers, PID recovery, MCP
  tool shapes, and the existing NDJSON projection.

**Evidence gate:** Migration upgrade and rollback tests, lease fencing races,
cancellation-versus-completion behavior, duplicate terminal settlement,
transaction/event atomicity, close/reopen replay, and preservation of existing
ledger fixtures must all pass independent review.

**Status:** The SQLite lifecycle authority is integrated with durable-mode
`spawn_fleet` and `attach_agent`, persisted retry eligibility, launch-intent quarantine, lease recovery,
fenced settlement, compatibility projections, and a transactional event outbox.
Legacy behavior remains the default and shadow remains legacy-authoritative. No
multi-host coordination claim is made.

**Boundary:** This slice proves a durable state machine for one SQLite
authority. It must not be called multi-host coordination.

### Slice 3: Provider-neutral runtime and transport adapters

**Objective:** Remove OpenCode from the architectural center and prove that the
same coordination lifecycle can execute through more than one runtime.

**Exact scope:**

- Introduce separate transport, envelope/delivery, runtime, coordinator, and
  configuration-renderer contracts.
- Move the current OpenCode launch and result parsing behind an
  `OpenCodeRuntimeAdapter` compatibility boundary.
- Implement a deterministic local-process adapter first, using argv arrays,
  controlled environments, isolated stdin, and normalized outcomes.
- Compare lifecycle behavior across the local fixture and OpenCode adapters
  without treating requested model metadata as runtime proof.
- Add configuration renderers only where target schemas are verified.
- Consider exactly one real Claude or Codex CLI adapter after the local proof;
  authentication, network, spend, and private-data gates remain explicit.

**Evidence gate:** Adapter contract tests must cover success, failure, timeout,
cancellation, signal termination, stderr diagnostics, working directory,
environment policy, child-output isolation, and evidence-level identity. A real
vendor smoke test is opt-in and cannot be required for the offline suite.

**Status:** Slice 3A implemented with a provider-neutral runtime contract,
internal registry, OpenCode compatibility adapter, and deterministic local
process proof. `spawn_fleet` remains OpenCode-backed by default with unchanged
MCP input/output. Bounded durable single-host lifecycle integration is
implemented; real vendor adapters, target configuration renderers, public
runtime selection, and remote execution remain separate.

## Sequencing and dependencies

1. Slice 1 establishes the semantic substrate. Do not add external transports
   or a public canonical-envelope tool before its conformance gate passes.
2. Slice 2 can be prototyped after the state contract is reviewed, but its
   storage must not be presented as distributed until a shared coordinator
   exists.
3. Slice 3 consumes the stable semantic and lifecycle boundaries. The local
   adapter is the first runtime proof; real vendor adapters are separate gates.
4. The bounded single-host wiring is accepted only with the lifecycle and MCP
   compatibility evidence; public cancellation and multi-host coordination
   remain separate architecture gates.

## Deferred and gated work

The following are intentionally outside the three initial slices or require a
separate human and architecture gate:

- A networked multi-host coordinator or remote durable datastore.
- Authenticated transport principals, sender binding, and per-operation
  authorization.
- Signed messages, signed receipts, or runtime attestations.
- Public `send_a2a`, public cancellation, and remote control APIs.
- Direct Claude, Codex, Antigravity/Gemini, Grok, or other vendor adapters (Slice 3B adds only inbound static config renderers; outbound remains deferred).
- Production deployment, external relay activation, credentials, spend, and
  private-data or production-data egress.
- Exactly-once external side effects. Idempotency and fencing do not provide
  that guarantee.

## Canonical artifact roles

| Artifact | Authority |
|---|---|
| `docs/A2A-PROGRAM.md` | Ranked strategy, gates, sequencing, and status |
| `docs/A2A-PROTOCOL-v0.1.md` | Versioned wire envelope and legacy mapping |
| `docs/ADAPTER-CONTRACT.md` | Transport, delivery, runtime, coordinator, and renderer boundaries |
| `docs/A2A-THREAT-MODEL.md` | Trust zones, threats, controls, and security invariants |
| `docs/A2A-NEXT-SLICE.md` | Durable lifecycle contract and acceptance bar |
| `docs/A2A-DURABLE-ACCEPTANCE-v0.1.md` | Slice 4B physical migration, private journal, transaction, privacy, and evidence contract |
| `docs/adr/` | Durable decisions and their tradeoffs |
| `COMPATIBILITY.md` | Public API, ledger, and conformance registry |
| `ROADMAP.md` | Product sequencing and shipped-versus-planned view |
| `AGENT-MESH-SPEC.md` | High-level orientation and pointers, not duplicated registries |
| `README.md` | User-facing install, current capabilities, and honest limitations |

Review packages, test output, and handoffs are evidence of a state; they do not
replace these normative documents.

## Lifecycle visibility update

The bounded lifecycle authority now has a read-only verification and inspection
slice. SQLite remains authority; NDJSON remains a non-authoritative projection.
This adds no ingress, control, activation, remote transport, multi-host claim,
or public runtime selection.
# Ranked Slice 4 Program

The next three slices are ordered to establish portable protocol evidence before
durable local acceptance, and durable local acceptance before any public API.
They are additive, reversible, and do not widen the current MCP surface.

1. **Slice 4A: canonical semantics and independent portability proof.** Freeze
   `docs/A2A-INGRESS-CONTRACT-v0.1.md`; add a standalone Python reference
   witness and language-neutral fixtures. This is codec/profile evidence only:
   no production ingress/store/tool, delivery, legacy projection, transport,
   authentication, or multi-host claim.
2. **Slice 4B: explicit dormant durable acceptance foundation.** Implemented
   and locally verified at `f1f98fb` over `acc4090..f1f98fb`: ordered physical
   SQLite v4, a three-table private journal, exact schema validation,
   request-first durable classification, and accepted-only local receipts. It
   remains unmerged, unpublished, inactive, and below public ingress.
3. **Slice 4C-0: capability, identity, and runtime-attestation profile.** Next
   specification-first slice; capability claims and model banners do not grant
   authorization.
4. **Slice 4C-1: principal-bound authenticated-local semantic path.** Then
   prove a local adapter path without public ingress, remote transport,
   credentials, or delivery.
5. **Slice 4D then 4E:** offline delivery-attempt/transport conformance
   followed by a deterministic two-host coordinator simulation; both remain
   unimplemented.

`meshfleet.a2a` v0.1 remains a codec protocol. Its process-local identity
registry is not durable ingress identity. The public `send_a2a` tool remains
absent until all principal-binding, authorization, durable acceptance,
compatibility, and independent-review gates are satisfied.

## Slice 4B closeout: dormant durable acceptance (2026-07-20)

Slice 4B is **implemented and locally verified, not activated** at
`f1f98fb` (`acc4090..f1f98fb`). It advances durable local acceptance only:
physical SQLite v4 with logical ledger schema v2, an internal package-private
journal, exact pre-mutation schema validation, request-first identity ordering,
and one honest local-decision receipt per accepted semantic identity.

It does not establish public ingress, authenticated remote identity, delivery,
execution, transport activation, multi-host coordination, or interoperability
with any named provider. Capability claims and model/runtime banners remain
non-authorizing data. The subsequent program sequence is 4C-0
capability/identity/runtime-attestation profile, 4C-1 principal-bound
authenticated-local semantic path, 4D offline delivery-attempt and transport
conformance, then 4E deterministic two-host coordinator simulation. Public or
remote activation remains human-gated.
