# Agent Mesh A2A Current Handoff

Status: **Slice 1 implemented, verified, and independently approved**

This is the current successor handoff for the provider-neutral A2A program. It
records evidence and next actions; normative behavior remains in the canonical
documents linked below.

## Current state

- Branch: `codex/a2a-seamless-foundation`
- Slice base: `00885e4`
- Verified head: `7b4bc36`
- Public package version remains `0.14.0`; nothing was published or deployed.
- Inbound coordination is MCP stdio and host-neutral at the packaged server
  boundary.
- Outbound worker execution remains OpenCode-backed.
- Agent Mesh remains a local trusted control plane and single-host SQLite
  authority. It is not authenticated cross-host coordination.

## Implemented and verified

- `meshfleet.a2a` version `0.1` envelope types, validation, codec, and stable
  semantic identity fingerprinting.
- Namespace-aware agent references and explicit canonical recipients.
- Internal legacy direct and broadcast mapping without changing MCP tool names,
  accepted inputs, return shapes, ledger schema, receipt behavior, or payload
  limits.
- A language-neutral JSON conformance corpus covering all five message types,
  validation failures, duplicate/conflict behavior, and legacy direct/broadcast
  mapping.
- Legacy self-messages remain a local compatibility-only projection and cannot
  be encoded as canonical wire messages.

## Verification receipts

- TypeScript: `npm run typecheck` passed at `7b4bc36`.
- Test suite: `438/438` passed at `7b4bc36`.
- Independent whole-slice review: approved with no Critical or Important
  findings after two correction rounds.
- Review package:
  `.superpowers/sdd/review-00885e4..7b4bc36.diff`
- Live ledger verification: `ok=true`, zero errors, zero warnings; 33 fleets,
  81 agents, 4 messages, and 1 receipt.

## Canonical authorities

- [Program and sequencing](./A2A-PROGRAM.md)
- [Protocol v0.1](./A2A-PROTOCOL-v0.1.md)
- [Adapter contract](./ADAPTER-CONTRACT.md)
- [Threat model](./A2A-THREAT-MODEL.md)
- [Durable lifecycle contract](./A2A-NEXT-SLICE.md)
- [Layer-boundary decision](./adr/0001-a2a-layer-boundaries.md)
- [Compatibility registry](../COMPATIBILITY.md)

## Explicitly not implemented

- Public canonical `send_a2a` ingress.
- Authenticated transport principals, sender binding, or authorization policy.
- Durable cross-request duplicate persistence.
- Durable attempts, leases, fencing, cancellation, transactional lifecycle
  events, or replay-backed recovery.
- Provider-neutral runtime adapters or a second outbound runtime.
- Remote relay, shared coordinator, or multi-host execution.

## Next slice

Implement the additive durable lifecycle kernel defined in
[A2A-NEXT-SLICE.md](./A2A-NEXT-SLICE.md): separate SQLite storage migrations,
`work_items`, immutable attempts, owner epochs, leases, cancellation, atomic
lifecycle events, and replay. Do not wire it into spawning or describe it as
multi-host until its separate acceptance and review gates pass.

