# Agent Mesh - Coordination Engine

**Status**: Core implemented; inbound MCP stdio process handshake verified

This file is the high-level orientation document for Agent Mesh. The canonical
A2A strategy, protocol, adapter, threat, and decision documents own the details.
This file intentionally does not duplicate their registries or acceptance bars.

## Canonical A2A documents

- [A2A program](docs/A2A-PROGRAM.md) - ranked slices, sequencing, gates, and status
- [A2A protocol v0.1](docs/A2A-PROTOCOL-v0.1.md) - normative envelope and legacy mapping
- [Adapter contract](docs/ADAPTER-CONTRACT.md) - transport, delivery, runtime, coordinator, and renderer boundaries
- [Threat model](docs/A2A-THREAT-MODEL.md) - trust zones, threats, controls, and evidence limits
- [ADR 0001](docs/adr/0001-a2a-layer-boundaries.md) - accepted layer-boundary decision
- [Durable lifecycle contract](docs/A2A-NEXT-SLICE.md) - next implementation acceptance bar
- [Compatibility registry](COMPATIBILITY.md) - public API and conformance evidence
- [Roadmap](ROADMAP.md) - shipped, planned, and exploratory work

## Current architecture

Agent Mesh is a local-first MCP coordination server. Compatible clients connect
through the packaged stdio server, invoke coordination tools, and share a local
SQLite ledger. Outbound work launches independent processes through a
provider-neutral runtime adapter contract. OpenCode remains the default.
Callers may choose an operator-registered runtime per agent in legacy lifecycle
mode; durable mode refuses that selector. Kimi and Claude Code are shipped as
fixture-verified, non-default adapters with explicit configuration gates.

```text
MCP client
  -> MCP stdio
    -> Agent Mesh coordination core
      -> local SQLite ledger
      -> selected registered runtime adapter
        -> independent worker process
      -> optional local SSE inbox projection
```

The inbound MCP boundary and outbound runtime registry are separate. A provider
selected with OpenCode's `provider/model` argument is still OpenCode-routed
execution; a per-agent runtime selector chooses a separately registered
adapter. Neither label proves account identity, entitlement, availability, or
billing.

## Current guarantees

- Existing MCP tool names, input shapes, and return shapes remain additive.
- The SQLite ledger provides same-host transactional write exclusion.
- The packaged `npx -y meshfleet` process completes the MCP initialization
  handshake.
- The canonical A2A codec validates and fingerprints provider-neutral
  envelopes; its public evidence is offline conformance, not authenticated
  ingress.
- The durable lifecycle kernel provides fenced leases, persisted retries,
  recovery, cancellation, and a repairable event outbox on one SQLite
  authority.
- The provider-neutral runtime adapter registry normalizes execution outcomes
  and accepts per-agent runtime selection in legacy lifecycle mode;
  unconfigured selections and durable-mode selection fail closed.
- Messages are at-least-once ledger delivery with receipt-derived acknowledgment
  projections.
- Capabilities are self-described routing metadata.
- Runtime metadata is observation or report data, not attestation.

## Explicit non-guarantees

The current system does not claim:

- Authenticated principal binding or signed sender and receipt identity.
- General HTTP A2A transport or remote relay behavior.
- Production multi-host coordination or shared remote ownership. The two-host
  witness is a deterministic offline model only.
- Exactly-once external side effects.

## Extension rule

New A2A work must first identify its canonical layer:

1. Protocol and envelope semantics belong in `docs/A2A-PROTOCOL-v0.1.md`.
2. Transport, delivery, execution, and configuration boundaries belong in
   `docs/ADAPTER-CONTRACT.md`.
3. Durable ownership and replay belong in `docs/A2A-NEXT-SLICE.md` and its
   implementation ADRs.
4. Trust and authorization claims belong in `docs/A2A-THREAT-MODEL.md`.
5. Public compatibility claims belong in `COMPATIBILITY.md`.

Do not add provider-specific fields to the protocol envelope, treat a message as
authorization, or call local SQLite behavior multi-host coordination.

## Repository orientation

```text
src/index.ts       MCP server and current orchestration wiring
src/core.ts        ledger domain operations and message semantics
src/db.ts          SQLite persistence and same-host transaction seam
src/spawn-config.ts OpenCode command construction compatibility code
src/spawn-result.ts OpenCode output and runtime evidence parsing
src/sse-server.ts  optional local inbox stream projection
```

The source layout above is an orientation map only. The canonical A2A documents
and compatibility registry define the contracts and evidence status.

## Security posture

Agent Mesh assumes a trusted local process boundary by default. SSE bearer
authentication is optional and does not itself create per-agent identity.
Sensitive execution, credentials, external egress, production data, deployment,
and remote activation remain explicit policy and human gates. See the [threat
model](docs/A2A-THREAT-MODEL.md) and [security policy](SECURITY.md).
