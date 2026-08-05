import { test } from "node:test";
import assert from "node:assert/strict";

import { summarizeCollection } from "../src/collection-summary.js";

// The shape of a real reported incident, with neutral roles: a 7-agent fleet
// where the server died mid-run, two agents were killed, and the other five
// finished normally. collect_results returned all seven and said nothing about
// the two that were gone — the loss was found by counting.
const CRASHED_FLEET = [
  { role: "critical-role", status: "interrupted", output: "" },
  { role: "role-b", status: "complete", output: "the deliverable" },
  { role: "role-c", status: "complete", output: "the deliverable" },
  { role: "role-d", status: "complete", output: "the deliverable" },
  { role: "role-e", status: "complete", output: "the deliverable" },
  { role: "second-role", status: "interrupted", output: "" },
  { role: "role-f", status: "complete", output: "the deliverable" },
];

test("the real incident: loss is counted, named, and warned about", () => {
  const s = summarizeCollection(CRASHED_FLEET);
  assert.equal(s.total, 7);
  assert.equal(s.delivered, 5);
  assert.equal(s.lost, 2);
  assert.equal(s.still_running, 0);

  const lostRoles = s.lost_agents.map((a) => a.role).sort();
  assert.deepEqual(lostRoles, ["critical-role", "second-role"]);

  // In the reported incident the lost agent was the caller's highest-priority
  // job. It must be NAMED, not merely reflected in a count they have to compute.
  assert.ok(s.warning, "a fleet that lost agents must carry a warning");
  assert.match(s.warning!, /critical-role/);
  assert.match(s.warning!, /2 of 7/);
});

test("a clean fleet carries NO warning — absence of the field is a real all-clear", () => {
  // The warning must be meaningful. If it were always present, callers would
  // learn to ignore it, which is how the original silence happened.
  const s = summarizeCollection([
    { role: "a", status: "complete", output: "x" },
    { role: "b", status: "complete", output: "y" },
  ]);
  assert.equal(s.lost, 0);
  assert.equal(s.warning, undefined, "a healthy collection must not cry wolf");
});

test("still-running is NOT counted as lost — silence must never be ambiguous", () => {
  // The whole defect is that a dead agent's silence looked like "not finished
  // yet". The summary must keep those two states apart, in both directions:
  // a running agent is not a loss, and a dead one is not merely pending.
  const s = summarizeCollection([
    { role: "working", status: "running", output: "" },
    { role: "dead", status: "interrupted", output: "" },
    { role: "done", status: "complete", output: "x" },
  ]);
  assert.equal(s.still_running, 1);
  assert.equal(s.lost, 1);
  assert.equal(s.delivered, 1);
  assert.equal(s.lost_agents[0]?.role, "dead");
});

test("each lost agent explains itself in the caller's terms", () => {
  const s = summarizeCollection([{ role: "x", status: "interrupted", output: "" }]);
  const meaning = s.lost_agents[0]!.meaning;
  // A caller must not need to know MeshFleet's internal vocabulary to learn
  // that this work is gone and needs re-dispatching.
  assert.match(meaning, /GONE|gone/);
  assert.match(meaning, /re-dispatch/i);
});

test("failed agents are tallied too, so the caller gets ONE honest count", () => {
  const s = summarizeCollection([
    { role: "a", status: "failed", output: "" },
    { role: "b", status: "interrupted", output: "" },
    { role: "c", status: "complete", output: "x" },
  ]);
  assert.equal(s.lost, 2);
  assert.equal(s.delivered, 1);
  // ...but they are distinguishable, because a failure reroutes and a death
  // must be re-dispatched.
  const byRole = Object.fromEntries(s.lost_agents.map((a) => [a.role, a.status]));
  assert.equal(byRole.a, "failed");
  assert.equal(byRole.b, "interrupted");
});

test("an empty fleet is not an alarm", () => {
  const s = summarizeCollection([]);
  assert.deepEqual(
    { total: s.total, lost: s.lost, delivered: s.delivered, warning: s.warning },
    { total: 0, lost: 0, delivered: 0, warning: undefined },
  );
});

test("an unknown status is treated as delivered, not silently dropped", () => {
  // Forward-compatibility: a status this build has never heard of must still be
  // counted in the total. Losing an agent from the tally is the exact bug.
  const s = summarizeCollection([{ role: "x", status: "some-future-status", output: "x" }]);
  assert.equal(s.total, 1);
  assert.equal(s.delivered + s.lost + s.still_running, 1);
});
