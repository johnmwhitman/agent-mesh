# Agent Mesh P2P Specification (v0.2.0) — meshfleet.app

## 1. Overview

Agent Mesh v0.2 adds peer-to-peer messaging and capability-based routing on top of the existing fleet spawn model. Agents can now communicate, hand off work, and request help from peers — transforming the mesh from a star topology (orchestrator → isolated workers) into a true swarm where agents collaborate directly.

---

## 2. Message Types

Five canonical message types cover the vast majority of swarm collaboration patterns:

### handoff
Transfer context and next step to another agent.
- **Payload**: JSON string with `{ context, next_step, artifacts }`
- **Direction**: One agent → another agent
- **Example**: Explore agent finishes mapping → hands off findings to Oracle for review

### question
Ask a clarifying question to another agent.
- **Payload**: JSON string with `{ question, context }`
- **Direction**: One agent → another agent
- **Example**: Engineer asks Code Reviewer whether a pattern is acceptable before committing

### result
Deliver a structured result to the orchestrator or a peer.
- **Payload**: JSON string with `{ summary, data, files_changed }`
- **Direction**: One agent → orchestrator or peer
- **Example**: Engineer completes implementation → sends result to orchestrator

### alert
Signal an exception, timeout, or failure condition to fleet peers.
- **Payload**: JSON string with `{ severity, error, agent_id, fleet_id }`
- **Direction**: One agent → all fleet peers (broadcast pattern)
- **Example**: Frontend Developer hits a blocking build error → alerts fleet

### request_help
Escalate when an agent is stuck and needs orchestrator or peer intervention.
- **Payload**: JSON string with `{ blocker, attempted, agent_id }`
- **Direction**: One agent → orchestrator or specific peer
- **Example**: Engineer can't resolve a type error → requests help from Code Reviewer

---

## 3. Delivery Semantics

- **At-least-once delivery** via the JSON ledger. Messages are appended to the recipient's inbox (array of message IDs).
- **Explicit acknowledgment** via `ack_message` — messages remain in inbox until acked.
- **Receipts (v0.9 "witnessed messaging")** — every ack writes a timestamped receipt row keyed `(message, agent, action)`. Non-consuming receipts (`seen`, `r-ack`, `retracted`, …) annotate a message without removing it from the inbox. The receipt trail answers *who saw this, who acted on it, and when* — the audit layer that a boolean `acknowledged` flag cannot provide.
- **Broadcast** — `to_agent_id: "*"` delivers to every other agent in the fleet. The recipient list is resolved and captured at send time; each recipient acks independently, and the message counts as acknowledged only when **all** recipients have acked.
- **No retries or dead-letter queue** in v0.2.
- **Payload size limit**: 64 KB (enforced at MCP tool layer).
- **Correlation IDs** — optional `correlation_id` links request/response pairs for conversation tracking.

> Lineage note: the receipts design is a port of a bus that coordinated a 10-agent
> fleet in production for 40 days (18,404 messages). Its single consumed-flag
> per message could not audit broadcast consumption; per-recipient receipts are
> the tested fix.

---

## 4. MCP Tools

### send_message
```typescript
send_message(
  from_agent_id: string,
  to_agent_id: string,   // agent id, or "*" for fleet broadcast
  fleet_id: string,
  type: "handoff" | "question" | "result" | "alert" | "request_help",
  payload: string,
  correlation_id?: string
) → { message_id: string, recipients: string[] }
```

### get_inbox
```typescript
get_inbox(
  agent_id: string,
  since?: number  // epoch ms timestamp
) → { messages: Message[] }
```

### ack_message
```typescript
ack_message(
  agent_id: string,
  message_id: string
) → { ok: boolean }
// Writes an 'ack' receipt and removes the message from this agent's inbox.
// Idempotent. A broadcast is acked independently by each recipient.
```

### receipt
```typescript
receipt(
  agent_id: string,
  message_id: string,
  action: string,    // 'seen', 'r-ack', 'retracted', ... — anything except 'ack'
  note?: string
) → { receipt: Receipt }
// Non-consuming: annotates the message, leaves it in the inbox.
// One receipt per (message, agent, action); repeat calls are idempotent.
```

### get_receipts
```typescript
get_receipts(
  message_id: string
) → { receipts: Receipt[] }  // oldest first: who acked, who annotated, when
```

### register_capability
```typescript
register_capability(
  agent_id: string,
  fleet_id: string,
  role: string,
  skills: string[],
  model?: string,
  context_window?: number
) → { ok: boolean }
```

### route_work
```typescript
route_work(
  description: string
) → { matches: Array<{ agent_id: string, score: number, role: string }> }
```

---

## 5. Collaboration Patterns

### Pattern 1: Explore → Oracle → Engineer Handoff

A 3-agent pipeline where each specialist hands context to the next:

1. **Codebase Onboarding Engineer** maps the codebase → sends `handoff` to **Oracle** with `{ context: "found 3 auth middleware files in src/middleware/", next_step: "review architecture for fragmentation" }`
2. **Oracle** reviews → sends `handoff` to **Backend Architect** with `{ context: "auth layer is fragmented across 3 files with duplicated logic", next_step: "implement unified JWT token refresh" }`
3. **Backend Architect** implements → sends `result` to orchestrator with `{ summary: "Consolidated auth middleware into single module", files_changed: ["src/middleware/auth.ts"] }`

**Topology**: Linear pipeline, one-way handoffs, no back-and-forth.

### Pattern 2: Debate with Consensus

Two agents review the same artifact and must agree before proceeding:

1. Orchestrator sends the same code snippet via `question` messages to both **Code Reviewer** and **Application Security Engineer**
2. Each sends a `result` with their assessment
3. If they disagree, either sends a `question` to the other: `{ question: "I see no security issue here — what's your concern?", context: "the eval() call on line 42" }`
4. Once they agree, one sends a `result` to the orchestrator with the consensus

**Topology**: Peer-to-peer debate loop, convergence required.

### Pattern 3: Failure Recovery via Peer Alert

An agent hits a wall and alerts the fleet for help:

1. **Frontend Developer** encounters a blocking build error → sends `alert` to all fleet peers with `{ severity: "high", error: "Module not found: can't resolve '@/components/Button'", agent_id: "...", fleet_id: "..." }`
2. **Code Reviewer** (who has relevant context) sends `request_help` response with a suggested fix: `{ blocker: "missing import path alias", attempted: "tried relative import", fix: "add @/* path alias to tsconfig.json paths" }`
3. **Frontend Developer** applies the fix → sends `result` to orchestrator with `{ summary: "Fixed path alias configuration", files_changed: ["tsconfig.json"] }`

**Topology**: Broadcast alert → targeted response → resolution.

---

## 6. Capability Registry

### Registration
Agents self-register on spawn by calling `register_capability` with their role, skills, and optional model/context_window info. The orchestrator (Sisyphus) typically registers capabilities on behalf of agents immediately after `spawn_fleet`.

### Matching Algorithm (v0.2)
Simple keyword + role overlap scoring:

1. Tokenize the work description into lowercase keywords.
2. For each registered capability, count keyword matches against `role` (lowercase) and each skill (lowercase).
3. Compute score: `matches / total_keywords`.
4. Return all matches with `score > 0`, sorted descending.
5. No embeddings or external services — pure string matching.

**Example**: `route_work("build accessible React UI with TypeScript")`
- Keywords: `["build", "accessible", "react", "ui", "typescript"]`
- Frontend Developer (role: "Frontend Developer", skills: ["React", "Vue", "Angular", "UI", "Accessibility"]) → score = 4/5 = 0.8
- UI Designer (role: "UI Designer", skills: ["Visual", "Components", "Design Systems"]) → score = 1/5 = 0.2
- Backend Architect (role: "Backend Architect", skills: ["API", "Database"]) → score = 0/5 = 0.0 (filtered out)

---

## 7. Sisyphus Orchestrator Evolution

With P2P messaging, Sisyphus evolves from a **pure spawner** to a **swarm governor**:

| Before (v0.1) | After (v0.2) |
|---|---|
| Spawn fleet → poll status → collect results | Spawn fleet → register capabilities → route work → monitor P2P messages → intervene on alerts |
| Star topology: orchestrator ↔ isolated workers | Mesh topology: agents collaborate directly, orchestrator governs |
| Manual task assignment per agent | Capability-aware routing via `route_work` |
| No failure recovery | Alert + request_help patterns enable peer-assisted recovery |

**New orchestrator workflow**:
1. `spawn_fleet` with N agents
2. `register_capability` for each agent (role, skills)
3. `route_work(description)` to find best agent for a task
4. `send_message` to hand off work between agents
5. Monitor via `fleet_status` and `get_inbox` for alerts
6. `collect_results` when fleet is complete

---

## 8. Limitations (v0.2.0)

1. **No push notifications** — agents must poll `get_inbox` on their own schedule.
2. **No message retries** — at-least-once delivery only; no automatic retry or dead-letter queue.
3. **No embedding-based matching** — capability routing uses keyword overlap only.
4. **No automatic agent scaling** — orchestrator decides fleet size.
5. **Single MCP server process** — no distributed ledger or multi-server coordination.
6. **No heartbeat/watchdog** — hung agents are not detected automatically (planned for v0.3).
7. **64KB payload limit** — large context transfers should use file paths, not inline payloads.

---

## 9. Roadmap

| Phase | Feature | Status |
|---|---|---|
| v0.1 | spawn_fleet, fleet_status, collect_results, JSON ledger | ✅ Complete |
| v0.2 | P2P message bus, capability registry, route_work | ✅ Complete |
| v0.3 | Heartbeat/watchdog, automatic retry, partial result recovery | Planned |
| v0.4 | Embedding-based capability matching, auto-scaling | Planned |
| v0.5 | Push notifications (SSE), distributed multi-server support | Planned |

---

*Part of the Agent Mesh orchestration engine. See AGENT-MESH-SPEC.md for the core architecture specification.*