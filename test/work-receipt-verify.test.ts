import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, setDbPath, withStorageTransaction } from "../src/db.js";
import {
  WORK_RECEIPT_SCHEMA,
  WORK_RECEIPT_SOURCE,
  computeWorkReceiptPayloadSha256,
  type WorkReceipt,
  type WorkReceiptInput,
  workReceiptKey,
} from "../src/work-receipt.js";
import { verifyLedgerFile } from "../src/verify.js";

// -----------------------------------------------------------------------
// Test isolation. The verifier reads the SQLite ledger on a private
// readonly audit copy (verifyLedgerFile), so we point it at a temp file
// populated by raw INSERTs (bypassing the live writer's validation
// surface, so the test can deliberately plant malformed rows the writer
// would refuse). Each test owns its own mkdtempSync.
// -----------------------------------------------------------------------

function withTempLedger<T>(run: (ledgerPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-wr-verify-test-"));
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

function insertWorkReceiptRow(row: {
  key: string;
  source: string;
  task_id: string;
  run_id: number;
  assignee: string;
  terminal_outcome: string;
  result_contract: string;
  quality_gate: string;
  completed_at: number;
  evidence_json: string;
  payload_sha256: string;
  recorded_at: number;
}): void {
  withStorageTransaction((db) => {
    db.prepare(
      "INSERT INTO work_receipts (key, source, task_id, run_id, assignee, terminal_outcome, " +
        "result_contract, quality_gate, completed_at, evidence_json, payload_sha256, recorded_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      row.key,
      row.source,
      row.task_id,
      row.run_id,
      row.assignee,
      row.terminal_outcome,
      row.result_contract,
      row.quality_gate,
      row.completed_at,
      row.evidence_json,
      row.payload_sha256,
      row.recorded_at,
    );
  });
}

function makeRow(fields: Partial<{
  task_id: string;
  run_id: number;
  terminal_outcome: string;
  result_contract: string;
  quality_gate: string;
  evidence_json: string;
  assignee: string;
  payload_sha256: string;
}>): WorkReceipt {
  const evidence: Array<{ kind: string; handle: string }> = JSON.parse(
    fields.evidence_json ?? '[{"kind":"git_commit","handle":"h1"}]',
  );
  const base = {
    schema: WORK_RECEIPT_SCHEMA,
    task_id: fields.task_id ?? "t_x",
    run_id: fields.run_id ?? 1,
    assignee: fields.assignee ?? "alice",
    terminal_outcome: fields.terminal_outcome ?? "completed",
    result_contract: fields.result_contract ?? "ok",
    quality_gate: fields.quality_gate ?? "passed",
    completed_at: 1_700_000_000,
    evidence,
    payload_sha256: "",
  };
  const payload_sha256 = fields.payload_sha256 ?? computeWorkReceiptPayloadSha256(base as WorkReceiptInput);
  return {
    ...base,
    terminal_outcome: base.terminal_outcome as WorkReceipt["terminal_outcome"],
    result_contract: base.result_contract as WorkReceipt["result_contract"],
    quality_gate: base.quality_gate as WorkReceipt["quality_gate"],
    evidence: evidence as WorkReceipt["evidence"],
    payload_sha256,
    source: WORK_RECEIPT_SOURCE,
    recorded_at: 1_700_000_001,
  };
}

function plantRow(ledgerPath: string, fields: Parameters<typeof makeRow>[0] = {}): void {
  const row = makeRow(fields);
  insertWorkReceiptRow({
    key: workReceiptKey(WORK_RECEIPT_SOURCE, row.task_id, row.run_id),
    source: row.source,
    task_id: row.task_id,
    run_id: row.run_id,
    assignee: row.assignee,
    terminal_outcome: row.terminal_outcome,
    result_contract: row.result_contract,
    quality_gate: row.quality_gate,
    completed_at: row.completed_at,
    evidence_json: JSON.stringify(row.evidence),
    payload_sha256: row.payload_sha256,
    recorded_at: row.recorded_at,
  });
}

// -----------------------------------------------------------------------
// Verifier v3 work_receipt.* findings.
// -----------------------------------------------------------------------

test("verifier v3 errors on digest_mismatch (stored payload_sha256 disagrees with recomputed)", () => {
  withTempLedger((ledgerPath) => {
    plantRow(ledgerPath, { payload_sha256: "0".repeat(64) });
    const result = verifyLedgerFile(ledgerPath);
    const finding = result.findings.find(
      (f) => f.check === "work_receipt.digest_mismatch",
    );
    assert.ok(finding, `expected work_receipt.digest_mismatch finding; got ${JSON.stringify(result.findings.map((f) => f.check))}`);
    assert.equal(finding.severity, "error");
  });
});

test("verifier v3 errors on impossible_success (terminal_outcome=refused + result_contract=ok)", () => {
  withTempLedger((ledgerPath) => {
    plantRow(ledgerPath, { terminal_outcome: "refused", result_contract: "ok" });
    const result = verifyLedgerFile(ledgerPath);
    const finding = result.findings.find(
      (f) => f.check === "work_receipt.impossible_success",
    );
    assert.ok(finding, `expected work_receipt.impossible_success; got ${JSON.stringify(result.findings.map((f) => f.check))}`);
  });
});

test("verifier v3 errors on impossible_success (terminal_outcome=completed + result_contract=refused)", () => {
  withTempLedger((ledgerPath) => {
    plantRow(ledgerPath, { terminal_outcome: "completed", result_contract: "refused" });
    const result = verifyLedgerFile(ledgerPath);
    const finding = result.findings.find(
      (f) => f.check === "work_receipt.impossible_success",
    );
    assert.ok(finding, `expected work_receipt.impossible_success; got ${JSON.stringify(result.findings.map((f) => f.check))}`);
  });
});

test("verifier v3 errors on impossible_success (quality_gate=passed + result_contract != ok)", () => {
  withTempLedger((ledgerPath) => {
    plantRow(ledgerPath, { quality_gate: "passed", result_contract: "refused" });
    const result = verifyLedgerFile(ledgerPath);
    const finding = result.findings.find(
      (f) => f.check === "work_receipt.impossible_success",
    );
    assert.ok(finding, `expected work_receipt.impossible_success; got ${JSON.stringify(result.findings.map((f) => f.check))}`);
  });
});

test("verifier v3 errors on evidence_shape (zero entries with quality_gate=passed)", () => {
  withTempLedger((ledgerPath) => {
    plantRow(ledgerPath, { evidence_json: "[]" });
    const result = verifyLedgerFile(ledgerPath);
    const finding = result.findings.find(
      (f) => f.check === "work_receipt.evidence_shape",
    );
    assert.ok(finding, `expected work_receipt.evidence_shape; got ${JSON.stringify(result.findings.map((f) => f.check))}`);
  });
});

test("verifier v3 errors on malformed_key (key not parseable as source\\0task_id\\0run_id)", () => {
  withTempLedger((ledgerPath) => {
    // Plant a row whose primary key is a single segment — the verifier's
    // parseWorkReceiptKey will reject it, surfacing malformed_key.
    insertWorkReceiptRow({
      key: "not-a-parseable-key",
      source: WORK_RECEIPT_SOURCE,
      task_id: "t_x",
      run_id: 1,
      assignee: "alice",
      terminal_outcome: "completed",
      result_contract: "ok",
      quality_gate: "passed",
      completed_at: 1_700_000_000,
      evidence_json: '[{"kind":"git_commit","handle":"h1"}]',
      payload_sha256: computeWorkReceiptPayloadSha256({
        schema: WORK_RECEIPT_SCHEMA,
        task_id: "t_x",
        run_id: 1,
        assignee: "alice",
        terminal_outcome: "completed",
        result_contract: "ok",
        quality_gate: "passed",
        completed_at: 1_700_000_000,
        evidence: [{ kind: "git_commit", handle: "h1" }],
        payload_sha256: "",
      }),
      recorded_at: 1_700_000_001,
    });
    const result = verifyLedgerFile(ledgerPath);
    const finding = result.findings.find(
      (f) => f.check === "work_receipt.malformed_key",
    );
    assert.ok(finding, `expected work_receipt.malformed_key; got ${JSON.stringify(result.findings.map((f) => f.check))}`);
  });
});

// -----------------------------------------------------------------------
// RED-ON-REVERT: this is the contract guard. If we remove one of the
// checks above (digest_mismatch, impossible_success, evidence_shape, or
// malformed_key), this test must go RED. Each plant covers one of the
// four classes — run them in a single ledger so a single verifyLedgerFile
// call sees all four at once and reports them as a SET, not as four
// separate verifications.
// -----------------------------------------------------------------------

test("verifier v3 reports ALL FOUR work_receipt error classes in one audit run", () => {
  withTempLedger((ledgerPath) => {
    // Plant 1: digest_mismatch — payload_sha256 wrong.
    plantRow(ledgerPath, { task_id: "t_1", payload_sha256: "f".repeat(64) });
    // Plant 2: impossible_success — refused + ok.
    plantRow(ledgerPath, {
      task_id: "t_2",
      terminal_outcome: "refused",
      result_contract: "ok",
    });
    // Plant 3: evidence_shape — zero evidence, quality_gate=passed.
    plantRow(ledgerPath, {
      task_id: "t_3",
      evidence_json: "[]",
      quality_gate: "passed",
    });
    // Plant 4: malformed_key — hand-crafted single-segment primary key.
    insertWorkReceiptRow({
      key: "malformed-key-no-nuls",
      source: WORK_RECEIPT_SOURCE,
      task_id: "t_zz",
      run_id: 1,
      assignee: "alice",
      terminal_outcome: "completed",
      result_contract: "ok",
      quality_gate: "passed",
      completed_at: 1_700_000_000,
      evidence_json: '[{"kind":"git_commit","handle":"h1"}]',
      payload_sha256: computeWorkReceiptPayloadSha256({
        schema: WORK_RECEIPT_SCHEMA,
        task_id: "t_zz",
        run_id: 1,
        assignee: "alice",
        terminal_outcome: "completed",
        result_contract: "ok",
        quality_gate: "passed",
        completed_at: 1_700_000_000,
        evidence: [{ kind: "git_commit", handle: "h1" }],
        payload_sha256: "",
      } as WorkReceiptInput),
      recorded_at: 1_700_000_001,
    });

    const result = verifyLedgerFile(ledgerPath);
    const checks = new Set(result.findings.map((f) => f.check));
    assert.ok(
      checks.has("work_receipt.digest_mismatch"),
      `digest_mismatch missing: ${JSON.stringify([...checks])}`,
    );
    assert.ok(
      checks.has("work_receipt.impossible_success"),
      `impossible_success missing: ${JSON.stringify([...checks])}`,
    );
    assert.ok(
      checks.has("work_receipt.evidence_shape"),
      `evidence_shape missing: ${JSON.stringify([...checks])}`,
    );
    assert.ok(
      checks.has("work_receipt.malformed_key"),
      `malformed_key missing: ${JSON.stringify([...checks])}`,
    );
    // All four findings are errors, so ok must be false.
    assert.equal(result.ok, false);
  });
});

test("verifier v3 ok=true on a clean row (baseline)", () => {
  withTempLedger((ledgerPath) => {
    plantRow(ledgerPath); // no overrides — fully contract-valid row
    const result = verifyLedgerFile(ledgerPath);
    const wrFindings = result.findings.filter((f) => f.check.startsWith("work_receipt."));
    assert.equal(wrFindings.length, 0, `unexpected work_receipt findings: ${JSON.stringify(wrFindings.map((f) => f.check))}`);
  });
});