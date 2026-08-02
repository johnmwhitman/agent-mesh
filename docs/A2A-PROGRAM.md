# Agent-to-Agent Program

This is the canonical strategy and sequencing document for the next Agent Mesh
A2A program. It separates planned or designed work from implemented evidence;
it does not turn a design into an implementation claim.

## Scope ruling (2026-08-02): single-host is the product

Remote transport, authenticated network ingress, and production multi-host
coordination are **out of scope for this project** — a deliberate product
decision, not a pending phase. Agent Mesh is a local-first, single-host
coordination control plane; that is its identity, not its current limitation.
The offline witnesses (including the Slice 4E two-host coordinator witness)
remain maintained as protocol evidence: they price the semantics honestly so
the protocol stays interop-ready on paper, and any future transport would be a
separate project consuming these documents rather than an extension of this
server. Sections below that sequence transport-adjacent work are retained as
design records under this ruling.

## Current position

Agent Mesh currently provides a local coordination control plane with these
verified boundaries:

- The packaged `meshfleet` command provides a process-level MCP stdio handshake.
  Claude Code, Codex, OpenCode, and generic MCP clients are documented against
  the same inbound server shape, but live semantic conformance for each client
  is not yet claimed.
- Worker execution uses a provider-neutral runtime registry. OpenCode is the
  default; Kimi and Claude Code are configuration-gated fixture-verified
  adapters. `spawn_fleet` may select a registered runtime per agent in legacy
  lifecycle mode, while durable mode refuses that selector.
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
- Public canonical-envelope ingress, durable duplicate persistence,
  authenticated principals, public lifecycle controls, and production
  multi-host coordination remain unimplemented. The former Slice 4B acceptance
  writer and Slice 4C-0 reference implementation are absent from current main;
  their specifications remain design records.
- Slice 4A is reference-conformance verified. Slice 4C-1 remains an incomplete
  offline evidence path. Slice 4D has offline delivery-trace reference evidence,
  and Slice 4E has an offline two-host coordinator witness only.

## Slice 4C-1 bounded evidence-alpha

Slice 4C-1 is specified by the local admission profile and ADR 0007. A bounded
test-only evidence implementation now defines exactly one offline operation,
`evaluate-local-admission(request_json, envelope_json, replay_oracle)`, over two
independent raw UTF-8 texts. Its sole success is an ephemeral `admission_plan`;
replay/conflict/expiry are lowercase
`not_admitted` dispositions. Internal parsing, validation, binding,
authorization, replay classification, and unseen-only expiry are not APIs.

The internal replay-decision seam now fixes the copied canonical query shape and
closed oracle-to-outcome mapping used after authorization. It is not exported,
an authentication provider, a replay store, persistence integration, or a
transport implementation.

The design passes `envelope_json` unchanged to 4A, preserves its
envelope/recipient/numeric/depth/byte/digest semantics independently of request
parsing, projects every inherited failure as `MALFORMED_ENVELOPE`, keeps Slice 4B behind
preauthorization, treats policy snapshots as caller-supplied fixtures rather
than current-state proof, and keeps 4C-0 evidence non-authoritative. It adds no
public ingress, auth provider, trust root, credential verification, replay
store, persistence integration, MCP, network, transport, delivery, runtime,
provider call, release, or activation. The shared corpus currently has 44
mandatory cases, an independent Python witness, strict mutation canaries, and
seven positive plus fourteen negative StaticHarnessMapping fixtures. It does
not yet satisfy every exhaustive coverage row in the profile and is therefore
registered as `unverified`, not full Slice 4C-1 conformance.

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
canonical-envelope ingress, durable duplicate detection, remote transport, and
authenticated principals are not implemented in current main.

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
MCP output. Per-agent runtime selection is public in legacy lifecycle mode and
refused in durable mode. Kimi and Claude Code adapters are configuration-gated
and fixture-verified; that is not live account or availability evidence. No
target configuration renderer ships, and remote execution remains separate.

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
- Direct Codex, Antigravity/Gemini, Grok, or other additional vendor adapters.
  Kimi and Claude Code implementations already exist behind configuration and
  fixture gates; live account execution remains separately gated. Inbound
  client configurations are hand-authored documentation examples, not rendered.
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
2. **Slice 4B: explicit dormant durable acceptance foundation.** Design and
   migration records remain, but the acceptance writer is absent from current
   main. No released durable-acceptance surface is claimed.
3. **Slice 4C-0: capability profile and evidence taxonomy.** The specification
   and decision record remain, but the former reference implementation is absent
   from current main.
4. **Slice 4C-1: principal-bound authenticated-local semantic path.** Bounded
   evidence-alpha is executable but the exhaustive profile gate remains open.
   It models a local adapter path without public
   ingress, remote transport, credentials, or delivery and remains separately
   gated.
5. **Slice 4D then 4E:** 4D-alpha has a pure reference-conformance offline
   delivery-trace normalizer; an independent stdlib-only Python witness agrees
   with the TypeScript evaluator over the language-neutral corpus. It implements
   no transport and consumes no 4C-1 principal or admission result. The 4E
   deterministic two-host coordinator witness is implemented as a 24-case
   offline JS/Python differential model; it is not a production coordinator,
   network, consensus system, datastore, or multi-host authority.

`meshfleet.a2a` v0.1 remains a codec protocol. Its process-local identity
registry is not durable ingress identity. The public `send_a2a` tool remains
absent until all principal-binding, authorization, durable acceptance,
compatibility, and independent-review gates are satisfied.

## Slice 4B design record: dormant durable acceptance

The durable-acceptance specification and migration ADR remain as design
records. The acceptance writer is absent from current main, so current source
does not claim a durable canonical-ingress store. Public ingress,
authenticated remote identity, delivery, execution, transport activation, and
multi-host coordination remain outside this record.

## Slice 4C-0 capability profile closeout

Slice 4C-0 is specified in
[A2A Capability Profile v0.1](./A2A-CAPABILITY-PROFILE-v0.1.md) and
[ADR 0006](./adr/0006-capability-evidence-is-not-authority.md) and is
retained as a design record. Its former reference implementation is absent from
current main. The record separates non-authorizing claim provenance, proof
verification, external principal authentication, external authorization,
conformance maturity, and external local-persistence facts.

This design record authorizes no public ingress, `send_a2a`, principal provider,
provider call, runtime selection, transport, persistence, durable registry,
delivery, execution, cryptographic verification, credentials, network, deploy,
publish, merge, push, or activation. Slice 4C-1 remains offline, inactive,
incomplete, and separately gated. The later 4D-alpha fixture normalizer does
not satisfy, bypass, consume, or activate 4C-1; it only proves that modeled
transport labels normalize to the same closed delivery-observation vocabulary.
