import assert from "node:assert/strict";
import test from "node:test";

import { LocalDemoRuntimeAdapter } from "../src/runtime/local-demo.js";
import { availableRuntimeIds, getDefaultRuntimeAdapter } from "../src/runtime/registry.js";
import type { ExecutionSpec } from "../src/runtime/types.js";

function spec(overrides: Partial<ExecutionSpec> = {}): ExecutionSpec {
  return {
    fleetId: "demo-fleet",
    agentId: "demo-agent",
    prompt: "Summarize the release notes.",
    cwd: process.cwd(),
    timeoutMs: 30_000,
    ...overrides,
  } as ExecutionSpec;
}

test("local-demo is registered and selectable, and the default runtime is unchanged", () => {
  assert.ok(
    availableRuntimeIds().includes("local-demo"),
    `local-demo must be reachable out of the box; got ${JSON.stringify(availableRuntimeIds())}`,
  );
  assert.equal(getDefaultRuntimeAdapter().id, "opencode-cli", "default stays OpenCode");
});

test("local-demo refuses what it cannot honestly provide", () => {
  const adapter = new LocalDemoRuntimeAdapter();
  const withModel = adapter.validate(spec({ requestedModel: "anthropic/claude" }));
  assert.equal(withModel.ok, false, "a model request must fail: the demo worker has no model");
  assert.ok(withModel.errors.some((e) => /no (AI )?model/i.test(e)));

  const withStdin = adapter.validate(
    spec({ input: { transport: "stdin", bytes: new TextEncoder().encode("stdin payload") } }),
  );
  assert.equal(withStdin.ok, false, "argv-only: stdin must be refused");

  const plain = adapter.validate(spec());
  assert.equal(plain.ok, true, `plain prompt must validate: ${plain.errors.join(", ")}`);
});

test("local-demo runs a real child process and returns an honest deterministic result", async () => {
  const adapter = new LocalDemoRuntimeAdapter();
  const handle = await adapter.start(spec({ prompt: "Count the receipts." }));
  const result = await adapter.wait(handle);

  assert.equal(result.status, "success", result.error ?? result.stderr);
  assert.equal(result.identity.adapterId, "local-demo");
  assert.equal(result.identity.evidence, "none");

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.worker, "local-demo");
  assert.equal(payload.model, null, "the worker must state it has no model");
  assert.match(payload.note, /no AI model/i, "honesty line is load-bearing");
  assert.equal(payload.task_received, "Count the receipts.");
  assert.equal(typeof payload.result, "string");

  // Determinism: same spec, same payload (timestamps deliberately absent).
  const again = await adapter.wait(await adapter.start(spec({ prompt: "Count the receipts." })));
  assert.equal(again.stdout, result.stdout, "identical prompt must produce identical bytes");
});

test("local-demo worker fails loudly on a missing prompt instead of inventing output", async () => {
  const adapter = new LocalDemoRuntimeAdapter();
  const validation = adapter.validate(spec({ prompt: "" }));
  assert.equal(validation.ok, false, "an empty prompt must not validate");
});

test("local-demo is invisible to automatic failover — explicit selection only", () => {
  const adapter = new LocalDemoRuntimeAdapter();
  assert.equal(
    adapter.describe().failoverEligible,
    false,
    "a deterministic echo must never silently replace a failed model-backed agent",
  );
});
