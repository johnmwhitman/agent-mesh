/**
 * Persisted-row schema regression tests (v5 audit hardening).
 *
 * The verifier previously passed every one of these fixtures with
 * ok=true and zero findings:
 *   - malformed evidence (JSON parses to non-array, then .forEach crashes)
 *   - rehashed unknown enums (terminal_outcome=completed, result_contract=bogus)
 *   - blank assignee
 *   - invalid timestamp (string, negative, NaN, Infinity)
 *
 * These tests are NOT RUN in this source repair pass. Root owns the
 * canonical Node 24.18.1 verifier gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, setDbPath, withStorageTransaction } from "../src/db.js";
import { WORK_RECEIPT_SOURCE } from "../src/work-receipt.js";
import { verifyLedgerFile } from "../src/verify.js";

// ----------------------------------------------------------------------
// Test isolation. The verifier reads the SQLite ledger on a private
// readonly audit copy, so we point it at a temp file populated by raw
// INSERTs (bypassing the live writer's validation surface, so the test
// can deliberately plant malformed rows the writer would refuse).
// ----------------------------------------------------------------------

function withTempLedger<T>(run: (ledgerPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-wr-persisted-test-"));
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

function plantRawRow(row: {
  key?: string;
  source?: string;
  task_id?: string;
  run_id?: number;
  assignee?: string;
  terminal_outcome?: string;
  result_contract?: string;
  quality_gate?: string;
  completed_at?: number | string;
  evidence_json?: string;
  payload_sha256?: string;
  recorded_at?: number | string;
}): void {
  const defaults = {
    key: `${WORK_RECEIPT_SOURCE}\u0000t_default\u00001`,
    source: WORK_RECEIPT_SOURCE,
    task_id: "t_default",
    run_id: 1,
    assignee: "alice",
    terminal_outcome: "completed",
    result_contract: "ok",
    quality_gate: "passed",
    completed_at: 1_700_000_000,
    evidence_json: '[{"kind":"git_commit","handle":"h1"}]',
    payload_sha256: "0".repeat(64),
    recorded_at: 1_700_000_001,
  };
  const merged = { ...defaults, ...row };
  withStorageTransaction((tx) => {
    tx.prepare(
      "INSERT INTO work_receipts (key, source, task_id, run_id, assignee, terminal_outcome, " +
        "result_contract, quality_gate, completed_at, evidence_json, payload_sha256, recorded_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      merged.key,
      merged.source,
      merged.task_id,
      merged.run_id,
      merged.assignee,
      merged.terminal_outcome,
      merged.result_contract,
      merged.quality_gate,
      merged.completed_at as number,
      merged.evidence_json,
      merged.payload_sha256,
      merged.recorded_at as number,
    );
  });
}

test("verifier does NOT throw on a row whose evidence_json parses to a non-array", () => {
  // The v5 reproduction's crash mode: evidence_json='{"not":"an array"}'
  // parses to an object, the previous code coerced to the raw string, then
  // called .forEach on the string. The new code parses defensively, treats
  // a non-array as `[]` + a persisted-schema finding, and proceeds.
  withTempLedger((ledgerPath) => {
    plantRawRow({
      task_id: "t_evidence_obj",
      evidence_json: '{"kind":"git_commit","handle":"h1"}',
      quality_gate: "failed",
      result_contract: "refused",
      terminal_outcome: "refused",
    });
    const result = verifyLedgerFile(ledgerPath);
    // No throw, no crash — the verifier must reach a verdict.
    assert.equal(typeof result.ok, "boolean");
    // And it must report the shape violation.
    const findings = result.findings.filter((f) => f.check === "work_receipt.invalid_persisted_schema");
    assert.ok(findings.length >= 1, `expected invalid_persisted_schema finding; got ${JSON.stringify(result.findings.map((f) => f.check))}`);
    assert.equal(result.ok, false);
  });
});

test("verifier does NOT throw on a row whose evidence_json is malformed JSON", () => {
  withTempLedger((ledgerPath) => {
    plantRawRow({
      task_id: "t_evidence_bad_json",
      evidence_json: "not-json-at-all",
      quality_gate: "failed",
      result_contract: "refused",
      terminal_outcome: "refused",
    });
    const result = verifyLedgerFile(ledgerPath);
    assert.equal(typeof result.ok, "boolean");
    // The persisted-schema check reports the malformed JSON via
    // invalid_persisted_schema; the downstream invariants then see
    // evidence: [] (never throw on .length / .forEach).
    const findings = result.findings.filter((f) => f.check === "work_receipt.invalid_persisted_schema");
    assert.ok(findings.length >= 1, `expected invalid_persisted_schema; got ${JSON.stringify(result.findings.map((f) => f.check))}`);
    assert.equal(result.ok, false);
  });
});

test("verifier reports invalid_persisted_schema for an unknown terminal_outcome enum", () => {
  withTempLedger((ledgerPath) => {
    plantRawRow({
      task_id: "t_unknown_terminal",
      terminal_outcome: "exited", // not in {completed, failed, refused, blocked}
    });
    const result = verifyLedgerFile(ledgerPath);
    const findings = result.findings.filter((f) => f.check === "work_receipt.invalid_persisted_schema");
    assert.ok(findings.length >= 1, `expected invalid_persisted_schema; got ${JSON.stringify(result.findings.map((f) => f.check))}`);
    assert.equal(result.ok, false);
  });
});

test("verifier reports invalid_persisted_schema for a blank assignee", () => {
  withTempLedger((ledgerPath) => {
    plantRawRow({
      task_id: "t_blank_assignee",
      assignee: "   ",
    });
    const result = verifyLedgerFile(ledgerPath);
    const findings = result.findings.filter((f) => f.check === "work_receipt.invalid_persisted_schema");
    assert.ok(findings.length >= 1, `expected invalid_persisted_schema for blank assignee; got ${JSON.stringify(result.findings.map((f) => f.check))}`);
    assert.equal(result.ok, false);
  });
});

test("verifier reports invalid_persisted_schema for a negative completed_at", () => {
  withTempLedger((ledgerPath) => {
    plantRawRow({
      task_id: "t_neg_time",
      completed_at: -1,
    });
    const result = verifyLedgerFile(ledgerPath);
    const findings = result.findings.filter((f) => f.check === "work_receipt.invalid_persisted_schema");
    assert.ok(findings.length >= 1, `expected invalid_persisted_schema; got ${JSON.stringify(result.findings.map((f) => f.check))}`);
    assert.equal(result.ok, false);
  });
});

test("verifier reports invalid_persisted_schema for a recorded_at of zero", () => {
  withTempLedger((ledgerPath) => {
    plantRawRow({
      task_id: "t_zero_recorded",
      recorded_at: 0,
    });
    const result = verifyLedgerFile(ledgerPath);
    const findings = result.findings.filter((f) => f.check === "work_receipt.invalid_persisted_schema");
    assert.ok(findings.length >= 1, `expected invalid_persisted_schema for zero recorded_at; got ${JSON.stringify(result.findings.map((f) => f.check))}`);
    assert.equal(result.ok, false);
  });
});

test("verifier reports invalid_persisted_schema for a non-hex payload_sha256", () => {
  withTempLedger((ledgerPath) => {
    plantRawRow({
      task_id: "t_bad_hash",
      payload_sha256: "not-a-real-sha256",
    });
    const result = verifyLedgerFile(ledgerPath);
    const findings = result.findings.filter((f) => f.check === "work_receipt.invalid_persisted_schema");
    assert.ok(findings.length >= 1, `expected invalid_persisted_schema for bad payload_sha256; got ${JSON.stringify(result.findings.map((f) => f.check))}`);
    assert.equal(result.ok, false);
  });
});

test("verifier reports invalid_persisted_schema for a malformed task_id", () => {
  withTempLedger((ledgerPath) => {
    plantRawRow({
      task_id: "not-a-kanban-id",
    });
    const result = verifyLedgerFile(ledgerPath);
    const findings = result.findings.filter((f) => f.check === "work_receipt.invalid_persisted_schema");
    assert.ok(findings.length >= 1, `expected invalid_persisted_schema; got ${JSON.stringify(result.findings.map((f) => f.check))}`);
    assert.equal(result.ok, false);
  });
});