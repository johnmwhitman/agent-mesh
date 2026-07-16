import { test } from "node:test";
import assert from "node:assert/strict";

import {
  registerAgentInLedger,
  type Agent,
  type MeshData,
} from "../src/core.js";
import { withTempDb } from "./helpers/with-temp-db.js";
import {
  castVote,
  getRatification,
  openRatification,
  resolveRatification,
  sweepRatifications,
  tallyRatification,
} from "../src/ratify.js";

function freshLedger(): { cleanup: () => void } {
  return withTempDb();
}

function agent(id: string, fleetId: string): Agent {
  return { id, fleet_id: fleetId, role: "peer", prompt: "p", status: "running" };
}

/** Register a proposer + N peers in one fleet. Returns the peer ids. */
function fleet(n: number, fleetId = "f1"): string[] {
  registerAgentInLedger(agent("proposer", fleetId));
  const peers: string[] = [];
  for (let i = 1; i <= n; i++) {
    const id = `p${i}`;
    registerAgentInLedger(agent(id, fleetId));
    peers.push(id);
  }
  return peers;
}

test("open resolves voters to the fleet's other agents", () => {
  const l = freshLedger();
  try {
    fleet(9);
    const mid = openRatification({ proposer: "proposer", fleetId: "f1", subject: "amend §4", quorum: 6 });
    const r = getRatification(mid)!;
    assert.equal(r.voters.length, 9);
    assert.ok(!r.voters.includes("proposer"));
    assert.equal(r.status, "open");
  } finally {
    l.cleanup();
  }
});

test("6/9 quorum: ratifies on the sixth approval", () => {
  const l = freshLedger();
  try {
    const peers = fleet(9);
    const mid = openRatification({ proposer: "proposer", fleetId: "f1", subject: "x", quorum: 6 });
    for (const p of peers.slice(0, 5)) castVote(p, mid, true);
    assert.equal(tallyRatification(mid)!.status, "open", "5 approvals is short");
    castVote(peers[5], mid, true);
    const t = tallyRatification(mid)!;
    assert.equal(t.status, "ratified");
    assert.equal(t.approvals.length, 6);
  } finally {
    l.cleanup();
  }
});

test("rejects when quorum becomes unreachable", () => {
  const l = freshLedger();
  try {
    const peers = fleet(9); // quorum 6 → max 3 declines tolerable
    const mid = openRatification({ proposer: "proposer", fleetId: "f1", subject: "x", quorum: 6 });
    for (const p of peers.slice(0, 4)) castVote(p, mid, false);
    const t = tallyRatification(mid)!;
    assert.equal(t.reachable, false, "4 declines: only 5 approvals possible < 6");
    assert.equal(t.status, "rejected");
  } finally {
    l.cleanup();
  }
});

test("required signoff (T5): quorum without it does not ratify", () => {
  const l = freshLedger();
  try {
    const peers = fleet(9);
    const mid = openRatification({
      proposer: "proposer",
      fleetId: "f1",
      subject: "canon change",
      quorum: 6,
      requiredSignoffs: ["p9"],
    });
    for (const p of peers.slice(0, 6)) castVote(p, mid, true); // p1..p6, not p9
    assert.equal(tallyRatification(mid)!.status, "open", "quorum met but signoff missing");
    castVote("p9", mid, true);
    assert.equal(tallyRatification(mid)!.status, "ratified");
  } finally {
    l.cleanup();
  }
});

test("required signoff declines → rejected even with quorum", () => {
  const l = freshLedger();
  try {
    const peers = fleet(9);
    const mid = openRatification({
      proposer: "proposer",
      fleetId: "f1",
      subject: "x",
      quorum: 6,
      requiredSignoffs: ["p9"],
    });
    for (const p of peers.slice(0, 6)) castVote(p, mid, true);
    castVote("p9", mid, false);
    assert.equal(tallyRatification(mid)!.status, "rejected");
  } finally {
    l.cleanup();
  }
});

test("silence = approve: pending voters count once the deadline passes", () => {
  const l = freshLedger();
  try {
    const peers = fleet(9);
    const mid = openRatification({
      proposer: "proposer",
      fleetId: "f1",
      subject: "swarm vote",
      quorum: 6,
      deadline: 1000,
      silencePolicy: "approve",
    });
    castVote(peers[0], mid, true); // one explicit approval
    assert.equal(tallyRatification(mid, 500)!.status, "open", "before deadline: 1 approval");
    const t = tallyRatification(mid, 1500)!; // after deadline
    assert.equal(t.status, "ratified", "8 pending count as approve → well over 6");
  } finally {
    l.cleanup();
  }
});

test("silence = abstain (default): short vote expires at the deadline", () => {
  const l = freshLedger();
  try {
    const peers = fleet(9);
    const mid = openRatification({
      proposer: "proposer",
      fleetId: "f1",
      subject: "x",
      quorum: 6,
      deadline: 1000,
    });
    castVote(peers[0], mid, true);
    castVote(peers[1], mid, true);
    assert.equal(tallyRatification(mid, 1500)!.status, "expired");
  } finally {
    l.cleanup();
  }
});

test("resolve persists the terminal status once", () => {
  const l = freshLedger();
  try {
    const peers = fleet(9);
    const mid = openRatification({ proposer: "proposer", fleetId: "f1", subject: "x", quorum: 6 });
    for (const p of peers.slice(0, 6)) castVote(p, mid, true);
    assert.equal(resolveRatification(mid), "ratified");
    assert.equal(getRatification(mid)!.status, "ratified");
    assert.ok(getRatification(mid)!.resolved_at !== undefined);
    // Further votes cannot flip a resolved ratification
    castVote(peers[6], mid, false);
    assert.equal(tallyRatification(mid)!.status, "ratified");
  } finally {
    l.cleanup();
  }
});

test("non-voter cannot cast a vote", () => {
  const l = freshLedger();
  try {
    fleet(9);
    registerAgentInLedger(agent("outsider", "f2"));
    const mid = openRatification({ proposer: "proposer", fleetId: "f1", subject: "x", quorum: 6 });
    assert.throws(() => castVote("outsider", mid, true), /not an eligible voter/);
  } finally {
    l.cleanup();
  }
});

test("quorum exceeding voter count is rejected at open", () => {
  const l = freshLedger();
  try {
    fleet(3);
    assert.throws(
      () => openRatification({ proposer: "proposer", fleetId: "f1", subject: "x", quorum: 5 }),
      /exceeds 3 eligible voters/
    );
  } finally {
    l.cleanup();
  }
});

test("required signoff must be an eligible voter", () => {
  const l = freshLedger();
  try {
    fleet(9);
    assert.throws(
      () =>
        openRatification({
          proposer: "proposer",
          fleetId: "f1",
          subject: "x",
          quorum: 6,
          requiredSignoffs: ["ghost"],
        }),
      /not among voters/
    );
  } finally {
    l.cleanup();
  }
});

test("sweep resolves expired and silent-approve ratifications, leaves live ones open", () => {
  const l = freshLedger();
  try {
    const peers = fleet(9);
    // r1: deadline passed, silence=approve → should ratify on sweep
    const r1 = openRatification({
      proposer: "proposer", fleetId: "f1", subject: "r1", quorum: 6,
      deadline: 1000, silencePolicy: "approve",
    });
    // r2: deadline passed, silence=abstain, short → should expire on sweep
    const r2 = openRatification({
      proposer: "proposer", fleetId: "f1", subject: "r2", quorum: 6, deadline: 1000,
    });
    // r3: no deadline, still short → stays open
    const r3 = openRatification({
      proposer: "proposer", fleetId: "f1", subject: "r3", quorum: 6,
    });
    castVote(peers[0], r2, true);
    const result = sweepRatifications(2000);
    assert.equal(result.checked, 3);
    assert.deepEqual(
      Object.fromEntries(Object.entries(result.resolved).sort()),
      { [r1]: "ratified", [r2]: "expired" }
    );
    assert.equal(getRatification(r3)!.status, "open");
    // second sweep: nothing open with a passed deadline resolves again
    const again = sweepRatifications(3000);
    assert.equal(again.checked, 1); // only r3 still open
    assert.deepEqual(again.resolved, {});
  } finally {
    l.cleanup();
  }
});

test("castVote / tally / getRatification return null for unknown proposal", () => {
  const l = freshLedger();
  try {
    assert.equal(castVote("p1", "nope", true), false);
    assert.equal(tallyRatification("nope"), null);
    assert.equal(getRatification("nope"), null);
  } finally {
    l.cleanup();
  }
});

// --- Regression: production vote-polarity incident (2026-07) -------------
// Agents answered "REVISE-NEEDED" and the relay mapped that to approve=false,
// inverting every vote's meaning against the subject-as-stated. Recovery
// depended on two core behaviors that were never pinned by tests until now.

test("polarity recovery: re-cast vote wins, an agent is never double-counted", () => {
  const l = freshLedger();
  try {
    const peers = fleet(3);
    const mid = openRatification({ proposer: "proposer", fleetId: "f1", subject: "revise the copy", quorum: 2 });
    // The inverted relay: everyone 'declines' the subject they actually agree with.
    for (const p of peers) castVote(p, mid, false);
    assert.equal(tallyRatification(mid)!.status, "rejected", "unanimous declines read as rejected");
    // Corrected relay re-casts the true polarity while the ratification is still open.
    for (const p of peers) castVote(p, mid, true);
    const t = tallyRatification(mid)!;
    // Latest vote wins; both receipt rows exist, but each agent lands in exactly one bucket.
    assert.equal(t.status, "ratified");
    assert.deepEqual(t.declines, []);
    assert.equal(t.approvals.length, 3);
    assert.equal(
      t.approvals.length + t.declines.length + t.pending.length,
      3,
      "buckets must partition the voter set — no double-counting from paired r-ack/r-decline rows"
    );
    for (const p of peers) {
      assert.ok(!(t.approvals.includes(p) && t.declines.includes(p)), `${p} in both buckets`);
    }
  } finally {
    l.cleanup();
  }
});

test("polarity recovery: a RESOLVED ratification is sticky — re-votes cannot flip it", () => {
  const l = freshLedger();
  try {
    const peers = fleet(3);
    const mid = openRatification({ proposer: "proposer", fleetId: "f1", subject: "revise the copy", quorum: 2 });
    for (const p of peers) castVote(p, mid, false);
    assert.equal(resolveRatification(mid), "rejected", "terminal status persisted");
    // Corrected votes arrive too late: terminal status must hold.
    for (const p of peers) castVote(p, mid, true);
    assert.equal(tallyRatification(mid)!.status, "rejected", "terminal status is immutable");
    assert.equal(getRatification(mid)!.status, "rejected");
    // This is why the production fix opened a FRESH ratification: after
    // resolution, the only honest correction is a new proposal on the record.
  } finally {
    l.cleanup();
  }
});

// --- Duplicate voters (verify-audit finding, 2026-07-16) --------------------
// A duplicated voter id would be counted once per occurrence by the tally's
// voters.filter(...), letting one agent satisfy a quorum of 2 alone.

test("open dedupes the voter set so one agent cannot double-count toward quorum", () => {
  const l = freshLedger();
  try {
    fleet(2);
    assert.throws(
      () =>
        openRatification({
          proposer: "proposer",
          fleetId: "f1",
          subject: "s",
          quorum: 2,
          voters: ["p1", "p1"],
        }),
      /quorum 2 exceeds 1 eligible voters/,
      "after dedupe there is one voter, so quorum 2 must be rejected"
    );
    const mid = openRatification({
      proposer: "proposer",
      fleetId: "f1",
      subject: "s",
      quorum: 2,
      voters: ["p1", "p1", "p2"],
    });
    assert.deepEqual(getRatification(mid)!.voters, ["p1", "p2"]);
    castVote("p1", mid, true);
    assert.equal(tallyRatification(mid)!.approvals.length, 1);
    assert.equal(tallyRatification(mid)!.status, "open", "one distinct approval must not satisfy quorum 2");
  } finally {
    l.cleanup();
  }
});
