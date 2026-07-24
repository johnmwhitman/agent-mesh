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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
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

/** Test/override hook: point at a specific db file (null clears the override) and drop any open handle. */
export function setDbPath(file: string | null): void {
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

/** The compiled-in default db path, ignoring every override. */
export function defaultDbFile(): string {
  return DEFAULT_DB_FILE;
}

/**
 * Does this open handle's ledger hold any rows outside bookkeeping?
 *
 * Empty iff EVERY table except `meta` (schema/storage version markers, written
 * by ordinary first-open) and `sqlite_*` internals has zero rows. The tables
 * are enumerated from `sqlite_master`, not from a hardcoded list, so lifecycle,
 * A2A, and any future table are covered by construction — a hardcoded list
 * silently under-covered once already (it skipped lifecycle rows, so a
 * lifecycle-only ledger read as "empty" and authorized a wholesale import over
 * it). Verified empirically: a freshly materialized db holds rows only in
 * `meta`.
 *
 * Runs on the shared handle, so inside an open transaction it sees that
 * transaction's view — which is what makes it usable as the migrator's
 * AUTHORIZING check rather than an advisory one.
 */
export function isOpenLedgerEmpty(): boolean {
  const db = getDb();
  return !ledgerHasRows(db);
}

/** Read one `meta` row on the shared handle (in-transaction safe). */
export function getMetaValue(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

/** Write one `meta` row on the shared handle (in-transaction safe). */
export function setMetaValue(key: string, value: string): void {
  const db = getDb();
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

function ledgerHasRows(db: Database.Database): boolean {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'meta'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    if (db.prepare(`SELECT 1 FROM "${name.replace(/"/g, '""')}" LIMIT 1`).get() !== undefined) return true;
  }
  return false;
}

/**
 * Does this ledger FILE exist but hold no rows?
 *
 * Same predicate as `isOpenLedgerEmpty`, on a private read-only connection that
 * never touches the global handle or the configured path. Advisory only — the
 * migrator re-checks under its import transaction before writing anything.
 *
 * Unreadable or non-SQLite files answer `false` (not empty) — the conservative
 * direction, since claiming "empty" would authorize an import over the file.
 */
export function isLedgerFileEmpty(file: string): boolean {
  return probeLedgerFile(file) === "empty";
}

/**
 * Advisory classification of a ledger file. The distinction that matters:
 * `populated` is the ONLY answer that may short-circuit a migration decision,
 * and it additionally requires meshfleet IDENTITY — rows alone are not enough.
 *
 * The boolean predecessor collapsed "unreadable / locked / not-SQLite" into
 * "not empty", which the migrator's fast-path then read as "a ledger is already
 * present" — so a transient SQLITE_BUSY from a peer's cold initialization (or
 * plain garbage at the path) silently skipped the migration and stranded the
 * JSON source with a FALSE reason. `unknown` forces those cases down to the
 * authoritative in-transaction check, where a lock wait serializes properly and
 * a genuinely broken file fails loudly instead of quietly.
 *
 * `foreign` = a valid SQLite db holding rows but NO meshfleet schema marker.
 * Answering `populated` for one would declare an unrelated database "the
 * ledger" and advise the operator to retire their real JSON against it. The
 * identity check must run HERE, on the read-only probe: once getDb() touches
 * the file it stamps a schema_version marker into it, spoiling the question.
 */
export function probeLedgerFile(file: string): "absent" | "empty" | "populated" | "foreign" | "unknown" {
  if (!existsSync(file)) return "absent";
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    // A locked db answers SQLITE_BUSY on the query, not on open — the catch
    // below maps it to `unknown` like every other non-definitive outcome.
    if (!ledgerHasRows(db)) return "empty";
    const marker = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    return marker ? "populated" : "foreign";
  } catch (err) {
    // No `meta` table at all is a definitive foreign answer, not an unknown.
    if (err instanceof Error && /no such table: meta/.test(err.message)) return "foreign";
    return "unknown";
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

/**
 * Run `fn` inside ONE `BEGIN IMMEDIATE` transaction on the ledger handle.
 * Exists for the migrator, whose decide→import→validate sequence must be a
 * single unit of exclusive ownership: any check performed outside the
 * transaction can be invalidated by a writer committing before the import's
 * wholesale replace, which is how a "checked empty" db lost committed rows.
 * Nested transaction seams (`importSnapshot`, `readLedger`) become savepoints
 * inside it, and a throw rolls the WHOLE unit back.
 *
 * Options — each exists for a reviewed failure mode, not for generality:
 *  - `durable`: run the transaction under `synchronous = FULL`, restoring the
 *    connection's PRIOR setting after (whatever it was — not a hardcoded
 *    NORMAL). WAL + synchronous=NORMAL explicitly allows the last commit to be
 *    lost on power failure; a caller that performs an IRREVERSIBLE filesystem
 *    action conditioned on the commit (the migrator renames the JSON source
 *    away) must not act on a commit the disk has not yet seen.
 *  - `acquireMs`: bounded retry on the busy family for everything UP TO the
 *    callback: `getDb()` cold initialization (schema exec + storage migration,
 *    which take their own write locks under the 5s busy_timeout) AND the
 *    `BEGIN IMMEDIATE` acquisition. A peer's long-held import can legitimately
 *    exceed 5s at either point; for a startup-critical caller, crashing the
 *    whole server because a sibling was slow is worse than waiting.
 *
 *    The callback itself is NEVER replayed: a busy error thrown after `fn` has
 *    started (post-BEGIN) propagates instead of retrying. Retrying it would
 *    re-run side effects — the migrator's callback quarantine-renames a corrupt
 *    source, which must happen at most once. An `entered` sentinel
 *    distinguishes "BEGIN failed" (fn never ran → safe to retry) from "fn
 *    threw" (never retry); this was verified to matter empirically — the
 *    previous shape replayed a counter callback twice under an injected busy.
 */
export function withImmediateTransaction<T>(fn: () => T, opts?: { durable?: boolean; acquireMs?: number }): T {
  const deadline = Date.now() + (opts?.acquireMs ?? 0);
  const retryable = (err: unknown): boolean => {
    const code = (err as { code?: string }).code ?? "";
    return Boolean(opts?.acquireMs) && code.startsWith("SQLITE_BUSY") && Date.now() <= deadline;
  };
  for (;;) {
    let db: Database.Database;
    try {
      // Inside the retry loop on purpose: cold initialization takes write
      // locks of its own, and getDb() closes its half-initialized connection
      // on failure, so re-attempting is safe.
      db = getDb();
    } catch (err) {
      if (!retryable(err)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // synchronous 50ms backoff
      continue;
    }
    let entered = false;
    const run = (): T =>
      db.transaction(() => {
        entered = true;
        return fn();
      }).immediate();
    try {
      if (!opts?.durable) return run();
      const prior = db.pragma("synchronous", { simple: true });
      db.pragma("synchronous = FULL");
      try {
        return run();
      } finally {
        db.pragma(`synchronous = ${prior}`);
      }
    } catch (err) {
      if (entered || !retryable(err)) throw err; // fn ran (or not ours to retry): never replay it
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
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

/**
 * Physical SQLite layout version. This is deliberately independent from the
 * JSON/ledger compatibility marker in core.ts (`schema_version = 2`). A ledger
 * imported from any supported JSON version retains that logical marker; these
 * migrations only add internal relational storage.
 */
export const CURRENT_STORAGE_SCHEMA_VERSION = 4;
const SQLITE_SAFE_INTEGER = 9_007_199_254_740_991;

const LIFECYCLE_SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS work_items (
  work_id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  current_attempt_id TEXT NOT NULL,
  owner_epoch INTEGER NOT NULL DEFAULT 0 CHECK (owner_epoch >= 0),
  cancelled_at INTEGER CHECK (cancelled_at IS NULL OR cancelled_at >= 0),
  terminal_at INTEGER CHECK (terminal_at IS NULL OR terminal_at >= 0),
  result_json TEXT,
  error_json TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  CHECK (updated_at >= created_at),
  CHECK (
    (status IN ('pending', 'running') AND cancelled_at IS NULL AND terminal_at IS NULL)
    OR (status IN ('succeeded', 'failed') AND cancelled_at IS NULL AND terminal_at IS NOT NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND terminal_at IS NOT NULL)
  )
);
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES work_items(work_id) ON DELETE RESTRICT,
  owner_id TEXT,
  owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'expired', 'succeeded', 'failed', 'cancelled')),
  lease_until INTEGER CHECK (lease_until IS NULL OR lease_until >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  terminal_at INTEGER CHECK (terminal_at IS NULL OR terminal_at >= 0),
  result_json TEXT,
  error_json TEXT,
  UNIQUE(work_id, owner_epoch),
  CHECK (updated_at >= created_at),
  CHECK (
    (status = 'pending' AND owner_id IS NULL AND lease_until IS NULL AND terminal_at IS NULL)
    OR (status = 'running' AND owner_id IS NOT NULL AND lease_until IS NOT NULL AND terminal_at IS NULL)
    OR (status = 'expired' AND lease_until IS NULL AND terminal_at IS NULL)
    OR (status IN ('succeeded', 'failed', 'cancelled') AND lease_until IS NULL AND terminal_at IS NOT NULL)
  )
);
CREATE TABLE IF NOT EXISTS attempt_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  work_id TEXT NOT NULL REFERENCES work_items(work_id) ON DELETE RESTRICT,
  attempt_id TEXT REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  owner_epoch INTEGER CHECK (owner_epoch IS NULL OR owner_epoch >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('attempt_created', 'lease_acquired', 'lease_expired', 'attempt_retried', 'attempt_succeeded', 'attempt_failed', 'attempt_cancelled')),
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX IF NOT EXISTS idx_attempts_work ON attempts(work_id);
CREATE INDEX IF NOT EXISTS idx_attempt_events_work_seq ON attempt_events(work_id, seq);
`;

/**
 * Physical v3 is intentionally additive. `schema_version` in MeshData remains
 * v2: these columns are implementation authority, not a public ledger shape.
 */
const LIFECYCLE_SCHEMA_V3 = `
CREATE INDEX IF NOT EXISTS idx_attempts_due ON attempts(status, eligible_at, work_id);
CREATE INDEX IF NOT EXISTS idx_work_items_fleet_status ON work_items(fleet_id, status);
CREATE TABLE IF NOT EXISTS lifecycle_event_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at INTEGER NOT NULL,
  claimed_by TEXT,
  claimed_at INTEGER,
  projected_at INTEGER
);
CREATE TRIGGER IF NOT EXISTS lifecycle_work_retry_policy_insert
BEFORE INSERT ON work_items WHEN NEW.max_attempts < 1 OR NEW.retry_base_ms < 0
BEGIN SELECT RAISE(ABORT, 'invalid lifecycle retry policy'); END;
CREATE TRIGGER IF NOT EXISTS lifecycle_work_retry_policy_update
BEFORE UPDATE OF max_attempts, retry_base_ms ON work_items WHEN NEW.max_attempts < 1 OR NEW.retry_base_ms < 0
BEGIN SELECT RAISE(ABORT, 'invalid lifecycle retry policy'); END;
CREATE TRIGGER IF NOT EXISTS lifecycle_attempt_schedule_insert
BEFORE INSERT ON attempts WHEN NEW.attempt_number < 1 OR NEW.eligible_at < 0
BEGIN SELECT RAISE(ABORT, 'invalid lifecycle attempt schedule'); END;
CREATE TRIGGER IF NOT EXISTS lifecycle_attempt_schedule_update
BEFORE UPDATE OF attempt_number, eligible_at ON attempts WHEN NEW.attempt_number < 1 OR NEW.eligible_at < 0
BEGIN SELECT RAISE(ABORT, 'invalid lifecycle attempt schedule'); END;
`;

type A2aSchemaObject = {
  type: "table" | "index" | "trigger";
  name: string;
  table: string;
  sql: string;
  faultStep: string;
};

const a2aSafeInteger = (column: string): string => "typeof(" + column + ") = 'integer' AND " + column + " BETWEEN 0 AND " + SQLITE_SAFE_INTEGER;
const a2aKeyId = (column: string): string => "typeof(" + column + ") = 'text' AND length(" + column + ") BETWEEN 1 AND 64 AND " + column + " NOT GLOB '*[^A-Za-z0-9._-]*'";
const a2aOpaque32 = (column: string): string => "typeof(" + column + ") = 'text' AND length(" + column + ") = 43 AND " + column + " NOT GLOB '*[^A-Za-z0-9_-]*' AND substr(" + column + ", 43, 1) GLOB '[AEIMQUYcgkosw048]'";
const a2aCanonicalDigest = (column: string): string => "typeof(" + column + ") = 'text' AND length(" + column + ") = 100 AND substr(" + column + ", 1, 36) = 'meshfleet.a2a.fingerprint.v1:sha256:' AND substr(" + column + ", 37) NOT GLOB '*[^0-9a-f]*'";
const a2aAuthorizationDigest = (column: string): string => "typeof(" + column + ") = 'text' AND length(" + column + ") = 71 AND substr(" + column + ", 1, 7) = 'sha256:' AND substr(" + column + ", 8) NOT GLOB '*[^0-9a-f]*'";
const a2aEvaluatorVersion = (column: string): string => "typeof(" + column + ") = 'text' AND length(" + column + ") BETWEEN 1 AND 128 AND " + column + " NOT GLOB '*[^A-Za-z0-9._:-]*'";

const A2A_SCHEMA_V4: readonly A2aSchemaObject[] = [
  {
    type: "table",
    name: "a2a_acceptance_records",
    table: "a2a_acceptance_records",
    faultStep: "v4:acceptance-records",
    sql: "CREATE TABLE a2a_acceptance_records (" +
      "acceptance_id TEXT PRIMARY KEY NOT NULL CHECK (" + a2aOpaque32("acceptance_id") + ")," +
      "semantic_key_id TEXT NOT NULL CHECK (" + a2aKeyId("semantic_key_id") + ")," +
      "semantic_token TEXT NOT NULL CHECK (" + a2aOpaque32("semantic_token") + ")," +
      "canonical_digest TEXT NOT NULL CHECK (" + a2aCanonicalDigest("canonical_digest") + ")," +
      "accepted_at INTEGER NOT NULL CHECK (" + a2aSafeInteger("accepted_at") + ")," +
      "expires_at INTEGER CHECK (expires_at IS NULL OR (" + a2aSafeInteger("expires_at") + " AND expires_at > accepted_at))," +
      "authorization_context_digest TEXT NOT NULL CHECK (" + a2aAuthorizationDigest("authorization_context_digest") + ")," +
      "authorization_evaluator_version TEXT NOT NULL CHECK (" + a2aEvaluatorVersion("authorization_evaluator_version") + ")," +
      "receipt_id TEXT NOT NULL UNIQUE CHECK (" + a2aOpaque32("receipt_id") + ")," +
      "UNIQUE (semantic_key_id, semantic_token)," +
      "UNIQUE (acceptance_id, canonical_digest)," +
      "FOREIGN KEY (receipt_id) REFERENCES a2a_decision_receipts(receipt_id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED" +
    ")",
  },
  {
    type: "table",
    name: "a2a_decision_receipts",
    table: "a2a_decision_receipts",
    faultStep: "v4:decision-receipts",
    sql: "CREATE TABLE a2a_decision_receipts (" +
      "receipt_id TEXT PRIMARY KEY NOT NULL CHECK (" + a2aOpaque32("receipt_id") + ")," +
      "acceptance_id TEXT NOT NULL UNIQUE CHECK (" + a2aOpaque32("acceptance_id") + ")," +
      "decision TEXT NOT NULL CHECK (decision = 'accepted')," +
      "evidence_level TEXT NOT NULL CHECK (evidence_level = 'internal_local_decision')," +
      "decided_at INTEGER NOT NULL CHECK (" + a2aSafeInteger("decided_at") + ")," +
      "UNIQUE (acceptance_id, receipt_id)," +
      "FOREIGN KEY (acceptance_id) REFERENCES a2a_acceptance_records(acceptance_id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED" +
    ")",
  },
  {
    type: "table",
    name: "a2a_request_mappings",
    table: "a2a_request_mappings",
    faultStep: "v4:request-mappings",
    sql: "CREATE TABLE a2a_request_mappings (" +
      "principal_key_id TEXT NOT NULL CHECK (" + a2aKeyId("principal_key_id") + ")," +
      "principal_token TEXT NOT NULL CHECK (" + a2aOpaque32("principal_token") + ")," +
      "request_key_id TEXT NOT NULL CHECK (" + a2aKeyId("request_key_id") + ")," +
      "request_token TEXT NOT NULL CHECK (" + a2aOpaque32("request_token") + ")," +
      "acceptance_id TEXT NOT NULL CHECK (" + a2aOpaque32("acceptance_id") + ")," +
      "receipt_id TEXT NOT NULL CHECK (" + a2aOpaque32("receipt_id") + ")," +
      "canonical_digest TEXT NOT NULL CHECK (" + a2aCanonicalDigest("canonical_digest") + ")," +
      "mapped_at INTEGER NOT NULL CHECK (" + a2aSafeInteger("mapped_at") + ")," +
      "outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'duplicate'))," +
      "PRIMARY KEY (principal_key_id, principal_token, request_key_id, request_token)," +
      "FOREIGN KEY (acceptance_id, canonical_digest) REFERENCES a2a_acceptance_records(acceptance_id, canonical_digest) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED," +
      "FOREIGN KEY (acceptance_id, receipt_id) REFERENCES a2a_decision_receipts(acceptance_id, receipt_id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED" +
    ")",
  },
  { type: "index", name: "a2a_request_mappings_acceptance_idx", table: "a2a_request_mappings", faultStep: "v4:request-acceptance-index", sql: "CREATE INDEX a2a_request_mappings_acceptance_idx ON a2a_request_mappings(acceptance_id)" },
  { type: "index", name: "a2a_request_mappings_receipt_idx", table: "a2a_request_mappings", faultStep: "v4:request-receipt-index", sql: "CREATE INDEX a2a_request_mappings_receipt_idx ON a2a_request_mappings(receipt_id)" },
  ...(["a2a_acceptance_records", "a2a_request_mappings", "a2a_decision_receipts"] as const).flatMap((table) => [
    { type: "trigger" as const, name: table + "_no_update", table, faultStep: "v4:" + table + "-no-update", sql: "CREATE TRIGGER " + table + "_no_update BEFORE UPDATE ON " + table + " BEGIN SELECT RAISE(ABORT, '" + table + " is append-only'); END" },
    { type: "trigger" as const, name: table + "_no_delete", table, faultStep: "v4:" + table + "-no-delete", sql: "CREATE TRIGGER " + table + "_no_delete BEFORE DELETE ON " + table + " BEGIN SELECT RAISE(ABORT, '" + table + " is append-only'); END" },
  ]),
];

function asciiFold(value: string): string {
  return value.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

function schemaSqlTokens(sql: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    if (/\s/.test(char)) { index++; continue; }
    if (char === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index++;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) throw new Error("invalid schema SQL: unterminated comment");
      index = end + 2;
      continue;
    }
    if (char === "'") {
      const start = index++;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] !== "'") { index++; continue; }
        if (sql[index + 1] === "'") { index += 2; continue; }
        index++;
        closed = true;
        break;
      }
      if (!closed) throw new Error("invalid schema SQL: unterminated string literal");
      tokens.push("literal:" + sql.slice(start, index));
      continue;
    }
    if (char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      let value = "";
      let closed = false;
      index++;
      while (index < sql.length) {
        if (sql[index] !== close) { value += sql[index++]; continue; }
        if (sql[index + 1] === close) { value += close; index += 2; continue; }
        index++;
        closed = true;
        break;
      }
      if (!closed) throw new Error("invalid schema SQL: unterminated quoted identifier");
      tokens.push("identifier:" + asciiFold(value));
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(char)) {
      const start = index++;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index]!)) index++;
      tokens.push("identifier:" + asciiFold(sql.slice(start, index)));
      continue;
    }
    tokens.push("punctuation:" + char);
    index++;
  }
  while (tokens.at(-1) === "punctuation:;") tokens.pop();
  return tokens;
}

function schemaSqlMatches(actual: string, expected: string): boolean {
  const actualTokens = schemaSqlTokens(actual);
  const expectedTokens = schemaSqlTokens(expected);
  return actualTokens.length === expectedTokens.length && actualTokens.every((token, index) => token === expectedTokens[index]);
}

function a2aSchemaRows(db: Database.Database): Array<{ type: string; name: string; tbl_name: string; sql: string | null }> {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND type IN ('table', 'index', 'trigger', 'view') AND (lower(name) GLOB 'a2a_*' OR lower(tbl_name) IN ('a2a_acceptance_records', 'a2a_request_mappings', 'a2a_decision_receipts')) ORDER BY type, name").all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
}

function unexpectedA2aSchemaObject(db: Database.Database, permitExpectedObjects: boolean): { type: string; name: string } | undefined {
  const expected = new Set(A2A_SCHEMA_V4.map((item) => item.type + ":" + asciiFold(item.name)));
  const tables = ["a2a_acceptance_records", "a2a_request_mappings", "a2a_decision_receipts"];
  const rows = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND type IN ('table', 'index', 'trigger', 'view') ORDER BY type, name").all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  return rows.find((row) => {
    if (permitExpectedObjects && expected.has(row.type + ":" + asciiFold(row.name))) return false;
    const name = asciiFold(row.name);
    const table = asciiFold(row.tbl_name);
    const sqlTokens = new Set(schemaSqlTokens(row.sql));
    return name.startsWith("a2a_") || tables.includes(table) || tables.some((candidate) => sqlTokens.has("identifier:" + candidate));
  });
}

function preflightA2aNamespace(db: Database.Database): void {
  const reserved = unexpectedA2aSchemaObject(db, false);
  if (reserved) throw new Error("refusing v4 migration: reserved or dependent A2A " + reserved.type + " already exists (" + reserved.name + ")");
}

function validateA2aV4Layout(db: Database.Database): void {
  const unexpected = unexpectedA2aSchemaObject(db, true);
  if (unexpected) throw new Error("invalid v4 a2a layout: unexpected or dependent " + unexpected.type + " " + unexpected.name);
  const actual = a2aSchemaRows(db);
  if (actual.length !== A2A_SCHEMA_V4.length) throw new Error("invalid v4 a2a layout: unexpected object count");
  const expected = new Map(A2A_SCHEMA_V4.map((item) => [item.type + ":" + asciiFold(item.name), item]));
  for (const row of actual) {
    const item = expected.get(row.type + ":" + asciiFold(row.name));
    if (!item || asciiFold(row.tbl_name) !== item.table || row.sql === null || !schemaSqlMatches(row.sql, item.sql)) {
      throw new Error("invalid v4 a2a layout: " + row.type + " " + row.name);
    }
  }
  if ((db.pragma("foreign_keys", { simple: true }) as number) !== 1) throw new Error("invalid v4 a2a layout: foreign_keys is disabled");
  if ((db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length !== 0) throw new Error("invalid v4 a2a layout: foreign key check failed");
  const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check?: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error("invalid v4 a2a layout: integrity check failed");
}

/** Internal guard used as the first operation in every durable-acceptance transaction. */
export function assertA2aDurableSchema(db: Database.Database): void {
  const version = physicalStorageVersion(db);
  if (version !== 4) throw new Error("durable acceptance requires physical storage schema version 4");
  validateA2aV4Layout(db);
}

function ensureColumn(db: Database.Database, table: "fleets" | "work_items" | "attempts", column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function backfillAttemptNumbers(db: Database.Database, resetEligibility: boolean): void {
  const rows = db.prepare("SELECT attempt_id, work_id FROM attempts ORDER BY work_id, created_at, attempt_id").all() as Array<{ attempt_id: string; work_id: string }>;
  const update = db.prepare(resetEligibility
    ? "UPDATE attempts SET attempt_number = ?, eligible_at = 0 WHERE attempt_id = ?"
    : "UPDATE attempts SET attempt_number = ? WHERE attempt_id = ?");
  let workId = "";
  let number = 0;
  for (const row of rows) {
    if (row.work_id !== workId) { workId = row.work_id; number = 0; }
    if (resetEligibility) update.run(++number, row.attempt_id);
    else update.run(++number, row.attempt_id);
  }
}

function attemptNumbersNeedRepair(db: Database.Database): boolean {
  const indexes = db.prepare("PRAGMA index_list(attempts)").all() as Array<{ name: string; unique: number }>;
  const unique = indexes.some((index) => index.name === "idx_attempts_work_number" && index.unique === 1);
  const duplicate = db.prepare("SELECT 1 FROM attempts GROUP BY work_id, attempt_number HAVING COUNT(*) > 1 LIMIT 1").get();
  return !unique || Boolean(duplicate);
}

function ensureOutboxSequence(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(lifecycle_event_outbox)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "seq")) return;
  db.exec(`
    CREATE TABLE lifecycle_event_outbox_v3 (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      event TEXT NOT NULL,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      created_at INTEGER NOT NULL,
      claimed_by TEXT,
      claimed_at INTEGER,
      projected_at INTEGER
    );
    INSERT INTO lifecycle_event_outbox_v3 (event_id, event, payload, created_at, claimed_by, claimed_at, projected_at)
      SELECT event_id, event, payload, created_at, claimed_by, claimed_at, projected_at
      FROM lifecycle_event_outbox ORDER BY created_at, rowid;
    DROP TABLE lifecycle_event_outbox;
    ALTER TABLE lifecycle_event_outbox_v3 RENAME TO lifecycle_event_outbox;
  `);
}

let storageMigrationFaultForTest = false;
let storageMigrationFaultStepForTest: string | null = null;

/** Test-only fault injection proving a failing migration rolls back completely. */
export function setStorageMigrationFaultForTest(enabled: boolean): void {
  storageMigrationFaultForTest = enabled;
}

/** Test-only v4 fault injection after an individual DDL or version-marker step. */
export function setStorageMigrationFaultStepForTest(step: string | null): void {
  storageMigrationFaultStepForTest = step;
}

function maybeFailStorageMigration(step: string): void {
  if (storageMigrationFaultStepForTest === step) throw new Error("forced storage migration failure at " + step);
}

function hasInitializedPhysicalStorage(db: Database.Database): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name IN ('work_items', 'attempts', 'attempt_events', 'lifecycle_event_outbox') LIMIT 1").get());
}

function physicalStorageVersion(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'storage_schema_version'").get() as { value: string } | undefined;
  if (!row) {
    if (hasInitializedPhysicalStorage(db)) throw new Error("unsupported storage schema version: missing");
    return 1;
  }
  if (!/^[1-9]\d*$/.test(row.value)) throw new Error(`unsupported storage schema version: ${row.value}`);
  return Number(row.value);
}

function migrateA2aV4(db: Database.Database): void {
  preflightA2aNamespace(db);
  for (const object of A2A_SCHEMA_V4) {
    db.exec(object.sql);
    maybeFailStorageMigration(object.faultStep);
  }
  validateA2aV4Layout(db);
  const result = db.prepare("UPDATE meta SET value = '4' WHERE key = 'storage_schema_version'").run();
  if (result.changes !== 1) throw new Error("invalid v4 migration: missing storage schema marker");
  maybeFailStorageMigration("v4:version-marker");
}

function migrateStorage(db: Database.Database): void {
  const migrate = db.transaction(() => {
    let version = physicalStorageVersion(db);
    if (version > CURRENT_STORAGE_SCHEMA_VERSION) {
      throw new Error(
        `unsupported newer storage schema version ${version}; this meshfleet build supports up to ${CURRENT_STORAGE_SCHEMA_VERSION}`
      );
    }
    while (version < 3) {
      if (version === 1) {
        db.exec(LIFECYCLE_SCHEMA_V2);
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('storage_schema_version', '2')").run();
        version = 2;
        continue;
      }
      if (version !== 2) throw new Error(`unsupported storage schema migration from version ${version}`);
      // Some early v2 development layouts carried one or more v3 columns
      // without advancing meta. Treat them as a resumable physical migration.
      ensureColumn(db, "fleets", "lifecycle_mode", "lifecycle_mode TEXT CHECK (lifecycle_mode IN ('legacy', 'shadow', 'durable') OR lifecycle_mode IS NULL)");
      ensureColumn(db, "work_items", "agent_id", "agent_id TEXT");
      ensureColumn(db, "work_items", "max_attempts", "max_attempts INTEGER NOT NULL DEFAULT 3");
      ensureColumn(db, "work_items", "retry_base_ms", "retry_base_ms INTEGER NOT NULL DEFAULT 1000");
      ensureColumn(db, "work_items", "retry_jitter", "retry_jitter INTEGER NOT NULL DEFAULT 1 CHECK (retry_jitter IN (0, 1))");
      ensureColumn(db, "attempts", "attempt_number", "attempt_number INTEGER NOT NULL DEFAULT 1");
      ensureColumn(db, "attempts", "eligible_at", "eligible_at INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "attempts", "runtime_pid", "runtime_pid INTEGER");
      ensureColumn(db, "attempts", "runtime_meta_json", "runtime_meta_json TEXT");
      // v2 did not persist scheduling. Every pre-v3 pending attempt was
      // eligible immediately; assign deterministic ordinal attempts before
      // installing the per-work uniqueness constraint.
      backfillAttemptNumbers(db, true);
      db.exec(LIFECYCLE_SCHEMA_V3);
      ensureOutboxSequence(db);
      db.exec("CREATE INDEX IF NOT EXISTS idx_lifecycle_outbox_due ON lifecycle_event_outbox(projected_at, claimed_at, seq)");
      if (storageMigrationFaultForTest) throw new Error("forced storage migration failure");
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('storage_schema_version', '3')").run();
      version = 3;
    }
    if (version === 3) {
      // Repair partial/early v3 layouts on open without advancing the logical
      // ledger schema or making an already-valid migration non-idempotent.
      ensureColumn(db, "attempts", "runtime_pid", "runtime_pid INTEGER");
      ensureColumn(db, "attempts", "runtime_meta_json", "runtime_meta_json TEXT");
      ensureColumn(db, "attempts", "launch_intent_at", "launch_intent_at INTEGER");
      ensureColumn(db, "attempts", "launch_registered_at", "launch_registered_at INTEGER");
      db.exec(LIFECYCLE_SCHEMA_V3);
      ensureOutboxSequence(db);
      if (attemptNumbersNeedRepair(db)) backfillAttemptNumbers(db, false);
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_work_number ON attempts(work_id, attempt_number)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_lifecycle_outbox_due ON lifecycle_event_outbox(projected_at, claimed_at, seq)");
      migrateA2aV4(db);
      version = 4;
    }
    if (version === 4) validateA2aV4Layout(db);
  }).immediate;
  migrate();
}

/** Read-only physical layout diagnostic for isolated storage tests and tooling. */
export function getStorageSchemaVersion(): number {
  return physicalStorageVersion(getDb());
}

function getDb(): Database.Database {
  if (handle) return handle;
  const file = resolveDbFile();
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { timeout: 5000 });
  // busy_timeout MUST be set before the WAL conversion below — converting the
  // journal mode needs a write lock, and a cold multi-process first-open would
  // otherwise throw "database is locked" instead of waiting.
  try {
    db.pragma("foreign_keys = ON"); // enforce relational lifecycle invariants on every handle
    if ((db.pragma("foreign_keys", { simple: true }) as number) !== 1) throw new Error("SQLite foreign_keys could not be enabled");
    db.pragma("busy_timeout = 5000"); // wait for a concurrent writer instead of erroring
    // The WAL conversion is the one statement busy_timeout does NOT cover:
    // SQLite skips the busy handler on the lock upgrade journal-mode changes
    // need (its deadlock-avoidance path), so N processes racing to initialize
    // a COLD file — a real multi-session first boot — get an instant
    // SQLITE_BUSY however long the timeout is. Found by the concurrent-migrator
    // race test. Bounded retry is the documented remedy; once any process has
    // converted the file, this succeeds immediately for everyone after.
    {
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          db.pragma("journal_mode = WAL"); // local-disk only; the ledger lives under ~/.config
          break;
        } catch (err) {
          // Prefix match: better-sqlite3 surfaces extended result codes, so the
          // busy family arrives as SQLITE_BUSY_RECOVERY / SQLITE_BUSY_TIMEOUT /
          // SQLITE_BUSY_SNAPSHOT as well as plain SQLITE_BUSY.
          const code = (err as { code?: string }).code ?? "";
          if (!code.startsWith("SQLITE_BUSY") || Date.now() > deadline) throw err;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // synchronous 5ms backoff
        }
      }
    }
    db.pragma("synchronous = NORMAL"); // WAL-recommended; durable except last txn on OS crash
    db.exec(SCHEMA);
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(CURRENT_SCHEMA_VERSION)
    );
    migrateStorage(db);
  } catch (err) {
    // Never leak a half-initialized connection (its locks/sidecars linger,
    // especially on Windows) — close before rethrowing.
    try { db.close(); } catch { /* best-effort */ }
    throw err;
  }
  handle = db;
  return db;
}

/** The raw setDbPath override (may be hidden beneath a MESHFLEET_DB_FILE env override). */
export function getDbPathOverride(): string | null {
  return dbFile;
}

/**
 * Read a MeshData snapshot from an ARBITRARY ledger file via a dedicated
 * READ-ONLY connection — no pragmas that write, no schema creation, no meta
 * insert, and zero interaction with the global handle or path config. This is
 * the audit path: verification must never alter the evidence it audits. A
 * SQLite file lacking the mesh tables throws a legible diagnosis.
 */
export function readLedgerFile(file: string): MeshData {
  if (!existsSync(file)) throw new Error(`ledger file not found: ${file}`);
  // Audit a PRIVATE TEMP COPY: even a readonly SQLite connection creates
  // -wal/-shm sidecars beside a WAL-mode file, and evidence handling forbids
  // touching the original in any way. Copying the sidecars too means a ledger
  // copied mid-WAL (rows still in the -wal) reads completely instead of
  // looking truncated. The original is untouched by construction.
  const tmp = mkdtempSync(join(tmpdir(), "meshfleet-audit-"));
  const copy = join(tmp, "audit.db");
  try {
    // Sidecars BEFORE main: if a live writer checkpoints between the copies,
    // the newer main file makes the older WAL's salts/checksums mismatch and
    // SQLite ignores it — yielding a consistent (checkpointed) read instead of
    // torn state. The file-audit contract remains "frozen evidence"; auditing
    // a ledger under active write is what the no-arg --verify (single
    // transaction on the live handle) is for.
    for (const ext of ["-shm", "-wal"]) {
      if (existsSync(file + ext)) copyFileSync(file + ext, copy + ext);
    }
    copyFileSync(file, copy);
    const db = new Database(copy, { readonly: true, fileMustExist: true });
    try {
      return readState(db);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (/no such table/i.test(detail)) {
        throw new Error(
          `not a meshfleet ledger: ${file} — it is a SQLite database, but the mesh tables are missing (${detail})`
        );
      }
      throw err;
    } finally {
      db.close();
    }
  } finally {
    // Best-effort: a cleanup failure (EBUSY/EPERM) must never mask the audit
    // result or error; a leaked temp dir is the lesser harm.
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* leak beats mask */ }
  }
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
      `INSERT INTO ${this.spec.table} (${this.spec.cols.join(",")}) VALUES (${this.spec.cols.map(() => "?").join(",")}) ON CONFLICT(${this.spec.pk}) DO UPDATE SET ${this.spec.cols.filter((column) => column !== this.spec.pk).map((column) => `${column} = excluded.${column}`).join(", ")}`,
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
  const upsert = db.prepare(`INSERT INTO ${spec.table} (${spec.cols.join(",")}) VALUES (${spec.cols.map(() => "?").join(",")}) ON CONFLICT(${spec.pk}) DO UPDATE SET ${spec.cols.filter((column) => column !== spec.pk).map((column) => `${column} = excluded.${column}`).join(", ")}`);
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
function mutateLedger<T>(db: Database.Database, mutator: (data: MeshData, db: Database.Database) => T): T {
    txnStats = { rowsParsed: 0 };
    const views = new Map<CollSpec, LazyColl>();
    const data = emptyData();
    for (const c of COLLECTIONS) {
      const view = new LazyColl(db, c);
      views.set(c, view);
      (data as unknown as Record<string, unknown>)[c.table] = view.proxy;
    }
    const result = mutator(data, db);
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
}

export function withLedger<T>(mutator: (data: MeshData) => T): T {
  const db = getDb();
  return db.transaction(() => mutateLedger(db, (data) => mutator(data))).immediate();
}

/**
 * Unified immediate transaction seam. Compatibility projections and callers'
 * transaction-scoped lifecycle repositories share one SQLite handle and one
 * commit; lifecycle code must not open a nested self-transaction here.
 */
export function withLedgerAndStorage<T>(mutator: (data: MeshData, db: Database.Database) => T): T {
  const db = getDb();
  return db.transaction(() => mutateLedger(db, mutator)).immediate();
}

/**
 * Private relational-storage transaction seam. Lifecycle storage uses this
 * instead of `withLedger` so a lifecycle state transition and its event can be
 * one immediate SQLite transaction without materializing or rewriting MeshData.
 */
export function withStorageTransaction<T>(mutator: (db: Database.Database) => T): T {
  const db = getDb();
  const run = db.transaction((database: Database.Database) => {
    const result = mutator(database);
    if (result != null && typeof (result as { then?: unknown }).then === "function") {
      throw new Error("withStorageTransaction: mutator must be synchronous (it returned a Promise)");
    }
    return result;
  }).immediate;
  return run(db);
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
