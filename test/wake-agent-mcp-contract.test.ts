/**
 * wake_agent MCP contract — driven over real MCP stdio with the tool's
 * PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `wake_agent` is the sole general-purpose
 * Discussion run trigger (src/index.ts advertised schema at L1625-L1641 +
 * handler at toolHandlers["wake_agent"] L2728-L2751). It is published, yet
 * origin/main has no dedicated stdio contract pinning:
 *
 *   1. the advertised schema (three required CAS identity fields,
 *      additionalProperties:false, annotations including
 *      readOnlyHint=false + openWorldHint=true + idempotentHint=false)
 *   2. required-field absence refused as isError naming tool + field
 *      (an omitted expected_head_message_id would turn a guarded resume
 *      into an unguarded one)
 *   3. wire-boundary type validation for every CAS identity string
 *   4. unknown-discussion DiscussionError projection {error, detail_fields}
 *   5. CAS identity completeness — all three fields must be present and
 *      non-blank before the store walk
 *   6. advertised additionalProperties:false vs handler that does not
 *      refuse phantom keys (honest advertised-vs-handler drift)
 *   7. source-string pin on the handler body
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * A 2026-09-09 worktree (306f6112) existed but never landed. This card is
 * a fresh origin/main pin with no published-figure bump. Discussion-state
 * end-to-end coverage of stale_head / wrong_participant / terminal_state
 * lives in test/discussion-mcp.test.ts and test/discussion-core.test.ts
 * (in-process createDiscussionStore). This file pins ONLY the MCP stdio
 * boundary.
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-wake-agent-mcp-"));
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
    { name: "wake-agent-contract-test", version: "1.0.0" },
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
  expected_head_message_id: "m-1",
});

const REQUIRED_FIELDS = [
  "agent_id",
  "discussion_id",
  "expected_head_message_id",
] as const;

// ---------------------------------------------------------------------------
// T1 — advertised schema pin
// ---------------------------------------------------------------------------

test("wake_agent advertises three required CAS identity fields, additionalProperties:false, and write/open-world annotations", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "wake_agent");
    assert.ok(tool, "wake_agent must be advertised");
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
      "wake_agent schema MUST advertise additionalProperties:false",
    );
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(props.agent_id, {
      type: "string",
      description: "The resident agent to wake.",
    });
    assert.deepEqual(props.discussion_id, {
      type: "string",
      description: "The discussion to resume.",
    });
    assert.deepEqual(props.expected_head_message_id, {
      type: "string",
      description: "The expected current canonical head for compare-and-swap.",
    });
    assert.deepEqual(tool.annotations, {
      openWorldHint: true,
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    assert.ok(
      typeof tool.description === "string" &&
        tool.description.includes("sole general-purpose Discussion run trigger"),
      `description must keep the sole-run-trigger phrase; got: ${tool.description}`,
    );
    assert.ok(
      typeof tool.description === "string" &&
        tool.description.includes("Never waits for the reply"),
      `description must keep the never-waits phrase; got: ${tool.description}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T2 — required-field absence refused as tool+field, NEVER DiscussionError
// ---------------------------------------------------------------------------

test("wake_agent refuses every absent required field as isError naming tool+field", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    for (const field of REQUIRED_FIELDS) {
      const args = honestArgs();
      delete args[field];
      const response = await client.callTool({
        name: "wake_agent",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `absent ${field}: must be a tool error; got: ${textOf(response)}`,
      );
      const text = textOf(response);
      assert.match(text, /wake_agent/, `absent ${field}: must name the tool; got: ${text}`);
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
      const body = bodyOf(response);
      assert.equal(
        body.detail_fields,
        undefined,
        `absent ${field}: wire-boundary refusal must be jsonError, not jsonDiscussionError; got: ${JSON.stringify(body)}`,
      );
      assert.notEqual(
        body.error,
        "not_found",
        `absent ${field}: must die at requireString, never reach the store; got: ${JSON.stringify(body)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T3 — wire-boundary type validation for every CAS identity string
// ---------------------------------------------------------------------------

test("wake_agent refuses non-string shapes on every CAS identity field", async () => {
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
    for (const field of REQUIRED_FIELDS) {
      for (const { label, v } of nonStringShapes) {
        const args = honestArgs();
        args[field] = v;
        const response = await client.callTool({
          name: "wake_agent",
          arguments: args,
        });
        assert.equal(
          (response as ToolResponse).isError,
          true,
          `${field}=${label}: must be isError; got: ${textOf(response)}`,
        );
        const text = textOf(response);
        assert.match(text, /wake_agent/, `${field}=${label}: must name the tool; got: ${text}`);
        assert.match(
          text,
          new RegExp(`'${field}'`),
          `${field}=${label}: must name the field; got: ${text}`,
        );
        const body = bodyOf(response);
        assert.equal(
          body.detail_fields,
          undefined,
          `${field}=${label}: must be jsonError, not jsonDiscussionError; got: ${JSON.stringify(body)}`,
        );
        assert.notEqual(
          body.error,
          "not_found",
          `${field}=${label}: must die at requireString, never reach the store; got: ${JSON.stringify(body)}`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// T4 — unknown discussion surfaces as jsonDiscussionError not_found
// ---------------------------------------------------------------------------

test("wake_agent unknown discussion returns isError {error:not_found, detail_fields:{entity:discussion}}", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const response = await client.callTool({
      name: "wake_agent",
      arguments: {
        agent_id: "alpha",
        discussion_id: "no-such-discussion",
        expected_head_message_id: "no-such-head",
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
// T5 — CAS identity completeness: omitted expected_head_message_id never
//      becomes an unguarded resume (the named bug class in the handler)
// ---------------------------------------------------------------------------

test("wake_agent omitted expected_head_message_id is a requireString refusal, never an unguarded store walk", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const cases: ReadonlyArray<{ label: string; args: Record<string, unknown> }> = [
      {
        label: "omitted expected_head_message_id",
        args: { agent_id: "alpha", discussion_id: "d-1" },
      },
      {
        label: "empty expected_head_message_id",
        args: { agent_id: "alpha", discussion_id: "d-1", expected_head_message_id: "" },
      },
      {
        label: "whitespace expected_head_message_id",
        args: { agent_id: "alpha", discussion_id: "d-1", expected_head_message_id: "   " },
      },
      {
        label: "omitted agent_id (named: reached discussion lookup before noticing)",
        args: { discussion_id: "d-1", expected_head_message_id: "m-1" },
      },
    ];
    for (const { label, args } of cases) {
      const response = await client.callTool({
        name: "wake_agent",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be isError; got: ${textOf(response)}`,
      );
      const text = textOf(response);
      assert.match(text, /wake_agent/, `${label}: must name the tool; got: ${text}`);
      assert.match(
        text,
        /is required and must be a non-empty string/,
        `${label}: must use the requireString envelope; got: ${text}`,
      );
      const body = bodyOf(response);
      assert.equal(
        body.detail_fields,
        undefined,
        `${label}: must die at firstError/requireString, never jsonDiscussionError; got: ${JSON.stringify(body)}`,
      );
      assert.notEqual(
        body.error,
        "not_found",
        `${label}: must NEVER be reported as a genuine miss; got: ${JSON.stringify(body)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T6 — advertised additionalProperties:false is aspirational at the handler
// ---------------------------------------------------------------------------

test("wake_agent phantom top-level keys still reach the store (advertised additionalProperties:false is not handler-enforced)", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const phantomCases: ReadonlyArray<{ label: string; extra: Record<string, unknown> }> = [
      { label: "force", extra: { force: true } },
      { label: "retry", extra: { retry: 3 } },
      { label: "note", extra: { note: "for your eyes only" } },
    ];
    for (const { label, extra } of phantomCases) {
      const response = await client.callTool({
        name: "wake_agent",
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

test("wake_agent handler source pins requireString x3, firstError, jsonError, wakeAgent, jsonDiscussionError", () => {
  const source = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");
  assert.match(
    source,
    /toolHandlers\["wake_agent"\]/,
    "wake_agent must be a top-level toolHandlers entry",
  );
  assert.ok(
    source.includes("The sole general-purpose Discussion run trigger."),
    "wake_agent description must keep the sole-run-trigger surface text",
  );
  assert.ok(
    source.includes("Never waits for the reply."),
    "wake_agent description must keep the never-waits phrase",
  );
  assert.ok(
    source.includes("they never launch twice."),
    "wake_agent description must keep the never-launch-twice concurrent-call phrase",
  );

  const handlerMatch = source.match(
    /toolHandlers\["wake_agent"\] = async \(args\) => \{([\s\S]*?)\n\};\s*\n\s*toolHandlers\["reply_discussion"\]/,
  );
  assert.ok(
    handlerMatch,
    "wake_agent handler block must be found immediately before reply_discussion",
  );
  const handlerBody = handlerMatch[1]!;
  assert.match(
    handlerBody,
    /requireString\(\s*"wake_agent"\s*,\s*"agent_id"/,
    "handler must requireString agent_id",
  );
  assert.match(
    handlerBody,
    /requireString\(\s*"wake_agent"\s*,\s*"discussion_id"/,
    "handler must requireString discussion_id",
  );
  assert.match(
    handlerBody,
    /requireString\(\s*"wake_agent"\s*,\s*"expected_head_message_id"/,
    "handler must requireString expected_head_message_id",
  );
  assert.match(
    handlerBody,
    /const argErr = firstError\(/,
    "handler must collect the three requireString results via firstError",
  );
  assert.match(
    handlerBody,
    /if \(argErr\) return jsonError\(argErr\)/,
    "handler must return jsonError on the first wire-boundary failure",
  );
  assert.match(
    handlerBody,
    /const params = args as WakeAgentParams/,
    "success path must cast args as WakeAgentParams",
  );
  assert.match(
    handlerBody,
    /getDiscussionStore\(\)\.wakeAgent\(params\)/,
    "success path must call getDiscussionStore().wakeAgent(params)",
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
  assert.doesNotMatch(
    handlerBody,
    /requireBoolean/,
    "wake_agent has no boolean field — handler must not invent one",
  );
  assert.doesNotMatch(
    handlerBody,
    /params\.expected_head_message_id\s*\?\?/,
    "handler must NOT nullish-coalesce expected_head_message_id into an unguarded resume",
  );
});
