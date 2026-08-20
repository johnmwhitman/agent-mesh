/**
 * send_message is the public P2P boundary. Its contract — advertised schema,
 * boundary validation, and durable delivery — must be exercised through real
 * MCP stdio so a schema drift, validation bypass, or persistence regression
 * surfaces here, not at a peer lane that called the tool in good faith.
 *
 * Singular message = no batch atomicity story. The contract collapses to four
 *   claims, each anchored to a concrete persisted effect:
 *     1. The advertised `inputSchema` matches what the handler enforces.
 *     2. Invalid arguments are refused with an `isError: true` result and do
 *        NOT commit a row to `messages` or `inboxes`.
 *     3. A valid self-message returns `{ message_id, recipients: ["self"] }`,
 *        writes exactly one `messages` row, and one `inboxes` entry.
 *     4. The wire envelope (type, payload, correlation_id, from/to) round-trips
 *        through `get_inbox` byte-for-byte.
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
const bodyOf = (response: unknown): Record<string, unknown> =>
  JSON.parse(textOf(response)) as Record<string, unknown>;

async function withServer(
  fn: (client: Client, dbFile: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-send-message-mcp-"));
  const dbFile = join(dir, "ledger.db");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env: {
      ...(process.env as Record<string, string>),
      // Keep every durable writer isolated. JSON sidecar matters during
      // startup migration; the event log is a separate writer.
      MESHFLEET_DB_FILE: dbFile,
      MESHFLEET_DATA_FILE: join(dir, "ledger.json"),
      MESHFLEET_EVENT_LOG_FILE: join(dir, "events.jsonl"),
      MESHFLEET_RATIFY_SWEEP_MS: "0",
    },
    stderr: "ignore",
  });
  const client = new Client(
    { name: "send-message-contract-test", version: "1.0.0" },
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

function durableDeliveryCounts(dbFile: string): { messages: number; inboxes: number } {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    return {
      messages: (db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count,
      inboxes: (db.prepare("SELECT COUNT(*) AS count FROM inboxes").get() as { count: number }).count,
    };
  } finally {
    db.close();
  }
}

async function inbox(
  client: Client,
  agentId = "self",
): Promise<Array<Record<string, unknown>>> {
  const response = await client.callTool({
    name: "get_inbox",
    arguments: { agent_id: agentId },
  });
  return (JSON.parse(textOf(response)) as { messages: Array<Record<string, unknown>> }).messages;
}

const supportedSelfMessage = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  from_agent_id: "self",
  to_agent_id: "self",
  fleet_id: "fleet",
  type: "handoff",
  payload: "payload",
  ...overrides,
});

test("send_message advertises the same nonblank identity and correlation rules it enforces", async () => {
  await withServer(async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "send_message");
    assert.ok(tool, "send_message must be advertised");
    const schema = tool.inputSchema as unknown as {
      properties: Record<string, { minLength?: number; pattern?: string; type?: string }>;
      required: string[];
    };
    for (const field of ["from_agent_id", "to_agent_id", "fleet_id", "correlation_id"]) {
      assert.deepEqual(
        {
          minLength: schema.properties[field]!.minLength,
          pattern: schema.properties[field]!.pattern,
        },
        { minLength: 1, pattern: "\\S" },
        `${field} schema must reject blank-only values just like the handler`,
      );
    }
    assert.deepEqual(
      schema.required.sort(),
      ["fleet_id", "from_agent_id", "payload", "to_agent_id", "type"].sort(),
      "required[] must match the documented wire envelope",
    );
    assert.equal(
      schema.properties.payload!.minLength,
      undefined,
      "empty payloads are protocol-valid and must remain schema-valid",
    );
  });
});

test("send_message returns message_id and recipients for a supported self-message", async () => {
  await withServer(async (client, dbFile) => {
    const response = await client.callTool({
      name: "send_message",
      arguments: supportedSelfMessage({ payload: "hello" }),
    });
    assert.notEqual((response as ToolResponse).isError, true, textOf(response));
    const body = bodyOf(response);
    assert.equal(typeof body.message_id, "string", `message_id must be a string, got ${JSON.stringify(body)}`);
    assert.deepEqual(
      body.recipients,
      ["self"],
      "a direct self-send resolves to exactly one recipient",
    );
    assert.deepEqual(
      durableDeliveryCounts(dbFile),
      { messages: 1, inboxes: 1 },
      "the success path must commit exactly one messages row and one inboxes row",
    );

    // Round-trip the wire envelope through get_inbox so the durable store, not
    // the in-memory response, is what proves the envelope survived.
    const messages = await inbox(client);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.payload, "hello");
    assert.equal(messages[0]!.type, "handoff");
    assert.equal((messages[0] as { correlation_id?: string }).correlation_id, undefined);
  });
});

test("send_message accepts an empty payload and an optional correlation_id", async () => {
  await withServer(async (client, dbFile) => {
    const response = await client.callTool({
      name: "send_message",
      arguments: supportedSelfMessage({
        payload: "",
        correlation_id: "corr-1",
        future_schema_field: "ignored for forward compatibility",
      }),
    });
    assert.notEqual((response as ToolResponse).isError, true, textOf(response));
    const messages = await inbox(client);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.payload, "");
    assert.equal(messages[0]!.type, "handoff");
    assert.equal((messages[0] as { correlation_id?: string }).correlation_id, "corr-1");
    assert.deepEqual(
      durableDeliveryCounts(dbFile),
      { messages: 1, inboxes: 1 },
      "the compatibility control must prove valid input still commits",
    );
  });
});

const invalidBoundaryCases: Array<{
  name: string;
  arguments: Record<string, unknown>;
  diagnostic: RegExp;
}> = [
  {
    name: "omitted from_agent_id",
    arguments: {
      to_agent_id: "self",
      fleet_id: "fleet",
      type: "handoff",
      payload: "p",
    },
    diagnostic: /'from_agent_id' is required/,
  },
  {
    name: "omitted to_agent_id",
    arguments: {
      from_agent_id: "self",
      fleet_id: "fleet",
      type: "handoff",
      payload: "p",
    },
    diagnostic: /'to_agent_id' is required/,
  },
  {
    name: "omitted fleet_id",
    arguments: {
      from_agent_id: "self",
      to_agent_id: "self",
      type: "handoff",
      payload: "p",
    },
    diagnostic: /'fleet_id' is required/,
  },
  {
    name: "omitted payload",
    arguments: {
      from_agent_id: "self",
      to_agent_id: "self",
      fleet_id: "fleet",
      type: "handoff",
    },
    diagnostic: /'payload' is required and must be a string/,
  },
  {
    name: "non-string payload",
    arguments: supportedSelfMessage({ payload: 42 }),
    diagnostic: /'payload' is required and must be a string/,
  },
  {
    name: "omitted type",
    arguments: {
      from_agent_id: "self",
      to_agent_id: "self",
      fleet_id: "fleet",
      payload: "p",
    },
    diagnostic: /'type' is required and must be one of/,
  },
  {
    name: "unsupported type",
    arguments: supportedSelfMessage({ type: "nonsense" }),
    diagnostic: /'type' must be exactly one of/,
  },
  {
    name: "non-string type",
    arguments: supportedSelfMessage({ type: 42 }),
    diagnostic: /'type' must be exactly one of/,
  },
  {
    name: "blank from_agent_id",
    arguments: supportedSelfMessage({ from_agent_id: "   " }),
    diagnostic: /'from_agent_id' is required and must be a non-empty string/,
  },
  {
    name: "blank to_agent_id",
    arguments: supportedSelfMessage({ to_agent_id: "" }),
    diagnostic: /'to_agent_id' is required and must be a non-empty string/,
  },
  {
    name: "blank fleet_id",
    arguments: supportedSelfMessage({ fleet_id: "   " }),
    diagnostic: /'fleet_id' is required and must be a non-empty string/,
  },
  {
    name: "non-string identity",
    arguments: supportedSelfMessage({ fleet_id: 42 }),
    diagnostic: /'fleet_id' is required and must be a non-empty string/,
  },
  {
    name: "a null correlation_id",
    arguments: supportedSelfMessage({ correlation_id: null }),
    diagnostic: /'correlation_id' must be a non-empty string when provided/,
  },
  {
    name: "an empty correlation_id",
    arguments: supportedSelfMessage({ correlation_id: "" }),
    diagnostic: /'correlation_id' must be a non-empty string when provided/,
  },
  {
    name: "a blank correlation_id",
    arguments: supportedSelfMessage({ correlation_id: "   " }),
    diagnostic: /'correlation_id' must be a non-empty string when provided/,
  },
  {
    name: "a non-string correlation_id",
    arguments: supportedSelfMessage({ correlation_id: 42 }),
    diagnostic: /'correlation_id' must be a non-empty string when provided/,
  },
];

for (const { name, arguments: args, diagnostic } of invalidBoundaryCases) {
  test(`send_message rejects ${name} at the MCP boundary`, async () => {
    await withServer(async (client, dbFile) => {
      const response = await client.callTool({
        name: "send_message",
        arguments: args,
      });
      assert.equal((response as ToolResponse).isError, true, textOf(response));
      assert.match(textOf(response), diagnostic);
      assert.deepEqual(
        await inbox(client),
        [],
        "a rejected send must not write an inbox row",
      );
      assert.deepEqual(
        durableDeliveryCounts(dbFile),
        { messages: 0, inboxes: 0 },
        "a rejected send must not commit a hidden messages row",
      );
    });
  });
}