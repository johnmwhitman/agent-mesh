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
import { loadData } from "../src/core.js";
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
  return { status: "success", stdout, stderr: "", exitCode: 0, diagnostics: [], identity: { adapterId: "controlled", evidence: "none" } };
}

async function settleOnce(result: RuntimeResult) {
  const runtime = new ControlledRuntime();
  const coordinator = new LifecycleExecutionCoordinator(runtime, { ownerId: "owner-hollow", retryBaseMs: 0 });
  coordinator.createFleet("fleet-h", [{ fleetId: "fleet-h", agentId: "agent-h", role: "worker", prompt: "produce the thing" }]);
  await new Promise((done) => setImmediate(done));
  runtime.results[0].resolve(result);
  await new Promise((done) => setImmediate(done));
  const agent = loadData().agents["agent-h"];
  coordinator.stop();
  return agent;
}

test("exit 0 with EMPTY output is not banked as success", async () => {
  const temp = withTempDb();
  try {
    const agent = await settleOnce(hollowSuccess(""));
    assert.notEqual(agent.status, "complete",
      "an agent that produced nothing must not be sealed `complete` — that claims work that never happened");
  } finally {
    temp.cleanup();
  }
});

test("exit 0 with WHITESPACE-ONLY output is not banked as success", async () => {
  const temp = withTempDb();
  try {
    const agent = await settleOnce(hollowSuccess("\n  \t\n"));
    assert.notEqual(agent.status, "complete",
      "whitespace is not a deliverable; trim() before judging emptiness");
  } finally {
    temp.cleanup();
  }
});

test("the hollow-success verdict says WHY, so an orchestrator can reroute", async () => {
  const temp = withTempDb();
  try {
    const agent = await settleOnce(hollowSuccess(""));
    assert.match(String(agent.error ?? ""), /produced no output/i,
      "the recorded error must name the actual cause, not a generic failure");
  } finally {
    temp.cleanup();
  }
});

test("CONTROL: a real answer still completes normally (the fix must not eat good runs)", async () => {
  const temp = withTempDb();
  try {
    const agent = await settleOnce(realSuccess("the deliverable"));
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
    const agent = await settleOnce(realSuccess("x"));
    assert.equal(agent.status, "complete");
  } finally {
    temp.cleanup();
  }
});
