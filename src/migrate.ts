/**
 * One-shot JSON→SQLite ledger migrator (Phase 2).
 *
 * The live ledger moved from a single `agent-mesh.json` file to a SQLite db (the
 * `withLedger` seam). On the first boot after the upgrade, the parent MCP server
 * migrates the existing JSON ledger into SQLite ONCE, stop-the-world, before any
 * agent is spawned or any reader/writer touches the db.
 *
 * Safety (from the design spec):
 *  - Reuses `loadDataFromFile`, so a v1 ledger is backfilled to v2 and a CORRUPT
 *    ledger is quarantined + logged (never silently dropped) before import.
 *  - Validates the import round-trips (row counts + content hash) BEFORE retiring
 *    the JSON. On any mismatch it deletes the partial db and THROWS — the JSON is
 *    left authoritative (fail-closed; never a half-written db, never data loss).
 *  - Only retires the JSON on success, by renaming it to `.migrated.<ts>` (kept as
 *    a backup, not deleted).
 *  - Idempotent: a no-op when the db already exists, or when there is no JSON.
 */
import { existsSync, renameSync, rmSync } from "fs";
import { createHash } from "crypto";
import { loadDataFromFile, resolveDataFile, type MeshData } from "./core.js";
import { readLedger, importSnapshot, resolveDbFile, closeDb } from "./db.js";

const COLLECTIONS: (keyof MeshData)[] = [
  "fleets",
  "agents",
  "messages",
  "inboxes",
  "capabilities",
  "receipts",
  "ratifications",
  "templates",
];

function rowCount(data: MeshData): number {
  let n = 0;
  for (const c of COLLECTIONS) n += Object.keys(data[c] ?? {}).length;
  return n;
}

/**
 * Content fingerprint: per collection, the sorted `key=JSON(value)` pairs. The
 * import stores `JSON.stringify(value)` and reads it back via `JSON.parse`, so a
 * value's JSON serialization is preserved across the round-trip — only the
 * collection's key order can differ, hence the sort.
 */
function fingerprint(data: MeshData): string {
  const h = createHash("sha256");
  for (const c of COLLECTIONS) {
    const dict = (data[c] ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(dict).sort()) {
      h.update(`${c}/${k}=${JSON.stringify(dict[k])}\n`);
    }
  }
  return h.digest("hex");
}

/** All SQLite sidecar files for a db path (WAL mode creates -wal / -shm). */
function dbArtifacts(dbFile: string): string[] {
  return [dbFile, `${dbFile}-wal`, `${dbFile}-shm`, `${dbFile}-journal`];
}

export interface MigrationResult {
  migrated: boolean;
  reason?: string;
  rowCount?: number;
  backupPath?: string;
}

/**
 * Migrate the JSON ledger into SQLite if — and only if — the SQLite db does not
 * yet exist and a JSON ledger does. Safe to call unconditionally at startup.
 */
export function migrateJsonToSqlite(): MigrationResult {
  const dbFile = resolveDbFile();
  const jsonFile = resolveDataFile();

  if (existsSync(dbFile)) return { migrated: false, reason: "sqlite ledger already present" };
  if (!existsSync(jsonFile)) return { migrated: false, reason: "no json ledger to migrate" };

  // loadDataFromFile backfills v1→v2 and quarantines a corrupt file (returning
  // empty + logging loudly). If the file was corrupt it is already renamed to
  // `.corrupt-<ts>`, so there is nothing left to retire below.
  const source = loadDataFromFile(jsonFile);
  const expectedCount = rowCount(source);
  const expectedPrint = fingerprint(source);

  // Import into a fresh db. `importSnapshot` creates the db + schema on first open.
  importSnapshot(source);

  // Validate the round-trip before retiring the JSON.
  const roundTrip = readLedger();
  const gotCount = rowCount(roundTrip);
  const gotPrint = fingerprint(roundTrip);

  if (gotCount !== expectedCount || gotPrint !== expectedPrint) {
    // Fail-closed: tear down the partial db and leave the JSON authoritative.
    closeDb();
    for (const f of dbArtifacts(dbFile)) {
      try { rmSync(f, { force: true }); } catch { /* best-effort */ }
    }
    throw new Error(
      `JSON→SQLite migration validation FAILED (rows ${gotCount}/${expectedCount}, ` +
        `hash ${gotPrint === expectedPrint ? "ok" : "MISMATCH"}). ` +
        `Left ${jsonFile} authoritative; removed the partial db. No data lost.`
    );
  }

  // Success. Retire the JSON to a timestamped backup (kept, not deleted) — unless
  // loadDataFromFile already quarantined it as corrupt (renamed to `.corrupt-<ts>`),
  // in which case there is nothing left at jsonFile to retire.
  if (existsSync(jsonFile)) {
    const backupPath = `${jsonFile}.migrated.${Date.now()}`;
    renameSync(jsonFile, backupPath);
    return { migrated: true, rowCount: gotCount, backupPath };
  }
  return { migrated: true, rowCount: gotCount, reason: "source was quarantined as corrupt" };
}
