/**
 * The `expects_artifact` spawn flag, wired end to end.
 *
 * The evaluator has supported `expectsArtifact` since the contract shipped — and nothing set it,
 * so the `artifact_missing` rung of the ladder was unreachable from any published surface. These
 * tests prove the three halves the flag needs to be real:
 *
 *   1. TAUGHT — an agent spawned with the flag is told, in its prompt, that artifacts are
 *      required. An expectation the agent never saw would manufacture artifact_missing out of
 *      honest work.
 *   2. JUDGED — at settle, a valid `done` envelope naming no files is recorded
 *      `artifact_missing`; one naming a real file is recorded `ok`. Still observe-only: status
 *      banks exactly as before.
 *   3. PERSISTED — the flag rides the Agent row, so a durable retry rebuilt from the row is
 *      taught the same contract the first attempt was.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifecycleExecutionCoordinator } from "../src/lifecycle-execution.js";
import { loadData } from "../src/core.js";
import { summarizeCollection } from "../src/collection-summary.js";
import { RESULT_CONTRACT_SCHEMA, resultContractPreamble, withResultContract } from "../src/result-contract.js";
import type { ExecutionSpec, RuntimeAdapter, RuntimeHandle, RuntimeResult } from "../src/runtime/types.js";
import { withTempDb } from "./helpers/with-temp-db.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class DeclaringRuntime implements RuntimeAdapter {
  readonly id = "declaring";
  readonly starts: ExecutionSpec[] = [];
  readonly results: Array<ReturnType<typeof deferred<RuntimeResult>>> = [];
  constructor(private readonly declare: (resultPath: string) => void) {}
  describe() { return { id: this.id, displayName: "Declaring", defaultTimeoutMs: 1_000 }; }
  validate() { return { ok: true, errors: [] }; }
  async start(spec: ExecutionSpec): Promise<RuntimeHandle> {
    this.starts.push(spec);
    this.declare(spec.environment?.RESULT_PATH ?? "");
    this.results.push(deferred<RuntimeResult>());
    return { id: `handle-${this.results.length}`, startedAt: Date.now(), isAlive: () => true };
  }
  wait(): Promise<RuntimeResult> { return this.results.at(-1)!.promise; }
  async cancel() { return { accepted: true }; }
}

function success(stdout = "ok"): RuntimeResult {
  return { status: "success", stdout, stderr: "", exitCode: 0, diagnostics: [], identity: { adapterId: "declaring", evidence: "none" } };
}

async function runAgent(
  ownerId: string,
  expectsArtifact: boolean,
  declare: (resultPath: string) => void,
): Promise<{ agent: ReturnType<typeof loadData>["agents"][string]; spec: ExecutionSpec }> {
  const runtime = new DeclaringRuntime(declare);
  const coordinator = new LifecycleExecutionCoordinator(runtime, { ownerId, retryBaseMs: 0 });
  const fleetId = `fleet-${ownerId}`;
  const agentId = `agent-${ownerId}`;
  coordinator.createFleet(fleetId, [{ fleetId, agentId, role: "worker", prompt: "produce the report", expectsArtifact }]);
  await new Promise((done) => setImmediate(done));
  runtime.results[0].resolve(success("finished"));
  await new Promise((done) => setImmediate(done));
  coordinator.stop();
  return { agent: loadData().agents[agentId], spec: runtime.starts[0] };
}

const doneEnvelope = (artifacts?: string[]) =>
  JSON.stringify({ schema: RESULT_CONTRACT_SCHEMA, outcome: "done", summary: "did it", ...(artifacts ? { artifacts } : {}) });

test("teaching: the flag adds the artifacts-required line, and ONLY when the caller declared it", () => {
  const withFlag = resultContractPreamble("/tmp/p.json", true);
  const without = resultContractPreamble("/tmp/p.json", false);
  const defaulted = resultContractPreamble("/tmp/p.json");
  assert.ok(withFlag.includes("REQUIRES artifacts"), "the expectation must be stated to the agent");
  assert.ok(!without.includes("REQUIRES artifacts"), "teaching it unconditionally trains no-file agents to invent paths");
  assert.equal(defaulted, without, "the default is the old preamble, byte for byte");
  assert.ok(withResultContract("p", "/tmp/p.json", true).includes("REQUIRES artifacts"));
});

test("wired (durable): a spawned agent with the flag is taught it in the prompt it is handed", async () => {
  const temp = withTempDb();
  try {
    const { agent, spec } = await runAgent("owner-artifact-taught", true, () => {});
    assert.ok(spec.prompt.includes("REQUIRES artifacts"), "the runtime prompt carries the expectation");
    assert.equal(agent.prompt, "produce the report", "the stored row keeps the caller's text");
    assert.equal(agent.expects_artifact, true, "the expectation is persisted for retries");
  } finally {
    temp.cleanup();
  }
});

test("judged: done with no artifacts is recorded artifact_missing; naming a real file is ok — status banks as before", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mf-expects-artifact-"));
  const realFile = join(dir, "report.md");
  writeFileSync(realFile, "the report");
  const temp = withTempDb();
  try {
    const missing = await runAgent("owner-artifact-missing", true, (path) => writeFileSync(path, doneEnvelope()));
    assert.equal(missing.agent.result_contract, "artifact_missing", "a done that names nothing is not ok");
    assert.equal(missing.agent.result_artifacts, undefined, "non-ok declarations never retain artifact paths");
    assert.equal(missing.agent.status, "complete", "OBSERVE-ONLY: the recorded value still decides nothing");

    const ok = await runAgent("owner-artifact-ok", true, (path) => writeFileSync(path, doneEnvelope([realFile])));
    assert.equal(ok.agent.result_contract, "ok", "naming a file that exists satisfies the declared expectation");
    assert.deepEqual(ok.agent.result_artifacts, [realFile], "the validated declaration is persisted on the real Agent row");
    assert.equal(summarizeCollection([ok.agent]).contract_conforming, 1, "an artifact-only settled Agent conforms without invented mock fields");

    const unflagged = await runAgent("owner-artifact-unflagged", false, (path) => writeFileSync(path, doneEnvelope()));
    assert.equal(unflagged.agent.result_contract, "ok", "no declared expectation, no artifact demand — unchanged behaviour");
  } finally {
    temp.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
