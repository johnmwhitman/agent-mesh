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
 *  - Idempotent: a no-op when a POPULATED db already exists, or when there is no JSON.
 *    An empty db (materialized by ordinary startup recovery) is still migrated into,
 *    so a boot that created one does not strand the JSON ledger forever.
 */
import { existsSync, renameSync, rmSync } from "fs";
import { createHash } from "crypto";
import { loadDataFromFile, resolveDataFile, isDataFileDeclared, type MeshData } from "./core.js";
import { readLedger, importSnapshot, resolveDbFile, defaultDbFile, isLedgerFileEmpty, closeDb } from "./db.js";

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
  /**
   * True only for the isolation refusal below — a migration that COULD have run
   * and was deliberately declined. The ordinary no-ops (db already present, no
   * JSON to migrate) leave this unset, so a caller can surface this one case
   * without printing a line on every healthy boot.
   */
  refused?: boolean;
}

/**
 * Migrate the JSON ledger into SQLite if — and only if — the SQLite db does not
 * yet exist and a JSON ledger does. Safe to call unconditionally at startup.
 */
/**
 * The isolation policy, as a pure decision.
 *
 * Extracted so it can be tested exhaustively without a filesystem or an
 * environment — the earlier integration-only tests could not express
 * "undeclared JSON at the default path" without pointing at the developer's REAL
 * ledger, and one of them consequently consumed it. A guard whose test has to
 * break isolation to check isolation is the wrong shape.
 */
export function shouldRefuseMigration(input: {
  /** Is the destination db genuinely somewhere other than the compiled default? */
  dbRelocated: boolean;
  /** Is there a JSON ledger that would actually be consumed? */
  jsonExists: boolean;
  /** Did the caller explicitly name the JSON source? */
  dataDeclared: boolean;
}): boolean {
  // Nothing to consume => nothing to protect, so never warn about it.
  if (!input.jsonExists) return false;
  // The db is where it always was: an ordinary first-boot upgrade.
  if (!input.dbRelocated) return false;
  // Relocated destination + an undeclared source = the accident this exists for.
  return !input.dataDeclared;
}

export function migrateJsonToSqlite(): MigrationResult {
  const dbFile = resolveDbFile();
  const jsonFile = resolveDataFile();

  // An existing db normally means the migration already happened. An EMPTY one
  // does not: a single boot materializes the db as a side effect of ordinary
  // startup recovery (repairLifecycleOutbox -> getDb -> mkdir + CREATE TABLE)
  // even when nothing was migrated. Treating that as "already migrated" strands
  // the JSON permanently — and it is precisely the trap the refusal below would
  // otherwise set: refuse -> startup creates an empty db -> operator follows the
  // printed remedy -> next boot short-circuits here and the remedy silently does
  // nothing. Migrating into a db with no rows is safe (nothing to overwrite) and
  // is what makes that remedy true.
  if (existsSync(dbFile) && !isLedgerFileEmpty(dbFile)) {
    return { migrated: false, reason: "sqlite ledger already present" };
  }

  if (!existsSync(jsonFile)) return { migrated: false, reason: "no json ledger to migrate" };

  // Redirecting the db WITHOUT redirecting the JSON source used to pair a
  // throwaway destination with the real ledger: migration would import the
  // live JSON into the temp db and then RENAME the live file to
  // `.migrated.<ts>`. Anyone isolating a test, probe, or dogfood run with
  // `MESHFLEET_DB_FILE=$(mktemp -d)/x.db` therefore mutated production state
  // while believing they were sandboxed. (Observed 2026-07-23.)
  //
  // The two sides are tested DIFFERENTLY, on purpose — an adversarial review
  // proposed each rule for both sides and each is wrong on the other:
  //
  //   db side  -> PATH INEQUALITY. What matters is whether the destination is
  //     genuinely somewhere other than the real ledger. Testing mere presence
  //     would treat `MESHFLEET_DB_FILE=<the default path>` — which shell
  //     profiles and docs do export — as isolation and refuse first-boot
  //     migration forever.
  //
  //   json side -> DECLARATION (presence). What matters is whether the caller
  //     consciously named the source. Testing path inequality would reject an
  //     explicit `MESHFLEET_DATA_FILE=<default path>` as "not redirected" and
  //     refuse the very migration that setting it was meant to authorize —
  //     making the remedy this guard recommends fail.
  if (
    shouldRefuseMigration({
      dbRelocated: dbFile !== defaultDbFile(),
      jsonExists: true, // checked above
      dataDeclared: isDataFileDeclared(),
    })
  ) {
    return {
      migrated: false,
      refused: true,
      reason:
        `the ledger db is relocated (${dbFile}) but no JSON ledger path was declared, and a ` +
        `JSON ledger exists at ${jsonFile} — refusing to consume it into a relocated db. To ` +
        "migrate deliberately, also set MESHFLEET_DATA_FILE (naming the default path explicitly " +
        "is enough); an empty db created by a previous boot will be migrated into, so no cleanup " +
        "is needed.",
    };
  }

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
