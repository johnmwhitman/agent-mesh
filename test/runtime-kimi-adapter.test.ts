import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KimiRuntimeAdapter } from "../src/runtime/kimi.js";
import { createDefaultRuntimeRegistry } from "../src/runtime/registry.js";
import type { ExecutionSpec, RuntimeResult } from "../src/runtime/types.js";

const FIXTURE = join(process.cwd(), "test/fixtures/runtime-kimi.mjs");
const POSIX_ONLY = process.platform === "win32"
  ? "POSIX-only: Windows does not expose process-group signal semantics"
  : false;

function spec(overrides: Partial<ExecutionSpec> = {}): ExecutionSpec {
  return {
    fleetId: "fleet-kimi",
    agentId: "agent-kimi",
    prompt: "stdin-only prompt $(no shell)",
    requestedModel: "kimi-code/k3",
    cwd: process.cwd(),
    environment: { MESH_KIMI_FAKE_MODE: "success" },
    environmentPolicy: { mode: "scrubbed" },
    workspace: { isolation: "verified", bindingId: "workspace-canary" },
    permissions: { mode: "unattended", edit: "workspace" },
    session: { mode: "new" },
    timeoutMs: 10_000,
    ...overrides,
  };
}

function adapter(): KimiRuntimeAdapter {
  return new KimiRuntimeAdapter({
    command: join(process.cwd(), "operator-bin/kimi"),
    harnessVersion: "1.49.0",
    verifiedWorkspaceBindingIds: ["workspace-canary"],
    spawnProcess: (_command, args, options) => spawn(process.execPath, [FIXTURE, ...args], options),
    terminationGraceMs: 100,
  });
}

async function execute(request: ExecutionSpec): Promise<RuntimeResult> {
  const runtime = adapter();
  const handle = await runtime.start(request);
  return runtime.wait(handle);
}

async function waitForFile(path: string, ceilingMs = 30_000): Promise<void> {
  const deadline = Date.now() + ceilingMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`fixture did not create ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function assertPidDead(pid: number, ceilingMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ceilingMs;
    const poll = () => {
      try {
        process.kill(pid, 0);
      } catch {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`PID ${pid} still alive`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

async function waitForProcessGroupGone(pid: number, ceilingMs = 2_000): Promise<void> {
  const deadline = Date.now() + ceilingMs;
  while (true) {
    try {
      process.kill(-pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error(`process group ${pid} still alive`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function forceProcessGroupCleanup(pid: number | undefined): void {
  if (pid === undefined || process.platform === "win32") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already contained.
  }
}

test("Kimi adapter sends the prompt only on stdin with exact native print arguments", async () => {
  const result = await execute(spec());
  assert.equal(result.status, "success");
  const observed = JSON.parse(result.stdout) as {
    argv: string[];
    stdin: string;
    promptInEnvironment: boolean;
    environmentKeys: string[];
  };
  assert.equal(observed.stdin, spec().prompt);
  assert.equal(observed.argv.includes(spec().prompt), false);
  assert.equal(observed.promptInEnvironment, false);
  assert.deepEqual(observed.argv, [
    "--print",
    "--input-format", "text",
    "--output-format", "stream-json",
    "--final-message-only",
    "--work-dir", process.cwd(),
    "--model", "kimi-code/k3",
  ]);
  assert.equal(observed.environmentKeys.includes("OPENAI_API_KEY"), false);
  assert.equal(observed.environmentKeys.includes("KIMI_API_KEY"), false);
  assert.deepEqual(result.identity, { adapterId: "kimi-cli", evidence: "none" });
});

test("Kimi adapter is explicitly registerable without replacing the OpenCode default", () => {
  const runtime = adapter();
  assert.deepEqual(runtime.describe().harness, {
    name: "kimi-cli",
    version: "1.49.0",
    versionEvidence: "configured",
    transports: ["stdin-text", "stream-json-final"],
  });
  const registry = createDefaultRuntimeRegistry();
  registry.register(runtime);
  assert.deepEqual(registry.ids(), ["kimi-cli", "opencode-cli"]);
  assert.equal(registry.require("opencode-cli").id, "opencode-cli");
});

test("Kimi adapter maps plan and unattended permissions exactly", async () => {
  const plan = await execute(spec({
    permissions: { mode: "plan", edit: "forbidden" },
  }));
  const planArgs = (JSON.parse(plan.stdout) as { argv: string[] }).argv;
  assert.equal(planArgs.filter((value) => value === "--plan").length, 1);
  assert.equal(planArgs.includes("--yolo"), false);
  assert.equal(planArgs.includes("--afk"), false);

  const unattended = await execute(spec());
  const unattendedArgs = (JSON.parse(unattended.stdout) as { argv: string[] }).argv;
  assert.equal(unattendedArgs.includes("--plan"), false);
  assert.equal(unattendedArgs.includes("--yolo"), false);
  assert.equal(unattendedArgs.includes("--afk"), false);

  const defaultModel = await execute(spec({ requestedModel: undefined }));
  const defaultArgs = (JSON.parse(defaultModel.stdout) as { argv: string[] }).argv;
  assert.equal(defaultArgs.includes("--model"), false);
});

test("Kimi adapter requires explicit safe environment, permissions, session, and isolation", () => {
  const runtime = adapter();
  const relativeCommand = new KimiRuntimeAdapter({
    command: "kimi",
    harnessVersion: "1.49.0",
  });
  assert.equal(relativeCommand.validate(spec()).ok, false);
  const invalidVersion = new KimiRuntimeAdapter({
    command: process.execPath,
    harnessVersion: "../not-a-version",
  });
  assert.equal(invalidVersion.validate(spec()).ok, false);
  assert.equal(runtime.validate(spec({ environmentPolicy: { mode: "inherit" } })).ok, false);
  assert.equal(runtime.validate(spec({ environmentPolicy: undefined })).ok, false);
  assert.equal(runtime.validate(spec({
    environmentPolicy: { mode: "allowlist", allowlist: ["KIMI_API_KEY"] },
  })).ok, false);
  assert.equal(runtime.validate(spec({
    environmentPolicy: { mode: "allowlist", allowlist: ["openai_api_key"] },
  })).ok, false);
  assert.equal(runtime.validate(spec({
    environment: { KIMI_CODE_API: "must-not-cross-entitlements" },
  })).ok, false);
  assert.equal(runtime.validate(spec({
    permissions: { mode: "unattended", edit: "workspace" },
    workspace: { isolation: "requested", bindingId: "not-verified" },
  })).ok, false);
  assert.equal(runtime.validate(spec({
    workspace: { isolation: "verified", bindingId: "unregistered-workspace" },
  })).ok, false);
  assert.equal(runtime.validate(spec({
    permissions: { mode: "interactive", edit: "workspace" },
  })).ok, false);
  assert.equal(runtime.validate(spec({
    permissions: { mode: "plan", edit: "workspace" },
  })).ok, false);
  assert.equal(runtime.validate(spec({
    permissions: { mode: "plan", edit: "forbidden" },
    workspace: { isolation: "requested", bindingId: "not-verified" },
  })).ok, false);
  assert.equal(runtime.validate(spec({ session: { mode: "resume", bindingId: "session-1" } })).ok, false);
  assert.equal(runtime.validate(spec({ requestedModel: "kimi-code/k3 injected" })).ok, false);
  assert.equal(runtime.validate(spec({
    prompt: "éé",
  })).ok, true, "prompt ceilings are UTF-8 byte based rather than UTF-16 code-unit based");
  const tiny = new KimiRuntimeAdapter({
    command: process.execPath,
    harnessVersion: "1.49.0",
    verifiedWorkspaceBindingIds: ["workspace-canary"],
    maxPromptBytes: 3,
  });
  assert.equal(tiny.validate(spec({ prompt: "éé" })).ok, false);
});

test("Kimi adapter fails closed on empty, malformed, partial, or drifted JSONL", async () => {
  for (const mode of ["empty", "malformed", "wrong-role", "non-string", "unknown-key", "too-many"]) {
    const result = await execute(spec({ environment: { MESH_KIMI_FAKE_MODE: mode } }));
    assert.equal(result.status, "failure", mode);
    assert.equal(result.stdout, "", mode);
    assert.match(result.error ?? "", /invalid Kimi stream-json output/i, mode);
  }
});

test("Kimi adapter accepts bounded multiple final frames and returns only the last assistant text", async () => {
  const result = await execute(spec({ environment: { MESH_KIMI_FAKE_MODE: "multiple" } }));
  assert.equal(result.status, "success");
  const observed = JSON.parse(result.stdout) as { stdin: string };
  assert.equal(observed.stdin, spec().prompt);
});

test("Kimi adapter contains oversized and nonzero provider output without returning partial JSON", async () => {
  const overflow = await execute(spec({
    environment: { MESH_KIMI_FAKE_MODE: "oversize" },
    output: { maxStdoutBytes: 256, maxStderrBytes: 256 },
  }));
  assert.equal(overflow.status, "failure");
  assert.equal(overflow.stdout, "");
  assert.match(overflow.error ?? "", /stdout exceeded configured limit/i);

  const failed = await execute(spec({ environment: { MESH_KIMI_FAKE_MODE: "failure" } }));
  assert.equal(failed.status, "failure");
  assert.equal(failed.stdout, "");
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.stderr, "");
});

test("Kimi adapter does not disclose its private executable path on spawn failure", async () => {
  const privateCommand = join(tmpdir(), `meshfleet-private-kimi-${process.pid}-missing`);
  const runtime = new KimiRuntimeAdapter({
    command: privateCommand,
    harnessVersion: "1.49.0",
    verifiedWorkspaceBindingIds: ["workspace-canary"],
  });
  const handle = await runtime.start(spec());
  const result = await runtime.wait(handle);
  assert.equal(result.status, "failure");
  assert.equal(result.error, "Kimi process failed to start");
  assert.equal(JSON.stringify(result).includes(privateCommand), false);
});

test("Kimi adapter timeout kills its full descendant process group", { skip: POSIX_ONLY }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-kimi-tree-"));
  const ready = join(dir, "ready");
  const pidFile = join(dir, "descendant.pid");
  let descendantPid: number | undefined;
  let handle: Awaited<ReturnType<KimiRuntimeAdapter["start"]>> | undefined;
  const runtime = adapter();
  try {
    handle = await runtime.start(spec({
      environment: {
        MESH_KIMI_FAKE_MODE: "tree-ignore",
        MESH_KIMI_READY_FILE: ready,
        MESH_KIMI_DESCENDANT_PID_FILE: pidFile,
      },
      timeoutMs: 5_000,
    }));
    await waitForFile(ready);
    descendantPid = Number(readFileSync(pidFile, "utf8"));
    const result = await runtime.wait(handle);
    assert.equal(result.status, "timeout");
    await assertPidDead(descendantPid);
    await waitForProcessGroupGone(handle.pid!);
  } finally {
    forceProcessGroupCleanup(handle?.pid);
    if (handle) await runtime.wait(handle).catch(() => {});
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // Already contained.
      }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Kimi adapter cancellation kills its full descendant process group", { skip: POSIX_ONLY }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-kimi-cancel-tree-"));
  const ready = join(dir, "ready");
  const pidFile = join(dir, "descendant.pid");
  let descendantPid: number | undefined;
  let handle: Awaited<ReturnType<KimiRuntimeAdapter["start"]>> | undefined;
  const runtime = adapter();
  try {
    handle = await runtime.start(spec({
      environment: {
        MESH_KIMI_FAKE_MODE: "tree-ignore",
        MESH_KIMI_READY_FILE: ready,
        MESH_KIMI_DESCENDANT_PID_FILE: pidFile,
      },
      timeoutMs: 30_000,
    }));
    await waitForFile(ready);
    descendantPid = Number(readFileSync(pidFile, "utf8"));
    const cancelled = await runtime.cancel(handle, "owner cancellation");
    assert.equal(cancelled.accepted, true);
    const result = await runtime.wait(handle);
    assert.equal(result.status, "cancelled");
    await assertPidDead(descendantPid);
    await waitForProcessGroupGone(handle.pid!);
  } finally {
    if (handle?.isAlive()) await runtime.cancel(handle, "test cleanup");
    forceProcessGroupCleanup(handle?.pid);
    if (handle) await runtime.wait(handle).catch(() => {});
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // Already contained.
      }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
