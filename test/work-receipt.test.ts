import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORK_RECEIPT_SCHEMA,
  WORK_RECEIPT_SOURCE,
  computeWorkReceiptPayloadSha256,
  getAllWorkReceipts,
  getWorkReceipt,
  parseWorkReceiptKey,
  recordWorkReceipt,
  validateWorkReceipt,
  workReceiptCount,
  workReceiptKey,
  type WorkReceiptInput,
} from "../src/work-receipt.js";
import {
  closeDb,
  setDbPath,
} from "../src/db.js";

// -----------------------------------------------------------------------
// Test isolation. The writer touches the live handle, so each test owns a
// temp ledger file and the read path's audit-copy logic must point at the
// same file. The two env vars are the only isolation the SOUL allows for
// the live-handle writer; tests under scripts/run-tests.mjs do not need
// them because the writer is invoked from a fresh server process.
// -----------------------------------------------------------------------

function withTempLedger<T>(run: (ledgerPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-work-receipt-test-"));
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

// Helper — builds a contract-valid receipt input with overridable fields.
function mkInput(overrides: Partial<WorkReceiptInput> = {}): WorkReceiptInput {
  const base: WorkReceiptInput = {
    schema: WORK_RECEIPT_SCHEMA,
    task_id: "t_504324f5",
    run_id: 1,
    assignee: "meshfleet",
    terminal_outcome: "completed",
    result_contract: "ok",
    quality_gate: "passed",
    completed_at: 1_700_000_000,
    evidence: [{ kind: "git_commit", handle: "abc1234" }],
    payload_sha256: "",
  };
  const merged: WorkReceiptInput = { ...base, ...overrides };
  merged.payload_sha256 = computeWorkReceiptPayloadSha256(merged);
  return merged;
}

// -----------------------------------------------------------------------
// Pure helpers: key parse/format, schema marker, payload digest.
// -----------------------------------------------------------------------

test("workReceiptKey composes (source, task_id, run_id) with NUL separators", () => {
  const key = workReceiptKey("hermes-kanban", "t_abc", 42);
  assert.equal(key, "hermes-kanban\u0000t_abc\u000042");
});

test("parseWorkReceiptKey reverses workReceiptKey and rejects bad shapes", () => {
  const parsed = parseWorkReceiptKey(workReceiptKey("a", "t_x", 7));
  assert.deepEqual(parsed, { source: "a", task_id: "t_x", run_id: 7 });

  assert.equal(parseWorkReceiptKey("only-one-part"), null);
  assert.equal(parseWorkReceiptKey("a\u0000t_x\u0000not-a-number"), null);
  assert.equal(parseWorkReceiptKey("a\u0000t_x\u0000-1"), null);
});

test("computeWorkReceiptPayloadSha256 is order-independent over evidence", () => {
  const evidenceA: Array<{ kind: "git_commit" | "attachment" | "artifact" | "command_run" | "external"; handle: string }> = [
    { kind: "git_commit", handle: "a" },
    { kind: "attachment", handle: "b" },
  ];
  const evidenceB: Array<{ kind: "git_commit" | "attachment" | "artifact" | "command_run" | "external"; handle: string }> = [
    { kind: "attachment", handle: "b" },
    { kind: "git_commit", handle: "a" },
  ];
  const base = {
    schema: WORK_RECEIPT_SCHEMA,
    task_id: "t_x",
    run_id: 1,
    assignee: "meshfleet",
    terminal_outcome: "completed" as const,
    result_contract: "ok" as const,
    quality_gate: "passed" as const,
    completed_at: 1,
    evidence: evidenceA,
    payload_sha256: "",
  };
  const fromA = computeWorkReceiptPayloadSha256({ ...base, evidence: evidenceA });
  const fromB = computeWorkReceiptPayloadSha256({ ...base, evidence: evidenceB });
  assert.equal(fromA, fromB);
});

// -----------------------------------------------------------------------
// Validation: required fields, enums, cross-field invariants, digest.
// -----------------------------------------------------------------------

test("validateWorkReceipt accepts a fully formed contract-valid payload", () => {
  const result = validateWorkReceipt(mkInput());
  assert.equal(result.ok, true);
});

test("validateWorkReceipt rejects unknown schema markers", () => {
  const input = mkInput({ schema: "some.other/v9" });
  const result = validateWorkReceipt(input);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reasons.some((r) => r.includes("schema must be the literal")));
  }
});

test("validateWorkReceipt rejects malformed task_id (not /t_[A-Za-z0-9]+/)", () => {
  const result = validateWorkReceipt(mkInput({ task_id: "not-a-task" }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reasons.some((r) => r.includes("task_id must match")));
  }
});

test("validateWorkReceipt rejects non-positive run_id", () => {
  const result = validateWorkReceipt(mkInput({ run_id: 0 }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reasons.some((r) => r.includes("run_id must be a positive integer")));
  }
});

test("validateWorkReceipt rejects unknown enum values", () => {
  const result = validateWorkReceipt(
    mkInput({ terminal_outcome: "completedish" as unknown as "completed" }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reasons.some((r) => r.includes("terminal_outcome must be one of")));
  }
});

test("validateWorkReceipt rejects payload_sha256 when it does not match the recomputed digest", () => {
  const input = mkInput();
  const tampered = { ...input, payload_sha256: "0".repeat(64) };
  const result = validateWorkReceipt(tampered);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reasons.some((r) => r.includes("payload_sha256 does not match the canonical digest")));
  }
});

test("validateWorkReceipt rejects the impossible success combination terminal_outcome=completed + result_contract=refused", () => {
  const result = validateWorkReceipt(
    mkInput({ terminal_outcome: "completed", result_contract: "refused" }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reasons.some((r) => r.includes("terminal_outcome=completed requires result_contract in {ok, artifact_missing}")));
  }
});

test("validateWorkReceipt rejects terminal_outcome=refused + result_contract=ok", () => {
  const result = validateWorkReceipt(
    mkInput({ terminal_outcome: "refused", result_contract: "ok" }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reasons.some((r) => r.includes("forbids result_contract=ok")));
  }
});

test("validateWorkReceipt rejects quality_gate=passed without at least one evidence entry", () => {
  const result = validateWorkReceipt(mkInput({ evidence: [] }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reasons.some((r) => r.includes("quality_gate=passed requires at least one evidence entry")));
  }
});

test("validateWorkReceipt rejects evidence entries that are absolute Windows paths or home-tilde refs", () => {
  const winResult = validateWorkReceipt(
    mkInput({ evidence: [{ kind: "git_commit", handle: "C:\\Users\\x\\file" }] as unknown as WorkReceiptInput["evidence"] }),
  );
  assert.equal(winResult.ok, false);

  const tildeResult = validateWorkReceipt(
    mkInput({ evidence: [{ kind: "attachment", handle: "~/.ssh/id_rsa" }] as unknown as WorkReceiptInput["evidence"] }),
  );
  assert.equal(tildeResult.ok, false);
});

test("validateWorkReceipt rejects evidence digest that is not a 64-char hex SHA-256", () => {
  const result = validateWorkReceipt(
    mkInput({
      evidence: [{ kind: "git_commit", handle: "abc", digest: "deadbeef" }],
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reasons.some((r) => r.includes("digest must be a 64-char hex SHA-256")));
  }
});

test("validateWorkReceipt rejects unknown evidence kinds", () => {
  const result = validateWorkReceipt(
    mkInput({
      evidence: [{ kind: "made_up_kind", handle: "x" }] as unknown as WorkReceiptInput["evidence"],
    }),
  );
  assert.equal(result.ok, false);
});

// -----------------------------------------------------------------------
// Writer: insert, replay, conflict, read-back, event-log discipline.
// -----------------------------------------------------------------------

test("recordWorkReceipt inserts a fresh row and returns inserted", () => {
  withTempLedger(() => {
    const result = recordWorkReceipt(mkInput());
    assert.ok("outcome" in result);
    if ("outcome" in result) {
      assert.equal(result.outcome.kind, "inserted");
    }
  });
});

test("recordWorkReceipt on byte-equivalent replay returns replayed with the ORIGINAL recorded_at", () => {
  withTempLedger(() => {
    const first = recordWorkReceipt(mkInput());
    assert.ok("outcome" in first && first.outcome.kind === "inserted");
    const firstRecordedAt = (first as { outcome: { recorded_at: number } }).outcome.recorded_at;

    // Wait a tiny moment so a fresh INSERT would yield a different recorded_at;
    // the replay must return the ORIGINAL.
    const sleepMs = 5;
    const start = Date.now();
    while (Date.now() - start < sleepMs) {
      /* spin */
    }

    const second = recordWorkReceipt(mkInput());
    assert.ok("outcome" in second);
    if ("outcome" in second) {
      assert.equal(second.outcome.kind, "replayed");
      assert.equal(second.outcome.recorded_at, firstRecordedAt);
    }
  });
});

test("recordWorkReceipt on conflicting replay (same key, different bytes) refuses history", () => {
  withTempLedger(() => {
    const first = recordWorkReceipt(mkInput({ assignee: "alice" }));
    assert.ok("outcome" in first && first.outcome.kind === "inserted");

    const conflicting = recordWorkReceipt(mkInput({ assignee: "bob" }));
    assert.ok("outcome" in conflicting);
    if ("outcome" in conflicting) {
      assert.equal(conflicting.outcome.kind, "conflict");
      if (conflicting.outcome.kind === "conflict") {
        assert.equal(typeof conflicting.outcome.existing_payload_sha256, "string");
        assert.equal(conflicting.outcome.existing_payload_sha256.length, 64);
      }
    }
  });
});

test("recordWorkReceipt rejects invalid input and never mutates the ledger", () => {
  withTempLedger((ledgerPath) => {
    const result = recordWorkReceipt({ schema: "wrong" });
    assert.ok("error" in result);
    assert.equal(workReceiptCount(), 0);

    // The file was created by setDbPath's first-open; an invalid record MUST
    // not have left any row behind.
    assert.ok(existsSync(ledgerPath));
  });
});

test("getWorkReceipt returns the exact bytes that were recorded", () => {
  withTempLedger(() => {
    const input = mkInput({ assignee: "carol" });
    const written = recordWorkReceipt(input);
    assert.ok("outcome" in written && written.outcome.kind === "inserted");

    const readBack = getWorkReceipt(WORK_RECEIPT_SOURCE, "t_504324f5", 1);
    assert.equal(readBack.ok, true);
    if (readBack.ok) {
      assert.equal(readBack.receipt.assignee, "carol");
      assert.equal(readBack.receipt.payload_sha256, input.payload_sha256);
      assert.equal(readBack.receipt.task_id, "t_504324f5");
      assert.equal(readBack.receipt.run_id, 1);
      assert.equal(readBack.receipt.schema, WORK_RECEIPT_SCHEMA);
    }
  });
});

test("getWorkReceipt returns not_found when no row exists", () => {
  withTempLedger(() => {
    const readBack = getWorkReceipt(WORK_RECEIPT_SOURCE, "t_missing", 99);
    assert.equal(readBack.ok, false);
    if (!readBack.ok) {
      assert.equal(readBack.reason, "not_found");
    }
  });
});

test("getWorkReceipt rejects unknown source strings", () => {
  withTempLedger(() => {
    const readBack = getWorkReceipt("not-a-known-source", "t_x", 1);
    assert.equal(readBack.ok, false);
    if (!readBack.ok) {
      assert.match(readBack.reason, /unknown source/);
    }
  });
});

test("getAllWorkReceipts returns rows across multiple distinct keys", () => {
  withTempLedger(() => {
    recordWorkReceipt(mkInput({ task_id: "t_a", run_id: 1 }));
    recordWorkReceipt(mkInput({ task_id: "t_b", run_id: 2 }));
    const all = getAllWorkReceipts();
    const ids = all.map((r) => `${r.task_id}:${r.run_id}`);
    assert.ok(ids.includes("t_a:1"));
    assert.ok(ids.includes("t_b:2"));
  });
});

// -----------------------------------------------------------------------
// Surface file (zero import side-effect of importing the module).
// -----------------------------------------------------------------------

test("work-receipt module imports cleanly and exposes the schema constant", () => {
  assert.equal(WORK_RECEIPT_SCHEMA, "hermes.kanban-result/v1");
  assert.equal(WORK_RECEIPT_SOURCE, "hermes-kanban");
});

// -----------------------------------------------------------------------
// Sanity: ensure the temp file does not bleed across tests via a stray
// directory entry — checked by the run ordering (each test owns its own
// mkdtempSync). This last test guards the invariant: an empty writer state
// at module load.
// -----------------------------------------------------------------------

test("writer state is empty before any record (no cross-test bleed)", () => {
  withTempLedger(() => {
    assert.equal(workReceiptCount(), 0);
    assert.deepEqual(getAllWorkReceipts(), []);
  });
});