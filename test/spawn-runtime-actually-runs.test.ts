/**
 * A selected runtime must actually RUN the agent — not merely be accepted.
 *
 * `spawn_fleet` already validated `agents[].runtime` and refused unknown ids, and its published
 * description promised that "agents in one fleet can run under different CLIs and one provider
 * outage cannot stop every agent at once." The field was read in exactly ONE place — the refusal —
 * and then dropped: nothing copied it into the spawn specs and nothing passed it to `trySpawn`, so
 * `SpawnAgentInput.runtime` had no producer at all. Every selected agent still ran under opencode.
 *
 * Measured on `main` at bafe7aa, 2026-08-01: `runtime: "kimi-cli"` with `MESHFLEET_KIMI_COMMAND`
 * pointed at a marker-writing executable returned a normal `fleet_id` and never invoked it. That
 * is the same defect family as a tool description that overpromises, and the reason these tests
 * assert on a FILE THE RUNTIME WROTE rather than on the response: a `fleet_id` came back either
 * way, so the response cannot tell the two worlds apart.
 *
 * The second half is the workspace gate. `kimi.ts` refuses both `plan` and `unattended` unless the
 * caller names a binding AND the adapter's operator-configured admission list contains it. Two
 * independent keys, and each negative control below turns exactly one of them off.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = platform() === "win32";

/**
 * A stand-in for the Kimi CLI that records that it was invoked and emits one valid final frame.
 *
 * A real `kimi` binary is not present on CI and would need credentials, so the thing under test
 * here is the WIRING: did MeshFleet spawn the selected runtime's command at all. The frame shape
 * (`{role, content}`, exactly those two keys) is what `parseFinalAssistantText` accepts.
 */
function writeFakeRuntime(dir: string): { command: string; marker: string } {
  const marker = join(dir, "INVOKED");
  const command = join(dir, isWindows ? "fake-kimi.cmd" : "fake-kimi");
  const frame = '{"role":"assistant","content":"ok"}';
  if (isWindows) {
    writeFileSync(command, `@echo off\r\necho RAN > "${marker}"\r\necho ${frame}\r\n`);
  } else {
    writeFileSync(command, `#!/bin/sh\necho RAN > "${marker}"\nprintf '%s\\n' '${frame}'\n`);
    chmodSync(command, 0o755);
  }
  return { command, marker };
}

interface Options {
  binding?: string;
  admit?: string;
  runtime?: string;
  lifecycleMode?: string;
}

/** Spawn the real server over stdio, call spawn_fleet once, return the response line. */
function callSpawnFleet(dir: string, port: string, opts: Options): Promise<string> {
  const { command } = writeFakeRuntime(dir);
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      // All THREE: MESHFLEET_DB_FILE alone is not isolation — the migrator pairs a redirected
      // destination with a defaulted source and renames the operator's real ledger.
      MESHFLEET_DB_FILE: join(dir, "l.db"),
      MESHFLEET_DATA_FILE: join(dir, "l.json"),
      MESHFLEET_EVENT_LOG_FILE: join(dir, "e.log"),
      AGENT_MESH_CHILD: "1",
      MESHFLEET_SSE_PORT: port,
      MESHFLEET_KIMI_COMMAND: command,
    };
    if (opts.admit !== undefined) env.MESHFLEET_KIMI_WORKSPACE_BINDINGS = opts.admit;
    else delete env.MESHFLEET_KIMI_WORKSPACE_BINDINGS;
    if (opts.lifecycleMode !== undefined) env.MESHFLEET_LIFECYCLE_MODE = opts.lifecycleMode;
    else delete env.MESHFLEET_LIFECYCLE_MODE;

    const p = spawn("node", [join(repoRoot, "dist", "index.js")], {
      cwd: dir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    const send = (o: unknown) => p.stdin.write(JSON.stringify(o) + "\n");
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    const agent: Record<string, unknown> = { role: "w", prompt: "do the thing" };
    if (opts.runtime !== undefined) agent.runtime = opts.runtime;
    if (opts.binding !== undefined) agent.workspace_binding = opts.binding;
    setTimeout(
      () => send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "spawn_fleet", arguments: { agents: [agent] } } }),
      600,
    );
    const timer = setTimeout(() => { p.kill(); reject(new Error("timeout")); }, 25000);
    // Spawning is a side effect that happens AFTER the response is written, so reading the
    // response is not enough — wait for the child to actually run before looking at the marker.
    setTimeout(() => {
      clearTimeout(timer);
      const line = out.split("\n").find((l) => l.includes('"id":2')) ?? "NO RESPONSE";
      p.on("close", () => resolve(line));
      p.kill();
    }, 4500);
  });
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-runs-"));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
}

/**
 * What the ledger recorded about the single agent, for the failure message.
 *
 * The adapter deliberately never projects a child's stderr — Kimi diagnostics may echo prompts and
 * authentication details — so a bare "the marker is missing" assertion cannot distinguish "the
 * runtime was never selected" from "the runtime was selected and the OS refused to start it". The
 * agent row's normalized `error` is the only evidence that survives, and this repo's scar is to
 * PROBE rather than predict: three attempts to guess wire classifications failed where reading the
 * actual output worked first try.
 */
function agentDiagnostic(dir: string): string {
  const db = join(dir, "l.db");
  if (!existsSync(db)) return "no ledger was created";
  try {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    const handle = new Database(db, { readonly: true });
    // The agents table is (id, fleet_id, data) — the row is a JSON blob, not columns. Selecting
    // `status` directly threw "no such column" on the first instrumented run.
    const row = handle.prepare("SELECT data FROM agents LIMIT 1").get() as { data?: string } | undefined;
    handle.close();
    if (!row?.data) return "no agent row";
    const agent = JSON.parse(row.data) as Record<string, unknown>;
    return JSON.stringify({ status: agent.status, error: agent.error, output: agent.output, pid: agent.pid });
  } catch (err) {
    return `ledger unreadable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

test("a selected runtime is actually invoked", async () => {
  await withDir(async (dir) => {
    const res = await callSpawnFleet(dir, "13971", { runtime: "kimi-cli", binding: "ws-1", admit: "ws-1" });
    assert.match(res, /fleet_id/, "the call itself must succeed");
    assert.ok(
      existsSync(join(dir, "INVOKED")),
      "spawn_fleet accepted runtime 'kimi-cli' and returned a fleet_id without ever invoking it — " +
        `a fleet_id is not evidence that the selected harness ran. Agent row: ${agentDiagnostic(dir)}`,
    );
  });
});

test("NEGATIVE CONTROL: the caller's claim alone admits nothing", async () => {
  // Caller key present, operator key absent. If this passes the runtime would run on the caller's
  // unverified say-so, which is the whole reason the admission list exists.
  await withDir(async (dir) => {
    await callSpawnFleet(dir, "13972", { runtime: "kimi-cli", binding: "ws-1" });
    assert.ok(!existsSync(join(dir, "INVOKED")), "an unadmitted binding must not reach the runtime");
  });
});

test("NEGATIVE CONTROL: an admission list alone admits nothing", async () => {
  // Operator key present, caller key absent.
  await withDir(async (dir) => {
    await callSpawnFleet(dir, "13973", { runtime: "kimi-cli", admit: "ws-1" });
    assert.ok(!existsSync(join(dir, "INVOKED")), "configuration must not silently supply the caller's claim");
  });
});

test("NEGATIVE CONTROL: a binding that is not the admitted one is refused", async () => {
  await withDir(async (dir) => {
    await callSpawnFleet(dir, "13974", { runtime: "kimi-cli", binding: "ws-9", admit: "ws-1" });
    assert.ok(!existsSync(join(dir, "INVOKED")), "admission must match the named binding, not merely be non-empty");
  });
});

test("CONTROL: omitting runtime never reaches the non-default runtime", async () => {
  // Without this, every assertion above would hold just as well if MeshFleet invoked the fake
  // runtime for EVERY agent — the tests would be measuring nothing about selection.
  await withDir(async (dir) => {
    const res = await callSpawnFleet(dir, "13975", { binding: "ws-1", admit: "ws-1" });
    assert.match(res, /fleet_id/, "the default path must still work");
    assert.ok(!existsSync(join(dir, "INVOKED")), "an agent that selected nothing must not run under a selected runtime");
  });
});

test("durable mode refuses a per-agent runtime instead of silently downgrading it", async () => {
  // A durable respawn rehydrates from the agent row, and the row has no runtime column. Honouring
  // the selection on the first attempt and losing it on recovery is worse than refusing: it is the
  // same "ran somewhere the caller did not ask for" defect, only harder to see.
  await withDir(async (dir) => {
    const res = await callSpawnFleet(dir, "13976", {
      runtime: "kimi-cli", binding: "ws-1", admit: "ws-1", lifecycleMode: "durable",
    });
    assert.match(res, /durable/, "the refusal must name the mode that cannot support it");
    assert.ok(!res.includes("fleet_id"), `expected a refusal, got: ${res.slice(0, 200)}`);
    assert.ok(!existsSync(join(dir, "INVOKED")), "a refused call must not spawn anything");
  });
});
