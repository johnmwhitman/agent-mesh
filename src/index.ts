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
  autoRegisterFromAgent,
  checkFleetCompletion,
  createFleet,
  discoverPremadeAgents,
  getFleetTimeoutMs,
  listFleets,
  loadData,
  markAgentFinished,
  MAX_PAYLOAD_BYTES,
  MESSAGE_TYPES,
  MessageType,
  registerAgentInLedger,
  registerCapability,
  routeWork,
  sendMessage,
  getInbox,
  ackMessage,
  setFleetTimeout,
} from "./core.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

function agentTimeoutMs(): number {
  const configured = Number(process.env.AGENT_MESH_AGENT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_AGENT_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "agent-mesh", version: "0.4.0" },
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

  const runArgs: string[] = ["run"];
  if (input.agentFile) runArgs.push("--agent", input.agentFile);
  runArgs.push(input.prompt);

  const child = spawn("opencode", runArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  if (child.pid !== undefined) {
    const data = loadData();
    if (data.agents[agentId]) {
      data.agents[agentId].pid = child.pid;
      const { saveData } = await import("./core.js");
      saveData(data);
    }
  }

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));

  const timeout = setTimeout(() => {
    if (!child.killed) child.kill("SIGTERM");
    markAgentFinished(
      agentId,
      "failed",
      stdout,
      `Timed out after ${agentTimeoutMs()}ms${stderr ? `\n${stderr}` : ""}`
    );
  }, agentTimeoutMs());

  child.on("error", (err: Error) => {
    clearTimeout(timeout);
    markAgentFinished(agentId, "failed", stdout, err.message);
  });

  child.on("close", (code: number | null) => {
    clearTimeout(timeout);
    markAgentFinished(
      agentId,
      code === 0 ? "complete" : "failed",
      stdout,
      stderr || undefined
    );
  });

  return agentId;
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
    const { fleet_id } = args as { fleet_id: string };
    const data = loadData();
    const fleet = data.fleets[fleet_id];
    const agents = Object.values(data.agents).filter(
      (a) => a.fleet_id === fleet_id
    );
    return jsonResult({ fleet, agents });
  }

  if (name === "list_fleets") {
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

  throw new Error(`Unknown tool: ${name}`);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  "Agent Mesh v0.3.0 started (JSON persistence + P2P messaging + capability routing + premade agent discovery + timeout/resilience)"
);
