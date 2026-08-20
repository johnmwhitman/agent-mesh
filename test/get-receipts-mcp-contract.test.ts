/**
 * get_receipts is the public audit boundary for message acknowledgement and
 * delivery evidence. Drive the published tool over real MCP stdio so schema
 * drift, boundary-validation bypasses, and receipt-projection regressions fail.
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-get-receipts-mcp-"));
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
    { name: "get-receipts-contract-test", version: "1.0.0" },
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

test("get_receipts publishes and enforces its schema, then projects acknowledgement and delivery receipts", async () => {
  const messageId = "message-with-receipts";
  await withServer(async (client, dbFile) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "get_receipts");
    assert.ok(tool, "get_receipts must be advertised");
    assert.deepEqual(tool.inputSchema, {
      type: "object",
      properties: { message_id: { type: "string" } },
      required: ["message_id"],
    });

    for (const arguments_ of [{}, { message_id: 42 }]) {
      const refused = await client.callTool({
        name: "get_receipts",
        arguments: arguments_ as Record<string, unknown>,
      });
      assert.equal((refused as ToolResponse).isError, true, JSON.stringify(arguments_));
      assert.match(textOf(refused), /'message_id' is required and must be a non-empty string/);
    }

    assert.deepEqual(bodyOf(await client.callTool({
      name: "get_receipts",
      arguments: { message_id: "absent-message" },
    })), { receipts: [] });

    const seededReceipts = [
      {
        key: `${messageId}:recipient:delivered`,
        receipt: {
          message_id: messageId,
          agent_id: "recipient",
          action: "delivered",
          timestamp: 2000,
          note: "worker accepted handoff",
        },
      },
      {
        key: `${messageId}:recipient:ack`,
        receipt: {
          message_id: messageId,
          agent_id: "recipient",
          action: "ack",
          timestamp: 1000,
        },
      },
      {
        key: "other-message:recipient:ack",
        receipt: {
          message_id: "other-message",
          agent_id: "recipient",
          action: "ack",
          timestamp: 500,
        },
      },
    ];
    const db = new Database(dbFile);
    try {
      const insert = db.prepare("INSERT INTO receipts (key, message_id, data) VALUES (?, ?, ?)");
      for (const { key, receipt } of seededReceipts) {
        insert.run(key, receipt.message_id, JSON.stringify(receipt));
      }
    } finally {
      db.close();
    }

    assert.deepEqual(bodyOf(await client.callTool({
      name: "get_receipts",
      arguments: { message_id: messageId },
    })), {
      receipts: [
        {
          message_id: messageId,
          agent_id: "recipient",
          action: "ack",
          timestamp: 1000,
        },
        {
          message_id: messageId,
          agent_id: "recipient",
          action: "delivered",
          timestamp: 2000,
          note: "worker accepted handoff",
        },
      ],
    });
  });
});
