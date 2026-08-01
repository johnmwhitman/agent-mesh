/**
 * `spawn_fleet` accepts a per-agent `runtime`, and refuses an unknown one before writing anything.
 *
 * Until now every spawned agent was an `opencode` session — `getDefaultRuntimeAdapter()` is a
 * module-level constant and the tool surface had no way to ask for anything else. That means ONE
 * provider backs an entire fleet: when it refuses (grok returned 402 "usage balance exhausted" on
 * 2026-07-31) every agent in every fleet dies at the same moment while other subscriptions sit
 * idle. `model` was already selectable, but `model` picks a model WITHIN opencode; it cannot pick
 * a different harness.
 *
 * The refusal is asserted BY ROW COUNTS, not by the response shape. A handler can return an error
 * and still have written — and resolving the runtime lazily inside `trySpawn` would do exactly
 * that, throwing only after the fleet row was committed and leaving a ledger that records a fleet
 * whose agents never start.
 *
 * The accepted-call leg is the CONTROL. Without it these tests would pass just as happily if
 * `spawn_fleet` had started refusing everything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function callTool(dir: string, args: unknown, port: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [join(repoRoot, "dist", "index.js")], {
      env: {
        ...process.env,
        // All THREE: MESHFLEET_DB_FILE alone is not isolation — the migrator pairs a redirected
        // destination with a defaulted source and renames the operator's real ledger.
        MESHFLEET_DB_FILE: join(dir, "l.db"),
        MESHFLEET_DATA_FILE: join(dir, "l.json"),
        MESHFLEET_EVENT_LOG_FILE: join(dir, "e.log"),
        AGENT_MESH_CHILD: "1",
        MESHFLEET_SSE_PORT: port,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    const send = (o: unknown) => p.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize",
           params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/call",
                            params: { name: "spawn_fleet", arguments: args } }), 400);
    const timer = setTimeout(() => { p.kill(); reject(new Error("timeout")); }, 20000);
    p.stdout.on("data", () => {
      const line = out.split("\n").find((l) => l.includes('"id":2'));
      if (!line) return;
      clearTimeout(timer);
      // Settle on close: kill() returns when the SIGNAL is delivered, not when the process is
      // gone, and the caller deletes this directory next.
      p.on("close", () => resolve(line));
      p.kill();
    });
  });
}

function agentRows(dir: string): number {
  const Database = require("better-sqlite3");
  // A refusal returns before the ledger is opened at all, so the file does not exist. That is
  // stronger evidence than a zero count — and it is only sound because the control below proves
  // an accepted call DOES create it.
  if (!existsSync(join(dir, "l.db"))) return 0;
  const db = new Database(join(dir, "l.db"), { readonly: true });
  const n = db.prepare("SELECT count(*) AS n FROM agents").get().n as number;
  db.close();
  return n;
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-runtime-"));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
}

test("an unknown runtime is refused, and nothing is written", async () => {
  await withDir(async (dir) => {
    const res = await callTool(dir, { agents: [{ role: "r", prompt: "p", runtime: "no-such-runtime" }] }, "13961");
    assert.match(res, /unknown runtime/, "the refusal must name the problem");
    assert.match(res, /no-such-runtime/, "and quote the offending id");
    assert.ok(!res.includes("fleet_id"), `expected a refusal, got a fleet: ${res.slice(0, 200)}`);
    assert.equal(agentRows(dir), 0, "a refused spawn_fleet must not commit an agent row");
  });
});

test("the refusal lists what IS available, so the caller can correct it", async () => {
  await withDir(async (dir) => {
    const res = await callTool(dir, { agents: [{ role: "r", prompt: "p", runtime: "nope" }] }, "13962");
    assert.match(res, /opencode-cli/, "an error that does not say what IS valid makes the caller guess");
  });
});

test("CONTROL: omitting runtime still spawns under the default", async () => {
  await withDir(async (dir) => {
    const res = await callTool(dir, { agents: [{ role: "reviewer", prompt: "review it" }] }, "13963");
    assert.match(res, /fleet_id/, "a request with no runtime must still work");
    assert.equal(agentRows(dir), 1, "the control must commit exactly one agent");
  });
});

test("naming the default runtime explicitly is accepted", async () => {
  await withDir(async (dir) => {
    const res = await callTool(dir, { agents: [{ role: "r", prompt: "p", runtime: "opencode-cli" }] }, "13964");
    assert.match(res, /fleet_id/, "a registered runtime must be selectable by name");
    assert.equal(agentRows(dir), 1);
  });
});

test("one bad runtime refuses the WHOLE fleet — no partial spawn", async () => {
  // A fleet is a unit. Spawning the valid agents and dropping the invalid one would leave a fleet
  // that can never reach a terminal state, which is the defect the abandoned-fleet lattice exists
  // to clean up after.
  await withDir(async (dir) => {
    const res = await callTool(dir, {
      agents: [{ role: "ok", prompt: "p" }, { role: "bad", prompt: "p", runtime: "nope" }],
    }, "13965");
    assert.match(res, /unknown runtime/);
    assert.equal(agentRows(dir), 0, "no agent may be committed when any agent in the fleet is invalid");
  });
});
