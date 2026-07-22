import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalProcessRuntimeAdapter } from "../src/runtime/local-process.js";
import { OpenCodeRuntimeAdapter } from "../src/runtime/opencode.js";
import {
  RUNTIME_CHILD_STDIO,
  startProcessExecution,
  waitForProcessExecution,
  type RawProcessResult,
} from "../src/runtime/process.js";
import { createDefaultRuntimeRegistry } from "../src/runtime/registry.js";
import type { ExecutionSpec, RuntimeAdapter, RuntimeResult } from "../src/runtime/types.js";

const FIXTURE = join(process.cwd(), "test/fixtures/runtime-process.mjs");

// Signal-behaviour budgets must outlast child startup. A fixture cannot install
// its SIGTERM handler or write its pre-signal marker until Node has finished
// booting (~40ms observed on macOS/arm64); a signal delivered before that point
// kills the child under the default disposition, producing an empty-stdout
// SIGTERM exit that looks like an escalation bug. These budgets keep ~6x margin
// over observed boot so the assertions below exercise behaviour, not a race.
const CHILD_BOOT_BUDGET_MS = 250;
const TERMINATION_GRACE_MS = 100;

function spec(overrides: Partial<ExecutionSpec> = {}): ExecutionSpec {
  return {
    fleetId: "fleet-1",
    agentId: "agent-1",
    prompt: "plain prompt",
    cwd: process.cwd(),
    timeoutMs: 500,
    ...overrides,
  };
}

function local(mode: string): LocalProcessRuntimeAdapter {
  return new LocalProcessRuntimeAdapter({
    command: process.execPath,
    buildArgs: (request) => [FIXTURE, mode, request.prompt],
    terminationGraceMs: TERMINATION_GRACE_MS,
  });
}

async function execute(adapter: RuntimeAdapter, request = spec()) {
  const handle = await adapter.start(request);
  return adapter.wait(handle);
}

test("runtime registry keeps OpenCode as the internal default", () => {
  const registry = createDefaultRuntimeRegistry();
  assert.deepEqual(registry.ids(), ["opencode-cli"]);
  assert.equal(registry.require("opencode-cli").id, "opencode-cli");
  assert.throws(() => registry.require("missing"), /Unknown runtime adapter/);
  assert.throws(() => registry.register(registry.require("opencode-cli")), /already registered/);
});

test("local process adapter normalizes success, failure, empty output, and signal termination", async () => {
  assert.equal((await execute(local("success"))).status, "success");
  const failed = await execute(local("failure"));
  assert.equal(failed.status, "failure");
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.stdout, "partial:plain prompt");
  assert.equal(failed.stderr, "fixture failure");
  assert.equal((await execute(local("empty"))).status, "success");
  const signalled = await execute(local("signal"));
  assert.equal(signalled.status, "failure");
  assert.equal(signalled.signal, "SIGTERM");
});

test("local process adapter owns timeout and AbortSignal cancellation", async () => {
  const timeout = await execute(local("timeout"), spec({ timeoutMs: 25 }));
  assert.equal(timeout.status, "timeout");

  const adapter = local("timeout");
  const handle = await adapter.start(spec({ timeoutMs: 500 }));
  const controller = new AbortController();
  const pending = adapter.wait(handle, controller.signal);
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.status, "cancelled");
});

test("timeout waits for cooperative SIGTERM exit and captures trailing output", async () => {
  const result = await execute(local("term-exit"), spec({ timeoutMs: CHILD_BOOT_BUDGET_MS }));
  assert.equal(result.status, "timeout");
  assert.equal(result.stdout, "before-termterm-exit");
  assert.equal(result.signal, null);
});

test("timeout escalates SIGTERM-resistant children and leaves no live child", async () => {
  const adapter = local("term-ignore");
  const handle = await adapter.start(spec({ timeoutMs: CHILD_BOOT_BUDGET_MS }));
  const result = await adapter.wait(handle);
  assert.equal(result.status, "timeout");
  assert.equal(result.stdout, "before-termignored-term");
  assert.equal(result.signal, "SIGKILL");
  assert.equal(handle.isAlive(), false);
  assert.notEqual(handle.pid, undefined);
  assert.throws(() => process.kill(handle.pid!, 0));
});

test("cancellation wins the timeout race and settles exactly once after forced kill", async () => {
  let closeNormalizations = 0;
  let cancellationNormalizations = 0;
  const normalized = (raw: RawProcessResult, status: RuntimeResult["status"], error?: string): RuntimeResult => ({
    status,
    stdout: raw.stdout,
    stderr: raw.stderr,
    exitCode: raw.exitCode,
    signal: raw.signal,
    error,
    diagnostics: [],
    identity: { adapterId: "test", evidence: "none" },
  });
  // The timeout must stay well clear of the abort below: cancellation only wins
  // the race if it lands after the child is up but before the timeout fires.
  const cancellationTimeoutMs = CHILD_BOOT_BUDGET_MS * 4;
  const handle = startProcessExecution(spec({ timeoutMs: cancellationTimeoutMs }), {
    command: process.execPath,
    args: [FIXTURE, "term-ignore"],
    cwd: process.cwd(),
    environment: {},
    timeoutMs: cancellationTimeoutMs,
    terminationGraceMs: TERMINATION_GRACE_MS,
    normalizeClose: (raw) => {
      closeNormalizations += 1;
      return normalized(raw, "failure", "unexpected close normalization");
    },
    normalizeSpawnError: (raw, error) => normalized(raw, "failure", error.message),
    normalizeTimeout: (raw) => normalized(raw, "timeout", "timeout"),
    normalizeCancellation: (raw, reason) => {
      cancellationNormalizations += 1;
      return normalized(raw, "cancelled", reason);
    },
  });
  const controller = new AbortController();
  const pending = waitForProcessExecution(handle, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, CHILD_BOOT_BUDGET_MS));
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.signal, "SIGKILL");
  assert.equal(handle.isAlive(), false);
  assert.equal(closeNormalizations, 0);
  assert.equal(cancellationNormalizations, 1);
});

test("local process adapter keeps argv data, cwd, explicit env, and child output isolated", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "meshfleet-runtime-"));
  try {
    const result = await execute(local("success"), spec({
      cwd,
      prompt: "$(echo injected); & | < > 'quoted'",
      environment: { MESH_ALLOWED: "yes", MESH_SECRET: "explicit-only" },
    }));
    assert.equal(result.status, "success");
    const body = JSON.parse(result.stdout) as { prompt: string; cwd: string; allowed: string; inheritedSecret: string };
    assert.equal(body.prompt, "$(echo injected); & | < > 'quoted'");
    assert.equal(body.cwd, realpathSync(cwd));
    assert.equal(body.allowed, "yes");
    assert.equal(body.inheritedSecret, "explicit-only");
    assert.deepEqual(RUNTIME_CHILD_STDIO, ["ignore", "pipe", "pipe"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("OpenCode adapter preserves observed banner identity and raw receipt output with a test double", async () => {
  const adapter = new OpenCodeRuntimeAdapter({
    command: process.execPath,
    buildArgs: (request) => [FIXTURE, "opencode", request.prompt],
  });
  const result = await execute(adapter, spec({ prompt: "review", requestedAgent: "oracle" }));
  assert.equal(result.status, "success");
  assert.equal(result.stdout, "answer:review");
  assert.equal(result.stderr, "> oracle · anthropic/claude-sonnet-4\n");
  assert.deepEqual(result.identity, {
    adapterId: "opencode-cli",
    agent: "oracle",
    model: "anthropic/claude-sonnet-4",
    evidence: "observed",
  });
  assert.equal(spec({ requestedModel: "different-routing-hint" }).requestedModel, "different-routing-hint");
});

test("runtime adapters reject invalid execution specs before launch", async () => {
  const adapter = local("success");
  assert.equal(adapter.validate(spec({ timeoutMs: 0 })).ok, false);
  await assert.rejects(adapter.start(spec({ timeoutMs: 0 })), /timeoutMs/);
});
