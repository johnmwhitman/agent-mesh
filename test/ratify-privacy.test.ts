import { test } from "node:test";
import assert from "node:assert/strict";

import { registerAgentInLedger, getInbox, type Agent, type MeshData } from "../src/core.js";
import { withTempDb } from "./helpers/with-temp-db.js";
import { castVote, getRatification, openRatification, tallyRatification } from "../src/ratify.js";

// --- Council privacy fix (2026-07-19) ---------------------------------------
// Adversarial-review finding: openRatification always broadcast the proposal's
// `question` message to EVERY other fleet agent, even when `voters` narrowed
// the eligible voter set. A two-agent discussion that escalated to
// ratification leaked its content (the message payload) fleet-wide, to
// agents who were never meant to see it.
//
// Fix: when `voters` is explicit, deliver the proposal only to
// voters ∪ required_signoffs ∪ {proposer}. When `voters` is omitted (default
// = every other agent), the send stays a true broadcast, unchanged.

function agent(id: string, fleetId = "f1"): Agent {
  return { id, fleet_id: fleetId, role: "peer", prompt: "p", status: "running" };
}

/** Register a proposer + N peers (p1..pN) in one fleet. Returns the peer ids. */
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

test("narrowed voters: a non-voter, non-signoff, non-proposer agent's inbox does NOT receive the proposal", () => {
  const l = withTempDb();
  try {
    const peers = fleet(9); // p1..p9
    const mid = openRatification({
      proposer: "proposer",
      fleetId: "f1",
      subject: "two-agent discussion escalates",
      quorum: 2,
      voters: ["p1", "p2"],
    });
    // Everyone outside {p1, p2, proposer} must NOT see the proposal message.
    for (const outsider of peers.filter((p) => p !== "p1" && p !== "p2")) {
      const inbox = getInbox(outsider);
      assert.ok(
        !inbox.some((m) => m.id === mid),
        `${outsider} must not receive the narrowed proposal`
      );
    }
  } finally {
    l.cleanup();
  }
});

test("narrowed voters: voters, required signoffs, and the proposer DO receive the proposal", () => {
  const l = withTempDb();
  try {
    fleet(9);
    const mid = openRatification({
      proposer: "proposer",
      fleetId: "f1",
      subject: "canon change",
      quorum: 2,
      voters: ["p1", "p2", "p3"],
      requiredSignoffs: ["p3"],
    });
    for (const recipient of ["p1", "p2", "p3", "proposer"]) {
      const inbox = getInbox(recipient);
      assert.ok(
        inbox.some((m) => m.id === mid),
        `${recipient} (voter/signoff/proposer) must receive the narrowed proposal`
      );
    }
  } finally {
    l.cleanup();
  }
});

test("narrowed voters: tally derivation, weights, and quorum are unaffected by the delivery narrowing", () => {
  const l = withTempDb();
  try {
    fleet(9);
    const mid = openRatification({
      proposer: "proposer",
      fleetId: "f1",
      subject: "s",
      quorum: 2,
      voters: ["p1", "p2", "p3"],
      requiredSignoffs: ["p3"],
      weights: { p3: 2 },
    });
    const r = getRatification(mid)!;
    assert.deepEqual(r.voters, ["p1", "p2", "p3"]);
    assert.deepEqual(r.required_signoffs, ["p3"]);
    assert.deepEqual(r.weights, { p3: 2 });

    castVote("p1", mid, true);
    assert.equal(tallyRatification(mid)!.status, "open", "quorum met by weight but signoff missing");
    castVote("p3", mid, true); // signoff, weight 2 → quorum 2 satisfied too
    const t = tallyRatification(mid)!;
    assert.equal(t.status, "ratified");
    assert.equal(t.approval_weight, 3); // p1 (1) + p3 (2)
    assert.equal(t.signoffs_met, true);
  } finally {
    l.cleanup();
  }
});

test("default broadcast (voters omitted): delivery is unchanged — every other fleet agent receives it, proposer does not", () => {
  const l = withTempDb();
  try {
    const peers = fleet(9);
    const mid = openRatification({ proposer: "proposer", fleetId: "f1", subject: "amend §4", quorum: 6 });
    for (const p of peers) {
      assert.ok(getInbox(p).some((m) => m.id === mid), `${p} must receive the fleet-wide broadcast`);
    }
    assert.ok(
      !getInbox("proposer").some((m) => m.id === mid),
      "proposer never receives its own broadcast (unchanged default behavior)"
    );
    const msg = getInbox(peers[0]).find((m) => m.id === mid)!;
    assert.equal(msg.recipients?.length, 9, "recipients frozen at send to the full fleet, as before");
  } finally {
    l.cleanup();
  }
});

test("narrowed voters: message.recipients is frozen at send to exactly voters ∪ required_signoffs ∪ proposer", () => {
  const l = withTempDb();
  try {
    fleet(9);
    const mid = openRatification({
      proposer: "proposer",
      fleetId: "f1",
      subject: "s",
      quorum: 1,
      voters: ["p1", "p2"],
    });
    const msg = getInbox("p1").find((m) => m.id === mid)!;
    assert.deepEqual([...msg.recipients!].sort(), ["p1", "p2", "proposer"]);
  } finally {
    l.cleanup();
  }
});

test("back-compat: tally over a legacy ledger where the proposal's recipients equal only the voters (no proposer) still works", () => {
  const l = withTempDb();
  try {
    const data: MeshData = {
      fleets: { f1: { id: "f1", status: "running", created_at: 500 } },
      agents: {
        proposer: agent("proposer"),
        p1: agent("p1"),
        p2: agent("p2"),
      },
      messages: {
        legacyMsg: {
          id: "legacyMsg",
          from_agent_id: "proposer",
          to_agent_id: "*",
          fleet_id: "f1",
          type: "question",
          payload: "old-style broadcast proposal",
          timestamp: 1000,
          acknowledged: false,
          recipients: ["p1", "p2"], // old broadcast-to-everyone shape, pre-fix
        },
      },
      inboxes: { proposer: [], p1: ["legacyMsg"], p2: ["legacyMsg"] },
      capabilities: {},
      receipts: {
        "legacyMsg:p1:r-ack": { message_id: "legacyMsg", agent_id: "p1", action: "r-ack", timestamp: 2000 },
      },
      ratifications: {
        legacyMsg: {
          message_id: "legacyMsg",
          proposer: "proposer",
          fleet_id: "f1",
          subject: "s",
          quorum: 1,
          voters: ["p1", "p2"],
          required_signoffs: [],
          opened_at: 1000,
          silence_policy: "abstain",
          status: "open",
        },
      },
      templates: {},
    };
    l.seed(data);
    const t = tallyRatification("legacyMsg")!;
    assert.equal(t.status, "ratified");
    assert.deepEqual(t.approvals, ["p1"]);
    assert.deepEqual(t.pending, ["p2"]);
  } finally {
    l.cleanup();
  }
});
