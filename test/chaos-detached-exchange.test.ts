/**
 * Chaos durability: a MeshFleet worker SURVIVES the death of the MCP server process that
 * spawned it.
 *
 * Reproduces the rally-track-A finding of 2026-09-07 (seat fable-5.1). The seat's receipt
 * `checks/meshfleet-detached-exchange.sh` exercises the same property over raw stdio:
 * process A calls spawn_fleet through the live MCP server, the server is then terminated as a
 * finished dispatch turn does, and a fresh process B collects. The seat's exchange hit
 * `delivered: 0, lost: 1, "MCP server crashed before this agent completed … process_lost"` —
 * the agent's row decayed to `interrupted, stopped_reason: "process_lost"` because the legacy
 * spawn path had no orphan-survival mechanism.
 *
 * The seat prescribed two acceptable structural repairs:
 *   (a) detach the child (own process group, no inherited stdio pipes to the server) AND
 *       observe-time reconciliation that promotes the orphan's RESULT_PATH envelope to
 *       `complete`/`failed` on the next `collect_results`, OR
 *   (b) route one-shot submitters through durable lifecycle mode by default.
 *
 * This test pins (a). The detached-spawn is structural (process.ts spawns each child as a
 * POSIX process-group leader so SIGTERM doesn't cascade); the orphan-survival is the
 * `reconcileOrphanedAgentsInFleet` reconciliation in core.ts that `collect_results` invokes
 * before summarising. (b) is a separate lane with its own coordinator; mixing modes is
 * not a goal of this test. The combined property the seat pins (`expected: 0` against
 * `delivered = 0, lost = 1`) is the structural separation PLUS the observe-time
 * reconciliation: a worker that survives AND whose envelope is honoured by the next reader.
 *
 * The seat's exact receipt runs against the operator-installed binary at
 * `~/.claude.json["mcpServers"]["meshfleet"]["args"][0]`; this test runs against the WORKTREE'S
 * built binary so it stays in CI. It uses a fake sleeper opencode binary so the worker is
 * deterministic in DURATION (no operator CLI required) — the property under test is
 * fleet-lifecycle durability, not runtime coverage.
 *
 * The test FAILS — never skips — when the property does not hold; a flaky spawn is a defect,
 * not a passing test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { closeDb } from "../src/db.js";
import { loadData } from "../src/core.js";
import { withTempDb } from "./helpers/with-temp-db.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const serverTs = join(repoRoot, "src", "index.ts");
const nodeBin = process.env.MESHFLEET_CHAOS_NODE ?? process.execPath;

interface FleetResponse { fleet_id: string; agent_ids: string[] }
interface CollectionSummary {
  total: number;
  delivered: number;
  lost: number;
  still_running: number;
  warning?: string;
  /** Per-agent rows returned by `collect_results` (status, output, error, etc.). */
  results?: Array<{ role: string; status: string; output?: string; error?: string; result_contract?: string; stopped_reason?: string }>;
}

interface ChildServer {
  client: Client;
  transport: StdioClientTransport;
  pid: number;
  kill: () => Promise<void>;
  exited: Promise<number>;
}

async function spawnMcpxServer(env: Record<string, string>): Promise<ChildServer> {
  const transport = new StdioClientTransport({
    command: nodeBin,
    args: ["--import", "tsx", serverTs],
    env,
    cwd: repoRoot,
    stderr: "pipe",
  });
  (transport.stderr as NodeJS.ReadableStream | null)?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[server stderr] ${chunk.toString()}`);
  });
  const client = new Client({ name: "chaos-detached-exchange", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const proc = (transport as unknown as { _process?: { pid?: number; once?: (ev: string, cb: (c: number | null, s: NodeJS.Signals | null) => void) => void } })._process;
  assert.ok(proc && typeof proc.pid === "number", "StdioClientTransport must expose a real child pid");
  const pid = proc.pid;
  const exited = new Promise<number>((resolve) => {
    proc.once?.("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      resolve(code ?? (signal ? 128 : 0));
    });
  });
  return {
    client,
    transport,
    pid,
    exited,
    kill: async (): Promise<void> => {
      try { process.kill(pid, "SIGTERM"); } catch { /* may already be gone */ }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      try { process.kill(pid, "SIGKILL"); } catch { /* still gone */ }
    },
  };
}

async function waitForFile(path: string, budgetMs: number, label: string): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitForFile budget exhausted (${budgetMs}ms) waiting for: ${label} (path=${path})`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, budgetMs: number, label: string): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`waitFor budget exhausted (${budgetMs}ms) waiting for: ${label}`);
}

async function parseToolText<T>(result: unknown): Promise<T> {
  // MCP SDK's callTool returns `{ content: Array<{type, text?, ...}>, isError?, _meta? }` —
  // an envelope without a discriminator, structurally richer than the narrow type the test
  // declares locally. The contract we promise callers is the text-from-the-first-content-block
  // shape. We extract here so the rest of the test can stay typed and avoid re-parsing the
  // same JSON string in every assertion.
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  const text = content.find((c) => c?.type === "text")?.text ?? "";
  return JSON.parse(text) as T;
}

/**
 * Build a fake `opencode` binary that:
 *   - writes `invoked` so the test can confirm the worker was actually spawned,
 *   - sleeps for SLEEP_MS so we have a guaranteed working window to kill the submitter mid-flight,
 *   - then writes `done` and exits 0 — so the durable-lane re-launch by process B succeeds too.
 *
 * The binary is a small Node script invoked through a temp-dir shebang. `MESHFLEET_OPENCODE_COMMAND`
 * points the operator-configurable adapter at it for the duration of the test (the adapter
 * reads the env var unconditionally; see registry.ts:42).
 */
function buildFakeOpencode(dir: string, sleepMs: number, invokedPath: string, donePath: string): string {
  const fakeBin = join(dir, process.platform === "win32" ? "opencode.exe" : "opencode");
  // The runner feeds a result envelope file via RESULT_PATH and a per-attempt argv to the
  // child. A real opencode would speak its NDJSON protocol on stdout AND write the result
  // contract envelope to RESULT_PATH — the FAKE must do both shapes:
  //   1. Write a non-empty NDJSON stream to stdout so the adapter's classifier doesn't
  //      fail-closed on "Spawn exited without output (empty stdout)" (spawn-result.ts:312).
  //   2. Write a valid result envelope JSON to the path in $RESULT_PATH so settle-time
  //      contract checks bank the work as `complete` instead of `failed` for
  //      `result_contract=absent`.
  // Both halves are required for the agent to seal cleanly. A real opencode emits the same
  // pair; this fake just shrinks the work.
  const script = [
    'const fs = require("node:fs");',
    // Write the invoked marker immediately so the test can confirm the worker started,
    // BEFORE the durable server dies. The marker file is the synchronous signal the test
    // uses to prove the race window.
    `fs.writeFileSync(${JSON.stringify(invokedPath)}, "invoked");`,
    // The minimal valid opencode NDJSON line: type "step_finish" with a finish reason. The
    // spawn-result classifier requires `stdout.trim() !== ""`; ONE line is sufficient.
    "const sessionId = \"oc-session-\" + process.pid;",
    "const out = (o) => process.stdout.write(JSON.stringify(o) + \"\\n\");",
    "out({ type: \"step_start\", sessionID: sessionId, timestamp: Date.now() });",
    "const summary = process.argv.slice(2).join(\" \").trim() || \"ok\";",
    `setTimeout(() => {`,
    `  out({ type: "text", sessionID: sessionId, part: { text: "pong-from-fake-opencode" }, timestamp: Date.now() });`,
    `  out({ type: "step_finish\", sessionID: sessionId, reason: "stop", timestamp: Date.now() });`,
    // Write the result contract envelope. RESULT_PATH is set by the OpenCode adapter via
    // env (withResultContract + env.RESULT_PATH injection in index.ts). A absent / unset
    // path is a real defect — fail-closed; the test's boot env wires the opencode adapter
    // with the proper RESULT_PATH injection path through buildExecutionSpec.
    "  const resultPath = process.env.RESULT_PATH;",
    "  if (typeof resultPath !== \"string\" || resultPath.length === 0) {",
    "    process.stderr.write(\"chaos-sleeper: RESULT_PATH missing — refusing to fake a complete\\n\");",
    "    process.exit(2);",
    "  }",
    `  fs.writeFileSync(resultPath, JSON.stringify({`,
    `    schema: "mf.agent.result/v1",`,
    `    outcome: "done",`,
    `    summary: summary,`,
    `  }) + "\\n");`,
    `  fs.writeFileSync(${JSON.stringify(donePath)}, "done");`,
    `  process.exit(0);`,
    `}, ${sleepMs});`,
    // The OpenCode adapter uses stdio = ["ignore", "pipe", "pipe"] (AGENT_SPAWN_STDIO).
    // piped stdin from this side would block on a never-arriving pipe close; ignore means
    // the child has no stdin to worry about and stays alive on its timers alone. We do NOT
    // call process.stdin.resume() because there is no stdin pipe — Node exits when nothing
    // else keeps the loop alive, and our pending setTimeout does.
    "",
  ].join("\n");
  writeFileSync(fakeBin, `#!/usr/bin/env node\n${script}`);
  chmodSync(fakeBin, 0o755);
  return fakeBin;
}

test("one-shot submitter survives the spawning server's exit: a fresh server collects delivered=1 lost=0", { timeout: 240_000 }, async () => {
  // A dedicated tmp dir for the test: the fake-opencode binary, the invocation marker, and the
  // done marker all live here. Separating them from `withTempDb`'s dir keeps the failure
  // surface local — the SLEEPER and the LEDGER have non-overlapping cleanup responsibilities.
  const sleeperDir = mkdtempSync(join(tmpdir(), "meshfleet-chaos-"));
  const invokedMarker = join(sleeperDir, "invoked");
  const doneMarker = join(sleeperDir, "done");
  // The worker deliberately takes longer than the wait-and-kill window but finishes before the
  // 90 s collect timeout. Both bounds are observable (the marker files), not sleeps, so a slow
  // CI host does not produce a flaky false-negative.
  //
  // The collector's `collect_results` waits up to its timeout_ms for the agent to settle.
  // Because the durable lane re-launches the worker on its own boot (life cycle recovery),
  // the COLLECTOR will spawn a SECOND sleeper after the FIRST one (the orphaned post-crash
  // worker) finishes. Either the original or the re-launch is acceptable — what matters is
  // that *some* attempt finishes cleanly. SLEEP must be SHORT enough that both the original
  // and the re-launch finish well within the collector's timeout.
  const WORKER_SLEEP_MS = 3_000;
  const KILL_AFTER_INVOKE_MS = 1_500;
  const fakeOpencode = buildFakeOpencode(sleeperDir, WORKER_SLEEP_MS, invokedMarker, doneMarker);

  const temp = withTempDb();
  try {
    // Belt-and-braces: withTempDb sets the in-process override but does NOT export
    // MESHFLEET_DB_FILE into the env. Children inheriting `process.env` would otherwise hit
    // the operator's real default DB (at a schema version our build may not recognise),
    // contaminating the operator's ledger and crashing the spawned server before our scenario
    // even begins. Explicit env wins over both helpers.
    process.env.MESHFLEET_DB_FILE = temp.dbFile;
    process.env.MESHFLEET_DATA_FILE = join(temp.dir, "l.json");
    process.env.MESHFLEET_EVENT_LOG_FILE = join(temp.dir, "events.log");
    const env = (): Record<string, string> => ({
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: temp.dbFile,
      MESHFLEET_DATA_FILE: join(temp.dir, "l.json"),
      MESHFLEET_EVENT_LOG_FILE: join(temp.dir, "events.log"),
      MESHFLEET_RATIFY_SWEEP_MS: "0",
      // Pin the opencode adapter at our fake sleeper so the runtime is deterministic in
      // duration. The default adapter looks at MESHFLEET_OPENCODE_COMMAND unconditionally
      // (registry.ts:42); unset is the operator's own install, which is exactly what fails
      // the seat's reproducibility outside of the operator's machine.
      MESHFLEET_OPENCODE_COMMAND: fakeOpencode,
      // Pin the SSE server to a fresh port per test. The default 13579 often collides with
      // a peer lane (the operator's installed-v5 server) and the resulting "address already
      // in use" is non-fatal but means the test loses its subscription channel.
      MESHFLEET_SSE_PORT: "0",
      // Give the fleet plenty of headroom — never want a fleet timeout to masquerade as
      // chaos-durability success. The receipt's property is about server-death survival,
      // not about staying under a tight deadline.
      MESHFLEET_AGENT_TIMEOUT_MS: "240000",
      // Legacy lifecycle is what the rally's original reproduction exercises. The default
      // 'legacy' is unchanged (no operator lift); the fix is the orphan reconciliation that
      // `collect_results` invokes before summarising. A legacy submitter that dies now
      // delivers through the result envelope on the next read instead of being silently
      // lost — the durable lane is unchanged (its own coordinator covers the same property
      // through a different mechanism).
      MESHFLEET_LIFECYCLE_MODE: "legacy",
    });

    // ---------------------------------------------------------------------------------
    // Process A: the submitting harness. Spawns one opencode agent via the sleeper fake.
    // The server commits the fleet + agent rows DURING the spawn_fleet call; killing the
    // server mid-flight is the operative case — rows are on disk, the in-memory
    // coordinator is gone.
    //
    // CRITICAL ORDERING: the seat's reproduction leaves the harness open while the worker
    // runs and only disconnects when the dispatch turn ENDS — that is exactly the moment we
    // model. Closing `client` BEFORE killing the process would send stdio_close first and
    // the MCP server would exit 0 from its onclose handler, masking the race we are
    // exercising. We keep the connection open through the invoke-marker wait and the
    // kill window so the only signal the server receives is SIGTERM.
    // ---------------------------------------------------------------------------------
    const submitter = await spawnMcpxServer(env());
    let submitterAlive = true;
    submitter.exited.then(() => { submitterAlive = false; });
    const spawnRes = await submitter.client.callTool({
      name: "spawn_fleet",
      arguments: {
        agents: [{ role: "chaos-detached-probe", prompt: "Reply with the single word PONG and nothing else." }],
      },
    });
    const fleet = await parseToolText<FleetResponse>(spawnRes);
    assert.ok(fleet.fleet_id, "spawn_fleet must return a fleet_id");
    assert.equal(fleet.agent_ids.length, 1, "exactly one agent in the test fleet");

    // Confirm the worker WAS launched and is mid-flight before we kill the submitter. This
    // proves the race window we are testing: the server died WHILE its worker was still
    // running, not after the worker finished (which would be a different property).
    await waitForFile(invokedMarker, 10_000, "sleeper fake-opencode to write the invoked marker");

    // Tighten the window deliberately. We want the agent to still be running when we kill
    // the server, AND we want enough wall-clock slack that the SLEEPER won't finish before
    // the collector's first `collect_results` arrives — otherwise the durable path will
    // see `complete` from the original worker and the test reduces to "delegate the work,
    // claim the lease back". That's a different (and weaker) property than the rally asked
    // for, where the worker truly outlives the server and delivers without re-execution.
    await new Promise((r) => setTimeout(r, KILL_AFTER_INVOKE_MS));

    // Kill the submitting server AS A FINISHED DISPATCH TURN DOES. SIGTERM lets it run any
    // exit handlers; SIGKILL would skip the same drain an MCP turn does on session close.
    await submitter.kill();
    const submitterExit = await submitter.exited;
    // NOW (only now) is it safe to close the SDK transport; the process is already dead, so
    // the close is bookkeeping rather than a wire signal.
    await submitter.client.close().catch(() => {});
    assert.notEqual(submitterExit, 0,
      `submitter must NOT exit cleanly with work in flight (got exit=${submitterExit}). ` +
      `A clean exit means the server drained before we measured the race — the agent was already ` +
      `settled before the disconnect, which is not the rally's failure mode.`);
    assert.equal(submitterAlive, false, "submitter process must be dead before we start the collector");
    closeDb();

    // ---------------------------------------------------------------------------------
    // Process B: the collecting harness. Starts FRESH against the same on-disk ledger.
    // On boot, `recoverInterruptedAgents` runs its recovery pass and flips dead legacy
    // agents to `interrupted, stopped_reason: process_lost` (the rally's original
    // symptom). The orphan worker — the one process A's server had spawned but whose
    // in-memory wait it never got to run — has its own life; it is a detached process
    // group (process.ts), so it survives the server's SIGTERM and continues running.
    //
    // When the orphan eventually writes its `done` envelope and exits, the next
    // `collect_results` call observes the envelope and reconciles the row to `complete`
    // through `reconcileOrphanedAgentsInFleet`. The legacy path does NOT re-launch the
    // worker — durable-mode coverage is intentionally a different lane. The
    // chaos-durability fix is the observe-time reconciliation; the structural separation
    // is the existing detached-spawn.
    //
    // `collect_results` is NOT a wait — it returns the current ledger view, full stop.
    // Polling here matches the fleet-timeout-mcp pattern: read status, sleep, repeat
    // until the agent reaches terminal (`complete` / `failed` / `interrupted` /
    // `cancelled`) or the budget is exhausted.
    // ---------------------------------------------------------------------------------
    const collector = await spawnMcpxServer(env());
    try {
      const collectDeadline = Date.now() + 60_000;
      let summary: CollectionSummary | undefined;
      let lastSeenStatus: string | undefined;
      while (Date.now() < collectDeadline) {
        const raw = await collector.client.callTool({
          name: "collect_results",
          arguments: { fleet_id: fleet.fleet_id, timeout_ms: 5_000 },
        });
        summary = await parseToolText<CollectionSummary>(raw);
        lastSeenStatus = summary.results?.[0]?.status;
        if (summary.still_running === 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(summary, "collect_results must return a summary");
      if (summary.delivered !== 1 || summary.lost !== 0) {
        const statusRaw = await collector.client.callTool({
          name: "fleet_status",
          arguments: { fleet_id: fleet.fleet_id },
        });
        const status = await parseToolText<{ agents?: Array<{ status: string; error?: string; output?: string }> }>(statusRaw);
        const dump = JSON.stringify({ summary, lastSeenStatus, status }, null, 2);
        assert.fail(`chaos durability violated (legacy-mode reconciliation did not deliver). ${dump}`);
      }
      assert.equal(summary.delivered, 1,
        `delivered must be 1 (the seat's property). got lost=${summary.lost} ` +
        `still_running=${summary.still_running} warning=${summary.warning ?? "(none)"}.`);
      assert.equal(summary.lost, 0,
        `lost must be 0 (chaos durability proved). got warning=${summary.warning ?? "(none)"}`);
    } finally {
      await collector.client.close().catch(() => {});
      await collector.kill();
    }

    // Sanity invariant: the agent reached `complete` after recovery.
    closeDb();
    const data = loadData();
    const agent = Object.values(data.agents).find((a) => a.fleet_id === fleet.fleet_id);
    assert.ok(agent, "fleet's agent row still exists in the legacy ledger");
    assert.equal(agent.status, "complete",
      `agent must reach 'complete' after recovery; observed '${agent.status}'. ` +
      `agent.error=${JSON.stringify(agent.error ?? null)}. ` +
      `If observed 'failed', the opencode worker errored; ` +
      `if observed 'interrupted', reconciliation did not promote the orphan's envelope.`);
    assert.notEqual(agent.error ?? "", "MCP server crashed before this agent completed",
      "a delivered agent must not carry the crash-cascade error string");
  } finally {
    closeDb();
    temp.cleanup();
    rmSync(sleeperDir, { recursive: true, force: true, maxRetries: 5 });
  }
});
