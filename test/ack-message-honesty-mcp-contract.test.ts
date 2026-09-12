/**
 * ack_message MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names. Honesty-pattern refresh (2026-09-12).
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `ack_message` is the consuming
 * acknowledgement boundary (src/index.ts advertised schema at L824-L835 +
 * handler at toolHandlers["ack_message"] L2259-L2274 on origin/main
 * 8433dcb8). It answers "did this recipient consume this message" and
 * writes an `ack` receipt. origin/main already ships
 * `test/ack-message-mcp-contract.test.ts` (6 hardening witnesses:
 * schema+recipient consume, broadcast sibling isolation, hallucinated
 * {ok:false}, sender-not-recipient, non-string wire shapes, restart
 * durability). Those witnesses do NOT pin advertised-vs-handler honesty:
 * additionalProperties absence, the four annotations, phantom extra
 * keys, source-string shape, or the named bug class (handler
 * destructure-cast of args). 2026-08-20 / 2026-09-09 ack-message
 * worktrees never landed a 2026-09-12 honesty pin. This card is a
 * complementary origin/main pin — it does NOT replace the 6 hardening
 * witnesses.
 *
 *   1. advertised schema pin — {type:object,
 *      properties:{agent_id:{type:string}, message_id:{type:string}},
 *      required:[agent_id, message_id]} with NO additionalProperties
 *      key (advertising false would be a lie; handler has no
 *      requireAllowedKeys) + annotations {idempotentHint:true,
 *      readOnlyHint:false, destructiveHint:false, openWorldHint:false}
 *      + description names "Acknowledge a message" / "removing it from
 *      the agent's inbox" / "ack receipt" / "per-recipient" / broadcast
 *      independently.
 *   2. boundary validation — missing / non-string / blank agent_id AND
 *      message_id shapes all return isError:true with a named
 *      /agent_id|message_id.*non-empty string/ rejection AND NEVER a
 *      phantom ok:true (the historical defect: omitted agent_id wrote
 *      a receipt keyed `<msg>:undefined:ack`, consumed no inbox, and
 *      returned {ok:true}; verify_ledger passed it).
 *   3. unknown-message response — EXACTLY {ok:false} with no isError
 *      envelope (jsonResult, not jsonError). A hallucinated message_id
 *      is a named no, not a transport error.
 *   4. happy-path consume — registerAgentInLedger + sendMessage seeded
 *      before child connects; recipient ack_message returns EXACTLY
 *      {ok:true}; get_inbox no longer lists the message; get_receipts
 *      carries an `ack` receipt for that recipient.
 *   5. two quiet calls identical (idempotentHint) — writeReceipt is
 *      idempotent per (message, agent, action); the second ack is
 *      still {ok:true} and does not mint a second receipt.
 *   6. advertised-vs-handler honesty — phantom top-level keys
 *      (phantom_filter/debug_emit/future_field/force/nested/note) are
 *      silently ignored AND no phantom keys leak into the response.
 *      This is HONEST: additionalProperties is not advertised,
 *      handler does not enforce it.
 *   7. source-string pin — handler destructure-casts
 *      `const { agent_id, message_id } = args as { agent_id: string;
 *      message_id: string }` then firstError(requireString
 *      ("ack_message","agent_id",agent_id), requireString
 *      ("ack_message","message_id",message_id)) then
 *      jsonResult({ ok: ackMessage(agent_id, message_id) }) with NO
 *      try/catch, NO requireAllowedKeys, NO spawnFleet/wakeAgent/
 *      sendMessage/fetch, NO checkRateLimit, registered exactly once.
 *      Named bug class is the handler destructure-cast of args
 *      (null/non-object args throw instead of jsonError).
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * WRITE-ISOLATION LAW: every run that opens a ledger sets ALL THREE of
 * MESHFLEET_DB_FILE, MESHFLEET_DATA_FILE, MESHFLEET_EVENT_LOG_FILE to
 * temp paths — ack_message writes.
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-ack-message-honesty-mcp-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-ack-message-honesty-${dir}`,
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
    { name: "ack-message-honesty-contract-test", version: "1.0.0" },
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

const ACK_MESSAGE_ANNOTATIONS = {
  idempotentHint: true,
  readOnlyHint: false,
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
  const start = src.indexOf('toolHandlers["ack_message"] = async');
  assert.ok(start > 0, "ack_message handler block must be extractable");
  const nextHandler = src.indexOf("\ntoolHandlers[", start + 1);
  const end = nextHandler > 0 ? nextHandler : src.length;
  return src.slice(start, end);
}

function extractSchemaBlock(src: string): {
  schema: string;
  annotations: string;
} {
  const start = src.indexOf('name: "ack_message"');
  assert.notEqual(start, -1, "advertised ack_message schema block must be extractable");
  const nextName = src.indexOf('name: "receipt"', start + 1);
  const window = src.slice(start, nextName > 0 ? nextName : start + 900);
  const schemaStart = window.indexOf("inputSchema:");
  const annotationsStart = window.indexOf("annotations:");
  assert.ok(
    schemaStart >= 0 && annotationsStart > schemaStart,
    "inputSchema + annotations must follow name",
  );
  const schema = window.slice(schemaStart, annotationsStart);
  const annotations = window.slice(annotationsStart);
  return { schema, annotations };
}

async function callAck(
  client: Client,
  args: Record<string, unknown>,
): Promise<{ response: unknown; body: Record<string, unknown> }> {
  const response = await client.callTool({ name: "ack_message", arguments: args });
  return { response, body: bodyOf(response) };
}

function seedDirectedMessage(fix: Fixture): string {
  applyFixtureEnv(fix);
  registerAgentInLedger(fixtureAgent("ack-sender", "ack-fleet"));
  registerAgentInLedger(fixtureAgent("ack-recipient", "ack-fleet"));
  const { messageId } = sendMessage(
    "ack-sender",
    "ack-recipient",
    "ack-fleet",
    "handoff",
    "ack-honesty-payload",
  );
  return messageId;
}

// ─── Test 1: advertised schema + annotations + description honesty ───

test("ack_message: advertised schema requires agent_id+message_id strings, no additionalProperties, four annotations, description names consume + per-recipient ack receipt", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "ack_message");
    assert.ok(tool, "ack_message must be advertised");

    assert.deepEqual(tool!.inputSchema, {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        message_id: { type: "string" },
      },
      required: ["agent_id", "message_id"],
    });
    // Honesty: handler ignores extra keys and has no requireAllowedKeys.
    // Advertising additionalProperties:false would be a lie.
    assert.equal(
      "additionalProperties" in tool!.inputSchema,
      false,
      "additionalProperties must be ABSENT — handler never enforces it; advertising false would be a lie",
    );

    assert.equal(tool!.annotations?.idempotentHint, ACK_MESSAGE_ANNOTATIONS.idempotentHint);
    assert.equal(tool!.annotations?.readOnlyHint, ACK_MESSAGE_ANNOTATIONS.readOnlyHint);
    assert.equal(tool!.annotations?.destructiveHint, ACK_MESSAGE_ANNOTATIONS.destructiveHint);
    assert.equal(tool!.annotations?.openWorldHint, ACK_MESSAGE_ANNOTATIONS.openWorldHint);

    const desc = tool!.description ?? "";
    assert.match(desc, /Acknowledge a message/);
    assert.match(desc, /removing it from the agent's inbox/);
    assert.match(desc, /ack[''] receipt|Writes an 'ack' receipt/);
    assert.match(desc, /per-recipient/);
    assert.match(desc, /broadcast is acked independently/i);
    assert.doesNotMatch(
      desc,
      /read-only|does not (write|mutate|consume)/i,
      "consuming-ack description must not claim a read-only surface",
    );
  });
});

// ─── Test 2: boundary validation — never a phantom ok:true ───

test("ack_message: refuses missing / non-string / blank agent_id and message_id with a named error (NEVER a phantom ok:true)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const cases: ReadonlyArray<{
      label: string;
      field: "agent_id" | "message_id";
      args: Record<string, unknown>;
    }> = [
      { label: "missing agent_id", field: "agent_id", args: { message_id: "m1" } },
      { label: "null agent_id", field: "agent_id", args: { agent_id: null, message_id: "m1" } },
      { label: "number agent_id", field: "agent_id", args: { agent_id: 42, message_id: "m1" } },
      { label: "boolean agent_id", field: "agent_id", args: { agent_id: true, message_id: "m1" } },
      { label: "array agent_id", field: "agent_id", args: { agent_id: ["a"], message_id: "m1" } },
      { label: "object agent_id", field: "agent_id", args: { agent_id: { id: "a" }, message_id: "m1" } },
      { label: "empty-string agent_id", field: "agent_id", args: { agent_id: "", message_id: "m1" } },
      {
        label: "whitespace-only agent_id",
        field: "agent_id",
        args: { agent_id: "   \t ", message_id: "m1" },
      },
      { label: "missing message_id", field: "message_id", args: { agent_id: "a1" } },
      { label: "null message_id", field: "message_id", args: { agent_id: "a1", message_id: null } },
      { label: "number message_id", field: "message_id", args: { agent_id: "a1", message_id: 42 } },
      {
        label: "boolean message_id",
        field: "message_id",
        args: { agent_id: "a1", message_id: true },
      },
      {
        label: "array message_id",
        field: "message_id",
        args: { agent_id: "a1", message_id: ["m"] },
      },
      {
        label: "object message_id",
        field: "message_id",
        args: { agent_id: "a1", message_id: { id: "m" } },
      },
      {
        label: "empty-string message_id",
        field: "message_id",
        args: { agent_id: "a1", message_id: "" },
      },
      {
        label: "whitespace-only message_id",
        field: "message_id",
        args: { agent_id: "a1", message_id: "   \t " },
      },
    ];
    for (const { label, field, args } of cases) {
      const { response, body } = await callAck(client, args);
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be a tool error, not a silent consume`,
      );
      assert.match(
        textOf(response),
        new RegExp(`${field}.*non-empty string`),
        `${label}: rejection text must name ${field}; got: ${textOf(response)}`,
      );
      assert.notEqual(
        body.ok,
        true,
        `${label}: MUST NEVER return a phantom ok:true (historical omitted-agent_id defect); got: ${JSON.stringify(body)}`,
      );
    }
  });
});

// ─── Test 3: unknown message returns { ok: false } ───

test("ack_message: returns EXACTLY { ok: false } for an unknown message (NOT an isError)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { response, body } = await callAck(client, {
      agent_id: "ack-recipient",
      message_id: "never-sent-message",
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `unknown message_id must be jsonResult {ok:false}, not a transport error; got: ${textOf(response)}`,
    );
    assert.equal(body.ok, false);
    assert.equal(body.error, undefined);
    const extraTop = Object.keys(body).filter((k) => k !== "ok");
    assert.deepEqual(
      extraTop,
      [],
      `response must be exactly {ok:false}; extra: ${extraTop.join(",")}`,
    );
  });
});

// ─── Test 4: happy-path consume + inbox drain + ack receipt ───

test("ack_message: recipient consume returns EXACTLY { ok: true }, drains inbox, writes ack receipt", async () => {
  const fix = makeFixture();
  const messageId = seedDirectedMessage(fix);

  await withChildServer(fix, async (client) => {
    const { response, body } = await callAck(client, {
      agent_id: "ack-recipient",
      message_id: messageId,
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `recipient ack must succeed; got: ${textOf(response)}`,
    );
    assert.equal(body.ok, true);
    assert.equal(body.error, undefined);
    const extraTop = Object.keys(body).filter((k) => k !== "ok");
    assert.deepEqual(
      extraTop,
      [],
      `response must be exactly {ok:true}; extra: ${extraTop.join(",")}`,
    );

    const inboxResponse = await client.callTool({
      name: "get_inbox",
      arguments: { agent_id: "ack-recipient" },
    });
    assert.notEqual((inboxResponse as ToolResponse).isError, true);
    const inboxBody = bodyOf(inboxResponse);
    const messages = inboxBody.messages as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(messages), "get_inbox must return {messages:[]}");
    assert.equal(
      messages.filter((m) => m.id === messageId).length,
      0,
      "acked message MUST be gone from the recipient inbox",
    );

    const receiptsResponse = await client.callTool({
      name: "get_receipts",
      arguments: { message_id: messageId },
    });
    assert.notEqual((receiptsResponse as ToolResponse).isError, true);
    const receiptsBody = bodyOf(receiptsResponse);
    const receipts = receiptsBody.receipts as Array<Record<string, unknown>>;
    const ack = receipts.find(
      (r) => r.agent_id === "ack-recipient" && r.action === "ack",
    );
    assert.ok(ack, "consume MUST write an ack receipt for the recipient");
    assert.equal(ack!.message_id, messageId);
    assert.equal(typeof ack!.timestamp, "number");
  });
});

// ─── Test 5: two quiet calls are identical (idempotentHint) ───

test("ack_message: two quiet calls return identical { ok: true } snapshots (idempotentHint — writeReceipt is per (message, agent, action))", async () => {
  const fix = makeFixture();
  const messageId = seedDirectedMessage(fix);

  await withChildServer(fix, async (client) => {
    const first = await callAck(client, {
      agent_id: "ack-recipient",
      message_id: messageId,
    });
    const second = await callAck(client, {
      agent_id: "ack-recipient",
      message_id: messageId,
    });
    assert.notEqual((first.response as ToolResponse).isError, true);
    assert.notEqual((second.response as ToolResponse).isError, true);
    assert.deepEqual(
      first.body,
      second.body,
      "two quiet ack_message calls must return identical snapshots (idempotentHint)",
    );
    assert.equal(first.body.ok, true);
    assert.equal(second.body.ok, true);

    const receiptsResponse = await client.callTool({
      name: "get_receipts",
      arguments: { message_id: messageId },
    });
    const receipts = bodyOf(receiptsResponse).receipts as Array<Record<string, unknown>>;
    const acks = receipts.filter(
      (r) => r.agent_id === "ack-recipient" && r.action === "ack",
    );
    assert.equal(acks.length, 1, "idempotent repeat must NOT mint a second ack receipt");
  });
});

// ─── Test 6: phantom extra keys silently ignored (honesty) ───

test("ack_message: phantom extra keys are silently ignored (additionalProperties not advertised, handler does not enforce)", async () => {
  const fix = makeFixture();
  const messageId = seedDirectedMessage(fix);

  await withChildServer(fix, async (client) => {
    const { response, body } = await callAck(client, {
      agent_id: "ack-recipient",
      message_id: messageId,
      phantom_filter: "ignored",
      debug_emit: true,
      future_field: 42,
      force: "yes",
      nested: { a: 1 },
      note: "should be ignored",
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `phantom keys must be ignored, not rejected; got: ${textOf(response)}`,
    );
    assert.equal(body.ok, true);
    assert.equal(body.phantom_filter, undefined);
    assert.equal(body.debug_emit, undefined);
    assert.equal(body.future_field, undefined);
    assert.equal(body.force, undefined);
    assert.equal(body.nested, undefined);
    assert.equal(body.note, undefined);
    const extraTop = Object.keys(body).filter((k) => k !== "ok");
    assert.deepEqual(
      extraTop,
      [],
      `phantom keys must NOT leak into the response; extra: ${extraTop.join(",")}`,
    );
  });
});

// ─── Test 7: source-string pin ───

test("ack_message: source-string pin — destructure-cast agent_id+message_id + firstError(requireString, requireString) + jsonResult({ok: ackMessage(...)}), no allowedKeys/spawn", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    const registrations = src.match(/toolHandlers\["ack_message"\]/g) ?? [];
    assert.equal(
      registrations.length,
      1,
      `handler must be registered exactly once; got ${registrations.length}`,
    );

    const handlerBlock = extractHandlerBlock(src);
    assert.match(
      handlerBlock,
      /toolHandlers\["ack_message"\]\s*=\s*async\s*\(\s*args\s*\)\s*=>\s*\{/,
    );
    assert.match(
      handlerBlock,
      /const\s*\{\s*agent_id\s*,\s*message_id\s*\}\s*=\s*args\s+as\s*\{\s*agent_id:\s*string;\s*message_id:\s*string\s*;?\s*\}/,
    );
    assert.match(
      handlerBlock,
      /requireString\(\s*"ack_message"\s*,\s*"agent_id"\s*,\s*agent_id\s*\)/,
    );
    assert.match(
      handlerBlock,
      /requireString\(\s*"ack_message"\s*,\s*"message_id"\s*,\s*message_id\s*\)/,
    );
    assert.match(
      handlerBlock,
      /return\s+jsonResult\(\s*\{\s*ok:\s*ackMessage\(\s*agent_id\s*,\s*message_id\s*\)\s*\}\s*\)\s*;/,
    );
    assert.doesNotMatch(
      handlerBlock,
      /requireAllowedKeys/,
      "handler must NOT enforce additionalProperties (advertising false would be a lie)",
    );
    assert.doesNotMatch(handlerBlock, /spawnFleet|wakeAgent|sendMessage|fetch\(/);
    assert.doesNotMatch(
      handlerBlock,
      /toolHandlers\["ack_message"\]\s*=\s*async\s*\(\s*\{/,
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
      "ack_message has no rate-limit gate (pinned absence)",
    );

    const { schema, annotations } = extractSchemaBlock(src);
    assert.match(schema, /type:\s*"object"/);
    assert.match(schema, /agent_id:\s*\{\s*type:\s*"string"\s*\}/);
    assert.match(schema, /message_id:\s*\{\s*type:\s*"string"\s*\}/);
    assert.match(schema, /required:\s*\[\s*"agent_id"\s*,\s*"message_id"\s*\]/);
    assert.doesNotMatch(
      schema,
      /additionalProperties/,
      "advertised schema must NOT carry additionalProperties (handler does not enforce it)",
    );
    assert.match(annotations, /idempotentHint:\s*true/);
    assert.match(annotations, /readOnlyHint:\s*false/);
    assert.match(annotations, /destructiveHint:\s*false/);
    assert.match(annotations, /openWorldHint:\s*false/);

    const response = await client.callTool({
      name: "ack_message",
      arguments: { agent_id: "source-pin-empty", message_id: "source-pin-empty" },
    });
    assert.notEqual((response as ToolResponse).isError, true);
    const body = bodyOf(response);
    assert.equal(body.ok, false);
  });
});
