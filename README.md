# Agent Mesh — meshfleet.app

> **Auditable multi-agent coordination for OpenCode.** Spawn parallel agents as independent OS processes. Route work to specialists. Let agents collaborate peer-to-peer — with witnessed receipts and quorum ratification, so you can answer: *who saw this, who approved it, prove it.* The core is MIT and free.

**Website**: [meshfleet.app](https://meshfleet.app) · **Source version**: 0.19.0 (npm publish pending) · [CI](https://github.com/johnmwhitman/agent-mesh/actions)

*Maintained: v0.19.0 tagged 2026-07-28; npm latest remains v0.18.0 · issues answered within 48h · no download-count theater.*

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
    { role: "Engineer",   prompt: "Implement JWT refresh",  agent: "backend-architect", model: "opencode-go/minimax-m3" },
  ],
});
```

Three specialists. Three independent processes. They hand off, ask questions, alert on problems. You read the result.

Each agent accepts an optional `model` (`provider/model`) selector. When set, Meshfleet persists it as the immutable request (`Agent.requested_model`) and launches `opencode run --model <value>` for that agent; the observed runtime banner lands in `Agent.runtime_model`, and a `complete` agent whose banner is missing or contradicts the request fails closed. Omitting `model` keeps the old argv exactly. The selector is data, not shell text, and the banner is observed evidence — not authentication, billing, provider availability, or attestation. Default execution is still OpenCode; there is no public runtime-adapter selector, no automatic model choice, no default token-budget drain policy, and no credential flow in this slice. Local smoke tests exercised the installed OpenCode IDs `opencode-go/minimax-m3` and `kilo/kilo-auto/free`; that evidence is environment-local. Ollama Cloud's direct API and automatic executing subscription-aware selection remain future work; the separate pure `recommend_route` advisory may opt in to a caller-evidenced near-reset tie-break.

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
    "meshfleet": {
      "type": "local",
      "enabled": true,
      "command": ["npx", "-y", "meshfleet"]
    }
  }
}
```

For noncanonical development-only source-checkout usage (not the recommended release config):

```jsonc
{
  "mcp": {
    "meshfleet": {
      "type": "local",
      "enabled": true,
      "command": ["node", "~/.config/opencode/mcp-servers/agent-mesh/dist/index.js"]
    }
  }
}
```

Restart OpenCode. Spawn a fleet. [Wiring it into your client →](#wiring-it-into-your-client)

---

## Wiring it into your client

Meshfleet is a standard stdio MCP server. The invocation is always the same — `npx -y meshfleet`
(the `meshfleet` bin in `package.json` points at the server, `dist/index.js`) — only the config
file around it changes per client.

**Honesty labels.** "Tested" means verifiable from this repo itself. Client-specific shapes below
follow each client's documented config format — we haven't wired CI to every editor, so those are
marked "per \<client\> docs — verification welcome."

### Any MCP client (generic stdio) — tested: this exact shape ships in this repo as [`mcp.json`](./mcp.json)

```json
{
  "mcpServers": {
    "meshfleet": {
      "command": "npx",
      "args": ["-y", "meshfleet"]
    }
  }
}
```

### OpenCode — primary host; canonical `meshfleet` server identity

`~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "mcp": {
    "meshfleet": {
      "type": "local",
      "enabled": true,
      "command": ["npx", "-y", "meshfleet"]
    }
  }
}
```

### Claude Code — per Claude Code docs — verification welcome

CLI form:

```bash
claude mcp add meshfleet -- npx -y meshfleet
```

Or project-scoped `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "meshfleet": {
      "command": "npx",
      "args": ["-y", "meshfleet"]
    }
  }
}
```

### Codex — same host-neutral stdio server

Configure Codex's MCP server entry with the same command and arguments:

```json
{
  "mcpServers": {
    "meshfleet": {
      "command": "npx",
      "args": ["-y", "meshfleet"]
    }
  }
}
```

These Claude Code, Codex, OpenCode, and generic MCP configurations all call the
same inbound stdio server. This proves client interoperability at the MCP
boundary only: workers spawned by Meshfleet still execute through OpenCode's
`opencode run`. The `subscribe_inbox` SSE endpoint is optional acceleration; it
is not required for compatibility, and clients can use `get_inbox` polling.

If any block above doesn't work in your client, [open an issue](https://github.com/johnmwhitman/agent-mesh/issues) — config rot is a bug.

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

$ npx agent-mesh inspect timeline f-1 --from 2026-07-02T12:40:00Z --to 2026-07-02T12:45:00Z
Local ledger timestamps in [1782996000000,1782996300000) · not authenticity, completeness, tamper evidence, authenticated provenance, or external time
TIMESTAMP            KIND                SUMMARY
──────────────────────────────────────────────────────────────────────
2026-07-02 12:40:13  message             handoff agent-a→agent-b
2026-07-02 12:40:18  receipt             ack by agent-b on 3f9c1a2b

$ npx agent-mesh inspect --follow            # or -f; add --fleet <id> to scope to one fleet
ledger: ~/.config/opencode/agent-mesh.db  · poll 400ms  · ctrl-c to stop
watching… no messages yet  (spawn a fleet or send_message from MCP)
2026-07-22 09:14:03  handoff  agent-a → agent-b  msg=3f9c1a2b  {"task":"review PR #42"}
```

Timeline bounds are optional digits-only epoch milliseconds, ISO dates
(`YYYY-MM-DD`), or timezone-bearing ISO datetimes
(`YYYY-MM-DDTHH:mm:ss[.fraction](Z|±HH:mm)`). Fractional precision is
normalized to epoch milliseconds. Bounds select the half-open interval
`[from,to)` over timestamps stored in the local ledger. Add `--json` for the
additive `timeline_window` inspect envelope. An unbounded `inspect timeline
[fleet]` keeps the original text and JSON shapes. This is read-only
local-record selection, not proof of authenticity, completeness, tamper
evidence, authenticated provenance, or external time.

---

## 34 MCP tools

**Fleets**

| Tool | What it does |
|---|---|
| `spawn_fleet` | Spawn N parallel agents as independent OS processes; each agent may set an optional `model` (`provider/model`) selector that becomes `opencode run --model <value>` and is preserved across retries and Discussion wakeups |
| `spawn_from_template` | Spawn a fleet from a saved template |
| `save_fleet_template` / `list_fleet_templates` | Reusable, versioned fleet configs |
| `list_fleets` / `fleet_status` | All fleets, or one fleet's full state |
| `collect_results` | Gather every agent's final output in one call |
| `set_fleet_timeout` | Per-fleet timeout override (in ms) |
| `attach_agent` | Dynamically attach a premade agent to a running fleet; the agent may set the same optional `model` (`provider/model`) selector |

**Messaging & receipts**

| Tool | What it does |
|---|---|
| `send_message` | P2P message (5 types) — or `to_agent_id: "*"` to broadcast to the whole fleet |
| `send_messages` | Batched sends, one atomic transaction per batch (up to 1000 messages; larger batches are rejected) |
| `get_inbox` / `ack_message` | Poll and acknowledge; every ack writes a per-recipient receipt |
| `subscribe_inbox` | Push delivery over SSE instead of polling (optional auth token) |
| `receipt` / `get_receipts` | Write and query the witnessed-delivery ledger: who saw what, when |
| `verify_ledger` | Audit the whole ledger's internal consistency — errors mean it asserts something its own records don't support |
| `verify_ledger_v2` | Versioned unsigned-snapshot consistency envelope around the unchanged verifier report from a dedicated read-only file snapshot; the handler performs no ledger writes |

**Councils (quorum ratification)**

| Tool | What it does |
|---|---|
| `open_ratification` | Put a decision to the fleet: quorum, deadline, required sign-offs, optional per-voter weights |
| `cast_vote` | An agent votes, on the record — re-casting changes the effective vote without rewriting history |
| `tally_ratification` / `sweep_ratifications` | Resolve outcomes; expire past-deadline votes |

**Routing & ops**

| Tool | What it does |
|---|---|
| `register_capability` | Self-describe role + skills for routing |
| `route_work` | Match a task to the best agent by keyword + role overlap |
| `recommend_route` | Advisory ranking for caller-supplied agent/runtime/model candidates, with hard privacy/capability filters and an opt-in near-reset tie-break |
| `compile_route_candidates` | Pure offline projection of sanitized manifest/observation snapshots; does not rank, persist, execute, authorize, wake, or contact providers |
| `record_routing_outcome` | Feed results back to improve routing |
| `list_agents` | Discover 100+ premade agent personalities |
| `get_health` / `ping` | Fleet health and liveness |

**Discussions (bounded two-agent negotiation)**

| Tool | What it does |
|---|---|
| `ask_peer` | Open a bounded Discussion: send the root question, optionally reserve one peer attempt, wait for a settled answer |
| `wake_agent` | The sole general-purpose Discussion run trigger — atomically reserve and launch one bounded attempt |
| `reply_discussion` | Submit the one reply an active wake attempt is authorized to produce; never launches an agent |
| `get_discussion` | Read-only: derive transcript, attempts, budget, and fail-closed status from durable messages and receipts |

See [docs/discussions.md](docs/discussions.md) for the full quickstart, tool reference, and terminal-state precedence.

That's 34. We counted twice this time.

RoutePlane catalog discovery is a separate package library and CLI, not an MCP
tool: it fetches RoutePlane's fixed loopback model catalog and projects
caller-owned policy into advisory candidates. Its package-library API,
`recommendRoutePlaneCatalog()`, composes an already-fetched snapshot; the opt-in
`fetchAndRecommendRoutePlaneCatalog()` fetches that fixed loopback catalog once
before the same composition. Their `evaluated` and `no_compiled_candidates`
statuses preserve catalog diagnostics separately from task exclusions and remain
advisory with all effects false. Neither API deploys, publishes, selects
providers, executes models, contacts providers beyond that explicit loopback
catalog fetch, polls budget telemetry, or infers authority from provider labels.
[RoutePlane catalog boundary → docs/ROUTEPLANE-CATALOG.md](docs/ROUTEPLANE-CATALOG.md)

Fleetbudget ingress and observation projection are separate package surfaces,
not MCP tools. The new `meshfleet/fleetbudget-sanitizer` library and
`meshfleet-fleetbudget-sanitize` stdin CLI strictly validate the current
unversioned `fleetbudget --json` byte shape against a caller-owned collection
interval. They retain `lane` only as an opaque evidence identifier plus
`measured`, `used`, `total`, and `unit`; `routes`, `state`, `utilization`,
`note`, and `detail` are validated and erased. The CLI reads stdin and never
invokes Fleetbudget, another provider process, or a route command.

Sanitized raw lanes deliberately contain no typed quota window, so even a
complete or exhausted raw ceiling remains diagnostic-only: it produces
`WINDOW_MISSING`, no observation, and no availability, exhaustion, allocation,
ranking, or route authority. `compileFleetBudgetObservations()` still accepts
caller-supplied versioned snapshots with explicit candidate bindings when a
real typed quota window exists. Several candidates may share a lane ID as
copied, unsplit evidence; the compiler returns observations or diagnostics,
canonical provenance hashes, and all-false effects. Neither surface sums,
allocates, reserves, synchronizes, executes, or authorizes. Validated window
bounds flow through the route-candidate compiler without their lane/window ID.
An explicit `prefer_near_reset` recommendation can use those bounds only after
the existing final score as a tie-break; there is no default drain policy.
Structured collector versioning,
producer-owned observation timing, and typed quota windows are required before
raw measured budget can become actionable. [Safe host collection and exact boundary → docs/FLEETBUDGET-OBSERVATIONS.md](docs/FLEETBUDGET-OBSERVATIONS.md)

Sanitized fleet wrapper usage is available through the separate pure
`meshfleet/wrapper-usage-observations` package surface. It accepts only the
closed, already-decoded `fleet.wrapper-usage-summary/v1` object and returns a
distinct `accepted`/`groups` status envelope with all effects and authorities
false. It preserves `routeplane-unattributed` exactly and copies source
rejections and aggregate counts without prompts, raw event IDs, provider or
quota inference, derived rates, persistence, execution, scheduling, routing,
logging activation, or MeshFleet health changes. It is not an MCP tool and is
not structurally interchangeable with route-candidate observations.
[Wrapper usage status boundary → docs/WRAPPER-USAGE-OBSERVATIONS.md](docs/WRAPPER-USAGE-OBSERVATIONS.md)

[Advisory routing → docs/ADVISORY-ROUTING.md](docs/ADVISORY-ROUTING.md) · [Fleetbudget observations → docs/FLEETBUDGET-OBSERVATIONS.md](docs/FLEETBUDGET-OBSERVATIONS.md) · [Architecture orientation → AGENT-MESH-SPEC.md](AGENT-MESH-SPEC.md) · [P2P/receipts → SPEC-P2P.md](SPEC-P2P.md) · [Councils → SPEC-COUNCILS.md](SPEC-COUNCILS.md)

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

[More on the receipts wedge →](https://meshfleet.app)

---

## What the verifier catches — and what it can't

"Prove it" is a claim about detection, so it ships with the evidence:
[`test/fixtures/corpus/`](test/fixtures/corpus/README.md) is a corpus of 76 deliberately
falsified ledgers, each one a clean baseline plus **one declared change**. Results are
reported in three separate buckets, never blended into a single coverage number:

| Bucket | N | What it means |
|---|---|---|
| `caught` | 54 | An overclaim — the ledger asserts something its own records don't support. Raises an error and fails the ledger. |
| `anomaly` | 12 | Surprising, but claims no more than the records support. Warning only, and deliberately *not* counted as caught. |
| `undetectable` | 10 | The unsigned local core structurally cannot see it. Produces zero findings. |

**That third bucket is published on purpose.** The core polices internal coherence; it
cannot police provenance, content binding, completeness, or absolute time. So a payload
swapped *after* a council approved it, a ballot minted for an agent that legitimately
holds a seat, a ghost agent with a coherent history, and a wholesale clock shift all
verify clean — and each is committed as a fixture asserting exactly that. This is the
free-core boundary as something you can run, rather than something we assert. It is also
precisely the line [Meshfleet Pro](https://meshfleet.app/pro) exists on the other side of:
signatures are what make those vectors detectable, and signatures are not in this core.

Together the `caught` and `anomaly` vectors name every check the verifier can emit outside
the `discussion.*` family, and that inventory is re-derived from source on every run — so
a new check without a fixture fails the build.

### Implemented versioned evidence scope

`verify_ledger_v2` is an implemented opt-in MCP verifier surface. The existing
`verify_ledger`, `VerifyReport`, `VerifyFinding`, `agent-mesh inspect --verify`,
and `meshfleet.inspect/v1` remain unchanged.

At tool dispatch, its handler reads the configured ledger through a dedicated
read-only file snapshot and performs no ledger writes. In normal parent mode,
server startup recovery or migration may initialize or change the configured
ledger before any tool dispatch; those pre-dispatch effects are unchanged by
v2 and are outside this handler boundary.

The MCP tool returns this envelope. The matching opt-in `agent-mesh inspect
--verify-v2 [file]` CLI mode is implemented: it audits the supplied file, or
the configured ledger, through the same dedicated read-only file snapshot. With
`--json` it emits this same object; otherwise it emits one evidence-scope header
followed by the unchanged legacy verifier text:

```json
{
  "schema": "meshfleet.verify/v2",
  "evidence_scope": {
    "profile": "unsigned_snapshot_consistency/v1",
    "ok_means": "no_detected_internal_consistency_contradiction",
    "assurance_ceiling": "internal_consistency_of_the_unsigned_snapshot_read",
    "not_established": [
      "authorship_and_authenticated_provenance",
      "pre_read_snapshot_integrity_and_tamper_evidence",
      "content_binding",
      "completeness_and_deletion",
      "external_delivery_and_execution",
      "external_time"
    ]
  },
  "report": "the unchanged VerifyReport"
}
```

`report.ok` retains its exact current meaning: no detected internal
consistency contradiction in the unsigned snapshot read (`report.errors ===
0`). It does not establish authorship or authenticated provenance, pre-read
snapshot integrity or tamper evidence, content binding, completeness or absence
of deletion, external delivery or execution, or external time. The scope is
generated verifier output, never caller or ledger input; it is a ceiling on
what the report establishes, not a confidence score, integrity verdict, or
promotion.

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

[FAQ →](https://meshfleet.app/faq)

---

## Architecture

```
src/
├── db.ts                # The withLedger transaction seam over SQLite (the write boundary)
├── core.ts              # Data layer: ledger, messages, receipts, capabilities, events
├── migrate.ts           # One-shot JSON→SQLite migration (runs once at startup)
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

Every write goes through **one** function — `withLedger(mutator)` in `db.ts` — which runs the mutation inside a single SQLite `BEGIN IMMEDIATE` transaction. Agents are real OS processes that each boot their own agent-mesh instance on the same ledger, so writes are genuinely concurrent; SQLite (WAL + `busy_timeout`) provides cross-process write exclusion, so this codebase owns no locking protocol and lost-update is impossible by construction. (An earlier JSON read-modify-write store silently lost 57 of 120 receipts under a two-process test; the SQLite seam passes the same test 200/200.) Readers use a lock-free `readLedger()`. Pure formatters live in `inspector.ts` — easy to test, no I/O.

The ledger lives at `~/.config/opencode/agent-mesh.db` (SQLite); the event log at `~/.config/opencode/agent-mesh.events.log` (NDJSON). Dump the ledger as human-readable JSON any time with `npx agent-mesh inspect --export`. On first run after upgrading from a JSON ledger, the server migrates it once (validated, with a `.migrated.<ts>` backup kept).

[Architecture orientation →](AGENT-MESH-SPEC.md) · [P2P messaging spec →](SPEC-P2P.md)

---

## Requirements

- Node.js >= 20
- OpenCode CLI in `$PATH` (any model provider OpenCode supports)
- That's it

---

## License

The core is MIT — use it, fork it, ship it in your product. No attribution beyond the license file. (A commercial assurance layer, [Meshfleet Pro](https://meshfleet.app/pro), lives in a separate repo and doesn't change what's here.)

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Bugs → [issues](https://github.com/johnmwhitman/agent-mesh/issues). Security → [SECURITY.md](./SECURITY.md). Roadmap → [ROADMAP.md](./ROADMAP.md).
