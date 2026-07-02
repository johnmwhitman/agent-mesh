# Agent Mesh — meshfleet.app

Peer-to-peer agent orchestration engine for OpenCode. Spawns agents as independent OS processes, provides P2P messaging between agents, capability-based routing, and dynamic premade agent attachment.

**Website**: [meshfleet.app](https://meshfleet.app) — the fleet-native orchestration platform.

## Features

- **Fleet orchestration**: Spawn N parallel agents as independent `opencode run` processes — no 30-minute timeout ceiling
- **P2P messaging**: Agents send handoff, question, result, alert, and request_help messages to each other
- **Capability registry**: Agents self-describe skills; `route_work` finds the best match for a task
- **Premade agent discovery**: Scans `.opencode/agents/` for 100+ specialized agent personalities
- **Dynamic attachment**: Attach a premade agent to a running fleet mid-flight
- **JSON ledger**: Human-debuggable persistence, zero external dependencies

## MCP Tools (10 total)

| Tool | Purpose |
|---|---|
| `spawn_fleet` | Spawn N parallel agents with optional premade agent definitions |
| `fleet_status` | Check fleet and agent status |
| `collect_results` | Get all agent outputs from a fleet |
| `send_message` | P2P message between agents (handoff, question, result, alert, request_help) |
| `get_inbox` | Poll an agent's inbox for messages |
| `ack_message` | Acknowledge and remove a message from inbox |
| `register_capability` | Register agent capabilities for routing |
| `route_work` | Find best-matching agents for a task description |
| `list_agents` | List all available premade agents from .opencode/agents/ |
| `attach_agent` | Dynamically attach a premade agent to a running fleet |

## Installation

```bash
# Clone
git clone <repo-url> ~/.config/opencode/mcp-servers/agent-mesh

# Install dependencies
cd ~/.config/opencode/mcp-servers/agent-mesh
npm install

# Build
npm run build
```

## Configuration

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

## Usage

```typescript
// 1. Spawn a fleet with premade agents
const { fleet_id, agent_ids } = await callTool("spawn_fleet", {
  agents: [
    { role: "Explorer", prompt: "Map all auth middleware", agent: "codebase-onboarding-engineer" },
    { role: "Reviewer", prompt: "Review auth architecture", agent: "code-reviewer" },
  ],
});

// 2. List available premade agents
const { agents } = await callTool("list_agents", {});

// 3. Attach a new agent mid-flight
await callTool("attach_agent", {
  fleet_id, role: "Security Reviewer", prompt: "Audit auth for vulnerabilities",
  agent: "application-security-engineer"
});

// 4. Route work to the best agent
const { matches } = await callTool("route_work", {
  description: "audit authentication security vulnerabilities"
});

// 5. Agents collaborate via P2P messages
await callTool("send_message", {
  from_agent_id: agent_ids[0], to_agent_id: agent_ids[1], fleet_id,
  type: "handoff", payload: JSON.stringify({ context: "Found 3 files", next_step: "Review" })
});

// 6. Collect results
const results = await callTool("collect_results", { fleet_id });
```

## Specifications

- [AGENT-MESH-SPEC.md](AGENT-MESH-SPEC.md) — Core architecture (v0.1)
- [SPEC-P2P.md](SPEC-P2P.md) — P2P messaging + capability registry (v0.2)

## Branding

Agent Mesh ships as **meshfleet.app** — the fleet-native orchestration platform for OpenCode. Name a mesh, spawn a swarm, route work to specialists.

## Requirements

- Node.js >= 18
- OpenCode CLI in PATH
- `@modelcontextprotocol/sdk` (installed via npm)

## License

MIT