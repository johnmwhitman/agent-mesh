import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GrokCliRuntimeAdapter } from "../src/runtime/grok.js";
import type { ExecutionSpec, RuntimeResult } from "../src/runtime/types.js";

const FIXTURE = String.raw`
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
await new Promise((resolve) => process.stdin.on("end", resolve));
if (stdin === "EMPTY") process.exit(0);
if (stdin === "FAILURE") {
  process.stderr.write("private provider detail must not cross the adapter boundary\n");
  process.exit(7);
}
if (stdin === "HANG") {
  setInterval(() => {}, 1_000);
} else if (stdin === "PLAIN") {
  process.stdout.write("unstructured response");
} else if (stdin === "BLOCKED") {
  process.stdout.write(JSON.stringify({
    schema: "mf.agent.text-result/v1",
    outcome: "blocked",
    summary: "fixture could not continue",
    reason: "fixture input was incomplete",
  }));
} else {
  process.stdout.write(JSON.stringify({
    schema: "mf.agent.text-result/v1",
    outcome: "done",
    summary: "fixture completed",
    output: JSON.stringify({
      argv: process.argv.slice(2),
      stdin,
      promptInEnvironment: Object.values(process.env).includes(stdin),
      noMemory: process.env.NO_MEMORY,
      grokTextOnly: process.env.GROK_TEXT_ONLY,
      childMarker: process.env.AGENT_MESH_CHILD,
      environmentNames: Object.keys(process.env).sort(),
    }),
  }));
}
`;

const NESTED_PROVIDER_FIXTURE = String.raw`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidFile = process.argv.at(-1);
const provider = spawn(process.execPath, [
  "--input-type=module",
  "--eval",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
], { detached: true, stdio: "ignore" });
if (!provider.pid || !pidFile) process.exit(2);
provider.unref();
// The handler MUST be installed before the pid file is written: the pid file is the test's
// readiness signal, and the test cancels as soon as it sees it. Until a listener exists the
// OS default disposition applies, so a SIGTERM landing between the write and the listener
// killed this wrapper outright, orphaning the provider (macOS, Node 24 leg of CI run
// 36255863419: "condition did not become observable before ceiling").
process.on("SIGTERM", () => {
  try { process.kill(-provider.pid, "SIGTERM"); } catch {}
  setTimeout(() => {
    try { process.kill(-provider.pid, "SIGKILL"); } catch {}
    process.exit(143);
  }, 500);
});
writeFileSync(pidFile, String(provider.pid));
setInterval(() => {}, 1000);
`;

/** Names libuv injects into every Windows child environment (libuv src/win/process.c). */
const LIBUV_WIN32_REQUIRED_ENV = new Set([
  "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SYSTEMROOT",
  "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR",
]);

async function waitFor(check: () => boolean, ceilingMs = 2_000): Promise<void> {
  const deadline = Date.now() + ceilingMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition did not become observable before ceiling");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function pidIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function spec(overrides: Partial<ExecutionSpec> = {}): ExecutionSpec {
  return {
    fleetId: "fleet-grok",
    agentId: "agent-grok",
    prompt: "return the bounded review",
    cwd: process.cwd(),
    environmentPolicy: { mode: "scrubbed" },
    permissions: { mode: "unattended", edit: "forbidden" },
    session: { mode: "new" },
    timeoutMs: 10_000,
    ...overrides,
  };
}

function adapter(hostEnvironment: NodeJS.ProcessEnv = process.env): GrokCliRuntimeAdapter {
  return new GrokCliRuntimeAdapter({
    command: join(process.cwd(), "operator-bin/grk"),
    harnessVersion: "2026.09.24",
    hostEnvironment,
    spawnProcess: (_command, args, options) =>
      spawn(process.execPath, ["--input-type=module", "--eval", FIXTURE, "fixture", ...args], options),
    terminationGraceMs: 50,
  });
}

async function execute(request: ExecutionSpec, runtime = adapter()): Promise<RuntimeResult> {
  const handle = await runtime.start(request);
  return runtime.wait(handle);
}

test("Grok subscription adapter is explicit-only and advertises text-only authority", () => {
  assert.deepEqual(adapter().describe(), {
    id: "grok-cli",
    displayName: "Grok subscription CLI",
    defaultTimeoutMs: 30 * 60 * 1000,
    failoverEligible: false,
    harness: {
      name: "grk",
      version: "2026.09.24",
      versionEvidence: "configured",
      transports: ["stdin-text", "final-text"],
    },
    permissions: { mode: "restricted", capabilities: ["text.completion"] },
    session: { mode: "ephemeral" },
  });
});

test("Grok subscription adapter sends prompt bytes on stdin with one fixed argv label", async () => {
  const runtime = adapter({
    HOME: "/operator-profile",
    USER: "operator",
    PATH: "/operator-bin",
    UNRELATED_PRIVATE_TOKEN: "must-not-cross",
    GROK_MODEL: "must-not-cross",
    ROUTEPLANE: "must-not-cross",
  });
  const prompt = "x".repeat(40_000);
  const result = await execute(spec({ prompt }), runtime);
  assert.equal(result.status, "success");
  const observed = JSON.parse(result.stdout) as {
    argv: string[];
    stdin: string;
    promptInEnvironment: boolean;
    noMemory: string;
    grokTextOnly: string;
    childMarker: string;
    environmentNames: string[];
  };
  assert.deepEqual(observed.argv, ["Complete the following MeshFleet text task exactly as provided on stdin."]);
  assert.equal(observed.stdin, prompt, "task bytes above the Windows argv ceiling must use stdin");
  assert.equal(observed.promptInEnvironment, false);
  assert.equal(observed.noMemory, "1", "the wrapper must receive only the task prompt, not ambient memory");
  assert.equal(observed.grokTextOnly, "1", "the wrapper must disable every local tool");
  assert.equal(observed.childMarker, "1");
  const expectedNames = ["AGENT_MESH_CHILD", "GROK_TEXT_ONLY", "HOME", "NO_MEMORY", "PATH", "USER"];
  assert.deepEqual(
    observed.environmentNames.filter(
      (name) =>
        name !== "__CF_USER_TEXT_ENCODING" &&
        // On Windows, libuv's process spawn re-adds these variables from the PARENT environment
        // whenever a child's environment block omits them (src/win/process.c `required_vars`), so
        // they reach every child regardless of what the adapter admits. Measured on all three
        // windows-2022 legs of CI run 36255863419: exactly this set, and nothing else, appeared.
        // Every other name, including the three must-not-cross names above, is still asserted.
        !(process.platform === "win32" && LIBUV_WIN32_REQUIRED_ENV.has(name) && !expectedNames.includes(name)),
    ),
    expectedNames,
  );
  assert.deepEqual(result.identity, { adapterId: "grok-cli", evidence: "none" });
  assert.equal(result.stderr, "");
});

test("Grok subscription adapter refuses authority, selectors, and caller environment", () => {
  const runtime = adapter();
  assert.equal(runtime.validate(spec()).ok, true);
  for (const request of [
    spec({ requestedModel: "grok-4.5" }),
    spec({ requestedAgent: "reviewer" }),
    spec({ permissions: { mode: "unattended", edit: "workspace" } }),
    spec({ workspace: { isolation: "verified", bindingId: "ws-1" } }),
    spec({ environmentPolicy: { mode: "inherit" } }),
    spec({ environment: { GROK_API_KEY: "caller-must-not-route-credentials" } }),
    spec({ environment: { UNRELATED: "caller-must-not-expand-environment" } }),
    spec({ session: { mode: "resume", bindingId: "session-1" } }),
    spec({ prompt: "prefix\0suffix" }),
  ]) {
    assert.equal(runtime.validate(request).ok, false, JSON.stringify(request));
  }
});

test("Grok subscription adapter fails closed on empty and nonzero output without raw diagnostics", async () => {
  const empty = await execute(spec({ prompt: "EMPTY" }));
  assert.equal(empty.status, "failure");
  assert.equal(empty.failureClass, "deterministic");
  assert.equal(empty.stdout, "");
  assert.match(empty.error ?? "", /empty final response/i);

  const plain = await execute(spec({ prompt: "PLAIN" }));
  assert.equal(plain.status, "failure");
  assert.equal(plain.failureClass, "deterministic");
  assert.match(plain.error ?? "", /invalid Grok text result/i);

  const failed = await execute(spec({ prompt: "FAILURE" }));
  assert.equal(failed.status, "failure");
  assert.equal(failed.failureClass, undefined, "provider/runtime exits remain transient by default");
  assert.equal(failed.stdout, "");
  assert.equal(failed.stderr, "");
  assert.equal(failed.exitCode, 7);
  assert.equal(JSON.stringify(failed).includes("private provider detail"), false);
});

test("Grok subscription adapter preserves a blocked worker's mandatory triage reason", async () => {
  const blocked = await execute(spec({ prompt: "BLOCKED" }));
  assert.equal(blocked.status, "success", "declared blocking is a valid runtime delivery");
  assert.equal(blocked.resultContract, "blocked");
  assert.equal(blocked.stdout, "fixture could not continue\n\nReason: fixture input was incomplete");
});

test("Grok subscription adapter normalizes timeout and cancellation", async () => {
  const timed = await execute(spec({ prompt: "HANG", timeoutMs: 30 }));
  assert.equal(timed.status, "timeout");
  assert.equal(timed.stderr, "");

  const runtime = adapter();
  const handle = await runtime.start(spec({ prompt: "HANG", timeoutMs: 30_000 }));
  const cancellation = await runtime.cancel(handle, "owner stopped work");
  assert.equal(cancellation.accepted, true);
  const cancelled = await runtime.wait(handle);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.stderr, "");
});

test("Grok adapter leaves enough grace for the wrapper to kill its detached provider", {
  skip: process.platform === "win32" ? "POSIX process groups required" : false,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-grok-nested-"));
  const pidFile = join(dir, "provider.pid");
  let providerPid: number | undefined;
  try {
    const runtime = new GrokCliRuntimeAdapter({
      command: join(process.cwd(), "operator-bin/grk"),
      harnessVersion: "2026.09.24",
      spawnProcess: (_command, _args, options) =>
        spawn(process.execPath, ["--input-type=module", "--eval", NESTED_PROVIDER_FIXTURE, "fixture", pidFile], options),
    });
    const handle = await runtime.start(spec({ timeoutMs: 30_000 }));
    await waitFor(() => {
      try {
        providerPid = Number(readFileSync(pidFile, "utf8"));
        return Number.isInteger(providerPid) && providerPid > 0;
      } catch {
        return false;
      }
    });
    assert.equal((await runtime.cancel(handle, "contain nested provider")).accepted, true);
    assert.equal((await runtime.wait(handle)).status, "cancelled");
    await waitFor(() => providerPid !== undefined && pidIsDead(providerPid));
  } finally {
    if (providerPid !== undefined && !pidIsDead(providerPid)) {
      try { process.kill(-providerPid, "SIGKILL"); } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
