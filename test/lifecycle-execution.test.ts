import { test } from "node:test";
import assert from "node:assert/strict";
import { LifecycleExecutionCoordinator } from "../src/lifecycle-execution.js";
import { LifecycleStore } from "../src/attempt-lifecycle.js";
import { loadData, readEventLog, setFleetTimeout } from "../src/core.js";
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
  readonly cancellations: string[] = [];
  constructor(
    private readonly now: () => number = Date.now,
    private readonly pidBase = 10_000,
  ) {}
  describe() { return { id: this.id, displayName: "Controlled", defaultTimeoutMs: 1_000 }; }
  validate() { return { ok: true, errors: [] }; }
  async start(spec: ExecutionSpec): Promise<RuntimeHandle> {
    this.starts.push(spec);
    const result = deferred<RuntimeResult>();
    this.results.push(result);
    return { id: `handle-${this.results.length}`, pid: this.pidBase + this.results.length, startedAt: this.now(), isAlive: () => true };
  }
  wait(): Promise<RuntimeResult> { return this.results.at(-1)!.promise; }
  async cancel(handle: RuntimeHandle, reason: string) {
    this.cancellations.push(`${handle.id}:${reason}`);
    return { accepted: true };
  }
}

class DelayedStartRuntime implements RuntimeAdapter {
  readonly id = "delayed-start";
  readonly startEntered = deferred<void>();
  readonly releaseHandle = deferred<void>();
  readonly result = deferred<RuntimeResult>();
  readonly starts: ExecutionSpec[] = [];
  readonly cancellations: string[] = [];
  readonly timeoutUpdates: number[] = [];
  handleStartedAt: number | undefined;

  constructor(private readonly now: () => number) {}
  describe() { return { id: this.id, displayName: "Delayed start", defaultTimeoutMs: 1_000 }; }
  validate() { return { ok: true, errors: [] }; }
  async start(spec: ExecutionSpec): Promise<RuntimeHandle> {
    this.starts.push(spec);
    this.handleStartedAt = this.now();
    this.startEntered.resolve();
    await this.releaseHandle.promise;
    return {
      id: "handle-delayed",
      pid: 10_001,
      startedAt: this.handleStartedAt,
      isAlive: () => true,
      updateTimeout: (timeoutMs) => { this.timeoutUpdates.push(timeoutMs); },
    };
  }
  wait(): Promise<RuntimeResult> { return this.result.promise; }
  async cancel(handle: RuntimeHandle, reason: string) {
    this.cancellations.push(`${handle.id}:${reason}`);
    return { accepted: true };
  }
}

function success(stdout = "ok"): RuntimeResult {
  return { status: "success", stdout, stderr: "", exitCode: 0, diagnostics: [], identity: { adapterId: "controlled", evidence: "none" } };
}

function failure(error = "transient"): RuntimeResult {
  return { status: "failure", stdout: "", stderr: error, exitCode: 1, error, diagnostics: [], identity: { adapterId: "controlled", evidence: "none" } };
}

function timeout(): RuntimeResult {
  return { status: "timeout", stdout: "", stderr: "", exitCode: null, diagnostics: [], identity: { adapterId: "controlled", evidence: "none" } };
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

test("durable fleet timeout cancels lifecycle authority and its owned runtime handle", async () => {
  const temp = withTempDb();
  try {
    let now = 1_000;
    const contained: number[] = [];
    const runtime = new ControlledRuntime(() => now);
    const coordinator = new LifecycleExecutionCoordinator(runtime, {
      ownerId: "owner-timeout",
      now: () => now,
      terminatePid: (pid) => { contained.push(pid); },
    });
    coordinator.createFleet("fleet-timeout", [{
      fleetId: "fleet-timeout", agentId: "agent-timeout", role: "worker", prompt: "work",
    }]);
    await waitUntil(() => runtime.starts.length === 1, "durable timeout runtime start");
    // Gate #1 (t_db8af59c, 2026-08-26): setFleetTimeout clamps sub-floor
    // values up to MIN_PER_WORKER_BUDGET_MS (1s). The original test used
    // 100ms; the clamping rewrite keeps the intent — reaping at deadline —
    // but bumps the timing to cross the clamped 1000ms deadline.
    setFleetTimeout("fleet-timeout", 100);

    now = 2_100;
    const expired = coordinator.expireFleetTimeout("fleet-timeout", now);
    assert.deepEqual(expired.map((agent) => agent.agent_id), ["agent-timeout"]);
    assert.equal(new LifecycleStore().getState("agent-timeout")?.work.status, "cancelled");
    assert.equal(loadData().agents["agent-timeout"].status, "failed");
    assert.match(loadData().agents["agent-timeout"].error ?? "", /fleet timeout.*1000ms/i);
    assert.equal(loadData().fleets["fleet-timeout"].status, "failed");
    assert.deepEqual(runtime.cancellations, ["handle-1:Fleet timeout exceeded after 1000ms"]);
    assert.deepEqual(contained, [], "an exact owned handle must not also take the PID fallback");
    coordinator.stop();
  } finally {
    temp.cleanup();
  }
});

test("durable fleet timeout contains the current PID when its local handle is stale", async () => {
  const temp = withTempDb();
  try {
    let now = 1_000;
    const containedByStaleOwner: number[] = [];
    const staleRuntime = new ControlledRuntime(() => now, 10_000);
    const staleOwner = new LifecycleExecutionCoordinator(staleRuntime, {
      ownerId: "owner-stale-handle",
      now: () => now,
      leaseMs: 10_000,
      retryBaseMs: 0,
      maxAttempts: 2,
      terminatePid: (pid) => { containedByStaleOwner.push(pid); },
    });
    staleOwner.createFleet("fleet-stale-handle", [{
      fleetId: "fleet-stale-handle",
      agentId: "agent-stale-handle",
      role: "worker",
      prompt: "work",
    }]);
    await waitUntil(() => staleRuntime.results.length === 1, "stale durable handle start");

    now = 11_001;
    const replacementRuntime = new ControlledRuntime(() => now, 20_001);
    const replacementOwner = new LifecycleExecutionCoordinator(replacementRuntime, {
      ownerId: "owner-current-handle",
      now: () => now,
      leaseMs: 10_000,
      retryBaseMs: 0,
      maxAttempts: 2,
      terminatePid: () => {},
    });
    replacementOwner.recover();
    await waitUntil(() => replacementRuntime.results.length === 1, "replacement durable handle start");
    assert.equal(loadData().agents["agent-stale-handle"].pid, 20_002);
    // Gate #1 (t_db8af59c, 2026-08-26): setFleetTimeout clamps sub-floor
    // values up to MIN_PER_WORKER_BUDGET_MS (1s); bump the reap clock to
    // cross the clamped 1000ms deadline instead of the original 100ms.
    setFleetTimeout("fleet-stale-handle", 100);

    now = 12_101;
    const expired = staleOwner.expireFleetTimeout("fleet-stale-handle", now);
    assert.deepEqual(expired.map((agent) => agent.agent_id), ["agent-stale-handle"]);
    assert.equal(new LifecycleStore().getState("agent-stale-handle")?.work.status, "cancelled");
    assert.equal(loadData().agents["agent-stale-handle"].status, "failed");
    assert.deepEqual(containedByStaleOwner, [20_002], "the current attempt PID remains authoritative");
    assert.deepEqual(
      staleRuntime.cancellations,
      ["handle-1:stale durable handle after fleet timeout"],
      "the stale local handle is cleaned without suppressing current containment",
    );
    replacementOwner.stop();
    staleOwner.stop();
  } finally {
    temp.cleanup();
  }
});

test("durable fleet timeout contains a recorded PID after local handles are lost", async () => {
  const temp = withTempDb();
  try {
    let now = 1_000;
    const contained: number[] = [];
    const runtime = new ControlledRuntime(() => now);
    const coordinator = new LifecycleExecutionCoordinator(runtime, {
      ownerId: "owner-timeout-restart",
      now: () => now,
      terminatePid: (pid) => { contained.push(pid); },
    });
    coordinator.createFleet("fleet-timeout-restart", [{
      fleetId: "fleet-timeout-restart", agentId: "agent-timeout-restart", role: "worker", prompt: "work",
    }]);
    await waitUntil(() => runtime.starts.length === 1, "durable restart timeout runtime start");
    // Gate #1 (t_db8af59c, 2026-08-26): setFleetTimeout clamps sub-floor
    // values up to MIN_PER_WORKER_BUDGET_MS (1s); bump the reap clock past
    // the clamped 1000ms deadline.
    setFleetTimeout("fleet-timeout-restart", 100);

    coordinator.stop();
    runtime.cancellations.length = 0;
    now = 2_100;
    const expired = coordinator.expireFleetTimeout("fleet-timeout-restart", now);

    assert.deepEqual(expired.map((agent) => agent.agent_id), ["agent-timeout-restart"]);
    assert.deepEqual(contained, [10_001]);
    assert.deepEqual(runtime.cancellations, []);
  } finally {
    temp.cleanup();
  }
});

test("durable recovery expires an offline fleet deadline before reclaiming its lease", async () => {
  const temp = withTempDb();
  try {
    let now = 1_000;
    const firstRuntime = new ControlledRuntime(() => now);
    const first = new LifecycleExecutionCoordinator(firstRuntime, {
      ownerId: "owner-offline-first",
      now: () => now,
      leaseMs: 50,
      retryBaseMs: 0,
    });
    first.createFleet("fleet-offline-timeout", [{
      fleetId: "fleet-offline-timeout",
      agentId: "agent-offline-timeout",
      role: "worker",
      prompt: "work",
    }]);
    await waitUntil(() => firstRuntime.starts.length === 1, "offline timeout runtime start");
    // Gate #1 (t_db8af59c, 2026-08-26): setFleetTimeout clamps sub-floor
    // values up to MIN_PER_WORKER_BUDGET_MS (1s); bump the reap clock past
    // the clamped 1000ms deadline and update the assertion message.
    setFleetTimeout("fleet-offline-timeout", 50);
    first.stop();
    firstRuntime.cancellations.length = 0;

    now = 2_100;
    const contained: number[] = [];
    const recoveredRuntime = new ControlledRuntime(() => now);
    const recovered = new LifecycleExecutionCoordinator(recoveredRuntime, {
      ownerId: "owner-offline-second",
      now: () => now,
      leaseMs: 50,
      retryBaseMs: 0,
      terminatePid: (pid) => { contained.push(pid); },
    });
    recovered.recover();

    assert.equal(new LifecycleStore().getState("agent-offline-timeout")?.work.status, "cancelled");
    assert.equal(loadData().agents["agent-offline-timeout"].status, "failed");
    assert.match(loadData().agents["agent-offline-timeout"].error ?? "", /fleet timeout.*1000ms/i);
    assert.equal(loadData().fleets["fleet-offline-timeout"].status, "failed");
    assert.equal(recoveredRuntime.starts.length, 0, "an elapsed deadline must not spend retry budget");
    assert.deepEqual(contained, [10_001], "offline runtime containment has exactly one owner");
    assert.equal(
      readEventLog().some((event) => event.event === "agent_retry_scheduled"),
      false,
      "deadline expiry wins before lease recovery can schedule a retry",
    );
    recovered.stop();
  } finally {
    temp.cleanup();
  }
});

test("durable runtime timeout settles as the configured fleet timeout without retry", async () => {
  const temp = withTempDb();
  try {
    let now = 1_000;
    const runtime = new ControlledRuntime(() => now);
    const coordinator = new LifecycleExecutionCoordinator(runtime, {
      ownerId: "owner-runtime-timeout",
      now: () => now,
      retryBaseMs: 0,
    });
    coordinator.createFleet("fleet-runtime-timeout", [{
      fleetId: "fleet-runtime-timeout", agentId: "agent-runtime-timeout", role: "worker", prompt: "work",
    }]);
    await waitUntil(() => runtime.results.length === 1, "durable runtime timeout start");
    // Gate #1 (t_db8af59c, 2026-08-26): setFleetTimeout clamps sub-floor
    // values up to MIN_PER_WORKER_BUDGET_MS (1s); the runtime settles its
    // own timer at this budget. The settlement path doesn't depend on the
    // budget number — `runtime.results[0].resolve(timeout())` triggers it
    // by hand — so we leave the rest of the assertions as-is.
    setFleetTimeout("fleet-runtime-timeout", 100);

    now = 1_100;
    runtime.results[0].resolve(timeout());
    await waitUntil(() => loadData().agents["agent-runtime-timeout"].status !== "running", "durable runtime timeout settlement");

    assert.equal(loadData().agents["agent-runtime-timeout"].status, "failed");
    assert.match(loadData().agents["agent-runtime-timeout"].error ?? "", /runtime timeout/i);
    assert.equal(loadData().fleets["fleet-runtime-timeout"].status, "failed");
    assert.equal(runtime.starts.length, 1, "fleet timeout must not spend retry budget");
    coordinator.stop();
  } finally {
    temp.cleanup();
  }
});

test("durable runtime timeout uses handle start time, not later ledger observation, and never retries", async () => {
  const temp = withTempDb();
  const previousTimeout = process.env.MESHFLEET_AGENT_TIMEOUT_MS;
  try {
    process.env.MESHFLEET_AGENT_TIMEOUT_MS = "100";
    let now = 1_000;
    const runtime = new DelayedStartRuntime(() => now);
    const coordinator = new LifecycleExecutionCoordinator(runtime, {
      ownerId: "owner-delayed-timeout",
      now: () => now,
      retryBaseMs: 60_000,
      maxAttempts: 2,
    });
    coordinator.createFleet("fleet-delayed-timeout", [{
      fleetId: "fleet-delayed-timeout",
      agentId: "agent-delayed-timeout",
      role: "worker",
      prompt: "work",
    }]);
    await runtime.startEntered.promise;
    // Gate #1 (t_db8af59c, 2026-08-26): the env override path also clamps
    // up to MIN_PER_WORKER_BUDGET_MS, so the runtime was told 1000 not 100.
    assert.equal(runtime.starts[0]?.timeoutMs, 1_000);
    assert.equal(runtime.handleStartedAt, 1_000);
    // setFleetTimeout clamps the same way; the original 200ms becomes 1000ms.
    setFleetTimeout("fleet-delayed-timeout", 200);

    now = 1_050;
    runtime.releaseHandle.resolve();
    await waitUntil(
      () => loadData().agents["agent-delayed-timeout"].status === "running",
      "delayed durable handle observation",
    ).catch((error) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; agent=${JSON.stringify(loadData().agents["agent-delayed-timeout"])}; lifecycle=${JSON.stringify(new LifecycleStore().getState("agent-delayed-timeout"))}`);
    });
    assert.equal(loadData().agents["agent-delayed-timeout"].started_at, 1_000);
    assert.deepEqual(runtime.timeoutUpdates, [1_000], "pending-start timeout changes re-arm the observed handle with the clamped budget");

    now = 1_200;
    // The runtime's 200ms timer has already fired. A late extension cannot
    // revoke that terminal request while process shutdown is still settling.
    setFleetTimeout("fleet-delayed-timeout", 1_000);
    runtime.result.resolve(timeout());
    await waitUntil(
      () => new LifecycleStore().getState("agent-delayed-timeout")?.work.status !== "running",
      "delayed durable timeout settlement",
    );

    const state = new LifecycleStore().getState("agent-delayed-timeout")!;
    assert.equal(state.work.status, "cancelled");
    assert.equal(state.attempts.length, 1);
    assert.equal(loadData().agents["agent-delayed-timeout"].status, "failed");
    assert.match(loadData().agents["agent-delayed-timeout"].error ?? "", /runtime timeout/i);
    assert.equal(loadData().fleets["fleet-delayed-timeout"].status, "failed");
    assert.equal(runtime.starts.length, 1);
    assert.equal(readEventLog().some((event) => event.event === "agent_retry_scheduled"), false);
    coordinator.stop();
  } finally {
    if (previousTimeout === undefined) delete process.env.MESHFLEET_AGENT_TIMEOUT_MS;
    else process.env.MESHFLEET_AGENT_TIMEOUT_MS = previousTimeout;
    temp.cleanup();
  }
});

test("stale durable runtime timeout cannot cancel a replacement attempt", async () => {
  const temp = withTempDb();
  try {
    let now = 1_000;
    const runtime = new ControlledRuntime(() => now);
    const coordinator = new LifecycleExecutionCoordinator(runtime, {
      ownerId: "owner-stale-timeout",
      now: () => now,
      leaseMs: 100,
      retryBaseMs: 0,
      maxAttempts: 2,
      terminatePid: () => {},
    });
    coordinator.createFleet("fleet-stale-timeout", [{
      fleetId: "fleet-stale-timeout",
      agentId: "agent-stale-timeout",
      role: "worker",
      prompt: "work",
    }]);
    await waitUntil(() => runtime.results.length === 1, "original durable runtime start");

    now = 1_101;
    coordinator.recover();
    await waitUntil(() => runtime.results.length === 2, "replacement durable runtime start");
    const before = new LifecycleStore().getState("agent-stale-timeout")!;
    assert.equal(before.work.status, "running");
    assert.equal(before.attempts.length, 2);
    const replacement = before.attempts.find((attempt) => attempt.attempt_id === before.work.current_attempt_id)!;
    const leaseBeforeStaleTimeout = replacement.lease_until!;
    const cancellationsBeforeStaleTimeout = [...runtime.cancellations];

    now = 1_150;
    runtime.results[0].resolve(timeout());
    await new Promise((done) => setImmediate(done));

    const after = new LifecycleStore().getState("agent-stale-timeout")!;
    assert.equal(after.work.status, "running");
    assert.equal(after.work.current_attempt_id, before.work.current_attempt_id);
    assert.equal(after.attempts.length, 2);
    assert.equal(loadData().agents["agent-stale-timeout"].status, "running");
    assert.equal(runtime.starts.length, 2);
    assert.equal(
      readEventLog().some((event) => event.event === "agent_fleet_timeout" && event.agent_id === "agent-stale-timeout"),
      false,
    );
    await waitUntil(() => {
      const state = new LifecycleStore().getState("agent-stale-timeout")!;
      const current = state.attempts.find((attempt) => attempt.attempt_id === state.work.current_attempt_id);
      return (current?.lease_until ?? 0) > leaseBeforeStaleTimeout;
    }, "replacement lease renewal after stale timeout", 500);
    assert.deepEqual(runtime.cancellations, cancellationsBeforeStaleTimeout, "stale timeout does not cancel the replacement");
    coordinator.stop();
  } finally {
    temp.cleanup();
  }
});

test("durable runtime timeout cannot terminalize an expired lease before recovery", async () => {
  const temp = withTempDb();
  try {
    let now = 1_000;
    const expiredRuntime = new ControlledRuntime(() => now);
    const expiredOwner = new LifecycleExecutionCoordinator(expiredRuntime, {
      ownerId: "owner-expired-timeout",
      now: () => now,
      leaseMs: 100,
      retryBaseMs: 0,
      maxAttempts: 2,
    });
    expiredOwner.createFleet("fleet-expired-timeout", [{
      fleetId: "fleet-expired-timeout",
      agentId: "agent-expired-timeout",
      role: "worker",
      prompt: "work",
    }]);
    await waitUntil(() => expiredRuntime.results.length === 1, "expiring durable runtime start");

    now = 1_100;
    expiredRuntime.results[0].resolve(timeout());
    await new Promise((done) => setImmediate(done));
    assert.equal(new LifecycleStore().getState("agent-expired-timeout")?.work.status, "running");
    assert.equal(loadData().agents["agent-expired-timeout"].status, "running");
    assert.equal(
      readEventLog().some((event) => event.event === "agent_fleet_timeout" && event.agent_id === "agent-expired-timeout"),
      false,
    );

    const recoveredRuntime = new ControlledRuntime(() => now);
    const recovered = new LifecycleExecutionCoordinator(recoveredRuntime, {
      ownerId: "owner-expired-timeout-recovery",
      now: () => now,
      leaseMs: 1_000,
      retryBaseMs: 0,
      maxAttempts: 2,
      terminatePid: () => {},
    });
    recovered.recover();
    await waitUntil(() => recoveredRuntime.results.length === 1, "expired lease recovery runtime start");
    const recoveredState = new LifecycleStore().getState("agent-expired-timeout")!;
    assert.equal(recoveredState.work.status, "running");
    assert.equal(recoveredState.attempts.length, 2);
    assert.equal(loadData().agents["agent-expired-timeout"].status, "running");
    assert.deepEqual(expiredRuntime.cancellations, [], "expired timeout callback only forgets its already-terminal handle");
    expiredOwner.stop();
    assert.deepEqual(expiredRuntime.cancellations, []);
    recovered.stop();
  } finally {
    temp.cleanup();
  }
});

test("durable runtime start anchors reject invalid or future handle timestamps", async () => {
  for (const invalidStartedAt of [Number.NaN, 1_051]) {
    const temp = withTempDb();
    try {
      let now = 1_000;
      const runtime = new DelayedStartRuntime(() => now);
      const coordinator = new LifecycleExecutionCoordinator(runtime, {
        ownerId: `owner-invalid-start-${String(invalidStartedAt)}`,
        now: () => now,
      });
      coordinator.createFleet("fleet-invalid-start", [{
        fleetId: "fleet-invalid-start",
        agentId: "agent-invalid-start",
        role: "worker",
        prompt: "work",
      }]);
      await runtime.startEntered.promise;
      runtime.handleStartedAt = invalidStartedAt;
      now = 1_050;
      runtime.releaseHandle.resolve();
      await waitUntil(
        () => loadData().agents["agent-invalid-start"].status === "running",
        "invalid durable start fallback",
      );
      assert.equal(loadData().agents["agent-invalid-start"].started_at, 1_000);
      coordinator.stop();
    } finally {
      temp.cleanup();
    }
  }
});

test("durable success stores bounded diagnostics separately from error", async () => {
  const temp = withTempDb();
  try {
    const runtime = new ControlledRuntime();
    const coordinator = new LifecycleExecutionCoordinator(runtime, { ownerId: "owner-diagnostics", retryBaseMs: 0 });
    coordinator.createFleet("fleet-diagnostics", [{
      fleetId: "fleet-diagnostics",
      agentId: "agent-diagnostics",
      role: "worker",
      prompt: "work",
    }]);
    await waitUntil(() => runtime.results.length === 1, "durable runtime start");
    runtime.results[0].resolve({
      ...success("completed"),
      stderr: "raw tool transcript that must not persist",
      diagnostics: [{ severity: "warning", message: "token=warning-secret retrying" }],
    });
    await waitUntil(() => loadData().agents["agent-diagnostics"].status === "complete", "durable settlement");
    const agent = loadData().agents["agent-diagnostics"];
    assert.equal(agent.error, undefined);
    assert.deepEqual(agent.diagnostics, [{ severity: "warning", message: "token=[redacted] retrying" }]);
    assert.ok(!JSON.stringify(agent).includes("raw tool transcript"));
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
    const runtime1 = new ControlledRuntime(() => now);
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

    const runtime2 = new ControlledRuntime(() => now);
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
