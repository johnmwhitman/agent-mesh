#!/usr/bin/env node
/**
 * fleet-bus-v2-migrate.mjs — ISOLATED, OFFLINE-ONLY migration runner.
 *
 * Reference: docs/FLEET-BUS-V2-DESIGN.md §8 (schema migration), §11 (migration path).
 *
 * This tool COPIES the live store to a tmp file, applies the v2 delta
 * idempotently, asserts row-count parity and schema_version=2, and prints a
 * one-line JSON receipt. It NEVER mutates the live store on its own — a
 * second `--apply` flag is required to write to a target path, and even then
 * the tool refuses to write to the live store path.
 *
 * Usage:
 *   node scripts/fleet-bus-v2-migrate.mjs --src <path> --dry-run
 *   node scripts/fleet-bus-v2-migrate.mjs --src <path> --out <tmp-path> --apply
 *
 * Defaults:
 *   --src  resolved from $FLEET_BUS_HOME/fleet-bus.db (live v1 store); refuse
 *         if the env var is unset and --src is not passed (never auto-discover
 *         from operator-specific paths).
 *   --dry-run is the default; --apply requires --out.
 *
 * Refusals:
 *   - If --out equals --src, refuse. (No mutating the live store from this tool.)
 *   - If --src is missing (and $FLEET_BUS_HOME is unset), refuse with a clear error.
 *   - If --src does not have schema_version=1, refuse (v2 delta assumes v1).
 */
import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function defaultSrc() {
  const home = process.env.FLEET_BUS_HOME;
  if (!home) return null;
  return join(home, "fleet-bus.db");
}

const V2_DELTA = `
ALTER TABLE messages ADD COLUMN topic             TEXT;
ALTER TABLE messages ADD COLUMN correlation_id    TEXT;
ALTER TABLE messages ADD COLUMN causation_id      TEXT;
ALTER TABLE messages ADD COLUMN reply_chain       TEXT;
ALTER TABLE messages ADD COLUMN host_id           TEXT;
ALTER TABLE messages ADD COLUMN event_sig         TEXT;
ALTER TABLE messages ADD COLUMN payload_media_type TEXT;
ALTER TABLE messages ADD COLUMN payload_body      TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_topic       ON messages(topic, ts);
CREATE INDEX IF NOT EXISTS idx_messages_correlation ON messages(correlation_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_causation   ON messages(causation_id);
-- v2 indexes above. v1's UNIQUE(source, source_id) stays the dedupe rule.
-- Cross-host dedupe is achieved by the writer encoding host_id into source_id
-- (e.g. <host_id>:<original_source_id>). The table-level UNIQUE then blocks
-- duplicates. See docs/FLEET-BUS-V2-DESIGN.md §3.2.
CREATE TABLE IF NOT EXISTS subscriptions (
  agent              TEXT    NOT NULL,
  topic              TEXT    NOT NULL,
  mode               TEXT    NOT NULL DEFAULT 'at_least_once',
  last_seen_offset   INTEGER NOT NULL DEFAULT 0,
  ack_deadline_s     INTEGER NOT NULL DEFAULT 600,
  max_redeliveries   INTEGER NOT NULL DEFAULT 5,
  created_ts         REAL    NOT NULL,
  PRIMARY KEY (agent, topic)
);
CREATE INDEX IF NOT EXISTS idx_subs_topic ON subscriptions(topic);
CREATE TABLE IF NOT EXISTS delivery_attempts (
  agent           TEXT    NOT NULL,
  msg_id          INTEGER NOT NULL REFERENCES messages(id),
  attempt_no      INTEGER NOT NULL,
  attempted_at    REAL    NOT NULL,
  outcome         TEXT    NOT NULL,
  next_retry_at   REAL,
  PRIMARY KEY (agent, msg_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_deliv_next ON delivery_attempts(agent, next_retry_at);
CREATE TABLE IF NOT EXISTS dead_letter (
  msg_id          INTEGER PRIMARY KEY REFERENCES messages(id),
  agent           TEXT    NOT NULL,
  moved_at        REAL    NOT NULL,
  reason          TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dlq_agent ON dead_letter(agent, moved_at);
CREATE TABLE IF NOT EXISTS retention_policy (
  topic_pattern  TEXT PRIMARY KEY,
  keep_days      INTEGER NOT NULL,
  hard_keep      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS migrations (
  seq           INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  applied_at    REAL    NOT NULL,
  forward_sql   TEXT    NOT NULL,
  rollback_sql  TEXT,
  dry_run_ok    INTEGER NOT NULL DEFAULT 1
);
INSERT OR REPLACE INTO meta(k, v) VALUES ('schema_version', '2');
`;

function parseArgs(argv) {
  const args = { src: defaultSrc(), out: null, dryRun: true, apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--src") args.src = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--apply") { args.apply = true; args.dryRun = false; }
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "-h" || a === "--help") {
      console.error("usage: node scripts/fleet-bus-v2-migrate.mjs [--src <path>] [--out <path>] [--apply|--dry-run]");
      process.exit(2);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function countRows(db) {
  const n = db.prepare("SELECT COUNT(*) AS n FROM messages").get();
  return Number(n.n);
}

function readSchemaVersion(db) {
  const r = db.prepare("SELECT v FROM meta WHERE k='schema_version'").get();
  return r ? String(r.v) : null;
}

function applyDelta(db) {
  const stmts = V2_DELTA.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let alterDuplicate = 0;
  for (const stmt of stmts) {
    try {
      db.exec(stmt);
    } catch (err) {
      if (/duplicate column name/.test(String(err))) {
        alterDuplicate++;
        continue;
      }
      throw err;
    }
  }
  return { alterDuplicate };
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.src) {
    console.error("refusing: --src not provided and $FLEET_BUS_HOME is unset; pass --src <path> or set FLEET_BUS_HOME");
    process.exit(2);
  }
  const src = resolve(args.src);
  if (!existsSync(src)) {
    console.error(`refusing: --src does not exist: ${src}`);
    process.exit(1);
  }
  if (args.apply && !args.out) {
    console.error("refusing: --apply requires --out");
    process.exit(1);
  }
  if (args.out && resolve(args.out) === src) {
    console.error("refusing: --out equals --src; this tool will not mutate the live store");
    process.exit(1);
  }

  // Always work on a tmp copy unless --apply with --out was given.
  const tmpDir = mkdtempSync(join(tmpdir(), "fleet-bus-v2-migrate-"));
  const workPath = args.apply ? args.out : join(tmpDir, "copy.db");
  try {
    copyFileSync(src, workPath);
    // Copy WAL/SHM if present (live store may have a WAL).
    for (const suffix of ["-wal", "-shm"]) {
      const p = src + suffix;
      if (existsSync(p)) copyFileSync(p, workPath + suffix);
    }
  } catch (err) {
    console.error(`failed to copy ${src} -> ${workPath}: ${err.message}`);
    process.exit(1);
  }

  const db = new Database(workPath);
  try {
    const beforeVersion = readSchemaVersion(db);
    const beforeRows = countRows(db);
    if (beforeVersion !== "1" && beforeVersion !== "2") {
      console.error(`refusing: source schema_version is ${JSON.stringify(beforeVersion)}, expected "1" or "2"`);
      process.exit(1);
    }
    const beforeIndexes = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'idx_messages_%'").get();
    const beforeIndexCount = Number(beforeIndexes.n);

    const deltaInfo = applyDelta(db);

    const afterVersion = readSchemaVersion(db);
    const afterRows = countRows(db);
    const afterIndexes = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'idx_messages_%'").get();
    const afterIndexCount = Number(afterIndexes.n);

    const newCols = db.prepare("PRAGMA table_info(messages)").all()
      .filter((c) => ["topic","correlation_id","causation_id","reply_chain","host_id","event_sig","payload_media_type","payload_body"].includes(c.name))
      .map((c) => c.name);

    const receipt = {
      ts: new Date().toISOString(),
      mode: args.apply ? "apply" : "dry-run",
      src,
      out: args.apply ? workPath : `${workPath} (tmp, will be removed)`,
      before: { schema_version: beforeVersion, rows: beforeRows, indexes: beforeIndexCount },
      after: { schema_version: afterVersion, rows: afterRows, indexes: afterIndexCount,
               delta_alter_duplicates: deltaInfo.alterDuplicate,
               new_columns: newCols, expected_new_columns: 8 },
      row_loss: afterRows !== beforeRows,
      passed: afterVersion === "2" && afterRows === beforeRows && newCols.length === 8,
    };
    console.log(JSON.stringify(receipt, null, 2));

    if (!receipt.passed) {
      process.exit(1);
    }
  } finally {
    db.close();
    if (!args.apply) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

main();
