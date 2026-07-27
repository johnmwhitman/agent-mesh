/**
 * send_messages has a stricter promise than the core batch writer: the MCP
 * boundary advertises that one invalid wire message rejects the whole batch.
 * These are real stdio calls so the test exercises the published tool contract
 * instead of re-testing the typed core API.
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

async function withServer(fn: (client: Client) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-send-batch-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env: {
      ...(process.env as Record<string, string>),
      // Keep every durable writer isolated. The JSON path matters during
      // startup migration, and the event log is a separate writer as well.
      MESHFLEET_DB_FILE: join(dir, "ledger.db"),
      MESHFLEET_DATA_FILE: join(dir, "ledger.json"),
      MESHFLEET_EVENT_LOG_FILE: join(dir, "events.jsonl"),
      MESHFLEET_RATIFY_SWEEP_MS: "0",
    },
    stderr: "ignore",
  });
  const client = new Client(
    { name: "send-batch-contract-test", version: "1.0.0" },
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

const supportedSelfMessage = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  from_agent_id: "self",
  to_agent_id: "self",
  fleet_id: "fleet",
  type: "handoff",
  payload: "payload",
  ...overrides,
});

async function inbox(client: Client, agentId = "self"): Promise<Array<Record<string, unknown>>> {
  const response = await client.callTool({
    name: "get_inbox",
    arguments: { agent_id: agentId },
  });
  return (JSON.parse(textOf(response)) as { messages: Array<Record<string, unknown>> }).messages;
}

test("send_messages rejects a mixed batch atomically before the invalid self-message can persist", async () => {
  await withServer(async (client) => {
    const response = await client.callTool({
      name: "send_messages",
      arguments: {
        messages: [
          supportedSelfMessage({ payload: "valid-first" }),
          supportedSelfMessage({ type: "unsupported" }),
        ],
      },
    });
    const messages = await inbox(client);

    // This single assertion deliberately shows all three contract effects in
    // RED: current code reports success, omits the indexed diagnostic, and
    // writes both rows before returning.
    assert.deepEqual(
      {
        isError: (response as ToolResponse).isError === true,
        indexedTypeDiagnostic: /messages\[1\]\.type/.test(textOf(response)),
        persistedInboxMessages: messages.length,
      },
      {
        isError: true,
        indexedTypeDiagnostic: true,
        persistedInboxMessages: 0,
      },
    );
  });
});

test("send_messages accepts a supported self-message with an empty payload", async () => {
  await withServer(async (client) => {
    const response = await client.callTool({
      name: "send_messages",
      arguments: { messages: [supportedSelfMessage({ payload: "" })] },
    });
    assert.notEqual((response as ToolResponse).isError, true, textOf(response));

    const messages = await inbox(client);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.payload, "");
    assert.equal(messages[0]!.type, "handoff");
  });
});

const invalidBoundaryCases: Array<{
  name: string;
  arguments: Record<string, unknown>;
  diagnostic: RegExp;
}> = [
  {
    name: "omitted messages",
    arguments: {},
    diagnostic: /messages.*array/i,
  },
  {
    name: "a non-array messages value",
    arguments: { messages: "not-an-array" },
    diagnostic: /messages.*array/i,
  },
  {
    name: "a null batch item",
    arguments: { messages: [null] },
    diagnostic: /messages\[0\].*(object|record)/i,
  },
  {
    name: "an array batch item",
    arguments: { messages: [[]] },
    diagnostic: /messages\[0\].*(object|record)/i,
  },
  {
    name: "more than 1000 messages",
    arguments: { messages: Array.from({ length: 1001 }, () => supportedSelfMessage()) },
    diagnostic: /messages.*1000/i,
  },
  {
    name: "a null correlation_id",
    arguments: { messages: [supportedSelfMessage({ correlation_id: null })] },
    diagnostic: /messages\[0\]\.correlation_id/i,
  },
  {
    name: "an empty correlation_id",
    arguments: { messages: [supportedSelfMessage({ correlation_id: "" })] },
    diagnostic: /messages\[0\]\.correlation_id/i,
  },
];

for (const { name, arguments: args, diagnostic } of invalidBoundaryCases) {
  test(`send_messages rejects ${name} at the MCP boundary`, async () => {
    await withServer(async (client) => {
      const response = await client.callTool({
        name: "send_messages",
        arguments: args,
      });
      assert.equal((response as ToolResponse).isError, true, textOf(response));
      assert.match(textOf(response), diagnostic);
      assert.deepEqual(await inbox(client), [], "a rejected batch must not write an inbox row");
    });
  });
}
