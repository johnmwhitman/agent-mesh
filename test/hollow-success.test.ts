// A runtime that exits 0 having emitted NO final answer must not be banked as
// success. Observed 2026-08-01 on a real fleet: an agent read five files, never
// produced its deliverable, exited 0, and was sealed `complete` with a one-line
// preamble as its entire output. `collect_results` then returned that to the
// orchestrator, where an empty/stub result is indistinguishable from a real one.
//
// That is the overclaim verify.ts already forbids — `complete` must never "claim
// work that never happened" — arriving through the one door nothing checked: the
// process exit code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LifecycleExecutionCoordinator } from "../src/lifecycle-execution.js";
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

/** Exit 0, but the model never emitted a final answer. */
function hollowSuccess(stdout = ""): RuntimeResult {
  return { status: "success", stdout, stderr: "", exitCode: 0, diagnostics: [], identity: { adapterId: "controlled", evidence: "none" } };
}

function realSuccess(stdout = "the deliverable"): RuntimeResult {
  // Release N+1 (2026-08-19 → enforce): a successful runtime exit 0 must be paired with
  // `resultContract: "ok"` to bank `complete`. The CONTROL tests prove "a real answer still
  // completes normally" — the cleanest way to assert THAT is to bypass the filesystem read
  // and pass the contract value in the runtime result, so the test exercises only the
  // banking decision, not the contract ladder. The ladder's own coverage is in
  // test/result-contract.test.ts.
  return {
    status: "success", stdout, stderr: "", exitCode: 0, diagnostics: [],
    identity: { adapterId: "controlled", evidence: "none" },
    resultContract: "ok",
  };
}

async function settleOnce(result: RuntimeResult, until?: (runtime: ControlledRuntime) => boolean) {
  const runtime = new ControlledRuntime();
  const coordinator = new LifecycleExecutionCoordinator(runtime, { ownerId: "owner-hollow", retryBaseMs: 0 });
  coordinator.createFleet("fleet-h", [{ fleetId: "fleet-h", agentId: "agent-h", role: "worker", prompt: "produce the thing" }]);
  await new Promise((done) => setImmediate(done));
  runtime.results[0].resolve(result);
  await new Promise((done) => setImmediate(done));
  // The retry relaunch rides a TIMER (scheduleDue with retryBaseMs 0 is still a macrotask),
  // so a microtask tick alone stops the coordinator before the second attempt can launch —
  // which made the relaunch assertion fail against CORRECT source. Wait on observable state
  // with a ceiling, per this repo's own wait law; callers that expect no retry pass no
  // predicate and take the fast path.
  if (until) {
    const deadline = Date.now() + 2_000;
    while (!until(runtime) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 10));
    }
  }
  const data = loadData();
  const agent = data.agents["agent-h"];
  coordinator.stop();
  return { agent, events: readEventLog(), starts: runtime.starts.length };
}

test("exit 0 with EMPTY output is not banked as success", async () => {
  const temp = withTempDb();
  try {
    const { agent, events } = await settleOnce(hollowSuccess(""));
    assert.notEqual(agent.status, "complete",
      "an agent that produced nothing must not be sealed `complete` — that claims work that never happened");
  } finally {
    temp.cleanup();
  }
});

test("exit 0 with WHITESPACE-ONLY output is not banked as success", async () => {
  const temp = withTempDb();
  try {
    const { agent } = await settleOnce(hollowSuccess("\n  \t\n"));
    assert.notEqual(agent.status, "complete",
      "whitespace is not a deliverable; trim() before judging emptiness");
  } finally {
    temp.cleanup();
  }
});

test("a hollow success is RETRIED, not banked — the remedy actually fires", async () => {
  const temp = withTempDb();
  try {
    const { agent, events, starts } = await settleOnce(hollowSuccess(""), (runtime) => runtime.starts.length >= 2);
    // The point of refusing to bank an empty result is that the work gets
    // ANOTHER shot. Assert the observable remedy — a retry was scheduled and a
    // fresh attempt launched — rather than the reason string, which this store
    // deliberately keeps on the attempt record (not on `work`) while pending.
    const kinds = events.map((e) => e.event);
    assert.ok(kinds.includes("agent_retry_scheduled"),
      `hollow success must schedule a retry; saw ${JSON.stringify(kinds)}`);
    // Assert the relaunch on the RUNTIME's own start count — the same observable the wait
    // predicate used. The first version asserted on agent_launch_intended EVENTS, which ride
    // the NDJSON outbox and flush later; on a fast runner the second event legitimately had
    // not landed yet and the test failed against correct behavior (Node 22/macos, 15ms run).
    // Waiting on one observable and asserting on a laggier one is just the same race moved.
    assert.ok(starts >= 2,
      "a second attempt must actually launch, not just be recorded as scheduled");
    assert.notEqual(agent.status, "complete");
  } finally {
    temp.cleanup();
  }
});

test("CONTROL: a real answer still completes normally (the fix must not eat good runs)", async () => {
  const temp = withTempDb();
  try {
    const { agent } = await settleOnce(realSuccess("the deliverable"));
    assert.equal(agent.status, "complete");
    assert.equal(agent.output, "the deliverable");
  } finally {
    temp.cleanup();
  }
});

test("CONTROL: a single space of real content is enough — we judge emptiness, not quality", async () => {
  const temp = withTempDb();
  try {
    // Deliberate boundary: this guard must never become a prose-quality judge.
    // Anything non-blank is the agent's answer, however short.
    const { agent } = await settleOnce(realSuccess("x"));
    assert.equal(agent.status, "complete");
  } finally {
    temp.cleanup();
  }
});
