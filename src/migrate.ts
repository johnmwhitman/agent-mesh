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
 *  - Parses the source ITSELF, before the transaction: a v0/v1 ledger is
 *    backfilled to v2 (`ledgerFromRaw`), a FUTURE-version ledger is refused
 *    untouched (importing it would silently drop unknown collections), and a
 *    CORRUPT
 *    ledger is quarantined + logged (never silently dropped) before import.
 *  - Validates the import round-trips (row counts + content hash) INSIDE the
 *    transaction, reading through the same handle so it sees the uncommitted
 *    writes. On any mismatch it throws — the transaction rolls back and the
 *    JSON is left authoritative (fail-closed; never a half-written db, never
 *    data loss, never an unlink).
 *  - Idempotent: a no-op when a POPULATED db already exists, or when there is no
 *    JSON. An empty db (materialized by ordinary startup recovery) is still
 *    migrated into, so a boot that created one does not strand the JSON ledger.
 *
 * Accepted residuals (reviewed, deliberately not "fixed"):
 *  - A concurrent LEGACY-VERSION writer mutating the JSON mid-migration can have
 *    its newest write renamed into the backup un-imported (TOCTOU between read
 *    and retire). Mixed-version concurrent writers are unsupported by design;
 *    the rename preserves the newer data (recoverable from the backup), it does
 *    not destroy it.
 *  - The crash window between commit and rename is irreducible for a
 *    cross-filesystem sequence. Its residue — populated db + live JSON — is made
 *    LOUD on every later boot rather than silently ignored.
 *  - Startup statements OUTSIDE this migrator (recovery, sweepers) waiting on a
 *    peer's long import are still bound by the connection's 5s busy_timeout and
 *    can fail loudly; a restart recovers, and no data is lost either way. The
 *    migrator itself — including its getDb() cold initialization — retries the
 *    busy family for up to 60s, so a losing migrator serializes instead of
 *    crashing (an earlier revision misclassified the losing migrator as part of
 *    this residual; its getDb() ran outside the retry window).
 */
import { existsSync, renameSync, readFileSync } from "fs";
import { createHash } from "crypto";
import {
  ledgerFromRaw,
  resolveDataFile,
  isDataFileDeclared,
  CURRENT_SCHEMA_VERSION,
  type MeshData,
} from "./core.js";
import {
  readLedger,
  importSnapshot,
  resolveDbFile,
  defaultDbFile,
  probeLedgerFile,
  isOpenLedgerEmpty,
  withImmediateTransaction,
  getMetaValue,
  setMetaValue,
  readLedgerFileMarker,
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
/**
 * Test-only fault hook: force the round-trip validation to report a mismatch,
 * so the full validation-failure path (throw → rollback → db intact → JSON
 * authoritative) is exercisable end-to-end. A real mismatch is not
 * constructible from outside (the import round-trips by design), and the
 * repo's precedent for exactly this shape is setStorageMigrationFaultForTest.
 */
let validationFaultForTest = false;
export function setMigrationValidationFaultForTest(enabled: boolean): void {
  validationFaultForTest = enabled;
}

/**
 * A populated db and a live JSON source coexisting is the residue of an
 * interrupted migration (crash between commit and rename) or of an operator
 * following the refusal remedy after rows already landed. Both used to be
 * SILENT — the fast-path returned a quiet no-op every boot, forever, and a
 * later "delete the db to start fresh" would resurrect the stale JSON. Never
 * auto-rename here (a non-importing process must not touch the source; a
 * mixed-version peer may still be reading it) — but never be quiet either.
 */
function warnDualAuthority(dbFile: string, jsonFile: string): string {
  const msg =
    `a populated sqlite ledger (${dbFile}) AND a json ledger (${jsonFile}) both exist. ` +
    "The sqlite ledger is authoritative; the json was NOT imported this boot and is likely " +
    "left over from an interrupted migration. Rename it aside (any name) to silence this " +
    "warning — if it lingers, deleting the db would silently resurrect this stale snapshot. " +
    "(If another process is migrating right now, this can be a transient race window — " +
    "check whether it persists on the next boot.)";
  console.error(`meshfleet migration WARNING: ${msg}`);
  return msg;
}

export function migrateJsonToSqlite(): MigrationResult {
  const dbFile = resolveDbFile();
  const jsonFile = resolveDataFile();

  if (!existsSync(jsonFile)) return { migrated: false, reason: "no json ledger to migrate" };

  // Advisory fast-path: a POPULATED db means the migration already happened.
  // This early-out authorizes NOTHING — the binding emptiness check runs again
  // under the import transaction below. Only the definitive "populated" answer
  // may short-circuit: `unknown` (locked, unreadable, not SQLite) falls
  // through to the transaction, where a lock serializes properly and garbage
  // fails LOUDLY in getDb() — the boolean predecessor mapped those cases to
  // "already present", silently stranding the JSON with a false reason.
  const probe = probeLedgerFile(dbFile);
  if (probe === "populated") {
    // The JSON exists (checked above) alongside a populated db: say so, loudly,
    // every boot — this is the crash-between-commit-and-rename residue.
    const warning = warnDualAuthority(dbFile, jsonFile);
    return { migrated: false, reason: `sqlite ledger already present; ${warning}` };
  }
  if (probe === "foreign") {
    // A valid SQLite db with rows but no meshfleet identity. Calling it "the
    // ledger already present" would declare an unrelated database authoritative
    // and advise retiring the real JSON against it; proceeding would let
    // getDb() stamp meshfleet schema into a file that belongs to something
    // else. Refuse before touching it — this must throw (fail the boot), not
    // return, because every non-throwing path here implies the ledger question
    // was answered and this one cannot be.
    throw new Error(
      `the file at ${dbFile} is a valid SQLite database but does not look like a meshfleet ` +
        `ledger (it lacks the meshfleet schema signature) — refusing to adopt it, migrate into ` +
        `it, or write schema into it, whether or not it currently holds rows. If ` +
        `MESHFLEET_DB_FILE points at the wrong file, fix it; if this really is the intended ` +
        `destination, move the existing database aside first. ${jsonFile} was not touched.`
    );
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
        "is enough) and restart BEFORE using the server: an empty db created by a previous boot " +
        "will be migrated into, but once any row lands in the relocated db the migration will " +
        "decline (loudly) rather than overwrite it.",
    };
  }

  // Advisory destination-version check, read-only, BEFORE the source parse:
  // the corrupt-path quarantine below is an irreversible rename, so any
  // refusal that is knowable now must fire now — refusing only inside the
  // transaction would quarantine first and then claim the source was left
  // untouched. Advisory only: an unreadable marker skips this, and the
  // BINDING check runs again inside the transaction (the marker can change
  // between here and there).
  {
    const advisoryMarker = readLedgerFileMarker(dbFile);
    if (
      advisoryMarker !== undefined &&
      (!/^(0|[1-9]\d*)$/.test(advisoryMarker) || Number(advisoryMarker) > CURRENT_SCHEMA_VERSION)
    ) {
      throw new Error(
        `JSON→SQLite migration refused: the db at ${dbFile} carries schema_version=` +
          `${JSON.stringify(advisoryMarker)} but this build writes ${CURRENT_SCHEMA_VERSION} — ` +
          `it was likely created by a newer or different meshfleet version. ` +
          `${jsonFile} was not touched. No data lost.`
      );
    }
  }

  // ── Read, bound, and shape the SOURCE — all BEFORE the transaction. ──────
  //
  // Three reviewed defects live (or lived) on this seam, and the pre-parse
  // closes them together:
  //  1. A FUTURE-version source was silently downgraded: migrateLedger accepts
  //     any schema_version >= 2 unchanged, and the collection mapping keeps
  //     only today's known collections — so a v99 ledger imported partially,
  //     validated against its own filtered self, and got retired. The version
  //     is now bounded here, with the file untouched on refusal.
  //  2. The corrupt-path quarantine rename sat INSIDE the transaction — a
  //     filesystem side effect SQL rollback cannot undo, so a late
  //     IOERR/disk-full failure could strand "no live source and no import"
  //     while the error claimed the source was left authoritative. The
  //     quarantine now happens out here, with NOTHING to roll back; the
  //     transaction below performs no filesystem writes at all.
  //  3. Attribution: whether WE quarantined is now a fact this process knows
  //     directly, not an inference from directory diffing (which could blame a
  //     sibling's artifact).
  //
  // TOCTOU note: the imported snapshot is the one parsed here; a writer
  // swapping the file between this read and the commit is the accepted
  // mixed-version residual documented in the header.
  let sourceData: MeshData;
  let quarantinedByUs = false;
  try {
    const raw = JSON.parse(readFileSync(jsonFile, "utf-8")) as Record<string, unknown>;
    const srcVersion = raw.schema_version;
    if (srcVersion !== undefined) {
      if (typeof srcVersion !== "number" || !Number.isInteger(srcVersion) || srcVersion < 0 || srcVersion > CURRENT_SCHEMA_VERSION) {
        throw Object.assign(
          new Error(
            `JSON→SQLite migration refused: ${jsonFile} declares schema_version=${JSON.stringify(srcVersion)} ` +
              `but this build understands versions up to ${CURRENT_SCHEMA_VERSION} — importing it would ` +
              `silently drop anything this build does not know about. The file was NOT touched; ` +
              `migrate it with the meshfleet version that wrote it.`
          ),
          { sourceVersionRefusal: true }
        );
      }
    }
    sourceData = ledgerFromRaw(raw);
  } catch (err) {
    if ((err as { sourceVersionRefusal?: boolean }).sourceVersionRefusal) throw err;
    // Corrupt source: quarantine it NOW, before any transaction exists —
    // loudly, preserving the bytes, with a pid suffix so two processes (or
    // same-ms boots) cannot overwrite each other's artifact.
    const quarantine = `${jsonFile}.corrupt-${Date.now()}-${process.pid}`;
    try {
      renameSync(jsonFile, quarantine);
      quarantinedByUs = true;
      console.error(
        `meshfleet migration: ledger at ${jsonFile} is CORRUPT and was quarantined to ${quarantine}. ` +
          `Migrating an empty ledger — inspect the quarantine file to recover. Error: ${err}`
      );
    } catch (renameErr) {
      console.error(
        `meshfleet migration: ledger at ${jsonFile} is CORRUPT and could NOT be quarantined (${renameErr}). ` +
          `Original parse error: ${err}`
      );
    }
    sourceData = {
      fleets: {}, agents: {}, messages: {}, inboxes: {},
      capabilities: {}, receipts: {}, ratifications: {}, templates: {},
    };
  }

  // ONE transaction: authorize, import, validate — pure SQL, no filesystem
  // effects. `BEGIN IMMEDIATE` takes the write lock up front; a concurrent
  // writer or second migrator serializes behind it. `durable` because the
  // post-commit rename below is irreversible: under WAL + synchronous=NORMAL a
  // power cut can drop the last commit, and a dropped import with an
  // already-renamed source is data loss — FULL makes the commit hit the disk
  // before we act on it. `acquireMs` because a peer's legitimately long import
  // can exceed the 5s busy_timeout — at initialization as well as at BEGIN —
  // and crashing the whole server because a sibling was slow is worse than
  // waiting.
  const txn = withImmediateTransaction(
    (): { result: MigrationResult; imported: boolean } => {
      // AUTHORIZING check, under the write lock. The advisory checks above may
      // be stale by now: a writer or another migrator can have committed rows
      // since. Wholesale-importing over those rows would erase them — this
      // re-check is the fix for exactly that erasure, found in review.
      if (!isOpenLedgerEmpty()) {
        const warning = existsSync(jsonFile) ? `; ${warnDualAuthority(dbFile, jsonFile)}` : "";
        return {
          result: {
            migrated: false,
            reason: `sqlite ledger already populated (found under the import transaction)${warning}`,
          },
          imported: false,
        };
      }
      // The JSON can legitimately be gone by now too: a concurrent migrator
      // that committed first has renamed it to its backup path. Its import
      // stands. (If WE quarantined it above, the import of the resulting empty
      // snapshot must still proceed — skip this check in that case.)
      if (!quarantinedByUs && !existsSync(jsonFile)) {
        return {
          result: { migrated: false, reason: "json ledger already retired (concurrent migration completed first)" },
          imported: false,
        };
      }

      // The DESTINATION's logical schema marker must be one this build can
      // own. An empty db left behind by a NEWER meshfleet (downgrade scenario)
      // carries its higher schema_version through getDb's INSERT OR IGNORE —
      // importing v2-shaped data under that marker would hand every future
      // reader a false version claim. An OLDER marker is fine: the import is
      // CURRENT-shaped (backfilled), so the marker is bumped with it. The
      // syntax check is canonical-decimal on purpose: `Number()` blesses "",
      // "0x2", "1e1", and negatives, which are corruption, not versions.
      const metaRaw = getMetaValue("schema_version") ?? "";
      const metaVersion = /^(0|[1-9]\d*)$/.test(metaRaw) ? Number(metaRaw) : NaN;
      if (!Number.isSafeInteger(metaVersion) || metaVersion > CURRENT_SCHEMA_VERSION) {
        throw new Error(
          `JSON→SQLite migration refused: the db at ${dbFile} carries schema_version=` +
            `${JSON.stringify(metaRaw)} but this build writes ${CURRENT_SCHEMA_VERSION} — ` +
            `it was likely created by a newer or different meshfleet version. Import rolled back; ` +
            `the json source was not retired. No data lost.`
        );
      }

      const source = sourceData;
      const expectedCount = rowCount(source);
      const expectedPrint = fingerprint(source);

      // A nested transaction seam becomes a savepoint inside this transaction.
      importSnapshot(source);

      if (metaVersion < CURRENT_SCHEMA_VERSION) {
        // The imported data is CURRENT-shaped (backfilled above); the stale
        // marker must move with it or the db lies about its own contents.
        // Same transaction, so a rollback reverts the marker too.
        setMetaValue("schema_version", String(CURRENT_SCHEMA_VERSION));
      }

      // Validate the round-trip INSIDE the transaction — same handle, so the
      // read sees the uncommitted import.
      const roundTrip = readLedger();
      const gotCount = rowCount(roundTrip);
      const gotPrint = fingerprint(roundTrip);

      if (gotCount !== expectedCount || gotPrint !== expectedPrint || validationFaultForTest) {
        // Fail-closed: the throw rolls the WHOLE transaction back, returning
        // the db to exactly the state the transaction found it in. Nothing is
        // deleted — this process may not own the db file, and does not need
        // to: rollback already un-does the import.
        throw new Error(
          `JSON→SQLite migration validation FAILED (rows ${gotCount}/${expectedCount}, ` +
            `hash ${gotPrint === expectedPrint ? "ok" : "MISMATCH"}). ` +
            `Import rolled back; ${jsonFile} left authoritative. No data lost.`
        );
      }

      return { result: { migrated: true, rowCount: gotCount }, imported: true };
    },
    { durable: true, acquireMs: 60_000 }
  );

  // Retire the JSON only AFTER the commit above, and only in the process whose
  // transaction performed the import. Renaming before the commit loses the
  // source if the commit then fails; renaming from a process that did NOT
  // import is the double-migrator erasure. Kept as a backup, never deleted.
  // (The crash window between commit and rename is irreducible for a
  // cross-filesystem sequence — its residue, populated db + live JSON, is made
  // LOUD on every later boot by warnDualAuthority above.)
  if (txn.imported) {
    if (existsSync(jsonFile)) {
      // pid suffix: timestamp-only names can collide across processes/boots
      // and renameSync overwrites an existing destination on POSIX.
      const backupPath = `${jsonFile}.migrated.${Date.now()}-${process.pid}`;
      try {
        renameSync(jsonFile, backupPath);
        txn.result.backupPath = backupPath;
      } catch (err) {
        // The import itself is committed and durable — do not throw away a
        // successful migration over a rename failure, but never be silent
        // about the stranded source either: warnDualAuthority makes every
        // subsequent boot loud until the operator moves it.
        txn.result.reason =
          `imported, but could not retire the json source (${err instanceof Error ? err.message : String(err)}); ` +
          `remove or rename ${jsonFile} manually`;
        console.error(`meshfleet migration WARNING: ${txn.result.reason}`);
      }
    } else {
      if (quarantinedByUs) {
        txn.result.reason = "source was quarantined as corrupt";
      } else if ((txn.result.rowCount ?? 0) > 0) {
        // The read succeeded and the rows ARE committed — the source was moved
        // or removed by something else before retirement. Saying "nothing was
        // imported" here would contradict the committed rowCount.
        txn.result.reason =
          "imported, but the json source was moved or removed externally before it could be " +
          "retired — no backup was created by this process";
        console.error(`meshfleet migration WARNING: ${txn.result.reason}`);
      } else {
        txn.result.reason = "json source disappeared during import; nothing was imported from it";
      }
    }
  }

  return txn.result;
}
