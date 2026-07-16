import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  createFleet,
  getInbox,
  registerAgentInLedger,
  sendMessages,
  MAX_BATCH_MESSAGES,
  type Agent,
} from "../src/core.js";
import { lastTxnStats } from "../src/db.js";
import { withTempDb } from "./helpers/with-temp-db.js";

function agent(id: string, fleetId: string): Agent {
  return { id, fleet_id: fleetId, role: "worker", prompt: "p", status: "running" };
}

function seed(): void {
  createFleet("f1");
  registerAgentInLedger(agent("a1", "f1"));
  registerAgentInLedger(agent("a2", "f1"));
  registerAgentInLedger(agent("a3", "f1"));
}

const item = (i: number) => ({
  fromAgentId: "a1",
  toAgentId: "a2",
  fleetId: "f1",
  type: "result" as const,
  payload: `p${i}`,
});

test("sendMessages delivers the whole batch in ONE transaction, in order", () => {
  const l = withTempDb();
  try {
    seed();
    const results = sendMessages(Array.from({ length: 50 }, (_, i) => item(i)));
    assert.equal(results.length, 50);
    const inbox = getInbox("a2");
    assert.equal(inbox.length, 50);
    assert.deepEqual(inbox.map((m) => m.payload), Array.from({ length: 50 }, (_, i) => `p${i}`));
    assert.deepEqual(inbox.map((m) => m.id), results.map((r) => r.messageId));
  } finally {
    l.cleanup();
  }
});

test("a batch is atomic: one oversized payload rejects the WHOLE batch", () => {
  const l = withTempDb();
  try {
    seed();
    const batch = [item(0), { ...item(1), payload: "x".repeat(65 * 1024) }, item(2)];
    assert.throws(() => sendMessages(batch), /Payload too large/);
    assert.equal(getInbox("a2").length, 0, "nothing from a rejected batch may persist");
  } finally {
    l.cleanup();
  }
});

test("broadcasts inside a batch resolve recipients like single sends", () => {
  const l = withTempDb();
  try {
    seed();
    const [r] = sendMessages([{ ...item(0), toAgentId: "*" }]);
    assert.deepEqual([...r.recipients].sort(), ["a2", "a3"]);
    assert.equal(getInbox("a3").length, 1);
  } finally {
    l.cleanup();
  }
});

test("a batch pays the inbox parse once, not once per message", () => {
  const l = withTempDb();
  try {
    seed();
    sendMessages(Array.from({ length: 300 }, (_, i) => item(i))); // grow the inbox row
    sendMessages(Array.from({ length: 200 }, (_, i) => item(1000 + i)));
    assert.ok(
      lastTxnStats().rowsParsed < 20,
      `batched send parsed ${lastTxnStats().rowsParsed} rows — coalescing is broken`,
    );
  } finally {
    l.cleanup();
  }
});

test("batches beyond MAX_BATCH_MESSAGES are rejected up front (bounded transactions)", () => {
  const l = withTempDb();
  try {
    seed();
    const batch = Array.from({ length: MAX_BATCH_MESSAGES + 1 }, (_, i) => item(i));
    assert.throws(() => sendMessages(batch), /batch too large/i);
    assert.equal(getInbox("a2").length, 0);
  } finally {
    l.cleanup();
  }
});

test("an empty batch is a no-op returning []", () => {
  const l = withTempDb();
  try {
    seed();
    assert.deepEqual(sendMessages([]), []);
  } finally {
    l.cleanup();
  }
});

test("send_messages is advertised as an MCP tool", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8");
  assert.match(source, /name: "send_messages"/);
  assert.match(source, /toolHandlers\["send_messages"\]\s*=/);
});
