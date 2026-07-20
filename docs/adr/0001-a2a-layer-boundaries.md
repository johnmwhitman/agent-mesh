# ADR 0001: A2A Layer Boundaries

- **Status:** Accepted as the strategy baseline
- **Date:** 2026-07-19
- **Scope:** Agent Mesh A2A protocol, durability, adapters, and compatibility

## Problem

Agent Mesh can accept inbound MCP stdio connections from multiple compatible
clients, but its outbound worker path is coupled to OpenCode. Its messages are
fleet-local ledger records, and SQLite provides same-host write exclusion rather
than durable distributed ownership. Adding provider-specific launchers or a
remote relay directly to the current core would mix transport, message
semantics, execution, and trust claims.

## Constraints

- Existing MCP tool names, input shapes, return shapes, and ledger compatibility
  must remain additive and readable.
- The first work must be local-first, reversible, and testable without vendor
  credentials, network access, spend, or private-data egress.
- A requested model or self-described capability cannot be treated as runtime
  attestation.
- Local receipts are ledger evidence, not authenticated actor evidence.
- SQLite cannot be described as a multi-host coordinator.
- Human approval remains required for deployment, publication, secrets, spend,
  and remote activation.

## Options considered

### Option A: Add provider launchers directly to the MCP handler

This is fast but makes the core branch on provider names, command syntax,
output banners, cancellation behavior, and authentication. It would duplicate
semantics and make every new harness a compatibility risk.

### Option B: Choose one universal vendor runtime

This simplifies the first implementation but makes OpenCode, Claude Code,
Codex, Antigravity/Gemini, or another provider the de facto protocol authority.
It does not satisfy a platform-neutral A2A goal.

### Option C: Define a canonical envelope and narrow adapter boundaries

This adds explicit contracts for protocol, delivery, durability, execution, and
configuration. It costs more design work up front but lets each harness translate
to one semantic layer and keeps provider evidence at the adapter boundary.

## Decision

Choose Option C and sequence it as three ranked slices:

1. A pure `meshfleet.a2a` v0.1 envelope and conformance corpus. Legacy MCP
   messaging maps into it; wildcard broadcast is expanded before wire encoding;
   public `send_a2a` is deferred.
2. An additive durable lifecycle kernel with work items, immutable attempts,
   leases, owner epochs, cancellation, transactional events, and replay. The
   first implementation is isolated to one SQLite authority and is not called
   multi-host.
3. Separate transport, envelope/delivery, durable coordinator, runtime adapter,
   and configuration-renderer contracts. OpenCode becomes one compatibility
   adapter, and a deterministic local process is the first second-runtime proof.

The canonical details live in [A2A-PROGRAM.md](../A2A-PROGRAM.md),
[A2A-PROTOCOL-v0.1.md](../A2A-PROTOCOL-v0.1.md),
[ADAPTER-CONTRACT.md](../ADAPTER-CONTRACT.md), and
[A2A-THREAT-MODEL.md](../A2A-THREAT-MODEL.md).

## Tradeoffs

- The envelope adds translation and conformance work before it adds a public
  API, but prevents each transport from inventing incompatible semantics.
- The lifecycle kernel introduces schema and migration complexity before it is
  wired into spawning, but avoids pretending PID/timer behavior is durable.
- The adapter boundary requires normalized outcomes and evidence labels, but
  prevents provider-specific parsing from becoming core protocol behavior.
- Deferring signed identity and remote coordination slows the cross-boundary
  claim, but keeps trust and deployment assumptions explicit.

## Reversibility

Slice 1 is additive and pure. Slice 2 adds isolated storage tables and can be
removed without changing current MCP behavior if migration and replay evidence
fails. Slice 3 can preserve the existing OpenCode path behind a compatibility
adapter while introducing the local proof independently. None of these slices
requires a deployment or remote activation.

## Evidence and validation

Current evidence supports only the following claims:

- The packaged MCP stdio server completes a process-level handshake.
- Existing MCP and ledger compatibility behavior is covered by the current
  repository test baseline.
- Outbound worker execution remains OpenCode-specific.
- SQLite provides same-host transaction serialization.

The acceptance gates for the three slices are defined in the canonical program
and protocol documents. Validation must include focused conformance or state
machine tests, the existing compatibility suite, independent review, and an
honest evidence-level update. This ADR itself is documentation; it does not
constitute implementation evidence.

## Deferred questions

- What shared transactional coordinator and clock model will support real
  multi-host leases?
- How will authenticated principals bind to namespaces and agent IDs?
- Which Claude or Codex headless runtime is suitable for the first gated vendor
  adapter, and what evidence can it provide?
- What authorization model governs sensitive prompts, artifacts, and provider
  egress?
- When should canonical-envelope ingress and cancellation become public MCP
  tools without destabilizing existing return shapes?

