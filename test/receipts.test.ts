import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ackMessage,
  BROADCAST,
  getInbox,
  getReceipts,
  loadData,
  loadDataFromFile,
  messageRecipients,
  registerAgentInLedger,
  sendMessage,
  writeReceipt,
  type Agent,
} from "../src/core.js";
import { withTempDb } from "./helpers/with-temp-db.js";

function agent(id: string, fleetId: string): Agent {
  return { id, fleet_id: fleetId, role: "worker", prompt: "p", status: "running" };
}

// ---------------------------------------------------------------------------
// Receipts: ack as receipt
// ---------------------------------------------------------------------------

test("ack writes a timestamped receipt", () => {
  const l = withTempDb();
  try {
    const { messageId: msgId } = sendMessage("a1", "a2", "f1", "handoff", "x");
    assert.equal(ackMessage("a2", msgId), true);
    const receipts = getReceipts(msgId);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].agent_id, "a2");
    assert.equal(receipts[0].action, "ack");
    assert.ok(receipts[0].timestamp > 0);
  } finally {
    l.cleanup();
  }
});

test("double ack is idempotent: one receipt", () => {
  const l = withTempDb();
  try {
    const { messageId: msgId } = sendMessage("a1", "a2", "f1", "handoff", "x");
    ackMessage("a2", msgId);
    ackMessage("a2", msgId);
    assert.equal(getReceipts(msgId).length, 1);
  } finally {
    l.cleanup();
  }
});

test("ack of unknown message returns false", () => {
  const l = withTempDb();
  try {
    assert.equal(ackMessage("a2", "nope"), false);
    assert.equal(writeReceipt("a2", "nope", "seen"), null);
  } finally {
    l.cleanup();
  }
});

test("direct message: acknowledged flag set by recipient ack", () => {
  const l = withTempDb();
  try {
    const { messageId: msgId } = sendMessage("a1", "a2", "f1", "handoff", "x");
    ackMessage("a2", msgId);
    assert.equal(loadData().messages[msgId].acknowledged, true);
    assert.equal(getInbox("a2").length, 0);
  } finally {
    l.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Non-consuming receipts
// ---------------------------------------------------------------------------

test("non-ack receipt annotates without consuming", () => {
  const l = withTempDb();
  try {
    const { messageId: msgId } = sendMessage("a1", "a2", "f1", "question", "ratify?");
    const r = writeReceipt("a2", msgId, "r-ack", "approved");
    assert.ok(r);
    assert.equal(r.note, "approved");
    assert.equal(getInbox("a2").length, 1, "message stays in inbox");
    assert.equal(loadData().messages[msgId].acknowledged, false);
  } finally {
    l.cleanup();
  }
});

test("same agent can hold multiple receipt actions on one message", () => {
  const l = withTempDb();
  try {
    const { messageId: msgId } = sendMessage("a1", "a2", "f1", "handoff", "x");
    writeReceipt("a2", msgId, "seen");
    ackMessage("a2", msgId);
    const actions = getReceipts(msgId).map((r) => r.action).sort();
    assert.deepEqual(actions, ["ack", "seen"]);
  } finally {
    l.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

test("broadcast delivers to every other fleet agent", () => {
  const l = withTempDb();
  try {
    registerAgentInLedger(agent("a1", "f1"));
    registerAgentInLedger(agent("a2", "f1"));
    registerAgentInLedger(agent("a3", "f1"));
    registerAgentInLedger(agent("b1", "f2")); // other fleet, excluded
    const { messageId: msgId } = sendMessage("a1", BROADCAST, "f1", "alert", "fleet notice");
    const msg = loadData().messages[msgId];
    assert.deepEqual(messageRecipients(msg).sort(), ["a2", "a3"]);
    assert.equal(getInbox("a2").length, 1);
    assert.equal(getInbox("a3").length, 1);
    assert.equal(getInbox("a1").length, 0, "sender does not receive");
    assert.equal(getInbox("b1").length, 0, "other fleets do not receive");
  } finally {
    l.cleanup();
  }
});

test("broadcast acknowledged only when ALL recipients ack", () => {
  const l = withTempDb();
  try {
    registerAgentInLedger(agent("a1", "f1"));
    registerAgentInLedger(agent("a2", "f1"));
    registerAgentInLedger(agent("a3", "f1"));
    const { messageId: msgId } = sendMessage("a1", BROADCAST, "f1", "alert", "x");
    ackMessage("a2", msgId);
    assert.equal(loadData().messages[msgId].acknowledged, false, "one ack is not enough");
    assert.equal(getInbox("a3").length, 1, "a3 still has it");
    ackMessage("a3", msgId);
    assert.equal(loadData().messages[msgId].acknowledged, true);
    assert.equal(getReceipts(msgId).length, 2, "two independent receipts");
  } finally {
    l.cleanup();
  }
});

test("broadcast with no other agents throws", () => {
  const l = withTempDb();
  try {
    registerAgentInLedger(agent("a1", "f1"));
    assert.throws(() => sendMessage("a1", BROADCAST, "f1", "alert", "x"), /no recipients/);
  } finally {
    l.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Migration v1 -> v2
// ---------------------------------------------------------------------------

test("v1 ledger migration backfills receipts for acknowledged messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-mesh-receipts-mig-"));
  const file = join(dir, "ledger.json");
  try {
    writeFileSync(
      file,
      JSON.stringify({
        schema_version: 1,
        fleets: {},
        agents: {},
        messages: {
          m1: {
            id: "m1",
            from_agent_id: "a1",
            to_agent_id: "a2",
            fleet_id: "f1",
            type: "handoff",
            payload: "x",
            timestamp: 123,
            acknowledged: true,
          },
          m2: {
            id: "m2",
            from_agent_id: "a1",
            to_agent_id: "a2",
            fleet_id: "f1",
            type: "handoff",
            payload: "y",
            timestamp: 456,
            acknowledged: false,
          },
        },
        inboxes: { a2: ["m2"] },
        capabilities: {},
      })
    );
    const data = loadDataFromFile(file);
    const receipts = Object.values(data.receipts ?? {});
    assert.equal(receipts.length, 1, "only the acked message gets a backfill");
    assert.equal(receipts[0].message_id, "m1");
    assert.equal(receipts[0].agent_id, "a2");
    assert.equal(receipts[0].action, "ack");
    assert.equal(receipts[0].note, "backfilled_from_v1_acknowledged_flag");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("receipts survive a save/load round-trip through the ledger", () => {
  const l = withTempDb();
  try {
    const { messageId: msgId } = sendMessage("a1", "a2", "f1", "handoff", "x");
    writeReceipt("a2", msgId, "seen");
    ackMessage("a2", msgId);
    // loadData round-trips through JSON in the override; receipts must persist
    const receipts = getReceipts(msgId);
    assert.equal(receipts.length, 2);
  } finally {
    l.cleanup();
  }
});
