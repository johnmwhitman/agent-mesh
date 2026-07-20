# ADR 0002: Durable Lifecycle Authority

- **Status:** Accepted and implemented as an isolated storage kernel
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

## Consequences

- Existing JSON v0-v2 and SQLite ledger data remain readable without changing
  logical `schema_version` or creating synthetic attempts.
- A physical migration is transactional, idempotent, and rejects an unknown
  newer layout instead of guessing.
- Replay is sourced from SQLite lifecycle events, not PIDs, timers, or NDJSON.
- This kernel is intentionally not wired into `spawn_fleet`, retry timers, PID
  recovery, MCP tools, or the NDJSON projection. Existing public behavior is
  unchanged.
- It is one SQLite authority, not multi-host coordination. Shared ownership,
  remote clocks, authenticated worker identity, and a networked coordinator
  remain separate work.
