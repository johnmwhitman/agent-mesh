import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const ADVISORY_ROUTE_TOOLS = [
  "compile_route_candidates",
  "plan_speculative_backlog",
  "recommend_route",
] as const;

const DEFAULT_CORE_TOOLS = [
  "spawn_fleet",
  "fleet_status",
  "collect_results",
  "route_work",
  "send_message",
  "get_receipts",
  "verify_ledger",
  "verify_ledger_v3",
  "open_ratification",
  "cast_vote",
  "get_health",
  "get_work_receipt",
  "record_work_receipt",
  "subscribe_events",
  "ask_peer",
] as const;

async function withCatalog<T>(
  extraEnv: Record<string, string>,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-default-catalog-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(REPO_ROOT, "src", "index.ts")],
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: join(dir, "ledger.db"),
      MESHFLEET_DATA_FILE: join(dir, "ledger.json"),
      MESHFLEET_EVENT_LOG_FILE: join(dir, "events.jsonl"),
      MESHFLEET_RATIFY_SWEEP_MS: "0",
      AGENT_MESH_CHILD: "1",
      MESHFLEET_COMPACT_CATALOG: "0",
      MESHFLEET_ROUTE_ADVISOR: "0",
      ...extraEnv,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "meshfleet-default-catalog", version: "1.0.0" });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("default tools/list remains the compatible 40-tool catalog", async () => {
  await withCatalog({}, async (client) => {
    assert.equal(client.getServerCapabilities()?.tools?.listChanged, undefined);
    const response = await client.listTools();
    const names = response.tools.map((tool) => tool.name);

    assert.equal(names.length, 40, `expected 40 default tools, got ${names.length}: ${names.sort().join(", ")}`);
    for (const name of DEFAULT_CORE_TOOLS) {
      assert.ok(names.includes(name), `core tool missing from default catalog: ${name}`);
    }
    for (const name of ADVISORY_ROUTE_TOOLS) {
      assert.equal(names.includes(name), true, `${name} missing from the compatible default catalog`);
    }
    assert.equal(names.includes("verify_ledger_v2"), true, "verify_ledger_v2 missing from the compatible default catalog");
  });
});

test("compact catalog is 36 tools and can opt back into the three advisory tools", async () => {
  const compactCatalog = await withCatalog({ MESHFLEET_COMPACT_CATALOG: "1" }, async (client) => client.listTools());
  const advisorCatalog = await withCatalog(
    { MESHFLEET_COMPACT_CATALOG: "1", MESHFLEET_ROUTE_ADVISOR: "1" },
    async (client) => client.listTools(),
  );

  const compactNames = new Set(compactCatalog.tools.map((tool) => tool.name));
  const advisorNames = new Set(advisorCatalog.tools.map((tool) => tool.name));
  const compactBytes = Buffer.byteLength(JSON.stringify(compactCatalog), "utf8");
  const advisorBytes = Buffer.byteLength(JSON.stringify(advisorCatalog), "utf8");

  assert.equal(compactCatalog.tools.length, 36);
  assert.equal(advisorCatalog.tools.length, 39);
  for (const name of ADVISORY_ROUTE_TOOLS) {
    assert.equal(compactNames.has(name), false, `${name} leaked onto the compact catalog`);
    assert.equal(advisorNames.has(name), true, `${name} missing from compact advisory catalog`);
  }
  assert.equal(compactNames.has("verify_ledger_v2"), false);
  assert.equal(advisorNames.has("verify_ledger_v2"), false);
  assert.ok(
    advisorBytes > compactBytes,
    `compact advisory catalog (${advisorBytes} bytes) must be larger than compact core (${compactBytes} bytes)`,
  );
  assert.ok(
    compactBytes < 60_000,
    `compact tools/list payload ${compactBytes} bytes exceeds 60 KiB ceiling`,
  );
});
