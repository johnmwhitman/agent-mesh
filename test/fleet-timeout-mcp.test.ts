import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const textOf = (result: unknown): string =>
  (result as { content: Array<{ text: string }> }).content[0]!.text;

test("set_fleet_timeout re-arms an already-running real MCP child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-timeout-mcp-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const opencode = join(bin, "opencode");
  writeFileSync(opencode, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
  chmodSync(opencode, 0o755);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env: {
      ...(process.env as Record<string, string>),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      MESHFLEET_DB_FILE: join(dir, "ledger.db"),
      MESHFLEET_DATA_FILE: join(dir, "ledger.json"),
      MESHFLEET_EVENT_LOG_FILE: join(dir, "events.ndjson"),
      MESHFLEET_AGENT_TIMEOUT_MS: "50",
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
    await client.callTool({
      name: "set_fleet_timeout",
      arguments: { fleet_id: spawned.fleet_id, timeout_ms: 500 },
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
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
