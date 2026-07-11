import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, renameSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync } from "fs";
import { dirname } from "path";
import { join, basename, extname } from "path";
import { homedir } from "os";
import { getRoutingAdjustment } from "./routing-feedback.js";
import { expandKeywordsWithSynonyms } from "./synonyms.js";

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
  status: "pending" | "running" | "complete" | "failed" | "interrupted";
  output?: string;
  error?: string;
  started_at?: number;
  completed_at?: number;
  retry_count?: number;
}

export interface Fleet {
  id: string;
  status: "pending" | "running" | "complete" | "failed";
  created_at: number;
  completed_at?: number;
  timeout_ms?: number;
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
  to_agent_id: string; // agent id, or "*" for fleet broadcast
  fleet_id: string;
  type: MessageType;
  payload: string;
  correlation_id?: string;
  timestamp: number;
  /** Derived since v0.9: true once every addressed recipient has an 'ack' receipt. */
  acknowledged: boolean;
  /** Resolved recipient list for broadcasts; absent on direct messages. */
  recipients?: string[];
}

export const BROADCAST = "*";

/**
 * A receipt is the audit primitive (v0.9 "witnessed messaging"): one row per
 * (message, agent, action), timestamped. The 'ack' action consumes the message
 * from that agent's inbox; any other action ('seen', 'r-ack', 'retracted', ...)
 * annotates without consuming. A broadcast to N agents therefore carries N
 * independent, queryable acks — a single acknowledged flag cannot represent
 * that (the defect that motivated this design in the Hermes production fleet).
 */
export interface Receipt {
  message_id: string;
  agent_id: string;
  action: string;
  timestamp: number;
  note?: string;
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
  /** Keyed `${message_id}:${agent_id}:${action}` — the key is the idempotency guarantee. Optional for pre-v2 ledgers; lazily initialized. */
  receipts?: Record<string, Receipt>;
  /** Keyed by the proposal message id. Optional; lazily initialized. See ratify.ts. */
  ratifications?: Record<string, Ratification>;
  /**
   * Named fleet templates (see templates.ts), keyed `${name}@v${version}`. Carried
   * as an opaque record so core stays decoupled from the template types. MUST be in
   * loadDataFromFile's whitelist below — omitting it silently drops templates on a
   * real-file load (the v0.11 data-loss bug), then the next core saveData wipes them.
   */
  templates?: Record<string, unknown>;
}

/**
 * A ratification is a quorum vote over the receipts substrate (v0.10 "councils").
 * The proposal is a broadcast message; votes are `r-ack` (approve) / `r-decline`
 * (reject) receipts on it. Generalized from the HOOL fleet's council doctrine:
 * quorum threshold (their 6/9), mandatory named sign-offs (their T5), an SLA
 * deadline, and a "silence = approve" default for peers who don't respond in time.
 */
export interface Ratification {
  message_id: string; // the proposal (a broadcast message)
  proposer: string;
  fleet_id: string;
  subject: string;
  quorum: number; // approvals required to ratify
  voters: string[]; // eligible voters, resolved at open time
  required_signoffs: string[]; // agents whose approval is mandatory regardless of quorum
  opened_at: number;
  deadline?: number; // epoch ms; undefined = stays open until resolved
  silence_policy: "abstain" | "approve"; // how non-voters count once the deadline passes
  status: "open" | "ratified" | "rejected" | "expired";
  resolved_at?: number;
}

export const CURRENT_SCHEMA_VERSION = 2;

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
  weight?: number;
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
  receipts: {},
  ratifications: {},
  templates: {},
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
    const migrated = migrateLedger(raw) as Record<string, unknown>;
    return {
      fleets: (migrated.fleets || {}) as Record<string, Fleet>,
      agents: (migrated.agents || {}) as Record<string, Agent>,
      messages: (migrated.messages || {}) as Record<string, Message>,
      inboxes: (migrated.inboxes || {}) as Record<string, string[]>,
      capabilities: (migrated.capabilities || {}) as Record<string, Capability>,
      receipts: (migrated.receipts || {}) as Record<string, Receipt>,
      ratifications: (migrated.ratifications || {}) as Record<string, Ratification>,
      templates: (migrated.templates || {}) as Record<string, unknown>,
    };
  } catch (err) {
    // Corrupt ledger: QUARANTINE the bad file (preserve it for recovery) and fail
    // LOUDLY, then start empty — never silently overwrite unrecoverable data. The
    // old behavior returned empty and left the corrupt file in place, so the next
    // saveData silently wiped it with no operator signal.
    const quarantine = `${file}.corrupt-${Date.now()}`;
    try {
      renameSync(file, quarantine);
      console.error(
        `Agent Mesh: ledger at ${file} is CORRUPT and was quarantined to ${quarantine}. ` +
        `Starting with an empty ledger — inspect the quarantine file to recover. Error: ${err}`
      );
    } catch (renameErr) {
      console.error(
        `Agent Mesh: ledger at ${file} is CORRUPT and could NOT be quarantined (${renameErr}). ` +
        `Starting with an empty ledger. Original parse error: ${err}`
      );
    }
    return { ...EMPTY_DATA };
  }
}

function migrateLedger(raw: Record<string, unknown>): Record<string, unknown> {
  let version = typeof raw.schema_version === "number" ? raw.schema_version : 0;
  if (version < 1) {
    raw.schema_version = 1;
    version = 1;
  }
  if (version < 2) {
    // v2: receipts ledger. Backfill an 'ack' receipt for every message the
    // v1 boolean recorded as acknowledged, so the audit trail has no gap.
    const receipts = (raw.receipts || {}) as Record<string, Receipt>;
    const messages = (raw.messages || {}) as Record<string, Message>;
    for (const msg of Object.values(messages)) {
      if (msg.acknowledged) {
        const key = `${msg.id}:${msg.to_agent_id}:ack`;
        if (!receipts[key]) {
          receipts[key] = {
            message_id: msg.id,
            agent_id: msg.to_agent_id,
            action: "ack",
            timestamp: msg.timestamp,
            note: "backfilled_from_v1_acknowledged_flag",
          };
        }
      }
    }
    raw.receipts = receipts;
    raw.schema_version = 2;
    version = 2;
  }
  return raw;
}

export function saveDataToFile(data: MeshData, file: string, dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({ schema_version: CURRENT_SCHEMA_VERSION, ...data }, null, 2);
  // Atomic write: write a SAME-DIRECTORY temp file, fsync it, then rename over the
  // target. rename(2) is atomic within a filesystem, so a crash mid-write leaves the
  // previous ledger fully intact (worst case: an orphaned .tmp) — never a truncated
  // ledger. The temp MUST be same-dir (never /tmp) or the rename crosses filesystems
  // and silently degrades to a non-atomic copy.
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
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
// Structured Event Log (NDJSON, append-only)
// ---------------------------------------------------------------------------

export const DEFAULT_EVENT_LOG = join(DEFAULT_DATA_DIR, "agent-mesh.events.log");

let eventLogFile = DEFAULT_EVENT_LOG;

export function setEventLogPath(path: string): void {
  eventLogFile = path;
}

export function appendEvent(
  event: string,
  data: Record<string, unknown> = {}
): void {
  const dir = dirname(eventLogFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const entry = JSON.stringify({ event, timestamp: Date.now(), ...data }) + "\n";
  appendFileSync(eventLogFile, entry, "utf-8");
}

export function readEventLog(limit = 1000): Array<Record<string, unknown>> {
  if (!existsSync(eventLogFile)) return [];
  const content = readFileSync(eventLogFile, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  const recent = lines.slice(-limit);
  const events: Array<Record<string, unknown>> = [];
  for (const line of recent) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Fleet Operations
// ---------------------------------------------------------------------------

const DEFAULT_FLEET_TIMEOUT_MS = 30 * 60 * 1000;

export function getFleetTimeoutMs(fleetId: string): number {
  const fleet = loadData().fleets[fleetId];
  if (fleet?.timeout_ms !== undefined) return fleet.timeout_ms;
  const envVal = Number(process.env.AGENT_MESH_AGENT_TIMEOUT_MS);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : DEFAULT_FLEET_TIMEOUT_MS;
}

export function setFleetTimeout(fleetId: string, timeoutMs: number): void {
  const data = loadData();
  if (!data.fleets[fleetId]) {
    throw new Error(`Fleet ${fleetId} not found`);
  }
  data.fleets[fleetId].timeout_ms = timeoutMs;
  saveData(data);
}

export interface FleetSummary {
  id: string;
  status: Fleet["status"];
  created_at: number;
  completed_at?: number;
  agent_count: number;
  agents_complete: number;
  agents_failed: number;
  agents_running: number;
}

export function listFleets(): FleetSummary[] {
  const data = loadData();
  return Object.values(data.fleets).map((fleet) => {
    const fleetAgents = Object.values(data.agents).filter(
      (a) => a.fleet_id === fleet.id
    );
    return {
      id: fleet.id,
      status: fleet.status,
      created_at: fleet.created_at,
      completed_at: fleet.completed_at,
      agent_count: fleetAgents.length,
      agents_complete: fleetAgents.filter((a) => a.status === "complete").length,
      agents_failed: fleetAgents.filter((a) => a.status === "failed").length,
      agents_running: fleetAgents.filter((a) => a.status === "running").length,
    };
  });
}

export function createFleet(fleetId: string): Fleet {
  const data = loadData();
  const fleet: Fleet = {
    id: fleetId,
    status: "running",
    created_at: Date.now(),
  };
  data.fleets[fleetId] = fleet;
  saveData(data);
  appendEvent("fleet_created", { fleet_id: fleetId });
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

/** True when a pid refers to a live process we can signal. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = alive but not ours; anything else (ESRCH) = dead.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Mark 'running' agents as 'interrupted' (called at MCP startup).
 *
 * Liveness-probed (2026-07-03): an agent is only flipped when its recorded
 * pid is missing or dead. Without the probe, ANY second agent-mesh instance
 * on the same ledger — which every spawned child creates, because its
 * `opencode run` loads the user's MCP config including agent-mesh — marked
 * the parent's healthy running agents as interrupted within seconds
 * (field data: 31/52 agents on the 2026-07-02 ledger).
 */
export function recoverInterruptedAgents(): number {
  const data = loadData();
  let count = 0;
  for (const agent of Object.values(data.agents)) {
    if (agent.status === "running") {
      if (agent.pid !== undefined && isPidAlive(agent.pid)) continue;
      agent.status = "interrupted";
      agent.completed_at = Date.now();
      agent.error = "MCP server crashed before this agent completed; use retry or respawn to recover";
      count++;
      appendEvent("agent_interrupted_recovered", {
        agent_id: agent.id,
        fleet_id: agent.fleet_id,
        started_at: agent.started_at,
        recovered_at: agent.completed_at,
      });
    }
  }
  if (count > 0) saveData(data);
  return count;
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

  let recipients: string[] | undefined;
  if (toAgentId === BROADCAST) {
    recipients = Object.values(data.agents)
      .filter((a) => a.fleet_id === fleetId && a.id !== fromAgentId)
      .map((a) => a.id);
    if (recipients.length === 0) {
      throw new Error(
        `Broadcast in fleet ${fleetId} has no recipients (no other agents registered)`
      );
    }
  }

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
    ...(recipients ? { recipients } : {}),
  };

  data.messages[messageId] = message;
  for (const recipient of recipients ?? [toAgentId]) {
    if (!data.inboxes[recipient]) data.inboxes[recipient] = [];
    data.inboxes[recipient].push(messageId);
  }
  saveData(data);
  return messageId;
}

/** The agents a message is addressed to (broadcasts resolve to their captured recipient list). */
export function messageRecipients(msg: Message): string[] {
  return msg.recipients ?? [msg.to_agent_id];
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
  return writeReceipt(agentId, messageId, "ack") !== null;
}

/**
 * Write a receipt (v0.9 witnessed messaging). Idempotent per
 * (message, agent, action). Returns the receipt, the existing receipt on a
 * repeat call, or null if the message doesn't exist.
 *
 * action 'ack' consumes: removes the message from that agent's inbox and
 * recomputes the message's derived `acknowledged` flag (true only when every
 * addressed recipient has acked). Other actions annotate without consuming.
 */
export function writeReceipt(
  agentId: string,
  messageId: string,
  action: string,
  note?: string
): Receipt | null {
  const data = loadData();
  const msg = data.messages[messageId];
  if (!msg) return null;

  if (!data.receipts) data.receipts = {};
  const key = `${messageId}:${agentId}:${action}`;
  const existing = data.receipts[key];
  if (existing) return existing;

  const receipt: Receipt = {
    message_id: messageId,
    agent_id: agentId,
    action,
    timestamp: Date.now(),
    ...(note !== undefined ? { note } : {}),
  };
  data.receipts[key] = receipt;

  if (action === "ack") {
    if (data.inboxes[agentId]) {
      data.inboxes[agentId] = data.inboxes[agentId].filter(
        (id) => id !== messageId
      );
    }
    msg.acknowledged = messageRecipients(msg).every(
      (r) => data.receipts![`${messageId}:${r}:ack`] !== undefined
    );
  }

  saveData(data);
  appendEvent("receipt_written", {
    message_id: messageId,
    agent_id: agentId,
    action,
    fleet_id: msg.fleet_id,
  });
  return receipt;
}

/** All receipts for a message, oldest first. */
export function getReceipts(messageId: string): Receipt[] {
  const data = loadData();
  return Object.values(data.receipts ?? {})
    .filter((r) => r.message_id === messageId)
    .sort((a, b) => a.timestamp - b.timestamp || a.agent_id.localeCompare(b.agent_id));
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

export function routeWork(description: string, topN: number = 1): RouteMatch[] {
  const data = loadData();
  const caps = Object.values(data.capabilities);
  if (caps.length === 0 || topN <= 0) return [];

  const keywords = expandKeywordsWithSynonyms(
    description
      .toLowerCase()
      .split(/[\s,;.!?()/]+/)
      .filter((k) => k.length > 1)
  );
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

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.agent_id.localeCompare(b.agent_id);
  });

  const matches = scored.filter((s) => s.score > 0).slice(0, topN);

  return matches
    .map((m) => ({ ...m, weight: m.score * getRoutingAdjustment(m.agent_id) }))
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return a.agent_id.localeCompare(b.agent_id);
    });
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
