/**
 * receipt MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names. Honesty-pattern refresh (2026-09-12).
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `receipt` is the non-consuming audit
 * primitive (src/index.ts advertised schema at L838-L851 + handler at
 * toolHandlers["receipt"] L2276-L2295 on origin/main 8433dcb8). It writes
 * one row per (message, agent, action) WITHOUT consuming the inbox.
 * 2026-09-10 receipt-mcp-contract worktree never landed on origin/main.
 * This card is a fresh origin/main pin with the 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — {type:object,
 *      properties:{agent_id:{type:string}, message_id:{type:string},
 *      action:{type:string, description:...}, note:{type:string}},
 *      required:[agent_id, message_id, action]} with NO additionalProperties
 *      key (advertising false would be a lie; handler has no
 *      requireAllowedKeys) + annotations {idempotentHint:true,
 *      readOnlyHint:false, destructiveHint:false, openWorldHint:false}
 *      + description names "non-consuming" / "stays in the inbox" /
 *      "audit primitive" / "idempotent".
 *   2. boundary validation — missing / non-string / blank agent_id,
 *      message_id, AND action shapes all return isError:true with a
 *      named /agent_id|message_id|action.*non-empty string/ rejection
 *      AND NEVER a phantom {receipt:...} (historical omitted-action
 *      defect corrupted the message_id:agent_id:action idempotency key).
 *   3. action === "ack" short-circuit — EXACTLY jsonError("Use
 *      ack_message to consume a message; receipt is for non-consuming
 *      actions"). Ack is reserved for ack_message (the CONSUMING
 *      operation). A regression that lifted this guard would let
 *      callers write "ack" receipts without consuming the inbox.
 *   4. unknown-message response — EXACTLY isError with
 *      "No such message: ${message_id}" (writeReceipt returns null;
 *      handler converts to jsonError). NOT {receipt:null}.
 *   5. happy-path write + inbox preserved — registerAgentInLedger +
 *      sendMessage seeded before child connects; receipt returns
 *      EXACTLY {receipt:{message_id,agent_id,action,timestamp}} with
 *      optional note; get_inbox STILL lists the message (non-consuming);
 *      get_receipts carries the written row.
 *   6. two quiet calls identical (idempotentHint) — writeReceipt is
 *      idempotent per (message, agent, action); the second call returns
 *      the SAME timestamp and does not mint a second receipt. A
 *      different action on the same (msg,agent) pair DOES mint a
 *      fresh row.
 *   7. advertised-vs-handler honesty — phantom top-level keys
 *      (phantom_filter/debug_emit/future_field/force/nested) are
 *      silently ignored AND no phantom keys leak into the response.
 *      Optional `note` IS accepted (advertised). This is HONEST:
 *      additionalProperties is not advertised, handler does not
 *      enforce it.
 *   8. source-string pin — handler destructure-casts
 *      `const { agent_id, message_id, action, note } = args as {
 *      agent_id: string; message_id: string; action: string; note?: string }`
 *      then firstError(requireString("receipt", ...)*3) then the
 *      action==="ack" jsonError then writeReceipt then
 *      jsonResult({ receipt }) with NO try/catch, NO requireAllowedKeys,
 *      NO spawnFleet/wakeAgent/sendMessage/fetch, NO checkRateLimit,
 *      registered exactly once. Named bug class is the handler
 *      destructure-cast of args (null/non-object args throw instead
 *      of jsonError).
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * WRITE-ISOLATION LAW: every run that opens a ledger sets ALL THREE of
 * MESHFLEET_DB_FILE, MESHFLEET_DATA_FILE, MESHFLEET_EVENT_LOG_FILE to
 * temp paths — receipt writes.
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-receipt-honesty-mcp-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-receipt-honesty-${dir}`,
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
    { name: "receipt-honesty-contract-test", version: "1.0.0" },
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

const RECEIPT_ANNOTATIONS = {
  idempotentHint: true,
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const ACTION_DESCRIPTION =
  "e.g. 'seen', 'r-ack', 'retracted' — any label except 'ack' (use ack_message to consume)";

const fixtureAgent = (id: string, fleetId: string): Agent => ({
  id,
  fleet_id: fleetId,
  role: `${id}-role`,
  prompt: `${id}-prompt`,
  status: "running",
});

function extractHandlerBlock(src: string): string {
  const start = src.indexOf('toolHandlers["receipt"] = async');
  assert.ok(start > 0, "receipt handler block must be extractable");
  const nextHandler = src.indexOf("\ntoolHandlers[", start + 1);
  const end = nextHandler > 0 ? nextHandler : src.length;
  return src.slice(start, end);
}

function extractSchemaBlock(src: string): {
  schema: string;
  annotations: string;
} {
  const start = src.indexOf('name: "receipt"');
  assert.notEqual(start, -1, "advertised receipt schema block must be extractable");
  const nextName = src.indexOf('name: "get_receipts"', start + 1);
  const window = src.slice(start, nextName > 0 ? nextName : start + 1200);
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

async function callReceipt(
  client: Client,
  args: Record<string, unknown>,
): Promise<{ response: unknown; body: Record<string, unknown> }> {
  const response = await client.callTool({ name: "receipt", arguments: args });
  return { response, body: bodyOf(response) };
}

function seedDirectedMessage(fix: Fixture): string {
  applyFixtureEnv(fix);
  registerAgentInLedger(fixtureAgent("rcp-sender", "rcp-fleet"));
  registerAgentInLedger(fixtureAgent("rcp-recipient", "rcp-fleet"));
  const { messageId } = sendMessage(
    "rcp-sender",
    "rcp-recipient",
    "rcp-fleet",
    "handoff",
    "receipt-honesty-payload",
  );
  return messageId;
}

function assertReceiptShape(
  receipt: Record<string, unknown>,
  expected: { message_id: string; agent_id: string; action: string; note?: string },
): void {
  assert.equal(receipt.message_id, expected.message_id);
  assert.equal(receipt.agent_id, expected.agent_id);
  assert.equal(receipt.action, expected.action);
  assert.equal(typeof receipt.timestamp, "number");
  assert.ok(
    Number.isFinite(receipt.timestamp as number) && (receipt.timestamp as number) > 0,
    `timestamp MUST be a finite positive number, got ${receipt.timestamp}`,
  );
  if (expected.note !== undefined) {
    assert.equal(receipt.note, expected.note);
  } else {
    assert.equal(receipt.note, undefined);
  }
}

// ─── Test 1: advertised schema + annotations + description honesty ───

test("receipt: advertised schema requires agent_id+message_id+action strings + optional note, no additionalProperties, four annotations, description names non-consuming audit primitive", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "receipt");
    assert.ok(tool, "receipt must be advertised");

    assert.deepEqual(tool!.inputSchema, {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        message_id: { type: "string" },
        action: { type: "string", description: ACTION_DESCRIPTION },
        note: { type: "string" },
      },
      required: ["agent_id", "message_id", "action"],
    });
    // Honesty: handler ignores extra keys and has no requireAllowedKeys.
    // Advertising additionalProperties:false would be a lie.
    assert.equal(
      "additionalProperties" in tool!.inputSchema,
      false,
      "additionalProperties must be ABSENT — handler never enforces it; advertising false would be a lie",
    );

    assert.equal(tool!.annotations?.idempotentHint, RECEIPT_ANNOTATIONS.idempotentHint);
    assert.equal(tool!.annotations?.readOnlyHint, RECEIPT_ANNOTATIONS.readOnlyHint);
    assert.equal(tool!.annotations?.destructiveHint, RECEIPT_ANNOTATIONS.destructiveHint);
    assert.equal(tool!.annotations?.openWorldHint, RECEIPT_ANNOTATIONS.openWorldHint);

    const desc = tool!.description ?? "";
    assert.match(desc, /non-consuming/);
    assert.match(desc, /audit primitive/);
    assert.match(desc, /stays in the inbox/);
    assert.match(desc, /idempotent/);
    assert.match(desc, /seen/);
    assert.match(desc, /r-ack/);
    assert.match(desc, /retracted/);
    assert.doesNotMatch(
      desc,
      /read-only|does not (write|mutate)/i,
      "non-consuming write description must not claim a read-only surface",
    );
  });
});

// ─── Test 2: boundary validation — never a phantom receipt ───

test("receipt: refuses missing / non-string / blank agent_id, message_id, and action with a named error (NEVER a phantom receipt)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const cases: ReadonlyArray<{
      label: string;
      field: "agent_id" | "message_id" | "action";
      args: Record<string, unknown>;
    }> = [
      { label: "missing agent_id", field: "agent_id", args: { message_id: "m1", action: "seen" } },
      { label: "null agent_id", field: "agent_id", args: { agent_id: null, message_id: "m1", action: "seen" } },
      { label: "number agent_id", field: "agent_id", args: { agent_id: 42, message_id: "m1", action: "seen" } },
      { label: "boolean agent_id", field: "agent_id", args: { agent_id: true, message_id: "m1", action: "seen" } },
      { label: "array agent_id", field: "agent_id", args: { agent_id: ["a"], message_id: "m1", action: "seen" } },
      { label: "object agent_id", field: "agent_id", args: { agent_id: { id: "a" }, message_id: "m1", action: "seen" } },
      { label: "empty-string agent_id", field: "agent_id", args: { agent_id: "", message_id: "m1", action: "seen" } },
      {
        label: "whitespace-only agent_id",
        field: "agent_id",
        args: { agent_id: "   \t ", message_id: "m1", action: "seen" },
      },
      { label: "missing message_id", field: "message_id", args: { agent_id: "a1", action: "seen" } },
      { label: "null message_id", field: "message_id", args: { agent_id: "a1", message_id: null, action: "seen" } },
      { label: "number message_id", field: "message_id", args: { agent_id: "a1", message_id: 42, action: "seen" } },
      {
        label: "boolean message_id",
        field: "message_id",
        args: { agent_id: "a1", message_id: true, action: "seen" },
      },
      {
        label: "array message_id",
        field: "message_id",
        args: { agent_id: "a1", message_id: ["m"], action: "seen" },
      },
      {
        label: "object message_id",
        field: "message_id",
        args: { agent_id: "a1", message_id: { id: "m" }, action: "seen" },
      },
      {
        label: "empty-string message_id",
        field: "message_id",
        args: { agent_id: "a1", message_id: "", action: "seen" },
      },
      {
        label: "whitespace-only message_id",
        field: "message_id",
        args: { agent_id: "a1", message_id: "   \t ", action: "seen" },
      },
      { label: "missing action", field: "action", args: { agent_id: "a1", message_id: "m1" } },
      { label: "null action", field: "action", args: { agent_id: "a1", message_id: "m1", action: null } },
      { label: "number action", field: "action", args: { agent_id: "a1", message_id: "m1", action: 42 } },
      { label: "boolean action", field: "action", args: { agent_id: "a1", message_id: "m1", action: true } },
      { label: "array action", field: "action", args: { agent_id: "a1", message_id: "m1", action: ["seen"] } },
      { label: "object action", field: "action", args: { agent_id: "a1", message_id: "m1", action: { kind: "seen" } } },
      { label: "empty-string action", field: "action", args: { agent_id: "a1", message_id: "m1", action: "" } },
      {
        label: "whitespace-only action",
        field: "action",
        args: { agent_id: "a1", message_id: "m1", action: "   \t " },
      },
    ];
    for (const { label, field, args } of cases) {
      const { response, body } = await callReceipt(client, args);
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be a tool error, not a silent write`,
      );
      assert.match(
        textOf(response),
        new RegExp(`${field}.*non-empty string`),
        `${label}: rejection text must name ${field}; got: ${textOf(response)}`,
      );
      assert.equal(
        body.receipt,
        undefined,
        `${label}: MUST NEVER return a phantom receipt (historical omitted-action defect); got: ${JSON.stringify(body)}`,
      );
    }
  });
});

// ─── Test 3: action === "ack" is reserved for ack_message ───

test("receipt: action='ack' is refused as isError pointing the caller at ack_message (NEVER writes an ack row)", async () => {
  const fix = makeFixture();
  const messageId = seedDirectedMessage(fix);

  await withChildServer(fix, async (client) => {
    const { response, body } = await callReceipt(client, {
      agent_id: "rcp-recipient",
      message_id: messageId,
      action: "ack",
    });
    assert.equal(
      (response as ToolResponse).isError,
      true,
      `action='ack' must be a tool error; got: ${textOf(response)}`,
    );
    assert.match(
      textOf(response),
      /Use ack_message to consume a message; receipt is for non-consuming actions/,
    );
    assert.equal(body.receipt, undefined);

    const inboxResponse = await client.callTool({
      name: "get_inbox",
      arguments: { agent_id: "rcp-recipient" },
    });
    assert.notEqual((inboxResponse as ToolResponse).isError, true);
    const messages = bodyOf(inboxResponse).messages as Array<Record<string, unknown>>;
    assert.equal(
      messages.filter((m) => m.id === messageId).length,
      1,
      "refused action='ack' MUST leave the message in the inbox (non-consuming)",
    );

    const receiptsResponse = await client.callTool({
      name: "get_receipts",
      arguments: { message_id: messageId },
    });
    const receipts = bodyOf(receiptsResponse).receipts as Array<Record<string, unknown>>;
    assert.equal(
      receipts.filter((r) => r.action === "ack").length,
      0,
      "refused action='ack' MUST NOT write an ack receipt",
    );
  });
});

// ─── Test 4: unknown message is a structured isError ───

test("receipt: returns isError 'No such message: ${message_id}' for an unknown message (NOT {receipt:null})", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { response, body } = await callReceipt(client, {
      agent_id: "rcp-recipient",
      message_id: "never-sent-message",
      action: "seen",
    });
    assert.equal(
      (response as ToolResponse).isError,
      true,
      `unknown message_id must be jsonError, not a success body; got: ${textOf(response)}`,
    );
    assert.match(textOf(response), /No such message: never-sent-message/);
    assert.equal(
      body.receipt,
      undefined,
      `unknown message MUST NOT return {receipt:null}; got: ${JSON.stringify(body)}`,
    );
    assert.equal(typeof body.error, "string");
  });
});

// ─── Test 5: happy-path write + inbox preserved + note ───

test("receipt: writes EXACTLY { receipt } with documented fields, preserves inbox, optional note lands", async () => {
  const fix = makeFixture();
  const messageId = seedDirectedMessage(fix);

  await withChildServer(fix, async (client) => {
    const { response, body } = await callReceipt(client, {
      agent_id: "rcp-recipient",
      message_id: messageId,
      action: "seen",
      note: "annotated-on-wire",
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `recipient receipt must succeed; got: ${textOf(response)}`,
    );
    assert.equal(body.error, undefined);
    const extraTop = Object.keys(body).filter((k) => k !== "receipt");
    assert.deepEqual(
      extraTop,
      [],
      `response must be exactly {receipt}; extra: ${extraTop.join(",")}`,
    );
    const receipt = body.receipt as Record<string, unknown>;
    assert.ok(receipt && typeof receipt === "object", "body.receipt must be an object");
    assertReceiptShape(receipt, {
      message_id: messageId,
      agent_id: "rcp-recipient",
      action: "seen",
      note: "annotated-on-wire",
    });

    const inboxResponse = await client.callTool({
      name: "get_inbox",
      arguments: { agent_id: "rcp-recipient" },
    });
    assert.notEqual((inboxResponse as ToolResponse).isError, true);
    const messages = bodyOf(inboxResponse).messages as Array<Record<string, unknown>>;
    assert.equal(
      messages.filter((m) => m.id === messageId).length,
      1,
      "non-consuming receipt MUST leave the message in the recipient inbox",
    );

    const receiptsResponse = await client.callTool({
      name: "get_receipts",
      arguments: { message_id: messageId },
    });
    assert.notEqual((receiptsResponse as ToolResponse).isError, true);
    const receipts = bodyOf(receiptsResponse).receipts as Array<Record<string, unknown>>;
    const seen = receipts.find(
      (r) => r.agent_id === "rcp-recipient" && r.action === "seen",
    );
    assert.ok(seen, "write MUST land a seen receipt for the recipient");
    assert.equal(seen!.note, "annotated-on-wire");
    assert.equal(seen!.timestamp, receipt.timestamp);
  });
});

// ─── Test 6: two quiet calls are identical (idempotentHint) ───

test("receipt: two quiet calls return identical { receipt } snapshots (idempotentHint — writeReceipt is per (message, agent, action)); different action mints a fresh row", async () => {
  const fix = makeFixture();
  const messageId = seedDirectedMessage(fix);

  await withChildServer(fix, async (client) => {
    const first = await callReceipt(client, {
      agent_id: "rcp-recipient",
      message_id: messageId,
      action: "seen",
    });
    const second = await callReceipt(client, {
      agent_id: "rcp-recipient",
      message_id: messageId,
      action: "seen",
    });
    assert.notEqual((first.response as ToolResponse).isError, true);
    assert.notEqual((second.response as ToolResponse).isError, true);
    assert.deepEqual(
      first.body,
      second.body,
      "two quiet receipt calls must return identical snapshots (idempotentHint)",
    );
    const firstReceipt = first.body.receipt as Record<string, unknown>;
    const secondReceipt = second.body.receipt as Record<string, unknown>;
    assert.equal(firstReceipt.timestamp, secondReceipt.timestamp);

    const other = await callReceipt(client, {
      agent_id: "rcp-recipient",
      message_id: messageId,
      action: "r-ack",
    });
    assert.notEqual((other.response as ToolResponse).isError, true);
    const otherReceipt = other.body.receipt as Record<string, unknown>;
    assert.equal(otherReceipt.action, "r-ack");
    assert.notEqual(
      otherReceipt.timestamp,
      firstReceipt.timestamp,
      "a different action on the same (msg,agent) pair MUST mint a fresh row",
    );

    const receiptsResponse = await client.callTool({
      name: "get_receipts",
      arguments: { message_id: messageId },
    });
    const receipts = bodyOf(receiptsResponse).receipts as Array<Record<string, unknown>>;
    const seens = receipts.filter(
      (r) => r.agent_id === "rcp-recipient" && r.action === "seen",
    );
    const racks = receipts.filter(
      (r) => r.agent_id === "rcp-recipient" && r.action === "r-ack",
    );
    assert.equal(seens.length, 1, "idempotent repeat must NOT mint a second seen receipt");
    assert.equal(racks.length, 1, "different action must mint exactly one r-ack receipt");
  });
});

// ─── Test 7: phantom extra keys silently ignored (honesty) ───

test("receipt: phantom extra keys are silently ignored (additionalProperties not advertised, handler does not enforce); advertised note is accepted", async () => {
  const fix = makeFixture();
  const messageId = seedDirectedMessage(fix);

  await withChildServer(fix, async (client) => {
    const { response, body } = await callReceipt(client, {
      agent_id: "rcp-recipient",
      message_id: messageId,
      action: "seen",
      note: "keep-me",
      phantom_filter: "ignored",
      debug_emit: true,
      future_field: 42,
      force: "yes",
      nested: { a: 1 },
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `phantom keys must be ignored, not rejected; got: ${textOf(response)}`,
    );
    assert.equal(body.phantom_filter, undefined);
    assert.equal(body.debug_emit, undefined);
    assert.equal(body.future_field, undefined);
    assert.equal(body.force, undefined);
    assert.equal(body.nested, undefined);
    const extraTop = Object.keys(body).filter((k) => k !== "receipt");
    assert.deepEqual(
      extraTop,
      [],
      `phantom keys must NOT leak into the response; extra: ${extraTop.join(",")}`,
    );
    const receipt = body.receipt as Record<string, unknown>;
    assertReceiptShape(receipt, {
      message_id: messageId,
      agent_id: "rcp-recipient",
      action: "seen",
      note: "keep-me",
    });
  });
});

// ─── Test 8: source-string pin ───

test("receipt: source-string pin — destructure-cast agent_id+message_id+action+note + firstError(requireString x3) + ack short-circuit + jsonResult({receipt}), no allowedKeys/spawn", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    const registrations = src.match(/toolHandlers\["receipt"\]/g) ?? [];
    assert.equal(
      registrations.length,
      1,
      `handler must be registered exactly once; got ${registrations.length}`,
    );

    const handlerBlock = extractHandlerBlock(src);
    assert.match(
      handlerBlock,
      /toolHandlers\["receipt"\]\s*=\s*async\s*\(\s*args\s*\)\s*=>\s*\{/,
    );
    assert.match(
      handlerBlock,
      /const\s*\{\s*agent_id\s*,\s*message_id\s*,\s*action\s*,\s*note\s*\}\s*=\s*args\s+as\s*\{\s*agent_id:\s*string;\s*message_id:\s*string;\s*action:\s*string;\s*note\?:\s*string\s*;?\s*\}/,
    );
    assert.match(
      handlerBlock,
      /requireString\(\s*"receipt"\s*,\s*"agent_id"\s*,\s*agent_id\s*\)/,
    );
    assert.match(
      handlerBlock,
      /requireString\(\s*"receipt"\s*,\s*"message_id"\s*,\s*message_id\s*\)/,
    );
    assert.match(
      handlerBlock,
      /requireString\(\s*"receipt"\s*,\s*"action"\s*,\s*action\s*\)/,
    );
    assert.match(
      handlerBlock,
      /if\s*\(\s*action\s*===\s*"ack"\s*\)\s*\{/,
    );
    assert.match(
      handlerBlock,
      /return\s+jsonError\(\s*"Use ack_message to consume a message; receipt is for non-consuming actions"\s*\)/,
    );
    assert.match(
      handlerBlock,
      /const\s+receipt\s*=\s*writeReceipt\(\s*agent_id\s*,\s*message_id\s*,\s*action\s*,\s*note\s*\)/,
    );
    assert.match(
      handlerBlock,
      /if\s*\(\s*!receipt\s*\)\s*return\s+jsonError\(`No such message: \$\{message_id\}`\)/,
    );
    assert.match(
      handlerBlock,
      /return\s+jsonResult\(\s*\{\s*receipt\s*\}\s*\)\s*;/,
    );
    assert.doesNotMatch(
      handlerBlock,
      /requireAllowedKeys/,
      "handler must NOT enforce additionalProperties (advertising false would be a lie)",
    );
    assert.doesNotMatch(handlerBlock, /spawnFleet|wakeAgent|sendMessage|fetch\(/);
    assert.doesNotMatch(
      handlerBlock,
      /toolHandlers\["receipt"\]\s*=\s*async\s*\(\s*\{/,
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
      "receipt has no rate-limit gate (pinned absence)",
    );

    const { schema, annotations } = extractSchemaBlock(src);
    assert.match(schema, /type:\s*"object"/);
    assert.match(schema, /agent_id:\s*\{\s*type:\s*"string"\s*\}/);
    assert.match(schema, /message_id:\s*\{\s*type:\s*"string"\s*\}/);
    assert.match(schema, /action:\s*\{\s*type:\s*"string"/);
    assert.match(schema, /note:\s*\{\s*type:\s*"string"\s*\}/);
    assert.match(schema, /required:\s*\[\s*"agent_id"\s*,\s*"message_id"\s*,\s*"action"\s*\]/);
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
      name: "receipt",
      arguments: { agent_id: "source-pin-empty", message_id: "source-pin-empty", action: "seen" },
    });
    assert.equal((response as ToolResponse).isError, true);
    assert.match(textOf(response), /No such message: source-pin-empty/);
  });
});
