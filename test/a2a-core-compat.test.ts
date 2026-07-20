import { test } from "node:test";
import assert from "node:assert/strict";

import { createFleet, getInbox, registerAgentInLedger, sendMessage, type Agent } from "../src/core.js";
import { withTempDb } from "./helpers/with-temp-db.js";

function agent(id: string): Agent {
  return { id, fleet_id: "f1", role: "worker", prompt: "p", status: "running" };
}

test("existing sendMessage direct API remains a canonical-mapped legacy projection", () => {
  const ledger = withTempDb();
  try {
    createFleet("f1");
    const result = sendMessage("a1", "a2", "f1", "result", "payload", "corr");
    assert.deepEqual(result.recipients, ["a2"]);
    assert.deepEqual(getInbox("a2")[0], {
      id: result.messageId, from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1", type: "result",
      payload: "payload", correlation_id: "corr", timestamp: getInbox("a2")[0]!.timestamp, acknowledged: false,
    });
  } finally {
    ledger.cleanup();
  }
});

test("existing sendMessage broadcast API preserves resolved recipients and wildcard projection", () => {
  const ledger = withTempDb();
  try {
    createFleet("f1");
    registerAgentInLedger(agent("a1"));
    registerAgentInLedger(agent("a2"));
    registerAgentInLedger(agent("a3"));
    const result = sendMessage("a1", "*", "f1", "handoff", "payload");
    assert.deepEqual(result.recipients, ["a2", "a3"]);
    const message = getInbox("a2")[0]!;
    assert.equal(message.to_agent_id, "*");
    assert.deepEqual(message.recipients, ["a2", "a3"]);
    assert.equal(getInbox("a3")[0]!.id, message.id);
  } finally {
    ledger.cleanup();
  }
});
