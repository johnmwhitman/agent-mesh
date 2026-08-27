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

test("ENFORCE: done with no artifacts is recorded artifact_missing and banks failed; naming a real file is ok and banks complete", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mf-expects-artifact-"));
  const realFile = join(dir, "report.md");
  writeFileSync(realFile, "the report");
  const temp = withTempDb();
  try {
    const missing = await runAgent("owner-artifact-missing", true, (path) => writeFileSync(path, doneEnvelope()));
    assert.equal(missing.agent.result_contract, "artifact_missing", "a done that names nothing is not ok");
    // 🔴 The flip: release N banked `complete` here on the declared-output miss; this release
    // banks `failed`. The artifact was required by the caller (`expects_artifact: true`),
    // the agent knew it, and the agent still declared `done` with nothing produced — the
    // caller can no longer trust the row's `complete`, so it cannot claim it.
    assert.equal(missing.agent.status, "failed", "ENFORCE: artifact_missing banks failed, not complete");
    assert.ok(
      missing.agent.error?.includes("result_contract=artifact_missing"),
      `the row's error names the recorded contract value, got ${JSON.stringify(missing.agent.error)}`,
    );

    const ok = await runAgent("owner-artifact-ok", true, (path) => writeFileSync(path, doneEnvelope([realFile])));
    assert.equal(ok.agent.result_contract, "ok", "naming a file that exists satisfies the declared expectation");
    assert.equal(ok.agent.status, "complete", "ok with artifacts present still banks complete");

    const unflagged = await runAgent("owner-artifact-unflagged", false, (path) => writeFileSync(path, doneEnvelope()));
    assert.equal(unflagged.agent.result_contract, "ok", "no declared expectation, no artifact demand — unchanged behaviour");
    assert.equal(unflagged.agent.status, "complete", "ok without artifacts and no expectation still banks complete");
  } finally {
    temp.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
