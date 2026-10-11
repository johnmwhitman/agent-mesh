import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { registerAgentInLedger, type Agent } from "../src/core.js";
import { withTempDb } from "./helpers/with-temp-db.js";
import { castVote, openRatification, resolveRatification, tallyRatification } from "../src/ratify.js";

// A vote cast AFTER the deadline must not count. Before the fix a late approval was
// counted by effectiveVotes, so an expired ratification flipped to ratified the moment
// the late vote landed (index.ts resolves at `now` right after writing it).

function agent(id: string): Agent {
  return { id, fleet_id: "f1", role: "peer", prompt: "p", status: "running" };
}

test("a vote cast after the deadline is ignored: the ratification expires", () => {
  const l = withTempDb();
  const t0 = Date.now();
  let clock = t0;
  const nowMock = mock.method(Date, "now", () => clock);
  try {
    for (const id of ["proposer", "a", "b"]) registerAgentInLedger(agent(id));
    const mid = openRatification({
      proposer: "proposer", fleetId: "f1", subject: "s", quorum: 2,
      voters: ["a", "b"], deadline: t0 + 1_000,
    });
    clock = t0 + 500;
    castVote("a", mid, true); // in time
    clock = t0 + 5_000; // past the deadline
    castVote("b", mid, true); // late — would reach quorum 2
    const t = tallyRatification(mid, clock)!;
    assert.deepEqual(t.approvals, ["a"], JSON.stringify(t));
    assert.deepEqual(t.pending, ["b"]);
    assert.equal(t.status, "expired");
    assert.equal(resolveRatification(mid, clock), "expired");
  } finally {
    nowMock.mock.restore();
    l.cleanup();
  }
});

test("a vote exactly at the deadline still counts", () => {
  const l = withTempDb();
  const t0 = Date.now();
  let clock = t0;
  const nowMock = mock.method(Date, "now", () => clock);
  try {
    for (const id of ["proposer", "a"]) registerAgentInLedger(agent(id));
    const mid = openRatification({
      proposer: "proposer", fleetId: "f1", subject: "s", quorum: 1,
      voters: ["a"], deadline: t0 + 1_000,
    });
    clock = t0 + 1_000;
    castVote("a", mid, true);
    assert.equal(tallyRatification(mid, clock)!.status, "ratified");
  } finally {
    nowMock.mock.restore();
    l.cleanup();
  }
});
