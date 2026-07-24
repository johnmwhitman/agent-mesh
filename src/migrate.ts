/**
 * One-shot JSON→SQLite ledger migrator (Phase 2).
 *
 * The live ledger moved from a single `agent-mesh.json` file to a SQLite db (the
 * `withLedger` seam). On the first boot after the upgrade, the parent MCP server
 * migrates the existing JSON ledger into SQLite ONCE, stop-the-world, before any
 * agent is spawned or any reader/writer touches the db.
 *
 * Ownership model (this is the part three adversarial review passes kept
 * finding holes in, so it is stated as law):
 *
 *  1. decide → import → validate is ONE `BEGIN IMMEDIATE` transaction. The
 *     emptiness check that AUTHORIZES the wholesale import runs under the same
 *     exclusive write lock as the import itself, so no writer — including a
 *     second migrator — can commit rows between the decision and the replace.
 *     Checks performed outside the transaction are advisory fast-paths only.
 *  2. This process never deletes a db file. It may not own it: ordinary startup
 *     materializes the db as a side effect, and another process may be live on
 *     it. A failed validation THROWS, which rolls the whole transaction back —
 *     the db returns to exactly the state the transaction found it in.
 *  3. The JSON is retired (renamed, kept as a backup) only AFTER the import
 *     transaction commits, and only by the process whose transaction performed
 *     the import. A racing migrator that finds the db already populated returns
 *     without touching the JSON — so the "A renames the source, B reads the
 *     missing file as empty and imports nothing over A's data" interleaving is
 *     closed: B's authorizing check sees A's committed rows first.
 *
 * Safety (from the design spec):
 *  - Reuses `loadDataFromFile`, so a v1 ledger is backfilled to v2 and a CORRUPT
 *    ledger is quarantined + logged (never silently dropped) before import.
 *  - Validates the import round-trips (row counts + content hash) INSIDE the
 *    transaction, reading through the same handle so it sees the uncommitted
 *    writes. On any mismatch it throws — the transaction rolls back and the
 *    JSON is left authoritative (fail-closed; never a half-written db, never
 *    data loss, never an unlink).
 *  - Idempotent: a no-op when a POPULATED db already exists, or when there is no
 *    JSON. An empty db (materialized by ordinary startup recovery) is still
 *    migrated into, so a boot that created one does not strand the JSON ledger.
 */
import { existsSync, renameSync } from "fs";
import { createHash } from "crypto";
import { loadDataFromFile, resolveDataFile, isDataFileDeclared, type MeshData } from "./core.js";
import {
  readLedger,
  importSnapshot,
  resolveDbFile,
  defaultDbFile,
  isLedgerFileEmpty,
  isOpenLedgerEmpty,
  withImmediateTransaction,
} from "./db.js";

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

export interface MigrationResult {
  migrated: boolean;
  reason?: string;
  rowCount?: number;
  backupPath?: string;
  /**
   * True only for the isolation refusal below — a migration that COULD have run
   * and was deliberately declined. The ordinary no-ops (db already populated, no
   * JSON to migrate) leave this unset, so a caller can surface this one case
   * without printing a line on every healthy boot.
   */
  refused?: boolean;
}

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

/**
 * Migrate the JSON ledger into SQLite if — and only if — the SQLite ledger is
 * empty (or absent) and a JSON ledger exists. Safe to call unconditionally at
 * startup.
 */
export function migrateJsonToSqlite(): MigrationResult {
  const dbFile = resolveDbFile();
  const jsonFile = resolveDataFile();

  if (!existsSync(jsonFile)) return { migrated: false, reason: "no json ledger to migrate" };

  // Advisory fast-path: a populated db means the migration already happened.
  // This early-out authorizes NOTHING — the binding emptiness check runs again
  // under the import transaction below. It exists so a healthy boot never has
  // to take a write lock, and so a non-SQLite file at the db path is answered
  // here ("already present", conservatively) instead of exploding in getDb().
  if (existsSync(dbFile) && !isLedgerFileEmpty(dbFile)) {
    return { migrated: false, reason: "sqlite ledger already present" };
  }

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
  //
  // Checked BEFORE the transaction (and thus before getDb()): a refused
  // migration must not materialize a db file at the relocated path as a side
  // effect of deciding not to migrate into it.
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

  // ONE transaction: authorize, import, validate. `BEGIN IMMEDIATE` takes the
  // write lock up front; a concurrent writer or second migrator serializes
  // behind it (or times out loudly via busy_timeout — a loud SQLITE_BUSY on a
  // pathological first boot beats a silent lost row).
  const txn = withImmediateTransaction((): { result: MigrationResult; imported: boolean } => {
    // AUTHORIZING check, under the write lock. The advisory checks above may
    // be stale by now: a writer or another migrator can have committed rows
    // since. Wholesale-importing over those rows would erase them — this
    // re-check is the fix for exactly that erasure, found in review.
    if (!isOpenLedgerEmpty()) {
      return {
        result: { migrated: false, reason: "sqlite ledger already populated (found under the import transaction)" },
        imported: false,
      };
    }
    // The JSON can legitimately be gone by now too: a concurrent migrator that
    // committed first has renamed it to its backup path. Its import stands.
    if (!existsSync(jsonFile)) {
      return {
        result: { migrated: false, reason: "json ledger already retired (concurrent migration completed first)" },
        imported: false,
      };
    }

    // loadDataFromFile backfills v1→v2 and quarantines a corrupt file (returning
    // empty + logging loudly). If the file was corrupt it is already renamed to
    // `.corrupt-<ts>`, so there is nothing left to retire below.
    const source = loadDataFromFile(jsonFile);
    const expectedCount = rowCount(source);
    const expectedPrint = fingerprint(source);

    // A nested transaction seam becomes a savepoint inside this transaction.
    importSnapshot(source);

    // Validate the round-trip INSIDE the transaction — same handle, so the
    // read sees the uncommitted import.
    const roundTrip = readLedger();
    const gotCount = rowCount(roundTrip);
    const gotPrint = fingerprint(roundTrip);

    if (gotCount !== expectedCount || gotPrint !== expectedPrint) {
      // Fail-closed: the throw rolls the WHOLE transaction back, returning the
      // db to exactly the state the transaction found it in. Nothing is
      // deleted — this process may not own the db file, and does not need to:
      // rollback already un-does the import.
      throw new Error(
        `JSON→SQLite migration validation FAILED (rows ${gotCount}/${expectedCount}, ` +
          `hash ${gotPrint === expectedPrint ? "ok" : "MISMATCH"}). ` +
          `Import rolled back; ${jsonFile} left authoritative. No data lost.`
      );
    }

    return { result: { migrated: true, rowCount: gotCount }, imported: true };
  });

  // Retire the JSON only AFTER the commit above, and only in the process whose
  // transaction performed the import. Renaming before the commit loses the
  // source if the commit then fails; renaming from a process that did NOT
  // import is the double-migrator erasure. Kept as a backup, never deleted.
  if (txn.imported) {
    if (existsSync(jsonFile)) {
      const backupPath = `${jsonFile}.migrated.${Date.now()}`;
      try {
        renameSync(jsonFile, backupPath);
        txn.result.backupPath = backupPath;
      } catch (err) {
        // The import itself is committed and durable — do not throw away a
        // successful migration over a rename failure, but never be silent
        // about the stranded source either: if it lingers, a future operator
        // deleting the db file would resurrect this stale JSON on next boot.
        txn.result.reason =
          `imported, but could not retire the json source (${err instanceof Error ? err.message : String(err)}); ` +
          `remove or rename ${jsonFile} manually`;
        console.error(`meshfleet migration WARNING: ${txn.result.reason}`);
      }
    } else {
      txn.result.reason = "source was quarantined as corrupt";
    }
  }

  return txn.result;
}
