/**
 * v5 layout fail-closed regression tests.
 *
 * The v5-layout-reproduction.json probe proved:
 *   - fresh_v5 → green (correct)
 *   - marked-v5 + DROP TABLE work_receipts → green (BUG: should fail closed)
 *   - marked-v5 + DROP TABLE → reopens at v5 (BUG: should refuse the open)
 *
 * These tests are NOT RUN in this source repair pass. Root owns the
 * canonical Node 24.18.1 verifier gate; the lane wrote these as source so
 * the next --class=focused run picks them up after Conductor verification.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertWorkReceiptsV5Schema,
  closeDb,
  getDb,
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
    const db = getDb();
    // The migrator ran on first open; the v5 layout is now in place.
    assert.doesNotThrow(() => assertWorkReceiptsV5Schema(db));
  });
});

test("v5: dropping the work_receipts table on a marked-v5 ledger throws on assertWorkReceiptsV5Schema", () => {
  withFreshLedger(() => {
    const db = getDb();
    // Verify the layout first (green), then drop the table to simulate the
    // v5-layout-reproduction.json probe's DROP TABLE step. The marker stays
    // at v5 because the migrator already wrote it.
    assert.doesNotThrow(() => assertWorkReceiptsV5Schema(db));
    withStorageTransaction((tx) => {
      tx.exec("DROP TABLE work_receipts");
    });
    assert.throws(
      () => assertWorkReceiptsV5Schema(db),
      /invalid v5 work_receipts layout: work_receipts table is missing/,
    );
  });
});

test("v5: dropping a required column on a marked-v5 ledger throws on assertWorkReceiptsV5Schema", () => {
  withFreshLedger(() => {
    const db = getDb();
    assert.doesNotThrow(() => assertWorkReceiptsV5Schema(db));
    // Simulate a partial migration that lost one column. SQLite's ALTER
    // TABLE DROP COLUMN is the natural failure mode here.
    withStorageTransaction((tx) => {
      tx.exec("ALTER TABLE work_receipts DROP COLUMN assignee");
    });
    assert.throws(
      () => assertWorkReceiptsV5Schema(db),
      /invalid v5 work_receipts layout: (expected \d+ columns, found|unexpected column)/,
    );
  });
});

test("v5: dropping a required index on a marked-v5 ledger throws on assertWorkReceiptsV5Schema", () => {
  withFreshLedger(() => {
    const db = getDb();
    assert.doesNotThrow(() => assertWorkReceiptsV5Schema(db));
    withStorageTransaction((tx) => {
      tx.exec("DROP INDEX idx_work_receipts_task");
    });
    assert.throws(
      () => assertWorkReceiptsV5Schema(db),
      /invalid v5 work_receipts layout: required index 'idx_work_receipts_task' is missing/,
    );
  });
});

test("v5: verifyLedgerFile throws on a marked-v5 ledger whose work_receipts table was dropped (audit fail-closed)", () => {
  // This is the direct regression for v5-layout-reproduction.json: a fresh
  // v5 ledger + DROP TABLE work_receipts must NOT audit green; the audit
  // copy inherits the v5 marker, the reader checks the table, and the
  // reader throws.
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
    // Demote the version marker to v4 to simulate a real pre-v5 install.
    withStorageTransaction((tx) => {
      tx.exec("UPDATE meta SET value = '4' WHERE key = 'storage_schema_version'");
      tx.exec("DROP TABLE work_receipts");
    });
    // No throw, no work_receipt findings.
    const result = verifyLedgerFile(ledgerPath);
    const wrFindings = result.findings.filter((f) => f.check.startsWith("work_receipt."));
    assert.equal(wrFindings.length, 0, `unexpected work_receipt findings on pre-v5: ${JSON.stringify(wrFindings.map((f) => f.check))}`);
  });
});