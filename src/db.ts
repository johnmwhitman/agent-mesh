/**
 * SQLite-backed ledger — the `withLedger` transaction seam (Phase 2).
 *
 * Replaces the split loadData()/saveData() JSON read-modify-write. Every writer
 * runs inside a single `BEGIN IMMEDIATE` transaction (via better-sqlite3), so
 * SQLite's own WAL + busy_timeout provide cross-process write exclusion — we own
 * NO locking protocol. This kills lost-update by construction (the multi-process
 * race that lost 57/120 receipts on the JSON ledger).
 *
 * Storage model: one table per collection, each row = a JSON blob of the entity
 * plus a few extracted, indexed columns for query paths (message_id, fleet_id).
 * This keeps perfect MeshData fidelity (round-trip via JSON) while making reads
 * indexable. v1 persistence is reconcile-all (delete+insert per collection per
 * transaction) — correct and simple; a diff-based surgical-write optimization is
 * a tracked follow-up.
 *
 * NON-NEGOTIABLES (from the 3-model red-team):
 *  - BEGIN IMMEDIATE for every mutator (never deferred — deferred races on upgrade).
 *  - Mutators are SYNCHRONOUS and side-effect-free; async returns are rejected.
 *  - WAL is local-disk only (document; the ledger lives under ~/.config).
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import {
  CURRENT_SCHEMA_VERSION,
  type MeshData,
  type Agent,
  type Message,
  type Receipt,
  type Ratification,
} from "./core.js";

const DEFAULT_DB_FILE = join(homedir(), ".config/opencode", "agent-mesh.db");

let dbFile: string | null = null;
let handle: Database.Database | null = null;

/** Test/override hook: point at a specific db file and drop any open handle. */
export function setDbPath(file: string): void {
  closeDb();
  dbFile = file;
}

export function closeDb(): void {
  if (handle) {
    handle.close();
    handle = null;
  }
}

export function resolveDbFile(): string {
  return process.env.MESHFLEET_DB_FILE || dbFile || DEFAULT_DB_FILE;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta          (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fleets        (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agents        (id TEXT PRIMARY KEY, fleet_id TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages      (id TEXT PRIMARY KEY, fleet_id TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS inboxes       (agent_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS capabilities  (agent_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS receipts      (key TEXT PRIMARY KEY, message_id TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ratifications (message_id TEXT PRIMARY KEY, fleet_id TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS templates     (key TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_agents_fleet        ON agents(fleet_id);
CREATE INDEX IF NOT EXISTS idx_messages_fleet      ON messages(fleet_id);
CREATE INDEX IF NOT EXISTS idx_receipts_message    ON receipts(message_id);
CREATE INDEX IF NOT EXISTS idx_ratifications_fleet ON ratifications(fleet_id);
`;

function getDb(): Database.Database {
  if (handle) return handle;
  const file = resolveDbFile();
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { timeout: 5000 });
  // busy_timeout MUST be set before the WAL conversion below — converting the
  // journal mode needs a write lock, and a cold multi-process first-open would
  // otherwise throw "database is locked" instead of waiting.
  db.pragma("busy_timeout = 5000"); // wait for a concurrent writer instead of erroring
  db.pragma("journal_mode = WAL"); // local-disk only; the ledger lives under ~/.config
  db.pragma("synchronous = NORMAL"); // WAL-recommended; durable except last txn on OS crash
  db.exec(SCHEMA);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run(
    String(CURRENT_SCHEMA_VERSION)
  );
  handle = db;
  return db;
}

const EMPTY: MeshData = {
  fleets: {},
  agents: {},
  messages: {},
  inboxes: {},
  capabilities: {},
  receipts: {},
  ratifications: {},
  templates: {},
};

interface Row {
  id?: string;
  agent_id?: string;
  message_id?: string;
  key?: string;
  data: string;
}

function readState(db: Database.Database): MeshData {
  const all = (t: string) => db.prepare(`SELECT * FROM ${t}`).all() as Row[];
  const dict = (rows: Row[], k: keyof Row) =>
    Object.fromEntries(rows.map((r) => [r[k] as string, JSON.parse(r.data)]));
  return {
    fleets: dict(all("fleets"), "id"),
    agents: dict(all("agents"), "id"),
    messages: dict(all("messages"), "id"),
    inboxes: dict(all("inboxes"), "agent_id"),
    capabilities: dict(all("capabilities"), "agent_id"),
    receipts: dict(all("receipts"), "key"),
    ratifications: dict(all("ratifications"), "message_id"),
    templates: dict(all("templates"), "key"),
  };
}

function writeState(db: Database.Database, data: MeshData): void {
  // v1: reconcile-all — delete then insert every collection. Correct and simple;
  // the whole thing is inside one IMMEDIATE transaction, so it is atomic.
  const replace = (
    table: string,
    entries: [string, unknown][],
    cols: string,
    row: (k: string, v: unknown) => unknown[]
  ) => {
    db.prepare(`DELETE FROM ${table}`).run();
    if (entries.length === 0) return;
    const ins = db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${cols.split(",").map(() => "?").join(",")})`);
    for (const [k, v] of entries) ins.run(...row(k, v));
  };

  replace("fleets", Object.entries(data.fleets), "id,data", (k, v) => [k, JSON.stringify(v)]);
  replace("agents", Object.entries(data.agents), "id,fleet_id,data", (k, v) => [k, (v as Agent).fleet_id, JSON.stringify(v)]);
  replace("messages", Object.entries(data.messages), "id,fleet_id,data", (k, v) => [k, (v as Message).fleet_id, JSON.stringify(v)]);
  replace("inboxes", Object.entries(data.inboxes), "agent_id,data", (k, v) => [k, JSON.stringify(v)]);
  replace("capabilities", Object.entries(data.capabilities), "agent_id,data", (k, v) => [k, JSON.stringify(v)]);
  replace("receipts", Object.entries(data.receipts ?? {}), "key,message_id,data", (k, v) => [k, (v as Receipt).message_id, JSON.stringify(v)]);
  replace("ratifications", Object.entries(data.ratifications ?? {}), "message_id,fleet_id,data", (k, v) => [k, (v as Ratification).fleet_id, JSON.stringify(v)]);
  replace("templates", Object.entries(data.templates ?? {}), "key,data", (k, v) => [k, JSON.stringify(v)]);
}

/**
 * Run a mutator inside a single BEGIN IMMEDIATE transaction: read fresh state
 * under the write lock, mutate in memory, persist, commit. SQLite serializes
 * concurrent writers (busy_timeout waits, doesn't lose), so no update is lost.
 * The mutator MUST be synchronous and free of side effects (spawns/network/IO);
 * an async return is rejected and rolls the transaction back.
 */
export function withLedger<T>(mutator: (data: MeshData) => T): T {
  const db = getDb();
  const run = db.transaction((m: (data: MeshData) => T): T => {
    const data = readState(db);
    const result = m(data);
    if (result != null && typeof (result as { then?: unknown }).then === "function") {
      throw new Error("withLedger: mutator must be synchronous (it returned a Promise)");
    }
    writeState(db, data);
    return result;
  }).immediate;
  return run(mutator);
}

/** Lock-free read for read-only callers. WAL readers never block writers. */
export function readLedger(): MeshData {
  return readState(getDb());
}

/** Bulk-load a full MeshData snapshot (used by the JSON→SQLite migrator). */
export function importSnapshot(data: MeshData): void {
  const db = getDb();
  db.transaction(() => writeState(db, { ...EMPTY, ...data })).immediate();
}
