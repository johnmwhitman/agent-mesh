import { test } from "node:test";
import assert from "node:assert/strict";

import { sendMessage, writeReceipt, getRecentReceipts, type Receipt } from "../src/core.js";
import { withTempDb } from "./helpers/with-temp-db.js";

// ---------------------------------------------------------------------------
// D2.1: getRecentReceipts — global ledger view for the dashboard timeline.
// ---------------------------------------------------------------------------

test("getRecentReceipts returns empty list on a clean ledger", () => {
  const l = withTempDb();
  try {
    assert.deepEqual(getRecentReceipts(10), []);
  } finally {
    l.cleanup();
  }
});

test("getRecentReceipts accepts non-positive limits without throwing", () => {
  const l = withTempDb();
  try {
    assert.deepEqual(getRecentReceipts(0), []);
    assert.deepEqual(getRecentReceipts(-1), []);
    assert.deepEqual(getRecentReceipts(NaN), []);
  } finally {
    l.cleanup();
  }
});

test("getRecentReceipts returns the latest ledger receipts sorted by timestamp desc", () => {
  const l = withTempDb();
  try {
    const { messageId: m1 } = sendMessage("a1", "a2", "f1", "handoff", "first");
    const { messageId: m2 } = sendMessage("a3", "a4", "f1", "handoff", "second");
    writeReceipt("a2", m1, "ack");
    writeReceipt("a4", m2, "r-ack", "approved");

    const recent: Receipt[] = getRecentReceipts(10);
    assert.equal(recent.length, 2);
    for (let i = 1; i < recent.length; i++) {
      assert.ok(
        recent[i - 1].timestamp >= recent[i].timestamp,
        "receipts must be sorted by timestamp descending",
      );
    }
  } finally {
    l.cleanup();
  }
});

test("getRecentReceipts filters by fleet via the receipt's message", () => {
  const l = withTempDb();
  try {
    const { messageId: m1 } = sendMessage("a1", "a2", "f1", "handoff", "in-f1");
    const { messageId: m2 } = sendMessage("a3", "a4", "f2", "handoff", "in-f2");
    writeReceipt("a2", m1, "ack");
    writeReceipt("a4", m2, "ack");

    const f1Only = getRecentReceipts(10, "f1");
    assert.equal(f1Only.length, 1);
    assert.equal(f1Only[0].message_id, m1);

    const f2Only = getRecentReceipts(10, "f2");
    assert.equal(f2Only.length, 1);
    assert.equal(f2Only[0].message_id, m2);

    const unknown = getRecentReceipts(10, "fleet-that-never-existed");
    assert.equal(unknown.length, 0);
  } finally {
    l.cleanup();
  }
});

test("getRecentReceipts respects the limit, returning the most recent N", () => {
  const l = withTempDb();
  try {
    for (let i = 0; i < 5; i++) {
      const { messageId } = sendMessage("a1", "a2", "f1", "handoff", `msg-${i}`);
      writeReceipt("a2", messageId, "ack");
    }
    const recent = getRecentReceipts(3);
    assert.equal(recent.length, 3);
  } finally {
    l.cleanup();
  }
});

test("getRecentReceipts skips receipts whose message has been pruned", () => {
  const l = withTempDb();
  try {
    const { messageId: m1 } = sendMessage("a1", "a2", "f1", "handoff", "live");
    writeReceipt("a2", m1, "ack");

    l.seed({
      messages: {
        [m1]: { id: m1, fleet_id: "f1", from_agent_id: "a1", to_agent_id: "a2", type: "handoff", payload: "live", timestamp: 1, acknowledged: false },
      },
      receipts: {
        [`${m1}:a2:ack`]: { message_id: m1, agent_id: "a2", action: "ack", timestamp: 2 },
      },
    });
    const before = getRecentReceipts(10, "f1");
    assert.equal(before.length, 1, "live receipt surfaces on a clean ledger");

    l.seed({
      messages: {},
      receipts: {
        [`${m1}:a2:ack`]: { message_id: m1, agent_id: "a2", action: "ack", timestamp: 2 },
      },
    });
    const after = getRecentReceipts(10, "f1");
    assert.equal(after.length, 0, "orphaned receipt (message gone) must not surface");
  } finally {
    l.cleanup();
  }
});
