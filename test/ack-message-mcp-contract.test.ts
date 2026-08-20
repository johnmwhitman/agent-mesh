/**
 * ack_message is the consuming acknowledgement boundary. Exercise it through
 * real MCP stdio so advertised-schema drift, false acknowledgements, inbox
 * consumption, receipt durability, and idempotency stay coupled.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

type ToolResponse = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
};

const textOf = (response: unknown): string => (response as ToolResponse).content[0]!.text;
const bodyOf = (response: unknown): Record<string, unknown> => JSON.parse(textOf(response)) as Record<string, unknown>;

async function withServer(fn: (client: Client) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-ack-message-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: join(dir, "ledger.db"),
      MESHFLEET_DATA_FILE: join(dir, "ledger.json"),
      MESHFLEET_EVENT_LOG_FILE: join(dir, "events.jsonl"),
      MESHFLEET_RATIFY_SWEEP_MS: "0",
      AGENT_MESH_CHILD: "1",
    },
    stderr: "ignore",
  });
  const client = new Client(
    { name: "ack-message-contract-test", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    await fn(client);
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

test("ack_message advertises its schema and only a recipient can durably consume a message", async () => {
  await withServer(async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "ack_message");
    assert.ok(tool, "ack_message must be advertised");
    assert.deepEqual(tool.inputSchema, {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        message_id: { type: "string" },
      },
      required: ["agent_id", "message_id"],
    });

    for (const arguments_ of [
      { message_id: "message" },
      { agent_id: "recipient" },
      { agent_id: 42, message_id: "message" },
      { agent_id: "recipient", message_id: false },
    ]) {
      const refused = await client.callTool({
        name: "ack_message",
        arguments: arguments_ as Record<string, unknown>,
      });
      assert.equal((refused as ToolResponse).isError, true, JSON.stringify(arguments_));
      assert.match(textOf(refused), /is required and must be a non-empty string/);
    }

    const sent = bodyOf(await client.callTool({
      name: "send_message",
      arguments: {
        from_agent_id: "sender",
        to_agent_id: "recipient",
        fleet_id: "fleet",
        type: "handoff",
        payload: "bounded handoff",
      },
    }));
    const messageId = sent.message_id;
    assert.equal(typeof messageId, "string");

    assert.deepEqual(bodyOf(await client.callTool({
      name: "ack_message",
      arguments: { agent_id: "bystander", message_id: messageId },
    })), { ok: false }, "a non-recipient must not forge acknowledgement evidence");
    assert.deepEqual(bodyOf(await client.callTool({
      name: "get_receipts",
      arguments: { message_id: messageId },
    })), { receipts: [] });

    assert.equal((bodyOf(await client.callTool({
      name: "get_inbox",
      arguments: { agent_id: "recipient" },
    })).messages as unknown[]).length, 1);

    assert.deepEqual(bodyOf(await client.callTool({
      name: "ack_message",
      arguments: { agent_id: "recipient", message_id: messageId },
    })), { ok: true });
    assert.deepEqual(bodyOf(await client.callTool({
      name: "ack_message",
      arguments: { agent_id: "recipient", message_id: messageId },
    })), { ok: true }, "repeat acknowledgement must be idempotent");

    assert.deepEqual(bodyOf(await client.callTool({
      name: "get_inbox",
      arguments: { agent_id: "recipient" },
    })), { messages: [] });

    const receiptBody = bodyOf(await client.callTool({
      name: "get_receipts",
      arguments: { message_id: messageId },
    }));
    const receipts = receiptBody.receipts as Array<Record<string, unknown>>;
    assert.equal(receipts.length, 1, "idempotent repeat must not duplicate the receipt");
    assert.deepEqual(
      { ...receipts[0], timestamp: "number" },
      {
        message_id: messageId,
        agent_id: "recipient",
        action: "ack",
        timestamp: "number",
      },
    );
    assert.equal(typeof receipts[0]!.timestamp, "number");
  });
});
