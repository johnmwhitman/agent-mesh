# Agent Mesh — meshfleet.app

> **Auditable multi-agent coordination for OpenCode.** Spawn parallel agents as independent OS processes. Route work to specialists. Let agents collaborate peer-to-peer — with witnessed receipts and quorum ratification, so you can answer: *who saw this, who approved it, prove it.* The core is MIT and free.

**Website**: [meshfleet.app](https://meshfleet.app) · **Version**: 0.11.1 · **Tests**: 209/209 passing · [CI](https://github.com/johnmwhitman/agent-mesh/actions)

> **Project status — deliberately pre-1.0, actively maintained.** Releases are intentionally
> infrequent (we cut versions when something is worth shipping, not on a calendar); the repo
> carries a monthly maintenance heartbeat and issues get a first response within 48 hours.
>
> **The boundary, as a covenant:** the mechanisms are free and stay free — coordination,
> receipts, councils, and the ability to *run* verification are MIT, forever. Cryptographic
> **signing** and auditor-grade attestation are the paid layer ([meshfleet-pro](https://meshfleet.app/pro));
> signatures never enter this core. The developer's question (*what happened?*) is answered
> here; the auditor's question (*could anyone have changed this?*) is what you pay for.
>
> **Host portability:** this is an agent audit trail, **OpenCode first** — not an
> OpenCode-only idea. The core is a standard MCP server; broader host support tracks
> real demand.

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

And when an agent's action matters, Meshfleet can prove what happened. Every message writes **per-recipient receipts** (delivered, seen, acked). Decisions can go through **councils** — quorum-based ratification with required sign-offs, recorded on the same ledger. The design is a port of a bus that ran a 10+ agent fleet in production for 40 days and 18,404 messages, including quorum-ratified decisions.

---

## Install in 30 seconds

From npm (the package is `meshfleet`; the `agent-mesh` npm name is squatted by a placeholder):

```bash
npm install -g meshfleet
```

Or from source:

```bash
git clone https://github.com/johnmwhitman/agent-mesh.git \
  ~/.config/opencode/mcp-servers/agent-mesh
cd ~/.config/opencode/mcp-servers/agent-mesh
npm install && npm run build
```

Add to `~/.config/opencode/opencode.jsonc` (npm install):

```jsonc
{
  "mcp": {
    "agent-mesh": {
      "type": "local",
      "enabled": true,
      "command": ["npx", "meshfleet"]
    }
  }
}
```

or, if you built from source:

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

Once Meshfleet is installed, the `agent-mesh` CLI gives you terminal visibility into your running fleets, and `agent-mesh-dashboard` gives you a live TUI.

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

## 25 MCP tools

**Fleets**

| Tool | What it does |
|---|---|
| `spawn_fleet` | Spawn N parallel agents as independent OS processes |
| `spawn_from_template` | Spawn a fleet from a saved template |
| `save_fleet_template` / `list_fleet_templates` | Reusable, versioned fleet configs |
| `list_fleets` / `fleet_status` | All fleets, or one fleet's full state |
| `collect_results` | Gather every agent's final output in one call |
| `set_fleet_timeout` | Per-fleet timeout override (in ms) |
| `attach_agent` | Dynamically attach a premade agent to a running fleet |

**Messaging & receipts**

| Tool | What it does |
|---|---|
| `send_message` | P2P message (5 types) — or `to_agent_id: "*"` to broadcast to the whole fleet |
| `get_inbox` / `ack_message` | Poll and acknowledge; every ack writes a per-recipient receipt |
| `subscribe_inbox` | Push delivery over SSE instead of polling |
| `receipt` / `get_receipts` | Write and query the witnessed-delivery ledger: who saw what, when |

**Councils (quorum ratification)**

| Tool | What it does |
|---|---|
| `open_ratification` | Put a decision to the fleet: quorum size, deadline, required sign-offs |
| `cast_vote` | An agent votes, on the record |
| `tally_ratification` / `sweep_ratifications` | Resolve outcomes; expire past-deadline votes |

**Routing & ops**

| Tool | What it does |
|---|---|
| `register_capability` | Self-describe role + skills for routing |
| `route_work` | Match a task to the best agent by keyword + role overlap |
| `record_routing_outcome` | Feed results back to improve routing |
| `list_agents` | Discover 100+ premade agent personalities |
| `get_health` / `ping` | Fleet health and liveness |

That's 25. We counted twice this time.

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

64 KB payload cap. The default encoding is JSON, but payloads are strings — send whatever you want. Broadcasts (`to_agent_id: "*"`) fan out to every fleet peer, and each recipient acks independently — the receipts ledger shows exactly who saw it.

---

## 4 collaboration patterns

- **Pipeline handoff**: A → B → C. Each specialist hands context to the next. No orchestrator in the loop.
- **Debate consensus**: A and B review the same artifact, debate via questions, converge before reporting.
- **Failure recovery**: C hits a blocker, broadcasts `alert`, peers with relevant skills respond with fixes.
- **Ratified decision**: a council votes on a risky action — quorum, deadline, required sign-off — and the outcome (including who stayed silent) is on the ledger.

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
| **Meshfleet** | OpenCode + multi-agent, local-first, auditable | TypeScript-only (for now) |

None of them answer "who saw this, who approved it, prove it." That's the lane.

[Full comparison →](https://meshfleet.app/comparison)

---

## Architecture

```
src/
├── core.ts              # Pure data layer: ledger, messages, receipts, capabilities, events
├── ratify.ts            # Councils: quorum ratification over the receipts substrate
├── templates.ts         # Versioned fleet templates
├── routing-feedback.ts  # Outcome-informed work routing
├── health.ts            # Fleet health scoring
├── realtime.ts          # SSE push delivery (subscribe_inbox)
├── inspector.ts         # Pure formatters for CLI output
├── index.ts             # MCP server: transport + tool handlers
└── bin/
    ├── inspect.ts       # CLI: npx agent-mesh inspect
    └── dashboard.ts     # Live TUI: npx agent-mesh-dashboard
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

The core is MIT — use it, fork it, ship it in your product. No attribution beyond the license file. (A commercial assurance layer, [Meshfleet Pro](https://meshfleet.app/pro), lives in a separate repo and doesn't change what's here.)

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Bugs → [issues](https://github.com/johnmwhitman/agent-mesh/issues). Security → [SECURITY.md](./SECURITY.md). Roadmap → [ROADMAP.md](./ROADMAP.md).
