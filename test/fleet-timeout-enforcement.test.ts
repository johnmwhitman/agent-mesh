import { test } from "node:test";
import assert from "node:assert/strict";

import {
  expireFleetTimeoutAgents,
  loadData,
  saveData,
  setFleetTimeout,
} from "../src/core.js";
import { withTempDb } from "./helpers/with-temp-db.js";
import { FleetTimeoutEnforcer } from "../src/fleet-timeout.js";

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
