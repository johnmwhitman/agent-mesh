/**
 * send_messages MCP stdio contract — honesty-pattern refresh (2026-09-12).
 *
 * Drives the tool through real MCP stdio so the advertised schema, the four
 * annotations, the object guard, boundary rejection, atomicity, the happy
 * path, and phantom-key tolerance stay coupled to the handler that publishes
 * them. The 2026-09-09 worktree (f918886a) never landed on origin/main; this
 * is a fresh witness off origin/main 8433dcb8 so the contract has a 20260912
 * card that is independently verifiable.
 *
 * The send_messages handler (src/index.ts L2038-L2115) is structurally
 * different from send_message (L1982-L2036): send_message destructures the
 * args object directly (a non-object casts to undefined fields and the
 * requireString calls catch it), but send_messages has an EXPLICIT object
 * guard at the top — `args === null || typeof args !== "object" ||
 * Array.isArray(args)` — that returns a dedicated jsonError BEFORE any
 * destructure. This test pins that guard because it is the only handler-level
 * boundary that distinguishes send_messages from send_message at the wire
 * surface, and a regression that removed it would re-open the class where a
 * non-object args payload silently destructure-casts.
 *
 * Seven test groups:
 *   1. Schema + annotations pin (deepEqual against advertised values).
 *   2. Object guard: null / array / non-object args return a named jsonError,
 *      never a phantom results array.
 *   3. Container-level: missing messages, non-array messages, over-max
 *      refused with at-most-N text; never a phantom results array.
 *   4. Per-item: non-object item, each required field (from_agent_id,
 *      to_agent_id, fleet_id, type, payload), correlation_id optional —
 *      all with indexed error paths messages[N].field.
 *   5. Atomicity: one invalid item rejects the whole batch; inbox stays empty.
 *   6. Happy path: jsonResult {results:[{message_id, recipients}]} with
 *      unique message_ids; phantom top-level keys do not error.
 *   7. Source-string pin: the handler block still calls the documented guards
 *      in the documented order.
 *
 * WRITE-ISOLATION LAW: send_messages writes to the ledger. Every run that
 * opens a child sets ALL THREE of MESHFLEET_DB_FILE, MESHFLEET_DATA_FILE,
 * MESHFLEET_EVENT_LOG_FILE to temp paths — never the live
 * ~/.config/opencode/agent-mesh.db.
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
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { closeDb } from "../src/db.js";
import { registerAgentInLedger, type Agent } from "../src/core.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

type ToolResponse = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
};
const textOf = (r: unknown): string => (r as ToolResponse).content[0]!.text;
const bodyOf = (r: unknown): Record<string, unknown> =>
  JSON.parse(textOf(r)) as Record<string, unknown>;

type Fixture = {
  dir: string;
  dataFile: string;
  dbFile: string;
  eventsFile: string;
};

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-send-messages-mcp-20260912-"));
  // A scratch package.json so any rogue discoverPremadeAgents() call
  // in the child finds an empty agent directory rather than the live
  // ~/.config/opencode/agents/ tree.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-send-messages-20260912-${dir}`,
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

/**
 * applyFixtureEnv MUST be called BEFORE the child connects so the
 * cached better-sqlite3 handle inside src/db.ts opens against the
 * tempdir, not the live ~/.config/opencode/agent-mesh.db (which is on
 * storage_schema_version=5 and would raise unsupported-newer-schema).
 * HOME points at the tempdir so any discoverPremadeAgents() call
 * the handler chain hits cannot fail from a missing HOME.
 */
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
  HOME: fix.dir,
});

async function connectChild(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs"),
      join(repoRoot, "src", "index.ts"),
    ],
    cwd: env.HOME,
    env,
    stderr: "ignore",
  });
  const client = new Client(
    { name: "send-messages-contract-test-20260912", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

async function withChildServer(
  fix: Fixture,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const client = await connectChild(childEnv(fix));
  try {
    await fn(client);
  } finally {
    await client.close().catch(() => {});
    closeDb();
    // ENOTEMPTY retry pattern (cycle-454 lesson): the stdio child's
    // last few buffered writes can race the parent's rmSync.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(fix.dir, { recursive: true, force: true });
        break;
      } catch (e) {
        if (
          (e as NodeJS.ErrnoException).code !== "ENOTEMPTY" ||
          attempt === 4
        ) {
          throw e;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    clearFixtureEnv();
  }
}

const fixtureAgent = (id: string, fleetId: string): Agent => ({
  id,
  fleet_id: fleetId,
  role: `${id}-role`,
  prompt: `${id}-prompt`,
  status: "running",
});

async function callOk(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: args });
  return bodyOf(response);
}

const MESSAGE_TYPE_ENUM = [
  "handoff",
  "question",
  "result",
  "alert",
  "request_help",
] as const;

const baseHandoff = (
  from: string,
  to: string,
  fleet: string,
  payload: string,
): Record<string, unknown> => ({
  from_agent_id: from,
  to_agent_id: to,
  fleet_id: fleet,
  type: "handoff",
  payload,
});

// ============================================================================
// Test 1 — advertised schema: required=[messages], per-item required in
// advertised order, type enum, maxItems=MAX_BATCH_MESSAGES (1000), NO
// additionalProperties key, four annotations all false.
// ============================================================================

test("send_messages advertised schema: required=[messages], per-item required=[from_agent_id,to_agent_id,fleet_id,type,payload], correlation_id optional, type enum, maxItems=1000, NO additionalProperties, annotations all false", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((c) => c.name === "send_messages");
    assert.ok(tool, "send_messages must be advertised");
    const schema = tool.inputSchema as unknown as {
      type: string;
      required: string[];
      properties: {
        messages: {
          type: string;
          maxItems: number;
          items: {
            type: string;
            required: string[];
            properties: Record<string, unknown>;
          };
        };
      };
      additionalProperties?: boolean;
    };
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["messages"]);

    // maxItems MUST equal MAX_BATCH_MESSAGES=1000 (src/core.ts:1205).
    assert.equal(
      schema.properties.messages.maxItems,
      1000,
      "maxItems MUST equal MAX_BATCH_MESSAGES=1000",
    );
    assert.equal(schema.properties.messages.type, "array");
    assert.equal(schema.properties.messages.items.type, "object");

    // Per-item required in advertised order.
    assert.deepEqual(schema.properties.messages.items.required, [
      "from_agent_id",
      "to_agent_id",
      "fleet_id",
      "type",
      "payload",
    ]);

    // Type is enum-constrained to MESSAGE_TYPES.
    assert.deepEqual(
      schema.properties.messages.items.properties.type,
      { type: "string", enum: [...MESSAGE_TYPE_ENUM] },
    );

    // correlation_id is declared in properties but NOT in required.
    assert.ok(
      "correlation_id" in schema.properties.messages.items.properties,
      "correlation_id must be declared in per-item properties",
    );
    assert.ok(
      !schema.properties.messages.items.required.includes("correlation_id"),
      "correlation_id must NOT be in per-item required (it is optional)",
    );

    // NO additionalProperties key — advertising false would be a lie;
    // the handler has no requireAllowedKeys and phantom keys are ignored.
    assert.equal(
      schema.additionalProperties,
      undefined,
      "schema must NOT advertise additionalProperties — handler has no requireAllowedKeys",
    );

    // Four annotations, all false.
    assert.deepEqual(tool.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });

    // Description must mention ONE ledger transaction / Atomic / Max 1000.
    const desc = tool.description as string;
    assert.match(desc, /ONE ledger transaction/i);
    assert.match(desc, /Atomic/i);
    assert.match(desc, /Max 1000/i);
  });
});

// ============================================================================
// Test 2 — object guard: args null / array / non-object returns a named
// jsonError naming send_messages and "arguments must be an object", and
// NEVER a phantom results array. This is the handler-level guard that
// distinguishes send_messages from send_message (which destructure-casts).
// ============================================================================

test("send_messages object guard: null / array / non-object args are rejected (SDK or handler layer) and NEVER return a phantom results array", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  await withChildServer(fix, async (client) => {
    // The MCP SDK validates that `arguments` is a record (object) at the
    // protocol layer. Null, arrays, strings, and numbers are rejected by
    // the SDK with a McpError BEFORE the request reaches the handler.
    // The handler's own object guard at src/index.ts:2039-2041 is
    // defense-in-depth: if the SDK ever stopped enforcing, the handler
    // would still catch the shape. The source-string pin (Test 7) covers
    // that the guard exists in the code; here we pin the runtime
    // contract: these shapes NEVER produce a successful results array.
    const cases: Array<{ label: string; args: unknown }> = [
      { label: "null args", args: null },
      { label: "array args", args: [{ messages: [] }] },
      { label: "string args", args: "not-an-object" },
      { label: "number args", args: 42 },
    ];
    for (const { label, args } of cases) {
      let gotResponse = false;
      let gotPhantomResults = false;
      try {
        const response = await client.callTool({
          name: "send_messages",
          arguments: args as Record<string, unknown>,
        });
        gotResponse = true;
        // If the SDK let it through and the handler caught it, it must
        // be isError and must NOT contain a results array.
        const body = bodyOf(response);
        if ("results" in body) gotPhantomResults = true;
        assert.equal(
          (response as ToolResponse).isError,
          true,
          `${label}: if the SDK let it through, the handler must return isError`,
        );
      } catch (err) {
        // SDK-level rejection (McpError) — this is the expected path
        // today. The call must not produce any tool response.
        assert.ok(
          err instanceof Error,
          `${label}: SDK rejection must be an Error, got ${typeof err}`,
        );
      }
      assert.ok(
        !gotPhantomResults,
        `${label}: must NEVER return a phantom results array`,
      );
      // If the SDK rejected it, gotResponse stays false — that's correct.
      // If the handler rejected it, gotResponse is true and isError is
      // asserted above. Either path upholds the contract.
    }
  });
});

// ============================================================================
// Test 3 — container-level: missing messages, non-array messages, over-max
// all return isError naming send_messages + messages, NEVER a phantom
// results array. Over-max text includes the limit and the observed count.
// ============================================================================

test("send_messages container-level: missing messages, non-array messages, over-max(>1000) all return isError naming send_messages + messages, never a phantom results array", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  await withChildServer(fix, async (client) => {
    // 3a: messages absent entirely.
    const absent = await client.callTool({
      name: "send_messages",
      arguments: {},
    });
    assert.equal(
      (absent as ToolResponse).isError,
      true,
      "send_messages must refuse absent 'messages' as isError",
    );
    {
      const body = bodyOf(absent);
      assert.ok(
        typeof body.error === "string" &&
          body.error.includes("send_messages") &&
          body.error.includes("messages"),
        `absent messages: error must name send_messages + messages, got: ${JSON.stringify(body)}`,
      );
      assert.ok(!("results" in body), "absent messages: must not return a phantom results array");
    }

    // 3b: messages is a non-array (string, number, object, null).
    const nonArrayCases: Array<{ value: unknown }> = [
      { value: "not-an-array" },
      { value: 42 },
      { value: { not: "an array" } },
      { value: null },
    ];
    for (const { value } of nonArrayCases) {
      const response = await client.callTool({
        name: "send_messages",
        arguments: { messages: value },
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `send_messages must refuse non-array messages=${JSON.stringify(value)} as isError`,
      );
      const body = bodyOf(response);
      assert.ok(
        typeof body.error === "string" &&
          body.error.includes("send_messages") &&
          body.error.includes("messages") &&
          body.error.includes("array"),
        `non-array messages=${JSON.stringify(value)}: error must name send_messages + messages + array, got: ${JSON.stringify(body)}`,
      );
      assert.ok(!("results" in body), "non-array messages: must not return a phantom results array");
    }

    // 3c: messages over MAX_BATCH_MESSAGES=1000. Use 1001 items.
    const oversized = Array.from({ length: 1001 }, (_, i) => ({
      from_agent_id: "sender",
      to_agent_id: "recipient",
      fleet_id: "fleet",
      type: "handoff",
      payload: `p${i}`,
    }));
    const overMax = await client.callTool({
      name: "send_messages",
      arguments: { messages: oversized },
    });
    assert.equal(
      (overMax as ToolResponse).isError,
      true,
      "send_messages must refuse >MAX_BATCH_MESSAGES as isError",
    );
    {
      const body = bodyOf(overMax);
      assert.ok(
        typeof body.error === "string" &&
          body.error.includes("1000") &&
          body.error.includes("1001"),
        `over-max: error must include the limit (1000) and observed count (1001), got: ${JSON.stringify(body)}`,
      );
      assert.ok(!("results" in body), "over-max: must not return a phantom results array");
    }
  });
});

// ============================================================================
// Test 4 — per-item: non-object item refused as messages[i] must be an
// object; each required field enforced with indexed error paths
// messages[N].field; correlation_id optional (absent accepted, non-blank
// rejected, non-string rejected).
// ============================================================================

test("send_messages per-item: non-object item refused, each required field enforced with indexed path messages[N].field, correlation_id optional", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  await withChildServer(fix, async (client) => {
    // 4a: per-item non-object — null, array, string, number.
    const nonObjectCases: Array<{ label: string; value: unknown }> = [
      { label: "null item", value: null },
      { label: "array item", value: ["not", "an", "object"] },
      { label: "string item", value: "a string" },
      { label: "number item", value: 99 },
    ];
    for (const { label, value } of nonObjectCases) {
      const messages = [
        baseHandoff("s", "r", "f", "ok-0"),
        value,
        baseHandoff("s", "r", "f", "ok-2"),
      ];
      const response = await client.callTool({
        name: "send_messages",
        arguments: { messages },
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be refused as isError`,
      );
      const body = bodyOf(response);
      assert.ok(
        typeof body.error === "string" &&
          body.error.includes("send_messages") &&
          body.error.includes("messages[1]") &&
          body.error.includes("must be an object"),
        `${label}: error must name send_messages + messages[1] + 'must be an object', got: ${JSON.stringify(body)}`,
      );
    }

    // 4b: each required per-item field is enforced with the indexed path.
    // Index 2 is the bad item so a regression that off-by-one'd the prefix
    // would fail loudly.
    const stringinessCases: Array<{
      mutate: (m: Record<string, unknown>) => Record<string, unknown>;
      field: string;
    }> = [
      { mutate: (m) => ({ ...m, from_agent_id: 42 }), field: "from_agent_id" },
      { mutate: (m) => ({ ...m, from_agent_id: "   " }), field: "from_agent_id" },
      { mutate: (m) => ({ ...m, to_agent_id: 99 }), field: "to_agent_id" },
      { mutate: (m) => ({ ...m, to_agent_id: "\t" }), field: "to_agent_id" },
      { mutate: (m) => ({ ...m, fleet_id: null }), field: "fleet_id" },
      { mutate: (m) => ({ ...m, fleet_id: "  " }), field: "fleet_id" },
      { mutate: (m) => ({ ...m, type: 5 }), field: "type" },
      { mutate: (m) => ({ ...m, type: "handofs" }), field: "type" },
      { mutate: (m) => ({ ...m, type: null }), field: "type" },
      { mutate: (m) => ({ ...m, payload: 42 }), field: "payload" },
      { mutate: (m) => ({ ...m, payload: null }), field: "payload" },
    ];
    for (const { mutate, field } of stringinessCases) {
      const messages = [
        baseHandoff("s", "r", "f", "ok-0"),
        baseHandoff("s", "r", "f", "ok-1"),
        mutate(baseHandoff("s", "r", "f", "ok-2")),
      ];
      const response = await client.callTool({
        name: "send_messages",
        arguments: { messages },
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `field ${field}: must be refused as isError`,
      );
      const body = bodyOf(response);
      assert.ok(
        typeof body.error === "string" && body.error.includes(field),
        `field ${field}: error must name the field, got: ${JSON.stringify(body)}`,
      );
      assert.ok(
        typeof body.error === "string" && body.error.includes("messages[2]"),
        `field ${field}: error must include indexed prefix 'messages[2]', got: ${JSON.stringify(body)}`,
      );
    }

    // 4c: correlation_id is optional — absent is accepted, but non-blank
    // and non-string are rejected with the indexed path.
    // Absent: a valid batch without correlation_id succeeds (covered in
    // Test 6 happy path). Here we pin the rejection cases.
    const corrCases: Array<{
      mutate: (m: Record<string, unknown>) => Record<string, unknown>;
    }> = [
      { mutate: (m) => ({ ...m, correlation_id: 99 }) },
      { mutate: (m) => ({ ...m, correlation_id: "  " }) },
    ];
    for (const { mutate } of corrCases) {
      const messages = [
        baseHandoff("s", "r", "f", "ok-0"),
        mutate(baseHandoff("s", "r", "f", "ok-1")),
      ];
      const response = await client.callTool({
        name: "send_messages",
        arguments: { messages },
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        "correlation_id rejection: must be refused as isError",
      );
      const body = bodyOf(response);
      assert.ok(
        typeof body.error === "string" &&
          body.error.includes("messages[1]") &&
          body.error.includes("correlation_id"),
        `correlation_id rejection: error must name messages[1].correlation_id, got: ${JSON.stringify(body)}`,
      );
    }
  });
});

// ============================================================================
// Test 5 — atomicity: ONE invalid item rejects the WHOLE batch. None of the
// prior or subsequent items reach the ledger (inbox stays empty).
// ============================================================================

test("send_messages atomicity: one invalid item rejects the whole batch — no items reach the recipient inbox", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  registerAgentInLedger(fixtureAgent("atom-sender", "atom-fleet"));
  registerAgentInLedger(fixtureAgent("atom-recipient", "atom-fleet"));
  await withChildServer(fix, async (client) => {
    // Two good items, one bad item in the middle (oversized payload
    // > 64KiB core limit). The handler may reject at two barriers:
    //   (a) per-item validation (would name messages[1].payload), OR
    //   (b) the core sendMessages() call (would surface "Payload too large").
    // Either barrier upholds atomicity; the isError + inbox-empty pin
    // is the contract guarantee.
    const oversized = "x".repeat(65 * 1024);
    const messages = [
      baseHandoff("atom-sender", "atom-recipient", "atom-fleet", "ok-0"),
      baseHandoff("atom-sender", "atom-recipient", "atom-fleet", oversized),
      baseHandoff("atom-sender", "atom-recipient", "atom-fleet", "ok-2"),
    ];
    const response = await client.callTool({
      name: "send_messages",
      arguments: { messages },
    });
    assert.equal(
      (response as ToolResponse).isError,
      true,
      "send_messages must reject a bad item in the middle as isError",
    );
    const body = bodyOf(response);
    assert.ok(
      typeof body.error === "string" &&
        (body.error.includes("messages[1]") ||
          body.error.includes("Payload too large")),
      `atomicity: error must name messages[1] or 'Payload too large', got: ${JSON.stringify(body)}`,
    );

    // Confirm NONE of the three items reached the recipient inbox.
    const inbox = await callOk(client, "get_inbox", {
      agent_id: "atom-recipient",
    });
    const inboxMessages = (inbox.messages as Array<unknown>) ?? [];
    assert.equal(
      inboxMessages.length,
      0,
      `atomicity violation — bad item at messages[1] caused items to reach the inbox; found ${inboxMessages.length}`,
    );
  });
});

// ============================================================================
// Test 6 — happy path: well-formed batch returns jsonResult
// {results:[{message_id, recipients}]} with unique message_ids. Phantom
// top-level keys do not error (open-world pin).
// ============================================================================

test("send_messages happy path: jsonResult {results:[{message_id,recipients}]} with unique ids; phantom top-level keys do not error", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  registerAgentInLedger(fixtureAgent("happy-sender", "happy-fleet"));
  registerAgentInLedger(fixtureAgent("happy-recipient", "happy-fleet"));
  await withChildServer(fix, async (client) => {
    const messages = [
      baseHandoff("happy-sender", "happy-recipient", "happy-fleet", "first"),
      baseHandoff("happy-sender", "happy-recipient", "happy-fleet", "second"),
      baseHandoff("happy-sender", "happy-recipient", "happy-fleet", "third"),
    ];
    const response = await callOk(client, "send_messages", { messages });
    const results = response.results as Array<{
      message_id: string;
      recipients: string[];
    }>;
    assert.ok(Array.isArray(results), "results must be an array");
    assert.equal(results.length, messages.length, "one result per input");
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      assert.equal(typeof r.message_id, "string");
      assert.ok(r.message_id.length > 0, `result[${i}].message_id must be non-empty`);
      assert.deepEqual(r.recipients, ["happy-recipient"]);
    }
    // message_ids must be distinct.
    const ids = new Set(results.map((r) => r.message_id));
    assert.equal(ids.size, results.length, "every message_id must be unique");

    // Phantom top-level args — handler destructures {messages} only,
    // so phantom keys are dropped at the cast site.
    const phantom = await callOk(client, "send_messages", {
      messages: [
        baseHandoff("happy-sender", "happy-recipient", "happy-fleet", "phantom-bearing"),
      ],
      phantom_field: "ignored",
      force: true,
      note: "ignored",
    });
    const phantomResults = phantom.results as Array<{
      message_id: string;
      recipients: string[];
    }>;
    assert.equal(phantomResults.length, 1);
    assert.equal(typeof phantomResults[0]!.message_id, "string");
    assert.deepEqual(phantomResults[0]!.recipients, ["happy-recipient"]);
  });
});

// ============================================================================
// Test 7 — source-string pin: the handler block at src/index.ts:2038-2115
// still calls the documented guards in the documented order.
// ============================================================================

test("send_messages source-string pin: handler block still calls object guard + Array.isArray + length cap + firstError(requireString x3 + requirePresentString + requireEnum + optionalNonBlankString) + jsonResult", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  await withChildServer(fix, async (_client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");
    const start = src.indexOf('toolHandlers["send_messages"] = async');
    assert.ok(start > 0, "send_messages handler block must exist in src/index.ts");
    const nextHandler = src.indexOf("\ntoolHandlers[", start + 1);
    const end = nextHandler > 0 ? nextHandler : src.length;
    const block = src.slice(start, end);

    // Object guard (the distinguishing guard vs send_message).
    assert.ok(
      /args\s*===\s*null\s*\|\|\s*typeof\s+args\s*!==\s*"object"\s*\|\|\s*Array\.isArray\(args\)/.test(block),
      "handler must have the object guard (args null/non-object/array) BEFORE destructure",
    );
    assert.ok(
      /send_messages: arguments must be an object/.test(block),
      "handler must return jsonError 'send_messages: arguments must be an object'",
    );

    // Container-level guards.
    assert.ok(
      /Array\.isArray\(messages\)/.test(block),
      "handler must guard Array.isArray(messages) BEFORE per-item projection",
    );
    assert.ok(
      /messages\.length\s*>\s*MAX_BATCH_MESSAGES/.test(block),
      "handler must enforce messages.length <= MAX_BATCH_MESSAGES",
    );

    // Per-item prefix (messages[i]).
    assert.ok(
      /messages\[i\]/.test(block),
      "handler must use messages[i] as the per-item index",
    );

    // Per-item non-object guard. The source uses a template literal:
    // `messages[${i}]' must be an object`.
    assert.ok(
      /messages\[\$\{i\}\].*must be an object/.test(block),
      "handler must refuse per-item non-object as 'messages[${i}] must be an object'",
    );

    // Six per-field guards inside firstError(...).
    assert.ok(/firstError\(/.test(block), "handler must use firstError(...)");
    assert.ok(
      /requireString\(\s*"send_messages"\s*,\s*`\$\{prefix\}\.from_agent_id`/.test(block),
      "handler must call requireString for from_agent_id",
    );
    assert.ok(
      /requireString\(\s*"send_messages"\s*,\s*`\$\{prefix\}\.to_agent_id`/.test(block),
      "handler must call requireString for to_agent_id",
    );
    assert.ok(
      /requireString\(\s*"send_messages"\s*,\s*`\$\{prefix\}\.fleet_id`/.test(block),
      "handler must call requireString for fleet_id",
    );
    assert.ok(
      /requirePresentString\(\s*"send_messages"\s*,\s*`\$\{prefix\}\.payload`/.test(block),
      "handler must call requirePresentString for payload",
    );
    assert.ok(
      /requireEnum\(\s*"send_messages"\s*,\s*`\$\{prefix\}\.type`\s*,\s*message\.type\s*,\s*MESSAGE_TYPES\s*\)/.test(block),
      "handler must call requireEnum for type with MESSAGE_TYPES",
    );
    assert.ok(
      /optionalNonBlankString\(\s*"send_messages"\s*,\s*`\$\{prefix\}\.correlation_id`/.test(block),
      "handler must call optionalNonBlankString for correlation_id",
    );

    // Success shape: jsonResult({ results: results.map(...) }).
    assert.ok(
      /jsonResult\(\s*\{\s*results:\s*results\.map\(/.test(block),
      "handler must return jsonResult({ results: results.map(...) })",
    );
    assert.ok(
      /results\.map\(\s*\(r\)\s*=>\s*\(\s*\{\s*message_id:\s*r\.messageId\s*,\s*recipients:\s*r\.recipients\s*\}\s*\)\s*\)/.test(block),
      "handler must project {message_id: r.messageId, recipients: r.recipients}",
    );
  });
});