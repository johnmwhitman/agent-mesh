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

test("default tools/list is 36 core tools and hides advisory routing plus verify_ledger_v2", async () => {
  await withCatalog({}, async (client) => {
    assert.equal(client.getServerCapabilities()?.tools?.listChanged, true);
    const response = await client.listTools();
    const names = response.tools.map((tool) => tool.name);

    assert.equal(names.length, 36, `expected 36 default tools, got ${names.length}: ${names.sort().join(", ")}`);
    for (const name of DEFAULT_CORE_TOOLS) {
      assert.ok(names.includes(name), `core tool missing from default catalog: ${name}`);
    }
    for (const name of ADVISORY_ROUTE_TOOLS) {
      assert.equal(names.includes(name), false, `${name} must stay off the default catalog`);
    }
    assert.equal(names.includes("verify_ledger_v2"), false, "deprecated verify_ledger_v2 must stay off the default catalog");
  });
});

test("MESHFLEET_ROUTE_ADVISOR=1 advertises the three advisory tools without restoring verify_ledger_v2", async () => {
  const defaultCatalog = await withCatalog({}, async (client) => client.listTools());
  const advisorCatalog = await withCatalog({ MESHFLEET_ROUTE_ADVISOR: "1" }, async (client) => client.listTools());

  const defaultNames = new Set(defaultCatalog.tools.map((tool) => tool.name));
  const advisorNames = new Set(advisorCatalog.tools.map((tool) => tool.name));
  const defaultBytes = Buffer.byteLength(JSON.stringify(defaultCatalog), "utf8");
  const advisorBytes = Buffer.byteLength(JSON.stringify(advisorCatalog), "utf8");

  assert.equal(defaultCatalog.tools.length, 36);
  assert.equal(advisorCatalog.tools.length, 39);
  for (const name of ADVISORY_ROUTE_TOOLS) {
    assert.equal(defaultNames.has(name), false, `${name} leaked onto the default catalog`);
    assert.equal(advisorNames.has(name), true, `${name} missing from MESHFLEET_ROUTE_ADVISOR=1 catalog`);
  }
  assert.equal(advisorNames.has("verify_ledger_v2"), false);
  assert.ok(
    advisorBytes > defaultBytes,
    `opt-in advisory catalog (${advisorBytes} bytes) must be larger than default (${defaultBytes} bytes)`,
  );
  assert.ok(
    defaultBytes < 60_000,
    `default tools/list payload ${defaultBytes} bytes exceeds 60 KiB ceiling`,
  );
});
