/**
 * get_receipts MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `get_receipts` is the operator-facing
 * READ of the receipt trail for a message (src/index.ts advertised schema
 * at L821-L832 + handler at toolHandlers["get_receipts"] L2264-L2269 on
 * origin/main 8433dcb8). It answers "who saw this and who acted on it".
 * 2026-08-20 / 2026-09-08 / 2026-09-11 get-receipts worktrees never
 * landed on origin/main. This card is a fresh origin/main pin with the
 * 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — {type:object, properties:{message_id:{type:string}},
 *      required:[message_id]} with NO additionalProperties key (advertising
 *      false would be a lie; handler has no requireAllowedKeys) +
 *      annotations {readOnlyHint:true, idempotentHint:true,
 *      destructiveHint:false, openWorldHint:false} + description names
 *      "full receipt trail" / "who acked, who annotated, when".
 *   2. boundary validation — 8 non-string/missing/blank message_id shapes
 *      (missing, null, number, boolean, array, object, empty-string,
 *      whitespace-only) all return isError:true with
 *      /message_id.*non-empty string/ rejection text. A wrong-typed
 *      message_id must be NAMED, not shrugged into an empty trail.
 *   3. unknown-message response — EXACTLY {receipts:[]} with no
 *      isError/ok/error envelope (NOT an isError; JSON.stringify does
 *      not drop the empty array).
 *   4. real-trail Receipt shape — registerAgentInLedger + sendMessage +
 *      writeReceipt("seen") + ackMessage seeded before child connects;
 *      response {receipts:[2]} oldest-first with documented fields
 *      message_id/agent_id/action/timestamp (+ optional note).
 *   5. two quiet calls identical (idempotentHint) — the trail is a
 *      snapshot, not a consume.
 *   6. advertised-vs-handler honesty — phantom top-level keys
 *      (phantom_filter/debug_emit/future_field/force/nested/note) are
 *      silently ignored AND no phantom keys leak into the response.
 *      This is HONEST: additionalProperties is not advertised,
 *      handler does not enforce it.
 *   7. source-string pin — handler destructure-casts
 *      `const { message_id } = args as { message_id: string }` then
 *      requireString("get_receipts","message_id",message_id) then
 *      jsonResult({ receipts: getReceipts(message_id) }) with NO
 *      try/catch, NO requireAllowedKeys, NO spawnFleet/wakeAgent/
 *      sendMessage/fetch, NO checkRateLimit, registered exactly once.
 *      Named bug class is the handler destructure-cast of args
 *      (null/non-object args throw instead of jsonError). Receipt
 *      interface at src/core.ts pins message_id/agent_id/action/
 *      timestamp/note?.
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
  ackMessage,
  registerAgentInLedger,
  sendMessage,
  writeReceipt,
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-get-receipts-mcp-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-get-receipts-${dir}`,
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
    { name: "get-receipts-contract-test", version: "1.0.0" },
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

const GET_RECEIPTS_ANNOTATIONS = {
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
  const match = src.match(/toolHandlers\["get_receipts"\][\s\S]*?^};/m);
  assert.ok(match, "get_receipts handler block must be extractable");
  return match[0];
}

function extractSchemaBlock(src: string): { schema: string; annotations: string } {
  const start = src.indexOf('name: "get_receipts"');
  assert.notEqual(start, -1, "advertised get_receipts schema block must be extractable");
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
  const response = await client.callTool({ name: "get_receipts", arguments: args });
  assert.notEqual(
    (response as ToolResponse).isError,
    true,
    `get_receipts must succeed; got: ${textOf(response)}`,
  );
  return bodyOf(response);
}

function seedTrail(fix: Fixture): string {
  applyFixtureEnv(fix);
  registerAgentInLedger(fixtureAgent("trail-sender", "trail-fleet"));
  registerAgentInLedger(fixtureAgent("trail-recipient", "trail-fleet"));
  const { messageId } = sendMessage(
    "trail-sender",
    "trail-recipient",
    "trail-fleet",
    "handoff",
    "trail-payload",
  );
  writeReceipt("trail-recipient", messageId, "seen", "annotated");
  ackMessage("trail-recipient", messageId);
  return messageId;
}

// ─── Test 1: advertised schema + annotations + description honesty ───

test("get_receipts: advertised schema requires message_id string, no additionalProperties, four annotations, description names full receipt trail", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "get_receipts");
    assert.ok(tool, "get_receipts must be advertised");

    assert.deepEqual(tool!.inputSchema, {
      type: "object",
      properties: {
        message_id: { type: "string" },
      },
      required: ["message_id"],
    });
    // Honesty: handler ignores extra keys and has no requireAllowedKeys.
    // Advertising additionalProperties:false would be a lie.
    assert.equal(
      "additionalProperties" in tool!.inputSchema,
      false,
      "additionalProperties must be ABSENT — handler never enforces it; advertising false would be a lie",
    );

    assert.deepEqual(tool!.annotations, GET_RECEIPTS_ANNOTATIONS);

    const desc = tool!.description ?? "";
    assert.match(desc, /full receipt trail/i);
    assert.match(desc, /who acked, who annotated, when/i);
    assert.doesNotMatch(
      desc,
      /write|mutate|delete|spawn/i,
      "read-only receipt-trail description must not claim a write",
    );
  });
});

// ─── Test 2: boundary validation — missing / non-string / blank message_id ───

test("get_receipts: refuses missing / non-string / blank message_id with a named error (not a silent empty trail)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const cases: ReadonlyArray<{
      label: string;
      args: Record<string, unknown>;
    }> = [
      { label: "missing message_id", args: {} },
      { label: "null message_id", args: { message_id: null } },
      { label: "number message_id", args: { message_id: 42 } },
      { label: "boolean message_id", args: { message_id: true } },
      { label: "array message_id", args: { message_id: ["mid"] } },
      { label: "object message_id", args: { message_id: { id: "mid" } } },
      { label: "empty-string message_id", args: { message_id: "" } },
      { label: "whitespace-only message_id", args: { message_id: "   \t " } },
    ];
    for (const { label, args } of cases) {
      const response = await client.callTool({
        name: "get_receipts",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be a tool error, not a silent empty trail`,
      );
      assert.match(
        textOf(response),
        /message_id.*non-empty string/,
        `${label}: rejection text must name message_id; got: ${textOf(response)}`,
      );
    }
  });
});

// ─── Test 3: unknown message returns { receipts: [] } ───

test("get_receipts: returns EXACTLY { receipts: [] } for an unknown message (NOT an isError)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const result = await callOk(client, { message_id: "never-sent-message" });
    assert.deepEqual(result.receipts, []);
    assert.equal(result.ok, undefined);
    assert.equal(result.error, undefined);
    const extraTop = Object.keys(result).filter((k) => k !== "receipts");
    assert.deepEqual(
      extraTop,
      [],
      `response must be exactly {receipts:[]}; extra: ${extraTop.join(",")}`,
    );
  });
});

// ─── Test 4: seeded trail returns documented Receipt shape, oldest first ───

test("get_receipts: returns { receipts: [Receipt, Receipt] } oldest-first with documented fields for a seeded trail", async () => {
  const fix = makeFixture();
  const messageId = seedTrail(fix);

  await withChildServer(fix, async (client) => {
    const result = await callOk(client, { message_id: messageId });
    const receipts = result.receipts as Array<Record<string, unknown>>;
    assert.equal(receipts.length, 2, "trail MUST contain exactly 2 receipts (seen + ack)");
    const first = receipts[0]!;
    const second = receipts[1]!;

    assert.equal(first.message_id, messageId);
    assert.equal(first.agent_id, "trail-recipient");
    assert.equal(first.action, "seen");
    assert.equal(first.note, "annotated");
    assert.equal(typeof first.timestamp, "number");
    assert.ok(
      Number.isFinite(first.timestamp as number) && (first.timestamp as number) > 0,
      `timestamp MUST be a finite positive number, got ${first.timestamp}`,
    );

    assert.equal(second.message_id, messageId);
    assert.equal(second.agent_id, "trail-recipient");
    assert.equal(second.action, "ack");
    assert.equal(typeof second.timestamp, "number");
    assert.ok(
      Number.isFinite(second.timestamp as number) && (second.timestamp as number) > 0,
      `ack timestamp MUST be a finite positive number, got ${second.timestamp}`,
    );
    assert.ok(
      (second.timestamp as number) >= (first.timestamp as number),
      "receipts MUST be oldest-first (seen before ack)",
    );

    assert.equal(result.ok, undefined);
    assert.equal(result.error, undefined);
    const extraTop = Object.keys(result).filter((k) => k !== "receipts");
    assert.deepEqual(
      extraTop,
      [],
      `response must be exactly {receipts}; extra: ${extraTop.join(",")}`,
    );
  });
});

// ─── Test 5: two quiet calls are identical (idempotentHint) ───

test("get_receipts: two quiet calls return identical snapshots (idempotentHint — trail is a snapshot, not a consume)", async () => {
  const fix = makeFixture();
  const messageId = seedTrail(fix);

  await withChildServer(fix, async (client) => {
    const first = await callOk(client, { message_id: messageId });
    const second = await callOk(client, { message_id: messageId });
    assert.deepEqual(
      first,
      second,
      "two quiet get_receipts calls must return identical snapshots (idempotentHint)",
    );
    const receipts = first.receipts as Array<Record<string, unknown>>;
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0]!.action, "seen");
    assert.equal(receipts[1]!.action, "ack");
  });
});

// ─── Test 6: phantom extra keys silently ignored (honesty) ───

test("get_receipts: phantom extra keys are silently ignored (additionalProperties not advertised, handler does not enforce)", async () => {
  const fix = makeFixture();
  const messageId = seedTrail(fix);

  await withChildServer(fix, async (client) => {
    const result = await callOk(client, {
      message_id: messageId,
      phantom_filter: "ignored",
      debug_emit: true,
      future_field: 42,
      force: "yes",
      nested: { a: 1 },
      note: "should be ignored",
    });
    const receipts = result.receipts as Array<Record<string, unknown>>;
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0]!.action, "seen");
    assert.equal(result.phantom_filter, undefined);
    assert.equal(result.debug_emit, undefined);
    assert.equal(result.future_field, undefined);
    assert.equal(result.force, undefined);
    assert.equal(result.nested, undefined);
    assert.equal(result.note, undefined);
    const extraTop = Object.keys(result).filter((k) => k !== "receipts");
    assert.deepEqual(
      extraTop,
      [],
      `phantom keys must NOT leak into the response; extra: ${extraTop.join(",")}`,
    );
  });
});

// ─── Test 7: source-string pin ───

test("get_receipts: source-string pin — destructure-cast message_id + requireString + jsonResult({receipts: getReceipts(message_id)}), no allowedKeys/spawn", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    const registrations = src.match(/toolHandlers\["get_receipts"\]/g) ?? [];
    assert.equal(
      registrations.length,
      1,
      `handler must be registered exactly once; got ${registrations.length}`,
    );

    const handlerBlock = extractHandlerBlock(src);
    assert.match(
      handlerBlock,
      /toolHandlers\["get_receipts"\]\s*=\s*async\s*\(\s*args\s*\)\s*=>\s*\{/,
    );
    assert.match(
      handlerBlock,
      /const\s*\{\s*message_id\s*\}\s*=\s*args\s+as\s*\{\s*message_id:\s*string\s*\}/,
    );
    assert.match(
      handlerBlock,
      /requireString\(\s*"get_receipts"\s*,\s*"message_id"\s*,\s*message_id\s*\)/,
    );
    assert.match(
      handlerBlock,
      /return\s+jsonResult\(\s*\{\s*receipts:\s*getReceipts\(\s*message_id\s*\)\s*\}\s*\)\s*;/,
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
      /toolHandlers\["get_receipts"\]\s*=\s*async\s*\(\s*\{/,
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
      "get_receipts has no rate-limit gate (pinned absence — unlike fleet_status/list_fleets)",
    );

    const { schema, annotations } = extractSchemaBlock(src);
    assert.match(schema, /type:\s*"object"/);
    assert.match(schema, /message_id:\s*\{\s*type:\s*"string"\s*\}/);
    assert.match(schema, /required:\s*\[\s*"message_id"\s*\]/);
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
    const ifaceStart = core.indexOf("export interface Receipt {");
    assert.notEqual(ifaceStart, -1, "src/core.ts must export interface Receipt");
    const window = core.slice(ifaceStart, ifaceStart + 800);
    const blockEnd = window.indexOf("\nexport ");
    const block = blockEnd === -1 ? window : window.slice(0, blockEnd);
    for (const field of ["message_id", "agent_id", "action", "timestamp"]) {
      const present = block.includes(`${field}:`) || block.includes(`${field}?:`);
      assert.ok(
        present,
        `Receipt interface MUST define \`${field}:\`; block:\n${block.slice(0, 400)}`,
      );
    }
    assert.ok(
      block.includes("note?:"),
      `Receipt interface MUST define optional note?; block:\n${block.slice(0, 400)}`,
    );

    const response = await client.callTool({
      name: "get_receipts",
      arguments: { message_id: "source-pin-empty" },
    });
    const body = bodyOf(response);
    assert.deepEqual(body.receipts, []);
  });
});
