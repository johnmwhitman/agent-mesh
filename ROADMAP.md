# Roadmap

Agent Mesh is on a fast iteration cycle. This document tracks what's shipped, what's next, and what's on the longer horizon. Dates are aspirational; everything is best-effort and not a commitment.

## A2A program status

The ranked A2A strategy is canonical in
[`docs/A2A-PROGRAM.md`](docs/A2A-PROGRAM.md):

1. **Canonical envelope and conformance** - implementation pending. The
   normative `meshfleet.a2a` v0.1 contract is documented, but no public
   `send_a2a` tool or codec is shipped.
2. **Durable lifecycle kernel** - contract documented, implementation pending.
   The next lifecycle work is single-authority SQLite durability, not
   multi-host coordination.
3. **Provider-neutral runtime adapters** - proposed. Outbound execution remains
   OpenCode-coupled; a deterministic local-process proof must come first.

Inbound MCP process compatibility does not imply outbound runtime neutrality,
authenticated principal binding, lifecycle durability, or multi-host support.
Those claims require the evidence gates in the canonical program.

## Shipped

| Version | Theme | Highlights |
|---|---|---|
| **0.1.0** | Core fleet orchestration | `spawn_fleet`, `fleet_status`, `collect_results`, JSON ledger, timeout bypass |
| **0.2.0** | P2P messaging | `send_message`, `get_inbox`, `ack_message`, capability registry, `route_work` |
| **0.3.0** | Premade agents | `list_agents`, `attach_agent`, timeout watchdog, 26 tests, CI |
| **0.4.0** | Resilience | `set_fleet_timeout`, structured event log, `list_fleets` |
| **0.5.0** | Observability | CLI inspector (`npx agent-mesh inspect`), `getFleetMetrics`, formatting helpers |
| **0.5.1** | Health tools | `ping`, `get_health`, read-side rate limiting |
| **0.6.0** | Fleet templates | `save_fleet_template`, `list_fleet_templates`, `get_fleet_template`, `delete_fleet_template`, `spawn_from_template` |
| **0.7.0** | Real-time push | `subscribe_inbox` (SSE), `notifySubscribers` hooked into `send_message`, per-agent connection cap, heartbeat keepalive, 90 tests |
| **0.8.0** | Hardening push | Auto-retry with exponential backoff, partial result recovery, ledger schema versioning, `route_work` `top_n` |
| **0.8.1** | Skill taxonomy | Hierarchical skill matching with ancestor/descendant decay (`src/skill-taxonomy.ts`) |
| **0.8.2** | Routing feedback loop | `record_routing_outcome` + Wilson-style score adjustment on `route_work` |
| **0.8.3** | Synonym expansion | Curated synonym table for 30+ dev terms; `route_work` now matches "ui" → `frontend` |
| **0.8.4** | Performance benchmarks | Self-contained `benchmark/bench.ts`; v1.0 gates met (spawn 6.4ms p50, 10k msgs no drops) |
| **0.8.5** | Template versioning | Re-saving a template creates a new version (auto-increment); `getFleetTemplate(name, version?)` returns latest or specific; `listFleetTemplateVersions(name)` and `deleteFleetTemplate(name, version?)` round out the API |
| **0.8.6** | Template sharing | `exportFleetTemplate(name, file_path, version?)` writes a portable JSON; `importFleetTemplate(file_path, rename?)` reads, validates schema, and inserts (with auto-suffix on conflict) |
| **0.8.7** | Fleet dashboard TUI | `npx agent-mesh-dashboard` (or `npx agent-mesh dashboard`) shows live fleets, recent agents, and recent events; refreshes every 1s; ANSI in-place updates |

## v0.7.x — Hardening (current focus)

The fleet must be self-healing. A hung agent should not block the whole mesh.

- [x] **Per-fleet timeout** — `set_fleet_timeout` overrides global default per-fleet
- [x] **Structured logging** — every spawn, message, capability registration emits a log line
- [x] **Fleet summary** — `list_fleets` returns status + agent counts across all fleets
- [x] **SSE push notifications** — `subscribe_inbox(agent_id, callback)` for real-time message delivery
- [x] **Fleet events** — emit events on fleet start / agent spawn / agent complete / fleet complete
- [x] **CLI inspector** — `npx agent-mesh inspect <fleet_id>` shows a live TUI of running agents
- [x] **Fleet metrics** — `get_fleet_metrics` returns avg duration, success rate, message volume per fleet
- [x] **Heartbeat / watchdog** — periodic heartbeat events + `isAlive` liveness probe; auto-fails agents whose process dies without a close event, never kills healthy long-running agents
- [x] **Automatic retry with exponential backoff** — agents that fail with transient errors get retried up to 3 times
- [x] **Partial result recovery** — if the MCP server crashes mid-fleet, the next start should resume the ledger

## v0.8.0 — Smart routing (Q3 2026)

Routing becomes capability-aware, not just keyword-overlap.

- [x] **Embedding-based `route_work`** — use a local embedding model (e.g., all-MiniLM via `@xenova/transformers`) for semantic match
- [x] **Skill taxonomy** — formalize skills as a hierarchy (e.g., `frontend` > `react` > `nextjs`)
- [x] **Multi-agent routing** — `route_work` returns N best matches for fan-out tasks
- [x] **Routing feedback loop** — if a routed task fails, learn from the failure to improve future routing

## v0.9.0 — Scale (complete)

Bridge release between v0.8.x and v1.0. Targeted at the known bottleneck.

- [x] **Batch writes for `sendMessage`** — DONE (2026-07-16), two halves. *Surgical reads:* `withLedger` builds lazy per-row transaction views (row-granular SELECT on first touch, hydration on enumerate, touched-row diff on commit) instead of parsing the whole ledger per transaction — 10k per-call sends 73s → ~5-8s, warm send p50 0.10ms, spawn bookkeeping p50 11.9 → 0.08ms. *Coalesced writes:* new `send_messages` batch tool (one transaction per batch, atomic, max 1000/call) — **10k messages in 52ms**, ~100× under the < 5s target. The per-call path's residual cost is the per-agent inbox row (one JSON array rewritten per send); normalizing inboxes into their own table (schema v3 + migration) is optional future work if per-call bulk ever matters.
- [x] **Wire `skill-taxonomy` into `route_work`** — DONE (2026-07-13). `route_work` reads the active taxonomy (`setSkillTaxonomy()` / `AGENT_MESH_TAXONOMY`) and credits each capability by its position in the tree (ancestor scoring, decaying weight). Empty-by-default keeps routing unchanged until a taxonomy is set.
- [x] **Wire `synonyms` into the `route_work` description parser** — DONE (2026-07-13). Capability role+skills are now synonym-expanded as a rescue when nothing matched literally, closing the key-also-value collision (`api`→`backend`). Rescue-only, so existing rankings are preserved.
- [x] **Per-version fixture tests for COMPATIBILITY.md** — DONE (2026-07-16). `test/fixtures/ledger-v{0,1,2}.json`, one per released `schema_version`; CI loads each through `loadDataFromFile` and requires the result to pass `verify_ledger` clean (including the v0/v1→v2 ack-receipt backfill).

## v1.0.0 — Stable (Q4 2026)

API freeze. Production-ready. Backward-compatible.

- [x] **Schema versioning** — ledger includes a `schema_version` field; old ledgers auto-migrate
- [x] **Backward compatibility matrix** — `COMPATIBILITY.md` documents the API + ledger schema guarantees per version; per-version fixture tests are a v1.0 follow-up
- [x] **Performance benchmarks** — sub-100ms overhead per agent spawn, 10k messages per fleet
- [x] **Single-host SQLite ledger** — resolved differently and better in 0.12.0: SQLite (better-sqlite3, WAL + `BEGIN IMMEDIATE`) became THE ledger, not a flagged option, because the JSON store provably lost concurrent writes. This provides same-host process write exclusion only; it is not multi-host readiness. Cross-machine coordination (the libSQL idea) folds into the post-1.0 cloud relay.
- [x] **npm publish** — DONE (2026-07-16). `meshfleet@0.13.0` live on the registry (dist-tag `latest`); published tarball verified end-to-end (fresh install, bins run, `inspect --verify` audits a real ledger clean).
- [x] **Auth token for MCP** — DONE (2026-07-16). Optional `MESHFLEET_AUTH_TOKEN` (legacy `AGENT_MESH_AUTH_TOKEN`): when set, the SSE listener requires `Authorization: Bearer <token>` (or `?token=` for EventSource) on every endpoint except `/healthz`; constant-time comparison; unset keeps the historical open local-trust default. The stdio MCP transport stays process-local (auth is the OS process boundary there by design).

## v0.13 (staged)

- [x] **Tiered councils / weighted quorum voting** — DONE (2026-07-16). Optional per-voter integer `weights` on `open_ratification`; quorum is a weight threshold, signoffs stay per-agent identity gates, unweighted behavior unchanged. Adversarially design-reviewed before build.
- [x] **`verify_ledger` + `send_messages` + SSE auth + surgical reads** — see the CHANGELOG.
- [x] **Vote re-casting is fully honest (A→B→A fix)** — DONE (2026-07-16). Every polarity change appends a sequence-suffixed receipt (`r-ack:1`, `r-decline:2`, …); the effective vote is derived from ledger content (highest seq, then timestamp, then decline-wins — fail-closed), never from row order. Same-polarity re-casts are no-ops; history is never mutated; legacy bare-vote ledgers tally identically. `verify_ledger` checks seq uniqueness/contiguity and flags malformed vote-like actions.

## Now / Next / Later (post-0.13)

Direction, not commitment — items ship when real usage pulls them.

**Now**
- Provenance-signed npm releases (the "prove it" project practicing its own thesis at the package layer)
- VS Code extension marketplace listing (the read-only inspector MVP already lives in `editors/vscode/`)
- `verify --explain` — failure triage for the ledger auditor

**Next**
- P1 spawn receipts: resolved runtime agent/model banner capture is implemented. Capability `model` remains routing self-description, not proof of runtime identity; requested-vs-resolved model binding remains future work.
- Zero-install ledger verification (`npx` against any ledger file someone sends you)
- A quickstart demo that ends with a verification, not a wall of text
- `agent-mesh doctor` — 30-second diagnosis of broken installs
- Machine-readable `--json` output across every inspect subcommand
- A published corpus of tampered-ledger fixtures the verifier must catch
- Per-entry provenance confidence bands in verify output

**Later / exploring**
- Incident-window timeline reconstruction from the ledger
- Out-of-band ledger-head fingerprints and external timestamp anchoring
- Verifiable cold-archive segments (retention without receipt loss)
- MCP stateless-spec migration as host support lands
- Agent Mesh Protocol (AMP) — a cross-runtime wire format; a v0.1 draft exists and will be published when it stabilizes

### Next distributed-safety slice (contract only)

`docs/A2A-NEXT-SLICE.md` records the next implementation boundary for crash-safe
attempt lifecycle state. It is not implemented by this roadmap entry and does not
claim multi-host readiness. The current package remains single-host: there is no
safe multi-host coordinator, lease owner epoch, durable attempt identity,
transactional lifecycle event stream, or cancellation state. Any implementation
must preserve the existing MCP API names and return shapes.

## Contributing to the roadmap

Open a GitHub issue with the `roadmap` label. Tell us:
- What you're trying to do
- What's blocking you
- Which version it would unlock

We'll move items up if the use case is clear and the implementation is contained.
