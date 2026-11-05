import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ackMessage, createFleet, registerAgentInLedger, registerCapability, sendMessage } from "../src/core.js";
import { withStorageTransaction } from "../src/db.js";
import { LifecycleStore } from "../src/attempt-lifecycle.js";
import { castVote, openRatification, resolveRatification } from "../src/ratify.js";
import { computeWorkReceiptPayloadSha256, recordWorkReceipt, WORK_RECEIPT_SCHEMA, type WorkReceiptInput } from "../src/work-receipt.js";
import { verifyLedgerFile, type VerifyFinding } from "../src/verify.js";
import { formatVerifyExplanation } from "../src/inspector.js";
import { withTempDb } from "./helpers/with-temp-db.js";

// Real writers, real SQLite, all relevant streams; no provider or runtime starts.
export function withHealthyLedger(run: (file: string, now: number) => void): void {
  const temp = withTempDb();
  try {
    createFleet("f");
    for (const id of ["a", "b"]) registerAgentInLedger({ id, fleet_id: "f", role: "worker", prompt: "p", status: "running" });
    registerCapability({ agentId: "a", fleetId: "f", role: "worker", skills: ["review"] });
    const { messageId } = sendMessage("a", "b", "f", "handoff", "review");
    assert.equal(ackMessage("b", messageId), true);
    const proposal = openRatification({ proposer: "a", fleetId: "f", subject: "plan", quorum: 1 });
    assert.equal(castVote("b", proposal, true), true);
    assert.equal(resolveRatification(proposal), "ratified");
    const input: WorkReceiptInput = {
      schema: WORK_RECEIPT_SCHEMA, task_id: "t_metadata", run_id: 1, assignee: "a",
      terminal_outcome: "completed", result_contract: "ok", quality_gate: "passed",
      completed_at: Math.floor(Date.now() / 1000) - 60,
      evidence: [{ kind: "git_commit", handle: "fixture" }], payload_sha256: "",
    };
    input.payload_sha256 = computeWorkReceiptPayloadSha256(input);
    assert.equal("error" in recordWorkReceipt(input), false);
    createFleet("durable");
    withStorageTransaction((db) => db.prepare("UPDATE fleets SET lifecycle_mode = 'durable' WHERE id = 'durable'").run());
    new LifecycleStore().createWork({ workId: "w", fleetId: "durable" });
    const now = Date.now();
    assert.deepEqual(audit(temp.dbFile, now), []);
    run(temp.dbFile, now);
  } finally { temp.cleanup(); }
}

export function audit(file: string, now: number): VerifyFinding[] {
  const before = readFileSync(file);
  const report = verifyLedgerFile(file, now);
  assert.deepEqual(readFileSync(file), before, "audit must preserve source database bytes");
  return report.findings;
}

export function expectDiagnostic(findings: VerifyFinding[], check: string, severity: "warning" | "error" = "warning"): void {
  const hits = findings.filter((f) => f.check === check);
  assert.equal(hits.length, 1, JSON.stringify(findings));
  assert.equal(hits[0].severity, severity);
  assert.doesNotMatch(formatVerifyExplanation(hits[0]), /not a check this build knows/);
}
