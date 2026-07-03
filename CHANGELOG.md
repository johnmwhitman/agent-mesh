# Changelog

All notable changes to Agent Mesh are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- batch writes (the 3.8ms/msg bottleneck at 10k scale — see BENCHMARKS.md)
- wire skill-taxonomy into route_work
- wire synonyms into role/skill parsing
- per-version fixture tests for COMPATIBILITY.md
- tiered councils / vote weighting (if real usage demands them)

## [0.11.1] — 2026-07-03

**First published release.** If you somehow have 0.11.0 or earlier: upgrade — 0.11.1 carries a critical fix.

### Added
- **Release-gate runner** (`scripts/validate-gates.mjs`) — spawns real `opencode run` children on an isolated ledger: 10 sequential fleets + 3 concurrent fleets, asserting zero interrupted agents ledger-wide. This is the test class that catches process-topology bugs unit tests can't.
- npm distribution as **`meshfleet`** (the `agent-mesh` npm name is squatted); new `meshfleet` bin runs the MCP server, so OpenCode config can be `["npx", "meshfleet"]`.

### Fixed
- **CRITICAL: spawned children corrupted the parent's fleet state.** Every spawned agent's `opencode run` loads the user's MCP config — agent-mesh included — so each child booted a second server instance on the same ledger, whose liveness-blind startup recovery flipped the parent's healthy `running` agents to `interrupted` within ~2s of spawn (field data: 31/52 agents on the 2026-07-02 ledger; 0/2 trivial validation fleets completed). Two-part fix: (A) `recoverInterruptedAgents()` now probes liveness and only flips agents whose recorded pid is missing or dead (`isPidAlive`, `process.kill(pid,0)` + EPERM handling); (B) spawn env sets `AGENT_MESH_CHILD=1` and child-mode instances skip startup recovery, the ratification sweeper, and the SSE bind (which also collided on port 13579). Validation re-run after fix: 10/10 sequential + 3/3 concurrent real-spawn fleets green, zero interrupted. + 2 regression tests (207 total).

## [0.11.0] — 2026-07-03

**Do not use** — contains the child-corruption bug fixed in 0.11.1. Never published to npm.

### Added
- **Ratification deadline sweeper** — the server now evaluates every open ratification every `AGENT_MESH_RATIFY_SWEEP_MS` (default 60s, `0` disables) and persists terminal states, so deadlines and "silent = PASS" fire without anyone calling tally. Each resolution appends a `ratification_resolved` event (`via: "sweep"`). New `sweep_ratifications` tool for on-demand sweeps. + 1 test (205 total).

## [0.10.0] — 2026-07-03

### Added
- **Councils — quorum ratification** (see SPEC-COUNCILS.md). New tools `open_ratification`, `cast_vote`, `tally_ratification` let a fleet ratify a proposal by vote, entirely over the v0.9 receipts substrate (votes are `r-ack`/`r-decline` receipts on a broadcast proposal). Supports a quorum threshold, mandatory named sign-offs (a decision can require a specific agent's approval regardless of quorum), an optional SLA deadline, and a silence policy (`abstain` default, or `approve` for "silent = PASS"). Terminal status (ratified / rejected / expired) is computed live and persisted once reached; unreachable-quorum and required-signoff-declined both short-circuit to rejected. Design generalized from a production governance framework (6/9 councils with a human sign-off lane). + 12 new tests (204 total). New `src/ratify.ts`; `MeshData` gained an optional `ratifications` collection (additive, no migration needed).

## [0.9.0] — 2026-07-03

### Added
- **Witnessed messaging (receipts ledger)** — every ack now writes a timestamped receipt keyed `(message, agent, action)`; new `receipt` tool writes non-consuming annotations (`seen`, `r-ack`, `retracted`, …) and new `get_receipts` tool returns the full trail for a message: who saw it, who acted on it, when. Ledger schema v2 with automatic migration (v1 `acknowledged` flags are backfilled as receipts, so existing audit history has no gap). Design ported from a production fleet bus (18,404 messages / 10+ agents / 40 days) via its clean-room reference implementation; the 12 new tests mirror that implementation's acceptance suite. + 12 new tests (192 total).
- **Fleet broadcast** — `send_message` accepts `to_agent_id: "*"`, delivering to every other agent in the fleet. Recipient list is resolved and captured at send time; SSE push notifies every recipient; each recipient acks independently and `acknowledged` becomes true only when all have acked (per-recipient tracking a single boolean flag could not represent). `send_message` now returns `recipients` alongside `message_id`.

### Changed
- `Message.acknowledged` is now a derived field (true when every addressed recipient holds an `ack` receipt). Existing single-recipient behavior is unchanged.

## [0.8.7] — 2026-07-02

### Added
- **Fleet dashboard TUI** — new `src/bin/dashboard.ts` + `agent-mesh-dashboard` bin. Live view of fleets, recent agents (with retry counts), and recent events. Refreshes every 1s by default (configurable via `--interval <ms>`), or runs once with `--once`. ANSI cursor moves for in-place updates; Ctrl+C to exit. Closes #8.

## [0.8.6] — 2026-07-02

### Added
- **Fleet template sharing** — `exportFleetTemplate(name, file_path, version?)` writes a portable `meshfleet-template-v1` JSON file. `importFleetTemplate(file_path, rename?)` reads, validates the schema, and inserts. On name conflict without `rename`, a timestamp suffix is appended (e.g. `foo-2026-07-02T17-50-00`). Closes #7. + 9 new tests (181 total).

## [0.8.5] — 2026-07-02

### Added
- **Fleet template versioning** — `saveFleetTemplate(name, agents, description?, version?)` now creates a new version on each save instead of overwriting. `version` defaults to `max(existing) + 1` so re-saving is safe. `getFleetTemplate(name, version?)` returns the latest by default, or a specific version. New `listFleetTemplateVersions(name)` returns all versions of a name sorted newest-first. `deleteFleetTemplate(name, version?)` removes one version or all. `spawnFromTemplate(name, version?)` respects the version argument. Closes #6. `FleetTemplate` interface gained a `version: number` field. + 13 new tests (172 total).

## [0.8.4] — 2026-07-02

### Added
- **Performance benchmarks** — new `benchmark/bench.ts` and `BENCHMARKS.md`. Measures `routeWork` at 10/100/1000-agent rosters, `sendMessage` warm and bulk (10k), `saveData`/`loadData`/`getInbox` on a 1k-agent + 10k-message ledger, and spawn-path bookkeeping. v1.0 perf gates met: spawn bookkeeping 6.4ms p50 (target <100ms); 10k messages persisted without drops. Known bottleneck: each `sendMessage` rewrites the full ledger (3.8ms/message at 10k scale) — batch writes are a v0.9+ follow-up.

## [0.8.3] — 2026-07-02

### Added
- **Synonym expansion (lightweight semantic routing)** — new `src/synonyms.ts` module with a curated synonym table for 30+ common dev terms (frontend ↔ ui/ux/web/client/browser, database ↔ db/sql/postgres/mongo/redis, auth ↔ oauth/jwt/sso, etc.). `route_work` now calls `expandKeywordsWithSynonyms()` before scoring, so "ui" in a description routes to a `frontend` agent. Zero network cost, no runtime dependency, no model. Extend with `setSynonymOverrides()`. Swap for a true embedding model later by replacing the one function call. + 9 new tests (159 total).

## [0.8.2] — 2026-07-02

### Added
- **Routing feedback loop** — new `src/routing-feedback.ts` module with Wilson-style score adjustment. `record_routing_outcome(agent_id, capability_key, success)` records whether a routed task succeeded; `route_work` now weights each match's score by accumulated outcomes. `RouteMatch` gains an optional `weight` field (= `score * feedback_adjustment`). Fresh agents stay neutral at 1.0; consistent successes push toward 1.5, consistent failures toward 0.5. New MCP tool: `record_routing_outcome`. 7 new tests (150 total).

## [0.8.1] — 2026-07-02

### Added
- **Skill taxonomy (hierarchical matching)** — new `src/skill-taxonomy.ts` module: `parseSkillTaxonomy(json)`, `expandSkillWithAncestors(skill, tree)`, `scoreSkillsAgainstKeywords(keywords, tree)`. Loads a JSON hierarchy like `{ frontend: { react: ["nextjs", "remix"] } }`. Matches a `react` keyword not only to a `react` skill (score 1.0) but also to its parent `frontend` (score 0.5) and its descendants `nextjs`/`remix` (score 0.5) with decaying weight. Wire into `route_work` in v0.9 to augment keyword scoring. + 9 tests (143 total).

## [0.8.0] — 2026-07-02

### Added
- **Automatic retry with exponential backoff** — agents that fail transiently (non-zero exit, heartbeat watchdog, timeout, spawn error) are respawned up to 3 times with exponential backoff (1s, 2s, 4s + ±20% jitter). After 3 failures the agent is marked permanently failed. Configurable via `AGENT_MESH_RETRY_BASE_MS`. Each retry is logged via `appendEvent("agent_retry_scheduled", ...)`; permanent failure via `appendEvent("agent_failed_permanent", ...)`. Clean exits (code 0) skip retry entirely. `src/retry.ts` (computeBackoff, shouldRetry, scheduleRetry) + 9 new tests.
- **Partial result recovery on startup** — if the MCP server crashes mid-fleet, the next start calls `recoverInterruptedAgents()` which transitions any agent left in `running` state to a new `interrupted` status (with `completed_at` and a clear error message). The user sees accurate fleet status instead of stale "running" agents whose OS processes are dead. Emits `agent_interrupted_recovered` events for the structured log. New status type value `"interrupted"`. + 4 tests.
- **Ledger schema versioning** — the JSON ledger now includes a `schema_version` field on every save (currently `1`). On load, `migrateLedger()` auto-upgrades legacy v0 ledgers (no field) to v1. Missing collections default to empty objects so partial/corrupt files don't crash the server. Exposed `CURRENT_SCHEMA_VERSION` constant. + 6 tests.
- **`route_work` `top_n` parameter** — call signature is now `route_work(description, top_n?)`. Default `top_n=1` preserves backward compatibility; pass a larger number to fan out work to the N best-scoring agents. Sort is by score (desc) then agent_id (asc) for stable deterministic ordering on ties. MCP tool definition exposes the new `top_n` parameter. + 5 tests.
- **npm publish prep** — package.json now ships with `files` whitelist (dist + docs + LICENSE), `prepublishOnly` runs build + tests, `repository.url` + `bugs.url` + `homepage` filled in. `npm pack --dry-run` produces a clean 29.3 kB tarball (16 files).

### Fixed
- **Agent dispatch: stdin hang** — `opencode run` blocks forever when stdin is a pipe, so every spawned agent hung until the timeout. Children are now spawned with `stdio: ["ignore", "pipe", "pipe"]`. Contract + evidence live in `src/spawn-config.ts`, guarded by regression tests.
- **Heartbeat watchdog killed healthy agents** — the v0.7.0 watchdog counted every tick as a missed heartbeat, SIGKILLing any agent running longer than 60s. `createHeartbeat` now takes an `isAlive` liveness probe; only consecutive dead checks count as missed, and `spawnAgent` probes real child-process liveness. Healthy long-running agents are never auto-failed (verified with a 75s agent run).
- Default agent timeout restored to 30 minutes (was briefly 5 during hang triage) — with the stdin hang fixed it is a backstop, overridable via `AGENT_MESH_AGENT_TIMEOUT_MS` or `set_fleet_timeout`.

### Changed
- Spawn args/stdio/timeout extracted into `src/spawn-config.ts` so the spawn contract is unit-testable.
- 134 total tests across 12 test files, all passing on the 3 OS × 3 Node CI matrix.

### Installation
```bash
npm install -g agent-mesh     # once published to the npm registry
# or from source:
git clone https://github.com/johnmwhitman/agent-mesh.git \
  ~/.config/opencode/mcp-servers/agent-mesh
cd ~/.config/opencode/mcp-servers/agent-mesh && npm install && npm run build
```

## [0.7.0] — 2026-07-02

### Added
- **Real-time inbox push via SSE**: `subscribe_inbox(agent_id)` MCP tool returns an SSE stream URL. Agents open an HTTP GET to the stream and receive incoming P2P messages in real-time instead of polling `get_inbox`.
- `src/sse-server.ts`: standalone HTTP server (default port 13579, bind 127.0.0.1) serving `GET /inbox/:agent_id/stream` SSE endpoints. Heartbeat comments every 30s. Per-agent connection cap (default 5).
- `src/realtime.ts`: subscriber registry with `addSubscriber`, `removeSubscriber`, `notifySubscribers`, `shutdownServer`. Write failures drop the subscriber (backpressure). `setMaxConnectionsPerAgent` for tests.
- `notifySubscribers` is called inside the `send_message` handler so every new message is pushed to active SSE clients.
- 15 new unit tests for the realtime module (90 total, all passing).
- Bumped version to 0.7.0.

### Changed
- Startup log now reports the SSE port when the HTTP server starts successfully.

## [0.6.0] — 2026-07-02

### Added
- **Fleet templates** — save, list, and spawn named fleet templates so you don't retype common agent sets
  - `save_fleet_template(name, agents, description?)` MCP tool: stores a template in the JSON ledger under `templates`. Names: lowercase letters, numbers, dashes, underscores. Max 32 agents per template. Re-saving the same name errors.
  - `list_fleet_templates()` MCP tool: returns all templates, sorted by name
  - `spawn_from_template(name)` MCP tool: returns a `SpawnSpec` you can pass directly to `spawn_fleet`
  - `src/templates.ts`: new module with pure functions, full validation, sorted listing
  - 15 new unit tests (75 total, all passing)

### Changed
- Bumped version to 0.6.0

## [0.5.1] — 2026-07-02

### Added
- **`ping` MCP tool**: minimal liveness check, returns `{ status: 'ok', timestamp }`
- **`get_health` MCP tool**: deeper health report — ledger size, fleet/agent/message counts, uptime, last event timestamp, status (`ok` / `degraded` if any fleet is stuck > 24h, `error` if ledger is corrupt)
- **Read-side rate limiting**: `list_fleets` and `fleet_status` are now rate-limited at 600 reads/hour per IP. Write-side was already rate-limited (60/hour). New helpers in `src/health.ts`: `checkRateLimit(ip, 'read'|'write')`, `setRateLimitConfig`, `resetRateLimits`
- **Storage introspection**: `getLedgerSize()` reports the combined byte size of the JSON ledger and the NDJSON event log. Used internally by `get_health` and available for future size-warning logic
- **`src/health.ts` module**: new file with `ping`, `getHealth`, `getLedgerSize`, `checkRateLimit`, `setRateLimitConfig`, `resetRateLimits`. Pure functions, easy to test
- 11 new unit tests (60 total, all passing)

### Changed
- `fleet_status` and `list_fleets` now apply read-side rate limiting (60 reads/min)

## [0.5.0] — 2026-07-02

### Added
- **CLI inspector**: `npx agent-mesh inspect` shows all fleets, one fleet, metrics, recent events
  - `inspect` (no args): list all fleets with status, agent counts, durations
  - `inspect <fleet_id>`: detailed view of one fleet with agent rows
  - `inspect --metrics`: summary metrics (total fleets, success rate, avg duration, etc.)
  - `inspect --events [n]`: recent structured events as a table
  - `inspect --help`: usage
- **`getFleetMetrics` function** in `src/inspector.ts` (reused by the CLI and exposed for future dashboard work): total_fleets, completed_fleets, failed_fleets, running_fleets, total_agents, total_messages, avg_fleet_duration_ms, success_rate, total_capabilities
- **`formatFleetSummary`, `formatAgentRow`, `formatEventLog`**: pure formatting helpers for terminal display
- `bin` field in `package.json`: `npx agent-mesh` resolves to the inspector
- `npm run inspect` script for local development
- 14 new unit tests (51 total, all passing)

## [0.4.0] — 2026-07-01

### Added
- Per-fleet timeout: `set_fleet_timeout(fleet_id, timeout_ms)` overrides the global `AGENT_MESH_AGENT_TIMEOUT_MS` for a specific fleet
- `get_fleet_timeout_ms(fleet_id)` returns the effective timeout (per-fleet override → env var → default 30 min)
- Structured event log: every `fleet_created`, `agent_spawned`, `fleet_timeout_set` event appended to `~/.config/opencode/agent-mesh.events.log` (NDJSON)
- `readEventLog(limit?)` reads recent events back for observability
- `list_fleets` MCP tool: returns summaries for all fleets (id, status, agent counts)
- 10 new unit tests (36 total, all passing)

### Changed
- `Fleet` interface now includes optional `timeout_ms` field
- `createFleet` now emits a `fleet_created` event

## [0.3.0] — 2026-07-01

### Added
- P2P message bus: `send_message`, `get_inbox`, `ack_message` (5 message types: handoff, question, result, alert, request_help)
- Capability registry: `register_capability`, `route_work` (keyword + role overlap scoring)
- Premade agent discovery: `list_agents` scans `.opencode/agents/` for 100+ specialized personalities
- Dynamic attachment: `attach_agent` joins a running fleet mid-flight
- `spawn_fleet` accepts an optional `agent` field to use a premade agent definition (`--agent` flag on `opencode run`)
- Auto-registration of capabilities from agent frontmatter on spawn
- Timeout watchdog with configurable `AGENT_MESH_AGENT_TIMEOUT_MS` (default 30 min)
- Spawn error handler for failed child processes
- Ledger corruption recovery (auto-reset to empty data on parse error)
- Child PID tracking for observability
- 26 unit tests covering loadData, sendMessage, getInbox, ackMessage, routeWork, extractSkillsFromDescription, discoverPremadeAgents, markAgentFinished
- Test isolation via in-memory `setLedgerOverride` pattern
- GitHub Actions CI: install, typecheck, test on push/PR to main
- AGENT-MESH-SPEC.md (v0.1 core architecture)
- Brand: meshfleet.app

### Changed
- Refactored: extracted pure data layer to `src/core.ts` (416 LOC, testable) from `src/index.ts` (440 LOC MCP transport)
- Bumped `package.json` to 0.3.0 with keywords, license, engines, test/typecheck scripts

## [0.2.0] — 2026-07-01

### Added
- P2P messaging on top of v0.1 fleet primitives
- Capability registry with skill-based routing
- 5 message types (handoff, question, result, alert, request_help)
- 64 KB payload size limit
- SPEC-P2P.md documentation

## [0.1.0] — 2026-07-01

### Added
- Initial release
- `spawn_fleet`: spawn N parallel agents as independent `opencode run` processes
- `fleet_status`: check fleet and agent lifecycle state
- `collect_results`: aggregate agent outputs
- JSON ledger persistence (`~/.config/opencode/agent-mesh.json`)
- Independent process execution (bypasses OpenCode's 30-minute background task timeout)
- Schema for Fleet and Agent records

[Unreleased]: https://github.com/johnmwhitman/agent-mesh/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/johnmwhitman/agent-mesh/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/johnmwhitman/agent-mesh/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/johnmwhitman/agent-mesh/releases/tag/v0.1.0
