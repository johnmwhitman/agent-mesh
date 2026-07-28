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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
        // Every accepted-call control reaches the real spawn path. Keep those
        // boundary tests hermetic: the previous helper launched the user's real
        // OpenCode and then killed only the MCP parent, orphaning one provider
        // process per accepted seed call.
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
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
    const binDir = join(dir, "bin");
    const opencodePath = join(binDir, "opencode");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      opencodePath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const modelIndex = args.indexOf("--model");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "openai/gpt-5";
process.stdout.write("boundary test complete\\n");
process.stderr.write("> boundary-test · " + model + "\\n");
`,
      { mode: 0o755 },
    );
    chmodSync(opencodePath, 0o755);
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

function readAgents(dir: string): Array<Record<string, unknown>> {
  if (!existsSync(join(dir, "l.db"))) return [];
  const Database = require("better-sqlite3");
  const db = new Database(join(dir, "l.db"), { readonly: true });
  try {
    const rows = db.prepare("SELECT data FROM agents").all() as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

function toolIsError(res: any): boolean {
  return Boolean(res?.result?.isError ?? res?.isError);
}

function hasSpawnObservation(dir: string): boolean {
  const log = join(dir, "e.log");
  if (!existsSync(log)) return false;
  return readFileSync(log, "utf8").includes("agent_spawned");
}

test("spawn_fleet persists a valid requested model", async () => {
  await withDir(async (dir) => {
    const res = await callTool(dir, "spawn_fleet", {
      agents: [{
        role: "builder",
        prompt: "build",
        model: "opencode-go/minimax-m3",
      }],
    }, "13930");
    assert.equal(toolIsError(res), false, JSON.stringify(res).slice(0, 300));
    const agents = readAgents(dir);
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.requested_model, "opencode-go/minimax-m3");
  });
});

test("attach_agent persists a valid requested model", async () => {
  await withDir(async (dir) => {
    const spawned = await callTool(dir, "spawn_fleet", {
      agents: [{ role: "seed", prompt: "seed fleet" }],
    }, "13931");
    assert.equal(toolIsError(spawned), false);
    const fleetId = JSON.parse(
      (spawned.result ?? spawned).content[0].text,
    ).fleet_id as string;

    const res = await callTool(dir, "attach_agent", {
      fleet_id: fleetId,
      role: "builder",
      prompt: "build",
      model: "opencode-go/minimax-m3",
    }, "13932");
    assert.equal(toolIsError(res), false, JSON.stringify(res).slice(0, 300));
    const withModel = readAgents(dir).filter((a) => a.requested_model !== undefined);
    assert.equal(withModel.length, 1);
    assert.equal(withModel[0]?.requested_model, "opencode-go/minimax-m3");
  });
});

test("spawn_fleet omits requested_model when model is absent", async () => {
  await withDir(async (dir) => {
    const res = await callTool(dir, "spawn_fleet", {
      agents: [{ role: "reviewer", prompt: "review it" }],
    }, "13933");
    assert.equal(toolIsError(res), false);
    const agent = readAgents(dir)[0];
    assert.ok(agent);
    assert.equal(Object.prototype.hasOwnProperty.call(agent, "requested_model"), false);
  });
});

test("attach_agent omits requested_model when model is absent", async () => {
  await withDir(async (dir) => {
    const spawned = await callTool(dir, "spawn_fleet", {
      agents: [{ role: "seed", prompt: "seed fleet" }],
    }, "13934");
    const fleetId = JSON.parse(
      (spawned.result ?? spawned).content[0].text,
    ).fleet_id as string;
    const res = await callTool(dir, "attach_agent", {
      fleet_id: fleetId,
      role: "reviewer",
      prompt: "review",
    }, "13935");
    assert.equal(toolIsError(res), false);
    const attached = readAgents(dir).find((a) => a.role === "reviewer");
    assert.ok(attached);
    assert.equal(Object.prototype.hasOwnProperty.call(attached, "requested_model"), false);
  });
});

const INVALID_MODELS: Array<{ label: string; model: unknown }> = [
  { label: "non-string", model: 42 },
  { label: "null", model: null },
  { label: "empty", model: "" },
  { label: "whitespace", model: "   " },
  { label: "no slash", model: "minimax-m3" },
  { label: "empty provider", model: "/minimax-m3" },
  { label: "empty model", model: "kilo/" },
  { label: "embedded whitespace", model: "kilo /minimax" },
  { label: "257-character selector", model: `${"p".repeat(128)}/${"m".repeat(128)}` },
];

for (const [i, { label, model }] of INVALID_MODELS.entries()) {
  test(`spawn_fleet refuses ${label} model before any write`, async () => {
    await withDir(async (dir) => {
      const res = await callTool(dir, "spawn_fleet", {
        agents: [{ role: "builder", prompt: "build", model }],
      }, String(13940 + i));
      assert.equal(toolIsError(res), true, `expected refusal for ${label}: ${JSON.stringify(res).slice(0, 200)}`);
      assert.match(JSON.stringify(res), /model/i);
      assert.equal(ledgerCounts(dir).agents, 0, `refused ${label} must not commit an agent row`);
      assert.equal(ledgerCounts(dir).fleets, 0, `refused ${label} must not commit a fleet`);
      assert.equal(hasSpawnObservation(dir), false, `refused ${label} must not spawn`);
    });
  });
}

for (const [i, { label, model }] of INVALID_MODELS.entries()) {
  test(`attach_agent refuses ${label} model before any write`, async () => {
    await withDir(async (dir) => {
      const spawned = await callTool(dir, "spawn_fleet", {
        agents: [{ role: "seed", prompt: "seed fleet" }],
      }, String(13960 + i));
      const before = ledgerCounts(dir).agents;
      const fleetId = JSON.parse(
        (spawned.result ?? spawned).content[0].text,
      ).fleet_id as string;
      const res = await callTool(dir, "attach_agent", {
        fleet_id: fleetId,
        role: "builder",
        prompt: "build",
        model,
      }, String(13980 + i));
      assert.equal(toolIsError(res), true, `expected refusal for ${label}`);
      assert.match(JSON.stringify(res), /model/i);
      assert.equal(ledgerCounts(dir).agents, before, `refused attach ${label} must not add an agent row`);
      // seed spawn may have observed; attach refusal must not add a second agent_spawned for the refused call.
      // Agent count is the hard ledger boundary.
    });
  });
}
