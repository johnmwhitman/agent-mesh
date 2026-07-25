/**
 * Fleet completion is an aggregate over agent terminal states — and it was
 * missing one.
 *
 * `Agent.status` has five members; three of them are terminal
 * (`complete`, `failed`, `interrupted`). `_checkFleetCompletion` recognised
 * only two, so a fleet whose agents were ALL interrupted could never close:
 * every crash minted a fleet that stays `running` forever, and `get_health`
 * reported the pile as `abandoned_fleets` without anything able to act on it.
 *
 * The naive repair is a trap, and both design reviews caught it independently:
 * widening the predicate to include `interrupted` while keeping the binary
 * complete/failed outcome makes those fleets `complete`, because no agent
 * `failed`. That is a WORSE lie than leaving them `running`, and it is written
 * into the evidence ledger.
 *
 * So the outcome is a lattice, not a boolean, and it gets a fourth fleet
 * status. Tests here pin every edge of it, including the two that bit the
 * earlier attempts: the vacuous-truth case (`[].every(terminal)` is `true`) and
 * the re-terminalization path that `abandoned` has to keep open.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  loadData,
  saveData,
  markAgentFinished,
  registerAgentInLedger,
  recoverInterruptedAgents,
  reconcileAbandonedFleets,
  readEventLog,
  type Agent,
  type Fleet,
} from "../src/core.js";
import { getHealth } from "../src/health.js";
import { withTempDb } from "./helpers/with-temp-db.js";

/** Seed a fleet plus agents at the given statuses. Returns the fleet id. */
function seedFleet(
  statuses: Agent["status"][],
  fleetStatus: Fleet["status"] = "running",
  createdAt = 0
): string {
  const fleetId = `f-${randomUUID().slice(0, 8)}`;
  const data = loadData();
  data.fleets[fleetId] = { id: fleetId, status: fleetStatus, created_at: createdAt };
  statuses.forEach((status, i) => {
    const id = randomUUID();
    data.agents[id] = {
      id,
      fleet_id: fleetId,
      role: `r${i}`,
      prompt: "p",
      status,
      // Terminal agents carry completed_at; live ones do not.
      completed_at:
        status === "complete" || status === "failed" || status === "interrupted"
          ? 1
          : undefined,
    };
    data.inboxes[id] = [];
  });
  saveData(data);
  return fleetId;
}

const fleetStatus = (id: string): string => loadData().fleets[id].status;

// ---------------------------------------------------------------------------
// The outcome lattice
// ---------------------------------------------------------------------------

test("all agents interrupted and none failed terminalizes the fleet as abandoned", () => {
  const { cleanup } = withTempDb();
  const fleetId = seedFleet(["interrupted", "interrupted"]);

  reconcileAbandonedFleets();

  assert.equal(
    fleetStatus(fleetId),
    "abandoned",
    "a fleet whose agents were all interrupted by a crash is neither complete " +
      "nor failed — before this it stayed `running` forever"
  );
  assert.notEqual(
    loadData().fleets[fleetId].completed_at,
    undefined,
    "a terminalized fleet records when it terminalized"
  );
  cleanup();
});

test("a failed agent outranks an interrupted one — the fleet is failed, not abandoned", () => {
  const { cleanup } = withTempDb();
  const fleetId = seedFleet(["failed", "interrupted", "complete"]);

  reconcileAbandonedFleets();

  assert.equal(
    fleetStatus(fleetId),
    "failed",
    "`failed` means the work ran and errored; that fact must not be downgraded " +
      "to `abandoned` just because a sibling agent was also interrupted"
  );
  cleanup();
});

test("all agents complete still terminalizes as complete", () => {
  const { cleanup } = withTempDb();
  const fleetId = seedFleet(["complete", "complete"]);

  reconcileAbandonedFleets();

  assert.equal(fleetStatus(fleetId), "complete");
  cleanup();
});

test("a fleet with a live agent is left alone", () => {
  const { cleanup } = withTempDb();
  const running = seedFleet(["interrupted", "running"]);
  const pending = seedFleet(["interrupted", "pending"]);

  reconcileAbandonedFleets();

  assert.equal(fleetStatus(running), "running", "work may still be moving");
  assert.equal(fleetStatus(pending), "running", "`pending` is not terminal");
  cleanup();
});

test("a fleet with NO agents is left running, not vacuously completed", () => {
  const { cleanup } = withTempDb();
  // `[].every(terminal)` is `true`. A predicate that forgets this marks a fleet
  // that never ran a single agent as finished — and health.ts deliberately
  // classifies exactly this case as STUCK, so the read and write models would
  // then contradict each other. My own first version of the lattice had this bug.
  const fleetId = seedFleet([]);

  reconcileAbandonedFleets();

  assert.equal(
    fleetStatus(fleetId),
    "running",
    "an empty fleet is stuck, not finished — nothing can ever trigger its completion"
  );
  assert.equal(loadData().fleets[fleetId].completed_at, undefined);
  cleanup();
});

// ---------------------------------------------------------------------------
// Sealing: `complete`/`failed` are final, `abandoned` deliberately is not
// ---------------------------------------------------------------------------

test("a sealed fleet is never re-terminalized by a later reconcile", () => {
  const { cleanup } = withTempDb();
  const completed = seedFleet(["complete", "interrupted"], "complete");
  const failed = seedFleet(["interrupted"], "failed");
  const before = loadData();
  const completedAt = before.fleets[completed].completed_at;

  reconcileAbandonedFleets();

  assert.equal(
    fleetStatus(completed),
    "complete",
    "recomputing must not rewrite a fleet that already reached a sealed outcome"
  );
  assert.equal(fleetStatus(failed), "failed");
  assert.equal(loadData().fleets[completed].completed_at, completedAt);
  cleanup();
});

test("an abandoned fleet is recomputed, not frozen, when a replacement agent finishes", () => {
  const { cleanup } = withTempDb();
  const fleetId = seedFleet(["interrupted"]);
  reconcileAbandonedFleets();
  assert.equal(fleetStatus(fleetId), "abandoned");

  // `abandoned` is not sealed: attach_agent accepts it, so completion must keep
  // running over the fleet afterwards rather than treating it as final.
  const replacement = randomUUID();
  registerAgentInLedger({
    id: replacement,
    fleet_id: fleetId,
    role: "replacement",
    prompt: "p",
    status: "running",
  });
  markAgentFinished(replacement, "complete", "ok", undefined);

  // ...but it recomputes to `abandoned` again, and that is the specified answer,
  // not an oversight. The interrupted agent is still there: attach_agent injects
  // a NEW agent and deliberately leaves the corpse intact, so the fleet still
  // contains work that died and was never resumed. Reporting `complete` here
  // would erase that from the evidence ledger to make a nicer-looking label.
  //
  // STATED LIMITATION: the fleet status therefore cannot distinguish a fleet
  // that was recovered from one that never was. That distinction lives in the
  // agent rows and in the `fleet_reconciled` events, not in this field. Encoding
  // it properly needs a supersession link between a replacement and the agent it
  // replaces, which does not exist and is not in this change's scope.
  assert.equal(
    fleetStatus(fleetId),
    "abandoned",
    "a successful replacement does not un-abandon the agent that died"
  );
  assert.equal(
    loadData().agents[replacement].status,
    "complete",
    "the replacement's own outcome is recorded truthfully — that is where " +
      "recovery is visible"
  );
  cleanup();
});

// ---------------------------------------------------------------------------
// Crash recovery closes the loop it used to leave open
// ---------------------------------------------------------------------------

test("recoverInterruptedAgents terminalizes the fleet it just interrupted", () => {
  const { cleanup } = withTempDb();
  const fleetId = `f-${randomUUID().slice(0, 8)}`;
  const agentId = randomUUID();
  const data = loadData();
  data.fleets[fleetId] = { id: fleetId, status: "running", created_at: 0 };
  // No pid — the liveness probe treats a pid-less running agent as dead.
  data.agents[agentId] = {
    id: agentId,
    fleet_id: fleetId,
    role: "r",
    prompt: "p",
    status: "running",
  };
  data.inboxes[agentId] = [];
  saveData(data);

  const recovered = recoverInterruptedAgents();

  assert.equal(recovered, 1);
  assert.equal(
    loadData().agents[agentId].status,
    "interrupted",
    "precondition: the crashed agent is flipped"
  );
  assert.equal(
    fleetStatus(fleetId),
    "abandoned",
    "recovery never called completion, which is why every crash minted a " +
      "permanently-running fleet — the pile of them was the reported symptom"
  );
  cleanup();
});

// ---------------------------------------------------------------------------
// The reconciliation is auditable, not a silent status mutation
// ---------------------------------------------------------------------------

test("reconciliation writes a transition event naming the before and after", () => {
  const { cleanup } = withTempDb();
  const fleetId = seedFleet(["interrupted", "complete"]);

  const count = reconcileAbandonedFleets();

  assert.equal(count, 1, "returns how many fleets it moved");
  const events = readEventLog().filter((e) => e.event === "fleet_reconciled");
  assert.equal(events.length, 1);
  assert.deepEqual(
    { fleet_id: events[0].fleet_id, from: events[0].from, to: events[0].to },
    { fleet_id: fleetId, from: "running", to: "abandoned" },
    "silently rewriting a status in an evidence ledger is the same defect that " +
      "disqualified the 'just reuse failed' option — the transition is a receipt"
  );
  cleanup();
});

test("reconciliation is idempotent — a second pass moves nothing and logs nothing", () => {
  const { cleanup } = withTempDb();
  seedFleet(["interrupted"]);
  reconcileAbandonedFleets();

  const second = reconcileAbandonedFleets();

  assert.equal(second, 0);
  assert.equal(readEventLog().filter((e) => e.event === "fleet_reconciled").length, 1);
  cleanup();
});

// ---------------------------------------------------------------------------
// The health signal must not go quiet just because the rows got labelled
// ---------------------------------------------------------------------------

test("health still counts abandoned fleets once they carry the stored status", () => {
  const { cleanup } = withTempDb();
  // Old enough that the legacy inference would have caught it while it was
  // still mislabelled `running`.
  const fleetId = seedFleet(["interrupted"], "running", Date.now() - 48 * 60 * 60 * 1000);
  assert.equal(
    getHealth().abandoned_fleets,
    1,
    "precondition: the inference reports it before reconciliation"
  );

  reconcileAbandonedFleets();

  assert.equal(fleetStatus(fleetId), "abandoned");
  assert.equal(
    getHealth().abandoned_fleets,
    1,
    "fixing the label must not silence the count — an alarm removed without a " +
      "replacement signal is how a fixed symptom becomes an invisible one"
  );
  cleanup();
});

test("an abandoned fleet does not make health degraded, but an empty stuck one does", () => {
  const { cleanup } = withTempDb();
  const dayOld = Date.now() - 48 * 60 * 60 * 1000;
  seedFleet(["interrupted"], "running", dayOld);
  reconcileAbandonedFleets();
  assert.equal(getHealth().status, "ok", "a projection inconsistency is not a hang");

  seedFleet([], "running", dayOld);
  assert.equal(
    getHealth().status,
    "degraded",
    "a fleet with no agents at all can never complete — that is a real hang"
  );
  cleanup();
});
