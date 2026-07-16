import { test } from "node:test";
import assert from "node:assert/strict";

import { getReceipts, registerAgentInLedger, type Agent, type MeshData } from "../src/core.js";
import { withTempDb } from "./helpers/with-temp-db.js";
import { castVote, computeTally, openRatification, resolveRatification, tallyRatification } from "../src/ratify.js";
import { verifyMeshData } from "../src/verify.js";

// Re-re-cast semantics: an agent may change their vote ANY number of times
// while a ratification is open, and the LATEST cast is always the effective
// one — including casting back to a polarity they already held once (the
// A→B→A case the idempotent receipt model silently swallowed; ROADMAP
// "Known limitations", closed by this change). Receipt history stays
// append-only: every cast is a new receipt, nothing is mutated or deleted.

function agent(id: string): Agent {
  return { id, fleet_id: "f1", role: "peer", prompt: "p", status: "running" };
}

function council(): string {
  registerAgentInLedger(agent("proposer"));
  for (const v of ["a", "b", "c"]) registerAgentInLedger(agent(v));
  return openRatification({
    proposer: "proposer",
    fleetId: "f1",
    subject: "s",
    quorum: 2,
    voters: ["a", "b", "c"],
  });
}

test("A→B→A: casting back to the original polarity takes effect", () => {
  const l = withTempDb();
  try {
    const mid = council();
    castVote("a", mid, true);
    castVote("a", mid, false);
    castVote("a", mid, true); // back to approve — must WIN
    castVote("b", mid, true);
    const t = tallyRatification(mid)!;
    assert.deepEqual(t.approvals.sort(), ["a", "b"], JSON.stringify(t));
    assert.deepEqual(t.declines, []);
    assert.equal(t.status, "ratified");
  } finally {
    l.cleanup();
  }
});

test("A→B→A→B: four casts, the last one wins", () => {
  const l = withTempDb();
  try {
    const mid = council();
    castVote("a", mid, true);
    castVote("a", mid, false);
    castVote("a", mid, true);
    castVote("a", mid, false); // final: decline
    const t = tallyRatification(mid)!;
    assert.deepEqual(t.approvals, []);
    assert.deepEqual(t.declines, ["a"]);
  } finally {
    l.cleanup();
  }
});

test("repeating the SAME vote is idempotent — one effective vote, no double-count", () => {
  const l = withTempDb();
  try {
    const mid = council();
    castVote("a", mid, true);
    castVote("a", mid, true);
    castVote("a", mid, true);
    const t = tallyRatification(mid)!;
    assert.deepEqual(t.approvals, ["a"]);
    assert.equal(t.approval_weight, 1);
    assert.equal(t.status, "open", "one approval must not satisfy quorum 2");
  } finally {
    l.cleanup();
  }
});

test("re-re-cast moves FULL weight on a weighted council", () => {
  const l = withTempDb();
  try {
    registerAgentInLedger(agent("proposer"));
    for (const v of ["a", "b"]) registerAgentInLedger(agent(v));
    const mid = openRatification({
      proposer: "proposer",
      fleetId: "f1",
      subject: "s",
      quorum: 3,
      voters: ["a", "b"],
      weights: { a: 3 },
    });
    castVote("a", mid, true);
    castVote("a", mid, false);
    castVote("a", mid, true); // full weight 3 back on approve
    const t = tallyRatification(mid)!;
    assert.equal(t.approval_weight, 3);
    assert.equal(t.decline_weight, 0);
    assert.equal(t.status, "ratified");
  } finally {
    l.cleanup();
  }
});

test("re-re-casts after a sticky resolution still cannot flip it", () => {
  const l = withTempDb();
  try {
    const mid = council();
    castVote("a", mid, false);
    castVote("b", mid, false);
    castVote("c", mid, false);
    assert.equal(resolveRatification(mid), "rejected");
    castVote("a", mid, true);
    castVote("a", mid, false);
    castVote("a", mid, true);
    assert.equal(tallyRatification(mid)!.status, "rejected", "terminal status is immutable");
  } finally {
    l.cleanup();
  }
});

// --- Wire format + determinism (the grk-adopted seq-suffix spec) -------------

test("A→B→A leaves exactly three append-only receipts: r-ack, r-decline:1, r-ack:2", () => {
  const l = withTempDb();
  try {
    const mid = council();
    castVote("a", mid, true);
    castVote("a", mid, false);
    castVote("a", mid, true);
    const actions = getReceipts(mid)
      .filter((r) => r.agent_id === "a")
      .map((r) => r.action)
      .sort();
    assert.deepEqual(actions, ["r-ack", "r-ack:2", "r-decline:1"]);
  } finally {
    l.cleanup();
  }
});

test("same-polarity re-cast writes NO new receipt (retry storms don't spam the ledger)", () => {
  const l = withTempDb();
  try {
    const mid = council();
    castVote("a", mid, true);
    castVote("a", mid, true);
    castVote("a", mid, true);
    assert.equal(getReceipts(mid).filter((r) => r.agent_id === "a").length, 1);
  } finally {
    l.cleanup();
  }
});

test("a required signoff's re-re-cast is honored: decline, then approve ratifies", () => {
  const l = withTempDb();
  try {
    registerAgentInLedger(agent("proposer"));
    for (const v of ["a", "boss"]) registerAgentInLedger(agent(v));
    const mid = openRatification({
      proposer: "proposer",
      fleetId: "f1",
      subject: "s",
      quorum: 1,
      voters: ["a", "boss"],
      requiredSignoffs: ["boss"],
    });
    castVote("a", mid, true);
    castVote("boss", mid, false);
    castVote("boss", mid, true); // signoff reverses — must count
    assert.equal(tallyRatification(mid)!.status, "ratified");
  } finally {
    l.cleanup();
  }
});

test("effective vote is derived from CONTENT (seq), never from receipt-dict order", () => {
  // Seed the higher-seq approve BEFORE the decline in dict order — the tally
  // must still pick the approve.
  const data: MeshData = {
    fleets: { f1: { id: "f1", status: "running", created_at: 500 } },
    agents: {
      p: { id: "p", fleet_id: "f1", role: "r", prompt: "x", status: "running" },
      a: { id: "a", fleet_id: "f1", role: "r", prompt: "x", status: "running" },
      b: { id: "b", fleet_id: "f1", role: "r", prompt: "x", status: "running" },
    },
    messages: {
      p1: { id: "p1", from_agent_id: "p", to_agent_id: "*", fleet_id: "f1", type: "question", payload: "q", timestamp: 1_000, acknowledged: false, recipients: ["a", "b"] },
    },
    inboxes: { p: [], a: ["p1"], b: ["p1"] },
    capabilities: {},
    receipts: {
      "p1:a:r-ack:2": { message_id: "p1", agent_id: "a", action: "r-ack:2", timestamp: 3_000 },
      "p1:a:r-decline:1": { message_id: "p1", agent_id: "a", action: "r-decline:1", timestamp: 2_500 },
      "p1:a:r-ack": { message_id: "p1", agent_id: "a", action: "r-ack", timestamp: 2_000 },
    },
    ratifications: {
      p1: { message_id: "p1", proposer: "p", fleet_id: "f1", subject: "s", quorum: 1, voters: ["a", "b"], required_signoffs: [], opened_at: 1_000, silence_policy: "abstain", status: "open" },
    },
    templates: {},
  };
  const tally = computeTally(data, data.ratifications!.p1!, 4_000);
  assert.deepEqual(tally.approvals, ["a"]);
  assert.deepEqual(tally.declines, []);
  assert.equal(tally.status, "ratified");
});

test("verify flags duplicate vote seqs, seq gaps, and malformed vote-like actions", () => {
  function seeded(receipts: Record<string, { message_id: string; agent_id: string; action: string; timestamp: number }>): MeshData {
    return {
      fleets: { f1: { id: "f1", status: "running", created_at: 500 } },
      agents: {
        p: { id: "p", fleet_id: "f1", role: "r", prompt: "x", status: "running" },
        a: { id: "a", fleet_id: "f1", role: "r", prompt: "x", status: "running" },
        b: { id: "b", fleet_id: "f1", role: "r", prompt: "x", status: "running" },
      },
      messages: {
        p1: { id: "p1", from_agent_id: "p", to_agent_id: "*", fleet_id: "f1", type: "question", payload: "q", timestamp: 1_000, acknowledged: false, recipients: ["a", "b"] },
      },
      inboxes: { p: [], a: ["p1"], b: ["p1"] },
      capabilities: {},
      receipts,
      ratifications: {
        p1: { message_id: "p1", proposer: "p", fleet_id: "f1", subject: "s", quorum: 1, voters: ["a", "b"], required_signoffs: [], opened_at: 1_000, silence_policy: "abstain", status: "open" },
      },
      templates: {},
    };
  }
  // duplicate seq 0: bare r-ack plus its ':0' alias
  const dup = verifyMeshData(seeded({
    "p1:a:r-ack": { message_id: "p1", agent_id: "a", action: "r-ack", timestamp: 2_000 },
    "p1:a:r-ack:0": { message_id: "p1", agent_id: "a", action: "r-ack:0", timestamp: 2_100 },
  }));
  assert.equal(dup.findings.filter((f) => f.check === "ratification.duplicate_vote_seq").length, 1);

  // gap: seq 0 and 2, no 1
  const gap = verifyMeshData(seeded({
    "p1:a:r-ack": { message_id: "p1", agent_id: "a", action: "r-ack", timestamp: 2_000 },
    "p1:a:r-decline:2": { message_id: "p1", agent_id: "a", action: "r-decline:2", timestamp: 2_500 },
  }));
  assert.equal(gap.findings.filter((f) => f.check === "ratification.vote_seq_gap").length, 1);

  // malformed vote-like action: leading zero
  const bad = verifyMeshData(seeded({
    "p1:a:r-ack:01": { message_id: "p1", agent_id: "a", action: "r-ack:01", timestamp: 2_000 },
  }));
  assert.equal(bad.findings.filter((f) => f.check === "ratification.malformed_vote_action").length, 1);

  // seq beyond Number safe-integer range: malformed (precision loss would
  // corrupt effective-vote ordering), and the tally ignores it
  const unsafe = verifyMeshData(seeded({
    "p1:a:r-ack:9007199254740993": { message_id: "p1", agent_id: "a", action: "r-ack:9007199254740993", timestamp: 2_000 },
  }));
  assert.equal(unsafe.findings.filter((f) => f.check === "ratification.malformed_vote_action").length, 1);

  // legacy dual bare votes at seq 0: allowed (re-cast warning only, no seq errors)
  const legacy = verifyMeshData(seeded({
    "p1:a:r-ack": { message_id: "p1", agent_id: "a", action: "r-ack", timestamp: 2_000 },
    "p1:a:r-decline": { message_id: "p1", agent_id: "a", action: "r-decline", timestamp: 2_500 },
  }));
  assert.equal(legacy.errors, 0, JSON.stringify(legacy.findings));
});
