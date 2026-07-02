# Roadmap

Agent Mesh is on a fast iteration cycle. This document tracks what's shipped, what's next, and what's on the longer horizon. Dates are aspirational; everything is best-effort and not a commitment.

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

- [ ] **Embedding-based `route_work`** — use a local embedding model (e.g., all-MiniLM via `@xenova/transformers`) for semantic match
- [ ] **Skill taxonomy** — formalize skills as a hierarchy (e.g., `frontend` > `react` > `nextjs`)
- [x] **Multi-agent routing** — `route_work` returns N best matches for fan-out tasks
- [ ] **Routing feedback loop** — if a routed task fails, learn from the failure to improve future routing

## v1.0.0 — Stable (Q4 2026)

API freeze. Production-ready. Backward-compatible.

- [x] **Schema versioning** — ledger includes a `schema_version` field; old ledgers auto-migrate
- [ ] **Backward compatibility matrix** — v1.x clients can read v0.9.x fleets
- [ ] **Performance benchmarks** — sub-100ms overhead per agent spawn, 10k messages per fleet
- [ ] **Distributed ledger option** — swap JSON for SQLite (single-process) or libSQL (multi-process) behind a feature flag
- [ ] **npm publish** — `npm install -g @meshfleet/agent-mesh` for a global install
- [ ] **Auth token for MCP** — optional bearer token to prevent unauthorized access

## Future (post-1.0)

- **Cloud relay** — optional hosted mesh for teams that want fleet orchestration across machines
- **VS Code extension** — fleet inspector in the editor sidebar
- **Agent Mesh Protocol (AMP)** — a wire format for cross-runtime agent coordination (not just MCP)

## Contributing to the roadmap

Open a GitHub issue with the `roadmap` label. Tell us:
- What you're trying to do
- What's blocking you
- Which version it would unlock

We'll move items up if the use case is clear and the implementation is contained.
