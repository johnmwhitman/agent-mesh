import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, basename, extname } from "path";
import { homedir } from "os";

// Persistence via JSON file
const dataDir = join(homedir(), ".config/opencode");
const dataFile = join(dataDir, "agent-mesh.json");

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

// ---------------------------------------------------------------------------
// Data Models
// ---------------------------------------------------------------------------

interface Agent {
  id: string;
  fleet_id: string;
  role: string;
  prompt: string;
  agent_file?: string; // premade agent filename stem (e.g. "frontend-developer")
  status: "pending" | "running" | "complete" | "failed";
  output?: string;
  error?: string;
  started_at?: number;
  completed_at?: number;
}

interface Fleet {
  id: string;
  status: "pending" | "running" | "complete" | "failed";
  created_at: number;
  completed_at?: number;
}

type MessageType = "handoff" | "question" | "result" | "alert" | "request_help";

interface Message {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  fleet_id: string;
  type: MessageType;
  payload: string;
  correlation_id?: string;
  timestamp: number;
  acknowledged: boolean;
}

interface Capability {
  agent_id: string;
  fleet_id: string;
  role: string;
  skills: string[];
  model?: string;
  context_window?: number;
  registered_at: number;
}

interface MeshData {
  fleets: Record<string, Fleet>;
  agents: Record<string, Agent>;
  messages: Record<string, Message>;
  inboxes: Record<string, string[]>; // agent_id -> array of message_ids
  capabilities: Record<string, Capability>;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const EMPTY_DATA: MeshData = {
  fleets: {},
  agents: {},
  messages: {},
  inboxes: {},
  capabilities: {},
};

function loadData(): MeshData {
  if (!existsSync(dataFile)) {
    return { ...EMPTY_DATA };
  }
  const raw = JSON.parse(readFileSync(dataFile, "utf-8"));
  return {
    fleets: raw.fleets || {},
    agents: raw.agents || {},
    messages: raw.messages || {},
    inboxes: raw.inboxes || {},
    capabilities: raw.capabilities || {},
  };
}

function saveData(data: MeshData) {
  writeFileSync(dataFile, JSON.stringify(data, null, 2));
}

interface PremadeAgent {
  filename: string;   // stem without .md (e.g. "frontend-developer")
  name: string;       // frontmatter "name" field
  description: string; // frontmatter "description" field
  mode: string;       // frontmatter "mode" field
}

// ---------------------------------------------------------------------------
// Premade Agent Discovery
// ---------------------------------------------------------------------------

function discoverPremadeAgents(): PremadeAgent[] {
  // Search both project-level and global agent directories
  const searchDirs = [
    join(process.cwd(), ".opencode", "agents"),
    join(homedir(), ".config", "opencode", "agents"),
  ];

  const agents: PremadeAgent[] = [];
  const seen = new Set<string>();

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const stem = basename(file, extname(file));
      if (seen.has(stem)) continue;
      seen.add(stem);

      try {
        const content = readFileSync(join(dir, file), "utf-8");
        // Parse YAML frontmatter (simple — not a full YAML parser)
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;

        const fm = fmMatch[1];
        const nameMatch = fm.match(/^name:\s*(.+)$/m);
        const descMatch = fm.match(/^description:\s*(.+)$/m);
        const modeMatch = fm.match(/^mode:\s*(.+)$/m);

        agents.push({
          filename: stem,
          name: nameMatch ? nameMatch[1].trim() : stem,
          description: descMatch ? descMatch[1].trim() : "",
          mode: modeMatch ? modeMatch[1].trim() : "subagent",
        });
      } catch {
        // Skip unreadable files
      }
    }
  }

  return agents;
}

function extractSkillsFromDescription(description: string): string[] {
  // Extract meaningful keywords from the agent description for capability routing
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "for", "with", "in", "on", "to", "of",
    "is", "are", "who", "that", "this", "expert", "specialist", "specializing",
    "provides", "providing", "focused", "focuses", "including", "includes",
    "across", "between", "from", "by", "as", "at", "via", "into", "their",
    "not", "but", "than", "then", "so", "if", "when", "while", "be", "been",
    "has", "have", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "must", "shall", "you", "your",
  ]);

  return description
    .toLowerCase()
    .split(/[\s,;.!?()/:]+/)
    .filter((w) => w.length > 2 && !stopWords.has(w))
    .slice(0, 15); // cap at 15 skills to keep ledger lean
}

const server = new Server(
  { name: "agent-mesh", version: "0.3.0" },
  { capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------
// Agent Lifecycle
// ---------------------------------------------------------------------------

async function spawnAgent(
  fleetId: string,
  role: string,
  prompt: string,
  agentFile?: string
): Promise<string> {
  const agentId = randomUUID();
  const data = loadData();

  data.agents[agentId] = {
    id: agentId,
    fleet_id: fleetId,
    role,
    prompt,
    agent_file: agentFile,
    status: "running",
    started_at: Date.now(),
  };
  // Initialize inbox for this agent
  if (!data.inboxes[agentId]) data.inboxes[agentId] = [];
  saveData(data);

  // Build the opencode run command — pass --agent if a premade agent is specified
  const runArgs: string[] = ["run"];
  if (agentFile) {
    runArgs.push("--agent", agentFile);
  }
  runArgs.push(prompt);

  const child = spawn("opencode", runArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));

  child.on("close", (code) => {
    const d = loadData();
    d.agents[agentId].status = code === 0 ? "complete" : "failed";
    d.agents[agentId].output = stdout;
    d.agents[agentId].error = stderr || undefined;
    d.agents[agentId].completed_at = Date.now();
    saveData(d);
    checkFleetCompletion(fleetId);
  });

  return agentId;
}

function checkFleetCompletion(fleetId: string) {
  const data = loadData();
  const agents = Object.values(data.agents).filter(
    (a) => a.fleet_id === fleetId
  );
  const allDone = agents.every(
    (a) => a.status === "complete" || a.status === "failed"
  );

  if (allDone && data.fleets[fleetId]) {
    const hasFail = agents.some((a) => a.status === "failed");
    data.fleets[fleetId].status = hasFail ? "failed" : "complete";
    data.fleets[fleetId].completed_at = Date.now();
    saveData(data);
  }
}

// ---------------------------------------------------------------------------
// P2P Message Bus
// ---------------------------------------------------------------------------

const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB

function sendMessage(
  fromAgentId: string,
  toAgentId: string,
  fleetId: string,
  type: MessageType,
  payload: string,
  correlationId?: string
): string {
  // Enforce payload size limit
  if (Buffer.byteLength(payload, "utf-8") > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `Payload too large: ${Buffer.byteLength(payload)} bytes (limit ${MAX_PAYLOAD_BYTES})`
    );
  }

  const messageId = randomUUID();
  const data = loadData();

  const message: Message = {
    id: messageId,
    from_agent_id: fromAgentId,
    to_agent_id: toAgentId,
    fleet_id: fleetId,
    type,
    payload,
    correlation_id: correlationId,
    timestamp: Date.now(),
    acknowledged: false,
  };

  data.messages[messageId] = message;

  // Append to recipient's inbox
  if (!data.inboxes[toAgentId]) data.inboxes[toAgentId] = [];
  data.inboxes[toAgentId].push(messageId);

  saveData(data);
  return messageId;
}

function getInbox(
  agentId: string,
  since?: number
): Message[] {
  const data = loadData();
  const inboxIds = data.inboxes[agentId] || [];
  const messages = inboxIds
    .map((id) => data.messages[id])
    .filter((m) => m !== undefined);
  if (since !== undefined) {
    return messages.filter((m) => m.timestamp > since);
  }
  return messages;
}

function ackMessage(agentId: string, messageId: string): boolean {
  const data = loadData();
  const msg = data.messages[messageId];
  if (!msg) return false; // idempotent no-op for non-existent message
  msg.acknowledged = true;
  // Remove from inbox
  if (data.inboxes[agentId]) {
    data.inboxes[agentId] = data.inboxes[agentId].filter(
      (id) => id !== messageId
    );
  }
  saveData(data);
  return true;
}

// ---------------------------------------------------------------------------
// Capability Registry
// ---------------------------------------------------------------------------

function registerCapability(
  agentId: string,
  fleetId: string,
  role: string,
  skills: string[],
  model?: string,
  contextWindow?: number
): void {
  const data = loadData();
  data.capabilities[agentId] = {
    agent_id: agentId,
    fleet_id: fleetId,
    role,
    skills,
    model,
    context_window: contextWindow,
    registered_at: Date.now(),
  };
  saveData(data);
}

function routeWork(description: string): Array<{ agent_id: string; score: number; role: string }> {
  const data = loadData();
  const caps = Object.values(data.capabilities);
  if (caps.length === 0) return [];

  // Tokenize the work description into lowercase keywords
  const keywords = description
    .toLowerCase()
    .split(/[\s,;.!?()/]+/)
    .filter((k) => k.length > 1);

  if (keywords.length === 0) return [];

  const scored = caps.map((cap) => {
    const roleLower = cap.role.toLowerCase();
    const skillsLower = cap.skills.map((s) => s.toLowerCase());
    let matches = 0;
    for (const kw of keywords) {
      if (roleLower.includes(kw)) matches++;
      for (const sk of skillsLower) {
        if (sk.includes(kw)) {
          matches++;
          break; // count keyword once per skill match
        }
      }
    }
    const score = matches / keywords.length;
    return { agent_id: cap.agent_id, score, role: cap.role };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "spawn_fleet",
      description: "Spawn parallel agents. Returns fleet_id. Each agent can optionally specify a 'agent' field to use a premade agent definition from .opencode/agents/.",
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
                  description: "Premade agent filename stem (e.g. 'frontend-developer', 'code-reviewer'). See list_agents for available agents.",
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
          type: {
            type: "string",
            enum: ["handoff", "question", "result", "alert", "request_help"],
          },
          payload: { type: "string" },
          correlation_id: { type: "string" },
        },
        required: ["from_agent_id", "to_agent_id", "fleet_id", "type", "payload"],
      },
    },
    {
      name: "get_inbox",
      description: "Get messages in an agent's inbox, optionally since a timestamp.",
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
      description: "Acknowledge a message, removing it from the agent's inbox.",
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
          skills: {
            type: "array",
            items: { type: "string" },
          },
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
        properties: {
          description: { type: "string" },
        },
        required: ["description"],
      },
    },
    {
      name: "list_agents",
      description:
        "List all available premade agents from .opencode/agents/ directories. Returns filename, name, description, and mode for each.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "attach_agent",
      description:
        "Dynamically attach a premade agent to an existing running fleet. The agent joins mid-flight and can participate in P2P messaging.",
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

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  // --- spawn_fleet ---
  if (name === "spawn_fleet") {
    const { agents } = args as { agents: { role: string; prompt: string; agent?: string }[] };
    const data = loadData();
    const fleetId = randomUUID();

    data.fleets[fleetId] = {
      id: fleetId,
      status: "running",
      created_at: Date.now(),
    };
    saveData(data);

    const ids: string[] = [];
    for (const a of agents) {
      const id = await spawnAgent(fleetId, a.role, a.prompt, a.agent);
      ids.push(id);

      // Auto-register capability if a premade agent file was specified
      if (a.agent) {
        const premade = discoverPremadeAgents().find((p) => p.filename === a.agent);
        if (premade) {
          const skills = extractSkillsFromDescription(premade.description);
          registerCapability(id, fleetId, premade.name, skills);
        }
      }
    }

    return {
      content: [
        { type: "text", text: JSON.stringify({ fleet_id: fleetId, agent_ids: ids }) },
      ],
    };
  }

  // --- fleet_status ---
  if (name === "fleet_status") {
    const { fleet_id } = args as { fleet_id: string };
    const data = loadData();
    const fleet = data.fleets[fleet_id];
    const agents = Object.values(data.agents).filter(
      (a) => a.fleet_id === fleet_id
    );
    return { content: [{ type: "text", text: JSON.stringify({ fleet, agents }) }] };
  }

  // --- collect_results ---
  if (name === "collect_results") {
    const { fleet_id } = args as { fleet_id: string };
    const data = loadData();
    const agents = Object.values(data.agents).filter(
      (a) => a.fleet_id === fleet_id
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            fleet_id,
            results: agents.map((a) => ({
              role: a.role,
              status: a.status,
              output: a.output,
              error: a.error,
            })),
          }),
        },
      ],
    };
  }

  // --- send_message ---
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
      return {
        content: [
          { type: "text", text: JSON.stringify({ message_id: messageId }) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          },
        ],
        isError: true,
      };
    }
  }

  // --- get_inbox ---
  if (name === "get_inbox") {
    const { agent_id, since } = args as {
      agent_id: string;
      since?: number;
    };
    const messages = getInbox(agent_id, since);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ messages }),
        },
      ],
    };
  }

  // --- ack_message ---
  if (name === "ack_message") {
    const { agent_id, message_id } = args as {
      agent_id: string;
      message_id: string;
    };
    const ok = ackMessage(agent_id, message_id);
    return {
      content: [{ type: "text", text: JSON.stringify({ ok }) }],
    };
  }

  // --- register_capability ---
  if (name === "register_capability") {
    const {
      agent_id,
      fleet_id,
      role,
      skills,
      model,
      context_window,
    } = args as {
      agent_id: string;
      fleet_id: string;
      role: string;
      skills: string[];
      model?: string;
      context_window?: number;
    };
    registerCapability(agent_id, fleet_id, role, skills, model, context_window);
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    };
  }

  // --- route_work ---
  if (name === "route_work") {
    const { description } = args as { description: string };
    const matches = routeWork(description);
    return {
      content: [
        { type: "text", text: JSON.stringify({ matches }) },
      ],
    };
  }

  // --- list_agents ---
  if (name === "list_agents") {
    const agents = discoverPremadeAgents();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            count: agents.length,
            agents: agents.map((a) => ({
              filename: a.filename,
              name: a.name,
              description: a.description,
              mode: a.mode,
            })),
          }),
        },
      ],
    };
  }

  // --- attach_agent ---
  if (name === "attach_agent") {
    const { fleet_id, role, prompt, agent } = args as {
      fleet_id: string;
      role: string;
      prompt: string;
      agent?: string;
    };

    // Verify fleet exists
    const data = loadData();
    if (!data.fleets[fleet_id]) {
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: `Fleet ${fleet_id} not found` }) },
        ],
        isError: true,
      };
    }

    // Fleet must still be running to attach
    if (data.fleets[fleet_id].status !== "running") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Fleet ${fleet_id} is ${data.fleets[fleet_id].status}, not running`,
            }),
          },
        ],
        isError: true,
      };
    }

    const agentId = await spawnAgent(fleet_id, role, prompt, agent);

    // Auto-register capability if premade agent specified
    if (agent) {
      const premade = discoverPremadeAgents().find((p) => p.filename === agent);
      if (premade) {
        const skills = extractSkillsFromDescription(premade.description);
        registerCapability(agentId, fleet_id, premade.name, skills);
      }
    }

    // Re-check fleet completion (attaching a new running agent keeps fleet running)
    // The fleet stays "running" because the new agent is still executing.
    // checkFleetCompletion won't mark it complete because the new agent is "running".

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            agent_id: agentId,
            fleet_id,
            role,
            agent_file: agent || null,
            message: `Agent ${role} attached to fleet ${fleet_id}`,
          }),
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Agent Mesh v0.3.0 started (JSON persistence + P2P messaging + capability routing + premade agent discovery)");