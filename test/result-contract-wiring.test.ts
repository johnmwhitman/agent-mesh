/**
 * The durable agentic-runtime wiring proof: each spawn is TAUGHT the file contract, and what it
 * declares is RECORDED — while this release still banks status exactly as it did before.
 *
 * Both halves matter. Teaching without recording gives an adoption figure nobody can read;
 * recording without teaching measures a contract no agent was ever shown. And the observe-only
 * half has to be asserted explicitly, or the next release's enforcement lands with nobody able to
 * tell which behaviour changed when.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifecycleExecutionCoordinator } from "../src/lifecycle-execution.js";
import { loadData } from "../src/core.js";
import { RESULT_CONTRACT_SCHEMA } from "../src/result-contract.js";
import type { ExecutionSpec, RuntimeAdapter, RuntimeHandle, RuntimeResult } from "../src/runtime/types.js";
import { withTempDb } from "./helpers/with-temp-db.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Writes whatever the test tells it to write to the path the spec handed it, then exits 0. */
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
  declare: (resultPath: string) => void,
): Promise<{ agent: ReturnType<typeof loadData>["agents"][string]; spec: ExecutionSpec }> {
  const runtime = new DeclaringRuntime(declare);
  const coordinator = new LifecycleExecutionCoordinator(runtime, { ownerId, retryBaseMs: 0 });
  const fleetId = `fleet-${ownerId}`;
  const agentId = `agent-${ownerId}`;
  coordinator.createFleet(fleetId, [{ fleetId, agentId, role: "worker", prompt: "audit the thing" }]);
  await new Promise((done) => setImmediate(done));
  runtime.results[0].resolve(success("here is the audit"));
  await new Promise((done) => setImmediate(done));
  coordinator.stop();
  return { agent: loadData().agents[agentId], spec: runtime.starts[0] };
}

test("every durable agentic spawn is taught the file contract in environment and prompt", async () => {
  const temp = withTempDb();
  try {
    const { agent, spec } = await runAgent("owner-taught", () => {});
    const injected = spec.environment?.RESULT_PATH;
    assert.ok(injected && injected.length > 0, "the child must be handed a RESULT_PATH");
    assert.ok(spec.prompt.includes(injected!), "the path must be inlined — agents routinely never read env");
    assert.ok(spec.prompt.includes(RESULT_CONTRACT_SCHEMA));
    assert.ok(spec.prompt.startsWith("audit the thing"), "the caller's prompt survives verbatim, first");
    assert.equal(agent.prompt, "audit the thing", "the stored row keeps the caller's text, not the runtime's");
  } finally {
    temp.cleanup();
  }
});

test("a valid done envelope is recorded as result_contract ok", async () => {
  const temp = withTempDb();
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-wiring-"));
  try {
    const { agent } = await runAgent("owner-ok", (path) => {
      writeFileSync(path, JSON.stringify({ schema: RESULT_CONTRACT_SCHEMA, outcome: "done", summary: "audited" }));
    });
    assert.equal(agent.result_contract, "ok");
    assert.equal(agent.status, "complete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    temp.cleanup();
  }
});

test("OBSERVE-ONLY → ENFORCE: a refusal is recorded, and this release banks failed", async () => {
  const temp = withTempDb();
  try {
    const { agent } = await runAgent("owner-refused", (path) => {
      writeFileSync(path, JSON.stringify({
        schema: RESULT_CONTRACT_SCHEMA,
        outcome: "refused",
        summary: "could not do the work",
        reason: "the target path does not exist in this workspace",
      }));
    });
    assert.equal(agent.result_contract, "refused");
    // 🔴 The single line that flipped between release N (observe-only) and release N+1
    // (enforce): a non-`ok` contract from a runtime exit 0 seals `failed`, not `complete`.
    // Refusal is the agent's chosen outcome — banked honestly so a caller asking
    // `agent.status === "complete" && agent.result_contract === "ok"` (the contract that
    // release N published) now holds by construction, without a caller-side post-filter.
    assert.equal(agent.status, "failed", "this release enforces: refused banks failed");
    assert.ok(
      agent.error?.includes("result_contract=refused"),
      `the row's error names the recorded contract value, got ${JSON.stringify(agent.error)}`,
    );
  } finally {
    temp.cleanup();
  }
});

test("ENFORCE: an agent that writes nothing is recorded as absent and banks failed", async () => {
  const temp = withTempDb();
  try {
    const { agent } = await runAgent("owner-absent", () => {});
    assert.equal(agent.result_contract, "absent");
    // 🔴 The deliberate-'invalid'/'absent' proof the card acceptance demands. The agent
    // exited 0 having written no envelope; release N would bank `complete` here, this
    // release banks `failed`. The runtime was never asked to retry — a contract failure
    // is the agent's final word, not a transient runtime fault.
    assert.equal(agent.status, "failed", "this release enforces: absent banks failed");
    assert.ok(
      agent.error?.includes("result_contract=absent"),
      `the row's error names the recorded contract value, got ${JSON.stringify(agent.error)}`,
    );
  } finally {
    temp.cleanup();
  }
});

test("ENFORCE: a deliberately invalid envelope (not JSON at all) is recorded as invalid and banks failed", async () => {
  const temp = withTempDb();
  try {
    const { agent } = await runAgent("owner-invalid", (path) => {
      // Bytes that are syntactically present and structurally unparseable. Same shape
      // as a runtime that wrote a partial file or its model output leaked into the path.
      writeFileSync(path, "{not valid json at all");
    });
    assert.equal(agent.result_contract, "invalid");
    assert.equal(agent.status, "failed", "this release enforces: invalid banks failed");
    assert.ok(
      agent.error?.includes("result_contract=invalid"),
      `the row's error names the recorded contract value, got ${JSON.stringify(agent.error)}`,
    );
  } finally {
    temp.cleanup();
  }
});

test("a retry never inherits the previous attempt's declaration: one path per attempt", async () => {
  const temp = withTempDb();
  try {
    const seen: string[] = [];
    const runtime = new DeclaringRuntime((path) => { seen.push(path); });
    const coordinator = new LifecycleExecutionCoordinator(runtime, { ownerId: "owner-retry", retryBaseMs: 0 });
    coordinator.createFleet("fleet-retry", [{ fleetId: "fleet-retry", agentId: "agent-retry", role: "worker", prompt: "work" }]);
    await new Promise((done) => setImmediate(done));
    runtime.results[0].resolve({ status: "failure", stdout: "", stderr: "transient", exitCode: 1, error: "transient", diagnostics: [], identity: { adapterId: "declaring", evidence: "none" } });
    // Give the coordinator its retry.
    for (let i = 0; i < 50 && runtime.starts.length < 2; i += 1) {
      await new Promise((done) => setTimeout(done, 5));
    }
    coordinator.stop();
    assert.ok(seen.length >= 2, "the agent must have been launched at least twice");
    assert.notEqual(seen[0], seen[1], "attempt 2 must not read attempt 1's envelope");
  } finally {
    temp.cleanup();
  }
});

test("the sweeper comment no longer describes a catch that is not there", () => {
  // A stale claim in the file whose whole purpose is punishing stale claims. Cheap to assert.
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.equal(source.includes("The catch below"), false);
});
