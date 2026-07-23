import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, renameSync } from "fs";
import { dirname } from "path";
import { join, basename, extname } from "path";
import { homedir } from "os";
import { getRoutingAdjustment } from "./routing-feedback.js";
import { getBudgetAdjustment } from "./budget-awareness.js";
import { expandKeywordsWithSynonyms } from "./synonyms.js";
import { getSkillTaxonomy, scoreSkillsAgainstKeywords } from "./skill-taxonomy.js";
import { resolveEnv } from "./env.js";
import { withLedger, withLedgerAndStorage, readLedger, importSnapshot } from "./db.js";
import { mapLegacyMessage, projectLegacyMessage } from "./a2a/legacy-map.js";
import { A2A_MESSAGE_TYPES, type A2AMessageType } from "./a2a/types.js";

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
  runtime_agent?: string;
  runtime_model?: string;
}

export interface Fleet {
  id: string;
  status: "pending" | "running" | "complete" | "failed";
  created_at: number;
  completed_at?: number;
  timeout_ms?: number;
}

export const MESSAGE_TYPES = A2A_MESSAGE_TYPES;

export type MessageType = A2AMessageType;

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
  /**
   * Tiered councils (v0.13): per-voter positive-integer weights, assigned at
   * open time; unlisted voters weigh 1, so an absent map = today's one-agent-
   * one-vote semantics exactly. Weight buys QUORUM power only — required
   * signoffs stay per-agent.
   */
  weights?: Record<string, number>;
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

/**
 * loadData / saveData are now thin SQLite shims over the withLedger seam (db.ts).
 * - `loadData()` is a lock-free read (read-only callers unchanged).
 * - `saveData()` is a transactional FULL-REPLACE, kept for seeding/compat only —
 *   it is NOT concurrency-safe for writers (it read-outside-then-replaces). Every
 *   WRITER uses `withLedger` directly so its read+mutate+write is one transaction.
 * The JSON functions below (`loadDataFromFile`/`migrateLedger`) are now
 * MIGRATION-ONLY — the one-time JSON→SQLite import path, not the live ledger.
 */
export function loadData(): MeshData {
  return readLedger();
}

export function saveData(data: MeshData): void {
  withLedger((cur) => {
    cur.fleets = data.fleets;
    cur.agents = data.agents;
    cur.messages = data.messages;
    cur.inboxes = data.inboxes;
    cur.capabilities = data.capabilities;
    cur.receipts = data.receipts ?? {};
    cur.ratifications = data.ratifications ?? {};
    cur.templates = data.templates ?? {};
  });
}

export function resolveDataFile(): string {
  return resolveEnv(process.env, "MESHFLEET_DATA_FILE", "AGENT_MESH_DATA_FILE") ?? dataFile;
}

/**
 * The compiled-in default JSON ledger path, ignoring every override. Used by the
 * migrator to tell "the caller pointed us somewhere deliberately" apart from
 * "we fell back to the real user ledger".
 */
export function defaultDataFile(): string {
  return DEFAULT_DATA_FILE;
}

/**
 * Did the caller state where the JSON ledger lives, as opposed to us falling
 * back to the default?
 *
 * Deliberately tests PRESENCE, not path inequality: someone who explicitly sets
 * `MESHFLEET_DATA_FILE` to the default path has still consciously named the
 * source, which is exactly the acknowledgement the migrator's isolation guard
 * is looking for. Comparing paths instead would silently reject that as "not
 * redirected" and refuse a migration the caller explicitly asked for.
 */
export function isDataFileDeclared(): boolean {
  if (resolveEnv(process.env, "MESHFLEET_DATA_FILE", "AGENT_MESH_DATA_FILE") != null) return true;
  // setLedgerPath() moved it off the compiled default.
  return dataFile !== DEFAULT_DATA_FILE;
}

export function resolveDataDir(): string {
  return resolveEnv(process.env, "MESHFLEET_DATA_DIR", "AGENT_MESH_DATA_DIR") ?? dataDir;
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

/** The active event-log path (honors setEventLogPath — the isolated path under test). */
export function resolveEventLogFile(): string {
  return eventLogFile;
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

/**
 * Outbox projection helper. The event id is additive to the historical NDJSON
 * shape, so existing inspector and MCP consumers retain their required keys.
 */
export function appendEventOnce(eventId: string, event: string, data: Record<string, unknown> = {}): void {
  const marker = `\"event_id\":\"${eventId}\"`;
  if (existsSync(eventLogFile) && readFileSync(eventLogFile, "utf-8").includes(marker)) return;
  appendEvent(event, { ...data, event_id: eventId });
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
  const envVal = Number(resolveEnv(process.env, "MESHFLEET_AGENT_TIMEOUT_MS", "AGENT_MESH_AGENT_TIMEOUT_MS"));
  return Number.isFinite(envVal) && envVal > 0 ? envVal : DEFAULT_FLEET_TIMEOUT_MS;
}

export function setFleetTimeout(fleetId: string, timeoutMs: number): void {
  withLedger((data) => {
    const fleet = data.fleets[fleetId];
    if (!fleet) throw new Error(`Fleet ${fleetId} not found`);
    fleet.timeout_ms = timeoutMs;
  });
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

/** In-transaction helper: create the fleet row in place and return it. */
export function _createFleet(data: MeshData, fleetId: string): Fleet {
  const f: Fleet = { id: fleetId, status: "running", created_at: Date.now() };
  data.fleets[fleetId] = f;
  return f;
}

export function createFleet(fleetId: string): Fleet {
  const fleet = withLedger((data): Fleet => _createFleet(data, fleetId));
  appendEvent("fleet_created", { fleet_id: fleetId }); // hoisted: side-effect outside the txn
  return fleet;
}

/** In-transaction helper: decide fleet completion from `data` and set it in place. */
export function _checkFleetCompletion(data: MeshData, fleetId: string): void {
  const agents = Object.values(data.agents).filter((a) => a.fleet_id === fleetId);
  const allDone = agents.every((a) => a.status === "complete" || a.status === "failed");
  if (allDone && data.fleets[fleetId]) {
    const hasFail = agents.some((a) => a.status === "failed");
    const fleet = data.fleets[fleetId];
    fleet.status = hasFail ? "failed" : "complete";
    fleet.completed_at = Date.now();
  }
}

export function checkFleetCompletion(fleetId: string): void {
  withLedger((data) => _checkFleetCompletion(data, fleetId));
}

// ---------------------------------------------------------------------------
// Agent Operations
// ---------------------------------------------------------------------------

/** In-transaction helper: register an agent row + its inbox in place. */
export function _registerAgent(
  data: MeshData,
  agent: Agent,
  inbox: string[] = []
): void {
  data.agents[agent.id] = agent;
  data.inboxes[agent.id] = inbox;
}

export function registerAgentInLedger(
  agent: Agent,
  inbox: string[] = []
): void {
  withLedger((data) => _registerAgent(data, agent, inbox));
}

export function markAgentFinished(
  agentId: string,
  status: "complete" | "failed",
  output: string,
  error: string | undefined,
  runtimeAgent?: string,
  runtimeModel?: string
): void {
  // ONE transaction: mark the agent AND decide+set fleet completion from the same
  // snapshot (was two RMW cycles — two finishers could both read "not all done").
  withLedger((data) => {
    const agent = data.agents[agentId];
    if (!agent || agent.completed_at !== undefined) return;
    agent.status = status;
    agent.output = output;
    agent.error = error;
    if (runtimeAgent !== undefined) agent.runtime_agent = runtimeAgent;
    if (runtimeModel !== undefined) agent.runtime_model = runtimeModel;
    agent.completed_at = Date.now();
    _checkFleetCompletion(data, agent.fleet_id);
  });
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
  // Startup-only, parent-only (CHILD guard). isPidAlive is a read-only syscall so
  // it stays in the mutator; the recovery events are hoisted OUT of the txn.
  const recovered: Agent[] = [];
  withLedgerAndStorage((data, db) => {
    for (const agent of Object.values(data.agents)) {
      if (agent.status === "running") {
        const mode = db.prepare("SELECT lifecycle_mode FROM fleets WHERE id = ?").get(agent.fleet_id) as { lifecycle_mode?: string | null } | undefined;
        // Durable ownership is lease-based; PID liveness is intentionally
        // irrelevant and must not reclaim a non-expired managed attempt.
        if (mode?.lifecycle_mode === "durable") continue;
        if (agent.pid !== undefined && isPidAlive(agent.pid)) continue;
        agent.status = "interrupted";
        agent.completed_at = Date.now();
        // This string is written into the evidence ledger, so it must name only
        // mechanisms that actually exist. It previously said "use retry or respawn
        // to recover" — there is no retry or respawn tool, and nothing anywhere
        // re-runs an interrupted agent (`retry.ts` and the attempt lifecycle are
        // automatic machinery for LIVE attempts, not an operator handle). The two
        // real options are stated instead. Note attach_agent injects a REPLACEMENT
        // agent and leaves this row as-is; it is not resumption. It also requires
        // the fleet to still be `running`, which today it is, because completion
        // never terminalizes an all-interrupted fleet.
        agent.error = "MCP server crashed before this agent completed. This agent cannot be resumed; attach a replacement to the fleet with attach_agent, or re-run the work with spawn_fleet.";
        recovered.push(agent);
      }
    }
  });
  for (const agent of recovered) {
    appendEvent("agent_interrupted_recovered", {
      agent_id: agent.id,
      fleet_id: agent.fleet_id,
      started_at: agent.started_at,
      recovered_at: agent.completed_at,
    });
  }
  return recovered.length;
}

// ---------------------------------------------------------------------------
// P2P Message Bus
// ---------------------------------------------------------------------------

export const MAX_PAYLOAD_BYTES = 64 * 1024;

/** In-transaction helper: append a message + inbox entries to `data`; returns the id. */
export function _sendMessage(
  data: MeshData,
  fromAgentId: string,
  toAgentId: string,
  fleetId: string,
  type: MessageType,
  payload: string,
  correlationId?: string
): { messageId: string; recipients: string[] } {
  const messageId = randomUUID();
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
  const delivered = recipients ?? [toAgentId];
  // Direct self-messages are a legacy-valid local operation but cannot be
  // represented by a canonical envelope, which forbids sender-as-recipient.
  // Preserve that compatibility edge without extending the wire contract.
  const message: Message = fromAgentId === toAgentId
    ? {
        id: messageId, from_agent_id: fromAgentId, to_agent_id: toAgentId,
        fleet_id: fleetId, type, payload, correlation_id: correlationId,
        timestamp: Date.now(), acknowledged: false,
      }
    : projectLegacyMessage(
        mapLegacyMessage({
          messageId,
          fromAgentId,
          toAgentId,
          fleetId,
          type,
          payload,
          timestamp: Date.now(),
          correlationId,
        }, recipients ? { broadcastRecipients: recipients } : {}),
        toAgentId,
      );
  data.messages[messageId] = message;
  for (const recipient of delivered) {
    if (!data.inboxes[recipient]) data.inboxes[recipient] = [];
    data.inboxes[recipient].push(messageId);
  }
  return { messageId, recipients: delivered };
}

export function sendMessage(
  fromAgentId: string,
  toAgentId: string,
  fleetId: string,
  type: MessageType,
  payload: string,
  correlationId?: string
): { messageId: string; recipients: string[] } {
  if (Buffer.byteLength(payload, "utf-8") > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `Payload too large: ${Buffer.byteLength(payload)} bytes (limit ${MAX_PAYLOAD_BYTES})`
    );
  }
  return withLedger((data) => _sendMessage(data, fromAgentId, toAgentId, fleetId, type, payload, correlationId));
}

export const MAX_BATCH_MESSAGES = 1000;

export interface BatchMessageInput {
  fromAgentId: string;
  toAgentId: string;
  fleetId: string;
  type: MessageType;
  payload: string;
  correlationId?: string;
}

/**
 * Send a batch of messages in ONE transaction (v0.9 "coalesced writes").
 * A per-message sendMessage pays the recipient's inbox-row parse+rewrite every
 * call — O(inbox) per message; the batch pays it once. Atomic: any invalid
 * item (oversized payload, empty broadcast) rejects the whole batch. Bounded
 * at MAX_BATCH_MESSAGES so one call cannot hold the write lock indefinitely.
 */
export function sendMessages(
  batch: BatchMessageInput[]
): Array<{ messageId: string; recipients: string[] }> {
  if (batch.length === 0) return [];
  if (batch.length > MAX_BATCH_MESSAGES) {
    throw new Error(`Batch too large: ${batch.length} messages (limit ${MAX_BATCH_MESSAGES})`);
  }
  for (const m of batch) {
    if (Buffer.byteLength(m.payload, "utf-8") > MAX_PAYLOAD_BYTES) {
      throw new Error(
        `Payload too large: ${Buffer.byteLength(m.payload)} bytes (limit ${MAX_PAYLOAD_BYTES})`
      );
    }
  }
  return withLedger((data) =>
    batch.map((m) =>
      _sendMessage(data, m.fromAgentId, m.toAgentId, m.fleetId, m.type, m.payload, m.correlationId)
    )
  );
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
/** In-transaction helper: write a receipt into `data`; returns receipt | existing | null. */
export function _writeReceipt(
  data: MeshData,
  agentId: string,
  messageId: string,
  action: string,
  note?: string
): Receipt | null {
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
      data.inboxes[agentId] = data.inboxes[agentId].filter((id) => id !== messageId);
    }
    msg.acknowledged = messageRecipients(msg).every(
      (r) => data.receipts![`${messageId}:${r}:ack`] !== undefined
    );
  }
  return receipt;
}

export function writeReceipt(
  agentId: string,
  messageId: string,
  action: string,
  note?: string
): Receipt | null {
  let event: { fleet_id: string } | null = null;
  const receipt = withLedger((data): Receipt | null => {
    const msg = data.messages[messageId];
    const key = `${messageId}:${agentId}:${action}`;
    const wasNew = !!msg && !(data.receipts?.[key]);
    const r = _writeReceipt(data, agentId, messageId, action, note);
    if (r && wasNew && msg) event = { fleet_id: msg.fleet_id };
    return r;
  });
  if (event) {
    appendEvent("receipt_written", { message_id: messageId, agent_id: agentId, action, fleet_id: (event as { fleet_id: string }).fleet_id });
  }
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

interface CapabilityInput {
  agentId: string;
  fleetId: string;
  role: string;
  skills: string[];
  model?: string;
  contextWindow?: number;
}

/** In-transaction helper. */
export function _registerCapability(data: MeshData, input: CapabilityInput): void {
  // Refuse to key a row on a missing id. Without this, a caller that passes the
  // wrong field names (the MCP wire is snake_case, this input is camelCase)
  // silently writes `capabilities["undefined"]` with `agent_id: undefined`:
  // every such call overwrites the last, and the row later crashes routeWork's
  // tie-breaker. Observed on a real ledger, so this guard is load-bearing, not
  // defensive decoration.
  if (typeof input?.agentId !== "string" || input.agentId.length === 0) {
    throw new Error(
      `register_capability: agentId is required and must be a non-empty string (got ${JSON.stringify(input?.agentId)}). ` +
        `Note the MCP wire field is 'agent_id'; it must be mapped to 'agentId'.`
    );
  }
  if (typeof input.fleetId !== "string" || input.fleetId.length === 0) {
    throw new Error(
      `register_capability: fleetId is required and must be a non-empty string (got ${JSON.stringify(input.fleetId)}). ` +
        `Note the MCP wire field is 'fleet_id'; it must be mapped to 'fleetId'.`
    );
  }
  data.capabilities[input.agentId] = {
    agent_id: input.agentId,
    fleet_id: input.fleetId,
    role: input.role,
    skills: input.skills,
    model: input.model,
    context_window: input.contextWindow,
    registered_at: Date.now(),
  };
}

export function registerCapability(input: CapabilityInput): void {
  withLedger((data) => _registerCapability(data, input));
}

export function routeWork(description: string, topN: number = 1): RouteMatch[] {
  const data = loadData();
  // Skip unusable rows before scoring. A ledger written before the
  // register_capability guard above can hold a row with no agent id (the
  // wire-format bug), and such a row is unroutable by definition — you cannot
  // dispatch to an agent with no id. Left in, it throws in the `localeCompare`
  // tie-breaker below and takes routing down for every healthy agent with it.
  //
  // `role` and `skills` are validated for the SAME reason, not for tidiness:
  // the scorer calls `cap.role.toLowerCase()` and `cap.skills.map(...)`
  // unconditionally, so a row missing either has exactly the blast radius the
  // id bug had. Guarding only the id would have fixed one corrupt shape and
  // left its siblings live.
  //
  // The id falls back to the record KEY: the ledger stores capabilities keyed by
  // agent id, so a row whose key is sound but whose body lost its `agent_id`
  // (hand-edited or partially imported) is still dispatchable, and the key is
  // the authoritative half of that pair.
  //
  // But NOT the literal strings "undefined"/"null": `capabilities[undefined]`
  // coerces its key to "undefined", so those are precisely the poisoned rows —
  // falling back to that key would resurrect the exact bug this guards against
  // and offer a route target no dispatcher can use. No real agent is named
  // either, so refusing them costs nothing.
  const UNUSABLE_IDS = new Set(["undefined", "null", ""]);
  const usableId = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && !UNUSABLE_IDS.has(v);

  const caps = Object.entries(data.capabilities)
    .map(([key, cap]) => {
      const id = usableId(cap?.agent_id) ? cap.agent_id : key;
      return { ...cap, agent_id: id } as Capability;
    })
    .filter(
      (c) =>
        usableId(c.agent_id) &&
        typeof c.role === "string" &&
        Array.isArray(c.skills) &&
        c.skills.every((s) => typeof s === "string")
    );
  if (caps.length === 0 || topN <= 0) return [];

  const tokenize = (s: string) =>
    s
      .toLowerCase()
      .split(/[\s,;.!?()/]+/)
      .filter((k) => k.length > 1);

  const keywords = expandKeywordsWithSynonyms(tokenize(description));
  if (keywords.length === 0) return [];

  // ROADMAP #55: taxonomy scoring. Empty by default → zero effect on routing
  // until a taxonomy is set (see skill-taxonomy.ts). When set, a capability is
  // credited for being an ancestor/relative of a description keyword in the
  // tree (a 'react' agent gets partial credit for a 'nextjs' task).
  const taxonomy = getSkillTaxonomy();
  const taxScores =
    Object.keys(taxonomy).length > 0
      ? new Map(
          scoreSkillsAgainstKeywords(keywords, taxonomy).map((s) => [s.skill.toLowerCase(), s.score])
        )
      : null;
  // Weight taxonomy credit below a direct keyword hit so exact matches still lead.
  const TAX_WEIGHT = 0.5;

  // A literal keyword match must always outrank a pure synonym-rescue or
  // taxonomy-only match. We guarantee that STRUCTURALLY (not with fragile
  // weights): any agent with ≥1 literal hit gets a tier base above the max any
  // non-literal agent can reach. Non-literal max = TAX_WEIGHT(0.5) +
  // RESCUE_WEIGHT(0.5) = 1.0 < LITERAL_TIER(2.0).
  const LITERAL_TIER = 2.0;
  const RESCUE_WEIGHT = 0.5;

  const capTaxTerms = (roleLower: string, skillsLower: string[]) =>
    [...tokenize(roleLower), ...skillsLower.flatMap(tokenize)];

  const scored = caps.map((cap) => {
    const roleLower = cap.role.toLowerCase();
    const skillsLower = cap.skills.map((s) => s.toLowerCase());

    // Literal pass — EXACTLY the original scoring: a role hit and a skill hit
    // for the same keyword count independently (preserved for compatibility).
    let literal = 0;
    for (const kw of keywords) {
      if (roleLower.includes(kw)) literal++;
      if (skillsLower.some((sk) => sk.includes(kw))) literal++;
    }

    // ROADMAP #55: taxonomy credit (0 unless a taxonomy is set). Tokenize the
    // role/skills so a compound label like "react engineer" still matches key "react".
    let taxBonus = 0;
    if (taxScores) {
      for (const term of capTaxTerms(roleLower, skillsLower)) {
        const b = taxScores.get(term);
        if (typeof b === "number" && Number.isFinite(b)) taxBonus = Math.max(taxBonus, b);
      }
    }

    let score: number;
    if (literal > 0) {
      score = LITERAL_TIER + literal / keywords.length + TAX_WEIGHT * taxBonus;
    } else {
      // ROADMAP #56: only when nothing matched literally, expand the capability's
      // OWN role+skills with synonyms and retry. Closes the key-also-value
      // collision where getSynonyms returns early on a key ('api') and never
      // reaches its parent ('backend'). Rescue-only → cannot perturb literals.
      const capTerms = new Set(
        expandKeywordsWithSynonyms([...tokenize(roleLower), ...skillsLower.flatMap(tokenize)])
      );
      let rescued = 0;
      for (const kw of keywords) if (capTerms.has(kw)) rescued++;
      score = TAX_WEIGHT * taxBonus + RESCUE_WEIGHT * (rescued / keywords.length);
    }

    return {
      agent_id: cap.agent_id,
      score,
      role: cap.role,
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.agent_id.localeCompare(b.agent_id);
  });

  // Weight BEFORE truncating. A provider that is out of budget scores 0 and must
  // drop out entirely, letting the next candidate take its place — if we sliced
  // first, an exhausted agent would occupy a top-N slot with weight 0 and the
  // caller would route to a lane that cannot run.
  return scored
    .filter((s) => s.score > 0)
    .map((m) => ({
      ...m,
      weight: m.score * getRoutingAdjustment(m.agent_id) * getBudgetAdjustment(m.agent_id),
    }))
    .filter((m) => m.weight > 0)
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return a.agent_id.localeCompare(b.agent_id);
    })
    .slice(0, topN);
}

// ---------------------------------------------------------------------------
// Auto-registration Helper
// ---------------------------------------------------------------------------

export function autoRegisterFromAgent(agentId: string, fleetId: string, agentFile: string): boolean {
  const premade = discoverPremadeAgents().find((p) => p.filename === agentFile); // FS read, outside the txn
  if (!premade) return false;
  const skills = extractSkillsFromDescription(premade.description);
  withLedger((data) => _registerCapability(data, { agentId, fleetId, role: premade.name, skills }));
  return true;
}
