# Agent Mesh — meshfleet.app

> **Fleet-native agent orchestration for OpenCode.** Spawn parallel agents as independent OS processes. Route work to specialists. Let agents collaborate peer-to-peer. No timeouts. No markups. Open source.

**Website**: [meshfleet.app](https://meshfleet.app) · **Version**: 0.8.1 · **Tests**: 143/143 passing

---

## Why Meshfleet?

OpenCode is a single-agent runtime. You talk to it, it does things. The moment you need **multiple specialists** running in parallel — explore, then review, then implement — you hit the 30-minute background-task timeout.

Meshfleet adds the missing layer: a fleet of agents that run in parallel, message each other, hand off work, and self-organize. As independent OS processes, not background tasks. No artificial ceiling.

```typescript
const { fleet_id } = await callTool("spawn_fleet", {
  agents: [
    { role: "Explorer",   prompt: "Map the auth layer",    agent: "codebase-onboarding-engineer" },
    { role: "Analyst",    prompt: "Review the architecture", agent: "oracle" },
    { role: "Engineer",   prompt: "Implement JWT refresh",  agent: "backend-architect" },
  ],
});
```

Three specialists. Three independent processes. They hand off, ask questions, alert on problems. You read the result.

---

## Install in 30 seconds

```bash
git clone https://github.com/johnmwhitman/agent-mesh.git \
  ~/.config/opencode/mcp-servers/agent-mesh
cd ~/.config/opencode/mcp-servers/agent-mesh
npm install && npm run build
```

Add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "mcp": {
    "agent-mesh": {
      "type": "local",
      "enabled": true,
      "command": ["node", "~/.config/opencode/mcp-servers/agent-mesh/dist/index.js"]
    }
  }
}
```

Restart OpenCode. Spawn a fleet. [Full install guide →](docs/install)

---

## The CLI

Once Meshfleet is installed, the `agent-mesh` CLI gives you terminal visibility into your running fleets.

```bash
$ npx agent-mesh inspect
3 fleets:

bc34d339-935c-4…  complete  3 agents, 3 done (34.8m)
37ae1cf2-5ce8-4…  complete  1 agents, 1 done (28.2m)
d648beb0-cfb2-4…  failed    2 agents, 2 done (27.3s)

$ npx agent-mesh inspect --metrics
Total fleets:       7
  completed:        3
  failed:           4
Total agents:       16
Success rate:       42.9%
Avg duration:       1.34s

$ npx agent-mesh inspect --events 5
TIMESTAMP            EVENT              DETAIL
──────────────────────────────────────────────────────────────────────
2026-07-02 12:40:12  agent_spawned       fleet=f-1 agent=a-1
2026-07-02 12:40:12  agent_spawned       fleet=f-1 agent=a-2
2026-07-02 12:40:12  fleet_created       fleet=f-1
```

---

## 10 MCP tools

| Tool | What it does |
|---|---|
| `spawn_fleet` | Spawn N parallel agents as independent OS processes |
| `list_fleets` | List all fleets with status + agent counts |
| `fleet_status` | Check one fleet's full state |
| `set_fleet_timeout` | Per-fleet timeout override (in ms) |
| `send_message` | P2P message between agents (5 types) |
| `get_inbox` | Agent polls for incoming messages |
| `ack_message` | Acknowledge and remove a message from inbox |
| `register_capability` | Self-describe role + skills for routing |
| `route_work` | Match a task to the best agent by keyword + role overlap |
| `list_agents` | Discover 100+ premade agent personalities |
| `attach_agent` | Dynamically attach a premade agent to a running fleet |

That's 11, not 10. The math is hard.

[Full API reference →](docs/api)

---

## 5 message types

| Type | Use it for |
|---|---|
| `handoff` | Passing context to the next agent in a pipeline |
| `question` | Asking a clarifying question (with optional `correlation_id`) |
| `result` | Reporting a final outcome |
| `alert` | Broadcasting a problem to all fleet peers |
| `request_help` | Escalating when stuck (target a specific peer with relevant skills) |

64 KB payload cap. The default encoding is JSON, but payloads are strings — send whatever you want.

---

## 3 collaboration patterns

- **Pipeline handoff**: A → B → C. Each specialist hands context to the next. No orchestrator in the loop.
- **Debate consensus**: A and B review the same artifact, debate via questions, converge before reporting.
- **Failure recovery**: C hits a blocker, broadcasts `alert`, peers with relevant skills respond with fixes.

[More use cases →](https://meshfleet.app/use-cases)

---

## How it compares

| Tool | Best for | Tradeoffs |
|---|---|---|
| **OpenCode `task()`** | Single-task work | 30-min timeout, no P2P |
| **LangGraph** | Python graph apps | Python-only, hosted-first |
| **CrewAI** | Role-based Python agents | Python-only, hosted |
| **AutoGen** | Research projects | Heavy, Python-only |
| **Hand-rolled cron** | Specific one-off workflows | No shared abstractions |
| **Meshfleet** | OpenCode + multi-agent, local-first | TypeScript-only (for now) |

[Full comparison →](https://meshfleet.app/comparison)

---

## Architecture

```
src/
├── core.ts          # Pure data layer: ledger, messages, capabilities, events
├── inspector.ts     # Pure formatters for CLI output
├── index.ts         # MCP server: transport + tool handlers
└── bin/
    └── inspect.ts   # CLI: npx agent-mesh inspect
```

The data layer is the only place that reads/writes the JSON ledger. The MCP server imports it for tool handlers. The CLI imports it directly. Pure formatters live in `inspector.ts` — easy to test, no I/O.

The ledger lives at `~/.config/opencode/agent-mesh.json`. The event log at `~/.config/opencode/agent-mesh.events.log` (NDJSON).

[Full spec →](AGENT-MESH-SPEC.md) · [P2P messaging spec →](SPEC-P2P.md)

---

## Requirements

- Node.js >= 18
- OpenCode CLI in `$PATH` (any model provider OpenCode supports)
- That's it

---

## License

MIT. Use it, fork it, ship it in your product. No attribution beyond the license file.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Bugs → [issues](https://github.com/johnmwhitman/agent-mesh/issues). Security → [SECURITY.md](./SECURITY.md). Roadmap → [ROADMAP.md](./ROADMAP.md).