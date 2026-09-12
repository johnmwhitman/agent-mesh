/**
 * send_message MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `send_message` is the operator-facing
 * single-message P2P write (src/index.ts advertised schema at L764-L779 +
 * handler at toolHandlers["send_message"] L2015-L2069 on origin/main
 * 8433dcb8). It is published. 2026-09-08/2026-09-09
 * send-message-mcp-contract worktrees never landed on origin/main.
 * This card is a fresh origin/main pin with the 2026-09-12 honesty
 * pattern:
 *
 *   1. advertised schema pin — required
 *      [from_agent_id, to_agent_id, fleet_id, type, payload] in
 *      advertised order; correlation_id optional; NO additionalProperties
 *      key (advertising false would be a lie; handler has no
 *      requireAllowedKeys) + annotations {readOnlyHint:false,
 *      destructiveHint:false, idempotentHint:false, openWorldHint:false}
 *      + description phrases "P2P" / "within the same fleet" and
 *      to_agent_id "*" broadcast.
 *   2. missing required fields return isError naming send_message plus
 *      the field and NEVER a phantom ok:true.
 *   3. happy path jsonResult { message_id, recipients }.
 *   4. named bug class — handler destructure-cast of args (null /
 *      non-object args throw instead of jsonError, unlike send_messages
 *      L2071+ object guard).
 *   5. per-field guards — requireString from_agent_id/to_agent_id/fleet_id;
 *      requirePresentString payload; requireEnum type MESSAGE_TYPES;
 *      optionalNonBlankString correlation_id.
 *   6. advertised-vs-handler honesty — phantom extra keys do not error
 *      AND no phantom keys leak into the response. HONEST:
 *      additionalProperties is not advertised, handler does not
 *      enforce it.
 *   7. source-string pin — the six per-field guards in advertised
 *      order + jsonResult({ message_id: messageId, recipients }) +
 *      destructure-cast (the named bug) + NO requireAllowedKeys +
 *      registered exactly once.
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * WRITE-ISOLATION LAW: every run that opens a ledger sets ALL THREE of
 * MESHFLEET_DB_FILE, MESHFLEET_DATA_FILE, MESHFLEET_EVENT_LOG_FILE to
 * temp paths — send_message writes.
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-send-message-mcp-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-send-message-${dir}`,
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
    { name: "send-message-contract-test", version: "1.0.0" },
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

const SEND_MESSAGE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const MESSAGE_TYPE_ENUM = [
  "handoff",
  "question",
  "result",
  "alert",
  "request_help",
] as const;

const fixtureAgent = (id: string, fleetId: string): Agent => ({
  id,
  fleet_id: fleetId,
  role: `${id}-role`,
  prompt: `${id}-prompt`,
  status: "running",
});

function extractHandlerBlock(src: string): string {
  const start = src.indexOf('toolHandlers["send_message"] = async');
  assert.ok(start > 0, "send_message handler block must be extractable");
  const nextHandler = src.indexOf("\ntoolHandlers[", start + 1);
  const end = nextHandler > 0 ? nextHandler : src.length;
  return src.slice(start, end);
}

function extractSchemaBlock(src: string): { schema: string; annotations: string; description: string } {
  const start = src.indexOf('name: "send_message"');
  assert.notEqual(start, -1, "advertised send_message schema block must be extractable");
  // Bound the window at the next tool name so we never pick up send_messages.
  const nextName = src.indexOf('name: "send_messages"', start + 1);
  const window = src.slice(start, nextName > 0 ? nextName : start + 1800);
  const schemaStart = window.indexOf("inputSchema:");
  const annotationsStart = window.indexOf("annotations:");
  assert.ok(schemaStart >= 0 && annotationsStart > schemaStart, "inputSchema + annotations must follow name");
  const schema = window.slice(schemaStart, annotationsStart);
  const annotations = window.slice(annotationsStart);
  const description = window.slice(0, schemaStart);
  return { schema, annotations, description };
}

function extractSendMessagesHandlerBlock(src: string): string {
  const start = src.indexOf('toolHandlers["send_messages"] = async');
  assert.ok(start > 0, "send_messages handler block must be extractable");
  const nextHandler = src.indexOf("\ntoolHandlers[", start + 1);
  const end = nextHandler > 0 ? nextHandler : src.length;
  return src.slice(start, end);
}

async function callOk(
  client: Client,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name: "send_message", arguments: args });
  assert.notEqual(
    (response as ToolResponse).isError,
    true,
    `send_message must succeed; got: ${textOf(response)}`,
  );
  return bodyOf(response);
}

const happyArgs = {
  from_agent_id: "sender",
  to_agent_id: "recipient",
  fleet_id: "fleet-x",
  type: "handoff",
  payload: "bounded handoff",
} as const;

function seedHappyPath(fix: Fixture): void {
  applyFixtureEnv(fix);
  registerAgentInLedger(fixtureAgent("sender", "fleet-x"));
  registerAgentInLedger(fixtureAgent("recipient", "fleet-x"));
}

// ─── Test 1: advertised schema + annotations + description honesty ───

test("send_message: advertised schema requires from_agent_id/to_agent_id/fleet_id/type/payload in advertised order, correlation_id optional, no additionalProperties, four annotations all false, description names P2P same-fleet and '*' broadcast", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "send_message");
    assert.ok(tool, "send_message must be advertised");

    assert.deepEqual(tool!.inputSchema, {
      type: "object",
      properties: {
        from_agent_id: { type: "string", minLength: 1, pattern: "\\S" },
        to_agent_id: {
          type: "string",
          minLength: 1,
          pattern: "\\S",
          description: 'Recipient agent id, or "*" for fleet broadcast',
        },
        fleet_id: { type: "string", minLength: 1, pattern: "\\S" },
        type: {
          type: "string",
          enum: [...MESSAGE_TYPE_ENUM],
        },
        payload: { type: "string" },
        correlation_id: { type: "string", minLength: 1, pattern: "\\S" },
      },
      required: [
        "from_agent_id",
        "to_agent_id",
        "fleet_id",
        "type",
        "payload",
      ],
    });
    // Honesty: handler ignores extra keys and has no requireAllowedKeys.
    // Advertising additionalProperties:false would be a lie.
    assert.equal(
      "additionalProperties" in tool!.inputSchema,
      false,
      "additionalProperties must be ABSENT — handler never enforces it; advertising false would be a lie",
    );

    assert.deepEqual(tool!.annotations, SEND_MESSAGE_ANNOTATIONS);

    const desc = tool!.description ?? "";
    assert.match(desc, /P2P/);
    assert.match(desc, /within the same fleet/);
    assert.match(desc, /to_agent_id/);
    assert.match(desc, /\*/);
    assert.match(desc, /broadcast/);
  });
});

// ─── Test 2: missing required fields — named isError, never phantom ok:true ───

test("send_message: missing required fields return isError naming send_message plus the field and NEVER a phantom ok:true", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const cases: ReadonlyArray<{ missing: string; args: Record<string, unknown> }> = [
      {
        missing: "from_agent_id",
        args: {
          to_agent_id: "recipient",
          fleet_id: "fleet-x",
          type: "handoff",
          payload: "x",
        },
      },
      {
        missing: "to_agent_id",
        args: {
          from_agent_id: "sender",
          fleet_id: "fleet-x",
          type: "handoff",
          payload: "x",
        },
      },
      {
        missing: "fleet_id",
        args: {
          from_agent_id: "sender",
          to_agent_id: "recipient",
          type: "handoff",
          payload: "x",
        },
      },
      {
        missing: "type",
        args: {
          from_agent_id: "sender",
          to_agent_id: "recipient",
          fleet_id: "fleet-x",
          payload: "x",
        },
      },
      {
        missing: "payload",
        args: {
          from_agent_id: "sender",
          to_agent_id: "recipient",
          fleet_id: "fleet-x",
          type: "handoff",
        },
      },
    ];
    for (const { missing, args } of cases) {
      const response = await client.callTool({
        name: "send_message",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `missing ${missing}: must be a tool error, not a silent write`,
      );
      const text = textOf(response);
      assert.match(
        text,
        /send_message/,
        `missing ${missing}: rejection text must name send_message; got: ${text}`,
      );
      assert.match(
        text,
        new RegExp(missing),
        `missing ${missing}: rejection text must name the field; got: ${text}`,
      );
      const body = bodyOf(response);
      assert.notEqual(
        body.ok,
        true,
        `missing ${missing}: MUST NEVER return a phantom ok:true; got: ${JSON.stringify(body)}`,
      );
      assert.equal(
        body.message_id,
        undefined,
        `missing ${missing}: must not mint a message_id`,
      );
    }
  });
});

// ─── Test 3: happy path jsonResult { message_id, recipients } ───

test("send_message: happy path returns jsonResult { message_id, recipients }", async () => {
  const fix = makeFixture();
  seedHappyPath(fix);
  await withChildServer(fix, async (client) => {
    const result = await callOk(client, { ...happyArgs });
    assert.equal(typeof result.message_id, "string");
    assert.ok(
      (result.message_id as string).length > 0,
      "message_id must be a non-empty string",
    );
    assert.deepEqual(result.recipients, ["recipient"]);
    assert.equal(result.ok, undefined);
    assert.equal(result.error, undefined);
    const extraTop = Object.keys(result).filter(
      (k) => k !== "message_id" && k !== "recipients",
    );
    assert.deepEqual(
      extraTop,
      [],
      `response must be exactly {message_id, recipients}; extra: ${extraTop.join(",")}`,
    );
  });
});

// ─── Test 4: named bug class — destructure-cast of args ───

test("send_message: named bug class — handler destructure-cast of args (null/non-object throw instead of jsonError, unlike send_messages object guard)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    // Runtime liveness so this test is not a pure source grep: listTools
    // proves the child is the same process whose source we pin.
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "send_message"));
    assert.ok(tools.some((t) => t.name === "send_messages"));

    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");
    const sendMessageBlock = extractHandlerBlock(src);
    const sendMessagesBlock = extractSendMessagesHandlerBlock(src);

    // Named bug: send_message destructure-casts args with no object guard.
    assert.match(
      sendMessageBlock,
      /toolHandlers\["send_message"\]\s*=\s*async\s*\(\s*args\s*\)\s*=>\s*\{/,
    );
    assert.match(
      sendMessageBlock,
      /const\s*\{\s*from_agent_id\s*,\s*to_agent_id\s*,\s*fleet_id\s*,\s*type\s*,\s*payload\s*,\s*correlation_id\s*,?\s*\}\s*=\s*args\s+as\s*\{/,
    );
    assert.doesNotMatch(
      sendMessageBlock,
      /args\s*===\s*null\s*\|\|\s*typeof\s+args\s*!==\s*"object"/,
      "send_message MUST still lack the object guard (named bug class vs send_messages)",
    );
    assert.doesNotMatch(
      sendMessageBlock,
      /arguments must be an object/,
      "send_message must NOT jsonError on non-object args (that guard lives on send_messages)",
    );

    // Contrast: send_messages HAS the object guard (L2071+ on origin/main).
    assert.match(
      sendMessagesBlock,
      /if\s*\(\s*args\s*===\s*null\s*\|\|\s*typeof\s+args\s*!==\s*"object"\s*\|\|\s*Array\.isArray\(\s*args\s*\)\s*\)/,
    );
    assert.match(
      sendMessagesBlock,
      /jsonError\(\s*"send_messages: arguments must be an object"\s*\)/,
    );
  });
});

// ─── Test 5: per-field guards (requireString / requirePresentString / requireEnum / optionalNonBlankString) ───

test("send_message: requireString from_agent_id/to_agent_id/fleet_id; requirePresentString payload; requireEnum type; optionalNonBlankString correlation_id", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const stringiness: ReadonlyArray<{ field: string; args: Record<string, unknown> }> = [
      {
        field: "from_agent_id",
        args: { ...happyArgs, from_agent_id: "   " },
      },
      {
        field: "from_agent_id",
        args: { ...happyArgs, from_agent_id: 42 },
      },
      {
        field: "to_agent_id",
        args: { ...happyArgs, to_agent_id: "" },
      },
      {
        field: "fleet_id",
        args: { ...happyArgs, fleet_id: null },
      },
      {
        field: "payload",
        args: { ...happyArgs, payload: 7 },
      },
      {
        field: "type",
        args: { ...happyArgs, type: "handofs" },
      },
      {
        field: "correlation_id",
        args: { ...happyArgs, correlation_id: "  " },
      },
      {
        field: "correlation_id",
        args: { ...happyArgs, correlation_id: 99 },
      },
    ];
    for (const { field, args } of stringiness) {
      const response = await client.callTool({
        name: "send_message",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${field} ${JSON.stringify(args[field])}: must be isError`,
      );
      const text = textOf(response);
      assert.match(
        text,
        /send_message/,
        `${field}: rejection must name send_message; got: ${text}`,
      );
      assert.match(
        text,
        new RegExp(field),
        `${field}: rejection must name the field; got: ${text}`,
      );
      const body = bodyOf(response);
      assert.notEqual(body.ok, true, `${field}: NEVER a phantom ok:true`);
    }

    // requirePresentString: empty payload IS a string and must be accepted
    // at the handler boundary (core may still reject later for other reasons).
    // We only pin the boundary here: a number payload is refused; a string
    // payload of "" is not a requirePresentString miss.
    const emptyPayload = await client.callTool({
      name: "send_message",
      arguments: { ...happyArgs, payload: "" },
    });
    const emptyText = textOf(emptyPayload);
    assert.doesNotMatch(
      emptyText,
      /'payload' is required and must be a string/,
      `empty payload must not trip requirePresentString; got: ${emptyText}`,
    );
  });
});

// ─── Test 6: phantom extra keys silently ignored (honesty) ───

test("send_message: phantom extra keys do not error (additionalProperties not advertised, handler does not enforce)", async () => {
  const fix = makeFixture();
  seedHappyPath(fix);
  await withChildServer(fix, async (client) => {
    const result = await callOk(client, {
      ...happyArgs,
      phantom_filter: "ignored",
      debug_emit: true,
      future_field: 42,
      force: "yes",
      nested: { a: 1 },
      note: "should be ignored",
    });
    assert.equal(typeof result.message_id, "string");
    assert.deepEqual(result.recipients, ["recipient"]);
    assert.equal(result.phantom_filter, undefined);
    assert.equal(result.debug_emit, undefined);
    assert.equal(result.future_field, undefined);
    assert.equal(result.force, undefined);
    assert.equal(result.nested, undefined);
    assert.equal(result.note, undefined);
    const extraTop = Object.keys(result).filter(
      (k) => k !== "message_id" && k !== "recipients",
    );
    assert.deepEqual(
      extraTop,
      [],
      `phantom keys must NOT leak into the response; extra: ${extraTop.join(",")}`,
    );
  });
});

// ─── Test 7: source-string pin ───

test("send_message: source-string pin — six per-field guards + jsonResult({message_id, recipients}) + destructure-cast + no requireAllowedKeys", async () => {
  const fix = makeFixture();
  seedHappyPath(fix);
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    const registrations = src.match(/toolHandlers\["send_message"\]/g) ?? [];
    assert.equal(
      registrations.length,
      1,
      `handler must be registered exactly once; got ${registrations.length}`,
    );

    const handlerBlock = extractHandlerBlock(src);
    assert.match(
      handlerBlock,
      /toolHandlers\["send_message"\]\s*=\s*async\s*\(\s*args\s*\)\s*=>\s*\{/,
    );
    assert.match(
      handlerBlock,
      /requireString\(\s*"send_message"\s*,\s*"from_agent_id"\s*,\s*from_agent_id\s*\)/,
    );
    assert.match(
      handlerBlock,
      /requireString\(\s*"send_message"\s*,\s*"to_agent_id"\s*,\s*to_agent_id\s*\)/,
    );
    assert.match(
      handlerBlock,
      /requireString\(\s*"send_message"\s*,\s*"fleet_id"\s*,\s*fleet_id\s*\)/,
    );
    assert.match(
      handlerBlock,
      /requirePresentString\(\s*"send_message"\s*,\s*"payload"\s*,\s*payload\s*\)/,
    );
    assert.match(
      handlerBlock,
      /requireEnum\(\s*"send_message"\s*,\s*"type"\s*,\s*type\s*,\s*MESSAGE_TYPES\s*\)/,
    );
    assert.match(
      handlerBlock,
      /optionalNonBlankString\(\s*"send_message"\s*,\s*"correlation_id"\s*,\s*correlation_id\s*\)/,
    );
    assert.match(
      handlerBlock,
      /return\s+jsonResult\(\s*\{\s*message_id:\s*messageId\s*,\s*recipients\s*\}\s*\)\s*;/,
    );
    assert.doesNotMatch(
      handlerBlock,
      /requireAllowedKeys/,
      "handler must NOT enforce additionalProperties (advertising false would be a lie)",
    );
    // Named bug class: destructure-cast remains; no object guard.
    assert.match(
      handlerBlock,
      /const\s*\{\s*from_agent_id\s*,\s*to_agent_id\s*,\s*fleet_id\s*,\s*type\s*,\s*payload\s*,\s*correlation_id\s*,?\s*\}\s*=\s*args\s+as\s*\{/,
    );
    assert.doesNotMatch(
      handlerBlock,
      /args\s*===\s*null\s*\|\|\s*typeof\s+args\s*!==\s*"object"/,
    );

    const { schema, annotations, description } = extractSchemaBlock(src);
    assert.match(schema, /type:\s*"object"/);
    assert.match(
      schema,
      /required:\s*\[\s*"from_agent_id"\s*,\s*"to_agent_id"\s*,\s*"fleet_id"\s*,\s*"type"\s*,\s*"payload"\s*\]/,
    );
    assert.doesNotMatch(
      schema,
      /additionalProperties/,
      "advertised schema must NOT carry additionalProperties (handler does not enforce it)",
    );
    assert.match(annotations, /readOnlyHint:\s*false/);
    assert.match(annotations, /destructiveHint:\s*false/);
    assert.match(annotations, /idempotentHint:\s*false/);
    assert.match(annotations, /openWorldHint:\s*false/);
    assert.match(description, /P2P/);
    assert.match(description, /within the same fleet/);
    assert.match(description, /\*/);

    const result = await callOk(client, { ...happyArgs, payload: "source-pin" });
    assert.equal(typeof result.message_id, "string");
    assert.deepEqual(result.recipients, ["recipient"]);
  });
});
