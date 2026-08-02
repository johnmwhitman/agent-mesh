# MeshFleet A2A current handoff

This is a public, source-bound orientation to the A2A program. Specifications,
ADRs, current source, and executable fixtures outrank this summary.

## Current position

- The `meshfleet.a2a` v0.1 codec and legacy mapping are implemented with an
  independent Python reference and language-neutral fixture evidence. There is
  no public authenticated canonical-envelope ingress or `send_a2a` MCP tool.
- The durable lifecycle kernel is implemented for single-host SQLite authority:
  fenced leases, persisted retries, recovery, cancellation, and a repairable
  event outbox. It is not multi-host coordination.
- The runtime registry is provider-neutral. OpenCode is the default; Kimi and
  Claude Code are configuration-gated fixture-verified adapters. Per-agent
  runtime selection is available in legacy lifecycle mode and refused in
  durable mode.
- Slice 4C-1 is a test-only offline local-admission evaluator. Its 44 mandatory cases,
  Python agreement, and static harness sidecar do not complete every
  exhaustive profile gate, so it remains `unverified` and unexported.
- Slice 4D has a pure delivery-trace normalizer with independent Python
  reference evidence. It models transport labels but implements no live
  transport, wake path, authenticated principal, or interoperability.
- The Slice 4E two-host coordinator witness is implemented as a deterministic
  24-case offline JS/Python differential model. It is not a production
  coordinator, network, consensus system, datastore, or multi-host authority.

## Design records that do not ship

- The Slice 4B durable-acceptance specification and migration ADR remain, but
  the acceptance writer is absent from current main.
- The Slice 4C-0 capability-profile specification and decision record remain,
  but the former reference implementation is absent from current main.
- Static harness mapping is a separate test-only sidecar. It emits null identity
  fields and does not restore Slice 4C-0, render client configuration, or grant
  authentication or authorization.

## Advisory boundary

Route-candidate compilation and recommendation are deterministic projections
over caller-supplied evidence. They do not contact providers, verify accounts,
refresh budgets, execute work, perform runtime failover, persist authority, or
authorize spend. Runtime failover is a separate execution concern and is proven
only with deterministic stub runtimes.

## Canonical authorities

- [Program and sequencing](./A2A-PROGRAM.md)
- [Protocol v0.1](./A2A-PROTOCOL-v0.1.md)
- [Local-admission profile](./A2A-LOCAL-ADMISSION-PROFILE-v0.1.md)
- [Delivery-trace profile](./A2A-DELIVERY-TRACE-PROFILE-v0.1.md)
- [Adapter contract](./ADAPTER-CONTRACT.md)
- [Configuration boundary](./CONFIG-TRANSLATION.md)
- [Conformance matrix](./CONFORMANCE-MATRIX.yaml)
- [Threat model](./A2A-THREAT-MODEL.md)
- [Compatibility registry](../COMPATIBILITY.md)

## Next sequence

1. Complete the remaining Slice 4C-1 exhaustive profile gates without adding a
   public ingress surface.
2. Expand Slice 4D transport evidence without upgrading it to live transport or
   interoperability.
3. Production multi-host coordination, authenticated ingress, and remote
   transport are OUT OF SCOPE for this project (scope ruling, 2026-08-02 —
   see A2A-PROGRAM.md). Any future transport is a separate project consuming
   these documents, not an activation of this server.
