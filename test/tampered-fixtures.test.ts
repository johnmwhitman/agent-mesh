import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyMeshData } from "../src/verify.js";
import { loadDataFromFile } from "../src/core.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function found(report: any, check: string) {
  return report.findings.filter((f: any) => f.check === check);
}

test("verifier catches tampered timestamps", () => {
  const file = join(__dirname, "fixtures", "tampered-timestamps.json");
  const data = loadDataFromFile(file);
  const report = verifyMeshData(data);
  assert.equal(report.ok, false);
  const errors = found(report, "agent.tampered_timestamp");
  assert.ok(errors.length > 0, "Expected agent.tampered_timestamp error");
});

test("an invalid early ack cannot prove acknowledgement", () => {
  const file = join(__dirname, "fixtures", "tampered-identities.json");
  const data = loadDataFromFile(file);
  data.fleets = { f1: { id: "f1", status: "running", created_at: 500 } };
  data.agents = {
    a1: { id: "a1", fleet_id: "f1", role: "worker", status: "running", prompt: "test" },
    a2: { id: "a2", fleet_id: "f1", role: "worker", status: "running", prompt: "test" },
  };
  data.messages = {
    m1: {
      id: "m1",
      from_agent_id: "a1",
      to_agent_id: "a2",
      fleet_id: "f1",
      type: "handoff",
      payload: "do the thing",
      timestamp: 1_000,
      acknowledged: true,
    },
  };
  data.inboxes = { a1: [], a2: [] };
  data.receipts = {
    "m1:a2:ack": { message_id: "m1", agent_id: "a2", action: "ack", timestamp: 999 },
  };

  const report = verifyMeshData(data);
  assert.ok(report.findings.some((f) => f.check === "message.ack_flag_mismatch"));
});

test("timestamp zero is validated", () => {
  const file = join(__dirname, "fixtures", "tampered-timestamps.json");
  const data = loadDataFromFile(file);
  data.agents.a1.started_at = 0;
  const report = verifyMeshData(data);
  assert.ok(report.findings.some((f) => f.check === "agent.tampered_timestamp"));
});
