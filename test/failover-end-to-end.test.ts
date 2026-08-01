/**
 * An agent whose runtime refuses is respawned on another runtime, and the ledger records the hop.
 *
 * This is the whole point of per-agent runtimes. Until now one provider backed every agent in
 * every fleet: when it refused for quota — grok returned 402 during a live run on 2026-07-31 —
 * every agent died at the same moment while other subscriptions sat idle, and the retry budget was
 * spent re-asking the runtime that had just said no.
 *
 * The proof is the SECOND runtime's own output, and a durable `runtime_attempts` list naming both.
 * A completed agent alone would not distinguish a hop from a lucky retry, and an event line alone
 * would not show in the ledger the audit reads.
 *
 * WINDOWS: skipped, and this is a fixture limit, not a product one. Both halves need a stub the OS
 * will execute, `child_process.spawn` refuses a `.bat`/`.cmd` without `shell: true` (which this
 * repo's process layer deliberately never sets), and a test cannot author a `.exe`. Unlike the
 * runtime-selection suite there is no surviving Windows-visible signal to fall back on: a stub
 * that cannot start produces "failed to start", which is correctly NOT a provider refusal, so
 * there would be no hop to observe. `failover-decision.test.ts` covers the reasoning on every
 * platform.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skipOnWindows = platform() === "win32"
  ? { skip: "needs an executable stub; spawn refuses .cmd without a shell and a test cannot author a .exe" }
  : {};

const ESC = String.fromCharCode(27);
/**
 * The REAL grok refusal, measured 2026-07-31 during a live fleet run. It matches the repo's
 * provider patterns on its `API 429 for` line — a plausible-looking invention would only test the
 * pattern against my own idea of what a provider says.
 */
const REAL_REFUSAL =
  `${ESC}[0m` + "\n> ultraworker · grok-4.3\n" +
  "opencode-claude-auth: API 429 for claude-haiku-4-5: This request would exceed your account's rate limit.\n" +
  "Error: Forbidden: You have run out of credits or need a Grok subscription.\n";

function writeStub(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

interface Options {
  /** stderr the stubbed default runtime emits before exiting nonzero. */
  refusal?: string;
  model?: string;
  admit?: boolean;
}

function agentRow(dir: string): Record<string, unknown> | undefined {
  const db = join(dir, "l.db");
  if (!existsSync(db)) return undefined;
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3");
  const handle = new Database(db, { readonly: true });
  const row = handle.prepare("SELECT data FROM agents LIMIT 1").get() as { data?: string } | undefined;
  handle.close();
  return row?.data ? JSON.parse(row.data) : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runFleet(dir: string, port: string, opts: Options): Promise<Record<string, unknown> | undefined> {
  const marker = join(dir, "KIMI-DID-THE-WORK");
  // The default runtime refuses the way the live provider did, then exits nonzero.
  writeStub(join(dir, "fake-opencode"), `cat >/dev/null\nprintf '%s' ${JSON.stringify(opts.refusal ?? REAL_REFUSAL)} >&2\nexit 1`);
  // The backup runtime does real work: it writes a file and emits one valid final frame.
  writeStub(join(dir, "fake-kimi"), `cat >/dev/null\necho DID > "${marker}"\nprintf '%s\\n' '{"role":"assistant","content":"ok"}'`);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // All THREE: MESHFLEET_DB_FILE alone is not isolation — the migrator pairs a redirected
    // destination with a defaulted source and renames the operator's real ledger.
    MESHFLEET_DB_FILE: join(dir, "l.db"),
    MESHFLEET_DATA_FILE: join(dir, "l.json"),
    MESHFLEET_EVENT_LOG_FILE: join(dir, "e.log"),
    AGENT_MESH_CHILD: "1",
    MESHFLEET_SSE_PORT: port,
    MESHFLEET_OPENCODE_COMMAND: join(dir, "fake-opencode"),
    MESHFLEET_KIMI_COMMAND: join(dir, "fake-kimi"),
    MESHFLEET_RETRY_BASE_MS: "1",
  };
  if (opts.admit !== false) env.MESHFLEET_KIMI_WORKSPACE_BINDINGS = "ws-1";
  else delete env.MESHFLEET_KIMI_WORKSPACE_BINDINGS;

  const p = spawn("node", [join(repoRoot, "dist", "index.js")], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  const send = (o: unknown) => p.stdin.write(JSON.stringify(o) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });

  // No `runtime`: this is the DEFAULT path failing over, which is the case that matters. An agent
  // that named a runtime already knew about the second one.
  const agent: Record<string, unknown> = { role: "w", prompt: "do the thing", workspace_binding: "ws-1" };
  if (opts.model) agent.model = opts.model;
  await sleep(600);
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "spawn_fleet", arguments: { agents: [agent] } } });

  // Wait for the outcome, never a fixed sleep: a fixed window measures the runner's speed, which
  // is how the runtime-selection suite first went red on Windows and green everywhere else.
  const deadline = Date.now() + 40_000;
  let row: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    await sleep(250);
    if (!out.includes('"id":2')) continue;
    row = agentRow(dir);
    if (row && (row.status === "complete" || row.status === "failed")) break;
  }
  await new Promise<void>((r) => { p.on("close", () => r()); p.kill(); });
  return row;
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-failover-"));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
}

test("a refused agent is respawned on another runtime and finishes the work", skipOnWindows, async () => {
  await withDir(async (dir) => {
    const row = await runFleet(dir, "13981", {});
    assert.ok(row, "the agent row must exist");
    assert.equal(row.status, "complete", `the agent must finish on the backup runtime: ${JSON.stringify(row)}`);
    assert.ok(
      existsSync(join(dir, "KIMI-DID-THE-WORK")),
      "the backup runtime must have done real work, not merely been selected",
    );
    assert.deepEqual(
      row.runtime_attempts,
      ["opencode-cli", "kimi-cli"],
      `the ledger must record the hop in order: ${JSON.stringify(row.runtime_attempts)}`,
    );
  });
});

test("the hop is recorded as an event naming both runtimes", skipOnWindows, async () => {
  await withDir(async (dir) => {
    await runFleet(dir, "13982", {});
    const log = readFileSync(join(dir, "e.log"), "utf8");
    const hop = log.split("\n").filter((l) => l.includes("agent_runtime_failover"));
    assert.equal(hop.length, 1, `exactly one failover event expected, got ${hop.length}`);
    assert.match(hop[0], /"from_runtime":"opencode-cli"/);
    assert.match(hop[0], /"to_runtime":"kimi-cli"/);
  });
});

test("NEGATIVE CONTROL: a failure that is not a provider refusal does not hop", skipOnWindows, async () => {
  // The stub still fails, but says nothing a provider would say. Burning a second subscription to
  // re-learn a broken prompt is the amplification this gate exists to prevent.
  await withDir(async (dir) => {
    const row = await runFleet(dir, "13983", { refusal: "TypeError: cannot read property of undefined\n" });
    assert.ok(row, "the agent row must exist");
    assert.equal(row.status, "failed", "it must fail rather than quietly succeed elsewhere");
    assert.ok(!existsSync(join(dir, "KIMI-DID-THE-WORK")), "the backup runtime must not have run");
    assert.deepEqual(row.runtime_attempts, ["opencode-cli"], "no hop may be recorded");
  });
});

test("NEGATIVE CONTROL: a pinned model is not carried to another harness", skipOnWindows, async () => {
  await withDir(async (dir) => {
    const row = await runFleet(dir, "13984", { model: "opencode-go/minimax-m3" });
    assert.ok(row, "the agent row must exist");
    assert.ok(!existsSync(join(dir, "KIMI-DID-THE-WORK")), "a pinned model must not be run on a different harness");
    assert.deepEqual(row.runtime_attempts, ["opencode-cli"], "no hop may be recorded");
  });
});

test("NEGATIVE CONTROL: no hop to a runtime that cannot accept the spec", skipOnWindows, async () => {
  // Kimi is registered and would take the work, but without an admitted workspace binding it
  // refuses every permission mode — so hopping there would spend an attempt on a certain refusal.
  await withDir(async (dir) => {
    const row = await runFleet(dir, "13985", { admit: false });
    assert.ok(row, "the agent row must exist");
    assert.ok(!existsSync(join(dir, "KIMI-DID-THE-WORK")), "the backup runtime could not have accepted this spec");
    assert.deepEqual(row.runtime_attempts, ["opencode-cli"], "no hop may be recorded");
  });
});
