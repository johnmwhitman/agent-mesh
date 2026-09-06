/**
 * Executable work-receipt negative fixtures.
 *
 * Closes the corpus gap for the work_receipt.* check family without using a
 * regex match against test source — that gate can be satisfied by a comment
 * saying the right word. The table below is the SOURCE OF TRUTH for which
 * work_receipt.* checks have a planted negative fixture: each entry names the
 * exact check id and a `plant(ledgerPath)` function that, when invoked, plants
 * a row on the supplied SQLite ledger such that verifyLedgerFile fires that
 * check as a `severity: "error"` finding.
 *
 * corpus.test.ts asserts two properties against this table:
 *   (a) the set of `work_receipt.*` checks the verifier emits equals the set
 *       of keys here (a new check without a fixture trips the gate; a fixture
 *       for a check the verifier no longer emits also trips the gate);
 *   (b) every fixture, executed against a fresh ledger, raises its named
 *       check at error severity (a fixture that does not actually fire the
 *       check it claims to pin trips the gate — comments cannot pass).
 *
 * This file is test-only infrastructure; it owns no product logic. The shared
 * planting primitives (computeWorkReceiptPayloadSha256, workReceiptKey,
 * WORK_RECEIPT_SCHEMA, WORK_RECEIPT_SOURCE) come from src/work-receipt.js,
 * the same module the production writer uses, so a drift in field names or
 * key composition surfaces here as a fixture that no longer plants the row
 * it claims to plant.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, setDbPath, withStorageTransaction } from "../src/db.js";
import { verifyLedgerFile } from "../src/verify.js";
import {
  WORK_RECEIPT_SCHEMA,
  WORK_RECEIPT_SOURCE,
  computeWorkReceiptPayloadSha256,
  workReceiptKey,
  type WorkReceiptInput,
} from "../src/work-receipt.js";

/**
 * A planted negative fixture. The function writes ONE row to the supplied
 * ledger such that verifyLedgerFile will report `check` at error severity.
 * The fixture should plant exactly the minimum row shape needed to fire that
 * one class — sharing clean field defaults so each fixture isolates one
 * invariant.
 */
export interface WorkReceiptFixture {
  /** The exact verifier check id the fixture must fire (e.g. "work_receipt.malformed_key"). */
  check: string;
  /** Human-readable reason this row violates the contract. */
  description: string;
  /** Plants the row on the supplied SQLite ledger. */
  plant(ledgerPath: string): void;
}

// ---------------------------------------------------------------------------
// Internal helpers — kept narrow so a fixture's intent is unmistakable.
// ---------------------------------------------------------------------------

function withTempLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-wr-corpus-"));
  const ledgerPath = join(dir, "agent-mesh.db");
  process.env.MESHFLEET_DB_FILE = ledgerPath;
  setDbPath(ledgerPath);
  return ledgerPath;
}

function cleanupTempLedger(): void {
  closeDb();
  delete process.env.MESHFLEET_DB_FILE;
  setDbPath(null);
}

function rawInsert(row: {
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

const BASE_TASK_ID = "t_corpus_fixture";
const BASE_RUN_ID = 1;
const BASE_COMPLETED_AT = 1_700_000_000;
const BASE_RECORDED_AT = 1_700_000_001;
const BASE_EVIDENCE_JSON = '[{"kind":"git_commit","handle":"h1"}]';

function basePayload(overrides: Partial<WorkReceiptInput> = {}): WorkReceiptInput {
  return {
    schema: WORK_RECEIPT_SCHEMA,
    task_id: BASE_TASK_ID,
    run_id: BASE_RUN_ID,
    assignee: "alice",
    terminal_outcome: "completed",
    result_contract: "ok",
    quality_gate: "passed",
    completed_at: BASE_COMPLETED_AT,
    evidence: [{ kind: "git_commit", handle: "h1" }],
    payload_sha256: "",
    ...overrides,
  };
}

function canonicalDigest(payload: WorkReceiptInput): string {
  return computeWorkReceiptPayloadSha256({ ...payload, payload_sha256: "" });
}

// ---------------------------------------------------------------------------
// The fixture table. Every work_receipt.* check the verifier emits must
// appear here with a function that demonstrably fires it.
// ---------------------------------------------------------------------------

export const WORK_RECEIPT_FIXTURES: readonly WorkReceiptFixture[] = [
  {
    check: "work_receipt.malformed_key",
    description:
      "primary key does not parse as source\\x00task_id\\x00run_id — a hand-edit or legacy backfill",
    plant(ledgerPath) {
      // Insert directly with a single-segment key; parseWorkReceiptKey will
      // refuse it and the verifier surfaces malformed_key. The row's other
      // fields stay contract-clean so the only finding is malformed_key.
      rawInsert({
        key: "not-a-parseable-key",
        source: WORK_RECEIPT_SOURCE,
        task_id: BASE_TASK_ID,
        run_id: BASE_RUN_ID,
        assignee: "alice",
        terminal_outcome: "completed",
        result_contract: "ok",
        quality_gate: "passed",
        completed_at: BASE_COMPLETED_AT,
        evidence_json: BASE_EVIDENCE_JSON,
        payload_sha256: canonicalDigest(basePayload()),
        recorded_at: BASE_RECORDED_AT,
      });
    },
  },
  {
    check: "work_receipt.digest_mismatch",
    description: "stored payload_sha256 disagrees with the canonical digest recomputed from the row's fields",
    plant(ledgerPath) {
      // Plant with the right KEY (so malformed_key does not co-fire) but a
      // deliberately wrong digest. 64-char hex string of all 'f's keeps the
      // field-shape valid while guaranteeing the recomputed value differs.
      rawInsert({
        key: workReceiptKey(WORK_RECEIPT_SOURCE, BASE_TASK_ID, BASE_RUN_ID),
        source: WORK_RECEIPT_SOURCE,
        task_id: BASE_TASK_ID,
        run_id: BASE_RUN_ID,
        assignee: "alice",
        terminal_outcome: "completed",
        result_contract: "ok",
        quality_gate: "passed",
        completed_at: BASE_COMPLETED_AT,
        evidence_json: BASE_EVIDENCE_JSON,
        payload_sha256: "f".repeat(64),
        recorded_at: BASE_RECORDED_AT,
      });
    },
  },
  {
    check: "work_receipt.impossible_success",
    description:
      "terminal_outcome=refused with result_contract=ok — the declared settle state contradicts the recorded contract",
    plant(ledgerPath) {
      // Use a distinct task_id so the digest_mismatch fixture (above) is not
      // accidentally re-fired. Refused + ok is exactly the contradiction the
      // strict success numerator forbids; the verifier surfaces it as
      // impossible_success, error severity.
      const payload = basePayload({
        task_id: "t_impossible_success",
        terminal_outcome: "refused",
        result_contract: "ok",
      });
      rawInsert({
        key: workReceiptKey(WORK_RECEIPT_SOURCE, payload.task_id, payload.run_id),
        source: WORK_RECEIPT_SOURCE,
        task_id: payload.task_id,
        run_id: payload.run_id,
        assignee: payload.assignee,
        terminal_outcome: payload.terminal_outcome,
        result_contract: payload.result_contract,
        quality_gate: payload.quality_gate,
        completed_at: payload.completed_at,
        evidence_json: JSON.stringify(payload.evidence),
        payload_sha256: canonicalDigest(payload),
        recorded_at: BASE_RECORDED_AT,
      });
    },
  },
  {
    check: "work_receipt.evidence_shape",
    description:
      "quality_gate=passed with zero evidence entries — the success numerator requires at least one handle",
    plant(ledgerPath) {
      const payload = basePayload({ task_id: "t_evidence_shape", evidence: [] });
      rawInsert({
        key: workReceiptKey(WORK_RECEIPT_SOURCE, payload.task_id, payload.run_id),
        source: WORK_RECEIPT_SOURCE,
        task_id: payload.task_id,
        run_id: payload.run_id,
        assignee: payload.assignee,
        terminal_outcome: payload.terminal_outcome,
        result_contract: payload.result_contract,
        quality_gate: payload.quality_gate,
        completed_at: payload.completed_at,
        evidence_json: "[]",
        payload_sha256: canonicalDigest(payload),
        recorded_at: BASE_RECORDED_AT,
      });
    },
  },
];

// ---------------------------------------------------------------------------
// Test-facing entry points.
// ---------------------------------------------------------------------------

/**
 * Run a single fixture against a fresh ledger and return the resulting
 * findings. Throws if the fixture's check does not appear at error severity,
 * or if any OTHER error-severity finding co-fires (the fixture must isolate
 * one violation — the corpus's minimality invariant, applied to the SQL
 * table). Used by corpus.test.ts.
 */
export function runFixture(fixture: WorkReceiptFixture): { check: string; severity: string }[] {
  let ledgerPath = "";
  try {
    ledgerPath = withTempLedgerPath();
    fixture.plant(ledgerPath);
    const report = verifyLedgerFile(ledgerPath);
    const errors = report.findings.filter((f) => f.severity === "error");
    const fired = errors.filter((f) => f.check === fixture.check);
    if (fired.length === 0) {
      const all = report.findings.map((f) => `${f.severity}:${f.check}`).join(", ");
      throw new Error(
        `fixture for ${fixture.check} did not raise its named check; verifier produced: ${all}`,
      );
    }
    // Other errors are tolerated if they are the SAME finding class (the
    // digest_mismatch fixture may co-fire a digest_mismatch in addition to
    // its primary), but a different work_receipt.* class co-firing means the
    // fixture's row violates more than the one invariant it claims to test.
    const otherWr = errors.filter(
      (f) => f.check.startsWith("work_receipt.") && f.check !== fixture.check,
    );
    if (otherWr.length > 0) {
      throw new Error(
        `fixture for ${fixture.check} co-fired additional work_receipt errors: ${otherWr.map((f) => f.check).join(", ")}`,
      );
    }
    return errors.map((f) => ({ check: f.check, severity: f.severity }));
  } finally {
    cleanupTempLedger();
    if (ledgerPath) {
      try {
        rmSync(join(ledgerPath, ".."), { recursive: true, force: true });
      } catch {
        /* leak the temp dir; the next suite cleans it up */
      }
    }
  }
}

/** Set of all check ids this table owns. Used by corpus.test.ts as a coverage set. */
export function fixtureCheckIds(): Set<string> {
  return new Set(WORK_RECEIPT_FIXTURES.map((f) => f.check));
}
