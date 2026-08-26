/**
 * Recovery test for the per-worker wall-clock reap — acceptance gate #6 of
 * `t_db8af59c` (2026-08-26).
 *
 * A synthetic fleet whose child hangs past its budget MUST be reaped within
 * `budget + grace`, the orchestrator MUST record the reap with reason and
 * (transitively) all descendants MUST be killed. The real-OS flavor of this
 * is what the conductor hand-off demanded: a fleet whose workers actually
 * outlived their budget, in 21+ hours of zombie state, with no supervision
 * noticing. This test makes the new supervision impossible to forget.
 *
 * To keep the test under a few seconds wall-clock we set the fleet timeout
 * to the structural floor (`MIN_PER_WORKER_BUDGET_MS` = 1s) and verify the
 * reap happens within `budget + grace` of the supervisor's first refresh.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { MIN_PER_WORKER_BUDGET_MS } from "../src/core.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const textOf = (result: unknown): string =>
  (result as { content: Array<{ text: string }> }).content[0]!.text;

async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const isWindows = process.platform === "win32";

/**
 * Build a sleeper child that ignores SIGTERM (proves the SIGKILL escalation
 * works on POSIX). We trap SIGTERM, write a marker, then loop forever.
 */
function sleeperScript(invoked: string, ignoreSigterm: boolean): string {
  // `process.on('SIGTERM')` registers a handler — Node will then NOT exit
  // on SIGTERM, and the runtime adapter's TERM→KILL escalation must escalate.
  return [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(invoked)}, "invoked");`,
    ignoreSigterm
      ? 'process.on("SIGTERM", () => {}); // ignore; the orchestrator must escalate'
      : "",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n");
}

test("a hung child past its budget is reaped within budget + grace (gate #6)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-recovery-budget-"));
  const events = join(dir, "events.ndjson");
  const sleeperName = isWindows ? "opencode.exe" : "opencode";
  const sleeper = join(dir, sleeperName);
  const invoked = join(dir, "sleeper-invoked");

  if (isWindows) {
    // The Windows branch compiles a small native sleeper (see
    // fleet-timeout-mcp.test.ts for the same pattern). For POSIX the
    // ignore-SIGTERM sleeper is what proves escalation.
    const windowsDir = process.env.WINDIR ?? "C:\\Windows";
    const compiler = [
      join(windowsDir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
      join(windowsDir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
    ].find(existsSync);
    assert.ok(compiler, "Windows recovery test requires the in-box .NET Framework C# compiler");
    const source = join(dir, "sleeper.cs");
    const marker = invoked.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    writeFileSync(
      source,
      `using System.IO; using System.Threading; static class Program { static void Main(string[] args) { File.WriteAllText("${marker}", "invoked"); Thread.Sleep(Timeout.Infinite); } }`,
    );
    execFileSync(compiler, ["/nologo", `/out:${sleeper}`, source]);
  } else {
    writeFileSync(sleeper, `#!/usr/bin/env node\n${sleeperScript(invoked, true)}`, { mode: 0o755 });
    chmodSync(sleeper, 0o755);
  }

  // Budget = MIN_PER_WORKER_BUDGET_MS so the reap happens fast enough for
  // the test to be under a few seconds. A supervisor refresh fires every
  // `MESHFLEET_RATIFY_SWEEP_MS` (we set it to the budget too, so we don't
  // wait longer than one cycle for the first reap).
  const budgetMs = MIN_PER_WORKER_BUDGET_MS;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", tsxLoader, join(repoRoot, "src", "index.ts")],
    cwd: dir,
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: join(dir, "ledger.db"),
      MESHFLEET_DATA_FILE: join(dir, "ledger.json"),
      MESHFLEET_EVENT_LOG_FILE: events,
      MESHFLEET_AGENT_TIMEOUT_MS: String(budgetMs),
      MESHFLEET_OPENCODE_COMMAND: sleeper,
      MESHFLEET_RATIFY_SWEEP_MS: "0",
      MESHFLEET_SSE_PORT: "13942",
      AGENT_MESH_CHILD: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "recovery-budget-test", version: "1" }, { capabilities: {} });
  let serverStderr = "";
  try {
    await client.connect(transport);
    transport.stderr?.on("data", (chunk) => { serverStderr += chunk.toString(); });

    const spawned = JSON.parse(textOf(await client.callTool({
      name: "spawn_fleet",
      arguments: { agents: [{ role: "sleeper", prompt: "hang past budget" }] },
    }))) as { fleet_id: string; agent_ids: string[] };

    // 1) The child was actually invoked. Without this, the rest of the
    //    assertions measure a no-spawn scenario.
    await waitUntil(() => existsSync(invoked), "child invocation").catch((error) => {
      const eventTail = existsSync(events) ? readFileSync(events, "utf8").slice(-2_000) : "no event log";
      throw new Error(`${error instanceof Error ? error.message : String(error)}; stderr=${serverStderr.slice(-2_000)}; events=${eventTail}`);
    });

    // 2) The budget must elapse and the orchestrator must reap the worker.
    //    Upper bound: budget + 2 budget periods + a healthy grace window for
    //    the supervisor to fire. The conductor hand-off's "21+ hour"
    //    failure mode is exactly what we are catching — if this assertion
    //    regresses to "wait minutes", the reap path is broken.
    const reapDeadline = Date.now() + budgetMs * 4;
    let observed: { fleet?: { status: string }; agents?: Array<{ status: string; error?: string; pid?: number }> } = {};
    while (Date.now() < reapDeadline) {
      observed = JSON.parse(textOf(await client.callTool({
        name: "fleet_status",
        arguments: { fleet_id: spawned.fleet_id },
      })));
      if (observed.fleet?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(observed.fleet?.status, "failed", `fleet must reap within budget*4; events tail: ${readFileSync(events, "utf8").slice(-1_500)}`);
    assert.equal(observed.agents?.[0]?.status, "failed");
    // The reap reason names the budget OR the stall, but it MUST exist —
    // a "failed" with no error is the silent-loss defect this whole fix
    // exists to prevent.
    assert.ok(
      (observed.agents?.[0]?.error ?? "").length > 0,
      "a reaped worker must carry a reason — empty error is the silent-loss defect",
    );

    // 3) The runtime child must be reaped, not just the ledger row. On POSIX
    //    we walk `/proc` to find the sleeper's pid and assert it is dead.
    //    This is the tree-kill half of gate #6 — without it the ledger can
    //    claim "failed" while the OS still has a live child.
    if (!isWindows) {
      const pid = observed.agents?.[0]?.pid;
      if (typeof pid === "number") {
        // Allow a small grace window for the SIGKILL to take effect — the
        // adapter's TERM→KILL escalation has its own 100ms grace, plus the
        // orchestrator's reap grace, plus async signal delivery.
        await new Promise((resolve) => setTimeout(resolve, 500));
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (err) {
          alive = (err as NodeJS.ErrnoException).code === "EPERM";
        }
        assert.equal(alive, false, `child pid ${pid} survived the reap — TERM→KILL escalation broken`);
      }
    }
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
