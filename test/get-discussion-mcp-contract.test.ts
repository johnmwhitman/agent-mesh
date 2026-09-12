/**
 * get_discussion MCP contract — driven over real MCP stdio with the tool's
 * PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `get_discussion` is the read-only
 * Discussion-state projector (src/index.ts advertised schema at L1700-L1716
 * + handler at toolHandlers["get_discussion"] L2816-L2835 on origin/main
 * 8433dcb8). It is published, yet origin/main has no dedicated stdio
 * contract pinning:
 *
 *   1. the advertised schema (required discussion_id, optional
 *      include_receipts, additionalProperties:false, annotations including
 *      readOnlyHint=true + idempotentHint=true + openWorldHint=false)
 *   2. required-field absence refused as isError naming tool + field
 *   3. wire-boundary type validation on discussion_id
 *   4. unknown-discussion DiscussionError projection {error, detail_fields}
 *   5. optionalBoolean include_receipts vs string-"false" OVER-INCLUDE
 *      defect (the named bug class: store compares `=== false`, so a
 *      string over-includes; "safe by accident" is not a contract)
 *   6. advertised additionalProperties:false vs handler that does not
 *      refuse phantom keys (honest advertised-vs-handler drift)
 *   7. source-string pin on the handler body
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * Discussion-state end-to-end coverage of transcript / attempts / budget /
 * fail-closed status lives in test/discussion-mcp.test.ts and
 * test/discussion-core.test.ts (in-process createDiscussionStore). This
 * file pins ONLY the MCP stdio boundary. No published-figure bump.
 *
 * A 2026-09-09 worktree (15490987) existed for get_discussion but never
 * landed; its T1 claimed phantom keys were a silent drop / "no bypass",
 * which is false of the handler (no requireAllowedKeys). This card is a
 * fresh origin/main pin with the 2026-09-12 honesty pattern.
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-get-discussion-mcp-"));
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
    { name: "get-discussion-contract-test", version: "1.0.0" },
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
  discussion_id: "d-1",
});

// ---------------------------------------------------------------------------
// T1 — advertised schema pin
// ---------------------------------------------------------------------------

test("get_discussion advertises required discussion_id, optional include_receipts, additionalProperties:false, and read-only/idempotent annotations", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "get_discussion");
    assert.ok(tool, "get_discussion must be advertised");
    const schema = tool.inputSchema as {
      type: string;
      required?: string[];
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["discussion_id"]);
    assert.equal(
      schema.additionalProperties,
      false,
      "get_discussion schema MUST advertise additionalProperties:false",
    );
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(props.discussion_id, {
      type: "string",
      description: "The discussion ID to retrieve.",
    });
    assert.deepEqual(props.include_receipts, {
      type: "boolean",
      description:
        "Whether to include lifecycle receipts in transcript presentation. Defaults to true.",
    });
    assert.ok(
      !schema.required!.includes("include_receipts"),
      "include_receipts is optional — must NOT appear in required[]",
    );
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    assert.ok(
      typeof tool.description === "string" &&
        tool.description.includes("Read-only: derive and return a Discussion's full state"),
      `description must keep the read-only derive phrase; got: ${tool.description}`,
    );
    assert.ok(
      typeof tool.description === "string" &&
        tool.description.includes(
          "invalid > closed > deadman > expired > exhausted > active > open",
        ),
      `description must keep the fail-closed status order; got: ${tool.description}`,
    );
    assert.ok(
      typeof tool.description === "string" &&
        tool.description.includes("Remains useful after every inbox entry has been acknowledged"),
      `description must keep the post-ack usefulness phrase; got: ${tool.description}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T2 — required-field absence refused as tool+field, NEVER DiscussionError
// ---------------------------------------------------------------------------

test("get_discussion refuses absent discussion_id as isError naming tool+field", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const response = await client.callTool({
      name: "get_discussion",
      arguments: {} as Record<string, unknown>,
    });
    assert.equal(
      (response as ToolResponse).isError,
      true,
      `absent discussion_id: must be a tool error; got: ${textOf(response)}`,
    );
    const text = textOf(response);
    assert.match(text, /get_discussion/, `absent discussion_id: must name the tool; got: ${text}`);
    assert.match(text, /'discussion_id'/, `absent discussion_id: must name the field; got: ${text}`);
    assert.match(
      text,
      /is required and must be a non-empty string/,
      `absent discussion_id: must use the requireString envelope; got: ${text}`,
    );
    const body = bodyOf(response);
    assert.equal(
      body.detail_fields,
      undefined,
      `absent discussion_id: wire-boundary refusal must be jsonError, not jsonDiscussionError; got: ${JSON.stringify(body)}`,
    );
    assert.notEqual(
      body.error,
      "not_found",
      `absent discussion_id: must die at firstError, never reach the store (omitted id produced not_found naming no id); got: ${JSON.stringify(body)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T3 — wire-boundary type validation on discussion_id
// ---------------------------------------------------------------------------

test("get_discussion refuses non-string shapes on discussion_id", async () => {
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
    for (const { label, v } of nonStringShapes) {
      const response = await client.callTool({
        name: "get_discussion",
        arguments: { discussion_id: v },
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `discussion_id=${label}: must be isError; got: ${textOf(response)}`,
      );
      const text = textOf(response);
      assert.match(
        text,
        /get_discussion/,
        `discussion_id=${label}: must name the tool; got: ${text}`,
      );
      assert.match(
        text,
        /'discussion_id'/,
        `discussion_id=${label}: must name the field; got: ${text}`,
      );
      const body = bodyOf(response);
      assert.equal(
        body.detail_fields,
        undefined,
        `discussion_id=${label}: must be jsonError, not jsonDiscussionError; got: ${JSON.stringify(body)}`,
      );
      assert.notEqual(
        body.error,
        "not_found",
        `discussion_id=${label}: must die at requireString, never reach the store; got: ${JSON.stringify(body)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T4 — unknown discussion surfaces as jsonDiscussionError not_found
// ---------------------------------------------------------------------------

test("get_discussion unknown discussion returns isError {error:not_found, detail_fields:{entity:discussion}}", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const response = await client.callTool({
      name: "get_discussion",
      arguments: {
        discussion_id: "no-such-discussion",
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
// T5 — named bug class: include_receipts:"false" must never silently OVER-include
// ---------------------------------------------------------------------------

test('get_discussion include_receipts:"false" is an optionalBoolean refusal, never a silent OVER-include', async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    // Named bug class: src/index.ts handler comment + discussion-store.ts
    // `params.include_receipts === false`. A string "false" is not === false,
    // so the store would over-include receipts. optionalBoolean refuses
    // that before the store walk because "safe by accident" is not a contract.
    const nonBooleanShapes: Array<{ label: string; v: unknown }> = [
      { label: "string-false", v: "false" },
      { label: "string-true", v: "true" },
      { label: "string-empty", v: "" },
      { label: "string-truthy", v: "yes" },
      { label: "number-zero", v: 0 },
      { label: "number-one", v: 1 },
      { label: "array", v: [false] },
      { label: "object", v: { value: false } },
    ];
    for (const { label, v } of nonBooleanShapes) {
      const args = honestArgs();
      args.include_receipts = v;
      const response = await client.callTool({
        name: "get_discussion",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `include_receipts=${label}: must be isError (OVER-INCLUDE-defect class); got: ${textOf(response)}`,
      );
      const text = textOf(response);
      assert.match(
        text,
        /get_discussion/,
        `include_receipts=${label}: must name the tool; got: ${text}`,
      );
      assert.match(
        text,
        /'include_receipts'/,
        `include_receipts=${label}: must name the field; got: ${text}`,
      );
      assert.match(
        text,
        /boolean|truthiness|"false"/i,
        `include_receipts=${label}: must explain the boolean/truthiness rationale; got: ${text}`,
      );
      const body = bodyOf(response);
      assert.equal(
        body.detail_fields,
        undefined,
        `include_receipts=${label}: must die at optionalBoolean, never jsonDiscussionError; got: ${JSON.stringify(body)}`,
      );
      assert.notEqual(
        body.error,
        "not_found",
        `include_receipts=${label}: must NEVER reach the store (string "false" would over-include); got: ${JSON.stringify(body)}`,
      );
    }

    // include_receipts is optional: omitted, real-boolean true, and
    // real-boolean false all pass the wire gate and reach the empty-ledger store.
    const accepted: Array<{ label: string; args: Record<string, unknown> }> = [
      { label: "omitted include_receipts", args: honestArgs() },
      { label: "include_receipts:false", args: { ...honestArgs(), include_receipts: false } },
      { label: "include_receipts:true", args: { ...honestArgs(), include_receipts: true } },
    ];
    for (const { label, args } of accepted) {
      const response = await client.callTool({
        name: "get_discussion",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: empty ledger still fails; got: ${textOf(response)}`,
      );
      const body = bodyOf(response);
      assert.equal(
        body.error,
        "not_found",
        `${label}: real boolean / absence must pass optionalBoolean and reach the store; got: ${JSON.stringify(body)}`,
      );
      assert.deepEqual(body.detail_fields, {
        entity: "discussion",
        discussion_id: "d-1",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// T6 — advertised additionalProperties:false is aspirational at the handler
// ---------------------------------------------------------------------------

test("get_discussion phantom top-level keys still reach the store (advertised additionalProperties:false is not handler-enforced)", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const phantomCases: ReadonlyArray<{ label: string; extra: Record<string, unknown> }> = [
      { label: "force", extra: { force: true } },
      { label: "retry", extra: { retry: 3 } },
      { label: "note", extra: { note: "for your eyes only" } },
    ];
    for (const { label, extra } of phantomCases) {
      const response = await client.callTool({
        name: "get_discussion",
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

test("get_discussion handler source pins requireString discussion_id, optionalBoolean include_receipts, jsonDiscussionError", () => {
  const source = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");
  assert.match(
    source,
    /toolHandlers\["get_discussion"\]/,
    "get_discussion must be a top-level toolHandlers entry",
  );
  assert.ok(
    source.includes("Read-only: derive and return a Discussion's full state"),
    "get_discussion description must keep the read-only derive phrase",
  );
  assert.ok(
    source.includes("invalid > closed > deadman > expired > exhausted > active > open"),
    "get_discussion description must keep the fail-closed status order",
  );
  assert.ok(
    source.includes("Remains useful after every inbox entry has been acknowledged."),
    "get_discussion description must keep the post-ack usefulness phrase",
  );

  const handlerMatch = source.match(
    /toolHandlers\["get_discussion"\] = async \(args\) => \{([\s\S]*?)\n\};\s*\n\s*server\.setRequestHandler\(CallToolRequestSchema/,
  );
  assert.ok(
    handlerMatch,
    "get_discussion handler block must be found immediately before CallToolRequestSchema",
  );
  const handlerBody = handlerMatch[1]!;
  assert.match(
    handlerBody,
    /requireString\(\s*"get_discussion"\s*,\s*"discussion_id"/,
    "handler must requireString discussion_id",
  );
  assert.match(
    handlerBody,
    /optionalBoolean\(\s*"get_discussion"\s*,\s*"include_receipts"/,
    "handler must optionalBoolean include_receipts — the OVER-INCLUDE-defect class",
  );
  assert.match(
    handlerBody,
    /const argErr = firstError\(/,
    "handler must collect the require* results via firstError",
  );
  assert.match(
    handlerBody,
    /if \(argErr\) return jsonError\(argErr\)/,
    "handler must return jsonError on the first wire-boundary failure",
  );
  assert.match(
    handlerBody,
    /const params = args as GetDiscussionParams/,
    "success path must cast args as GetDiscussionParams",
  );
  assert.match(
    handlerBody,
    /getDiscussionStore\(\)\.getDiscussion\(params\)/,
    "success path must call getDiscussionStore().getDiscussion(params)",
  );
  assert.match(
    handlerBody,
    /return jsonResult\(view\)/,
    "success path must return jsonResult(view)",
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
    /Boolean\s*\(\s*(args|params).*include_receipts/,
    "handler must NOT coerce include_receipts via Boolean() — that is the OVER-INCLUDE truthiness defect",
  );
  assert.match(
    handlerBody,
    /include_receipts[\s\S]*=== false/,
    "handler comment must keep the named === false OVER-INCLUDE-defect rationale",
  );
  assert.match(
    handlerBody,
    /safe by accident/,
    "handler comment must keep the 'safe by accident is not a contract' rationale",
  );
});
