import { test } from "node:test";
import assert from "node:assert/strict";
import { LifecycleExecutionCoordinator } from "../src/lifecycle-execution.js";
import { LifecycleStore } from "../src/attempt-lifecycle.js";
import { loadData, readEventLog } from "../src/core.js";
import type { RuntimeAdapter, RuntimeHandle, RuntimeResult } from "../src/runtime/types.js";
import { withTempDb } from "./helpers/with-temp-db.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class ControlledRuntime implements RuntimeAdapter {
  readonly id = "controlled";
  readonly results: Array<ReturnType<typeof deferred<RuntimeResult>>> = [];
  describe() { return { id: this.id, displayName: "Controlled", defaultTimeoutMs: 1_000 }; }
  validate() { return { ok: true, errors: [] }; }
  async start(): Promise<RuntimeHandle> {
    const result = deferred<RuntimeResult>();
    this.results.push(result);
    return { id: `handle-${this.results.length}`, startedAt: Date.now(), isAlive: () => true };
  }
  wait(): Promise<RuntimeResult> { return this.results.at(-1)!.promise; }
  async cancel() { return { accepted: true }; }
}

function success(stdout = "ok"): RuntimeResult {
  return { status: "success", stdout, stderr: "", exitCode: 0, diagnostics: [], identity: { adapterId: "controlled", evidence: "none" } };
}

test("durable coordinator records pending projection before launch and settles atomically", async () => {
  const temp = withTempDb();
  try {
    const runtime = new ControlledRuntime();
    const coordinator = new LifecycleExecutionCoordinator(runtime, { ownerId: "owner-a", retryBaseMs: 0 });
    coordinator.createFleet("fleet-1", [{ fleetId: "fleet-1", agentId: "agent-1", role: "worker", prompt: "work" }]);
    assert.equal(loadData().agents["agent-1"].status, "pending");
    await new Promise((done) => setImmediate(done));
    assert.equal(loadData().agents["agent-1"].status, "running");
    runtime.results[0].resolve(success("completed"));
    await new Promise((done) => setImmediate(done));
    const data = loadData();
    assert.equal(data.agents["agent-1"].status, "complete");
    assert.equal(data.fleets["fleet-1"].status, "complete");
    assert.ok(readEventLog().some((event) => event.event === "fleet_created"));
  } finally {
    temp.cleanup();
  }
});

test("durable retry creates a distinct attempt and persisted eligibility", async () => {
  const temp = withTempDb();
  try {
    const runtime = new ControlledRuntime();
    const coordinator = new LifecycleExecutionCoordinator(runtime, { ownerId: "owner-a", retryBaseMs: 10, maxAttempts: 2 });
    coordinator.createFleet("fleet-1", [{ fleetId: "fleet-1", agentId: "agent-1", role: "worker", prompt: "work" }]);
    await new Promise((done) => setImmediate(done));
    runtime.results[0].resolve({ ...success(), status: "failure", exitCode: 1, error: "Bearer secret-value" });
    await new Promise((done) => setImmediate(done));
    const state = new LifecycleStore().getState("agent-1")!;
    assert.equal(state.work.status, "pending");
    assert.equal(state.attempts.length, 2);
    assert.notEqual(state.attempts[0].attempt_id, state.attempts[1].attempt_id);
    assert.ok(state.attempts[1].eligible_at >= state.attempts[0].updated_at);
  } finally {
    temp.cleanup();
  }
});
