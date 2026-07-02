import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import {
  appendEvent,
  ackMessage,
  autoRegisterFromAgent,
  checkFleetCompletion,
  createFleet,
  discoverPremadeAgents,
  getFleetTimeoutMs,
  getInbox,
  listFleets,
  loadData,
  markAgentFinished,
  MAX_PAYLOAD_BYTES,
  MESSAGE_TYPES,
  MessageType,
  recoverInterruptedAgents,
  registerAgentInLedger,
  registerCapability,
  routeWork,
  saveData,
  sendMessage,
  setFleetTimeout,
} from "./core.js";
import { checkRateLimit, getHealth, ping } from "./health.js";
import {
  saveFleetTemplate as saveFleetTemplateFn,
  listFleetTemplates as listFleetTemplatesFn,
  spawnFromTemplate as spawnFromTemplateFn,
  type TemplateAgent,
} from "./templates.js";
import { notifySubscribers } from "./realtime.js";
import { startSseServer, stopSseServer, subscribeInboxUrl } from "./sse-server.js";
import { createHeartbeat } from "./heartbeat.js";
import {
  AGENT_SPAWN_STDIO,
  agentTimeoutMs,
  buildRunArgs,
} from "./spawn-config.js";
import {
  computeBackoff,
  scheduleRetry as scheduleAgentRetry,
  shouldRetry as shouldAgentRetry,
} from "./retry.js";

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "agent-mesh", version: "0.7.0" },
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

async function spawnAgent(input: SpawnAgentInput): Promise<string> {
  const agentId = randomUUID();
  registerAgentInLedger({
    id: agentId,
    fleet_id: input.fleetId,
    role: input.role,
    prompt: input.prompt,
    agent_file: input.agentFile,
    status: "running",
    started_at: Date.now(),
  });
  trySpawn(input, agentId, 1);
  return agentId;
}

/**
 * Inner spawn loop. attempt is 1-indexed (first attempt = 1).
 * On any transient failure path, decides retry vs permanent via shouldAgentRetry().
 */
function trySpawn(input: SpawnAgentInput, agentId: string, attempt: number): void {
  const child = spawn("opencode", buildRunArgs(input), {
    // stdin MUST be ignored — `opencode run` hangs forever on a piped
    // stdin. Contract + evidence documented in spawn-config.ts.
    stdio: AGENT_SPAWN_STDIO,
    env: { ...process.env },
  });

  if (child.pid !== undefined) {
    const data = loadData();
    if (data.agents[agentId]) {
      data.agents[agentId].pid = child.pid;
      saveData(data);
    }
  }

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));

  // Watchdog: auto-fail only when the child process is actually gone
  // (12 consecutive dead checks x 5s = 60s) but "close" never fired.
  // Healthy long-running agents are never killed by the watchdog.
  const heartbeat = createHeartbeat(agentId, input.fleetId, {
    intervalMs: 5_000,
    onHeartbeat: () => {},
    maxMissed: 12,
    isAlive: () => child.exitCode === null && child.signalCode === null,
    onMaxMissed: (reason: string) => {
      if (!child.killed) child.kill("SIGKILL");
      handleTransientFailure(input, agentId, attempt, stdout, `Heartbeat watchdog: ${reason}`);
    },
  });

  const timeout = setTimeout(() => {
    if (!child.killed) child.kill("SIGTERM");
    handleTransientFailure(input, agentId, attempt, stdout, `Timed out after ${agentTimeoutMs()}ms${stderr ? `\n${stderr}` : ""}`);
  }, agentTimeoutMs());

  child.on("error", (err: Error) => {
    clearTimeout(timeout);
    heartbeat.stop();
    handleTransientFailure(input, agentId, attempt, stdout, err.message);
  });

  child.on("close", (code: number | null) => {
    clearTimeout(timeout);
    heartbeat.stop();
    if (code === 0) {
      // Clean success — never retry.
      markAgentFinished(agentId, "complete", stdout, stderr || undefined);
      return;
    }
    // Non-zero exit = transient failure.
    handleTransientFailure(
      input,
      agentId,
      attempt,
      stdout,
      stderr || `exit code ${code}`
    );
  });
}

function handleTransientFailure(
  input: SpawnAgentInput,
  agentId: string,
  attempt: number,
  stdout: string,
  errorDetail: string
): void {
  if (!shouldAgentRetry(attempt)) {
    appendEvent("agent_failed_permanent", {
      agent_id: agentId,
      attempts: attempt,
      last_error: errorDetail,
      timestamp: Date.now(),
    });
    markAgentFinished(
      agentId,
      "failed",
      stdout,
      `Permanent failure after ${attempt} attempt(s). Last error: ${errorDetail}`
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
    last_error: errorDetail,
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
        "Send a P2P message from one agent to another within the same fleet.",
      inputSchema: {
        type: "object",
        properties: {
          from_agent_id: { type: "string" },
          to_agent_id: { type: "string" },
          fleet_id: { type: "string" },
          type: { type: "string", enum: [...MESSAGE_TYPES] },
          payload: { type: "string" },
          correlation_id: { type: "string" },
        },
        required: ["from_agent_id", "to_agent_id", "fleet_id", "type", "payload"],
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
        "Acknowledge a message, removing it from the agent's inbox.",
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
        "Route a work description to the best-matching registered agents by keyword + role overlap scoring.",
      inputSchema: {
        type: "object",
        properties: { description: { type: "string" } },
        required: ["description"],
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
        "Subscribe to an agent's inbox via Server-Sent Events (SSE). Returns a stream URL that the agent opens to receive real-time push of incoming P2P messages. Falls back to polling get_inbox if SSE is unreachable.",
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

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "spawn_fleet") {
    const { agents } = args as { agents: { role: string; prompt: string; agent?: string }[] };
    const fleetId = randomUUID();
    createFleet(fleetId);
    appendEvent("spawn_fleet_called", { fleet_id: fleetId, agent_count: agents.length });

    const ids: string[] = [];
    for (const a of agents) {
      const id = await spawnAgent({
        fleetId,
        role: a.role,
        prompt: a.prompt,
        agentFile: a.agent,
      });
      ids.push(id);
      appendEvent("agent_spawned", { fleet_id: fleetId, agent_id: id, role: a.role, agent_file: a.agent });
      if (a.agent) autoRegisterFromAgent(id, fleetId, a.agent);
    }

    return jsonResult({ fleet_id: fleetId, agent_ids: ids });
  }

  if (name === "fleet_status") {
    const ip = "global"; // no IP extraction yet; use single bucket
    if (!checkRateLimit(ip, "read")) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Read rate limit exceeded. Slow down." }) }], isError: true };
    }
    const { fleet_id } = args as { fleet_id: string };
    const data = loadData();
    const fleet = data.fleets[fleet_id];
    const agents = Object.values(data.agents).filter(
      (a) => a.fleet_id === fleet_id
    );
    return jsonResult({ fleet, agents });
  }

  if (name === "list_fleets") {
    const ip = "global";
    if (!checkRateLimit(ip, "read")) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Read rate limit exceeded." }) }], isError: true };
    }
    return jsonResult({ fleets: listFleets() });
  }

  if (name === "set_fleet_timeout") {
    const { fleet_id, timeout_ms } = args as { fleet_id: string; timeout_ms: number };
    try {
      setFleetTimeout(fleet_id, timeout_ms);
      appendEvent("fleet_timeout_set", { fleet_id, timeout_ms });
      return jsonResult({ ok: true, timeout_ms: getFleetTimeoutMs(fleet_id) });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err));
    }
  }

  if (name === "collect_results") {
    const { fleet_id } = args as { fleet_id: string };
    const data = loadData();
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
  }

  if (name === "send_message") {
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
      const messageId = sendMessage(
        from_agent_id,
        to_agent_id,
        fleet_id,
        type,
        payload,
        correlation_id
      );
      // v0.7.0: push to any active SSE subscribers
      notifySubscribers(to_agent_id, [
        {
          type: "message",
          message_id: messageId,
          from_agent_id,
          payload: JSON.stringify({ type, payload }),
          timestamp: Date.now(),
        },
      ]);
      return jsonResult({ message_id: messageId });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err));
    }
  }

  if (name === "get_inbox") {
    const { agent_id, since } = args as {
      agent_id: string;
      since?: number;
    };
    return jsonResult({ messages: getInbox(agent_id, since) });
  }

  if (name === "ack_message") {
    const { agent_id, message_id } = args as {
      agent_id: string;
      message_id: string;
    };
    return jsonResult({ ok: ackMessage(agent_id, message_id) });
  }

  if (name === "register_capability") {
    registerCapability(args as Parameters<typeof registerCapability>[0]);
    return jsonResult({ ok: true });
  }

  if (name === "route_work") {
    const { description } = args as { description: string };
    return jsonResult({ matches: routeWork(description) });
  }

  if (name === "list_agents") {
    const agents = discoverPremadeAgents();
    return jsonResult({ count: agents.length, agents });
  }

  if (name === "attach_agent") {
    const { fleet_id, role, prompt, agent } = args as {
      fleet_id: string;
      role: string;
      prompt: string;
      agent?: string;
    };
    const data = loadData();
    if (!data.fleets[fleet_id]) {
      return jsonError(`Fleet ${fleet_id} not found`);
    }
    if (data.fleets[fleet_id].status !== "running") {
      return jsonError(
        `Fleet ${fleet_id} is ${data.fleets[fleet_id].status}, not running`
      );
    }

    const agentId = await spawnAgent({ fleetId: fleet_id, role, prompt, agentFile: agent });
    if (agent) autoRegisterFromAgent(agentId, fleet_id, agent);

    return jsonResult({
      agent_id: agentId,
      fleet_id,
      role,
      agent_file: agent ?? null,
      message: `Agent ${role} attached to fleet ${fleet_id}`,
    });
  }

  if (name === "ping") {
    return jsonResult(ping());
  }

  if (name === "get_health") {
    return jsonResult(getHealth());
  }

  if (name === "subscribe_inbox") {
    const { agent_id } = args as { agent_id: string };
    const data = loadData();
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
  }

  if (name === "save_fleet_template") {
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
  }

  if (name === "list_fleet_templates") {
    return jsonResult({ templates: listFleetTemplatesFn() });
  }

  if (name === "spawn_from_template") {
    const { name: tplName } = args as { name: string };
    const spec = spawnFromTemplateFn(tplName);
    if (!spec) {
      return jsonError(`Template "${tplName}" not found`);
    }
    return jsonResult({ spec });
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

// v0.7.x: recover any agents left in 'running' state from a previous
// crashed process so fleet_status reflects reality.
const recoveredCount = recoverInterruptedAgents();
if (recoveredCount > 0) {
  console.error(`Agent Mesh v0.7.0 — recovered ${recoveredCount} interrupted agent(s) from previous run`);
}

// Start the SSE HTTP server for real-time inbox push (v0.7.0)
try {
  const { host, port } = await startSseServer();
  console.error(`Agent Mesh v0.7.0 started (JSON persistence + P2P messaging + capability routing + premade agent discovery + timeout/resilience + SSE push on ${host}:${port})`);
} catch (err) {
  console.error(`Agent Mesh v0.7.0 started (JSON persistence + P2P messaging + capability routing + premade agent discovery + timeout/resilience + SSE push) — SSE server failed to start: ${err instanceof Error ? err.message : String(err)}`);
}
