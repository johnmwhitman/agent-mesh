/**
 * sweep_ratifications is the public state-transition boundary for open councils.
 * Drive it over real MCP stdio so schema drift, argument handling, and durable
 * deadline resolution regressions fail at the published boundary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

type ToolResponse = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
};

const textOf = (response: unknown): string => (response as ToolResponse).content[0]!.text;
const bodyOf = (response: unknown): Record<string, unknown> => JSON.parse(textOf(response)) as Record<string, unknown>;

async function withServer(
  fn: (client: Client, dbFile: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-sweep-ratifications-mcp-"));
  const dbFile = join(dir, "ledger.db");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: dbFile,
      MESHFLEET_DATA_FILE: join(dir, "ledger.json"),
      MESHFLEET_EVENT_LOG_FILE: join(dir, "events.jsonl"),
      MESHFLEET_RATIFY_SWEEP_MS: "0",
      AGENT_MESH_CHILD: "1",
    },
    stderr: "ignore",
  });
  const client = new Client(
    { name: "sweep-ratifications-contract-test", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    await fn(client, dbFile);
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

test("sweep_ratifications publishes its empty schema and persists deadline resolution", async () => {
  await withServer(async (client, dbFile) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "sweep_ratifications");
    assert.ok(tool, "sweep_ratifications must be advertised");
    assert.deepEqual(tool.inputSchema, { type: "object", properties: {} });

    // The no-argument sweep is also the cheapest public bootstrap for the
    // durable schema. The declared schema does not forbid extra properties,
    // and the handler intentionally ignores them; pin both client-visible forms.
    const empty = bodyOf(await client.callTool({
      name: "sweep_ratifications",
      arguments: {},
    }));
    assert.deepEqual(empty, { checked: 0, resolved: {} });
    const ignoredExtra = bodyOf(await client.callTool({
      name: "sweep_ratifications",
      arguments: { ignored: "client-extension" },
    }));
    assert.deepEqual(ignoredExtra, { checked: 0, resolved: {} });

    // Seed only council participants. SQLite is the authoritative ledger; the
    // bootstrap sweep above has already materialized agents/inboxes tables.
    {
      const db = new Database(dbFile);
      try {
        const insertAgent = db.prepare("INSERT INTO agents (id, fleet_id, data) VALUES (?, ?, ?)");
        const insertInbox = db.prepare("INSERT INTO inboxes (agent_id, data) VALUES (?, ?)");
        for (const id of ["proposer", "v1", "v2"]) {
          insertAgent.run(id, "f1", JSON.stringify({
            id,
            fleet_id: "f1",
            role: "peer",
            prompt: "p",
            status: "running",
          }));
          insertInbox.run(id, JSON.stringify([]));
        }
      } finally {
        db.close();
      }
    }

    const expired = bodyOf(await client.callTool({
      name: "open_ratification",
      arguments: {
        proposer: "proposer",
        fleet_id: "f1",
        subject: "contract-test: expired",
        quorum: 2,
        voters: ["v1", "v2"],
        deadline: Date.now() - 10_000,
      },
    })) as { message_id: string };
    const stillOpen = bodyOf(await client.callTool({
      name: "open_ratification",
      arguments: {
        proposer: "proposer",
        fleet_id: "f1",
        subject: "contract-test: open",
        quorum: 2,
        voters: ["v1", "v2"],
        deadline: Date.now() + 60_000,
      },
    })) as { message_id: string };

    const swept = bodyOf(await client.callTool({
      name: "sweep_ratifications",
      arguments: {},
    }));
    assert.equal(swept.checked, 2);
    assert.deepEqual(swept.resolved, { [expired.message_id]: "expired" });

    const expiredAfterSweep = bodyOf(await client.callTool({
      name: "tally_ratification",
      arguments: { message_id: expired.message_id },
    }));
    assert.equal(expiredAfterSweep.status, "expired");
    assert.equal((expiredAfterSweep.tally as Record<string, unknown>).status, "expired");

    const openAfterSweep = bodyOf(await client.callTool({
      name: "tally_ratification",
      arguments: { message_id: stillOpen.message_id },
    }));
    assert.equal(openAfterSweep.status, "open");
    assert.equal((openAfterSweep.tally as Record<string, unknown>).status, "open");
  });
});
