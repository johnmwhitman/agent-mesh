import { test } from "node:test";
import assert from "node:assert/strict";

import { registerAgentInLedger, type Agent } from "../src/core.js";
import { withTempDb } from "./helpers/with-temp-db.js";
import { castVote, getRatification, openRatification, resolveRatification, tallyRatification } from "../src/ratify.js";
import { verifyMeshData } from "../src/verify.js";
import type { MeshData } from "../src/core.js";

// Weighted quorum voting ("tiered councils") — the last pre-cleared roadmap
// capability. Weights are per-voter positive integers assigned at open time;
// unlisted voters weigh 1, so an unweighted ratification is bit-identical to
// today's behavior. Required signoffs stay PER-AGENT — weight buys quorum
// power, never a mandatory approval.

function agent(id: string): Agent {
  return { id, fleet_id: "f1", role: "peer", prompt: "p", status: "running" };
}

function council(voters: string[]): void {
  registerAgentInLedger(agent("proposer"));
  for (const v of voters) registerAgentInLedger(agent(v));
}

test("a heavy voter can satisfy the quorum alone", () => {
  const l = withTempDb();
  try {
    council(["a", "b", "c"]);
    const mid = openRatification({
      proposer: "proposer",
      fleetId: "f1",
      subject: "s",
      quorum: 3,
      voters: ["a", "b", "c"],
      weights: { a: 3 },
    });
    castVote("a", mid, true);
    assert.equal(tallyRatification(mid)!.status, "ratified");
  } finally {
    l.cleanup();
  }
});

test("unlisted voters default to weight 1", () => {
  const l = withTempDb();
  try {
    council(["a", "b", "c"]);
    const mid = openRatification({
      proposer: "proposer",
      fleetId: "f1",
      subject: "s",
      quorum: 3,
      voters: ["a", "b", "c"],
      weights: { a: 2 },
    });
    castVote("a", mid, true);
    assert.equal(tallyRatification(mid)!.status, "open", "2 of 3 weight is not quorum");
    castVote("b", mid, true);
    assert.equal(tallyRatification(mid)!.status, "ratified");
  } finally {
    l.cleanup();
  }
});

test("tally exposes the weight arithmetic", () => {
  const l = withTempDb();
  try {
    council(["a", "b", "c"]);
    const mid = openRatification({
      proposer: "proposer",
      fleetId: "f1",
      subject: "s",
      quorum: 4,
      voters: ["a", "b", "c"],
      weights: { a: 3, b: 2 },
    });
    castVote("a", mid, true);
    castVote("b", mid, false);
    const t = tallyRatification(mid)!;
    assert.equal(t.approval_weight, 3);
    assert.equal(t.decline_weight, 2);
    assert.equal(t.pending_weight, 1); // c defaults to 1
    assert.equal(t.total_weight, 6);
  } finally {
    l.cleanup();
  }
});

test("quorum unreachable by remaining weight rejects", () => {
  const l = withTempDb();
  try {
    council(["a", "b"]);
    const mid = openRatification({
      proposer: "proposer",
      fleetId: "f1",
      subject: "s",
      quorum: 4,
      voters: ["a", "b"],
      weights: { a: 3 }, // total weight 4; b's decline caps max at 3
    });
    castVote("b", mid, false);
    assert.equal(resolveRatification(mid), "rejected");
  } finally {
    l.cleanup();
  }
});

test("silence_policy=approve counts pending WEIGHT after the deadline", () => {
  const l = withTempDb();
  try {
    council(["a", "b"]);
    const mid = openRatification({
      proposer: "proposer",
      fleetId: "f1",
      subject: "s",
      quorum: 4,
      voters: ["a", "b"],
      weights: { b: 3 },
      deadline: Date.now() + 60_000,
      silencePolicy: "approve",
    });
    castVote("a", mid, true); // weight 1; b (weight 3) stays silent
    assert.equal(tallyRatification(mid)!.status, "open");
    assert.equal(resolveRatification(mid, Date.now() + 120_000), "ratified");
  } finally {
    l.cleanup();
  }
});

test("weight never satisfies a required signoff — signoffs stay per-agent", () => {
  const l = withTempDb();
  try {
    council(["heavy", "authority"]);
    const mid = openRatification({
      proposer: "proposer",
      fleetId: "f1",
      subject: "s",
      quorum: 1,
      voters: ["heavy", "authority"],
      weights: { heavy: 10 },
      requiredSignoffs: ["authority"],
    });
    castVote("heavy", mid, true);
    assert.equal(tallyRatification(mid)!.status, "open", "quorum met by weight, but the signoff is missing");
    castVote("authority", mid, true);
    assert.equal(tallyRatification(mid)!.status, "ratified");
  } finally {
    l.cleanup();
  }
});

test("a re-cast vote moves the voter's FULL weight", () => {
  const l = withTempDb();
  try {
    council(["a", "b"]);
    const mid = openRatification({
      proposer: "proposer",
      fleetId: "f1",
      subject: "s",
      quorum: 3,
      voters: ["a", "b"],
      weights: { a: 3 },
    });
    castVote("a", mid, false);
    assert.equal(tallyRatification(mid)!.decline_weight, 3);
    castVote("a", mid, true);
    const t = tallyRatification(mid)!;
    assert.equal(t.approval_weight, 3);
    assert.equal(t.decline_weight, 0);
    assert.equal(t.status, "ratified");
  } finally {
    l.cleanup();
  }
});

test("open validates weights: non-voter key, non-positive, non-integer, unsafe, and quorum beyond total weight all throw", () => {
  const l = withTempDb();
  try {
    council(["a", "b"]);
    const base = { proposer: "proposer", fleetId: "f1", subject: "s", voters: ["a", "b"] };
    assert.throws(() => openRatification({ ...base, quorum: 1, weights: { ghost: 2 } }), /not among the voters/);
    assert.throws(() => openRatification({ ...base, quorum: 1, weights: { a: 0 } }), /positive integer/);
    assert.throws(() => openRatification({ ...base, quorum: 1, weights: { a: -2 } }), /positive integer/);
    assert.throws(() => openRatification({ ...base, quorum: 1, weights: { a: 1.5 } }), /positive integer/);
    assert.throws(() => openRatification({ ...base, quorum: 1, weights: { a: Number.MAX_SAFE_INTEGER } }), /weight too large/i);
    assert.throws(() => openRatification({ ...base, quorum: 4, weights: { a: 2 } }), /quorum 4 exceeds total voting weight 3/);
  } finally {
    l.cleanup();
  }
});

test("design-review deltas: NaN/Infinity weights, total-weight cap, non-integer quorum all throw; empty weights persists no field; tally echoes weights", () => {
  const l = withTempDb();
  try {
    council(["a", "b"]);
    const base = { proposer: "proposer", fleetId: "f1", subject: "s", voters: ["a", "b"] };
    assert.throws(() => openRatification({ ...base, quorum: 1, weights: { a: NaN } }), /positive integer/);
    assert.throws(() => openRatification({ ...base, quorum: 1, weights: { a: Infinity } }), /positive integer/);
    const eleven = Array.from({ length: 11 }, (_, i) => `w${i}`);
    for (const v of eleven) registerAgentInLedger(agent(v));
    assert.throws(
      () =>
        openRatification({
          ...base,
          voters: eleven,
          quorum: 1,
          weights: Object.fromEntries(eleven.map((v) => [v, 1_000_000])), // total 11M > 10M cap
        }),
      /total voting weight.*exceeds/i,
    );
    assert.throws(() => openRatification({ ...base, quorum: 1.5 }), /positive integer/);

    const bare = openRatification({ ...base, quorum: 1, weights: {} });
    assert.equal(getRatification(bare)!.weights, undefined, "empty weights map must not persist a field");

    const weighted = openRatification({ ...base, quorum: 2, weights: { a: 2 } });
    assert.deepEqual(tallyRatification(weighted)!.weights, { a: 2 }, "tally must echo the stored weights");
    assert.equal(tallyRatification(bare)!.weights, undefined);
  } finally {
    l.cleanup();
  }
});

test("an unweighted ratification is unchanged: quorum still counts heads", () => {
  const l = withTempDb();
  try {
    council(["a", "b", "c"]);
    const mid = openRatification({ proposer: "proposer", fleetId: "f1", subject: "s", quorum: 2, voters: ["a", "b", "c"] });
    castVote("a", mid, true);
    assert.equal(tallyRatification(mid)!.status, "open");
    castVote("b", mid, true);
    assert.equal(tallyRatification(mid)!.status, "ratified");
    assert.equal(getRatification(mid)!.weights, undefined, "no weights field persisted when none given");
  } finally {
    l.cleanup();
  }
});

// --- verify_ledger integration ----------------------------------------------

function seededRatification(weights: Record<string, number> | undefined, quorum: number): MeshData {
  return {
    fleets: { f1: { id: "f1", status: "running", created_at: 500 } },
    agents: {
      a1: { id: "a1", fleet_id: "f1", role: "r", prompt: "p", status: "running" },
      a2: { id: "a2", fleet_id: "f1", role: "r", prompt: "p", status: "running" },
      a3: { id: "a3", fleet_id: "f1", role: "r", prompt: "p", status: "running" },
    },
    messages: {
      p1: { id: "p1", from_agent_id: "a1", to_agent_id: "*", fleet_id: "f1", type: "question", payload: "q", timestamp: 1_000, acknowledged: false, recipients: ["a2", "a3"] },
    },
    inboxes: { a1: [], a2: ["p1"], a3: ["p1"] },
    capabilities: {},
    receipts: {},
    ratifications: {
      p1: {
        message_id: "p1",
        proposer: "a1",
        fleet_id: "f1",
        subject: "s",
        quorum,
        voters: ["a2", "a3"],
        required_signoffs: [],
        opened_at: 1_000,
        silence_policy: "abstain",
        status: "open",
        ...(weights ? { weights } : {}),
      },
    },
    templates: {},
  };
}

test("verify flags a weight assigned to a non-voter", () => {
  const report = verifyMeshData(seededRatification({ outsider: 5 }, 1));
  const f = report.findings.filter((x) => x.check === "ratification.weight_for_non_voter");
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "error");
});

test("verify flags an invalid weight value", () => {
  const report = verifyMeshData(seededRatification({ a2: 0 }, 1));
  assert.equal(report.findings.filter((x) => x.check === "ratification.invalid_weight").length, 1);
});

test("verify flags a weight beyond the per-voter cap", () => {
  const report = verifyMeshData(seededRatification({ a2: 2_000_000 }, 1));
  assert.equal(report.findings.filter((x) => x.check === "ratification.invalid_weight").length, 1);
});

test("verify's quorum-reachability check uses total WEIGHT when weights exist", () => {
  // quorum 5 with weights {a2: 3, a3: 1} (total 4) is unreachable → error;
  // the same quorum with weights {a2: 4} (total 5) is fine.
  const bad = verifyMeshData(seededRatification({ a2: 3 }, 5));
  assert.equal(bad.findings.filter((x) => x.check === "ratification.quorum_exceeds_voters").length, 1);
  const good = verifyMeshData(seededRatification({ a2: 4 }, 5));
  assert.equal(good.findings.filter((x) => x.check === "ratification.quorum_exceeds_voters").length, 0);
});

// --- cdx merge-review findings (2026-07-16) ----------------------------------

test("a voter literally named 'constructor' weighs 1 unless explicitly weighted (own-property lookup)", () => {
  const l = withTempDb();
  try {
    council(["a", "constructor"]);
    const mid = openRatification({
      proposer: "proposer",
      fleetId: "f1",
      subject: "s",
      quorum: 3,
      voters: ["a", "constructor"],
      weights: { a: 2 },
    });
    const t0 = tallyRatification(mid)!;
    assert.equal(t0.total_weight, 3, "inherited Object.prototype.constructor must not poison the sum");
    castVote("a", mid, true);
    castVote("constructor", mid, true);
    assert.equal(tallyRatification(mid)!.status, "ratified");
  } finally {
    l.cleanup();
  }
});

test("verify computes weighted reachability over UNIQUE voters when duplicates exist", () => {
  const data = seededRatification({ a2: 3 }, 5);
  data.ratifications!.p1!.voters = ["a2", "a2", "a3"]; // unique total weight 4 < quorum 5
  const report = verifyMeshData(data);
  assert.equal(report.findings.filter((x) => x.check === "ratification.duplicate_voters").length, 1);
  assert.equal(report.findings.filter((x) => x.check === "ratification.quorum_exceeds_voters").length, 1);
});

test("verify still runs config checks on a ratification whose proposal message is missing", () => {
  const data = seededRatification({ outsider: 0 }, 1);
  delete data.messages.p1;
  data.inboxes.a2 = [];
  data.inboxes.a3 = [];
  const report = verifyMeshData(data);
  assert.equal(report.findings.filter((x) => x.check === "ratification.orphan_proposal").length, 1);
  assert.equal(report.findings.filter((x) => x.check === "ratification.weight_for_non_voter").length, 1);
  assert.equal(report.findings.filter((x) => x.check === "ratification.invalid_weight").length, 1);
});

test("verify enforces the total-weight cap", () => {
  const data = seededRatification(undefined, 1);
  const eleven = Array.from({ length: 11 }, (_, i) => `v${i}`);
  data.ratifications!.p1!.voters = eleven;
  data.ratifications!.p1!.weights = Object.fromEntries(eleven.map((v) => [v, 1_000_000]));
  const report = verifyMeshData(data);
  assert.equal(report.findings.filter((x) => x.check === "ratification.total_weight_exceeded").length, 1);
});
