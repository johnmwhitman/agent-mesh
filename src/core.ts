import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join, basename, extname } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Data Models
// ---------------------------------------------------------------------------

export interface Agent {
  id: string;
  fleet_id: string;
  role: string;
  prompt: string;
  agent_file?: string;
  pid?: number;
  status: "pending" | "running" | "complete" | "failed";
  output?: string;
  error?: string;
  started_at?: number;
  completed_at?: number;
}

export interface Fleet {
  id: string;
  status: "pending" | "running" | "complete" | "failed";
  created_at: number;
  completed_at?: number;
}

export const MESSAGE_TYPES = [
  "handoff",
  "question",
  "result",
  "alert",
  "request_help",
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

export interface Message {
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

export interface Capability {
  agent_id: string;
  fleet_id: string;
  role: string;
  skills: string[];
  model?: string;
  context_window?: number;
  registered_at: number;
}

export interface MeshData {
  fleets: Record<string, Fleet>;
  agents: Record<string, Agent>;
  messages: Record<string, Message>;
  inboxes: Record<string, string[]>;
  capabilities: Record<string, Capability>;
}

export interface PremadeAgent {
  filename: string;
  name: string;
  description: string;
  mode: string;
}

export interface RouteMatch {
  agent_id: string;
  score: number;
  role: string;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const DEFAULT_DATA_DIR = join(homedir(), ".config/opencode");
const DEFAULT_DATA_FILE = join(DEFAULT_DATA_DIR, "agent-mesh.json");

const EMPTY_DATA: MeshData = {
  fleets: {},
  agents: {},
  messages: {},
  inboxes: {},
  capabilities: {},
};

let dataDir = DEFAULT_DATA_DIR;
let dataFile = DEFAULT_DATA_FILE;

function ensureDataDir(): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
}

export function setLedgerPath(dir: string, file: string): void {
  dataDir = dir;
  dataFile = file;
  ensureDataDir();
}

// Override primitives for test isolation
let loadOverride: ((() => MeshData) | null) = null;
let saveOverride: ((d: MeshData) => void) | null = null;

export function setLedgerOverride(
  load: (() => MeshData) | null,
  save: ((d: MeshData) => void) | null
): void {
  loadOverride = load;
  saveOverride = save;
}

export function loadData(): MeshData {
  if (loadOverride) return loadOverride();
  return loadDataFromFile(resolveDataFile());
}

export function saveData(data: MeshData): void {
  if (saveOverride) return saveOverride(data);
  saveDataToFile(data, resolveDataFile(), resolveDataDir());
}

export function resolveDataFile(): string {
  return process.env.AGENT_MESH_DATA_FILE || dataFile;
}

export function resolveDataDir(): string {
  return process.env.AGENT_MESH_DATA_DIR || dataDir;
}

export function loadDataFromFile(file: string): MeshData {
  if (!existsSync(file)) return { ...EMPTY_DATA };
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    return {
      fleets: raw.fleets || {},
      agents: raw.agents || {},
      messages: raw.messages || {},
      inboxes: raw.inboxes || {},
      capabilities: raw.capabilities || {},
    };
  } catch (err) {
    console.error(`Agent Mesh: ledger corrupted at ${file}, resetting. Error: ${err}`);
    return { ...EMPTY_DATA };
  }
}

export function saveDataToFile(data: MeshData, file: string, dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Premade Agent Discovery
// ---------------------------------------------------------------------------

export function discoverPremadeAgents(
  searchDirs: readonly string[] = [
    join(process.cwd(), ".opencode", "agents"),
    join(homedir(), ".config", "opencode", "agents"),
  ]
): PremadeAgent[] {
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
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;

        const fm = fmMatch[1];
        if (!fm) continue;
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
        // skip unreadable files
      }
    }
  }

  return agents;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "in", "on", "to", "of",
  "is", "are", "who", "that", "this", "expert", "specialist", "specializing",
  "provides", "providing", "focused", "focuses", "including", "includes",
  "across", "between", "from", "by", "as", "at", "via", "into", "their",
  "not", "but", "than", "then", "so", "if", "when", "while", "be", "been",
  "has", "have", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "must", "shall", "you", "your",
]);

export function extractSkillsFromDescription(description: string): string[] {
  return description
    .toLowerCase()
    .split(/[\s,;.!?()/:]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 15);
}

// ---------------------------------------------------------------------------
// Fleet Operations
// ---------------------------------------------------------------------------

export function createFleet(fleetId: string): Fleet {
  const data = loadData();
  const fleet: Fleet = {
    id: fleetId,
    status: "running",
    created_at: Date.now(),
  };
  data.fleets[fleetId] = fleet;
  saveData(data);
  return fleet;
}

export function checkFleetCompletion(fleetId: string): void {
  const data = loadData();
  const agents = Object.values(data.agents).filter(
    (a) => a.fleet_id === fleetId
  );
  const allDone = agents.every(
    (a) => a.status === "complete" || a.status === "failed"
  );

  if (allDone && data.fleets[fleetId]) {
    const hasFail = agents.some((a) => a.status === "failed");
    const fleet = data.fleets[fleetId];
    fleet.status = hasFail ? "failed" : "complete";
    fleet.completed_at = Date.now();
    saveData(data);
  }
}

// ---------------------------------------------------------------------------
// Agent Operations
// ---------------------------------------------------------------------------

export function registerAgentInLedger(
  agent: Agent,
  inbox: string[] = []
): void {
  const data = loadData();
  data.agents[agent.id] = agent;
  data.inboxes[agent.id] = inbox;
  saveData(data);
}

export function markAgentFinished(
  agentId: string,
  status: "complete" | "failed",
  output: string,
  error: string | undefined
): void {
  const data = loadData();
  const agent = data.agents[agentId];
  if (!agent || agent.completed_at !== undefined) return;
  agent.status = status;
  agent.output = output;
  agent.error = error;
  agent.completed_at = Date.now();
  saveData(data);
  checkFleetCompletion(agent.fleet_id);
}

// ---------------------------------------------------------------------------
// P2P Message Bus
// ---------------------------------------------------------------------------

export const MAX_PAYLOAD_BYTES = 64 * 1024;

export function sendMessage(
  fromAgentId: string,
  toAgentId: string,
  fleetId: string,
  type: MessageType,
  payload: string,
  correlationId?: string
): string {
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
  if (!data.inboxes[toAgentId]) data.inboxes[toAgentId] = [];
  data.inboxes[toAgentId].push(messageId);
  saveData(data);
  return messageId;
}

export function getInbox(agentId: string, since?: number): Message[] {
  const data = loadData();
  const inboxIds = data.inboxes[agentId] || [];
  const messages = inboxIds
    .map((id) => data.messages[id])
    .filter((m): m is Message => m !== undefined);
  if (since !== undefined) return messages.filter((m) => m.timestamp > since);
  return messages;
}

export function ackMessage(agentId: string, messageId: string): boolean {
  const data = loadData();
  const msg = data.messages[messageId];
  if (!msg) return false;
  msg.acknowledged = true;
  if (data.inboxes[agentId]) {
    data.inboxes[agentId] = data.inboxes[agentId].filter(
      (id) => id !== messageId
    );
  }
  saveData(data);
  return true;
}

// ---------------------------------------------------------------------------
// Capability Registry & Routing
// ---------------------------------------------------------------------------

export function registerCapability(input: {
  agentId: string;
  fleetId: string;
  role: string;
  skills: string[];
  model?: string;
  contextWindow?: number;
}): void {
  const data = loadData();
  data.capabilities[input.agentId] = {
    agent_id: input.agentId,
    fleet_id: input.fleetId,
    role: input.role,
    skills: input.skills,
    model: input.model,
    context_window: input.contextWindow,
    registered_at: Date.now(),
  };
  saveData(data);
}

export function routeWork(description: string): RouteMatch[] {
  const data = loadData();
  const caps = Object.values(data.capabilities);
  if (caps.length === 0) return [];

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
          break;
        }
      }
    }
    return {
      agent_id: cap.agent_id,
      score: matches / keywords.length,
      role: cap.role,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0);
}

// ---------------------------------------------------------------------------
// Auto-registration Helper
// ---------------------------------------------------------------------------

export function autoRegisterFromAgent(agentId: string, fleetId: string, agentFile: string): boolean {
  const premade = discoverPremadeAgents().find((p) => p.filename === agentFile);
  if (!premade) return false;
  const skills = extractSkillsFromDescription(premade.description);
  registerCapability({
    agentId,
    fleetId,
    role: premade.name,
    skills,
  });
  return true;
}
