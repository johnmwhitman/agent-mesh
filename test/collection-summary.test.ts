import { test } from "node:test";
import assert from "node:assert/strict";

import { summarizeCollection } from "../src/collection-summary.js";

// Reconstructed from the real incident: fleet 1e6b5186, 7 agents, the server
// crashed mid-run, safety-engineer and systems-designer were killed, the other
// five finished. collect_results returned all seven and said nothing about the
// two that were gone. The operator found out by counting.
const CRASHED_FLEET = [
  { role: "safety-engineer", status: "interrupted", output: "" },
  { role: "tools-engineer", status: "complete", output: "the deliverable" },
  { role: "art-director", status: "complete", output: "the deliverable" },
  { role: "qa-lead", status: "complete", output: "the deliverable" },
  { role: "release-engineer", status: "complete", output: "the deliverable" },
  { role: "systems-designer", status: "interrupted", output: "" },
  { role: "community-copy", status: "complete", output: "the deliverable" },
];

test("the real incident: loss is counted, named, and warned about", () => {
  const s = summarizeCollection(CRASHED_FLEET);
  assert.equal(s.total, 7);
  assert.equal(s.delivered, 5);
  assert.equal(s.lost, 2);
  assert.equal(s.still_running, 0);

  const lostRoles = s.lost_agents.map((a) => a.role).sort();
  assert.deepEqual(lostRoles, ["safety-engineer", "systems-designer"]);

  // The highest-priority job was the one that went quiet. It must be NAMED,
  // not merely reflected in a count the caller has to compute.
  assert.ok(s.warning, "a fleet that lost agents must carry a warning");
  assert.match(s.warning!, /safety-engineer/);
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
