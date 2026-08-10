import { test } from "node:test";
import assert from "node:assert/strict";

import {
  expireFleetTimeoutAgents,
  getFleetTimeoutMs,
  loadData,
  MAX_FLEET_TIMEOUT_MS,
  nextFleetTimeoutDeadline,
  normalizePersistedFleetTimeouts,
  readEventLog,
  saveData,
  setFleetTimeout,
} from "../src/core.js";
import { withTempDb } from "./helpers/with-temp-db.js";
import {
  FleetTimeoutEnforcer,
  routeLegacyRuntimeResult,
  terminalizeLegacyRuntimeTimeout,
} from "../src/fleet-timeout.js";

test("fleet timeout expires only agents whose own deadline passed", () => {
  const temp = withTempDb();
  try {
    const data = loadData();
    data.fleets.target = { id: "target", status: "running", created_at: 1 };
    data.fleets.foreign = { id: "foreign", status: "running", created_at: 1 };
    data.agents.old = {
      id: "old", fleet_id: "target", role: "old", prompt: "work",
      status: "running", started_at: 1_000,
    };
    data.agents.fresh = {
      id: "fresh", fleet_id: "target", role: "fresh", prompt: "work",
      status: "running", started_at: 6_000,
    };
    data.agents.foreign = {
      id: "foreign", fleet_id: "foreign", role: "foreign", prompt: "work",
      status: "running", started_at: 1_000,
    };
    data.inboxes = { old: [], fresh: [], foreign: [] };
    saveData(data);
    setFleetTimeout("target", 10_000);

    const first = expireFleetTimeoutAgents("target", 11_000);
    assert.deepEqual(first.map((agent) => agent.agent_id), ["old"]);
    let observed = loadData();
    assert.equal(observed.agents.old.status, "failed");
    assert.equal(observed.agents.old.completed_at, 11_000);
    assert.match(observed.agents.old.error ?? "", /fleet timeout.*10000ms/i);
    assert.equal(observed.agents.fresh.status, "running");
    assert.equal(observed.fleets.target.status, "running");
    assert.equal(observed.agents.foreign.status, "running");
    assert.equal(observed.fleets.foreign.status, "running");

    const second = expireFleetTimeoutAgents("target", 16_000);
    assert.deepEqual(second.map((agent) => agent.agent_id), ["fresh"]);
    observed = loadData();
    assert.equal(observed.agents.fresh.status, "failed");
    assert.equal(observed.fleets.target.status, "failed");
    assert.equal(observed.fleets.target.completed_at, 16_000);
    assert.equal(observed.agents.foreign.status, "running");

    assert.deepEqual(expireFleetTimeoutAgents("target", 20_000), []);
  } finally {
    temp.cleanup();
  }
});

test("legacy runtime timeout stays terminal after a late fleet extension", () => {
  const temp = withTempDb();
  try {
    const data = loadData();
    data.fleets.target = { id: "target", status: "running", created_at: 1_000 };
    data.fleets.foreign = { id: "foreign", status: "running", created_at: 1_000 };
    data.agents.target = {
      id: "target", fleet_id: "target", role: "worker", prompt: "work",
      status: "running", started_at: 1_000,
    };
    data.agents.foreign = {
      id: "foreign", fleet_id: "foreign", role: "worker", prompt: "work",
      status: "running", started_at: 1_000,
    };
    data.inboxes = { target: [], foreign: [] };
    saveData(data);
    setFleetTimeout("target", 100);

    // The runtime's original timer fired at 1_100, but process shutdown has not
    // settled yet. A late extension cannot revoke that already-latched result.
    setFleetTimeout("target", 1_000);
    const active = { fleetId: "target", handleId: "handle-1", attempt: 1 };
    let nonTimeoutCalls = 0;
    let transitioned: boolean | undefined;

    routeLegacyRuntimeResult("timeout", {
      onTimeout: () => {
        transitioned = terminalizeLegacyRuntimeTimeout({
          agentId: "target",
          fleetId: "target",
          handleId: "stale-handle",
          attempt: 0,
          active,
          now: 1_100,
        });
      },
      onNonTimeout: () => { nonTimeoutCalls += 1; },
    });
    assert.equal(transitioned, false, "stale identity is rejected while the row is still running");
    assert.equal(loadData().agents.target.status, "running");
    assert.equal(readEventLog().filter((event) => event.event === "agent_fleet_timeout").length, 0);

    routeLegacyRuntimeResult("timeout", {
      onTimeout: () => {
        transitioned = terminalizeLegacyRuntimeTimeout({
          agentId: "target",
          fleetId: "target",
          handleId: "handle-1",
          attempt: 1,
          active,
          now: 1_101,
        });
      },
      onNonTimeout: () => { nonTimeoutCalls += 1; },
    });
    assert.equal(transitioned, true);
    assert.equal(nonTimeoutCalls, 0, "a timeout result never reaches normal retry/failover settlement");

    const observed = loadData();
    assert.equal(observed.agents.target.status, "failed");
    assert.equal(observed.agents.target.completed_at, 1_101);
    assert.match(observed.agents.target.error ?? "", /fleet runtime timeout elapsed/i);
    assert.equal(observed.fleets.target.status, "failed");
    assert.equal(observed.agents.foreign.status, "running");
    assert.equal(observed.fleets.foreign.status, "running");
    const events = readEventLog();
    assert.equal(events.filter((event) => event.event === "agent_fleet_timeout").length, 1);
    assert.equal(events.some((event) => event.event === "agent_retry_scheduled"), false);
    assert.equal(events.some((event) => event.event === "agent_runtime_failover"), false);

    assert.equal(terminalizeLegacyRuntimeTimeout({
      agentId: "target",
      fleetId: "target",
      handleId: "handle-1",
      attempt: 1,
      active,
      now: 1_102,
    }), false, "repeated delivery is idempotent after ledger terminalization");
    assert.equal(readEventLog().filter((event) => event.event === "agent_fleet_timeout").length, 1);

    const eventErrors: string[] = [];
    assert.equal(terminalizeLegacyRuntimeTimeout({
      agentId: "foreign",
      fleetId: "foreign",
      handleId: "handle-foreign",
      attempt: 1,
      active: { fleetId: "foreign", handleId: "handle-foreign", attempt: 1 },
      now: 1_103,
      appendTimeoutEvent: () => { throw new Error("event log unavailable"); },
      onEventError: (error) => { eventErrors.push(error instanceof Error ? error.message : String(error)); },
    }), true, "event projection failure cannot undo terminal ledger truth");
    assert.equal(loadData().agents.foreign.status, "failed");
    assert.deepEqual(eventErrors, ["event log unavailable"]);
  } finally {
    temp.cleanup();
  }
});

test("an oversized timeout persisted by an older release is migrated before scheduling", () => {
  const temp = withTempDb({
    fleets: {
      legacy: {
        id: "legacy", status: "running", created_at: 1_000,
        timeout_ms: MAX_FLEET_TIMEOUT_MS + 1,
      },
    },
    agents: {
      worker: {
        id: "worker", fleet_id: "legacy", role: "worker", prompt: "work",
        status: "running", started_at: 1_000,
      },
    },
  });
  try {
    assert.equal(getFleetTimeoutMs("legacy"), MAX_FLEET_TIMEOUT_MS);
    assert.equal(nextFleetTimeoutDeadline("legacy"), 1_000 + MAX_FLEET_TIMEOUT_MS);
    assert.deepEqual(expireFleetTimeoutAgents("legacy", MAX_FLEET_TIMEOUT_MS), []);

    assert.deepEqual(normalizePersistedFleetTimeouts(), [{
      fleet_id: "legacy",
      timeout_ms: MAX_FLEET_TIMEOUT_MS,
    }]);
    assert.equal(loadData().fleets.legacy.timeout_ms, MAX_FLEET_TIMEOUT_MS);
  } finally {
    temp.cleanup();
  }
});

test("timeout enforcer re-arms changed deadlines and cancels only newly expired agents", () => {
  let now = 100;
  let deadline: number | undefined = 200;
  const expired: Array<{ agent_id: string; fleet_id: string; reason: string }> = [];
  const cancelled: string[] = [];
  const scheduled: Array<{ delay: number; callback: () => void; cleared: boolean }> = [];

  const enforcer = new FleetTimeoutEnforcer({
    now: () => now,
    nextDeadline: (fleetId) => fleetId === "target" ? deadline : undefined,
    expire: (fleetId) => fleetId === "target" ? expired.splice(0) : [],
    cancelAgent: (agent) => { cancelled.push(agent.agent_id); },
    schedule: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      scheduled.push(timer);
      return timer;
    },
    clear: (timer) => { (timer as typeof scheduled[number]).cleared = true; },
  });

  enforcer.refresh("target");
  assert.equal(scheduled[0]?.delay, 100);

  deadline = 350;
  enforcer.refresh("target");
  assert.equal(scheduled[0]?.cleared, true, "changing the override clears the old deadline");
  assert.equal(scheduled[1]?.delay, 250);

  now = 350;
  deadline = undefined;
  expired.push({ agent_id: "target-agent", fleet_id: "target", reason: "Fleet timeout" });
  scheduled[1]!.callback();
  assert.deepEqual(cancelled, ["target-agent"]);
  assert.equal(scheduled.length, 2, "no timer remains after the last active agent expires");
});

test("timeout enforcer does not duplicate cancellation already owned by durable mode", () => {
  const genericCancellations: string[] = [];
  const enforcer = new FleetTimeoutEnforcer({
    nextDeadline: () => undefined,
    expire: () => [{
      agent_id: "durable-agent",
      fleet_id: "durable-fleet",
      pid: 10_001,
      reason: "Fleet timeout",
      cancellation_attempted: true,
    }],
    cancelAgent: (agent) => { genericCancellations.push(agent.agent_id); },
  });

  enforcer.refresh("durable-fleet");
  assert.deepEqual(genericCancellations, []);
});

test("timeout enforcer retries after transient ledger failures instead of losing the deadline", () => {
  let failure: "expire" | "deadline" | undefined = "expire";
  const errors: string[] = [];
  const scheduled: Array<{ delay: number; callback: () => void }> = [];
  const enforcer = new FleetTimeoutEnforcer({
    now: () => 100,
    retryDelayMs: 25,
    expire: () => {
      if (failure === "expire") throw new Error("ledger write busy");
      return [];
    },
    nextDeadline: () => {
      if (failure === "deadline") throw new Error("ledger read busy");
      return 200;
    },
    cancelAgent: () => {},
    onError: (error) => { errors.push(error instanceof Error ? error.message : String(error)); },
    schedule: (callback, delay) => {
      const timer = { callback, delay };
      scheduled.push(timer);
      return timer;
    },
    clear: () => {},
  });

  enforcer.refresh("target");
  assert.deepEqual(errors, ["ledger write busy"]);
  assert.equal(scheduled[0]?.delay, 25);

  failure = "deadline";
  scheduled[0]!.callback();
  assert.deepEqual(errors, ["ledger write busy", "ledger read busy"]);
  assert.equal(scheduled[1]?.delay, 25);

  failure = undefined;
  scheduled[1]!.callback();
  assert.equal(scheduled[2]?.delay, 100, "healthy retry restores the real fleet deadline");
});
