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
import { runtimeModelsMatch } from "../src/spawn-result.js";
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

type AgentTimestampField = "started_at" | "completed_at";

function withAgentTimestamp(field: AgentTimestampField, value: unknown, present = true): MeshData {
  const data = consistent();
  const row: Agent = { ...agent("a1", "f1"), status: "complete" };
  if (present) (row as unknown as Record<string, unknown>)[field] = value;
  data.agents.a1 = row;
  return data;
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

test("missing, string, and NaN receipt timestamps are errors and cannot prove an ack", () => {
  for (const timestamp of [undefined, "2000", Number.NaN]) {
    const data = consistent();
    data.messages.m1 = msg("m1", "a1", "a2", "f1", { acknowledged: true });
    data.inboxes.a2 = [];
    data.receipts = {
      "m1:a2:ack": {
        message_id: "m1",
        agent_id: "a2",
        action: "ack",
        ...(timestamp === undefined ? {} : { timestamp }),
      } as unknown as Receipt,
    };
    const report = verifyMeshData(data);
    assert.equal(found(report, "receipt.invalid_timestamp").length, 1);
    assert.equal(found(report, "message.ack_flag_mismatch").length, 1);
  }
});

test("missing, string, and NaN message timestamps cannot prove an ack", () => {
  for (const timestamp of [undefined, "1000", Number.NaN]) {
    const data = consistent();
    data.messages.m1 = msg("m1", "a1", "a2", "f1", {
      timestamp: timestamp as unknown as number,
      acknowledged: true,
    });
    data.inboxes.a2 = [];
    data.receipts = { "m1:a2:ack": receiptRow("m1", "a2", "ack") };

    const report = verifyMeshData(data);
    assert.equal(found(report, "message.invalid_timestamp").length, 1);
    assert.equal(found(report, "message.ack_flag_mismatch").length, 1);
    assert.equal(found(report, "receipt.before_message").length, 0);
  }
});

test("a valid non-ack receipt cannot prove acknowledgement", () => {
  const data = consistent();
  data.messages.m1 = msg("m1", "a1", "a2", "f1", { acknowledged: true });
  data.inboxes.a2 = [];
  data.receipts = { "m1:a2:seen": receiptRow("m1", "a2", "seen") };
  const report = verifyMeshData(data);
  assert.equal(found(report, "message.ack_flag_mismatch").length, 1);
  assert.equal(found(report, "receipt.invalid_timestamp").length, 0);
});

test("an ack from an unknown recipient cannot prove acknowledgement", () => {
  const data = consistent();
  data.messages.m1 = msg("m1", "a1", "a2", "f1", { acknowledged: true });
  data.inboxes.a2 = [];
  data.receipts = { "m1:stranger:ack": receiptRow("m1", "stranger", "ack") };
  const report = verifyMeshData(data);
  assert.equal(found(report, "receipt.unknown_agent").length, 1);
  assert.equal(found(report, "message.ack_flag_mismatch").length, 1);
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

test("an agent holding both polarities on one proposal is a re-cast WARNING, not an error (pinned recovery semantics)", () => {
  const data = withRatification();
  data.receipts = {
    "p1:a2:r-decline": receiptRow("p1", "a2", "r-decline", 2_000),
    "p1:a2:r-ack": receiptRow("p1", "a2", "r-ack", 2_500),
  };
  const report = verifyMeshData(data);
  assert.equal(found(report, "ratification.vote_recast").length, 1);
  assert.equal(found(report, "ratification.vote_recast")[0].severity, "warning");
  assert.equal(report.ok, true);
});

test("polarity recovery through the real API verifies with zero errors", () => {
  // The production-incident recovery scenario ratify.test.ts pins: everyone declines
  // (inverted relay), then re-casts approve while open. Both receipt rows per
  // agent legitimately exist; verification must not call that corruption.
  const l = withTempDb();
  try {
    createFleet("f1");
    for (const id of ["proposer", "v1", "v2", "v3"]) registerAgentInLedger(agent(id, "f1"));
    const mid = openRatification({ proposer: "proposer", fleetId: "f1", subject: "revise", quorum: 2 });
    for (const v of ["v1", "v2", "v3"]) castVote(v, mid, false);
    for (const v of ["v1", "v2", "v3"]) castVote(v, mid, true);
    assert.equal(resolveRatification(mid), "ratified");
    const report = verifyLedger();
    assert.equal(report.errors, 0, JSON.stringify(report.findings));
    assert.equal(report.ok, true);
    assert.equal(found(report, "ratification.vote_recast").length, 3);
  } finally {
    l.cleanup();
  }
});

test("late votes after a sticky resolution do not trigger a status warning", () => {
  // ratify.test.ts pins that a resolved ratification is immutable and re-votes
  // after resolution are legitimate ledger content. The recompute must only
  // consider receipts that existed at resolved_at.
  const data = withRatification({ status: "rejected", quorum: 2, resolved_at: 3_000 });
  data.receipts = {
    "p1:a2:r-decline": receiptRow("p1", "a2", "r-decline", 2_000),
    "p1:a3:r-decline": receiptRow("p1", "a3", "r-decline", 2_100),
    // corrected votes arrive AFTER resolution — sticky status holds
    "p1:a2:r-ack": receiptRow("p1", "a2", "r-ack", 4_000),
    "p1:a3:r-ack": receiptRow("p1", "a3", "r-ack", 4_100),
  };
  const report = verifyMeshData(data);
  assert.equal(found(report, "ratification.status_mismatch").length, 0, JSON.stringify(report.findings));
});

test("duplicate voters in the voter set are an error (they double-count toward quorum)", () => {
  const data = withRatification({ voters: ["a2", "a2", "a3"], quorum: 2 });
  const report = verifyMeshData(data);
  assert.equal(found(report, "ratification.duplicate_voters").length, 1);
  assert.equal(found(report, "ratification.duplicate_voters")[0].severity, "error");
});

test("the legacy '*' backfill receipt from v1 migration is not flagged as an unknown agent", () => {
  const data = consistent();
  data.messages.m1 = msg("m1", "a1", "*", "f1", { acknowledged: true, recipients: undefined });
  data.inboxes.a2 = [];
  data.receipts = {
    "m1:*:ack": { message_id: "m1", agent_id: "*", action: "ack", timestamp: 1_000, note: "backfilled_from_v1_acknowledged_flag" },
  };
  const report = verifyMeshData(data);
  assert.deepEqual(report.findings, []);
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

for (const field of ["started_at", "completed_at"] as const) {
  test(`absent agent ${field} remains supported`, () => {
    const report = verifyMeshData(withAgentTimestamp(field, undefined, false));
    assert.equal(found(report, "agent.invalid_timestamp").length, 0);
  });

  test(`explicit undefined agent ${field} is treated as absent`, () => {
    const report = verifyMeshData(withAgentTimestamp(field, undefined));
    assert.equal(found(report, "agent.invalid_timestamp").length, 0);
  });

  for (const [label, value] of [["zero", 0], ["finite", 501]] as const) {
    test(`${label} numeric agent ${field} remains a valid ordering operand`, () => {
      const report = verifyMeshData(withAgentTimestamp(field, value));
      assert.equal(found(report, "agent.invalid_timestamp").length, 0);
    });
  }

  for (const [label, value] of [
    ["null", null],
    ["numeric string", "499"],
    ["nonnumeric string", "bad"],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ] as const) {
    test(`${label} agent ${field} is invalid and cannot participate in ordering`, () => {
      const report = verifyMeshData(withAgentTimestamp(field, value));
      const invalid = found(report, "agent.invalid_timestamp");
      assert.equal(report.ok, false);
      assert.equal(invalid.length, 1);
      assert.equal(invalid[0].severity, "error");
      assert.equal(invalid[0].subject, "a1");
      assert.equal(invalid[0].detail, `agent a1 has a present but non-finite ${field} timestamp`);
      assert.equal(found(report, "agent.tampered_timestamp").length, 0);
    });
  }
}

test("two invalid agent timestamps produce ordered field-specific findings", () => {
  const data = withAgentTimestamp("started_at", null);
  (data.agents.a1 as unknown as Record<string, unknown>).completed_at = "bad";

  const report = verifyMeshData(data);
  const invalid = found(report, "agent.invalid_timestamp");
  assert.deepEqual(
    invalid.map(({ severity, check, subject, detail }) => ({ severity, check, subject, detail })),
    [
      {
        severity: "error",
        check: "agent.invalid_timestamp",
        subject: "a1",
        detail: "agent a1 has a present but non-finite started_at timestamp",
      },
      {
        severity: "error",
        check: "agent.invalid_timestamp",
        subject: "a1",
        detail: "agent a1 has a present but non-finite completed_at timestamp",
      },
    ],
  );
  assert.equal(found(report, "agent.tampered_timestamp").length, 0);
});

// ---------------------------------------------------------------------------
// fleet.created_at — the anchor every lifecycle comparison above is made
// AGAINST. Its three read sites compare with `<`, and `<` against a non-finite
// right-hand side is false, so degrading this one field made three tamper
// errors silently not fire while the fleet drew no finding of its own. Each
// assertion class below is pinned by a different mutation, because disabling
// the check alone leaves the negative tests passing.
// ---------------------------------------------------------------------------

function withFleetCreatedAt(value: unknown, present = true): MeshData {
  const data = consistent();
  const row: Record<string, unknown> = { id: "f1", status: "running" };
  if (present) row.created_at = value;
  data.fleets.f1 = row as unknown as MeshData["fleets"][string];
  return data;
}

for (const [label, value] of [["zero", 0], ["finite", 500]] as const) {
  test(`${label} fleet created_at is a valid ordering anchor`, () => {
    const report = verifyMeshData(withFleetCreatedAt(value));
    // The positive contract, not just the absence of this one check: a valid
    // anchor must leave the whole ledger clean. Asserting only that
    // `fleet.invalid_timestamp` is absent would still pass if the new check
    // raised something else instead.
    assert.equal(found(report, "fleet.invalid_timestamp").length, 0);
    assert.deepEqual(report.findings, []);
    assert.equal(report.ok, true);
  });
}

for (const [label, value] of [
  ["null", null],
  ["numeric string", "500"],
  ["nonnumeric string", "bad"],
  ["NaN", Number.NaN],
  ["positive infinity", Number.POSITIVE_INFINITY],
  ["negative infinity", Number.NEGATIVE_INFINITY],
] as const) {
  test(`${label} fleet created_at cannot anchor an ordering and is an error`, () => {
    const report = verifyMeshData(withFleetCreatedAt(value));
    const invalid = found(report, "fleet.invalid_timestamp");
    assert.equal(report.ok, false);
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0].severity, "error");
    assert.equal(invalid[0].subject, "f1");
    // Pin the operator-facing sentence too. Without this the detail string can
    // be corrupted — or quietly re-broadened past what the check actually
    // proves — while every other assertion here stays green.
    assert.equal(
      invalid[0].detail,
      "fleet f1 has a missing or non-finite created_at — the lifecycle comparisons for THIS fleet's own agents and messages are made against it, and each of those silently passes while it cannot be ordered",
    );
  });
}

test("an absent fleet created_at is an error, unlike the optional agent fields", () => {
  const report = verifyMeshData(withFleetCreatedAt(undefined, false));
  const invalid = found(report, "fleet.invalid_timestamp");
  assert.equal(report.ok, false);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].subject, "f1");
});

test("an EMPTY fleet with an unreadable created_at is still reported", () => {
  // The fleet block `continue`s past agent-less fleets, deliberately, because
  // the lattice checks below it are vacuous for them. A row's own timestamp is
  // a different fact — and an agent-less fleet is exactly the shape a partial
  // export produces, so this must be checked before that skip.
  const data = withFleetCreatedAt(null);
  data.agents = {};
  data.messages = {};
  data.inboxes = {};

  const report = verifyMeshData(data);
  assert.equal(found(report, "fleet.invalid_timestamp").length, 1);
  assert.equal(report.ok, false);
});

test("one unreadable fleet timestamp yields one finding, not one per agent", () => {
  const data = withFleetCreatedAt(null);
  data.agents.a3 = agent("a3", "f1");
  data.agents.a4 = agent("a4", "f1");

  assert.equal(found(verifyMeshData(data), "fleet.invalid_timestamp").length, 1);
});

test("degrading the fleet anchor no longer leaves the audit silent", () => {
  // The falsifier this check exists for. On the same lying ledger — agents and
  // a message dated before their fleet — `created_at: null` erased all three
  // tamper errors and `verify` reported ok: true. The tamper findings are still
  // suppressed by the `<` comparisons (a separate, deliberate slice); what must
  // never happen again is the ledger reading CLEAN while it contradicts itself.
  const data = withFleetCreatedAt(10_000);
  data.agents.a1 = { ...agent("a1", "f1"), status: "complete", started_at: 1, completed_at: 2 };
  data.messages.m1 = msg("m1", "a1", "a2", "f1", { timestamp: 1 });

  const honest = verifyMeshData(data);
  assert.equal(honest.ok, false);
  assert.equal(found(honest, "agent.tampered_timestamp").length, 2);
  assert.equal(found(honest, "message.tampered_timestamp").length, 1);

  (data.fleets.f1 as unknown as Record<string, unknown>).created_at = null;
  const degraded = verifyMeshData(data);
  assert.equal(degraded.ok, false, "a self-contradicting ledger must not verify clean");
  assert.equal(found(degraded, "fleet.invalid_timestamp").length, 1);
});

test("invalid orphan-agent timestamp is reported before the orphan warning", () => {
  const data = consistent();
  data.agents.a9 = { ...agent("a9", "ghost-fleet"), status: "complete", completed_at: null as unknown as number };

  const report = verifyMeshData(data);
  assert.deepEqual(
    report.findings
      .filter((finding) => finding.subject === "a9")
      .map(({ severity, check, subject }) => ({ severity, check, subject })),
    [
      { severity: "error", check: "agent.invalid_timestamp", subject: "a9" },
      { severity: "warning", check: "agent.orphan_fleet", subject: "a9" },
    ],
  );
  assert.equal(found(report, "agent.tampered_timestamp").length, 0);
});

test("an invalid completion marker does not suppress completed-while-live", () => {
  const data = withAgentTimestamp("completed_at", null);
  data.agents.a1.status = "running";

  const report = verifyMeshData(data);
  assert.deepEqual(
    report.findings
      .filter((finding) => finding.subject === "a1")
      .map((finding) => finding.check),
    ["agent.invalid_timestamp", "agent.completed_while_live"],
  );
  assert.equal(found(report, "agent.tampered_timestamp").length, 0);
});

test("agent completion before its fleet was created is an error even without a start time", () => {
  const data = consistent();
  data.agents.a1 = { ...agent("a1", "f1"), status: "complete", completed_at: 499 };

  const report = verifyMeshData(data);
  const timestamps = found(report, "agent.tampered_timestamp");
  assert.equal(report.ok, false);
  assert.equal(timestamps.length, 1);
  assert.equal(timestamps[0].severity, "error");
  assert.equal(timestamps[0].detail, "agent completed before fleet was created");
});

test("agent completion at or after fleet creation is clean for the fleet timestamp relation", () => {
  for (const completed_at of [500, 501]) {
    const data = consistent();
    data.agents.a1 = { ...agent("a1", "f1"), status: "complete", completed_at };
    assert.equal(found(verifyMeshData(data), "agent.tampered_timestamp").length, 0, `completed_at=${completed_at}`);
  }
});

test("orphan agent completion does not receive a fleet timestamp error", () => {
  const data = consistent();
  data.agents.a9 = { ...agent("a9", "ghost-fleet"), status: "complete", completed_at: 1 };

  const report = verifyMeshData(data);
  assert.equal(found(report, "agent.tampered_timestamp").length, 0);
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
// capability.fleet_mismatch — the capability was the one record carrying a
// fleet_id that no reader ever dereferenced. Both fleets held, both rows held,
// and they disagree about where the agent worked.
// ---------------------------------------------------------------------------

/** consistent(), plus a second HELD fleet the mismatch can point at. */
function twoFleets(): MeshData {
  const data = consistent();
  data.fleets.f2 = { id: "f2", status: "running", created_at: 500 };
  return data;
}

test("a capability naming a held fleet its agent's own row contradicts is a warning", () => {
  const data = twoFleets();
  data.capabilities = {
    a2: { agent_id: "a2", fleet_id: "f2", role: "worker", skills: ["x"], registered_at: 1_000 },
  };
  const report = verifyMeshData(data);
  const hits = found(report, "capability.fleet_mismatch");
  assert.equal(hits.length, 1, "a2 is recorded in f1 by its agent row and in f2 by its capability");
  assert.equal(hits[0].severity, "warning");
  assert.equal(hits[0].subject, "a2");
  // The row is the defect; the agent is fine. Nothing here is an unknown agent.
  assert.equal(found(report, "capability.unknown_agent").length, 0);
});

test("a capability agreeing with its agent's fleet is silent", () => {
  const data = twoFleets();
  data.capabilities = {
    a2: { agent_id: "a2", fleet_id: "f1", role: "worker", skills: ["x"], registered_at: 1_000 },
  };
  assert.equal(found(verifyMeshData(data), "capability.fleet_mismatch").length, 0);
});

test("a capability naming a fleet this ledger does not hold is NOT a fleet mismatch", () => {
  // The cross-attachment exemption, and it is the whole reason the check is
  // gated rather than symmetric: a foreign fleet advertising capabilities this
  // ledger cannot resolve is the benign case `capability.unknown_agent`'s own
  // --explain text already names. Without this gate the check would fire on
  // honest federation traffic — the same shape that killed the sender-existence
  // check on 62% of the operator's real messages.
  const data = consistent();
  data.capabilities = {
    a2: { agent_id: "a2", fleet_id: "f-ghost", role: "worker", skills: ["x"], registered_at: 1_000 },
  };
  assert.equal(found(verifyMeshData(data), "capability.fleet_mismatch").length, 0);
});

test("an unknown agent's capability reports the unknown agent, never a fleet mismatch", () => {
  // Mutual exclusivity, asserted rather than assumed: the two checks share an
  // if/else and a reader should not have to derive that from the source.
  const data = twoFleets();
  data.capabilities = {
    ghost: { agent_id: "ghost", fleet_id: "f2", role: "worker", skills: ["x"], registered_at: 1_000 },
  };
  const report = verifyMeshData(data);
  assert.equal(found(report, "capability.unknown_agent").length, 1);
  assert.equal(found(report, "capability.fleet_mismatch").length, 0);
});

test("capability.fleet_mismatch leaves ok true — it is a warning, and ok gates on errors", () => {
  // Stated because Q3's original falsifier ("show ok:true while the invariant is
  // violated") does NOT discriminate for a warning-severity check: ok is true
  // before AND after this fix. The finding SET is the discriminator, not ok.
  const data = twoFleets();
  data.capabilities = {
    a2: { agent_id: "a2", fleet_id: "f2", role: "worker", skills: ["x"], registered_at: 1_000 },
  };
  const report = verifyMeshData(data);
  assert.equal(report.ok, true);
  assert.equal(found(report, "capability.fleet_mismatch").length, 1);
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

// ---------------------------------------------------------------------------
// Model-selected execution — task 3
// Narrow consistency checks for complete agents that carry a persisted
// `requested_model`: they MUST also carry a parseable observed
// `runtime_model` banner, and that banner MUST match under
// runtimeModelsMatch() (the same rule the classifier uses). Failed and
// interrupted agents may legitimately lack observation. A successful match
// does not upgrade evidence — `runtime_model` is still `observed` at best,
// never `attested`.
// ---------------------------------------------------------------------------

test("Task 3 V1 — a complete agent with requested_model but no runtime_model is an error", () => {
  const data = consistent();
  data.agents.a1 = { ...data.agents.a1, status: "complete", completed_at: 1_000, requested_model: "opencode-go/minimax-m3" };
  const report = verifyMeshData(data);
  assert.equal(
    found(report, "agent.requested_model_unobserved").length,
    1,
    JSON.stringify(report.findings)
  );
  assert.equal(found(report, "agent.requested_model_unobserved")[0]!.severity, "error");
});

test("Task 3 V2 — a complete agent whose requested_model and runtime_model do not match is an error", () => {
  const data = consistent();
  data.agents.a1 = {
    ...data.agents.a1,
    status: "complete",
    completed_at: 1_000,
    requested_model: "opencode-go/minimax-m3",
    runtime_model: "openai/gpt-5",
  };
  const report = verifyMeshData(data);
  assert.equal(found(report, "agent.requested_model_mismatch").length, 1, JSON.stringify(report.findings));
  assert.equal(found(report, "agent.requested_model_mismatch")[0]!.severity, "error");
});

test("Task 3 V3 — a complete agent whose requested_model and runtime_model match cleanly is not flagged", () => {
  assert.equal(runtimeModelsMatch("opencode-go/minimax-m3", "opencode-go/minimax-m3"), true);
  const data = consistent();
  data.agents.a1 = {
    ...data.agents.a1,
    status: "complete",
    completed_at: 1_000,
    requested_model: "opencode-go/minimax-m3",
    runtime_model: "opencode-go/minimax-m3",
  };
  const report = verifyMeshData(data);
  assert.equal(found(report, "agent.requested_model_unobserved").length, 0);
  assert.equal(found(report, "agent.requested_model_mismatch").length, 0);
});

test("Task 3 V4 — failed and interrupted agents may lack runtime_model without flagging", () => {
  for (const status of ["failed", "interrupted"] as const) {
    const data = consistent();
    data.agents.a1 = {
      ...data.agents.a1,
      status,
      completed_at: 1_000,
      requested_model: "opencode-go/minimax-m3",
    };
    const report = verifyMeshData(data);
    assert.equal(
      found(report, "agent.requested_model_unobserved").length,
      0,
      `${status} agents may lack observation: ${JSON.stringify(report.findings)}`
    );
    assert.equal(found(report, "agent.requested_model_mismatch").length, 0);
  }
});

test("Task 3 V5 — an unselected agent (no requested_model) is not subject to the new checks", () => {
  const data = consistent();
  data.agents.a1 = { ...data.agents.a1, status: "complete", completed_at: 1_000 };
  const report = verifyMeshData(data);
  assert.equal(found(report, "agent.requested_model_unobserved").length, 0);
  assert.equal(found(report, "agent.requested_model_mismatch").length, 0);
});

test("Task 3 V6 — runtime_model is still `observed` evidence at best, never `attested` (no vocabulary promotion)", () => {
  const data = consistent();
  data.agents.a1 = {
    ...data.agents.a1,
    status: "complete",
    completed_at: 1_000,
    requested_model: "opencode-go/minimax-m3",
    runtime_model: "opencode-go/minimax-m3",
  };
  const report = verifyMeshData(data);
  const allChecks = new Set(report.findings.map((f) => f.check));
  assert.ok(
    !allChecks.has("agent.requested_model_attested") &&
      !allChecks.has("agent.evidence_promoted") &&
      !allChecks.has("agent.runtime_model_verified"),
    `a successful match must not promote evidence vocabulary: ${[...allChecks].filter((c) => c.includes("attest") || c.includes("promot") || c.includes("verif")).join(",")}`
  );
});
