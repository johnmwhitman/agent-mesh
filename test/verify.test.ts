import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ackMessage,
  createFleet,
  registerAgentInLedger,
  sendMessage,
  type Agent,
  type MeshData,
  type Message,
  type Ratification,
  type Receipt,
} from "../src/core.js";
import { castVote, openRatification, resolveRatification } from "../src/ratify.js";
import { verifyLedger, verifyMeshData, type VerifyReport } from "../src/verify.js";
import { withTempDb } from "./helpers/with-temp-db.js";

// ---------------------------------------------------------------------------
// Fixture builders — raw MeshData, so we can construct states the write API
// (correctly) refuses to produce.
// ---------------------------------------------------------------------------

function mesh(over: Partial<MeshData> = {}): MeshData {
  return {
    fleets: {},
    agents: {},
    messages: {},
    inboxes: {},
    capabilities: {},
    receipts: {},
    ratifications: {},
    templates: {},
    ...over,
  };
}

function agent(id: string, fleetId: string): Agent {
  return { id, fleet_id: fleetId, role: "worker", prompt: "p", status: "running" };
}

function msg(id: string, from: string, to: string, fleetId: string, over: Partial<Message> = {}): Message {
  return {
    id,
    from_agent_id: from,
    to_agent_id: to,
    fleet_id: fleetId,
    type: "handoff",
    payload: "x",
    timestamp: 1_000,
    acknowledged: false,
    ...over,
  };
}

function receiptRow(messageId: string, agentId: string, action: string, timestamp = 2_000): Receipt {
  return { message_id: messageId, agent_id: agentId, action, timestamp };
}

/** A minimal internally-consistent ledger: f1 with a1→a2 message, unacked. */
function consistent(): MeshData {
  return mesh({
    fleets: { f1: { id: "f1", status: "running", created_at: 500 } },
    agents: { a1: agent("a1", "f1"), a2: agent("a2", "f1") },
    messages: { m1: msg("m1", "a1", "a2", "f1") },
    inboxes: { a1: [], a2: ["m1"] },
  });
}

function found(report: VerifyReport, check: string) {
  return report.findings.filter((f) => f.check === check);
}

// ---------------------------------------------------------------------------
// The happy path: a ledger built purely through the real API verifies clean.
// ---------------------------------------------------------------------------

test("a ledger built through the real API verifies clean", () => {
  const l = withTempDb();
  try {
    createFleet("f1");
    registerAgentInLedger(agent("a1", "f1"));
    registerAgentInLedger(agent("a2", "f1"));
    registerAgentInLedger(agent("a3", "f1"));

    const { messageId } = sendMessage("a1", "a2", "f1", "handoff", "do the thing");
    assert.equal(ackMessage("a2", messageId), true);

    const proposalId = openRatification({
      proposer: "a1",
      fleetId: "f1",
      subject: "adopt the plan",
      quorum: 1,
    });
    assert.equal(castVote("a2", proposalId, true), true);
    assert.equal(resolveRatification(proposalId), "ratified");

    const report = verifyLedger();
    assert.equal(report.ok, true);
    assert.deepEqual(report.findings, []);
    assert.equal(report.errors, 0);
    assert.equal(report.warnings, 0);
  } finally {
    l.cleanup();
  }
});

test("report carries entity counts", () => {
  const report = verifyMeshData(consistent());
  assert.equal(report.counts.fleets, 1);
  assert.equal(report.counts.agents, 2);
  assert.equal(report.counts.messages, 1);
  assert.equal(report.counts.receipts, 0);
  assert.equal(report.counts.ratifications, 0);
});

// ---------------------------------------------------------------------------
// Receipt integrity
// ---------------------------------------------------------------------------

test("receipt whose key disagrees with its fields is an error (idempotency key is the guarantee)", () => {
  const data = consistent();
  data.receipts = { "m1:a2:seen": receiptRow("m1", "a2", "ack") }; // key says seen, row says ack
  const report = verifyMeshData(data);
  assert.equal(report.ok, false);
  assert.equal(found(report, "receipt.key_mismatch").length, 1);
  assert.equal(found(report, "receipt.key_mismatch")[0].severity, "error");
});

test("receipt pointing at a missing message is an error", () => {
  const data = consistent();
  data.receipts = { "ghost:a2:seen": receiptRow("ghost", "a2", "seen") };
  const report = verifyMeshData(data);
  assert.equal(report.ok, false);
  assert.equal(found(report, "receipt.orphan_message").length, 1);
});

test("receipt from an agent the ledger has never registered is a warning, and warnings alone keep ok=true", () => {
  const data = consistent();
  data.receipts = { "m1:stranger:seen": receiptRow("m1", "stranger", "seen") };
  const report = verifyMeshData(data);
  assert.equal(found(report, "receipt.unknown_agent").length, 1);
  assert.equal(found(report, "receipt.unknown_agent")[0].severity, "warning");
  assert.equal(report.ok, true);
  assert.equal(report.warnings, 1);
});

test("receipt timestamped before its message is an error", () => {
  const data = consistent();
  data.receipts = { "m1:a2:seen": receiptRow("m1", "a2", "seen", 999) }; // message is at 1000
  const report = verifyMeshData(data);
  assert.equal(found(report, "receipt.before_message").length, 1);
  assert.equal(found(report, "receipt.before_message")[0].severity, "error");
});

// ---------------------------------------------------------------------------
// The derived acknowledged flag + inbox consumption
// ---------------------------------------------------------------------------

test("message claiming acknowledged without the acks to prove it is an error", () => {
  const data = consistent();
  data.messages.m1 = msg("m1", "a1", "a2", "f1", { acknowledged: true }); // no ack receipt exists
  const report = verifyMeshData(data);
  assert.equal(found(report, "message.ack_flag_mismatch").length, 1);
  assert.equal(found(report, "message.ack_flag_mismatch")[0].severity, "error");
});

test("message with full acks but acknowledged=false is only a warning (understates, never overclaims)", () => {
  const data = consistent();
  data.receipts = { "m1:a2:ack": receiptRow("m1", "a2", "ack") };
  data.inboxes.a2 = []; // consumed
  // acknowledged left false by the fixture
  const report = verifyMeshData(data);
  const findings = found(report, "message.ack_flag_mismatch");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "warning");
});

test("inbox entry pointing at a missing message is an error", () => {
  const data = consistent();
  data.inboxes.a2 = ["m1", "ghost"];
  const report = verifyMeshData(data);
  assert.equal(found(report, "inbox.dangling_message").length, 1);
});

test("acked message still sitting in the acker's inbox is an error (ack consumes)", () => {
  const data = consistent();
  data.receipts = { "m1:a2:ack": receiptRow("m1", "a2", "ack") };
  data.messages.m1.acknowledged = true;
  // inbox still holds m1 — the fixture "forgot" to consume
  const report = verifyMeshData(data);
  assert.equal(found(report, "inbox.acked_still_queued").length, 1);
  assert.equal(found(report, "inbox.acked_still_queued")[0].severity, "error");
});

// ---------------------------------------------------------------------------
// Ratifications: quorum + vote polarity
// ---------------------------------------------------------------------------

function withRatification(over: Partial<Ratification> = {}): MeshData {
  const data = mesh({
    fleets: { f1: { id: "f1", status: "running", created_at: 500 } },
    agents: { a1: agent("a1", "f1"), a2: agent("a2", "f1"), a3: agent("a3", "f1") },
    messages: { p1: msg("p1", "a1", "*", "f1", { recipients: ["a2", "a3"] }) },
    inboxes: { a1: [], a2: ["p1"], a3: ["p1"] },
  });
  data.ratifications = {
    p1: {
      message_id: "p1",
      proposer: "a1",
      fleet_id: "f1",
      subject: "s",
      quorum: 1,
      voters: ["a2", "a3"],
      required_signoffs: [],
      opened_at: 1_000,
      silence_policy: "abstain",
      status: "open",
      ...over,
    },
  };
  return data;
}

test("ratification whose proposal message is missing is an error", () => {
  const data = withRatification();
  delete data.messages.p1;
  data.inboxes.a2 = [];
  data.inboxes.a3 = [];
  const report = verifyMeshData(data);
  assert.equal(found(report, "ratification.orphan_proposal").length, 1);
});

test("an agent holding both an approve and a decline receipt on one proposal is an error", () => {
  const data = withRatification();
  data.receipts = {
    "p1:a2:r-ack": receiptRow("p1", "a2", "r-ack"),
    "p1:a2:r-decline": receiptRow("p1", "a2", "r-decline"),
  };
  const report = verifyMeshData(data);
  assert.equal(found(report, "ratification.conflicting_vote").length, 1);
  assert.equal(found(report, "ratification.conflicting_vote")[0].severity, "error");
});

test("quorum larger than the voter set is an error", () => {
  const data = withRatification({ quorum: 5 });
  const report = verifyMeshData(data);
  assert.equal(found(report, "ratification.quorum_exceeds_voters").length, 1);
});

test("required signoff outside the voter set is an error", () => {
  const data = withRatification({ required_signoffs: ["outsider"] });
  const report = verifyMeshData(data);
  assert.equal(found(report, "ratification.signoff_not_voter").length, 1);
});

test("vote receipt from a non-voter is a warning (the tally ignores it, but it should be seen)", () => {
  const data = withRatification();
  data.receipts = { "p1:a1:r-ack": receiptRow("p1", "a1", "r-ack") }; // proposer is not a voter
  const report = verifyMeshData(data);
  assert.equal(found(report, "ratification.vote_from_non_voter").length, 1);
  assert.equal(found(report, "ratification.vote_from_non_voter")[0].severity, "warning");
});

test("terminal status that does not recompute from the receipts is a warning", () => {
  const data = withRatification({ status: "ratified", resolved_at: 3_000 });
  // no vote receipts at all — nothing supports "ratified"
  const report = verifyMeshData(data);
  const findings = found(report, "ratification.status_mismatch");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "warning");
});

test("terminal status fully supported by the receipts recomputes clean", () => {
  const data = withRatification({ status: "ratified", resolved_at: 3_000 });
  data.receipts = { "p1:a2:r-ack": receiptRow("p1", "a2", "r-ack") }; // quorum 1 met
  const report = verifyMeshData(data);
  assert.equal(found(report, "ratification.status_mismatch").length, 0);
});

// ---------------------------------------------------------------------------
// Reference hygiene: agents, capabilities
// ---------------------------------------------------------------------------

test("agent pointing at a fleet the ledger does not hold is a warning", () => {
  const data = consistent();
  data.agents.a9 = agent("a9", "ghost-fleet");
  const report = verifyMeshData(data);
  assert.equal(found(report, "agent.orphan_fleet").length, 1);
  assert.equal(found(report, "agent.orphan_fleet")[0].severity, "warning");
});

test("capability registered for an unknown agent is a warning", () => {
  const data = consistent();
  data.capabilities = {
    ghost: { agent_id: "ghost", fleet_id: "f1", role: "worker", skills: ["x"], registered_at: 1_000 },
  };
  const report = verifyMeshData(data);
  assert.equal(found(report, "capability.unknown_agent").length, 1);
});

// ---------------------------------------------------------------------------
// verifyLedger reads the live ledger
// ---------------------------------------------------------------------------

test("verify_ledger is advertised as an MCP tool", () => {
  // index.ts boots transports on import (see dispatch-registry.test.ts), so
  // assert against the source like the registry parity test does.
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8");
  assert.match(source, /name: "verify_ledger"/);
  assert.match(source, /toolHandlers\["verify_ledger"\]\s*=/);
});

test("verifyLedger reads the active ledger and surfaces seeded corruption", () => {
  const corrupt = consistent();
  corrupt.receipts = { "ghost:a2:seen": receiptRow("ghost", "a2", "seen") };
  const l = withTempDb(corrupt);
  try {
    const report = verifyLedger();
    assert.equal(report.ok, false);
    assert.equal(found(report, "receipt.orphan_message").length, 1);
  } finally {
    l.cleanup();
  }
});
