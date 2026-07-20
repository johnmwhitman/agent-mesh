# ADR 0002: Durable Lifecycle Authority

- **Status:** Accepted and implemented as a bounded single-host execution authority
- **Date:** 2026-07-19
- **Scope:** SQLite lifecycle state for one local Agent Mesh authority

## Decision

Agent Mesh keeps its logical JSON/ledger compatibility marker at
`schema_version = 2` and adds an independently ordered physical SQLite storage
migration path. Storage version 2 adds `work_items`, immutable `attempts`, and
transactional `attempt_events` without fabricating lifecycle history for
existing agent rows.

The internal lifecycle store owns work identity, attempt identity, owner epoch,
lease expiry, cancellation, terminal settlement, and replay. Every accepted
lifecycle mutation writes the changed state and a database-sequenced event in
one `BEGIN IMMEDIATE` transaction. A worker mutation must match the current
work, attempt, owner, epoch, and an unexpired lease. Cancellation and terminal
states reject later renewal, retry, and settlement.

The execution coordinator consumes that authority for durable-mode fleet spawn
and attachment. It records legacy projections and lifecycle rows on one handle,
acquires a lease before launch, fences observed launch and settlement, persists
deterministic retry eligibility, wakes at persisted recovery boundaries, and
projects sequence-ordered SQLite outbox rows to NDJSON idempotently. Expired
diagnostic PIDs are best-effort contained without becoming authority. Managed
durable agents are excluded from PID recovery.

## Consequences

- Existing JSON v0-v2 and SQLite ledger data remain readable without changing
  logical `schema_version` or creating synthetic attempts.
- A physical migration is transactional, idempotent, and rejects an unknown
  newer layout instead of guessing.
- Replay is sourced from SQLite lifecycle events, not PIDs, timers, or NDJSON.
- Durable-mode `spawn_fleet` and `attach_agent` retain their existing MCP input
  and output shapes. Legacy behavior remains default; shadow remains
  legacy-authoritative. Public cancellation is still absent.
- It is one SQLite authority, not multi-host coordination. Shared ownership,
  remote clocks, authenticated worker identity, and a networked coordinator
  remain separate work.
