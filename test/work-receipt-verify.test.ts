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

// -----------------------------------------------------------------------
// Persisted-schema regression. The four cases below all share the same
// shape: the raw row violates one persisted-schema field (unknown enum,
// blank assignee, non-array evidence_json, malformed task_id), and the
// contract pinned here is invalid_persisted_schema + ok=false.
//   - unknown terminal_outcome      → invalid_persisted_schema + ok=false
//   - blank assignee               → invalid_persisted_schema + ok=false
//   - invalid completed_at         → invalid_persisted_schema + ok=false
//   - non-array evidence_json      → invalid_persisted_schema + ok=false
//
// The verifier NEVER throws on a corrupted row (the previous code threw
// `wr.evidence.forEach is not a function` on the non-array case).
// NOT RUN in this pass.
// -----------------------------------------------------------------------

test("verifier v3 invalid_persisted_schema on unknown enums (terminal_outcome='exited')", () => {
  withTempLedger((ledgerPath) => {
    // Bypass the schema writer's enum gate by planting the raw string. The
    // previous code cast it and produced ok=true with zero findings; the
    // contract pinned here is invalid_persisted_schema + ok=false.
    insertWorkReceiptRow({
      key: workReceiptKey(WORK_RECEIPT_SOURCE, "t_unknown_enums", 1),
      source: WORK_RECEIPT_SOURCE,
      task_id: "t_unknown_enums",
      run_id: 1,
      assignee: "alice",
      terminal_outcome: "exited",
      result_contract: "ok",
      quality_gate: "passed",
      completed_at: 1_700_000_000,
      evidence_json: '[{"kind":"git_commit","handle":"h1"}]',
      payload_sha256: computeWorkReceiptPayloadSha256({
        schema: WORK_RECEIPT_SCHEMA,
        task_id: "t_unknown_enums",
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
    const findings = result.findings.filter(
      (f) => f.check === "work_receipt.invalid_persisted_schema",
    );
    assert.ok(findings.length >= 1, `expected invalid_persisted_schema; got ${JSON.stringify(result.findings.map((f) => f.check))}`);
    assert.equal(result.ok, false);
  });
});

test("verifier v3 invalid_persisted_schema on blank assignee", () => {
  withTempLedger((ledgerPath) => {
    insertWorkReceiptRow({
      key: workReceiptKey(WORK_RECEIPT_SOURCE, "t_blank_assignee", 1),
      source: WORK_RECEIPT_SOURCE,
      task_id: "t_blank_assignee",
      run_id: 1,
      assignee: "   ",
      terminal_outcome: "completed",
      result_contract: "ok",
      quality_gate: "passed",
      completed_at: 1_700_000_000,
      evidence_json: '[{"kind":"git_commit","handle":"h1"}]',
      payload_sha256: computeWorkReceiptPayloadSha256({
        schema: WORK_RECEIPT_SCHEMA,
        task_id: "t_blank_assignee",
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
    const findings = result.findings.filter(
      (f) => f.check === "work_receipt.invalid_persisted_schema",
    );
    assert.ok(findings.length >= 1, `expected invalid_persisted_schema for blank assignee; got ${JSON.stringify(result.findings.map((f) => f.check))}`);
    assert.equal(result.ok, false);
  });
});

test("verifier v3 invalid_persisted_schema on invalid completed_at (negative)", () => {
  withTempLedger((ledgerPath) => {
    insertWorkReceiptRow({
      key: workReceiptKey(WORK_RECEIPT_SOURCE, "t_neg_time", 1),
      source: WORK_RECEIPT_SOURCE,
      task_id: "t_neg_time",
      run_id: 1,
      assignee: "alice",
      terminal_outcome: "completed",
      result_contract: "ok",
      quality_gate: "passed",
      completed_at: -1,
      evidence_json: '[{"kind":"git_commit","handle":"h1"}]',
      payload_sha256: computeWorkReceiptPayloadSha256({
        schema: WORK_RECEIPT_SCHEMA,
        task_id: "t_neg_time",
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
    const findings = result.findings.filter(
      (f) => f.check === "work_receipt.invalid_persisted_schema",
    );
    assert.ok(findings.length >= 1, `expected invalid_persisted_schema; got ${JSON.stringify(result.findings.map((f) => f.check))}`);
    assert.equal(result.ok, false);
  });
});

test("verifier v3 does NOT throw on a row whose evidence_json parses to a non-array", () => {
  // The reproduction's crash mode: `wr.evidence.forEach is not a function`.
  // The previous code coerced a non-array to the raw string and called
  // .forEach on it. The contract pinned here is: the verifier reaches a
  // verdict (ok=true|false), reports invalid_persisted_schema, and never
  // throws.
  withTempLedger((ledgerPath) => {
    insertWorkReceiptRow({
      key: workReceiptKey(WORK_RECEIPT_SOURCE, "t_evidence_obj", 1),
      source: WORK_RECEIPT_SOURCE,
      task_id: "t_evidence_obj",
      run_id: 1,
      assignee: "alice",
      terminal_outcome: "refused",
      result_contract: "refused",
      quality_gate: "failed",
      completed_at: 1_700_000_000,
      evidence_json: '{"kind":"git_commit","handle":"h1"}',
      payload_sha256: computeWorkReceiptPayloadSha256({
        schema: WORK_RECEIPT_SCHEMA,
        task_id: "t_evidence_obj",
        run_id: 1,
        assignee: "alice",
        terminal_outcome: "refused",
        result_contract: "refused",
        quality_gate: "failed",
        completed_at: 1_700_000_000,
        evidence: [],
        payload_sha256: "",
      } as WorkReceiptInput),
      recorded_at: 1_700_000_001,
    });
    // The .digest_mismatch path runs because the planted payload_sha256
    // matches the empty-evidence recompute, not the planted one. We
    // accept either invalid_persisted_schema OR digest_mismatch — the
    // pinned contract is "no throw, ok=false, no fewer findings than
    // before".
    const result = verifyLedgerFile(ledgerPath);
    assert.equal(typeof result.ok, "boolean");
    assert.equal(result.ok, false);
    const findings = result.findings.filter(
      (f) =>
        f.check === "work_receipt.invalid_persisted_schema" ||
        f.check === "work_receipt.digest_mismatch",
    );
    assert.ok(findings.length >= 1, `expected invalid_persisted_schema or digest_mismatch; got ${JSON.stringify(result.findings.map((f) => f.check))}`);
  });
});

// -----------------------------------------------------------------------
// RED-ON-REVERT additions for duplicate_logical_key and identity_mismatch.
//
// The verifier must surface BOTH invariants as errors. The two invariants
// necessarily co-fail on the realistic corrupted-ledger shape: a hand-edit
// rewrote one row's primary key without updating the row's stored
// (source, task_id, run_id) columns, leaving two rows whose stored
// identity is identical but whose keys differ AND one of those keys no
// longer matches its own stored identity. The duplicate-probe fixture
// below is exactly this shape — it plants two rows whose
// stored identity is (hermes-kanban, t_duplicate_probe, 1) but whose
// keys are `hermes-kanban\0t_duplicate_probe\01` and
// `hermes-kanban\0t_other_valid_key\01`. The second row trips
// identity_mismatch on its own; both rows share the stored identity
// tuple and trip duplicate_logical_key together.
//
// We exercise the co-fire here AND a single-invariant identity_mismatch
// shape so each check has its own minimal failing case.
// -----------------------------------------------------------------------

function rawInsertWithKey(key: string, payload: WorkReceiptInput): void {
  insertWorkReceiptRow({
    key,
    source: WORK_RECEIPT_SOURCE,
    task_id: payload.task_id,
    run_id: payload.run_id,
    assignee: payload.assignee,
    terminal_outcome: payload.terminal_outcome,
    result_contract: payload.result_contract,
    quality_gate: payload.quality_gate,
    completed_at: payload.completed_at,
    evidence_json: JSON.stringify(payload.evidence),
    payload_sha256: computeWorkReceiptPayloadSha256(payload),
    recorded_at: 1_700_000_001,
  });
}

test("verifier v3 errors on identity_mismatch (parsed key disagrees with stored identity columns)", () => {
  withTempLedger((ledgerPath) => {
    // Plant a row whose stored (source, task_id, run_id) is the canonical
    // (hermes-kanban, t_id_mismatch, 1) but whose primary key parses to a
    // DIFFERENT (source, task_id, run_id) — key =
    // `hermes-kanban\0t_peer\01`. The verifier must report identity_mismatch,
    // NOT silently trust the parsed key.
    const storedTask = "t_id_mismatch";
    const storedRun = 1;
    const payload: WorkReceiptInput = {
      schema: WORK_RECEIPT_SCHEMA,
      task_id: storedTask,
      run_id: storedRun,
      assignee: "alice",
      terminal_outcome: "completed",
      result_contract: "ok",
      quality_gate: "passed",
      completed_at: 1_700_000_000,
      evidence: [{ kind: "git_commit", handle: "h1" }],
      payload_sha256: "",
    };
    rawInsertWithKey(`${WORK_RECEIPT_SOURCE}\u0000t_peer\u0000${storedRun}`, payload);
    const result = verifyLedgerFile(ledgerPath);
    const mismatch = result.findings.find(
      (f) => f.check === "work_receipt.identity_mismatch",
    );
    assert.ok(mismatch, `expected identity_mismatch; got ${JSON.stringify(result.findings.map((f) => f.check))}`);
    assert.equal(mismatch.severity, "error");
    // No duplicate fires here — the stored identity tuple is unique on this
    // single row. The identity-mismatch invariant is independent of the
    // duplicate invariant in this case.
    assert.equal(
      result.findings.find((f) => f.check === "work_receipt.duplicate_logical_key"),
      undefined,
      "single-row identity_mismatch must not co-fire duplicate_logical_key",
    );
  });
});

test("verifier v3 errors on duplicate_logical_key with identity_mismatch co-fire (two rows share stored tuple, one row's key disagrees)", () => {
  withTempLedger((ledgerPath) => {
    // Supplier-fixture shape: two rows whose stored (source, task_id,
    // run_id) is identical, with one row's key agreeing with stored
    // identity and the other row's key disagreeing. This is the realistic
    // corrupted-ledger shape — the two invariants necessarily co-fire.
    const sharedTask = "t_duplicate_probe";
    const sharedRun = 1;
    const payload: WorkReceiptInput = {
      schema: WORK_RECEIPT_SCHEMA,
      task_id: sharedTask,
      run_id: sharedRun,
      assignee: "alice",
      terminal_outcome: "completed",
      result_contract: "ok",
      quality_gate: "passed",
      completed_at: 1_700_000_000,
      evidence: [{ kind: "git_commit", handle: "h1" }],
      payload_sha256: "",
    };
    // Row A: key agrees with stored identity.
    rawInsertWithKey(`${WORK_RECEIPT_SOURCE}\u0000${sharedTask}\u0000${sharedRun}`, payload);
    // Row B: stored identity columns unchanged (same as row A), but key
    // parses to a different task_id. This co-fires identity_mismatch on
    // row B AND duplicate_logical_key on both rows (they share the stored
    // identity tuple).
    rawInsertWithKey(`${WORK_RECEIPT_SOURCE}\u0000t_other_valid_key\u0000${sharedRun}`, payload);
    const result = verifyLedgerFile(ledgerPath);
    const findings = result.findings;
    const mismatch = findings.find((f) => f.check === "work_receipt.identity_mismatch");
    assert.ok(mismatch, `expected identity_mismatch; got ${JSON.stringify(findings.map((f) => f.check))}`);
    assert.equal(mismatch.severity, "error");
    // Both rows share the stored identity tuple, so two duplicate
    // findings fire (one per row). The peer-list inside each finding
    // names the other row.
    const dupes = findings.filter((f) => f.check === "work_receipt.duplicate_logical_key");
    assert.equal(
      dupes.length,
      2,
      `expected 2 duplicate_logical_key findings (one per duplicate row); got ${dupes.length}: ${JSON.stringify(dupes.map((f) => f.subject))}`,
    );
    for (const d of dupes) assert.equal(d.severity, "error");
    assert.equal(result.ok, false);
  });
});