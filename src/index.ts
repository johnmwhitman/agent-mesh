#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { createRequire } from "module";
import { resolveEnv } from "./env.js";

// Single source of truth for the advertised version — package.json.
// (The literal here drifted to 0.7.0 while releases moved to 0.11.x.)
const MESH_VERSION: string = createRequire(import.meta.url)("../package.json").version;
import {
  appendEvent,
  ackMessage,
  getReceipts,
  writeReceipt,
  autoRegisterFromAgent,
  _createFleet,
  _registerAgent,
  discoverPremadeAgents,
  getFleetTimeoutMs,
  getInbox,
  listFleets,
  markAgentFinished,
  MAX_PAYLOAD_BYTES,
  MESSAGE_TYPES,
  MessageType,
  recoverInterruptedAgents,
  registerCapability,
  routeWork,
  sendMessage,
  sendMessages,
  setFleetTimeout,
} from "./core.js";
import { readLedger, withLedger } from "./db.js";
import { migrateJsonToSqlite } from "./migrate.js";
import { checkRateLimit, getHealth, ping } from "./health.js";
import {
  saveFleetTemplate as saveFleetTemplateFn,
  listFleetTemplates as listFleetTemplatesFn,
  spawnFromTemplate as spawnFromTemplateFn,
  type TemplateAgent,
} from "./templates.js";
import {
  openRatification,
  castVote,
  tallyRatification,
  resolveRatification,
  sweepRatifications,
} from "./ratify.js";
import { verifyLedger } from "./verify.js";
import { notifySubscribers } from "./realtime.js";
import { startSseServer, stopSseServer, subscribeInboxUrl } from "./sse-server.js";
import { createHeartbeat } from "./heartbeat.js";
import {
  computeBackoff,
  scheduleRetry as scheduleAgentRetry,
  shouldRetry as shouldAgentRetry,
} from "./retry.js";
import { recordRoutingOutcome } from "./routing-feedback.js";
import { buildFailureDetail } from "./spawn-attempt.js";
import { getDefaultRuntimeAdapter } from "./runtime/registry.js";
import { defaultLifecycleMode, LifecycleExecutionCoordinator, repairLifecycleOutbox } from "./lifecycle-execution.js";

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "agent-mesh", version: MESH_VERSION },
  { capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------
// Agent Spawning (orchestration concern - not pure data)
// ---------------------------------------------------------------------------

interface SpawnAgentInput {
  fleetId: string;
  role: string;
  prompt: string;
  agentFile?: string;
}

const runtimeAdapter = getDefaultRuntimeAdapter();
const lifecycleCoordinator = new LifecycleExecutionCoordinator(runtimeAdapter);

/**
 * Inner spawn loop. attempt is 1-indexed (first attempt = 1).
 * On any transient failure path, decides retry vs permanent via shouldAgentRetry().
 */
function trySpawn(input: SpawnAgentInput, agentId: string, attempt: number): void {
  const spec = {
    fleetId: input.fleetId,
    agentId,
    role: input.role,
    prompt: input.prompt,
    requestedAgent: input.agentFile,
    cwd: process.cwd(),
    timeoutMs: runtimeAdapter.describe().defaultTimeoutMs,
  };
  void runtimeAdapter.start(spec).then((handle) => {
    if (handle.pid !== undefined) {
      withLedger((data) => {
        const agent = data.agents[agentId];
        if (agent) agent.pid = handle.pid;
      });
    }
    let watchdogReason: string | undefined;
    const heartbeat = createHeartbeat(agentId, input.fleetId, {
      intervalMs: 5_000,
      onHeartbeat: () => {},
      maxMissed: 12,
      isAlive: () => handle.isAlive(),
      onMaxMissed: (reason) => {
        watchdogReason = `Heartbeat watchdog: ${reason}`;
        void runtimeAdapter.cancel(handle, watchdogReason);
      },
    });
    void runtimeAdapter.wait(handle).then((result) => {
      heartbeat.stop();
      if (result.status === "success") {
        markAgentFinished(
          agentId,
          "complete",
          result.stdout,
          result.stderr || undefined,
          result.identity.agent,
          result.identity.model,
        );
        return;
      }
      handleTransientFailure(
        input,
        agentId,
        attempt,
        result.stdout,
        result.stderr,
        watchdogReason ?? result.error ?? `Spawn failed with exit code ${result.exitCode}`,
        result.identity.agent,
        result.identity.model,
      );
    });
  }).catch((error: unknown) => {
    handleTransientFailure(input, agentId, attempt, "", "", error instanceof Error ? error.message : String(error));
  });
}

function handleTransientFailure(
  input: SpawnAgentInput,
  agentId: string,
  attempt: number,
  stdout: string,
  stderr: string,
  errorDetail: string,
  runtimeAgent?: string,
  runtimeModel?: string
): void {
  const failureDetail = buildFailureDetail(stderr, errorDetail);
  if (!shouldAgentRetry(attempt)) {
    appendEvent("agent_failed_permanent", {
      agent_id: agentId,
      attempts: attempt,
      last_error: failureDetail,
      timestamp: Date.now(),
    });
    markAgentFinished(
      agentId,
      "failed",
      stdout,
      `Permanent failure after ${attempt} attempt(s). Last error: ${failureDetail}`,
      runtimeAgent,
      runtimeModel
    );
    return;
  }
  const nextAttempt = attempt + 1;
  const delayMs = computeBackoff(nextAttempt);
  appendEvent("agent_retry_scheduled", {
    agent_id: agentId,
    from_attempt: attempt,
    to_attempt: nextAttempt,
    delay_ms: delayMs,
    last_error: failureDetail,
    timestamp: Date.now(),
  });
  scheduleAgentRetry(nextAttempt, () => {
    trySpawn(input, agentId, nextAttempt);
  });
  void stdout;
}

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "spawn_fleet",
      description:
        "Spawn parallel agents. Returns fleet_id. Each agent can optionally specify an 'agent' field to use a premade agent definition from .opencode/agents/.",
      inputSchema: {
        type: "object",
        properties: {
          agents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                role: { type: "string" },
                prompt: { type: "string" },
                agent: {
                  type: "string",
                  description:
                    "Premade agent filename stem (e.g. 'frontend-developer'). See list_agents.",
                },
              },
              required: ["role", "prompt"],
            },
          },
        },
        required: ["agents"],
      },
    },
    {
      name: "fleet_status",
      description: "Check fleet and agent status.",
      inputSchema: {
        type: "object",
        properties: { fleet_id: { type: "string" } },
        required: ["fleet_id"],
      },
    },
    {
      name: "list_fleets",
      description: "List all fleets with summaries (agent count, status, completion).",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "set_fleet_timeout",
      description:
        "Set a per-fleet timeout override (in milliseconds). Agents exceeding this are auto-failed.",
      inputSchema: {
        type: "object",
        properties: {
          fleet_id: { type: "string" },
          timeout_ms: { type: "number" },
        },
        required: ["fleet_id", "timeout_ms"],
      },
    },
    {
      name: "collect_results",
      description: "Get all agent outputs from a fleet.",
      inputSchema: {
        type: "object",
        properties: { fleet_id: { type: "string" } },
        required: ["fleet_id"],
      },
    },
    {
      name: "send_message",
      description:
        'Send a P2P message from one agent to another within the same fleet. Set to_agent_id to "*" to broadcast to every other agent in the fleet (each recipient acks independently; see get_receipts).',
      inputSchema: {
        type: "object",
        properties: {
          from_agent_id: { type: "string" },
          to_agent_id: { type: "string", description: 'Recipient agent id, or "*" for fleet broadcast' },
          fleet_id: { type: "string" },
          type: { type: "string", enum: [...MESSAGE_TYPES] },
          payload: { type: "string" },
          correlation_id: { type: "string" },
        },
        required: ["from_agent_id", "to_agent_id", "fleet_id", "type", "payload"],
      },
    },
    {
      name: "send_messages",
      description:
        "Send a batch of P2P messages in ONE ledger transaction — use instead of repeated send_message calls for bulk fan-out (much faster: the recipient inbox is updated once per batch, not once per message). Atomic: one invalid message rejects the whole batch. Max 1000 messages per call.",
      inputSchema: {
        type: "object",
        properties: {
          messages: {
            type: "array",
            maxItems: 1000,
            items: {
              type: "object",
              properties: {
                from_agent_id: { type: "string" },
                to_agent_id: { type: "string", description: 'Recipient agent id, or "*" for fleet broadcast' },
                fleet_id: { type: "string" },
                type: { type: "string", enum: [...MESSAGE_TYPES] },
                payload: { type: "string" },
                correlation_id: { type: "string" },
              },
              required: ["from_agent_id", "to_agent_id", "fleet_id", "type", "payload"],
            },
          },
        },
        required: ["messages"],
      },
    },
    {
      name: "get_inbox",
      description:
        "Get messages in an agent's inbox, optionally since a timestamp.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          since: { type: "number", description: "Epoch ms timestamp" },
        },
        required: ["agent_id"],
      },
    },
    {
      name: "ack_message",
      description:
        "Acknowledge a message, removing it from the agent's inbox. Writes an 'ack' receipt (per-recipient — a broadcast is acked independently by each recipient).",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          message_id: { type: "string" },
        },
        required: ["agent_id", "message_id"],
      },
    },
    {
      name: "receipt",
      description:
        "Write a non-consuming receipt on a message — the audit primitive. Use actions like 'seen', 'r-ack' (approve), 'retracted'. Unlike ack_message, the message stays in the inbox. One receipt per (message, agent, action); repeat calls are idempotent.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          message_id: { type: "string" },
          action: { type: "string", description: "e.g. 'seen', 'r-ack', 'retracted' — any label except 'ack' (use ack_message to consume)" },
          note: { type: "string" },
        },
        required: ["agent_id", "message_id", "action"],
      },
    },
    {
      name: "get_receipts",
      description:
        "Get the full receipt trail for a message: who acked, who annotated, when. Answers 'who saw this and who acted on it'.",
      inputSchema: {
        type: "object",
        properties: {
          message_id: { type: "string" },
        },
        required: ["message_id"],
      },
    },
    {
      name: "verify_ledger",
      description:
        "Audit the ledger's internal consistency: every receipt points at a real message and honors the idempotency key, acknowledged flags are supported by ack receipts, inboxes hold no consumed or dangling messages, and ratification tallies (quorum, signoffs, vote polarity, terminal status) recompute from the receipts. Read-only. Returns ok, error/warning counts, and per-finding detail — errors mean the ledger asserts something its own records do not support.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "open_ratification",
      description:
        "Open a quorum vote ('council') over the fleet. Broadcasts a proposal; peers vote with cast_vote. Ratifies when approvals reach the quorum and every required signoff approves. Returns the proposal message_id.",
      inputSchema: {
        type: "object",
        properties: {
          proposer: { type: "string" },
          fleet_id: { type: "string" },
          subject: { type: "string" },
          payload: { type: "string", description: "Full proposal text (defaults to subject)" },
          quorum: { type: "number", description: "Approvals required to ratify" },
          voters: { type: "array", items: { type: "string" }, description: "Eligible voters; defaults to every other agent in the fleet" },
          required_signoffs: { type: "array", items: { type: "string" }, description: "Agents whose approval is mandatory regardless of quorum (e.g. a T5 authority)" },
          deadline: { type: "number", description: "Epoch ms; after it, silence_policy applies" },
          silence_policy: { type: "string", enum: ["abstain", "approve"], description: "How non-voters count once the deadline passes (default abstain)" },
          weights: {
            type: "object",
            additionalProperties: { type: "number" },
            description:
              "Tiered councils: per-voter positive-integer weights (max 1000000). Unlisted voters weigh 1, so quorum becomes a weight threshold. Weight never satisfies a required signoff.",
          },
        },
        required: ["proposer", "fleet_id", "subject", "quorum"],
      },
    },
    {
      name: "cast_vote",
      description:
        "Cast a vote on an open ratification. approve=true records approval, approve=false rejection. Re-casting CHANGES your effective vote (each change appends a new sequenced receipt — history is never rewritten); repeating your current vote is a no-op.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          message_id: { type: "string" },
          approve: { type: "boolean" },
          note: { type: "string" },
        },
        required: ["agent_id", "message_id", "approve"],
      },
    },
    {
      name: "tally_ratification",
      description:
        "Read the live vote tally and current status (open / ratified / rejected / expired) of a ratification, and persist the status if it has reached a terminal state.",
      inputSchema: {
        type: "object",
        properties: {
          message_id: { type: "string" },
        },
        required: ["message_id"],
      },
    },
    {
      name: "sweep_ratifications",
      description:
        "Evaluate every open ratification now and persist any that reached a terminal state (deadline expiry, silent-approval, unreachable quorum). The server also sweeps automatically every AGENT_MESH_RATIFY_SWEEP_MS (default 60s).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "register_capability",
      description:
        "Register an agent's capabilities (role, skills, model) for routing.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          fleet_id: { type: "string" },
          role: { type: "string" },
          skills: { type: "array", items: { type: "string" } },
          model: { type: "string" },
          context_window: { type: "number" },
        },
        required: ["agent_id", "fleet_id", "role", "skills"],
      },
    },
    {
      name: "route_work",
      description:
        "Route a work description to the best-matching registered agents by keyword + role/skill overlap scoring (with synonym expansion), weighted by routing feedback (success/fail history). top_n controls how many matches to return (default 1, max = fleet size).",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string" },
          top_n: {
            type: "number",
            description: "Maximum number of matches to return (default 1).",
            default: 1,
            minimum: 1,
          },
        },
        required: ["description"],
      },
    },
    {
      name: "record_routing_outcome",
      description:
        "Record whether a routed task succeeded or failed. Future route_work calls for the same agent weight their score by accumulated outcomes (Wilson-style). capability_key is a free-form identifier (e.g. 'react', 'sql') so an agent can be penalized for one failure mode without losing other capabilities.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          capability_key: { type: "string" },
          success: { type: "boolean" },
        },
        required: ["agent_id", "capability_key", "success"],
      },
    },
    {
      name: "list_agents",
      description:
        "List all available premade agents from .opencode/agents/ directories.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "attach_agent",
      description:
        "Dynamically attach a premade agent to an existing running fleet.",
      inputSchema: {
        type: "object",
        properties: {
          fleet_id: { type: "string" },
          role: { type: "string" },
          prompt: { type: "string" },
          agent: {
            type: "string",
            description: "Premade agent filename stem (e.g. 'frontend-developer').",
          },
        },
        required: ["fleet_id", "role", "prompt"],
      },
    },
    {
      name: "ping",
      description: "Minimal liveness check. Returns { status: 'ok', timestamp }.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "subscribe_inbox",
      description:
        "Subscribe to an agent's inbox via Server-Sent Events (SSE). Returns a stream URL that the agent opens to receive real-time push of incoming P2P messages. Falls back to polling get_inbox if SSE is unreachable. If the operator set MESHFLEET_AUTH_TOKEN, requests to the stream must carry it (Authorization: Bearer, or ?token=).",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: "The agent whose inbox to subscribe to.",
          },
        },
        required: ["agent_id"],
      },
    },
    {
      name: "get_health",
      description:
        "Health report: ledger size, fleet/agent/message counts, uptime, last event. Use for monitoring and alerting.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "save_fleet_template",
      description:
        "Save a named fleet template (set of agent specs) for reuse. Names: lowercase letters, numbers, dashes, underscores.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          agents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                role: { type: "string" },
                prompt: { type: "string" },
                agent: { type: "string" },
              },
              required: ["role", "prompt"],
            },
          },
        },
        required: ["name", "agents"],
      },
    },
    {
      name: "list_fleet_templates",
      description: "List all saved fleet templates, sorted by name.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "spawn_from_template",
      description:
        "Return a fleet spec from a saved template, ready to pass to spawn_fleet.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Tool Handlers
// ---------------------------------------------------------------------------

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function jsonError(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

const toolHandlers: Record<
  string,
  (args: any) => Promise<CallToolResult> | CallToolResult
> = {};

toolHandlers["spawn_fleet"] = async (args) => {
    const { agents } = args as { agents: { role: string; prompt: string; agent?: string }[] };
    const fleetId = randomUUID();
    const specs = agents.map((a) => ({
      agentId: randomUUID(),
      role: a.role,
      prompt: a.prompt,
      agent: a.agent,
    }));

    let lifecycleMode;
    try {
      lifecycleMode = defaultLifecycleMode();
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err));
    }
    if (lifecycleMode === "durable") {
      try {
        lifecycleCoordinator.createFleet(fleetId, specs.map((s) => ({ fleetId, agentId: s.agentId, role: s.role, prompt: s.prompt, agentFile: s.agent })));
      } catch (err) {
        // Durable mode is fail-closed: do not fall back to legacy spawning.
        return jsonError(err instanceof Error ? err.message : String(err));
      }
      for (const s of specs) if (s.agent) autoRegisterFromAgent(s.agentId, fleetId, s.agent);
      return jsonResult({ fleet_id: fleetId, agent_ids: specs.map((s) => s.agentId) });
    }

    // Phase 1 — ONE txn: create the fleet + pre-register every agent row.
    // spawn() is a side-effect, so it cannot live in the txn; committing the
    // rows first means a crash after commit leaves recoverable "running" agents,
    // never a fleet with phantom-missing members.
    withLedger((data) => {
      _createFleet(data, fleetId);
      for (const s of specs) {
        _registerAgent(data, {
          id: s.agentId,
          fleet_id: fleetId,
          role: s.role,
          prompt: s.prompt,
          agent_file: s.agent,
          status: "running",
          started_at: Date.now(),
        });
      }
    });
    if (lifecycleMode === "shadow") lifecycleCoordinator.recordMode(fleetId, "shadow");
    appendEvent("fleet_created", { fleet_id: fleetId });
    appendEvent("spawn_fleet_called", { fleet_id: fleetId, agent_count: agents.length });

    // Phase 2 — spawn each child after commit; per-child pid write-back is in trySpawn.
    for (const s of specs) {
      trySpawn({ fleetId, role: s.role, prompt: s.prompt, agentFile: s.agent }, s.agentId, 1);
      appendEvent("agent_spawned", { fleet_id: fleetId, agent_id: s.agentId, role: s.role, agent_file: s.agent });
      if (s.agent) autoRegisterFromAgent(s.agentId, fleetId, s.agent);
    }

    return jsonResult({ fleet_id: fleetId, agent_ids: specs.map((s) => s.agentId) });
};

toolHandlers["fleet_status"] = async (args) => {
    const ip = "global"; // no IP extraction yet; use single bucket
    if (!checkRateLimit(ip, "read")) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Read rate limit exceeded. Slow down." }) }], isError: true };
    }
    const { fleet_id } = args as { fleet_id: string };
    const data = readLedger();
    const fleet = data.fleets[fleet_id];
    const agents = Object.values(data.agents).filter(
      (a) => a.fleet_id === fleet_id
    );
    return jsonResult({ fleet, agents });
};

toolHandlers["list_fleets"] = async (args) => {
    const ip = "global";
    if (!checkRateLimit(ip, "read")) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Read rate limit exceeded." }) }], isError: true };
    }
    return jsonResult({ fleets: listFleets() });
};

toolHandlers["set_fleet_timeout"] = async (args) => {
    const { fleet_id, timeout_ms } = args as { fleet_id: string; timeout_ms: number };
    try {
      setFleetTimeout(fleet_id, timeout_ms);
      appendEvent("fleet_timeout_set", { fleet_id, timeout_ms });
      return jsonResult({ ok: true, timeout_ms: getFleetTimeoutMs(fleet_id) });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err));
    }
};

toolHandlers["collect_results"] = async (args) => {
    const { fleet_id } = args as { fleet_id: string };
    const data = readLedger();
    const agents = Object.values(data.agents).filter(
      (a) => a.fleet_id === fleet_id
    );
    return jsonResult({
      fleet_id,
      results: agents.map((a) => ({
        role: a.role,
        status: a.status,
        output: a.output,
        error: a.error,
      })),
    });
};

toolHandlers["send_message"] = async (args) => {
    const {
      from_agent_id,
      to_agent_id,
      fleet_id,
      type,
      payload,
      correlation_id,
    } = args as {
      from_agent_id: string;
      to_agent_id: string;
      fleet_id: string;
      type: MessageType;
      payload: string;
      correlation_id?: string;
    };
    try {
      // The writer returns the resolved recipient list from inside the txn, so
      // SSE notification needs no post-commit re-read (that read was a TOCTOU:
      // a concurrent write could change the message between commit and re-read).
      const { messageId, recipients } = sendMessage(
        from_agent_id,
        to_agent_id,
        fleet_id,
        type,
        payload,
        correlation_id
      );
      // v0.7.0: push to any active SSE subscribers
      // v0.9.0: broadcasts push to every resolved recipient
      for (const recipient of recipients) {
        notifySubscribers(recipient, [
          {
            type: "message",
            message_id: messageId,
            from_agent_id,
            payload: JSON.stringify({ type, payload }),
            timestamp: Date.now(),
          },
        ]);
      }
      return jsonResult({ message_id: messageId, recipients });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err));
    }
};

toolHandlers["send_messages"] = async (args) => {
    const { messages } = args as {
      messages: Array<{
        from_agent_id: string;
        to_agent_id: string;
        fleet_id: string;
        type: MessageType;
        payload: string;
        correlation_id?: string;
      }>;
    };
    try {
      const results = sendMessages(
        messages.map((m) => ({
          fromAgentId: m.from_agent_id,
          toAgentId: m.to_agent_id,
          fleetId: m.fleet_id,
          type: m.type,
          payload: m.payload,
          correlationId: m.correlation_id,
        }))
      );
      // Same per-recipient SSE push as send_message, after the single commit.
      results.forEach(({ messageId, recipients }, i) => {
        const src = messages[i]!;
        for (const recipient of recipients) {
          notifySubscribers(recipient, [
            {
              type: "message",
              message_id: messageId,
              from_agent_id: src.from_agent_id,
              payload: JSON.stringify({ type: src.type, payload: src.payload }),
              timestamp: Date.now(),
            },
          ]);
        }
      });
      return jsonResult({
        results: results.map((r) => ({ message_id: r.messageId, recipients: r.recipients })),
      });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err));
    }
};

toolHandlers["get_inbox"] = async (args) => {
    const { agent_id, since } = args as {
      agent_id: string;
      since?: number;
    };
    return jsonResult({ messages: getInbox(agent_id, since) });
};

toolHandlers["ack_message"] = async (args) => {
    const { agent_id, message_id } = args as {
      agent_id: string;
      message_id: string;
    };
    return jsonResult({ ok: ackMessage(agent_id, message_id) });
};

toolHandlers["receipt"] = async (args) => {
    const { agent_id, message_id, action, note } = args as {
      agent_id: string;
      message_id: string;
      action: string;
      note?: string;
    };
    if (action === "ack") {
      return jsonError("Use ack_message to consume a message; receipt is for non-consuming actions");
    }
    const receipt = writeReceipt(agent_id, message_id, action, note);
    if (!receipt) return jsonError(`No such message: ${message_id}`);
    return jsonResult({ receipt });
};

toolHandlers["get_receipts"] = async (args) => {
    const { message_id } = args as { message_id: string };
    return jsonResult({ receipts: getReceipts(message_id) });
};

toolHandlers["verify_ledger"] = async () => {
    return jsonResult(verifyLedger());
};

toolHandlers["open_ratification"] = async (args) => {
    const a = args as {
      proposer: string;
      fleet_id: string;
      subject: string;
      payload?: string;
      quorum: number;
      voters?: string[];
      required_signoffs?: string[];
      deadline?: number;
      silence_policy?: "abstain" | "approve";
      weights?: Record<string, number>;
    };
    try {
      const messageId = openRatification({
        proposer: a.proposer,
        fleetId: a.fleet_id,
        subject: a.subject,
        payload: a.payload,
        quorum: a.quorum,
        voters: a.voters,
        requiredSignoffs: a.required_signoffs,
        deadline: a.deadline,
        silencePolicy: a.silence_policy,
        weights: a.weights,
      });
      return jsonResult({ message_id: messageId, tally: tallyRatification(messageId) });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err));
    }
};

toolHandlers["cast_vote"] = async (args) => {
    const { agent_id, message_id, approve, note } = args as {
      agent_id: string;
      message_id: string;
      approve: boolean;
      note?: string;
    };
    try {
      const ok = castVote(agent_id, message_id, approve, note);
      if (!ok) return jsonError(`No such ratification: ${message_id}`);
      return jsonResult({ ok, status: resolveRatification(message_id), tally: tallyRatification(message_id) });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err));
    }
};

toolHandlers["tally_ratification"] = async (args) => {
    const { message_id } = args as { message_id: string };
    const status = resolveRatification(message_id);
    if (status === null) return jsonError(`No such ratification: ${message_id}`);
    return jsonResult({ status, tally: tallyRatification(message_id) });
};

toolHandlers["sweep_ratifications"] = async (args) => {
    return jsonResult(sweepRatifications());
};

toolHandlers["register_capability"] = async (args) => {
    // The wire schema is snake_case; CapabilityInput is camelCase. This handler
    // used to pass `args` straight through with a cast, so `agent_id`,
    // `fleet_id` and `context_window` all arrived undefined while `role`,
    // `skills` and `model` — which happen to share a spelling — came through
    // fine. The call then returned {ok:true} having written a row keyed
    // "undefined". Destructure explicitly, exactly like every sibling handler.
    const { agent_id, fleet_id, role, skills, model, context_window } = args as {
      agent_id: string;
      fleet_id: string;
      role: string;
      skills: string[];
      model?: string;
      context_window?: number;
    };
    registerCapability({
      agentId: agent_id,
      fleetId: fleet_id,
      role,
      skills,
      model,
      contextWindow: context_window,
    });
    return jsonResult({ ok: true, agent_id, fleet_id });
};

toolHandlers["route_work"] = async (args) => {
    const { description, top_n } = args as { description: string; top_n?: number };
    return jsonResult({ matches: routeWork(description, top_n ?? 1) });
};

toolHandlers["record_routing_outcome"] = async (args) => {
    const { agent_id, capability_key, success } = args as {
      agent_id: string;
      capability_key: string;
      success: boolean;
    };
    recordRoutingOutcome(agent_id, capability_key, success);
    return jsonResult({ ok: true, agent_id, capability_key, success });
};

toolHandlers["list_agents"] = async (args) => {
    const agents = discoverPremadeAgents();
    return jsonResult({ count: agents.length, agents });
};

toolHandlers["attach_agent"] = async (args) => {
    const { fleet_id, role, prompt, agent } = args as {
      fleet_id: string;
      role: string;
      prompt: string;
      agent?: string;
    };
    const agentId = randomUUID();
    let lifecycleMode;
    try {
      lifecycleMode = lifecycleCoordinator.modeForFleet(fleet_id);
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err));
    }
    if (lifecycleMode === "durable") {
      const check = lifecycleCoordinator.attachAgent({ fleetId: fleet_id, agentId, role, prompt, agentFile: agent });
      if (check.error) return jsonError(check.error);
      if (agent) autoRegisterFromAgent(agentId, fleet_id, agent);
      return jsonResult({ agent_id: agentId, fleet_id, role, agent_file: agent ?? null, message: `Agent ${role} attached to fleet ${fleet_id}` });
    }
    // Re-check exists && running INSIDE the txn and pre-register the row in the
    // same transaction. Checking outside (as before) let a concurrent
    // checkFleetCompletion flip the fleet to complete between check and write —
    // a live agent attached to a dead fleet (the red-team's exact case).
    const check = withLedger((data): { error?: string } => {
      const fleet = data.fleets[fleet_id];
      if (!fleet) return { error: `Fleet ${fleet_id} not found` };
      if (fleet.status !== "running") {
        return { error: `Fleet ${fleet_id} is ${fleet.status}, not running` };
      }
      _registerAgent(data, {
        id: agentId,
        fleet_id,
        role,
        prompt,
        agent_file: agent,
        status: "running",
        started_at: Date.now(),
      });
      return {};
    });
    if (check.error) return jsonError(check.error);

    // Spawn after commit; capability auto-register is its own txn.
    trySpawn({ fleetId: fleet_id, role, prompt, agentFile: agent }, agentId, 1);
    if (agent) autoRegisterFromAgent(agentId, fleet_id, agent);

    return jsonResult({
      agent_id: agentId,
      fleet_id,
      role,
      agent_file: agent ?? null,
      message: `Agent ${role} attached to fleet ${fleet_id}`,
    });
};

toolHandlers["ping"] = async (args) => {
    return jsonResult(ping());
};

toolHandlers["get_health"] = async (args) => {
    return jsonResult(getHealth());
};

toolHandlers["subscribe_inbox"] = async (args) => {
    const { agent_id } = args as { agent_id: string };
    const data = readLedger();
    if (!data.agents[agent_id]) {
      return jsonError(`Agent "${agent_id}" not found`);
    }
    const streamUrl = subscribeInboxUrl(agent_id);
    return jsonResult({
      agent_id,
      stream_url: streamUrl,
      instructions:
        "Open an HTTP GET to the stream_url. Each event is SSE-formatted: `event: <type>\\ndata: <json>\\n\\n`. Use polling get_inbox as a fallback if SSE is unreachable.",
    });
};

toolHandlers["save_fleet_template"] = async (args) => {
    const { name: tplName, description, agents } = args as {
      name: string
      description?: string
      agents: TemplateAgent[]
    };
    try {
      const tpl = saveFleetTemplateFn(tplName, agents, description ?? "");
      return jsonResult({ template: tpl });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err));
    }
};

toolHandlers["list_fleet_templates"] = async (args) => {
    return jsonResult({ templates: listFleetTemplatesFn() });
};

toolHandlers["spawn_from_template"] = async (args) => {
    const { name: tplName } = args as { name: string };
    const spec = spawnFromTemplateFn(tplName);
    if (!spec) {
      return jsonError(`Template "${tplName}" not found`);
    }
    return jsonResult({ spec });
};

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const handler = toolHandlers[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return await handler(args);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

// A nested instance booted by a spawned agent's own opencode session
// (spawn env sets AGENT_MESH_CHILD=1). It shares the parent's ledger, so it
// must not run startup recovery (it would flip the parent's live agents),
// must not bind the SSE port the parent already holds, and must not run a
// competing ratification sweeper.
const isChildInstance = process.env.AGENT_MESH_CHILD === "1";

if (!isChildInstance) {
  // Phase 2: one-shot JSON→SQLite migration. Stop-the-world, parent-only, BEFORE
  // any ledger read/write — a fresh getDb() would otherwise create an empty db
  // and strand the JSON. Fails-closed: a validation mismatch aborts startup with
  // the JSON left authoritative (never run on a partial/empty ledger).
  try {
    const migration = migrateJsonToSqlite();
    if (migration.migrated) {
      console.error(
        `Agent Mesh v${MESH_VERSION} — migrated ${migration.rowCount} ledger entr${migration.rowCount === 1 ? "y" : "ies"} JSON→SQLite; JSON backed up to ${migration.backupPath}`
      );
    } else if (migration.refused) {
      // A migration that could have run and was declined must SAY SO. Otherwise
      // someone who legitimately relocated their db sees an empty ledger with no
      // explanation — the silent-skip failure mode is nearly as bad as the
      // silent-consume one it replaces. The ordinary no-ops stay quiet.
      console.error(`Agent Mesh v${MESH_VERSION} — ledger migration SKIPPED: ${migration.reason}`);
    }
  } catch (err) {
    console.error(`Agent Mesh v${MESH_VERSION} — FATAL: ${err instanceof Error ? err.message : String(err)}`);
    throw err; // fail-closed
  }

  // v0.7.x: recover any agents left in 'running' state from a previous
  // crashed process so fleet_status reflects reality. Liveness-probed since
  // 2026-07-03 — only agents with a missing/dead pid are flipped.
  repairLifecycleOutbox();
  lifecycleCoordinator.recover();
  const recoveredCount = recoverInterruptedAgents();
  if (recoveredCount > 0) {
    console.error(`Agent Mesh v${MESH_VERSION} — recovered ${recoveredCount} interrupted agent(s) from previous run`);
  }

  // v0.11: periodic ratification deadline sweep (0 disables)
  const sweepMs = Number(resolveEnv(process.env, "MESHFLEET_RATIFY_SWEEP_MS", "AGENT_MESH_RATIFY_SWEEP_MS") ?? 60_000);
  if (Number.isFinite(sweepMs) && sweepMs > 0) {
    const sweeper = setInterval(() => {
      try {
        const { resolved } = sweepRatifications();
        for (const [id, status] of Object.entries(resolved)) {
          appendEvent("ratification_resolved", { message_id: id, status, via: "sweep" });
        }
      } catch {
        // sweep must never take the server down
      }
    }, sweepMs);
    sweeper.unref();
  }

  // Start the SSE HTTP server for real-time inbox push (v0.7.0)
  try {
    const { host, port } = await startSseServer();
    console.error(`Agent Mesh v${MESH_VERSION} started (JSON persistence + P2P messaging + capability routing + premade agent discovery + timeout/resilience + SSE push on ${host}:${port})`);
  } catch (err) {
    console.error(`Agent Mesh v${MESH_VERSION} started (JSON persistence + P2P messaging + capability routing + premade agent discovery + timeout/resilience + SSE push) — SSE server failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }
} else {
  console.error("Agent Mesh started in child mode (AGENT_MESH_CHILD=1) — recovery, sweeper, and SSE skipped");
}
