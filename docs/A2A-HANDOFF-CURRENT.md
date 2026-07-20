# Agent Mesh A2A Current Handoff

Status: **Foundation slices, bounded durable execution, and Slice 4A portable ingress-contract reference conformance implemented; single-host only**

This is the current successor handoff for the provider-neutral A2A program. It
records evidence and next actions; normative behavior remains in the canonical
documents linked below.

## Current state

- Branch: `codex/a2a-seamless-foundation`
- Branch base: `c278e33`
- Final approved Slice 4A range: `c3abd78..e895a83`; this handoff records the
  implementation, verification, and independent-review receipts while
  preserving the earlier integration receipts below.
- Public package version remains `0.14.0`; nothing was merged, pushed, published,
  deployed, or remotely activated.
- Inbound coordination is MCP stdio and host-neutral at the packaged server
  boundary.
- Legacy `spawn_fleet` remains OpenCode-backed by default. Durable mode uses the
  same internal adapter through a lease-fenced coordinator without exposing a
  runtime-selection field.
- Agent Mesh remains a local trusted control plane and single-host SQLite
  authority. It is not authenticated cross-host coordination.

## Implemented and verified

### Slice 1: canonical protocol and conformance

- `meshfleet.a2a` version `0.1` envelope types, validation, codec, and stable
  semantic identity fingerprinting.
- Namespace-aware agent references and explicit canonical recipients.
- Internal legacy direct and broadcast mapping without changing MCP tool names,
  inputs, return shapes, ledger schema, receipt behavior, or payload limits.
- Language-neutral JSON conformance corpus covering all five message types,
  validation, duplicate/conflict behavior, and legacy mapping.
- Legacy self-messages remain a local compatibility-only projection and cannot
  be encoded as canonical wire messages.

### Slice 2: durable lifecycle authority and bounded execution integration

- Ordered physical SQLite storage migrations separate from logical schema v2.
- Transactional `work_items`, immutable attempts, and monotonic lifecycle events.
- Lease ownership, owner epochs, stale-worker fencing, distinct retry identities,
  final cancellation, terminal immutability, and replay.
- Database-level foreign keys and lifecycle constraints.
- Cross-process acquisition/settlement races, migration rollback, and
  close/reopen replay are covered.
- Physical SQLite v3 persists fleet mode, captured retry policy, attempt number,
  eligibility, due indexes, and an event outbox while logical ledger schema
  remains v2.
- `MESHFLEET_LIFECYCLE_MODE` defaults new fleets to legacy; existing/missing
  modes remain legacy. Shadow preserves legacy authority. Durable mode wires
  `spawn_fleet` and `attach_agent` to lease-driven execution with unchanged MCP
  inputs and outputs.
- Durable retry and restart recovery are lease-based and wake at persisted due
  boundaries; non-expired work is never reclaimed from PID absence. Expired
  recorded diagnostic child PIDs are best-effort contained before replacement.
  A pre-registration launch crash is terminally quarantined for manual recovery
  rather than replaced; managed durable agents remain excluded from legacy PID
  recovery.
- Lifecycle and legacy Fleet/Agent projections settle atomically with a
  transactional, sequence-ordered SQLite outbox. NDJSON is an idempotent,
  repairable projection.

### Slice 3: runtime and configuration adapters

- Provider-neutral runtime SPI and internal adapter registry.
- Existing OpenCode execution extracted into the default compatibility adapter.
- Deterministic local-process adapter proves a second execution runtime without
  provider credentials, network access, or spend.
- Timeout and cancellation wait for child termination, with SIGTERM-to-SIGKILL
  escalation and exact-once normalized settlement.
- Canonical MCP stdio connection descriptor and static renderers for generic MCP,
  OpenCode, Claude Code, and Codex configurations supported by local evidence.
- Shared fail-closed secret preflight and complete emitted-or-unsupported field
  accounting.
- Machine-readable inbound/outbound conformance matrix.

### Slice 4A: portable canonical-ingress contract and reference conformance

- Ranked Slice 4A/4B/4C strategy separates portable contract proof, dormant
  durable acceptance, and any later authenticated-local/public surface review.
- Principal-bound canonical-ingress contract defines semantic message identity,
  request retry identity, authorization-before-replay ordering, stable
  non-enumerating dispositions, recipient normalization, and the durable-local
  acceptance boundary without exposing an ingress.
- Coordinator-free interoperability profile requires no Meshfleet install,
  MCP, coordinator, provider, credentials, network, or runtime.
- Standalone offline Python reference witness is independent of the TypeScript
  production codec and agrees with the language-neutral corpora.
- TypeScript and Python agree on strict raw-envelope and JSON-media parsing,
  recursive duplicate detection, Unicode-scalar and exact numeric domains,
  bounded depth/size, finite acyclic plain JSON value trees, and preservation of
  valid unknown extensions.
- Versioned custom canonical digest
  `meshfleet.a2a.fingerprint.v1:sha256:<hex>` has exact cross-language vectors
  and remains envelope-only, unsigned, unauthenticated, and non-attesting.
- Language-neutral ingress corpus exercises the designed principal binding,
  authorization, replay, conflict, expiry, atomicity, and external-code rules.

Slice 4A is **reference-conformance only**. It does not implement a public
ingress, durable acceptance store, authenticated principal, delivery path,
remote transport, or multi-host authority.

## Verification receipts

- TypeScript: `npm run typecheck` passed after the final code changes.
- Final test suite: `474/474` passed at `2ce185e` after all lifecycle,
  migration, recovery, outbox, compatibility, and crash-window corrections.
- Slice 1 review: approved with no remaining Critical or Important findings.
  Package: `.superpowers/sdd/review-00885e4..7b4bc36.diff`.
- Slice 2 review: approved with no remaining Critical or Important findings.
  Package: `.superpowers/sdd/review-f37b2fd..8cbecb7.diff`.
- Slice 3 review: approved with no remaining Critical or Important findings.
  Package: `.superpowers/sdd/review-8cbecb7..bb0ee43.diff`.
- Bounded lifecycle/runtime integration review: approved at `2ce185e` with no
  remaining Critical or Important findings after whole-slice migration,
  fencing, recovery, launch-quarantine, and outbox review. Package:
  `.superpowers/sdd/review-c278e33..2ce185e.diff`.
- Earlier host-neutral foundation review was approved at `00885e4`.
- Live ledger verification: `ok=true`, zero errors, zero warnings; 34 fleets,
  82 agents, 4 messages, and 1 receipt.
- Final Slice 4A independent GPT-5.5 `xhigh` review approved range
  `c3abd78..e895a83` with no Critical or Important findings.
- Final Slice 4A verification: full `npm test` passed `500/500`;
  `npm run typecheck` passed.
- Final live ledger verification: `ok=true`, `0` errors, `0` warnings; fleets
  `34`, agents `82`, messages `4`, receipts `1`, ratifications `0`.
- Portfolio Conductor structural validator exited `0`.
- Final Slice 4A review package:
  `.superpowers/sdd/review-c3abd78..e895a83-a2a-portable-ingress-contract.diff`.

## Canonical authorities

- [Program and sequencing](./A2A-PROGRAM.md)
- [Protocol v0.1](./A2A-PROTOCOL-v0.1.md)
- [Canonical ingress contract v0.1](./A2A-INGRESS-CONTRACT-v0.1.md)
- [Interoperability profile v0.1](./A2A-INTEROPERABILITY-PROFILE-v0.1.md)
- [Adapter contract](./ADAPTER-CONTRACT.md)
- [Configuration translation](./CONFIG-TRANSLATION.md)
- [Conformance matrix](./CONFORMANCE-MATRIX.yaml)
- [Threat model](./A2A-THREAT-MODEL.md)
- [Durable lifecycle contract](./A2A-NEXT-SLICE.md)
- [Layer-boundary decision](./adr/0001-a2a-layer-boundaries.md)
- [Lifecycle-authority decision](./adr/0002-durable-lifecycle-authority.md)
- [Runtime-adapter decision](./adr/0003-runtime-adapter-boundary.md)
- [Principal-bound ingress decision](./adr/0004-principal-bound-canonical-ingress.md)
- [Compatibility registry](../COMPATIBILITY.md)

## Explicitly not implemented

- Public canonical `send_a2a` ingress.
- Authenticated transport principals, sender binding, or authorization policy.
- Durable duplicate persistence across public ingress requests.
- Public cancellation, public runtime selection, or any multi-host lifecycle
  authority.
- Public runtime selection or real Claude/Codex/Gemini/Grok outbound adapters.
- Live Claude/Codex/Antigravity/Gemini/Grok client conformance; current renderer
  evidence is static configuration only.
- Remote relay, shared coordinator, or multi-host execution.

## Next integration stages

1. Completed Slice 4A: portable protocol/ingress semantics, coordinator-free
   profile, independent Python witness, strict cross-language value domain,
   canonical digest, and language-neutral ingress corpus.
2. Next Slice 4B gate: review the design, then implement only through an ordered
   physical SQLite migration and a dormant internal durable acceptance journal
   with local decision receipts. No hidden/lazy schema, public tool, legacy
   projection, delivery, or authentication claim.
3. Later Slice 4C gate: prove an adapter-derived authenticated local principal
   and semantic client path, then separately review any public ingress surface.
   No remote or multi-host claim follows from local evidence.

## Lifecycle visibility update

- Branch base for this bounded slice: `3115a9d`.
- Implemented: private copied-file, read-only SQLite snapshots; namespaced
  lifecycle verifier findings; `inspect --lifecycle [fleet]` with
  `meshfleet.lifecycle/v1`; redacted metadata summaries; outbox lag and
  repair-needed visibility with no repair command.
- Preserved: existing MCP stdio behavior, default inspector text, existing JSON
  schemas, logical verifier counts, and public package version `0.14.0`.
- Deferred: source-coordinated live-WAL certification, repair execution,
  lifecycle controls, remote transport, multi-host ownership, daemon/dashboard,
  and public ingress.

## Lifecycle visibility approval receipt

- Approved range: `3115a9d..77dabf1`.
- Independent GPT-5.5 high review found no Critical or Important findings.
- Verification: `npm test` passed `483/483`; `npm run typecheck` passed.
- Live ledger verification: `ok=true`, `0` errors, `0` warnings; counts are
  fleets `34`, agents `82`, messages `4`, receipts `1`, ratifications `0`.
- Portfolio Conductor structural validator exited `0`.
- Review package: `.superpowers/sdd/review-3115a9d..77dabf1-lifecycle-visibility.diff`.

## Next active strategy lane

Slice 4B design/implementation gate: ordered physical SQLite migration plus a
dormant internal durable acceptance journal and local decision receipts. The
package remains `0.14.0`; `send_a2a` remains absent; no storage migration has yet
been added for this lane; existing MCP tools, defaults, logical schema v2, and
physical schema v3 remain unchanged.

Slice 4B does not authorize a public tool, message delivery, authenticated
principal claim, transport/auth activation, merge, push, publish, deploy,
spend, secret use, private-data egress, or remote activation. All existing
human gates remain in force.
