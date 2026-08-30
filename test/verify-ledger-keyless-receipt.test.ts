import { test } from "node:test";
import assert from "node:assert/strict";

import type { MeshData } from "../src/core.js";
import { verifyMeshData } from "../src/verify.js";

/**
 * GOAL-PROMPT priority 2 (audit truth): the verifier has shipped three
 * failure classes found from the outside — forged ack, keyless receipt,
 * capability naming no agent. This test pins the "keyless receipt" class:
 * a receipt row with no usable agent_id must produce an ERROR finding
 * (`receipt.missing_agent_id`) and flip `ok` to false.
 *
 * The test MUST fail if the guard at src/verify.ts line 590
 * (`if (!isUsableAgentId(r.agent_id) && r.agent_id !== BROADCAST)`) is
 * relaxed or removed — i.e. it exercises the guard, not just the current
 * output shape. A ledger that accepts a keyless receipt silently is
 * exactly the false-green this product exists to prevent.
 */

function minimalLedgerWithReceipt(agentId: string | undefined | null): MeshData {
  // The inbox must NOT contain msg-1 for agent-b when agent-b holds an ack receipt —
  // an ack consumes the inbox entry. For the keyless-receipt tests (undefined/""),
  // the receipt is malformed and will be rejected before the inbox check runs, so
  // the inbox state is irrelevant there. For the positive control (agent-b), the
  // inbox must be empty to avoid triggering inbox.acked_still_queued.
  const hasValidAck = agentId === "agent-b";
  return {
    fleets: {
      "fleet-a": { id: "fleet-a", status: "running", created_at: 1 },
    },
    agents: {
      "agent-a": {
        id: "agent-a",
        fleet_id: "fleet-a",
        role: "worker",
        prompt: "test",
        status: "running",
      },
      "agent-b": {
        id: "agent-b",
        fleet_id: "fleet-a",
        role: "worker",
        prompt: "test",
        status: "running",
      },
    },
    messages: {
      "msg-1": {
        id: "msg-1",
        from_agent_id: "agent-a",
        to_agent_id: "agent-b",
        fleet_id: "fleet-a",
        type: "handoff",
        payload: "test",
        timestamp: 2,
        acknowledged: hasValidAck,
      },
    },
    inboxes: {
      "agent-a": [],
      "agent-b": hasValidAck ? [] : ["msg-1"],
    },
    capabilities: {},
    receipts: {
      // The key is constructed with the agent_id as given — if agent_id is
      // undefined, the key becomes "msg-1:undefined:ack", which is exactly
      // the shape the write path could produce before the guard landed.
      [`msg-1:${String(agentId)}:ack`]: {
        message_id: "msg-1",
        agent_id: agentId as string,
        action: "ack",
        timestamp: 3,
      },
    },
    ratifications: {},
    templates: {},
  };
}

test("verify_ledger rejects a receipt with no usable agent_id (keyless-receipt class)", () => {
  const data = minimalLedgerWithReceipt(undefined);
  const report = verifyMeshData(data);

  assert.equal(report.ok, false, "a keyless receipt must flip ok to false — silent acceptance is the failure this product exists to prevent");
  assert.ok(report.errors > 0, "at least one error finding must fire");

  const missingAgentIdFindings = report.findings.filter((f) => f.check === "receipt.missing_agent_id");
  assert.ok(missingAgentIdFindings.length >= 1, "expected at least one receipt.missing_agent_id finding");
  assert.equal(missingAgentIdFindings[0]!.severity, "error", "keyless receipt is an audit-breaking error, not a warning");
});

test("verify_ledger rejects a receipt with an empty-string agent_id (keyless-receipt class, alternate shape)", () => {
  const data = minimalLedgerWithReceipt("");
  const report = verifyMeshData(data);

  assert.equal(report.ok, false, "an empty-string agent_id is equally keyless — the guard must not distinguish undefined from empty");
  const missingAgentIdFindings = report.findings.filter((f) => f.check === "receipt.missing_agent_id");
  assert.ok(missingAgentIdFindings.length >= 1, "expected at least one receipt.missing_agent_id finding for empty-string agent_id");
});

test("verify_ledger accepts a receipt with a usable agent_id (positive control)", () => {
  const data = minimalLedgerWithReceipt("agent-b");
  const report = verifyMeshData(data);

  const missingAgentIdFindings = report.findings.filter((f) => f.check === "receipt.missing_agent_id");
  assert.equal(missingAgentIdFindings.length, 0, "a receipt with a real agent_id must not trigger the keyless-receipt guard");
  // The positive control must pass — if it fails, the test setup is broken, not the guard.
  assert.equal(report.ok, true, "a well-formed receipt must verify ok");
});
