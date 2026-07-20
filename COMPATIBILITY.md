# Compatibility Matrix

Agent Mesh follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
This document tracks what each version guarantees and what changes break it.

## Conformance status vocabulary

The A2A registry uses explicit evidence levels rather than treating a documented
configuration as a working integration:

| Status | Meaning |
|---|---|
| `documented` | Configuration or behavior is described; no executable proof |
| `static-config-verified` | Target configuration shape is checked without a live client |
| `process-handshake-verified` | A process starts and completes the protocol handshake |
| `semantic-tool-verified` | Representative tool calls and return shapes work through the target |
| `runtime-launch-verified` | A runtime adapter launches and settles work with normalized evidence |
| `recovery-verified` | Restart, expiry, fencing, cancellation, and replay are proven |
| `coupled` | Behavior exists but remains implementation-specific to one runtime |
| `proposed` | Contract or design exists; implementation evidence is absent |
| `deferred` | Intentionally outside the current release boundary |
| `gated` | Requires explicit human, security, credential, spend, or egress approval |

## A2A conformance registry

| Surface | Status | Current truthful claim | Canonical authority |
|---|---|---|---|
| Packaged MCP stdio ingress | `process-handshake-verified` | `npx -y meshfleet` completes the process-level MCP handshake | `test/mcp-stdio.test.ts` |
| Generic MCP configuration | `static-config-verified` | The canonical stdio command and argv are packaged and checked | `mcp.json` |
| Claude Code, Codex, OpenCode inbound configs | `documented` | Each is documented against the same inbound stdio shape; live client semantics are not claimed | `README.md` |
| SSE inbox projection | `implemented` | Optional local inbox push, not general A2A HTTP | `src/sse-server.ts` |
| Outbound worker execution | `coupled` | Current worker launch and parsing remain OpenCode-specific | `src/index.ts`, `src/spawn-result.ts` |
| `meshfleet.a2a` v0.1 codec and fixtures | `semantic-tool-verified` | Pure provider-neutral validation, codec, fixtures, and legacy internal mapping are covered by conformance tests; public canonical ingress is not implemented | `docs/A2A-PROTOCOL-v0.1.md`, `test/a2a-envelope.test.ts` |
| Durable attempt lifecycle | `proposed` | Single-authority lifecycle contract is documented; implementation is pending | `docs/A2A-NEXT-SLICE.md` |
| Provider-neutral runtime adapters | `proposed` | Adapter boundary is documented; current core remains OpenCode-coupled | `docs/ADAPTER-CONTRACT.md` |
| Multi-host coordination | `deferred` | No shared remote ownership authority exists | `docs/A2A-PROGRAM.md` |

The complete ranked sequence and acceptance gates are in
[docs/A2A-PROGRAM.md](docs/A2A-PROGRAM.md). This registry must not be upgraded
to `semantic-tool-verified`, `runtime-launch-verified`, or `recovery-verified`
without executable evidence at that scope.

## Ledger schema versions

| Version | `schema_version` | Notes |
|---|---|---|
| 0.1.0 – 0.7.x | (none) | Legacy. `migrateLedger()` upgrades on load. |
| 0.8.0 – 0.11.x | `1` | Stamped on every save. Missing field → auto-upgrade to 1. |
| 0.12.0 – 0.13.x | `2` | Receipts ledger. v1 `acknowledged` booleans are backfilled as `ack` receipts on load (no audit-trail gap). SQLite is canonical storage; a legacy JSON ledger still loads and migrates once. |
| 0.14.0+ | `2` | Same ledger schema. The packaged `meshfleet` executable exposes a host-neutral MCP stdio port. |

Future versions will increment `CURRENT_SCHEMA_VERSION` and add a migration step to `migrateLedger()`. The contract: **older clients can always read newer ledgers** (forward-only field additions, never renames or type changes without migration).

## MCP tool surface

| Version | Tools | Backward-compat breaks |
|---|---|---|
| 0.1.0 | spawn_fleet, fleet_status, collect_results | — |
| 0.2.0 | + send_message, get_inbox, ack_message | — |
| 0.3.0 | + list_agents, attach_agent, route_work, register_capability | — |
| 0.4.0 | + set_fleet_timeout, list_fleets | — |
| 0.5.0 | + get_fleet_metrics | — |
| 0.5.1 | + ping, get_health | — |
| 0.6.0 | + save_fleet_template, list_fleet_templates, get_fleet_template, delete_fleet_template, spawn_from_template | — |
| 0.7.0 | + subscribe_inbox (SSE) | — |
| 0.8.0 | (no new tools; retry/recovery/schema migration are behavior changes) | — |
| 0.8.1 – 0.13.x | (no new tools; skill taxonomy is a library module, not a tool yet) | — |
| 0.14.0+ | (no new tools; stdio handshake and host-neutral launch configuration are covered by integration tests) | — |

**Promise so far**: every minor release has been additive. No tool has been removed or had its signature narrowed. Tool inputs default to safe values when omitted.

## When v1.0 lands

- **API freeze**: tool names, input shapes, and return shapes become stable. New tools can be added; existing ones cannot be renamed or changed incompatibly.
- **Backward compat**: a v1.x client must be able to read any v0.9.x or v1.x fleet.
- **Forward compat**: v0.9.x clients MAY not understand v1.x-only fields; graceful degradation is required.
- **Dependency floor**: Node.js ≥20 (current).

## What we will NOT do in v1.0

- Remove or rename any existing tool.
- Change a return shape without a `version` field on the response.
- Bump minimum Node version above 20 without a 6-month deprecation notice.
- Drop compatibility with importing legacy JSON ledgers into SQLite.

## Test fixtures

Test fixtures for every released `schema_version` live in `test/fixtures/ledger-v{N}.json`. Loading each one in `loadDataFromFile` must succeed without error and produce a valid `MeshData`. CI exercises all fixtures on every push.

## Reporting a compat issue

Open an issue at https://github.com/johnmwhitman/agent-mesh/issues with:
- agent-mesh version (`npm list -g agent-mesh` or `cat package.json`)
- ledger `schema_version` (inspect `~/.config/opencode/agent-mesh.db` with `npx agent-mesh inspect --export`)
- A redacted copy of the failing operation
- The full error output
