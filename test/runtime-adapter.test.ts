import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";
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

// Cooperative termination is POSIX-only. Windows has no SIGTERM a child can
// trap: process.kill(pid, "SIGTERM") maps onto TerminateProcess, which is
// unconditional and immediate, so a child can neither install a handler, flush
// trailing output, nor resist long enough to be escalated to SIGKILL. Tests
// that assert those behaviours describe semantics the platform cannot express,
// so they are skipped there by contract rather than silenced — see
// COMPATIBILITY.md, "Runtime adapter platform support". Everything portable in
// this file still runs on Windows.
const POSIX_SIGNALS_ONLY =
  process.platform === "win32"
    ? "POSIX-only: Windows TerminateProcess cannot deliver a catchable SIGTERM"
    : false;

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

/**
 * Block until the child fixture reports that its signal handlers are installed.
 *
 * Polling for the marker is what makes the escalation assertions deterministic:
 * they need a child that genuinely RESISTS SIGTERM, and a child that has not
 * finished booting simply dies from it. The generous ceiling is a failure
 * detector, not a budget — a healthy child arrives in tens of milliseconds, and
 * exhausting it means something is actually wrong, so it reports that rather
 * than letting the caller signal a child that was never ready.
 */
async function waitForReady(marker: string, ceilingMs = 30_000): Promise<void> {
  const deadline = Date.now() + ceilingMs;
  while (!existsSync(marker)) {
    if (Date.now() > deadline) {
      throw new Error(`child never reported readiness at ${marker} within ${ceilingMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForProcessGone(pid: number, ceilingMs = 5_000): Promise<void> {
  const deadline = Date.now() + ceilingMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error(`process ${pid} survived containment for ${ceilingMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForProcessGroupGone(pgid: number, ceilingMs = 5_000): Promise<void> {
  const deadline = Date.now() + ceilingMs;
  for (;;) {
    try {
      process.kill(-pgid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error(`process group ${pgid} survived containment for ${ceilingMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function forceFixtureCleanup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
    else process.kill(pid, "SIGKILL");
  } catch {
    // The successful containment path has already reaped the process group.
  }
}

/**
 * Measure how long a child of this fixture actually takes to become
 * SIGTERM-resistant ON THIS MACHINE, right now.
 *
 * The timeout-escalation test needs a budget that outlasts child startup, and a
 * hardcoded one is a guess about hardware and load that a busy CI runner can
 * falsify — which is the whole failure mode. Measuring instead of guessing makes
 * the budget adapt: a fast laptop keeps the small floor, a contended runner gets
 * proportionally more room. It also warms the Node binary in the page cache, so
 * the measured run is the pessimistic one.
 */
async function measureChildBootMs(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-boot-"));
  const marker = join(dir, "ready");
  const started = Date.now();
  const probe = spawn(process.execPath, [FIXTURE, "term-ignore"], {
    env: { ...process.env, MESH_READY_FILE: marker },
    stdio: "ignore",
  });
  try {
    await waitForReady(marker);
    return Math.max(1, Date.now() - started);
  } finally {
    probe.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
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
  assert.deepEqual(registry.ids(), ["local-demo", "opencode-cli"]);
  assert.equal(registry.require("opencode-cli").id, "opencode-cli");
  assert.throws(() => registry.require("missing"), /Unknown runtime adapter/);
  assert.throws(() => registry.register(registry.require("opencode-cli")), /already registered/);
});

// Split from the signal case below so the portable half keeps running on Windows.
test("local process adapter normalizes success, failure, and empty output", async () => {
  assert.equal((await execute(local("success"))).status, "success");
  const failed = await execute(local("failure"));
  assert.equal(failed.status, "failure");
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.stdout, "partial:plain prompt");
  assert.equal(failed.stderr, "fixture failure");
  assert.equal((await execute(local("empty"))).status, "success");
});

test("local process adapter normalizes signal termination", { skip: POSIX_SIGNALS_ONLY }, async () => {
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

test("timeout waits for cooperative SIGTERM exit and captures trailing output", { skip: POSIX_SIGNALS_ONLY }, async () => {
  // Same measured budget as the escalation test below, for the same reason: a
  // SIGTERM that lands before this child installed its handler kills it under
  // the default disposition, and the trailing-output assertion fails as though
  // cooperative shutdown were broken.
  const budget = Math.max(CHILD_BOOT_BUDGET_MS, (await measureChildBootMs()) * 5);
  const result = await execute(local("term-exit"), spec({ timeoutMs: budget }));
  assert.equal(result.status, "timeout");
  assert.equal(result.stdout, "before-termterm-exit");
  assert.equal(result.signal, null);
});

test("timeout escalates SIGTERM-resistant children and leaves no live child", { skip: POSIX_SIGNALS_ONLY }, async () => {
  // Here the TIMEOUT is what must escalate, so the test cannot gate the signal
  // on a readiness marker the way the cancellation test does — the adapter's
  // timer starts at spawn. The budget therefore has to outlast child startup,
  // and a fixed 250ms is a guess about hardware that a contended runner
  // falsifies: the SIGTERM lands before the handler exists, the child dies under
  // the default disposition, and both the stdout and signal assertions below
  // fail as though escalation were broken. Measuring this machine and budgeting
  // from that adapts to whatever the runner is actually doing.
  const budget = Math.max(CHILD_BOOT_BUDGET_MS, (await measureChildBootMs()) * 5);
  const adapter = local("term-ignore");
  const handle = await adapter.start(spec({ timeoutMs: budget }));
  const result = await adapter.wait(handle);
  assert.equal(result.status, "timeout");
  assert.equal(result.stdout, "before-termignored-term");
  assert.equal(result.signal, "SIGKILL");
  assert.equal(handle.isAlive(), false);
  assert.notEqual(handle.pid, undefined);
  assert.throws(() => process.kill(handle.pid!, 0));
});

test("cancellation wins the timeout race and settles exactly once after forced kill", { skip: POSIX_SIGNALS_ONLY }, async () => {
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
  // Cancellation only wins the race if it lands after the child is genuinely
  // SIGTERM-resistant. This used to sleep CHILD_BOOT_BUDGET_MS and hope: under
  // load Node had not finished booting, the handler was not installed yet, and
  // the SIGTERM killed the child under the default disposition — so it closed
  // with SIGTERM and the SIGKILL assertion below failed. (This test has no
  // stdout assertion, so the signal check is the first thing that notices.)
  //
  // Now the child announces readiness and the abort waits for it, so the
  // ordering is established by evidence rather than by a delay. The timeout is
  // correspondingly a far-away ceiling a healthy run never approaches, not a
  // deadline the test is racing; raising it cannot mask a regression, because
  // the assertions require cancellation — a timeout would fail `status` first.
  const readyDir = mkdtempSync(join(tmpdir(), "meshfleet-ready-"));
  const readyFile = join(readyDir, "ready");
  const cancellationTimeoutMs = 30_000;
  const handle = startProcessExecution(spec({ timeoutMs: cancellationTimeoutMs }), {
    command: process.execPath,
    args: [FIXTURE, "term-ignore"],
    cwd: process.cwd(),
    environment: { MESH_READY_FILE: readyFile },
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
    normalizeOutputOverflow: (raw, stream, limit) => normalized(raw, "failure", `${stream}:${limit}`),
  });
  const controller = new AbortController();
  const pending = waitForProcessExecution(handle, controller.signal);
  try {
    await waitForReady(readyFile);
    controller.abort();
    const result = await pending;
    assert.equal(result.status, "cancelled");
    assert.equal(result.signal, "SIGKILL");
    assert.equal(handle.isAlive(), false);
    assert.equal(closeNormalizations, 0);
    assert.equal(cancellationNormalizations, 1);
  } finally {
    controller.abort(); // never leak the child if an assertion throws
    await pending.catch(() => {});
    rmSync(readyDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
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

test("process execution stdin delivery keeps prompt bytes out of argv and environment", async () => {
  const input = "stdin-only $() secret-shaped bytes";
  const request = spec({
    prompt: "compatibility prompt",
    input: { transport: "stdin", bytes: Buffer.from(input) },
  });
  const normalize = (
    raw: RawProcessResult,
    status: RuntimeResult["status"],
    error?: string,
  ): RuntimeResult => ({
    status,
    stdout: raw.stdout,
    stderr: raw.stderr,
    exitCode: raw.exitCode,
    signal: raw.signal,
    error,
    diagnostics: [],
    identity: { adapterId: "process-test", evidence: "none" },
  });
  const handle = startProcessExecution(request, {
    command: process.execPath,
    args: [FIXTURE, "success"],
    cwd: request.cwd,
    environment: {},
    timeoutMs: request.timeoutMs,
    normalizeClose: (raw) => normalize(raw, raw.exitCode === 0 ? "success" : "failure"),
    normalizeSpawnError: (raw) => normalize(raw, "failure", "spawn failed"),
    normalizeTimeout: (raw) => normalize(raw, "timeout", "timeout"),
    normalizeCancellation: (raw) => normalize(raw, "cancelled", "cancelled"),
    normalizeOutputOverflow: (raw) => normalize(raw, "failure", "output overflow"),
  });
  const result = await waitForProcessExecution(handle);
  assert.equal(result.status, "success");
  const body = JSON.parse(result.stdout) as { argv: string[]; stdin: string };
  assert.equal(body.stdin, input);
  assert.equal(body.argv.includes(input), false);
  assert.equal(body.argv.includes("compatibility prompt"), false);
  assert.deepEqual(RUNTIME_CHILD_STDIO, ["ignore", "pipe", "pipe"], "default remains compatibility-safe");
});

test("local process adapter rejects stdin so prompt delivery cannot be duplicated", () => {
  const validation = local("success").validate(spec({
    input: { transport: "stdin", bytes: Buffer.from("duplicate") },
  }));
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join(" "), /argv-only.*does not support stdin/i);
});

test("runtime environment allowlist excludes ambient values while retaining explicit baseline", async () => {
  const ambient = process.env.MESH_AMBIENT_FOR_TEST;
  process.env.MESH_AMBIENT_FOR_TEST = "do-not-inherit";
  try {
    const adapter = local("success");
    const result = await execute(adapter, spec({
      environment: { MESH_ALLOWED: "explicit", MESH_SECRET: "also-explicit" },
      environmentPolicy: { mode: "allowlist", allowlist: ["MESH_AMBIENT_FOR_TEST"] },
    }));
    const body = JSON.parse(result.stdout) as { allowed: string; inheritedSecret: string; ambient: string | null };
    assert.equal(body.allowed, "explicit");
    assert.equal(body.inheritedSecret, "also-explicit");
    assert.equal(body.ambient, "do-not-inherit", "only a named inherited value is admitted");
  } finally {
    if (ambient === undefined) delete process.env.MESH_AMBIENT_FOR_TEST;
    else process.env.MESH_AMBIENT_FOR_TEST = ambient;
  }
});

test("runtime output limits truncate deterministically and fail after containment", async () => {
  const adapter = new LocalProcessRuntimeAdapter({
    command: process.execPath,
    buildArgs: () => ["-e", "process.stdout.write('abcdef')"],
  });
  const result = await execute(adapter, spec({ output: { maxStdoutBytes: 3 } }));
  assert.equal(result.status, "failure");
  assert.equal(result.stdout, "abc");
  assert.equal(result.stderr, "");
  assert.match(result.error ?? "", /stdout exceeded configured limit of 3 bytes/);
});

test("timeout terminates the POSIX descendant process group", { skip: POSIX_SIGNALS_ONLY }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-descendant-"));
  const ready = join(dir, "ready");
  const descendantPid = join(dir, "descendant.pid");
  const adapter = new LocalProcessRuntimeAdapter({
    command: process.execPath,
    buildArgs: () => [FIXTURE, "tree-term-ignore"],
    terminationGraceMs: TERMINATION_GRACE_MS,
  });
  let handle: Awaited<ReturnType<LocalProcessRuntimeAdapter["start"]>> | undefined;
  try {
    handle = await adapter.start(spec({
      // The timeout starts at spawn, so this must leave a material startup
      // window before waiting on the child's ready marker.
      timeoutMs: 5_000,
      environment: { MESH_READY_FILE: ready, MESH_DESCENDANT_PID_FILE: descendantPid },
    }));
    await waitForReady(ready);
    const result = await adapter.wait(handle);
    assert.equal(result.status, "timeout");
    const pid = Number(readFileSync(descendantPid, "utf8"));
    await waitForProcessGone(pid);
    await waitForProcessGroupGone(handle.pid!);
  } finally {
    // This must run on any readiness or assertion failure: detached fixture
    // groups deliberately do not die with the node:test parent.
    forceFixtureCleanup(handle?.pid);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("leader close cannot cancel SIGKILL for a pipe-detached descendant", { skip: POSIX_SIGNALS_ONLY }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-detached-descendant-"));
  const ready = join(dir, "ready");
  const descendantPid = join(dir, "descendant.pid");
  const adapter = new LocalProcessRuntimeAdapter({
    command: process.execPath,
    buildArgs: () => [FIXTURE, "tree-leader-exits-child-detached"],
    terminationGraceMs: TERMINATION_GRACE_MS,
  });
  let handle: Awaited<ReturnType<LocalProcessRuntimeAdapter["start"]>> | undefined;
  try {
    handle = await adapter.start(spec({
      timeoutMs: 5_000,
      environment: { MESH_READY_FILE: ready, MESH_DESCENDANT_PID_FILE: descendantPid },
    }));
    await waitForReady(ready);
    const pid = Number(readFileSync(descendantPid, "utf8"));
    const result = await adapter.wait(handle);
    assert.equal(result.status, "timeout");
    await waitForProcessGone(pid);
    await waitForProcessGroupGone(handle.pid!);
  } finally {
    forceFixtureCleanup(handle?.pid);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("output overflow contains a POSIX descendant group without a pipe hang", { skip: POSIX_SIGNALS_ONLY }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-overflow-descendant-"));
  const ready = join(dir, "ready");
  const descendantPid = join(dir, "descendant.pid");
  const adapter = new LocalProcessRuntimeAdapter({
    command: process.execPath,
    buildArgs: () => [FIXTURE, "tree-output-ignore"],
    terminationGraceMs: TERMINATION_GRACE_MS,
  });
  let handle: Awaited<ReturnType<LocalProcessRuntimeAdapter["start"]>> | undefined;
  try {
    handle = await adapter.start(spec({
      timeoutMs: 30_000,
      output: { maxStdoutBytes: 3 },
      environment: { MESH_READY_FILE: ready, MESH_DESCENDANT_PID_FILE: descendantPid },
    }));
    await waitForReady(ready);
    const result = await adapter.wait(handle);
    assert.equal(result.status, "failure");
    assert.equal(result.stdout, "ove");
    assert.match(result.error ?? "", /stdout exceeded configured limit of 3 bytes/);
    const pid = Number(readFileSync(descendantPid, "utf8"));
    await waitForProcessGone(pid);
    await waitForProcessGroupGone(handle.pid!);
  } finally {
    forceFixtureCleanup(handle?.pid);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

test("OpenCode adapter passes the raw requested model through custom arguments and rejects a mismatching banner", async () => {
  let customBuilderSpec: ExecutionSpec | undefined;
  const adapter = new OpenCodeRuntimeAdapter({
    command: process.execPath,
    buildArgs: (request) => {
      customBuilderSpec = request;
      return [FIXTURE, "opencode", request.prompt];
    },
  });

  const result = await execute(adapter, spec({
    prompt: "review",
    requestedAgent: "oracle",
    requestedModel: "openai/gpt-5",
  }));

  assert.equal(customBuilderSpec?.requestedModel, "openai/gpt-5");
  assert.equal(result.status, "failure");
  assert.equal(result.error, "Requested model openai/gpt-5 but runtime model banner reported anthropic/claude-sonnet-4");
  assert.deepEqual(result.identity, {
    adapterId: "opencode-cli",
    agent: "oracle",
    model: "anthropic/claude-sonnet-4",
    evidence: "observed",
  });
});

test("OpenCode adapter accepts a requested model matching the observed banner", async () => {
  const adapter = new OpenCodeRuntimeAdapter({
    command: process.execPath,
    buildArgs: (request) => [FIXTURE, "opencode", request.prompt],
  });

  const result = await execute(adapter, spec({
    requestedAgent: "oracle",
    requestedModel: "claude-sonnet-4",
  }));

  assert.equal(result.status, "success");
  assert.equal(result.identity.evidence, "observed");
  assert.equal(result.identity.model, "anthropic/claude-sonnet-4");
});

test("OpenCode adapter accepts a provider-stripped multi-segment Kilo banner", async () => {
  const adapter = new OpenCodeRuntimeAdapter({
    command: process.execPath,
    spawnProcess: (_command, _args, options) => spawn(
      process.execPath,
      [
        "-e",
        "process.stdout.write('OK\\n'); process.stderr.write('> oracle · kilo-auto/free\\n')",
      ],
      options,
    ),
  });

  const result = await execute(adapter, spec({
    requestedAgent: "oracle",
    requestedModel: "kilo/kilo-auto/free",
  }));

  assert.equal(result.status, "success");
  assert.equal(result.identity.model, "kilo-auto/free");
  assert.equal(result.identity.evidence, "observed");
});

test("OpenCode adapter default argv selects the requested model while mismatch remains fail-closed", async () => {
  let observedArgs: string[] | undefined;
  const adapter = new OpenCodeRuntimeAdapter({
    command: process.execPath,
    spawnProcess: (_command, args, options) => {
      observedArgs = [...args];
      return spawn(process.execPath, [FIXTURE, "opencode", "review"], options);
    },
  });

  const result = await execute(adapter, spec({
    prompt: "review",
    requestedAgent: "oracle",
    requestedModel: "openai/gpt-5",
  }));

  assert.equal(result.status, "failure");
  assert.deepEqual(observedArgs, [
    "run",
    "--model",
    "openai/gpt-5",
    "--agent",
    "oracle",
    "review",
  ]);
});

test("OpenCode adapter default argv omits --model when no model is requested", async () => {
  let observedArgs: string[] | undefined;
  const adapter = new OpenCodeRuntimeAdapter({
    command: process.execPath,
    spawnProcess: (_command, args, options) => {
      observedArgs = [...args];
      return spawn(process.execPath, [FIXTURE, "opencode", "review"], options);
    },
  });

  await execute(adapter, spec({
    prompt: "review",
    requestedAgent: "oracle",
  }));

  assert.deepEqual(observedArgs, ["run", "--agent", "oracle", "review"]);
  assert.equal(observedArgs?.includes("--model"), false);
});

test("OpenCode preserves its ignored-stdin compatibility contract", async () => {
  const adapter = new OpenCodeRuntimeAdapter();
  const validation = adapter.validate(spec({
    input: { transport: "stdin", bytes: Buffer.from("future-native-input") },
  }));
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join(" "), /does not support stdin input/);
  assert.deepEqual(RUNTIME_CHILD_STDIO, ["ignore", "pipe", "pipe"]);
});

test("runtime adapters reject invalid execution specs before launch", async () => {
  const adapter = local("success");
  assert.equal(adapter.validate(spec({ timeoutMs: 0 })).ok, false);
  assert.equal(adapter.validate(spec({ input: { transport: "stdin", bytes: Buffer.from("too large"), maxBytes: 1 } })).ok, false);
  assert.equal(adapter.validate(spec({ environmentPolicy: { mode: "allowlist", allowlist: ["OK", "BAD=NAME"] } })).ok, false);
  assert.equal(adapter.validate(spec({ workspace: { isolation: "verified", bindingId: "/machine/path" } })).ok, false);
  assert.equal(adapter.validate(spec({ session: { mode: "resume" } })).ok, false);
  await assert.rejects(adapter.start(spec({ timeoutMs: 0 })), /timeoutMs/);
});
