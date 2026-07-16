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

/**
 * Own-property-safe row assignment. `dict[k] = v` on a plain dict invokes the
 * inherited setter when k is "__proto__" — the row would vanish from
 * Object.keys and the parsed value would become the dict's PROTOTYPE. The lazy
 * views' Map-backed overlay can durably store such a key, so read-back must
 * create an own property for every key.
 */
function setRow(dict: Record<string, unknown>, k: string, v: unknown): void {
  if (k === "__proto__") {
    Object.defineProperty(dict, k, { value: v, enumerable: true, writable: true, configurable: true });
  } else {
    dict[k] = v;
  }
}

function readState(db: Database.Database): MeshData {
  const data = emptyData();
  for (const c of COLLECTIONS) {
    const dict = c.get(data);
    for (const r of db.prepare(`SELECT ${c.pk} AS k, data FROM ${c.table}`).all() as { k: string; data: string }[]) {
      setRow(dict, r.k, JSON.parse(r.data));
    }
  }
  return data;
}

/** Rows JSON.parsed during the most recent withLedger transaction — the surgical-read metric. */
export interface TxnStats {
  rowsParsed: number;
}

let txnStats: TxnStats = { rowsParsed: 0 };

export function lastTxnStats(): TxnStats {
  return txnStats;
}

/**
 * Lazy per-row transaction view over one collection (the v0.9 surgical-read
 * fix). The eager loadForTxn parsed EVERY row of EVERY collection per
 * transaction, so a single sendMessage against a 10k-message ledger paid a
 * full-ledger JSON.parse — O(N) per write, quadratic in bulk (73s for 10k
 * sends; target < 5s). The view fetches rows on first touch instead:
 *
 *   - get/has: one indexed SELECT per key, cached (same object identity on
 *     re-read, so in-place row mutations behave exactly as before).
 *   - enumeration (Object.keys/values/entries, `in` spread, for..in): hydrates
 *     the full collection once — mutators that genuinely need the whole view
 *     (fleet completion, tallies, routing rosters) keep their semantics.
 *   - persist: diff ONLY the rows that were materialized/written/deleted,
 *     comparing against the raw JSON captured when each row was read.
 *
 * Everything runs inside the same BEGIN IMMEDIATE transaction, so the lazy
 * SELECTs see a stable snapshot and hold the same exclusion guarantees.
 */
class LazyColl {
  private overlay = new Map<string, unknown>();
  private rawCache = new Map<string, string | undefined>();
  private deleted = new Set<string>();
  private hydrated = false;
  readonly proxy: Record<string, unknown>;
  private readonly selectOne: Database.Statement;
  private readonly selectAll: Database.Statement;

  constructor(
    db: Database.Database,
    private readonly spec: CollSpec,
  ) {
    this.selectOne = db.prepare(`SELECT data FROM ${spec.table} WHERE ${spec.pk} = ?`);
    this.selectAll = db.prepare(`SELECT ${spec.pk} AS k, data FROM ${spec.table}`);
    // The proxy target stays empty; all state lives in the maps above. Ordinary
    // extensible target + configurable descriptors keep proxy invariants legal.
    this.proxy = new Proxy({} as Record<string, unknown>, {
      get: (_t, k) => (typeof k === "string" ? this.read(k) : undefined),
      set: (_t, k, v) => {
        if (typeof k !== "string") return false;
        this.overlay.set(k, v);
        this.deleted.delete(k);
        return true;
      },
      deleteProperty: (_t, k) => {
        if (typeof k !== "string") return true;
        this.overlay.delete(k);
        this.deleted.add(k);
        return true;
      },
      defineProperty: (_t, k, desc) => {
        // Route data descriptors through the overlay so they persist like a
        // plain set; refuse accessors LOUDLY (a silent drop would lose writes).
        if (typeof k !== "string" || desc.get || desc.set || !("value" in desc)) return false;
        this.overlay.set(k, desc.value);
        this.deleted.delete(k);
        return true;
      },
      has: (_t, k) =>
        typeof k === "string" ? this.read(k) !== undefined || this.overlay.has(k) : false,
      ownKeys: () => {
        this.hydrate();
        return [...this.overlay.keys()];
      },
      getOwnPropertyDescriptor: (_t, k) => {
        if (typeof k !== "string") return undefined;
        const v = this.read(k);
        if (v === undefined && !this.overlay.has(k)) return undefined;
        return { configurable: true, enumerable: true, writable: true, value: v };
      },
    });
  }

  /** Row for `k` from overlay or storage (cached; undefined once deleted). */
  private read(k: string): unknown {
    if (this.deleted.has(k)) return undefined;
    if (this.overlay.has(k)) return this.overlay.get(k);
    if (this.hydrated || this.rawCache.has(k)) return undefined; // known-absent
    const row = this.selectOne.get(k) as { data: string } | undefined;
    if (!row) {
      this.rawCache.set(k, undefined);
      return undefined;
    }
    const parsed = JSON.parse(row.data);
    txnStats.rowsParsed++;
    this.overlay.set(k, parsed);
    this.rawCache.set(k, row.data);
    return parsed;
  }

  private hydrate(): void {
    if (this.hydrated) return;
    for (const r of this.selectAll.all() as { k: string; data: string }[]) {
      if (this.deleted.has(r.k)) continue;
      if (!this.overlay.has(r.k)) {
        this.overlay.set(r.k, JSON.parse(r.data));
        txnStats.rowsParsed++;
        this.rawCache.set(r.k, r.data);
      } else if (!this.rawCache.has(r.k)) {
        this.rawCache.set(r.k, r.data);
      }
    }
    this.hydrated = true;
  }

  /** Write the touched-row diff. Only called when the mutator kept this view. */
  persist(db: Database.Database): void {
    const upsert = db.prepare(
      `INSERT OR REPLACE INTO ${this.spec.table} (${this.spec.cols.join(",")}) VALUES (${this.spec.cols.map(() => "?").join(",")})`,
    );
    const del = db.prepare(`DELETE FROM ${this.spec.table} WHERE ${this.spec.pk} = ?`);
    for (const [k, v] of this.overlay) {
      const s = JSON.stringify(v);
      if (!this.rawCache.has(k)) {
        const row = this.selectOne.get(k) as { data: string } | undefined;
        this.rawCache.set(k, row?.data);
      }
      if (this.rawCache.get(k) !== s) upsert.run(k, ...this.spec.extract(v), s);
    }
    for (const k of this.deleted) del.run(k);
  }
}

/** Full-collection diff against storage — importSnapshot and the wholesale-replacement fallback. */
function eagerPersist(db: Database.Database, spec: CollSpec, cur: Record<string, unknown>): void {
  const rawMap = new Map<string, string>();
  for (const r of db.prepare(`SELECT ${spec.pk} AS k, data FROM ${spec.table}`).all() as { k: string; data: string }[]) {
    rawMap.set(r.k, r.data);
  }
  const upsert = db.prepare(`INSERT OR REPLACE INTO ${spec.table} (${spec.cols.join(",")}) VALUES (${spec.cols.map(() => "?").join(",")})`);
  const del = db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.pk} = ?`);
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(cur)) {
    seen.add(k);
    const s = JSON.stringify(v);
    if (rawMap.get(k) !== s) upsert.run(k, ...spec.extract(v), s); // new or changed only
  }
  for (const k of rawMap.keys()) if (!seen.has(k)) del.run(k);
}

function persistDiff(db: Database.Database, data: MeshData, raw: Map<string, string> | null = null): void {
  void raw;
  for (const c of COLLECTIONS) {
    eagerPersist(db, c, c.get(data));
  }
}

/**
 * Run a mutator inside a single BEGIN IMMEDIATE transaction: build lazy
 * per-collection views, mutate in memory, persist the touched-row diff,
 * commit. SQLite serializes concurrent writers (busy_timeout waits, doesn't
 * lose), so no update is lost. The mutator MUST be synchronous and
 * side-effect-free (spawns/network/IO/nested withLedger); an async return is
 * rejected and rolls the txn back. A mutator that REPLACES a whole collection
 * (`data.inboxes = {...}`) drops that collection's lazy view; the commit
 * detects it and falls back to a full eager diff for that collection.
 */
export function withLedger<T>(mutator: (data: MeshData) => T): T {
  const db = getDb();
  const run = db.transaction((m: (data: MeshData) => T): T => {
    txnStats = { rowsParsed: 0 };
    const views = new Map<CollSpec, LazyColl>();
    const data = emptyData();
    for (const c of COLLECTIONS) {
      const view = new LazyColl(db, c);
      views.set(c, view);
      (data as unknown as Record<string, unknown>)[c.table] = view.proxy;
    }
    const result = m(data);
    if (result != null && typeof (result as { then?: unknown }).then === "function") {
      throw new Error("withLedger: mutator must be synchronous (it returned a Promise)");
    }
    for (const c of COLLECTIONS) {
      const view = views.get(c)!;
      const cur = c.get(data);
      if (cur === view.proxy) view.persist(db);
      else eagerPersist(db, c, cur); // wholesale replacement
    }
    return result;
  }).immediate;
  return run(mutator);
}

/**
 * Lock-free read for read-only callers. WAL readers never block writers.
 * The per-table SELECTs run inside ONE read transaction so the snapshot is
 * consistent ACROSS collections — without it, a writer committing between the
 * messages and inboxes queries hands the reader an inbox id whose message it
 * cannot see (a torn read verify_ledger would misreport as corruption).
 */
export function readLedger(): MeshData {
  const db = getDb();
  return db.transaction(() => readState(db))();
}

/** Bulk-load a full MeshData snapshot (used by the JSON→SQLite migrator). */
export function importSnapshot(data: MeshData): void {
  const db = getDb();
  const full = { ...emptyData(), ...data };
  db.transaction(() => persistDiff(db, full, new Map())).immediate();
}
