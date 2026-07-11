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

// One table per MeshData collection: entity stored as a JSON blob + extracted,
// indexed columns for query paths. `cols` is the insert order (pk, extra indexed
// cols, then `data`); `extract` yields the extra indexed column values.
interface CollSpec {
  table: string;
  pk: string;
  cols: string[];
  extract: (v: unknown) => (string | null)[];
  get: (d: MeshData) => Record<string, unknown>;
}

const COLLECTIONS: CollSpec[] = [
  { table: "fleets", pk: "id", cols: ["id", "data"], extract: () => [], get: (d) => d.fleets },
  { table: "agents", pk: "id", cols: ["id", "fleet_id", "data"], extract: (v) => [(v as Agent).fleet_id], get: (d) => d.agents },
  { table: "messages", pk: "id", cols: ["id", "fleet_id", "data"], extract: (v) => [(v as Message).fleet_id], get: (d) => d.messages },
  { table: "inboxes", pk: "agent_id", cols: ["agent_id", "data"], extract: () => [], get: (d) => d.inboxes },
  { table: "capabilities", pk: "agent_id", cols: ["agent_id", "data"], extract: () => [], get: (d) => d.capabilities },
  { table: "receipts", pk: "key", cols: ["key", "message_id", "data"], extract: (v) => [(v as Receipt).message_id], get: (d) => d.receipts ?? {} },
  { table: "ratifications", pk: "message_id", cols: ["message_id", "fleet_id", "data"], extract: (v) => [(v as Ratification).fleet_id], get: (d) => d.ratifications ?? {} },
  { table: "templates", pk: "key", cols: ["key", "data"], extract: () => [], get: (d) => d.templates ?? {} },
];

function emptyData(): MeshData {
  return { fleets: {}, agents: {}, messages: {}, inboxes: {}, capabilities: {}, receipts: {}, ratifications: {}, templates: {} };
}

function readState(db: Database.Database): MeshData {
  const data = emptyData();
  for (const c of COLLECTIONS) {
    const dict = c.get(data);
    for (const r of db.prepare(`SELECT ${c.pk} AS k, data FROM ${c.table}`).all() as { k: string; data: string }[]) {
      dict[r.k] = JSON.parse(r.data);
    }
  }
  return data;
}

/**
 * Read state for a transaction: parsed MeshData PLUS the raw JSON string per key,
 * so the commit writes only NEW/CHANGED rows and deletes removed ones — O(changed),
 * not O(N) (the reconcile-all approach regressed past ~1-2k rows; see the spike).
 */
function loadForTxn(db: Database.Database): { data: MeshData; raw: Map<string, Map<string, string>> } {
  const data = emptyData();
  const raw = new Map<string, Map<string, string>>();
  for (const c of COLLECTIONS) {
    const dict = c.get(data);
    const rawMap = new Map<string, string>();
    for (const r of db.prepare(`SELECT ${c.pk} AS k, data FROM ${c.table}`).all() as { k: string; data: string }[]) {
      dict[r.k] = JSON.parse(r.data);
      rawMap.set(r.k, r.data);
    }
    raw.set(c.table, rawMap);
  }
  return { data, raw };
}

function persistDiff(db: Database.Database, data: MeshData, raw: Map<string, Map<string, string>>): void {
  for (const c of COLLECTIONS) {
    const cur = c.get(data);
    const rawMap = raw.get(c.table) ?? new Map<string, string>();
    const upsert = db.prepare(`INSERT OR REPLACE INTO ${c.table} (${c.cols.join(",")}) VALUES (${c.cols.map(() => "?").join(",")})`);
    const del = db.prepare(`DELETE FROM ${c.table} WHERE ${c.pk} = ?`);
    const seen = new Set<string>();
    for (const [k, v] of Object.entries(cur)) {
      seen.add(k);
      const s = JSON.stringify(v);
      if (rawMap.get(k) !== s) upsert.run(k, ...c.extract(v), s); // new or changed only
    }
    for (const k of rawMap.keys()) if (!seen.has(k)) del.run(k);
  }
}

/**
 * Run a mutator inside a single BEGIN IMMEDIATE transaction: read fresh state
 * under the write lock, mutate in memory, persist the diff, commit. SQLite
 * serializes concurrent writers (busy_timeout waits, doesn't lose), so no update
 * is lost. The mutator MUST be synchronous and side-effect-free (spawns/network/
 * IO/nested withLedger); an async return is rejected and rolls the txn back.
 */
export function withLedger<T>(mutator: (data: MeshData) => T): T {
  const db = getDb();
  const run = db.transaction((m: (data: MeshData) => T): T => {
    const { data, raw } = loadForTxn(db);
    const result = m(data);
    if (result != null && typeof (result as { then?: unknown }).then === "function") {
      throw new Error("withLedger: mutator must be synchronous (it returned a Promise)");
    }
    persistDiff(db, data, raw);
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
  const full = { ...emptyData(), ...data };
  db.transaction(() => persistDiff(db, full, new Map())).immediate();
}
