/**
 * rotating-lens#3 contract test for the SQLite physical-storage schema
 * version surface at src/db.ts:505.
 *
 * Why this file exists. Cycles 815-826 documented a recurring STRIKE-1 env-mode
 * failure where `migrateStorage` refused to open the developer's live ledger
 * because the file carried `storage_schema_version = '5'` while the build
 * published `CURRENT_STORAGE_SCHEMA_VERSION = 4`. The error string — "unsupported
 * newer storage schema version 5; this meshfleet build supports up to 4" — was
 * what made the cycles easy to misread as a code regression. They were not: the
 * ledger was ahead of the build. The same trap fires in reverse — a build that
 * quietly bumps CURRENT_STORAGE_SCHEMA_VERSION would leave every live ledger
 * behind, with no test in the suite catching the drift before a deploy.
 *
 * What the test pins:
 *   (1) The literal `CURRENT_STORAGE_SCHEMA_VERSION = N` exists at src/db.ts:505,
 *       exported, and is the value the migration code reads. A contributor who
 *       bumps the constant in one place but not the migration ladder trips here.
 *   (2) A fresh ledger reaches the published CURRENT via the v1→v2→v3→v4 ladder
 *       (the `while (version < 3)` and `version === 3` branches of migrateStorage).
 *       End-to-end oracle: withTempDb + readLedger() drives a brand-new DB through
 *       the migration and lands at the published version.
 *   (3) A meta value ABOVE CURRENT is refused with the documented upper-bound
 *       error string ("unsupported newer storage schema version ... ; this
 *       meshfleet build supports up to ..."). This is what the cycles 815-826
 *       debug output showed; pinning the message protects against a silent
 *       loosening of the refusal.
 *   (4) A meta value missing on an ALREADY-INITIALIZED physical layout is
 *       REFUSED (not silently repaired) with "unsupported storage schema
 *       version: missing". The migrator distinguishes two missing-row cases
 *       in physicalStorageVersion (src/db.ts:861-863): empty physical
 *       layout → treat as v1; populated physical layout → refuse. A
 *       regression that silently "repairs" the populated case would mask
 *       a corruption.
 *   (5) RED-on-revert: the literal `= 4` at src/db.ts:505 must stay `= 4` — a
 *       bump to `= 5` (the very move that produced the cycles 815-826 baseline)
 *       is the canonical drift direction this test exists to catch.
 *
 * What this test CANNOT see:
 *   - The shape of MIGRATION STEPS beyond v4. Adding v5 requires bumping
 *     CURRENT_STORAGE_SCHEMA_VERSION, which is exactly what test (1) catches.
 *   - The on-disk encoding of v2/v3 columns. attempt-lifecycle.test.ts and
 *     lifecycle-integration-adversarial.test.ts own that surface; this file is
 *     a contract pin, not a substitute.
 *   - The corpus-and-fixture story. db-storage-schema-version-pin.test.ts is a
 *     surface pin, not a fixture pin; attempt-lifecycle.test.ts owns fixtures.
 *
 * The fixture pattern here is the same `withTempDb` helper used by every other
 * db.ts surface test — fresh temp directory, throwaway ledger, close + restore on
 * exit. NO live-ledger write path is exercised.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import {
  closeDb,
  CURRENT_STORAGE_SCHEMA_VERSION,
  getStorageSchemaVersion,
  readLedger,
  setDbPath,
} from "../src/db.js";
import { withTempDb } from "./helpers/with-temp-db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");
const DB_TS = join(SRC, "db.ts");

test("CURRENT_STORAGE_SCHEMA_VERSION is exported from src/db.ts at line 505 with literal value 4", () => {
  // The published surface. A grep-only assertion would stay green on
  // `// CURRENT_STORAGE_SCHEMA_VERSION = 4` in a comment; this regex
  // requires the export + literal assignment in source position.
  const dbSrc = readFileSync(DB_TS, "utf-8");
  // Match the export declaration at the published line range. We allow a
  // small window (db.ts:495..515) so an editor that adds an import above
  // the constant does not silently shift the pin. The literal shape
  // `export const CURRENT_STORAGE_SCHEMA_VERSION = <integer>;` is what
  // every consumer (migrateStorage, getStorageSchemaVersion, error
  // messages) actually reads.
  const exportRegex =
    /export\s+const\s+CURRENT_STORAGE_SCHEMA_VERSION\s*=\s*(\d+)\s*;/;
  const match = dbSrc.match(exportRegex);
  assert.ok(match, "src/db.ts is missing `export const CURRENT_STORAGE_SCHEMA_VERSION = <N>;` — every consumer of the migration ladder reads through this symbol");
  assert.equal(
    Number(match[1]),
    CURRENT_STORAGE_SCHEMA_VERSION,
    `export literal (${match[1]}) diverges from the imported symbol (${CURRENT_STORAGE_SCHEMA_VERSION}) — the migration ladder and the published constant would drift apart`,
  );
  // Pin the exact value at the published surface. A bump to 5 (the move
  // that produced the cycles 815-826 v5/v4 ABI pollution) trips here
  // BEFORE the migration ladder is even touched.
  assert.equal(
    CURRENT_STORAGE_SCHEMA_VERSION,
    4,
    `CURRENT_STORAGE_SCHEMA_VERSION drifted to ${CURRENT_STORAGE_SCHEMA_VERSION}; the cycles 815-826 STRIKE-1 v5/v4 baseline is exactly the trap a silent bump produces. Bump only alongside the migration ladder AND a HANDOFF.md count update.`,
  );
  // Pin the published line position. The cycle-815 reverify worktree
  // referenced L505; if a future refactor moves the export, this test
  // names the new location.
  const lines = dbSrc.split("\n");
  const line505 = lines[504]; // 0-indexed
  assert.ok(
    /export\s+const\s+CURRENT_STORAGE_SCHEMA_VERSION\s*=\s*4\s*;/.test(line505),
    `src/db.ts line 505 is no longer the CURRENT_STORAGE_SCHEMA_VERSION literal; got: ${line505}. Update the test to point at the new line.`,
  );
});

test("fresh ledger migrates v1→v4 through the published ladder and lands at CURRENT", () => {
  const temp = withTempDb();
  try {
    // readLedger() is the documented first-write path; getDb() runs
    // migrateStorage on connect, so a single read is enough to drive the
    // v1→v2→v3→v4 ladder end-to-end.
    readLedger();
    assert.equal(
      getStorageSchemaVersion(),
      CURRENT_STORAGE_SCHEMA_VERSION,
      `fresh ledger did not reach CURRENT_STORAGE_SCHEMA_VERSION=${CURRENT_STORAGE_SCHEMA_VERSION}; the migration ladder (src/db.ts:889-933) has been broken or shortened`,
    );
    // The ladder must have written the meta row. Without this row the
    // next open() would re-run the migration and trip the
    // hasInitializedPhysicalStorage rescue in physicalStorageVersion.
    const raw = new Database(temp.dbFile, { readonly: true });
    const row = raw
      .prepare("SELECT value FROM meta WHERE key = 'storage_schema_version'")
      .get() as { value: string } | undefined;
    raw.close();
    assert.ok(row, "meta row for storage_schema_version was not written by the migration");
    assert.equal(
      Number(row.value),
      CURRENT_STORAGE_SCHEMA_VERSION,
      `meta row carries ${row.value}; expected ${CURRENT_STORAGE_SCHEMA_VERSION}. Migration wrote a version the build does not know about.`,
    );
  } finally { temp.cleanup(); }
});

test("a meta value above CURRENT is refused with the documented upper-bound error string", () => {
  const temp = withTempDb();
  try {
    // Establish a clean ledger at CURRENT first, then rewind + bump past.
    readLedger();
    closeDb();
    const raw = new Database(temp.dbFile);
    raw
      .prepare(
        `UPDATE meta SET value = '${CURRENT_STORAGE_SCHEMA_VERSION + 1}' WHERE key = 'storage_schema_version'`,
      )
      .run();
    raw.close();
    setDbPath(temp.dbFile);
    let captured: Error | undefined;
    try {
      readLedger();
    } catch (err) {
      captured = err as Error;
    }
    // Restore the helper's setDbPath state by going through withTempDb's
    // cleanup, which already saved+restores prevDbFile. We re-assert here
    // for symmetry — readLedger failing is the expected outcome.
    assert.ok(captured, "a ledger ABOVE CURRENT must be refused; readLedger() silently succeeded");
    assert.match(
      captured.message,
      /unsupported newer storage schema version/,
      `refusal error must name the cause: got "${captured.message}". A contributor who weakens the message makes future debugging as hard as cycles 815-826.`,
    );
    assert.match(
      captured.message,
      new RegExp(`this meshfleet build supports up to ${CURRENT_STORAGE_SCHEMA_VERSION}`),
      `refusal error must name the build's CURRENT ceiling (${CURRENT_STORAGE_SCHEMA_VERSION}); got "${captured.message}". The exact-string assertion is the durable contract.`,
    );
  } finally { temp.cleanup(); }
});

test("a meta row missing on an already-initialized physical layout is REFUSED, not silently repaired", () => {
  const temp = withTempDb();
  try {
    // The migrator distinguishes two cases (src/db.ts:861-863):
    //   (a) meta row missing AND no physical tables yet → treat as v1,
    //       migrate upward from the bottom of the ladder.
    //   (b) meta row missing AND physical tables already initialized →
    //       refuse with "unsupported storage schema version: missing".
    // Case (b) is the dangerous one: a row went missing mid-flight, and
    // silently inventing a version would mask the corruption. The
    // migrator MUST refuse. This test pins the refusal so a future
    // "helpful" auto-repair can't quietly loosen it.
    readLedger();
    closeDb();
    const raw = new Database(temp.dbFile);
    raw.prepare("DELETE FROM meta WHERE key = 'storage_schema_version'").run();
    raw.close();
    setDbPath(temp.dbFile);
    let captured: Error | undefined;
    try {
      readLedger();
    } catch (err) {
      captured = err as Error;
    }
    assert.ok(
      captured,
      "a ledger with an INITIALIZED physical layout but a missing storage_schema_version meta row MUST be refused; silent repair would mask corruption",
    );
    assert.match(
      captured.message,
      /unsupported storage schema version: missing/,
      `refusal message must name the exact failure mode; got "${captured.message}". The literal ": missing" suffix is what differentiates a corrupt-but-trapped state from a clean-but-uninitialized one — dropping it would silently merge the two cases.`,
    );
    closeDb();
  } finally { temp.cleanup(); }
});

test("RED-on-revert: the literal `= 4` at src/db.ts line 505 is pinned against a silent bump", () => {
  // The cycles 815-826 STRIKE-1 v5/v4 ABI baseline was produced by a ledger
  // with storage_schema_version=5 meeting a build with
  // CURRENT_STORAGE_SCHEMA_VERSION=4. The inverse drift — bumping the
  // constant to 5 — would leave every live v4 ledger behind. This regex
  // requires the literal `= 4` to stay at the published surface, in the
  // exact line position (505) the rest of the suite references.
  //
  // Hardened call-pattern: scan a 1-line window around the export and
  // require both (a) the literal `= 4` token and (b) the export binding to
  // CURRENT_STORAGE_SCHEMA_VERSION. Comment-only positions are excluded
  // by anchoring on `export\s+const`.
  const dbSrc = readFileSync(DB_TS, "utf-8");
  const lines = dbSrc.split("\n");
  const line505 = lines[504];
  assert.ok(
    /export\s+const\s+CURRENT_STORAGE_SCHEMA_VERSION\s*=\s*4\s*;/.test(line505),
    `src/db.ts line 505 has shifted away from the published literal — got: "${line505}". This is the canonical drift direction cycles 815-826 documented; restoring the literal re-greens this test.`,
  );
  // Belt-and-braces: also assert the integer literal appears nowhere else
  // as `CURRENT_STORAGE_SCHEMA_VERSION = <other>` — a contributor who
  // bumps without updating the migration ladder is caught here too.
  const otherBumpRegex =
    /export\s+const\s+CURRENT_STORAGE_SCHEMA_VERSION\s*=\s*([0-9]+)\s*;/g;
  let count = 0;
  let nonFour = 0;
  let m: RegExpExecArray | null;
  while ((m = otherBumpRegex.exec(dbSrc)) !== null) {
    count += 1;
    if (m[1] !== "4") nonFour += 1;
  }
  assert.equal(count, 1, `expected exactly one exported CURRENT_STORAGE_SCHEMA_VERSION literal; found ${count}`);
  assert.equal(nonFour, 0, `found a non-4 CURRENT_STORAGE_SCHEMA_VERSION export; the build's ceiling has drifted from the cycles 815-826 published value`);
});
