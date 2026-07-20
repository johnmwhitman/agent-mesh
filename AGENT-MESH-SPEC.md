# Agent Mesh — OpenCode Fleet Orchestration Engine

**Version**: 0.14.0
**Status**: Core implemented; host-neutral MCP stdio port proven
**Location**: Published package `meshfleet` (local state under `~/.config/opencode/`)
**Website**: [meshfleet.app](https://meshfleet.app)

---

## 1. Problem Statement

OpenCode's built-in `task(..., run_in_background=true)` and synchronous `task()` polling both enforce a hard 30-minute inactivity timeout. This breaks any workflow requiring:

- Long-running agents (Oracle deep reasoning, large codebase exploration)
- True parallel execution of N agents (background tasks are capped at 4 and timeout independently)
- Persistent state across agent restarts or session interruptions

The result: orchestrators cannot reliably delegate to specialist agents without the entire fleet being killed mid-execution.

---

## 2. Solution Overview

**Agent Mesh** is a lightweight, host-neutral MCP server that accepts inbound
stdio connections from any compatible MCP client and spawns workers as
independent OS processes via OpenCode's `opencode run <prompt>`. Each worker
runs to completion with no artificial timeout ceiling. The MCP server acts as:

- **Spawner**: Launches child processes
- **Ledger**: Persists fleet/agent state in SQLite, with one-time legacy JSON import
- **Message Bus** (v0.2+): Enables peer-to-peer communication between agents
- **Capability Registry** (v0.2+): Agents self-describe skills; routing matches work to best agent
- **Premade Agent Discovery** (v0.3+): Scans `.opencode/agents/` for 100+ specialized personalities
- **Coordinator**: Exposes the MCP tool registry to any compatible MCP client

**Host boundary**: Claude Code, Codex, OpenCode, and generic MCP clients can
all call the same stdio server. That proves inbound client interoperability;
it does not make spawned workers provider-neutral. Workers still execute via
OpenCode's `opencode run`, and SSE inbox subscription is optional acceleration,
not a compatibility requirement.

**Key invariant**: No worker is a "background task" inside OpenCode's runtime.
Every worker is a separate `node` process executing `opencode run`. The
30-minute timeout does not apply.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Sisyphus (orchestrator)                   │
│              (this session, model: deepseek-v4-flash-free)   │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       │ MCP tool calls (stdio)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    Agent Mesh MCP Server                     │
│  - spawns `opencode run` child processes                     │
│  - maintains SQLite ledger (~/.config/opencode/agent-mesh.db)│
│  - exposes the MCP tool registry                             │
└──────┬──────────────┬──────────────┬────────────────────────┘
       │              │              │
       ▼              ▼              ▼
┌──────────┐   ┌──────────┐   ┌──────────┐
│ Agent A  │   │ Agent B  │   │ Agent C  │   ... (N agents)
│ (explore)│   │ (oracle) │   │(engineer)│
│  PID 123 │   │  PID 456 │   │  PID 789 │
└──────────┘   └──────────┘   └──────────┘
       │              │              │
       └──────────────┴──────────────┘
                      │
              (stdout/stderr captured)
                      │
                      ▼
              Written to ledger on exit
```

### 3.1 Persistence

- **File**: `~/.config/opencode/agent-mesh.db`
- **Format**: SQLite tables representing `{ fleets, agents, messages, inboxes, capabilities }`
- **Storage**: SQLite is canonical. Legacy JSON ledgers are validated, imported once, and retained as a timestamped backup. Every write goes through `withLedger`, which uses a single `BEGIN IMMEDIATE` transaction; this is required because workers are separate processes sharing the ledger.

### 3.2 Agent Lifecycle

1. `spawn_fleet` called → creates `Fleet` record, status=`running`
2. For each agent spec → spawns `opencode run <prompt>` via `child_process.spawn`
3. Child stdout/stderr captured in memory
4. On `close` event → writes output/error to `Agent` record, status=`complete|failed`
5. `checkFleetCompletion` runs after every agent exit → if all agents done, fleet status updated
6. Timeout watchdog kills agents exceeding `AGENT_MESH_AGENT_TIMEOUT_MS` (default 30 min)

---

## 4. Data Models

### Fleet
```ts
interface Fleet {
  id: string;                    // UUID
  status: "pending" | "running" | "complete" | "failed";
  created_at: number;            // epoch ms
  completed_at?: number;
}
```

### Agent
```ts
interface Agent {
  id: string;
  fleet_id: string;
  role: string;                  // "explore", "oracle", "engineer", etc.
  prompt: string;                // full prompt passed to opencode run
  agent_file?: string;           // premade agent filename stem (v0.3+)
  pid?: number;                  // OS process ID (v0.3+)
  status: "pending" | "running" | "complete" | "failed";
  output?: string;               // stdout
  error?: string;                // stderr (if non-zero exit)
  started_at?: number;
  completed_at?: number;
}
```

### Message (v0.2+)
```ts
interface Message {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  fleet_id: string;
  type: "handoff" | "question" | "result" | "alert" | "request_help";
  payload: string;
  correlation_id?: string;
  timestamp: number;
  acknowledged: boolean;
}
```

### Capability (v0.2+)
```ts
interface Capability {
  agent_id: string;
  fleet_id: string;
  role: string;
  skills: string[];
  model?: string;
  context_window?: number;
  registered_at: number;
}
```

---

## 5. Tools

The authoritative MCP tool registry, version history, and compatibility promise
live in [COMPATIBILITY.md](COMPATIBILITY.md). This spec intentionally points to
that registry instead of duplicating a tool table that can drift.

---

## 6. Configuration

**File**: `~/.config/opencode/opencode.jsonc`

```jsonc
{
  "mcp": {
    "agent-mesh": {
      "type": "local",
      "enabled": true,
      "command": ["npx", "-y", "meshfleet"]
    }
  }
}
```

**Requirements**
- Node.js >= 20
- A compatible MCP client for the inbound stdio connection
- `opencode` binary in `$PATH` for spawned workers (not for the MCP handshake itself)

---

## 7. Phase Roadmap

| Phase | Status | Features |
|---|---|---|
| v0.1 | Implemented | `spawn_fleet`, `fleet_status`, `collect_results`, JSON ledger |
| v0.2 | Implemented | P2P messaging (5 types), capability registry, `route_work` |
| v0.3 | Implemented | Premade agent discovery, dynamic `attach_agent`, timeout watchdog |
| v0.4 | Planned | Heartbeat retry, partial result recovery, embedding-based routing |
| v0.5 | Implemented | Fleet metrics and health tools |
| v0.7 | Implemented | SSE inbox push (`subscribe_inbox`) as optional acceleration |

---

## 8. Design Decisions

| Decision | Rationale | Tradeoff |
|---|---|---|
| SQLite ledger | Transactional, portable enough for local multi-process workers | Legacy JSON import remains for upgrades; operators inspect/export through the CLI |
| `opencode run` child processes | Inherits all agent prompts, models, permissions from host config | Slight startup overhead (~1-2s per agent) |
| No built-in message bus in v0.1 | Core timeout bypass is 80% of value; message bus is additive | Agents cannot collaborate until v0.2 |
| Role strings are free-form | Matches existing `oh-my-openagent.json` agent definitions | No validation — caller responsible for sensible roles |
| In-memory test override | Enables test isolation without file I/O coupling | Adds one indirection layer |

---

## 9. Limitations

1. **No inter-agent communication** (v0.1) — Resolved in v0.2 via P2P message bus.
2. **No capability matching** (v0.1) — Resolved in v0.2 via `route_work`.
3. **Shared local ledger** — Multiple server instances can use SQLite safely, but operators should still avoid unnecessary duplicate servers and coordinate access to the same local state.
4. **No authentication** — Any compatible MCP client with the server registered can spawn fleets. Assumes trusted local environment.
5. **Stdout/stderr only** — Structured output (JSON, tool calls) from child agents is not parsed. Only raw text is captured.
6. **Timeout-based resilience** (v0.3) — Hung agents are killed after `AGENT_MESH_AGENT_TIMEOUT_MS`, but no automatic retry yet (planned v0.4).

---

## 10. Usage Example

```typescript
// From Sisyphus (or any session with agent-mesh registered)

const { fleet_id, agent_ids } = await callTool("spawn_fleet", {
  agents: [
    { role: "explore", prompt: "Map all auth middleware in src/" },
    { role: "oracle", prompt: "Review the architecture of the auth layer" },
    { role: "engineer", prompt: "Implement JWT token refresh" },
    { role: "librarian", prompt: "Research OAuth 2.1 best practices" },
  ],
});

// Poll or wait...
const status = await callTool("fleet_status", { fleet_id });

// When complete:
const results = await callTool("collect_results", { fleet_id });
// results.results[0].output → "Found 3 auth middleware files..."
```

---

## 11. File Manifest

```
~/.config/opencode/mcp-servers/agent-mesh/
├── package.json
├── package-lock.json
├── tsconfig.json
├── README.md
├── AGENT-MESH-SPEC.md          # this file
├── SPEC-P2P.md                 # P2P messaging spec (v0.2)
├── .github/
│   └── workflows/
│       └── ci.yml              # GitHub Actions CI
├── src/
│   ├── index.ts                # MCP server (transport + handlers)
│   └── core.ts                 # Pure data layer (testable)
├── test/
│   └── core.test.ts            # 26 unit tests
└── dist/                       # compiled output
    ├── index.js
    └── core.js
```

---

## 12. Version History

- **0.14.0** (2026-07-19): SQLite-backed ledger, witnessed receipts and ratification, expanded MCP registry, packaged host-neutral stdio configuration, and process-level MCP handshake coverage.
- **0.3.0** (2026-07-01): Premade agent discovery, dynamic `attach_agent`, timeout watchdog, test suite (26 tests), GitHub Actions CI, test isolation via in-memory override, package metadata, brand: meshfleet.app
- **0.2.0** (2026-07-01): P2P messaging (5 types), capability registry, `route_work`, dynamic premade agent attachment
- **0.1.0** (2026-07-01): Initial implementation. Core spawn/status/collect tools. JSON persistence. Timeout bypass verified.

---

*Part of the Agent Mesh orchestration engine. See SPEC-P2P.md for the P2P messaging specification.*
