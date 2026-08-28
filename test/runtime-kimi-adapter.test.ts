import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { KimiRuntimeAdapter } from "../src/runtime/kimi.js";
import { createDefaultRuntimeRegistry } from "../src/runtime/registry.js";
import type { ExecutionSpec, RuntimeResult } from "../src/runtime/types.js";

const FIXTURE = join(process.cwd(), "test/fixtures/runtime-kimi.mjs");
const POSIX_ONLY = process.platform === "win32"
  ? "POSIX-only: Windows does not expose process-group signal semantics"
  : false;
const REAP_OWNER = createHash("sha256")
  .update("meshfleet:runtime-kimi-fixture:v1")
  .digest("hex")
  .slice(0, 16);

type FixtureReapJournal = {
  version: 1;
  owner: string;
  pid: number;
  runnerSocketPath: string;
  runnerToken: string;
  socketPath: string;
  token: string;
};

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
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          resolve();
          return;
        }
        reject(error);
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() > deadline) throw new Error(`process group ${pid} still alive`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function readFixtureReapJournal(journalPath: string): FixtureReapJournal {
  const handleDir = dirname(journalPath);
  const dirStat = lstatSync(handleDir);
  assert.equal(dirStat.isDirectory() && !dirStat.isSymbolicLink(), true);
  assert.equal(dirStat.mode & 0o777, 0o700);
  const journalStat = lstatSync(journalPath);
  assert.equal(journalStat.isFile() && !journalStat.isSymbolicLink(), true);
  assert.equal(journalStat.mode & 0o777, 0o600);
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as FixtureReapJournal;
  assert.deepEqual(Object.keys(journal).sort(), [
    "owner", "pid", "runnerSocketPath", "runnerToken", "socketPath", "token", "version",
  ]);
  assert.equal(journal.version, 1);
  assert.equal(journal.owner, REAP_OWNER);
  assert.equal(journal.socketPath, join(handleDir, "reap.sock"));
  assert.equal(journal.runnerSocketPath, join(handleDir, "runner.sock"));
  assert.equal(Buffer.byteLength(journal.socketPath) < 90, true);
  assert.equal(Buffer.byteLength(journal.runnerSocketPath) < 90, true);
  assert.match(journal.token, /^[a-f0-9]{32}$/);
  assert.match(journal.runnerToken, /^[a-f0-9]{32}$/);
  assert.equal(Number.isSafeInteger(journal.pid) && journal.pid > 1, true);
  return journal;
}

async function reapFixtureFromJournal(journalPath: string): Promise<FixtureReapJournal> {
  const journal = readFixtureReapJournal(journalPath);
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(journal.socketPath);
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => socket.destroy(new Error("fixture reap socket timed out")));
    socket.once("error", reject);
    socket.once("data", (data) => {
      if (String(data) !== "reaping\n") {
        reject(new Error(`unexpected fixture reap response: ${JSON.stringify(data)}`));
        return;
      }
      socket.end();
      resolve();
    });
    socket.once("connect", () => socket.write(`${journal.token}\n`));
  });
  return journal;
}

async function armRunnerLiveness(
  socketPath: string,
  token: string,
): Promise<ReturnType<typeof createServer>> {
  const server = createServer((socket) => {
    let request = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      request += chunk;
      if (request === `${token}\n`) socket.end("alive\n");
      else if (request.length >= 33) socket.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function probeRunnerLiveness(journal: FixtureReapJournal): Promise<"alive" | "dead" | "unknown"> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection(journal.runnerSocketPath);
    const finish = (result: "alive" | "dead" | "unknown") => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(500, () => finish("unknown"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "dead" : "unknown");
    });
    socket.once("data", (data) => finish(String(data) === "alive\n" ? "alive" : "unknown"));
    socket.once("connect", () => socket.write(`${journal.runnerToken}\n`));
  });
}

async function retireFixtureHandle(journalPath: string): Promise<FixtureReapJournal> {
  const journal = readFixtureReapJournal(journalPath);
  try {
    process.kill(-journal.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    rmSync(dirname(journalPath), { recursive: true, force: true });
    return journal;
  }
  await reapFixtureFromJournal(journalPath);
  await waitForProcessGroupGone(journal.pid);
  rmSync(dirname(journalPath), { recursive: true, force: true });
  return journal;
}

async function reapOwnedFixtures(): Promise<FixtureReapJournal[]> {
  const prefix = `mfk-${REAP_OWNER}-`;
  const reaped: FixtureReapJournal[] = [];
  for (const name of readdirSync("/tmp").filter((entry) => entry.startsWith(prefix))) {
    const handleDir = join("/tmp", name);
    const journalPath = join(handleDir, "journal.json");
    let journal: FixtureReapJournal | undefined;
    try {
      journal = readFixtureReapJournal(journalPath);
      if (await probeRunnerLiveness(journal) !== "dead") continue;
      journal = await retireFixtureHandle(journalPath);
      reaped.push(journal);
    } catch {
      // Retain the authenticated handle unless reap + group-gone both proved cleanup.
    }
  }
  return reaped;
}

function fixtureReapEnvironment(): {
  environment: Record<string, string>;
  journalPath: string;
  socketPath: string;
} {
  const token = randomUUID().replaceAll("-", "");
  const runnerToken = randomUUID().replaceAll("-", "");
  const handleDir = mkdtempSync(`/tmp/mfk-${REAP_OWNER}-`);
  const journalPath = join(handleDir, "journal.json");
  return {
    environment: {
      MESH_KIMI_REAP_JOURNAL: journalPath,
      MESH_KIMI_REAP_OWNER: REAP_OWNER,
      MESH_KIMI_REAP_RUNNER_SOCKET: join(handleDir, "runner.sock"),
      MESH_KIMI_REAP_RUNNER_TOKEN: runnerToken,
      MESH_KIMI_REAP_TOKEN: token,
    },
    journalPath,
    socketPath: join(handleDir, "reap.sock"),
  };
}

async function assertCrashRecoverableFixtureReap(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-kimi-crash-reap-"));
  const ready = join(dir, "ready");
  const descendantPidFile = join(dir, "descendant.pid");
  const leaderPidFile = join(dir, "leader.pid");
  const reap = fixtureReapEnvironment();
  const token = reap.environment.MESH_KIMI_REAP_TOKEN;
  let leaderPid: number | undefined;
  const harness = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
     import { createServer } from "node:net";
     const runner = createServer((socket) => {
       let request = "";
       socket.setEncoding("utf8");
       socket.on("data", (chunk) => {
         request += chunk;
         if (request === process.env.MESH_KIMI_REAP_RUNNER_TOKEN + "\\n") socket.end("alive\\n");
       });
     });
     runner.listen(process.env.MESH_KIMI_REAP_RUNNER_SOCKET, () => {
       const child = spawn(process.execPath, [process.env.FIXTURE], {
         detached: true, env: process.env, stdio: ["ignore", "ignore", "ignore"]
       });
       writeFileSync(process.env.LEADER_PID_FILE, String(child.pid));
     });`,
  ], {
    env: {
      ...process.env,
      ...reap.environment,
      FIXTURE,
      LEADER_PID_FILE: leaderPidFile,
      MESH_KIMI_FAKE_MODE: "tree-ignore",
      MESH_KIMI_READY_FILE: ready,
      MESH_KIMI_DESCENDANT_PID_FILE: descendantPidFile,
    },
    stdio: "ignore",
  });
  try {
    await waitForFile(leaderPidFile);
    leaderPid = Number(readFileSync(leaderPidFile, "utf8"));
    await waitForFile(ready);
    assert.equal(existsSync(reap.journalPath), true, "fixture must persist its reap handle before ready");
    assert.equal((await reapOwnedFixtures()).some((entry) => entry.token === token), false);
    process.kill(-leaderPid, 0);
    harness.kill("SIGKILL");
    await new Promise<void>((resolve) => harness.once("close", () => resolve()));
    process.kill(-leaderPid, 0);

    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(reap.socketPath);
      socket.setTimeout(2_000, () => {
        reject(new Error("unauthenticated reap was not rejected"));
        socket.destroy();
      });
      socket.once("error", () => resolve());
      socket.once("close", () => resolve());
      socket.once("connect", () => socket.write(`${"0".repeat(32)}\n`));
    });
    process.kill(-leaderPid, 0);

    const reaped = await reapOwnedFixtures();
    const journal = reaped.find((entry) => entry.token === token);
    assert.ok(journal);
    assert.equal(journal.pid, leaderPid);
    assert.equal(existsSync(dirname(reap.journalPath)), false);
  } finally {
    if (harness.exitCode === null && harness.signalCode === null) harness.kill("SIGKILL");
    if (existsSync(reap.journalPath)) await retireFixtureHandle(reap.journalPath).catch(() => {});
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
  assert.deepEqual(registry.ids(), ["kimi-cli", "local-demo", "opencode-cli"]);
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
  await assertCrashRecoverableFixtureReap();
  await reapOwnedFixtures();
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-kimi-tree-"));
  const reap = fixtureReapEnvironment();
  const runnerServer = await armRunnerLiveness(
    reap.environment.MESH_KIMI_REAP_RUNNER_SOCKET,
    reap.environment.MESH_KIMI_REAP_RUNNER_TOKEN,
  );
  const ready = join(dir, "ready");
  const pidFile = join(dir, "descendant.pid");
  let descendantPid: number | undefined;
  let handle: Awaited<ReturnType<KimiRuntimeAdapter["start"]>> | undefined;
  const runtime = adapter();
  try {
    handle = await runtime.start(spec({
      environment: {
        ...reap.environment,
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
    runnerServer.close();
    if (handle?.isAlive()) await runtime.cancel(handle, "test cleanup");
    if (handle) await runtime.wait(handle).catch(() => {});
    if (existsSync(reap.journalPath)) await retireFixtureHandle(reap.journalPath).catch(() => {});
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Kimi adapter cancellation kills its full descendant process group", { skip: POSIX_ONLY }, async () => {
  await reapOwnedFixtures();
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-kimi-cancel-tree-"));
  const reap = fixtureReapEnvironment();
  const runnerServer = await armRunnerLiveness(
    reap.environment.MESH_KIMI_REAP_RUNNER_SOCKET,
    reap.environment.MESH_KIMI_REAP_RUNNER_TOKEN,
  );
  const ready = join(dir, "ready");
  const pidFile = join(dir, "descendant.pid");
  let descendantPid: number | undefined;
  let handle: Awaited<ReturnType<KimiRuntimeAdapter["start"]>> | undefined;
  const runtime = adapter();
  try {
    handle = await runtime.start(spec({
      environment: {
        ...reap.environment,
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
    runnerServer.close();
    if (handle?.isAlive()) await runtime.cancel(handle, "test cleanup");
    if (handle) await runtime.wait(handle).catch(() => {});
    if (existsSync(reap.journalPath)) await retireFixtureHandle(reap.journalPath).catch(() => {});
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
