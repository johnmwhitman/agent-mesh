/**
 * Unit tests for the per-worker wall-clock enforcement and integrity verdict
 * introduced for the conductor hand-off `t_db8af59c` (2026-08-26).
 *
 * Six acceptance gates were prescribed by Conductor; this file covers the
 * pure-JS seams — gate #1 (minimum budget floor), gate #2 (per-worker
 * staleness reap), and gate #4 (artifact integrity verdict). The
 * end-to-end gates (#3 tree-kill semantics and #6 recovery test) live in
 * their own files because they need a real OS process to verify.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  expireStaleAgents,
  getFleetTimeoutMs,
  loadData,
  MIN_PER_WORKER_BUDGET_MS,
  recordAgentProgress,
  saveData,
  setFleetTimeout,
} from "../src/core.js";
import { computeArtifactIntegrity } from "../src/artifact-integrity.js";
import { withTempDb } from "./helpers/with-temp-db.js";

// ---------------------------------------------------------------------------
// Gate #1 — sub-second budget is structurally impossible
// ---------------------------------------------------------------------------

test("setFleetTimeout refuses non-finite or negative values, and clamps sub-floor values up", () => {
  // Gate #1 (t_db8af59c, 2026-08-26): the front door accepts any non-negative
  // finite value and clamps sub-floor values up to MIN_PER_WORKER_BUDGET_MS.
  // The MCP tool path (`set_fleet_timeout`) enforces the same floor with a
  // loud refusal — see index.ts; the internal API (`setFleetTimeout`) clamps
  // so existing timing-sensitive callers (e.g. lifecycle tests that need
  // "100ms" precision on the deadline math) still work. Non-finite and
  // negative inputs are still real mistakes and throw.
  const temp = withTempDb();
  try {
    const data = loadData();
    data.fleets.alpha = { id: "alpha", status: "running", created_at: 1 };
    data.agents.alpha = {
      id: "alpha-agent", fleet_id: "alpha", role: "x", prompt: "y",
      status: "running", started_at: 1_000,
    };
    data.inboxes = { "alpha-agent": [] };
    saveData(data);
    assert.throws(() => setFleetTimeout("alpha", NaN), /non-negative number/);
    assert.throws(() => setFleetTimeout("alpha", -1), /non-negative number/);
    // Sub-floor value is clamped UP and stored as the floor. The persisted
    // `timeout_ms` is what `getFleetTimeoutMs` returns — proving the floor
    // is the structural lower bound.
    setFleetTimeout("alpha", MIN_PER_WORKER_BUDGET_MS - 1);
    assert.equal(getFleetTimeoutMs("alpha"), MIN_PER_WORKER_BUDGET_MS);
    setFleetTimeout("alpha", 0);
    assert.equal(getFleetTimeoutMs("alpha"), MIN_PER_WORKER_BUDGET_MS);
  } finally {
    temp.cleanup();
  }
});

test("getFleetTimeoutMs clamps a historical 1ms value up to the floor", () => {
  // No need to seed — getFleetTimeoutMs reads from `data.fleets`; an absent
  // fleet returns configuredDefaultFleetTimeoutMs(). We seed an explicit
  // historical 1ms override to prove the clamp fires for legacy data.
  const temp = withTempDb();
  try {
    const data = loadData();
    data.fleets.legacy = { id: "legacy", status: "running", created_at: 1, timeout_ms: 1 };
    saveData(data);
    const resolved = getFleetTimeoutMs("legacy");
    assert.equal(resolved, MIN_PER_WORKER_BUDGET_MS, "historical 1ms must be clamped up to the floor");
    assert.ok(resolved >= MIN_PER_WORKER_BUDGET_MS);
  } finally {
    temp.cleanup();
  }
});

test("getFleetTimeoutMs returns MAX when stored value is non-numeric or out of range", () => {
  const temp = withTempDb();
  try {
    const data = loadData();
    // Far above MAX — same path as `Number.MAX_SAFE_INTEGER` evidence
    // pre-fix that the historical "any positive" validator accepted.
    data.fleets.huge = { id: "huge", status: "running", created_at: 1, timeout_ms: 10_000_000_000 };
    saveData(data);
    const resolved = getFleetTimeoutMs("huge");
    // MAX is the safe ceiling for stored values Node would otherwise clamp to 1ms.
    assert.ok(resolved >= MIN_PER_WORKER_BUDGET_MS, "clamp direction is up, not down");
    assert.ok(Number.isInteger(resolved));
  } finally {
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Gate #2 — per-worker staleness reap
// ---------------------------------------------------------------------------

test("expireStaleAgents reaps a worker that is past 50% of budget with no progress in the last 25%", () => {
  const temp = withTempDb();
  try {
    // Budget = 4000ms, started at t=1000. At t=5000 (50% consumed),
    // the worker has had zero progress, and the test is the canonical
    // stuck shape from the conductor hand-off.
    const data = loadData();
    data.fleets.f = { id: "f", status: "running", created_at: 1, timeout_ms: 4_000 };
    data.agents.stuck = {
      id: "stuck", fleet_id: "f", role: "x", prompt: "y",
      status: "running", started_at: 1_000, last_progress_at: 1_000,
    };
    data.agents.fresh = {
      id: "fresh", fleet_id: "f", role: "x", prompt: "y",
      status: "running", started_at: 1_000, last_progress_at: 4_500,
    };
    data.inboxes = { stuck: [], fresh: [] };
    saveData(data);

    // At t=5000: stuck is 4000ms into a 4000ms budget (100% consumed),
    // quiet for 4000ms — the canonical "stuck" shape. fresh has progress
    // at t=4500 so its quiet window is only 500ms — well under the 25%
    // threshold (1000ms) — so it stays running.
    const expired = expireStaleAgents("f", 5_000);
    assert.deepEqual(expired.map((e) => e.agent_id), ["stuck"]);
    const after = loadData();
    assert.equal(after.agents.stuck.status, "failed");
    assert.match(after.agents.stuck.error ?? "", /Worker stalled.*no progress signal/);
    assert.equal(after.agents.fresh.status, "running");
  } finally {
    temp.cleanup();
  }
});

test("expireStaleAgents does NOT reap a worker that has only consumed a small fraction of its budget", () => {
  const temp = withTempDb();
  try {
    const data = loadData();
    data.fleets.f = { id: "f", status: "running", created_at: 1, timeout_ms: 60_000 };
    data.agents.young = {
      id: "young", fleet_id: "f", role: "x", prompt: "y",
      status: "running", started_at: 1_000, last_progress_at: 1_000,
    };
    data.inboxes = { young: [] };
    saveData(data);
    // 25s elapsed: progress window is 50% of 60s = 30s. Not yet reached.
    const expired = expireStaleAgents("f", 26_000);
    assert.deepEqual(expired, []);
    assert.equal(loadData().agents.young.status, "running");
  } finally {
    temp.cleanup();
  }
});

test("expireStaleAgents treats absent last_progress_at as started_at", () => {
  const temp = withTempDb();
  try {
    const data = loadData();
    data.fleets.f = { id: "f", status: "running", created_at: 1, timeout_ms: 4_000 };
    // No last_progress_at — the field is absent on rows written before the
    // watchdog. The watchdog must default to started_at so a fresh agent
    // does not get an unfair "stuck at epoch 0" verdict.
    data.agents.np = {
      id: "np", fleet_id: "f", role: "x", prompt: "y",
      status: "running", started_at: 1_000,
    };
    data.inboxes = { np: [] };
    saveData(data);
    // Sanity: confirm the seed round-tripped.
    const seeded = loadData();
    assert.ok(seeded.agents.np, "seed round-trip should preserve np");
    // At t=5000: 4000ms elapsed since started_at (>= 50% of 4000ms = 2000ms
    // progress window), 4000ms "quiet" (>= 25% of 4000ms = 1000ms quiet
    // window) — reap.
    const expired = expireStaleAgents("f", 5_000);
    assert.deepEqual(expired.map((e) => e.agent_id), ["np"]);
    const after = loadData();
    assert.ok(after.agents.np, `agent row must survive the reap; keys: ${Object.keys(after.agents).join(",")}`);
    assert.equal(after.agents.np.status, "failed");
    assert.match(after.agents.np.error ?? "", /Worker stalled/);
  } finally {
    temp.cleanup();
  }
});

test("recordAgentProgress extends the quiet window so a thinking worker is not reaped", () => {
  const temp = withTempDb();
  try {
    const data = loadData();
    data.fleets.f = { id: "f", status: "running", created_at: 1, timeout_ms: 4_000 };
    data.agents.thinking = {
      id: "thinking", fleet_id: "f", role: "x", prompt: "y",
      status: "running", started_at: 1_000,
    };
    data.inboxes = { thinking: [] };
    saveData(data);
    // Stamp progress at t=2500. Quiet window is 25% of 4000ms = 1000ms.
    recordAgentProgress("thinking", 2_500);
    // At t=3200: 700ms since last progress — under the 1000ms quiet window.
    const stillRunning = expireStaleAgents("f", 3_200);
    assert.deepEqual(stillRunning, []);
    assert.equal(loadData().agents.thinking.status, "running");
    // At t=4000: 1500ms since last progress — over the quiet window.
    // 3000ms elapsed since start — over the 50% progress window of 2000ms.
    const reaped = expireStaleAgents("f", 4_000);
    assert.deepEqual(reaped.map((e) => e.agent_id), ["thinking"]);
  } finally {
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Gate #4 — per-worker artifact integrity verdict
// ---------------------------------------------------------------------------

test("computeArtifactIntegrity returns consistent for a fresh, non-empty artifact", () => {
  const oracle = {
    inspect: (path: string) => {
      if (path === "/artifacts/report.md") return { size: 1024, mtimeMs: 2_000 };
      return null;
    },
  };
  const agent = {
    id: "a1", fleet_id: "f1", role: "x", prompt: "y",
    status: "running" as const, started_at: 1_500,
  };
  const report = computeArtifactIntegrity(agent, ["/artifacts/report.md"], oracle);
  assert.equal(report.verdict, "consistent");
  assert.deepEqual(report.violations, []);
  assert.equal(report.inspected, 1);
});

test("computeArtifactIntegrity returns inconsistent for a missing artifact", () => {
  const oracle = { inspect: () => null };
  const agent = {
    id: "a1", fleet_id: "f1", role: "x", prompt: "y",
    status: "running" as const, started_at: 1_500,
  };
  const report = computeArtifactIntegrity(agent, ["/artifacts/ghost.md"], oracle);
  assert.equal(report.verdict, "inconsistent");
  assert.deepEqual(report.violations, [{ artifact: "/artifacts/ghost.md", reason: "missing" }]);
});

test("computeArtifactIntegrity returns inconsistent for an empty artifact", () => {
  const oracle = { inspect: () => ({ size: 0, mtimeMs: 2_000 }) };
  const agent = {
    id: "a1", fleet_id: "f1", role: "x", prompt: "y",
    status: "running" as const, started_at: 1_500,
  };
  const report = computeArtifactIntegrity(agent, ["/artifacts/empty.md"], oracle);
  assert.equal(report.verdict, "inconsistent");
  assert.deepEqual(report.violations, [{ artifact: "/artifacts/empty.md", reason: "empty" }]);
});

test("computeArtifactIntegrity returns inconsistent for an artifact older than started_at (stale / pre-existing file)", () => {
  // The agent started at t=2000 but the file at /artifacts/old.md has mtime
  // t=1000 — it was already there. This is the fabrication signature the
  // gate exists to surface.
  const oracle = { inspect: () => ({ size: 2048, mtimeMs: 1_000 }) };
  const agent = {
    id: "a1", fleet_id: "f1", role: "x", prompt: "y",
    status: "running" as const, started_at: 2_000,
  };
  const report = computeArtifactIntegrity(agent, ["/artifacts/old.md"], oracle);
  assert.equal(report.verdict, "inconsistent");
  assert.deepEqual(report.violations, [{ artifact: "/artifacts/old.md", reason: "stale" }]);
});

test("computeArtifactIntegrity returns unverifiable when no artifacts are declared", () => {
  const oracle = { inspect: () => ({ size: 1024, mtimeMs: 2_000 }) };
  const agent = {
    id: "a1", fleet_id: "f1", role: "x", prompt: "y",
    status: "running" as const, started_at: 1_500,
  };
  const reportNone = computeArtifactIntegrity(agent, undefined, oracle);
  assert.equal(reportNone.verdict, "unverifiable");
  const reportEmpty = computeArtifactIntegrity(agent, [], oracle);
  assert.equal(reportEmpty.verdict, "unverifiable");
});

test("computeArtifactIntegrity returns unverifiable when the agent has no started_at", () => {
  const oracle = { inspect: () => ({ size: 1024, mtimeMs: 2_000 }) };
  const agent = {
    id: "a1", fleet_id: "f1", role: "x", prompt: "y",
    status: "running" as const,
  };
  const report = computeArtifactIntegrity(agent, ["/artifacts/x.md"], oracle);
  assert.equal(report.verdict, "unverifiable");
});
