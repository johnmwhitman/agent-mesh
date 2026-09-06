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
  /**
   * The set of OTHER work_receipt.* checks that may legitimately co-fire
   * alongside the primary. The fixture's planted rows necessarily trip
   * more than one invariant (e.g. duplicate_logical_key co-fires with
   * identity_mismatch on the realistic corrupted-ledger shape). Names
   * here must match other fixture check ids in this table. Any
   * work_receipt.* finding outside (check ∪ coFiresWith) is a fixture
   * drift — it means the planted rows broke an invariant the fixture
   * didn't claim to test, and the fixture must be tightened. Default
   * empty (no co-fire is allowed).
   */
  coFiresWith?: readonly string[];
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
  {
    check: "work_receipt.identity_mismatch",
    description:
      "parsed primary key disagrees with the row's own stored (source, task_id, run_id) — the lookup-shape and the identity columns are out of sync",
    plant(ledgerPath) {
      // Plant a single row whose primary key parses to
      // (hermes-kanban, t_identity_peer, 1) but whose stored identity
      // columns are (hermes-kanban, t_identity_mismatch, 1). The
      // mismatch is reported on its own row; no duplicate can fire
      // because the stored identity tuple is unique on this ledger.
      const storedTask = "t_identity_mismatch";
      const payload = basePayload({ task_id: storedTask });
      rawInsert({
        // Key bytes intentionally differ from the stored task_id — a
        // hand-edit or a legacy backfill that wrote the key from a
        // different source than the row's own identity columns.
        key: workReceiptKey(WORK_RECEIPT_SOURCE, "t_identity_peer", payload.run_id),
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
    check: "work_receipt.duplicate_logical_key",
    description:
      "two stored rows share (source, task_id, run_id) — the v5 schema has no UNIQUE INDEX on the logical identity tuple, so a legacy backfill or hand-edit can produce duplicates",
    coFiresWith: ["work_receipt.identity_mismatch"],
    plant(ledgerPath) {
      // Two rows whose stored identity is identical. One row's key
      // agrees with its stored identity; the other's key disagrees —
      // exactly the supplier fixture's corrupted-ledger shape. The
      // duplicate_logical_key finding fires on both rows because they
      // share the stored identity tuple; the identity_mismatch finding
      // co-fires on the second row. The fixture assertion in
      // corpus.test.ts checks for duplicate_logical_key at error
      // severity; the co-firing identity_mismatch is the same finding
      // class as the standalone fixture above, which the runFixture
      // helper tolerates as "same-class co-fire".
      const sharedTask = "t_duplicate_logical";
      const sharedRun = 2;
      const payload = basePayload({ task_id: sharedTask, run_id: sharedRun });
      rawInsert({
        key: workReceiptKey(WORK_RECEIPT_SOURCE, sharedTask, sharedRun),
        source: WORK_RECEIPT_SOURCE,
        task_id: sharedTask,
        run_id: sharedRun,
        assignee: payload.assignee,
        terminal_outcome: payload.terminal_outcome,
        result_contract: payload.result_contract,
        quality_gate: payload.quality_gate,
        completed_at: payload.completed_at,
        evidence_json: JSON.stringify(payload.evidence),
        payload_sha256: canonicalDigest(payload),
        recorded_at: BASE_RECORDED_AT,
      });
      rawInsert({
        // Second row's key disagrees with its stored task_id so the
        // duplicate fixture exercises the same realistic shape the
        // supplier fixture uses — both invariants necessarily co-fire.
        key: workReceiptKey(WORK_RECEIPT_SOURCE, "t_duplicate_peer", sharedRun),
        source: WORK_RECEIPT_SOURCE,
        task_id: sharedTask,
        run_id: sharedRun,
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
    // Other work_receipt.* errors are tolerated only when the fixture
    // named them in `coFiresWith`. The contract is: a fixture plants a
    // minimal row shape that trips one invariant; if its row ALSO
    // breaks a second invariant the table has a fixture for, the
    // fixture's `coFiresWith` must name that second invariant so the
    // co-fire is loud in source. Any work_receipt.* finding outside
    // (check ∪ coFiresWith) is a drift — the fixture broke an
    // invariant it didn't claim to test.
    const allowed = new Set<string>([fixture.check, ...(fixture.coFiresWith ?? [])]);
    const otherWr = errors.filter(
      (f) => f.check.startsWith("work_receipt.") && !allowed.has(f.check),
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
