/**
 * spawn_fleet and attach_agent must refuse a schema-violating request BEFORE
 * they write the ledger or start a process.
 *
 * The MCP SDK enforces neither `required` nor `type` from a published
 * inputSchema, and `toolHandlers` is typed `(args: any)`. Both handlers opened
 * with a blind `args as {...}` cast, so `{"agents":[{"role":"reviewer"}]}` —
 * which omits the schema-REQUIRED `prompt` — returned a normal success with a
 * fleet_id, committed a fleet plus an agent row whose prompt was NULL, and
 * called trySpawn. Measured before the fix, over real MCP stdio.
 *
 * This is the fourth appearance of that family (register_capability's
 * snake/camel mismatch, cast_vote's `"false"` truthiness, the four Discussions
 * tools) and the highest blast radius of the four: the others returned a wrong
 * read or wrote a bad row, these two START AN OS PROCESS.
 *
 * The assertions are by ROW COUNT, not by the response shape. A handler could
 * return an error and still have written — proving refusal means proving the
 * ledger never moved. The accepted-call leg is the control: without it, these
 * tests would pass just as happily if spawn_fleet refused everything.
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

/** Drive the real server over stdio and return the response to one tool call. */
function callTool(dir: string, name: string, args: unknown, port: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [join(repoRoot, "dist", "index.js")], {
      env: {
        ...process.env,
        // All THREE. MESHFLEET_DB_FILE alone is not isolation: the migrator pairs
        // a redirected destination with a defaulted source and renames the real
        // ledger. The event-log var is the one that is easy to forget, and a
        // spawned child inherits environment, not module state.
        MESHFLEET_DB_FILE: join(dir, "l.db"),
        MESHFLEET_DATA_FILE: join(dir, "l.json"),
        MESHFLEET_EVENT_LOG_FILE: join(dir, "e.log"),
        AGENT_MESH_CHILD: "1",
        // An explicit unusual port: ssePort() accepts only v > 0, so "0" is not
        // "ephemeral" here, it silently falls back to the default the operator's
        // live instance actually holds.
        MESHFLEET_SSE_PORT: port,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const send = (o: unknown) => p.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize",
           params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }), 400);
    const timer = setTimeout(() => { p.kill(); reject(new Error(`timeout; stderr=${err.slice(0, 400)}`)); }, 20000);
    p.stdout.on("data", () => {
      const line = out.split("\n").find((l) => l.includes('"id":2'));
      if (!line) return;
      clearTimeout(timer);
      // p.kill() returns when the SIGNAL IS DELIVERED, not when the process is
      // gone. Settle on close so every handle on the ledger is released before
      // the caller deletes the directory — POSIX tolerates the race, Windows
      // does not.
      p.on("close", () => resolve(JSON.parse(line)));
      p.kill();
    });
  });
}

function ledgerCounts(dir: string) {
  const Database = require("better-sqlite3");
  // A refused call returns before the ledger is ever opened, so the db FILE does
  // not exist (SQLITE_CANTOPEN). That is stronger evidence than a zero row count,
  // not weaker — nothing was written because nothing was even initialised. It is
  // only sound because the accepted-call control below proves a valid request DOES
  // create this file; without that leg, "no file" would be indistinguishable from
  // a broken harness.
  if (!existsSync(join(dir, "l.db"))) return { fleets: 0, agents: 0 };
  const db = new Database(join(dir, "l.db"), { readonly: true });
  const one = (t: string) => db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n as number;
  const counts = { fleets: one("fleets"), agents: one("agents") };
  db.close();
  return counts;
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-contract-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

test("spawn_fleet refuses an agent missing the required prompt, and writes nothing", async () => {
  await withDir(async (dir) => {
    const res = await callTool(dir, "spawn_fleet", { agents: [{ role: "reviewer" }] }, "13921");
    const text = JSON.stringify(res);
    assert.ok(!text.includes("fleet_id"), `expected a refusal, got a fleet: ${text.slice(0, 200)}`);
    assert.match(text, /prompt/, "the refusal should name the offending field");
    const { fleets, agents } = ledgerCounts(dir);
    assert.equal(fleets, 0, "a refused spawn_fleet must not commit a fleet");
    assert.equal(agents, 0, "a refused spawn_fleet must not commit an agent row");
  });
});

test("spawn_fleet refuses a non-string role, and writes nothing", async () => {
  await withDir(async (dir) => {
    const res = await callTool(dir, "spawn_fleet", { agents: [{ role: 123, prompt: "go" }] }, "13922");
    assert.ok(!JSON.stringify(res).includes("fleet_id"), "expected a refusal for a numeric role");
    assert.equal(ledgerCounts(dir).agents, 0, "a refused spawn_fleet must not commit an agent row");
  });
});

test("spawn_fleet still accepts a well-formed request — the control", async () => {
  await withDir(async (dir) => {
    const res = await callTool(dir, "spawn_fleet", { agents: [{ role: "reviewer", prompt: "review it" }] }, "13923");
    assert.match(JSON.stringify(res), /fleet_id/, "a valid request must still spawn");
    const { fleets, agents } = ledgerCounts(dir);
    assert.equal(fleets, 1, "the control must commit exactly one fleet");
    assert.equal(agents, 1, "the control must commit exactly one agent");
  });
});

test("attach_agent refuses a missing prompt, and writes nothing", async () => {
  await withDir(async (dir) => {
    const res = await callTool(dir, "attach_agent", { fleet_id: "f1", role: "reviewer" }, "13924");
    const text = JSON.stringify(res);
    assert.match(text, /prompt/, "the refusal should name the offending field");
    assert.equal(ledgerCounts(dir).agents, 0, "a refused attach_agent must not commit an agent row");
  });
});
