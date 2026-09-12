/**
 * reply_discussion MCP contract — driven over real MCP stdio with the tool's
 * PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `reply_discussion` is the one-reply
 * emission boundary of the discussion substrate (src/index.ts advertised
 * schema at L1643-L1664 + handler at toolHandlers["reply_discussion"]
 * L2753-L2780). It is published, yet origin/main has no dedicated stdio
 * contract pinning:
 *
 *   1. the advertised schema (six required fields, optional close boolean,
 *      type enum ["question","result"], additionalProperties:false,
 *      annotations including readOnlyHint=false + openWorldHint=false)
 *   2. required-field absence refused as isError naming tool + field
 *   3. wire-boundary type validation for the five identity/payload strings
 *   4. unknown-discussion DiscussionError projection {error, detail_fields}
 *   5. the named close-truthiness defect (`close:"false"` must not make
 *      a conversation TERMINAL) plus off-enum type refusal
 *   6. advertised additionalProperties:false vs handler that does not
 *      refuse phantom keys (honest advertised-vs-handler drift)
 *   7. source-string pin on the handler body
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * A 2026-09-09 worktree (a9664141) existed but never landed; its T4
 * claimed phantom keys were refused, which is false of the handler.
 * This card is a fresh origin/main pin with the 2026-09-12 honesty
 * pattern (ask_peer/wake_agent): additionalProperties:false is
 * advertised, not handler-enforced. No published-figure bump.
 * Discussion-state end-to-end coverage of second_reply / stale_head /
 * terminal_state lives in test/discussion-mcp.test.ts and
 * test/discussion-core.test.ts. This file pins ONLY the MCP stdio
 * boundary. The one-line discussion-tool-boundary.test.ts pin of
 * off-enum type + non-boolean close remains; this file is the
 * dedicated advertised-schema + handler-source contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { closeDb } from "../src/db.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-reply-discussion-mcp-"));
  return {
    dir,
    dataFile: join(dir, "ledger.json"),
    dbFile: join(dir, "ledger.db"),
    eventsFile: join(dir, "events.jsonl"),
  };
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

async function connectChild(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env,
    stderr: "ignore",
  });
  const client = new Client(
    { name: "reply-discussion-contract-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

async function withServer(
  fix: Fixture,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  process.env.MESHFLEET_DB_FILE = fix.dbFile;
  process.env.MESHFLEET_DATA_FILE = fix.dataFile;
  process.env.MESHFLEET_EVENT_LOG_FILE = fix.eventsFile;

  const client = await connectChild(childEnv(fix));
  try {
    await fn(client);
  } finally {
    await client.close().catch(() => {});
    rmSync(fix.dir, { recursive: true, force: true });
    closeDb();
    delete process.env.MESHFLEET_DB_FILE;
  }
}

const honestArgs = (): Record<string, unknown> => ({
  agent_id: "alpha",
  discussion_id: "d-1",
  attempt_id: "at-1",
  reply_to_message_id: "m-1",
  type: "result",
  payload: "ok",
});

const STRING_REQUIRED_FIELDS = [
  "agent_id",
  "discussion_id",
  "attempt_id",
  "reply_to_message_id",
  "payload",
] as const;

// Advertised required order is load-bearing (src/index.ts L1661).
const REQUIRED_FIELDS = [
  "agent_id",
  "discussion_id",
  "attempt_id",
  "reply_to_message_id",
  "type",
  "payload",
] as const;

function assertJsonErrorNotDiscussion(
  response: unknown,
  label: string,
): Record<string, unknown> {
  assert.equal(
    (response as ToolResponse).isError,
    true,
    `${label}: must be isError; got: ${textOf(response)}`,
  );
  const text = textOf(response);
  assert.match(text, /reply_discussion/, `${label}: must name the tool; got: ${text}`);
  const body = bodyOf(response);
  assert.equal(
    body.detail_fields,
    undefined,
    `${label}: wire-boundary refusal must be jsonError, not jsonDiscussionError; got: ${JSON.stringify(body)}`,
  );
  assert.notEqual(
    body.error,
    "not_found",
    `${label}: must die at firstError, never reach the store; got: ${JSON.stringify(body)}`,
  );
  return body;
}

// ---------------------------------------------------------------------------
// T1 — advertised schema pin
// ---------------------------------------------------------------------------

test("reply_discussion advertises six required fields, optional close boolean, type enum, additionalProperties:false, and write/closed-world annotations", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "reply_discussion");
    assert.ok(tool, "reply_discussion must be advertised");
    const schema = tool.inputSchema as {
      type: string;
      required?: string[];
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, [...REQUIRED_FIELDS]);
    assert.equal(
      schema.additionalProperties,
      false,
      "reply_discussion schema MUST advertise additionalProperties:false",
    );
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(props.agent_id, {
      type: "string",
      description: "The agent authoring the reply.",
    });
    assert.deepEqual(props.discussion_id, {
      type: "string",
      description: "The discussion being replied to.",
    });
    assert.deepEqual(props.attempt_id, {
      type: "string",
      description: "The server-assigned attempt ID this reply satisfies.",
    });
    assert.deepEqual(props.reply_to_message_id, {
      type: "string",
      description: "The canonical head being replied to.",
    });
    assert.deepEqual(props.type, {
      type: "string",
      enum: ["question", "result"],
      description: "Message type for the reply.",
    });
    assert.deepEqual(props.payload, {
      type: "string",
      description: "The UTF-8 string payload for the reply.",
    });
    assert.deepEqual(props.close, {
      type: "boolean",
      description: "If true, explicitly closes the discussion. Defaults to false.",
    });
    const requiredNames: readonly string[] = schema.required ?? [];
    assert.ok(
      !requiredNames.includes("close"),
      "close is OPTIONAL — lifting it to required would break every caller that omits it",
    );
    assert.deepEqual(tool.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    assert.ok(
      typeof tool.description === "string" &&
        tool.description.includes("Never launches an agent"),
      `description must keep the never-launches phrase; got: ${tool.description}`,
    );
    assert.ok(
      typeof tool.description === "string" &&
        tool.description.includes("close:true makes the conversation terminal"),
      `description must keep the close:true terminal phrase; got: ${tool.description}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T2 — required-field absence refused as tool+field, NEVER DiscussionError
// ---------------------------------------------------------------------------

test("reply_discussion refuses every absent required field as isError naming tool+field", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    for (const field of STRING_REQUIRED_FIELDS) {
      const args = honestArgs();
      delete args[field];
      const response = await client.callTool({
        name: "reply_discussion",
        arguments: args,
      });
      const text = textOf(response);
      assertJsonErrorNotDiscussion(response, `absent ${field}`);
      assert.match(
        text,
        new RegExp(`'${field}'`),
        `absent ${field}: must name the field; got: ${text}`,
      );
      assert.match(
        text,
        /is required and must be a non-empty string/,
        `absent ${field}: must use the requireString envelope; got: ${text}`,
      );
    }

    const typeMissing = honestArgs();
    delete typeMissing.type;
    const typeResponse = await client.callTool({
      name: "reply_discussion",
      arguments: typeMissing,
    });
    const typeText = textOf(typeResponse);
    assertJsonErrorNotDiscussion(typeResponse, "absent type");
    assert.match(typeText, /'type'/, `absent type: must name the field; got: ${typeText}`);
    assert.match(
      typeText,
      /is required and must be one of question \| result/,
      `absent type: must use the requireEnum envelope; got: ${typeText}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T3 — wire-boundary type validation for every required string
// ---------------------------------------------------------------------------

test("reply_discussion refuses non-string shapes on every required string field", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const nonStringShapes: Array<{ label: string; v: unknown }> = [
      { label: "null", v: null },
      { label: "empty", v: "" },
      { label: "whitespace", v: "   " },
      { label: "number", v: 42 },
      { label: "boolean", v: false },
      { label: "array", v: ["x"] },
      { label: "object", v: { x: 1 } },
    ];
    for (const field of STRING_REQUIRED_FIELDS) {
      for (const { label, v } of nonStringShapes) {
        const args = honestArgs();
        args[field] = v;
        const response = await client.callTool({
          name: "reply_discussion",
          arguments: args,
        });
        const text = textOf(response);
        assertJsonErrorNotDiscussion(response, `${field}=${label}`);
        assert.match(
          text,
          new RegExp(`'${field}'`),
          `${field}=${label}: must name the field; got: ${text}`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// T4 — unknown discussion surfaces as jsonDiscussionError not_found
// ---------------------------------------------------------------------------

test("reply_discussion unknown discussion returns isError {error:not_found, detail_fields:{entity:discussion}}", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const response = await client.callTool({
      name: "reply_discussion",
      arguments: {
        agent_id: "alpha",
        discussion_id: "no-such-discussion",
        attempt_id: "at-1",
        reply_to_message_id: "m-1",
        type: "result",
        payload: "ok",
      },
    });
    assert.equal(
      (response as ToolResponse).isError,
      true,
      `unknown discussion MUST return isError; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.equal(body.error, "not_found", `got: ${JSON.stringify(body)}`);
    assert.deepEqual(
      body.detail_fields,
      { entity: "discussion", discussion_id: "no-such-discussion" },
      `DiscussionError must project snake_case detail_fields naming the discussion; got: ${JSON.stringify(body)}`,
    );
    assert.deepEqual(Object.keys(body).sort(), ["detail_fields", "error"]);
  });
});

// ---------------------------------------------------------------------------
// T5 — named bug class: close truthiness + off-enum type
//      (`params.close ?? false` treats the string "false" as true and
//      makes the conversation TERMINAL; an unrecognized type would be
//      persisted rather than refused)
// ---------------------------------------------------------------------------

test("reply_discussion refuses close truthiness and off-enum type at the wire boundary, never as a store walk", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const closeCases: ReadonlyArray<{ label: string; close: unknown }> = [
      { label: 'close:"false"', close: "false" },
      { label: 'close:"true"', close: "true" },
      { label: "close:0", close: 0 },
      { label: "close:1", close: 1 },
      { label: "close:null-is-absence (allowed) — skipped here", close: "sentinel" },
    ];
    for (const { label, close } of closeCases) {
      if (close === "sentinel") continue;
      const response = await client.callTool({
        name: "reply_discussion",
        arguments: { ...honestArgs(), close },
      });
      const text = textOf(response);
      const body = assertJsonErrorNotDiscussion(response, label);
      assert.match(
        text,
        /'close' must be a boolean when provided/,
        `${label}: must use the optionalBoolean envelope — \"false\" would close the discussion; got: ${text}`,
      );
      assert.match(
        String(body.error),
        /the string "false" is truthy/,
        `${label}: error must name the truthiness rationale; got: ${text}`,
      );
    }

    const typeCases: ReadonlyArray<{ label: string; type: unknown }> = [
      { label: "type:alert", type: "alert" },
      { label: "type:ANSWER", type: "ANSWER" },
      { label: "type:question-with-space", type: " question" },
      { label: "type:number", type: 1 },
      { label: "type:boolean", type: true },
    ];
    for (const { label, type } of typeCases) {
      const response = await client.callTool({
        name: "reply_discussion",
        arguments: { ...honestArgs(), type },
      });
      const text = textOf(response);
      assertJsonErrorNotDiscussion(response, label);
      assert.match(
        text,
        /'type' must be exactly one of question \| result/,
        `${label}: must use the requireEnum envelope; got: ${text}`,
      );
    }

    // Omitted close is valid (optional) and MUST reach the store, not die
    // at optionalBoolean. Against an empty ledger that is not_found.
    const omitted = await client.callTool({
      name: "reply_discussion",
      arguments: honestArgs(),
    });
    assert.equal((omitted as ToolResponse).isError, true);
    const omittedBody = bodyOf(omitted);
    assert.equal(
      omittedBody.error,
      "not_found",
      `omitted close must reach the store, not optionalBoolean; got: ${JSON.stringify(omittedBody)}`,
    );

    // Explicit close:false is a real boolean and MUST also reach the store.
    const explicitFalse = await client.callTool({
      name: "reply_discussion",
      arguments: { ...honestArgs(), close: false },
    });
    assert.equal((explicitFalse as ToolResponse).isError, true);
    const explicitBody = bodyOf(explicitFalse);
    assert.equal(
      explicitBody.error,
      "not_found",
      `close:false (real boolean) must reach the store; got: ${JSON.stringify(explicitBody)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T6 — advertised additionalProperties:false is aspirational at the handler
// ---------------------------------------------------------------------------

test("reply_discussion phantom top-level keys still reach the store (advertised additionalProperties:false is not handler-enforced)", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const phantomCases: ReadonlyArray<{ label: string; extra: Record<string, unknown> }> = [
      { label: "force", extra: { force: true } },
      { label: "retry", extra: { retry: 3 } },
      { label: "note", extra: { note: "for your eyes only" } },
    ];
    for (const { label, extra } of phantomCases) {
      const response = await client.callTool({
        name: "reply_discussion",
        arguments: { ...honestArgs(), ...extra },
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `phantom ${label}: unknown discussion still fails; got: ${textOf(response)}`,
      );
      const body = bodyOf(response);
      assert.equal(
        body.error,
        "not_found",
        `phantom ${label}: handler does not refuse extra keys — call must reach the store not_found path, not an additionalProperties error; got: ${JSON.stringify(body)}`,
      );
      assert.deepEqual(body.detail_fields, {
        entity: "discussion",
        discussion_id: "d-1",
      });
      const text = textOf(response);
      assert.doesNotMatch(
        text,
        /additionalProperties|unknown (key|field|property)|not allowed/i,
        `phantom ${label}: must NOT be refused as an additional-properties schema error; got: ${text}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T7 — source-string pin
// ---------------------------------------------------------------------------

test("reply_discussion handler source pins requireString x5, requireEnum type, optionalBoolean close, jsonDiscussionError", () => {
  const source = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");
  assert.match(
    source,
    /toolHandlers\["reply_discussion"\]/,
    "reply_discussion must be a top-level toolHandlers entry",
  );
  assert.ok(
    source.includes("Never launches an agent."),
    "reply_discussion description must keep the never-launches phrase",
  );
  assert.ok(
    source.includes("close:true makes the conversation terminal"),
    "reply_discussion description must keep the close:true terminal phrase",
  );
  assert.ok(
    source.includes('enum: ["question", "result"]'),
    "advertised schema must keep the two-member type enum",
  );

  const handlerMatch = source.match(
    /toolHandlers\["reply_discussion"\] = async \(args\) => \{([\s\S]*?)\n\};\s*\n\s*toolHandlers\["get_discussion"\]/,
  );
  assert.ok(
    handlerMatch,
    "reply_discussion handler block must be found immediately before get_discussion",
  );
  const handlerBody = handlerMatch[1]!;
  assert.match(
    handlerBody,
    /requireString\(\s*"reply_discussion"\s*,\s*"agent_id"/,
    "handler must requireString agent_id",
  );
  assert.match(
    handlerBody,
    /requireString\(\s*"reply_discussion"\s*,\s*"discussion_id"/,
    "handler must requireString discussion_id",
  );
  assert.match(
    handlerBody,
    /requireString\(\s*"reply_discussion"\s*,\s*"attempt_id"/,
    "handler must requireString attempt_id",
  );
  assert.match(
    handlerBody,
    /requireString\(\s*"reply_discussion"\s*,\s*"reply_to_message_id"/,
    "handler must requireString reply_to_message_id",
  );
  assert.match(
    handlerBody,
    /requireString\(\s*"reply_discussion"\s*,\s*"payload"/,
    "handler must requireString payload",
  );
  assert.match(
    handlerBody,
    /requireEnum\(\s*"reply_discussion"\s*,\s*"type".*\[\s*"question"\s*,\s*"result"\s*\]/s,
    "handler must requireEnum type to [question, result]",
  );
  assert.match(
    handlerBody,
    /optionalBoolean\(\s*"reply_discussion"\s*,\s*"close"/,
    "handler must optionalBoolean close — the named truthiness defect",
  );
  assert.match(
    handlerBody,
    /const argErr = firstError\(/,
    "handler must collect validation results via firstError",
  );
  assert.match(
    handlerBody,
    /if \(argErr\) return jsonError\(argErr\)/,
    "handler must return jsonError on the first wire-boundary failure",
  );
  assert.match(
    handlerBody,
    /const params = args as ReplyDiscussionParams/,
    "success path must cast args as ReplyDiscussionParams",
  );
  assert.match(
    handlerBody,
    /getDiscussionStore\(\)\.replyDiscussion\(params\)/,
    "success path must call getDiscussionStore().replyDiscussion(params)",
  );
  assert.match(
    handlerBody,
    /return jsonResult\(result\)/,
    "success path must return jsonResult(result)",
  );
  assert.match(
    handlerBody,
    /if \(err instanceof DiscussionError\) return jsonDiscussionError\(err\.code, err\.detail\)/,
    "DiscussionError must project through jsonDiscussionError",
  );
  assert.match(
    handlerBody,
    /return jsonError\(err instanceof Error \? err\.message : String\(err\)\)/,
    "non-DiscussionError fallback must be jsonError",
  );
  assert.doesNotMatch(
    handlerBody,
    /requireAllowedKeys/,
    "handler must NOT call requireAllowedKeys — advertised additionalProperties:false is not handler-enforced",
  );
  assert.match(
    handlerBody,
    /params\.close \?\? false/,
    "handler comment must document the named params.close ?? false TERMINAL defect",
  );
  assert.doesNotMatch(
    handlerBody,
    /const close = params\.close\s*\?\?/,
    "handler must NOT execute params.close ?? false — that is the named TERMINAL truthiness defect (store still does; optionalBoolean is the gate)",
  );
  assert.doesNotMatch(
    handlerBody,
    /Boolean\(\s*(args|params)\.close/,
    "handler must NOT coerce close via Boolean() — \"false\" is truthy",
  );
  assert.match(
    handlerBody,
    /the string "false" makes a/,
    "handler comment must keep the named close-truthiness defect note",
  );
});
