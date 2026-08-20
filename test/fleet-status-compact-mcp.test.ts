import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const textOf = (result: unknown): string =>
  (result as { content: Array<{ text: string }> }).content[0]!.text;

test("fleet_status compact is opt-in and default bytes stay unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-compact-status-"));
  const jsonFile = join(dir, "ledger.json");
  writeFileSync(jsonFile, JSON.stringify({
    schema_version: 2,
    fleets: {
      f1: { id: "f1", status: "complete", created_at: 100, completed_at: 200 },
    },
    agents: {
      a1: {
        id: "a1",
        fleet_id: "f1",
        role: "worker",
        prompt: "large private prompt",
        status: "complete",
        output: "large final output",
        started_at: 110,
        completed_at: 190,
        result_contract: "ok",
      },
    },
    messages: {},
    inboxes: { a1: [] },
    capabilities: {},
    receipts: {},
    ratifications: {},
    templates: {},
  }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: join(dir, "ledger.db"),
      MESHFLEET_DATA_FILE: jsonFile,
      MESHFLEET_EVENT_LOG_FILE: join(dir, "events.jsonl"),
      MESHFLEET_RATIFY_SWEEP_MS: "0",
      MESHFLEET_SSE_PORT: "0",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "compact-status-test", version: "1" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const omitted = textOf(await client.callTool({
      name: "fleet_status",
      arguments: { fleet_id: "f1" },
    }));
    const explicitFalse = textOf(await client.callTool({
      name: "fleet_status",
      arguments: { fleet_id: "f1", compact: false },
    }));
    assert.equal(explicitFalse, omitted, "false must preserve the exact default response bytes");

    const full = JSON.parse(omitted) as Record<string, unknown>;
    assert.deepEqual(full, {
      fleet: { id: "f1", status: "complete", created_at: 100, completed_at: 200 },
      agents: [{
        id: "a1",
        fleet_id: "f1",
        role: "worker",
        prompt: "large private prompt",
        status: "complete",
        output: "large final output",
        started_at: 110,
        completed_at: 190,
        result_contract: "ok",
      }],
    });

    const compactText = textOf(await client.callTool({
      name: "fleet_status",
      arguments: { fleet_id: "f1", compact: true },
    }));
    assert.deepEqual(JSON.parse(compactText), {
      projection: "compact",
      fleet: { id: "f1", status: "complete" },
      agents: [{ id: "a1", role: "worker", status: "complete", result_contract: "ok" }],
    });
    assert.ok(compactText.length < omitted.length, "opt-in status projection must actually be smaller");

    const invalid = textOf(await client.callTool({
      name: "fleet_status",
      arguments: { fleet_id: "f1", compact: "true" } as Record<string, unknown>,
    }));
    assert.match(invalid, /'compact' must be a boolean/);
  } finally {
    await client.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
