import { test } from "node:test";
import assert from "node:assert/strict";
import { LifecycleExecutionCoordinator } from "../src/lifecycle-execution.js";
import { LifecycleStore } from "../src/attempt-lifecycle.js";
import { loadData, readEventLog } from "../src/core.js";
import type { ExecutionSpec, RuntimeAdapter, RuntimeHandle, RuntimeResult } from "../src/runtime/types.js";
import { withTempDb } from "./helpers/with-temp-db.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class ControlledRuntime implements RuntimeAdapter {
  readonly id = "controlled";
  readonly results: Array<ReturnType<typeof deferred<RuntimeResult>>> = [];
  readonly starts: ExecutionSpec[] = [];
  describe() { return { id: this.id, displayName: "Controlled", defaultTimeoutMs: 1_000 }; }
  validate() { return { ok: true, errors: [] }; }
  async start(spec: ExecutionSpec): Promise<RuntimeHandle> {
    this.starts.push(spec);
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

function failure(error = "transient"): RuntimeResult {
  return { status: "failure", stdout: "", stderr: error, exitCode: 1, error, diagnostics: [], identity: { adapterId: "controlled", evidence: "none" } };
}

async function waitUntil(
  predicate: () => boolean,
  what: string,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((done) => setTimeout(done, 5));
  }
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
    coordinator.stop();
  } finally {
    temp.cleanup();
  }
});

test("durable retry creates a distinct attempt and persisted eligibility", async () => {
  const temp = withTempDb();
  try {
    const runtime = new ControlledRuntime();
    // The retry delay is deliberately unreachable (jitter is 0.8-1.2x base, so >=48s) rather
    // than merely "long enough". This test asserts the PERSISTED state after a failure settles
    // -- a second attempt row exists and is scheduled -- not how fast the retry fires. With a
    // small base (was 10ms) the retry timer beat the assertion whenever the runner stalled for
    // more than one event-loop tick, which is routine on loaded Windows CI: work.status read
    // 'running' because attempt 2 had already launched. Racing the scheduler proves nothing
    // this test claims, so the race is removed instead of widened.
    const coordinator = new LifecycleExecutionCoordinator(runtime, { ownerId: "owner-a", retryBaseMs: 60_000, maxAttempts: 2 });
    coordinator.createFleet("fleet-1", [{ fleetId: "fleet-1", agentId: "agent-1", role: "worker", prompt: "work" }]);
    await new Promise((done) => setImmediate(done));
    runtime.results[0].resolve({ ...success(), status: "failure", exitCode: 1, error: "Bearer secret-value" });
    await new Promise((done) => setImmediate(done));
    const state = new LifecycleStore().getState("agent-1")!;
    assert.equal(state.work.status, "pending");
    assert.equal(state.attempts.length, 2);
    assert.notEqual(state.attempts[0].attempt_id, state.attempts[1].attempt_id);
    assert.ok(state.attempts[1].eligible_at >= state.attempts[0].updated_at);
    coordinator.stop();
  } finally {
    temp.cleanup();
  }
});

test("durable createFleet persists requested_model and first start sees it", async () => {
  const temp = withTempDb();
  try {
    const runtime = new ControlledRuntime();
    const coordinator = new LifecycleExecutionCoordinator(runtime, {
      ownerId: "owner-model",
      retryBaseMs: 0,
    });
    coordinator.createFleet("fleet-m", [{
      fleetId: "fleet-m",
      agentId: "agent-m",
      role: "worker",
      prompt: "work",
      requestedModel: "opencode-go/minimax-m3",
    }]);
    assert.equal(loadData().agents["agent-m"].requested_model, "opencode-go/minimax-m3");
    await waitUntil(() => runtime.starts.length >= 1, "first durable start");
    assert.equal(runtime.starts[0]?.requestedModel, "opencode-go/minimax-m3");
    coordinator.stop();
  } finally {
    temp.cleanup();
  }
});

test("durable attachAgent persists requested_model and starts with it", async () => {
  const temp = withTempDb();
  try {
    const runtime = new ControlledRuntime();
    const coordinator = new LifecycleExecutionCoordinator(runtime, {
      ownerId: "owner-attach-model",
      retryBaseMs: 0,
    });
    coordinator.createFleet("fleet-attach", [{
      fleetId: "fleet-attach",
      agentId: "agent-seed",
      role: "seed",
      prompt: "seed",
    }]);
    await waitUntil(
      () => runtime.starts.some((spec) => spec.agentId === "agent-seed"),
      "seed durable start",
    );

    const attached = coordinator.attachAgent({
      fleetId: "fleet-attach",
      agentId: "agent-attached",
      role: "worker",
      prompt: "work",
      requestedModel: "opencode-go/minimax-m3",
    });
    assert.deepEqual(attached, {});
    assert.equal(
      loadData().agents["agent-attached"].requested_model,
      "opencode-go/minimax-m3",
    );
    await waitUntil(
      () => runtime.starts.some((spec) => spec.agentId === "agent-attached"),
      "attached durable start",
    );
    const attachedStart = runtime.starts.find(
      (spec) => spec.agentId === "agent-attached",
    );
    assert.equal(attachedStart?.requestedModel, "opencode-go/minimax-m3");
    coordinator.stop();
  } finally {
    temp.cleanup();
  }
});

test("durable retry reuses requestedModel from the Agent row", async () => {
  const temp = withTempDb();
  try {
    const runtime = new ControlledRuntime();
    const coordinator = new LifecycleExecutionCoordinator(runtime, {
      ownerId: "owner-retry-model",
      retryBaseMs: 1,
      maxAttempts: 3,
    });
    coordinator.createFleet("fleet-r", [{
      fleetId: "fleet-r",
      agentId: "agent-r",
      role: "worker",
      prompt: "work",
      requestedModel: "opencode-go/minimax-m3",
    }]);
    await waitUntil(() => runtime.starts.length >= 1, "first start");
    runtime.results[0].resolve(failure("first boom"));
    await waitUntil(() => runtime.starts.length >= 2, "durable retry start");
    assert.equal(runtime.starts[0]?.requestedModel, "opencode-go/minimax-m3");
    assert.equal(runtime.starts[1]?.requestedModel, "opencode-go/minimax-m3");
    assert.equal(loadData().agents["agent-r"].requested_model, "opencode-go/minimax-m3");
    coordinator.stop();
  } finally {
    temp.cleanup();
  }
});

test("reconstructed coordinator reads requestedModel from the Agent row", async () => {
  const temp = withTempDb();
  try {
    let now = 1_000;
    const runtime1 = new ControlledRuntime();
    const first = new LifecycleExecutionCoordinator(runtime1, {
      ownerId: "owner-first",
      retryBaseMs: 0,
      maxAttempts: 3,
      leaseMs: 30,
      now: () => now,
    });
    first.createFleet("fleet-rec", [{
      fleetId: "fleet-rec",
      agentId: "agent-rec",
      role: "worker",
      prompt: "work",
      requestedModel: "kilo/kilo-auto/free",
    }]);
    await waitUntil(() => runtime1.starts.length >= 1, "initial launch");
    assert.equal(runtime1.starts[0]?.requestedModel, "kilo/kilo-auto/free");
    await waitUntil(() => {
      const state = new LifecycleStore().getState("agent-rec");
      const attempt = state?.attempts.find(
        (candidate) => candidate.attempt_id === state.work.current_attempt_id,
      );
      return attempt !== undefined && attempt.launch_registered_at !== null;
    }, "durable handle registration");
    // Leave the attempt running under a short lease, then stop so a new
    // coordinator must recover from the ledger Agent row — not in-memory spec.
    first.stop();
    now += 31;

    const runtime2 = new ControlledRuntime();
    const recovered = new LifecycleExecutionCoordinator(runtime2, {
      ownerId: "owner-second",
      retryBaseMs: 0,
      maxAttempts: 3,
      leaseMs: 1_000,
      now: () => now,
    });
    recovered.recover();
    await waitUntil(() => runtime2.starts.length >= 1, "recovered launch");
    assert.equal(loadData().agents["agent-rec"].requested_model, "kilo/kilo-auto/free");
    assert.equal(runtime2.starts[0]?.requestedModel, "kilo/kilo-auto/free");
    recovered.stop();
  } finally {
    temp.cleanup();
  }
});
