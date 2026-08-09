import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
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
  const sleeper = join(dir, "runtime-sleeper.cjs");
  // NODE_OPTIONS reaches both the Node-hosted server and its runtime child.
  // No-op for index.ts; for the child, record real invocation and block before
  // Node tries to resolve buildRunArgs()'s synthetic `run` script. This uses a
  // genuine executable on Windows without shell:true or a non-portable shim.
  writeFileSync(sleeper, [
    'if (!process.argv[1] || !process.argv[1].endsWith("index.ts")) {',
    `  require("node:fs").writeFileSync(${JSON.stringify(invoked)}, "invoked");`,
    "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
    "}",
    "",
  ].join("\n"));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: join(dir, "ledger.db"),
      MESHFLEET_DATA_FILE: join(dir, "ledger.json"),
      MESHFLEET_EVENT_LOG_FILE: join(dir, "events.ndjson"),
      MESHFLEET_AGENT_TIMEOUT_MS: "500",
      MESHFLEET_OPENCODE_COMMAND: process.execPath,
      NODE_OPTIONS: `--require ${sleeper}`,
      MESHFLEET_RATIFY_SWEEP_MS: "0",
      MESHFLEET_SSE_PORT: "13941",
      AGENT_MESH_CHILD: "1",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "fleet-timeout-test", version: "1" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const spawned = JSON.parse(textOf(await client.callTool({
      name: "spawn_fleet",
      arguments: { agents: [{ role: "sleeper", prompt: "wait" }] },
    }))) as { fleet_id: string; agent_ids: string[] };
    await waitUntil(() => existsSync(invoked), "runtime child invocation");
    await client.callTool({
      name: "set_fleet_timeout",
      arguments: { fleet_id: spawned.fleet_id, timeout_ms: 1_500 },
    });

    await new Promise((resolve) => setTimeout(resolve, 700));
    const extended = JSON.parse(textOf(await client.callTool({
      name: "fleet_status",
      arguments: { fleet_id: spawned.fleet_id },
    }))) as { fleet: { status: string } };
    assert.equal(extended.fleet.status, "running", "extending the override must re-arm the runtime's original timeout");
    assert.ok(
      !readFileSync(join(dir, "events.ndjson"), "utf8").includes("agent_retry_scheduled"),
      "the original runtime timeout must be extended, not allowed to kill attempt 1 and hide behind a retry",
    );

    await client.callTool({
      name: "set_fleet_timeout",
      arguments: { fleet_id: spawned.fleet_id, timeout_ms: 50 },
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
    assert.match(observed.agents?.[0]?.error ?? "", /fleet timeout.*50ms/i);
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
