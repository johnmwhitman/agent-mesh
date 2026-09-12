/**
 * get_inbox MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `get_inbox` is the durable polling-fallback
 * READ path for the P2P messaging substrate (src/index.ts advertised schema
 * at L810-L821 + handler at toolHandlers["get_inbox"] L2150-L2164 on
 * origin/main 8433dcb8). subscribe_inbox (SSE) is documented as advisory
 * and falls back to get_inbox when SSE is unreachable. 2026-09-09
 * get-inbox-mcp-contract worktree never landed on origin/main. This card
 * is a fresh origin/main pin with the 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — {type:object, properties:{agent_id:{type:string},
 *      since:{type:number, description:"Epoch ms timestamp"}},
 *      required:[agent_id]} with NO additionalProperties key (advertising
 *      false would be a lie; handler has no requireAllowedKeys) +
 *      annotations {readOnlyHint:true, idempotentHint:true,
 *      destructiveHint:false, openWorldHint:false} + description
 *      "Get messages in an agent's inbox, optionally since a timestamp."
 *   2. boundary validation — 8 non-string/missing/blank agent_id shapes
 *      (missing, null, number, boolean, array, object, empty-string,
 *      whitespace-only) all return isError:true with
 *      /agent_id.*non-empty string/ rejection text; 4 non-finite since
 *      shapes (string, object, boolean, array) return isError:true with
 *      /since.*finite number/. A non-numeric `since` compares as NaN and
 *      would silently return an empty inbox — a message-loss path, not a
 *      cosmetic one (the handler comment documents this).
 *   3. empty-inbox response — unknown agent returns EXACTLY { messages: [] }
 *      (NOT an isError; JSON.stringify does not drop the empty array).
 *   4. real-inbox Message shape — registerAgentInLedger + sendMessage
 *      seeded before child connects; response { messages: [1] } with
 *      documented Message fields id/from_agent_id/to_agent_id/fleet_id/
 *      type/payload/timestamp/acknowledged. No isError/ok/error envelope.
 *   5. since-filter — timestamp > since (strict greater-than). Cutoff at
 *      the middle of three seeded messages keeps only the later one.
 *      This is the polling-fallback contract.
 *   6. advertised-vs-handler honesty — phantom top-level keys
 *      (phantom_filter/debug_emit/future_field/force/nested/note) are
 *      silently ignored AND no phantom keys leak into the response.
 *      This is HONEST: additionalProperties is not advertised,
 *      handler does not enforce it.
 *   7. source-string pin — handler is firstError(requireString
 *      ("get_inbox","agent_id",agent_id), optionalNumber
 *      ("get_inbox","since",since)) then jsonResult({ messages:
 *      getInbox(agent_id, since) }) with NO try/catch, NO
 *      requireAllowedKeys, NO spawnFleet/wakeAgent/sendMessage/fetch,
 *      registered exactly once. Message interface at src/core.ts pins
 *      id/from_agent_id/to_agent_id/fleet_id/type/payload/timestamp/
 *      acknowledged.
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * No published-figure bump. HANDOFF.md is not edited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  registerAgentInLedger,
  sendMessage,
  type Agent,
} from "../src/core.js";
import { closeDb } from "../src/db.js";

// process.cwd(), not import.meta-relative: tsconfig.test.json compiles into
// dist/, where node_modules/tsx does not exist and the stdio child dies
// with "Cannot find module .../dist/node_modules/tsx/dist/loader.mjs".
const repoRoot = process.cwd();

type ToolResponse = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
};

const textOf = (response: unknown): string =>
  (response as ToolResponse).content[0]!.text;
const bodyOf = (response: unknown): Record<string, unknown> =>
  JSON.parse(textOf(response)) as Record<string, unknown>;

type Fixture = {
  dir: string;
  dataFile: string;
  dbFile: string;
  eventsFile: string;
};

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-get-inbox-mcp-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-get-inbox-${dir}`,
      private: true,
      version: "1.0.0",
    }) + "\n",
  );
  return {
    dir,
    dataFile: join(dir, "ledger.json"),
    dbFile: join(dir, "ledger.db"),
    eventsFile: join(dir, "events.jsonl"),
  };
}

function applyFixtureEnv(fix: Fixture): void {
  process.env.MESHFLEET_DB_FILE = fix.dbFile;
  process.env.MESHFLEET_DATA_FILE = fix.dataFile;
  process.env.MESHFLEET_EVENT_LOG_FILE = fix.eventsFile;
  process.env.HOME = fix.dir;
}

function clearFixtureEnv(): void {
  delete process.env.MESHFLEET_DB_FILE;
  delete process.env.MESHFLEET_DATA_FILE;
  delete process.env.MESHFLEET_EVENT_LOG_FILE;
  delete process.env.HOME;
}

const childEnv = (fix: Fixture): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  MESHFLEET_DB_FILE: fix.dbFile,
  MESHFLEET_DATA_FILE: fix.dataFile,
  MESHFLEET_EVENT_LOG_FILE: fix.eventsFile,
  MESHFLEET_RATIFY_SWEEP_MS: "0",
  AGENT_MESH_CHILD: "1",
  HOME: fix.dir,
});

async function connectChild(fix: Fixture): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs"),
      join(repoRoot, "src", "index.ts"),
    ],
    cwd: fix.dir,
    env: childEnv(fix),
    stderr: "ignore",
  });
  const client = new Client(
    { name: "get-inbox-contract-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

async function cleanupFix(fix: Fixture): Promise<void> {
  closeDb();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(fix.dir, { recursive: true, force: true });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 4) {
        rmSync(fix.dir, { recursive: true, force: true });
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  clearFixtureEnv();
}

/** Child-mode: recovery, sweeper, and SSE skipped. HOME+cwd isolated. */
async function withChildServer(
  fix: Fixture,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  applyFixtureEnv(fix);
  const client = await connectChild(fix);
  try {
    await fn(client);
  } finally {
    await client.close().catch(() => {});
    await cleanupFix(fix);
  }
}

const GET_INBOX_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const fixtureAgent = (id: string, fleetId: string): Agent => ({
  id,
  fleet_id: fleetId,
  role: `${id}-role`,
  prompt: `${id}-prompt`,
  status: "running",
});

function extractHandlerBlock(src: string): string {
  const match = src.match(/toolHandlers\["get_inbox"\][\s\S]*?^};/m);
  assert.ok(match, "get_inbox handler block must be extractable");
  return match[0];
}

function extractSchemaBlock(src: string): { schema: string; annotations: string } {
  const start = src.indexOf('name: "get_inbox"');
  assert.notEqual(start, -1, "advertised get_inbox schema block must be extractable");
  const window = src.slice(start, start + 900);
  const schemaStart = window.indexOf("inputSchema:");
  const annotationsStart = window.indexOf("annotations:");
  assert.ok(schemaStart >= 0 && annotationsStart > schemaStart, "inputSchema + annotations must follow name");
  const schema = window.slice(schemaStart, annotationsStart);
  const annotations = window.slice(annotationsStart, annotationsStart + 220);
  return { schema, annotations };
}

async function callOk(
  client: Client,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name: "get_inbox", arguments: args });
  assert.notEqual(
    (response as ToolResponse).isError,
    true,
    `get_inbox must succeed; got: ${textOf(response)}`,
  );
  return bodyOf(response);
}

// ─── Test 1: advertised schema + annotations + description honesty ───

test("get_inbox: advertised schema requires agent_id string + optional since number, no additionalProperties, four annotations, description names Get messages in an agent's inbox", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "get_inbox");
    assert.ok(tool, "get_inbox must be advertised");

    assert.deepEqual(tool!.inputSchema, {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        since: { type: "number", description: "Epoch ms timestamp" },
      },
      required: ["agent_id"],
    });
    // Honesty: handler ignores extra keys and has no requireAllowedKeys.
    // Advertising additionalProperties:false would be a lie.
    assert.equal(
      "additionalProperties" in tool!.inputSchema,
      false,
      "additionalProperties must be ABSENT — handler never enforces it; advertising false would be a lie",
    );

    assert.deepEqual(tool!.annotations, GET_INBOX_ANNOTATIONS);

    const desc = tool!.description ?? "";
    assert.match(desc, /Get messages in an agent's inbox/i);
    assert.match(desc, /since a timestamp/i);
    assert.doesNotMatch(
      desc,
      /write|mutate|delete|spawn|ack/i,
      "read-only inbox description must not claim a write",
    );
  });
});

// ─── Test 2: boundary validation — missing / non-string / blank agent_id + non-finite since ───

test("get_inbox: refuses missing / non-string / blank agent_id AND non-finite since with a named error (not a silent empty inbox)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const agentCases: ReadonlyArray<{
      label: string;
      args: Record<string, unknown>;
    }> = [
      { label: "missing agent_id", args: {} },
      { label: "null agent_id", args: { agent_id: null } },
      { label: "number agent_id", args: { agent_id: 42 } },
      { label: "boolean agent_id", args: { agent_id: true } },
      { label: "array agent_id", args: { agent_id: ["alice"] } },
      { label: "object agent_id", args: { agent_id: { id: "alice" } } },
      { label: "empty-string agent_id", args: { agent_id: "" } },
      { label: "whitespace-only agent_id", args: { agent_id: "   \t " } },
    ];
    for (const { label, args } of agentCases) {
      const response = await client.callTool({
        name: "get_inbox",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be a tool error, not a silent empty inbox`,
      );
      assert.match(
        textOf(response),
        /agent_id.*non-empty string/,
        `${label}: rejection text must name agent_id; got: ${textOf(response)}`,
      );
    }

    // NaN / Infinity cannot traverse the JSON-RPC envelope
    // (JSON.stringify(NaN) === "null"); optionalNumber treats null as
    // absence. Pin the shapes that actually reach the handler.
    const sinceCases: ReadonlyArray<{
      label: string;
      value: unknown;
    }> = [
      { label: "string since", value: "not-a-number" },
      { label: "object since", value: { ts: 1700000000000 } },
      { label: "boolean since", value: true },
      { label: "array since", value: [1700000000000] },
    ];
    for (const { label, value } of sinceCases) {
      const response = await client.callTool({
        name: "get_inbox",
        arguments: { agent_id: "x", since: value },
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be a tool error, not a silent empty inbox (NaN compare)`,
      );
      assert.match(
        textOf(response),
        /since.*finite number/,
        `${label}: rejection text must name since; got: ${textOf(response)}`,
      );
    }
  });
});

// ─── Test 3: unknown agent returns { messages: [] } ───

test("get_inbox: returns EXACTLY { messages: [] } for an unknown agent (NOT an isError)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const result = await callOk(client, { agent_id: "never-registered-agent" });
    assert.deepEqual(result.messages, []);
    assert.equal(result.ok, undefined);
    assert.equal(result.error, undefined);
    const extraTop = Object.keys(result).filter((k) => k !== "messages");
    assert.deepEqual(
      extraTop,
      [],
      `response must be exactly {messages:[]}; extra: ${extraTop.join(",")}`,
    );
  });
});

// ─── Test 4: seeded message returns documented Message shape ───

test("get_inbox: returns { messages: [Message] } with documented fields for a seeded recipient", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  registerAgentInLedger(fixtureAgent("shape-sender", "shape-fleet"));
  registerAgentInLedger(fixtureAgent("shape-recipient", "shape-fleet"));
  sendMessage(
    "shape-sender",
    "shape-recipient",
    "shape-fleet",
    "handoff",
    "shape-payload",
  );

  await withChildServer(fix, async (client) => {
    const result = await callOk(client, { agent_id: "shape-recipient" });
    const messages = result.messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 1, "recipient inbox MUST contain exactly 1 message");
    const m = messages[0]!;
    assert.equal(typeof m.id, "string");
    assert.ok((m.id as string).length > 0, "id MUST be a non-empty string");
    assert.equal(m.from_agent_id, "shape-sender");
    assert.equal(m.to_agent_id, "shape-recipient");
    assert.equal(m.fleet_id, "shape-fleet");
    assert.equal(m.type, "handoff");
    assert.equal(m.payload, "shape-payload");
    assert.equal(typeof m.timestamp, "number");
    assert.ok(
      Number.isFinite(m.timestamp as number) && (m.timestamp as number) > 0,
      `timestamp MUST be a finite positive number, got ${m.timestamp}`,
    );
    assert.equal(typeof m.acknowledged, "boolean");
    assert.equal(m.acknowledged, false);

    assert.equal(result.ok, undefined);
    assert.equal(result.error, undefined);
    const extraTop = Object.keys(result).filter((k) => k !== "messages");
    assert.deepEqual(
      extraTop,
      [],
      `response must be exactly {messages}; extra: ${extraTop.join(",")}`,
    );
  });
});

// ─── Test 5: since-filter is strict greater-than (polling-fallback contract) ───

test("get_inbox: since filter returns ONLY messages with timestamp > since (strict greater-than)", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  registerAgentInLedger(fixtureAgent("since-sender", "since-fleet"));
  registerAgentInLedger(fixtureAgent("since-recipient", "since-fleet"));
  sendMessage("since-sender", "since-recipient", "since-fleet", "handoff", "first");
  await new Promise((r) => setTimeout(r, 5));
  sendMessage("since-sender", "since-recipient", "since-fleet", "handoff", "second");
  await new Promise((r) => setTimeout(r, 5));
  sendMessage("since-sender", "since-recipient", "since-fleet", "handoff", "third");

  await withChildServer(fix, async (client) => {
    const full = await callOk(client, { agent_id: "since-recipient" });
    const fullMessages = full.messages as Array<Record<string, unknown>>;
    assert.equal(fullMessages.length, 3, "all three messages must be present");
    const ts1 = fullMessages[0]!.timestamp as number;
    const ts2 = fullMessages[1]!.timestamp as number;
    const ts3 = fullMessages[2]!.timestamp as number;
    assert.ok(ts1 <= ts2 && ts2 <= ts3, "timestamps MUST be non-decreasing");

    const filtered = await callOk(client, {
      agent_id: "since-recipient",
      since: ts2,
    });
    const filteredMessages = filtered.messages as Array<Record<string, unknown>>;
    assert.equal(
      filteredMessages.length,
      1,
      `since=ts2 MUST keep exactly 1 message (timestamp > ts2), got ${filteredMessages.length}: ${JSON.stringify(filteredMessages)}`,
    );
    assert.equal(filteredMessages[0]!.timestamp, ts3);
    assert.equal(filteredMessages[0]!.payload, "third");

    const filtered2 = await callOk(client, {
      agent_id: "since-recipient",
      since: ts3 - 1,
    });
    const filtered2Messages = filtered2.messages as Array<Record<string, unknown>>;
    assert.equal(filtered2Messages.length, 1);
    assert.equal(filtered2Messages[0]!.timestamp, ts3);

    // two quiet full-inbox calls are identical (idempotentHint)
    const again = await callOk(client, { agent_id: "since-recipient" });
    assert.deepEqual(
      full,
      again,
      "two quiet get_inbox calls must return identical snapshots (idempotentHint)",
    );
  });
});

// ─── Test 6: phantom extra keys silently ignored (honesty) ───

test("get_inbox: phantom extra keys are silently ignored (additionalProperties not advertised, handler does not enforce)", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  registerAgentInLedger(fixtureAgent("phantom-sender", "phantom-fleet"));
  registerAgentInLedger(fixtureAgent("phantom-agent", "phantom-fleet"));
  sendMessage(
    "phantom-sender",
    "phantom-agent",
    "phantom-fleet",
    "handoff",
    "phantom-payload",
  );

  await withChildServer(fix, async (client) => {
    const result = await callOk(client, {
      agent_id: "phantom-agent",
      phantom_filter: "ignored",
      debug_emit: true,
      future_field: 42,
      force: "yes",
      nested: { a: 1 },
      note: "should be ignored",
    });
    const messages = result.messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.payload, "phantom-payload");
    assert.equal(result.phantom_filter, undefined);
    assert.equal(result.debug_emit, undefined);
    assert.equal(result.future_field, undefined);
    assert.equal(result.force, undefined);
    assert.equal(result.nested, undefined);
    assert.equal(result.note, undefined);
    const extraTop = Object.keys(result).filter((k) => k !== "messages");
    assert.deepEqual(
      extraTop,
      [],
      `phantom keys must NOT leak into the response; extra: ${extraTop.join(",")}`,
    );
  });
});

// ─── Test 7: source-string pin ───

test("get_inbox: source-string pin — firstError(requireString agent_id, optionalNumber since) + jsonResult({messages: getInbox(agent_id, since)}), no allowedKeys/spawn", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    const registrations = src.match(/toolHandlers\["get_inbox"\]/g) ?? [];
    assert.equal(
      registrations.length,
      1,
      `handler must be registered exactly once; got ${registrations.length}`,
    );

    const handlerBlock = extractHandlerBlock(src);
    assert.match(
      handlerBlock,
      /toolHandlers\["get_inbox"\]\s*=\s*async\s*\(\s*args\s*\)\s*=>\s*\{/,
    );
    assert.match(handlerBlock, /firstError\s*\(/);
    assert.match(
      handlerBlock,
      /requireString\(\s*"get_inbox"\s*,\s*"agent_id"\s*,\s*agent_id\s*\)/,
    );
    assert.match(
      handlerBlock,
      /optionalNumber\(\s*"get_inbox"\s*,\s*"since"\s*,\s*since\s*\)/,
    );
    assert.match(
      handlerBlock,
      /return\s+jsonResult\(\s*\{\s*messages:\s*getInbox\(\s*agent_id\s*,\s*since\s*\)\s*\}\s*\)\s*;/,
    );
    assert.doesNotMatch(
      handlerBlock,
      /requireAllowedKeys/,
      "handler must NOT enforce additionalProperties (advertising false would be a lie)",
    );
    assert.doesNotMatch(
      handlerBlock,
      /spawnFleet|wakeAgent|sendMessage|fetch\(/,
    );
    assert.doesNotMatch(
      handlerBlock,
      /toolHandlers\["get_inbox"\]\s*=\s*async\s*\(\s*\{/,
      "handler must NOT destructure-cast args at the signature",
    );
    assert.doesNotMatch(
      handlerBlock,
      /\btry\s*\{/,
      "handler must NOT wrap its body in try/catch (would change isError semantics)",
    );
    assert.doesNotMatch(
      handlerBlock,
      /checkRateLimit/,
      "get_inbox has no rate-limit gate (pinned absence — unlike fleet_status/list_fleets)",
    );

    const { schema, annotations } = extractSchemaBlock(src);
    assert.match(schema, /type:\s*"object"/);
    assert.match(schema, /agent_id:\s*\{\s*type:\s*"string"\s*\}/);
    assert.match(schema, /since:\s*\{\s*type:\s*"number"/);
    assert.match(schema, /required:\s*\[\s*"agent_id"\s*\]/);
    assert.doesNotMatch(
      schema,
      /additionalProperties/,
      "advertised schema must NOT carry additionalProperties (handler does not enforce it)",
    );
    assert.match(annotations, /readOnlyHint:\s*true/);
    assert.match(annotations, /idempotentHint:\s*true/);
    assert.match(annotations, /destructiveHint:\s*false/);
    assert.match(annotations, /openWorldHint:\s*false/);

    const core = readFileSync(join(repoRoot, "src", "core.ts"), "utf-8");
    const ifaceStart = core.indexOf("export interface Message {");
    assert.notEqual(ifaceStart, -1, "src/core.ts must export interface Message");
    const window = core.slice(ifaceStart, ifaceStart + 1200);
    const blockEnd = window.indexOf("\nexport ");
    const block = blockEnd === -1 ? window : window.slice(0, blockEnd);
    for (const field of [
      "id",
      "from_agent_id",
      "to_agent_id",
      "fleet_id",
      "type",
      "payload",
      "timestamp",
      "acknowledged",
    ]) {
      const present = block.includes(`${field}:`) || block.includes(`${field}?:`);
      assert.ok(
        present,
        `Message interface MUST define \`${field}:\`; block:\n${block.slice(0, 400)}`,
      );
    }

    const response = await client.callTool({
      name: "get_inbox",
      arguments: { agent_id: "source-pin-empty" },
    });
    const body = bodyOf(response);
    assert.deepEqual(body.messages, []);
  });
});
