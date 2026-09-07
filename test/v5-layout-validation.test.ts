/**
 * v5 layout fail-closed regression tests.
 *
 * A marked-v5 ledger whose `work_receipts` table was dropped verified GREEN — the audit counted
 * zero rows against a meta marker that promised the table. These tests pin the
 * fail-closed contract on the live migrator handle and the verifier's
 * audit-copy read path.
 *
 * Each test uses `withStorageTransaction` (the existing public seam in
 * src/db.ts) to acquire the live handle and plant a deliberate defect,
 * then asserts the named helper throws. No `getDb` import — that
 * helper is intentionally NOT exported; tests use the same seam the
 * production write path uses, so a drift in the seam's contract
 * surfaces here as a test that no longer plants what it claims to
 * plant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertWorkReceiptsV5Schema,
  closeDb,
  setDbPath,
  withStorageTransaction,
} from "../src/db.js";
import { verifyLedgerFile } from "../src/verify.js";

// ----------------------------------------------------------------------
// Test isolation. Each test owns its own temp ledger file and
// re-opens the SQLite handle from scratch, so the marker stays
// exactly what the test planted (no migrator advances the version
// underneath us).
// ----------------------------------------------------------------------

function withFreshLedger<T>(run: (ledgerPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-v5-layout-test-"));
  const ledgerPath = join(dir, "agent-mesh.db");
  process.env.MESHFLEET_DB_FILE = ledgerPath;
  setDbPath(ledgerPath);
  try {
    return run(ledgerPath);
  } finally {
    closeDb();
    delete process.env.MESHFLEET_DB_FILE;
    setDbPath(null);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* leak */ }
  }
}

test("v5: live handle passes assertWorkReceiptsV5Schema on a fresh ledger (green baseline)", () => {
  withFreshLedger(() => {
    // The migrator ran on first open; the v5 layout is now in place.
    // assertWorkReceiptsV5Schema runs the full check from inside the
    // existing withStorageTransaction seam — no separate getDb handle.
    withStorageTransaction((db) => {
      assert.doesNotThrow(() => assertWorkReceiptsV5Schema(db));
    });
  });
});

test("v5: dropping the work_receipts table on a marked-v5 ledger throws on assertWorkReceiptsV5Schema", () => {
  withFreshLedger(() => {
    withStorageTransaction((db) => {
      assert.doesNotThrow(() => assertWorkReceiptsV5Schema(db));
    });
    withStorageTransaction((tx) => {
      tx.exec("DROP TABLE work_receipts");
    });
    withStorageTransaction((db) => {
      assert.throws(
        () => assertWorkReceiptsV5Schema(db),
        /invalid v5 work_receipts layout: work_receipts table is missing/,
      );
    });
  });
});

test("v5: dropping a required column on a marked-v5 ledger throws on assertWorkReceiptsV5Schema", () => {
  withFreshLedger(() => {
    withStorageTransaction((db) => {
      assert.doesNotThrow(() => assertWorkReceiptsV5Schema(db));
    });
    withStorageTransaction((tx) => {
      tx.exec("ALTER TABLE work_receipts DROP COLUMN assignee");
    });
    withStorageTransaction((db) => {
      assert.throws(
        () => assertWorkReceiptsV5Schema(db),
        /invalid v5 work_receipts layout: (expected \d+ columns, found|unexpected column)/,
      );
    });
  });
});

test("v5: dropping a required index on a marked-v5 ledger throws on assertWorkReceiptsV5Schema", () => {
  withFreshLedger(() => {
    withStorageTransaction((db) => {
      assert.doesNotThrow(() => assertWorkReceiptsV5Schema(db));
    });
    withStorageTransaction((tx) => {
      tx.exec("DROP INDEX idx_work_receipts_task");
    });
    withStorageTransaction((db) => {
      assert.throws(
        () => assertWorkReceiptsV5Schema(db),
        /invalid v5 work_receipts layout: required index 'idx_work_receipts_task' is missing/,
      );
    });
  });
});

test("v5: verifyLedgerFile throws on a marked-v5 ledger whose work_receipts table was dropped (audit fail-closed)", () => {
  // The audit-copy path inherits the v5 marker and refuses to read a
  // ledger whose table was dropped.
  withFreshLedger((ledgerPath) => {
    withStorageTransaction((tx) => {
      tx.exec("DROP TABLE work_receipts");
    });
    assert.throws(
      () => verifyLedgerFile(ledgerPath),
      /invalid v5 work_receipts layout in audit copy: meta marker says v5 but the work_receipts table is missing/,
    );
  });
});

test("v5: verifyLedgerFile accepts a pre-v5 ledger without work_receipts (compatibility)", () => {
  // Backwards compatibility: a v4 ledger (no work_receipts table) is still
  // the supported pre-v5 shape. The audit must NOT throw on that fixture.
  withFreshLedger((ledgerPath) => {
    withStorageTransaction((tx) => {
      tx.exec("UPDATE meta SET value = '4' WHERE key = 'storage_schema_version'");
      tx.exec("DROP TABLE work_receipts");
    });
    const result = verifyLedgerFile(ledgerPath);
    const wrFindings = result.findings.filter((f) => f.check.startsWith("work_receipt."));
    assert.equal(wrFindings.length, 0, `unexpected work_receipt findings on pre-v5: ${JSON.stringify(wrFindings.map((f) => f.check))}`);
  });
});
