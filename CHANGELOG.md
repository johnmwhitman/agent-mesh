# Changelog

All notable changes to Agent Mesh are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- Automatic retry with exponential backoff
- Partial result recovery on crash
- Embedding-based capability matching
- Push notifications via SSE for inboxes
- `npm publish` to the public registry

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

[Unreleased]: https://github.com/meshfleet/agent-mesh/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/meshfleet/agent-mesh/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/meshfleet/agent-mesh/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/meshfleet/agent-mesh/releases/tag/v0.1.0
