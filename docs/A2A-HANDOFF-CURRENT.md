# Agent Mesh A2A Current Handoff

Status: **Three foundation slices implemented, verified, and independently approved**

This is the current successor handoff for the provider-neutral A2A program. It
records evidence and next actions; normative behavior remains in the canonical
documents linked below.

## Current state

- Branch: `codex/a2a-seamless-foundation`
- Branch base: `main` at `9d99952`
- Current head: `bb0ee43`
- Public package version remains `0.14.0`; nothing was merged, pushed, published,
  deployed, or remotely activated.
- Inbound coordination is MCP stdio and host-neutral at the packaged server
  boundary.
- Existing `spawn_fleet` behavior remains OpenCode-backed by default, now through
  a provider-neutral runtime adapter.
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

### Slice 2: isolated durable lifecycle authority

- Ordered physical SQLite storage migrations separate from logical schema v2.
- Transactional `work_items`, immutable attempts, and monotonic lifecycle events.
- Lease ownership, owner epochs, stale-worker fencing, distinct retry identities,
  final cancellation, terminal immutability, and replay.
- Database-level foreign keys and lifecycle constraints.
- Cross-process acquisition/settlement races, migration rollback, and
  close/reopen replay are covered.
- The kernel is not integrated with current spawning, retry, recovery, or MCP.

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

## Verification receipts

- TypeScript: `npm run typecheck` passed after the final code changes.
- Test suite: `455/455` passed at `feeb511`; `bb0ee43` is documentation-only.
- Slice 1 review: approved with no remaining Critical or Important findings.
  Package: `.superpowers/sdd/review-00885e4..7b4bc36.diff`.
- Slice 2 review: approved with no remaining Critical or Important findings.
  Package: `.superpowers/sdd/review-f37b2fd..8cbecb7.diff`.
- Slice 3 review: approved with no remaining Critical or Important findings.
  Package: `.superpowers/sdd/review-8cbecb7..bb0ee43.diff`.
- Earlier host-neutral foundation review was approved at `00885e4`.
- Live ledger verification: `ok=true`, zero errors, zero warnings; 34 fleets,
  82 agents, 4 messages, and 1 receipt.

## Canonical authorities

- [Program and sequencing](./A2A-PROGRAM.md)
- [Protocol v0.1](./A2A-PROTOCOL-v0.1.md)
- [Adapter contract](./ADAPTER-CONTRACT.md)
- [Configuration translation](./CONFIG-TRANSLATION.md)
- [Conformance matrix](./CONFORMANCE-MATRIX.yaml)
- [Threat model](./A2A-THREAT-MODEL.md)
- [Durable lifecycle contract](./A2A-NEXT-SLICE.md)
- [Layer-boundary decision](./adr/0001-a2a-layer-boundaries.md)
- [Lifecycle-authority decision](./adr/0002-durable-lifecycle-authority.md)
- [Runtime-adapter decision](./adr/0003-runtime-adapter-boundary.md)
- [Compatibility registry](../COMPATIBILITY.md)

## Explicitly not implemented

- Public canonical `send_a2a` ingress.
- Authenticated transport principals, sender binding, or authorization policy.
- Durable duplicate persistence across public ingress requests.
- Lifecycle-driven `spawn_fleet`, retry scheduling, recovery, or public
  cancellation.
- Public runtime selection or real Claude/Codex/Gemini/Grok outbound adapters.
- Live Claude/Codex/Antigravity/Gemini/Grok client conformance; current renderer
  evidence is static configuration only.
- Remote relay, shared coordinator, or multi-host execution.

## Next integration stage

Integrate the verified lifecycle authority and runtime adapter in one bounded
single-host execution slice:

1. Persist a logical work item and first pending attempt before adapter launch.
2. Acquire a lease before starting a worker and require attempt/owner/epoch for
   terminal settlement.
3. Make retry eligibility durable; timers become scheduling optimizations only.
4. Recover expired leases rather than trusting PID liveness as authority.
5. Keep cancellation internal until its authorization and MCP contract are
   separately reviewed.
6. Preserve every existing MCP input/output contract and continue to describe
   the system as single-host until a shared authenticated coordinator exists.
