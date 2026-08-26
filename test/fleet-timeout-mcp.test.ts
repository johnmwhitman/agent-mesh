import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("set_fleet_timeout re-arms an already-running real MCP child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-timeout-mcp-"));
  const invoked = join(dir, "runtime-invoked");
  const events = join(dir, "events.ndjson");
  const isWindows = process.platform === "win32";
  const sleeper = join(dir, isWindows ? "opencode.exe" : "opencode");
  const sleeperSource = [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(invoked)}, "invoked");`,
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n");
  if (isWindows) {
    // OpenCode ships a native .exe on Windows and accepts global flags before
    // `run`. A renamed node.exe is not a faithful stand-in: Node parses those
    // OpenCode flags as its own and exits before running a script. Compile the
    // smallest native-shaped sleeper so this timeout test accepts arbitrary
    // OpenCode argv while still exercising direct .exe process management.
    const windowsDir = process.env.WINDIR ?? "C:\\Windows";
    const compiler = [
      join(windowsDir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
      join(windowsDir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
    ].find(existsSync);
    assert.ok(compiler, "Windows timeout witness requires the in-box .NET Framework C# compiler");
    const source = join(dir, "sleeper.cs");
    const marker = invoked.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    writeFileSync(
      source,
      `using System.IO; using System.Threading; static class Program { static void Main(string[] args) { File.WriteAllText("${marker}", "invoked"); Thread.Sleep(Timeout.Infinite); } }`,
    );
    execFileSync(compiler, ["/nologo", `/out:${sleeper}`, source]);
  } else {
    writeFileSync(sleeper, `#!/usr/bin/env node\n${sleeperSource}`, { mode: 0o755 });
    chmodSync(sleeper, 0o755);
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", tsxLoader, join(repoRoot, "src", "index.ts")],
    cwd: dir,
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: join(dir, "ledger.db"),
      MESHFLEET_DATA_FILE: join(dir, "ledger.json"),
      MESHFLEET_EVENT_LOG_FILE: events,
      MESHFLEET_AGENT_TIMEOUT_MS: "5000",
      MESHFLEET_OPENCODE_COMMAND: sleeper,
      MESHFLEET_RATIFY_SWEEP_MS: "0",
      MESHFLEET_SSE_PORT: "13941",
      AGENT_MESH_CHILD: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "fleet-timeout-test", version: "1" }, { capabilities: {} });
  let serverStderr = "";
  try {
    await client.connect(transport);
    transport.stderr?.on("data", (chunk) => { serverStderr += chunk.toString(); });
    const spawned = JSON.parse(textOf(await client.callTool({
      name: "spawn_fleet",
      arguments: { agents: [{ role: "sleeper", prompt: "wait" }] },
    }))) as { fleet_id: string; agent_ids: string[] };
    await waitUntil(() => existsSync(invoked), "runtime child invocation").catch((error) => {
      const eventTail = existsSync(events) ? readFileSync(events, "utf8").slice(-2_000) : "no event log";
      throw new Error(`${error instanceof Error ? error.message : String(error)}; stderr=${serverStderr.slice(-2_000)}; events=${eventTail}`);
    });
    await client.callTool({
      name: "set_fleet_timeout",
      arguments: { fleet_id: spawned.fleet_id, timeout_ms: 15_000 },
    });

    await new Promise((resolve) => setTimeout(resolve, 5_500));
    const extended = JSON.parse(textOf(await client.callTool({
      name: "fleet_status",
      arguments: { fleet_id: spawned.fleet_id },
    }))) as { fleet: { status: string } };
    assert.equal(extended.fleet.status, "running", "extending the override must re-arm the runtime's original timeout");
    assert.ok(
      !readFileSync(events, "utf8").includes("agent_retry_scheduled"),
      "the original runtime timeout must be extended, not allowed to kill attempt 1 and hide behind a retry",
    );

    await client.callTool({
      name: "set_fleet_timeout",
      arguments: { fleet_id: spawned.fleet_id, timeout_ms: MIN_PER_WORKER_BUDGET_MS },
    });

    const ceiling = Date.now() + 3_000;
    let observed: { fleet?: { status: string }; agents?: Array<{ status: string; error?: string }> } = {};
    while (Date.now() < ceiling) {
      observed = JSON.parse(textOf(await client.callTool({
        name: "fleet_status",
        arguments: { fleet_id: spawned.fleet_id },
      })));
      if (observed.fleet?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(observed.fleet?.status, "failed");
    assert.equal(observed.agents?.[0]?.status, "failed");
    assert.match(observed.agents?.[0]?.error ?? "", new RegExp(`fleet timeout.*${MIN_PER_WORKER_BUDGET_MS}ms`, "i"));
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
