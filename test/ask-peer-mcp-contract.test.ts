/**
 * ask_peer MCP contract — driven over real MCP stdio with the tool's
 * PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `ask_peer` is the conversation-launching
 * boundary of the discussion substrate (src/index.ts advertised schema at
 * L1580-L1622 + handler at toolHandlers["ask_peer"] L2688-L2726). It is
 * published, yet origin/main has no dedicated stdio contract pinning:
 *
 *   1. the advertised schema (eight required fields, additionalProperties:false,
 *      annotations including readOnlyHint=false + openWorldHint=true)
 *   2. required-field absence refused as isError naming tool + field
 *   3. wire-boundary type validation, including the named wake_peer
 *      truthiness defect (`wake_peer:"false"` must not launch)
 *   4. unknown-agent DiscussionError projection {error, detail_fields}
 *   5. advertised min/max NOT enforced at requireNumber — out-of-range
 *      integers that pass the type gate surface as store invalid_envelope
 *   6. advertised additionalProperties:false vs handler that does not
 *      refuse phantom keys (honest advertised-vs-handler drift)
 *   7. source-string pin on the handler body
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * A 2026-09-09 worktree (4802d62a) existed but never landed. This card is
 * a fresh origin/main pin with no published-figure bump.
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-ask-peer-mcp-"));
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
    { name: "ask-peer-contract-test", version: "1.0.0" },
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
  from_agent_id: "agent-from",
  to_agent_id: "agent-to",
  fleet_id: "fleet-x",
  payload: "bounded payload",
  max_turns: 4,
  timeout_ms: 60_000,
  turn_timeout_ms: 30_000,
  wake_peer: false,
});

const REQUIRED_FIELDS = [
  "from_agent_id",
  "to_agent_id",
  "fleet_id",
  "payload",
  "max_turns",
  "timeout_ms",
  "turn_timeout_ms",
  "wake_peer",
] as const;

// ---------------------------------------------------------------------------
// T1 — advertised schema pin
// ---------------------------------------------------------------------------

test("ask_peer advertises eight required fields, additionalProperties:false, and write/open-world annotations", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "ask_peer");
    assert.ok(tool, "ask_peer must be advertised");
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
      "ask_peer schema MUST advertise additionalProperties:false",
    );
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(props.from_agent_id, {
      type: "string",
      description: "The initiating agent's ID.",
    });
    assert.deepEqual(props.to_agent_id, {
      type: "string",
      description: "The target peer agent's ID.",
    });
    assert.deepEqual(props.fleet_id, {
      type: "string",
      description: "The fleet both agents belong to.",
    });
    assert.deepEqual(props.payload, {
      type: "string",
      description: "The UTF-8 string payload for the root question.",
    });
    assert.deepEqual(props.max_turns, {
      type: "integer",
      minimum: 2,
      maximum: 32,
      description: "Total allowed turns, including the root. Must be 2..32.",
    });
    assert.deepEqual(props.timeout_ms, {
      type: "integer",
      minimum: 1000,
      maximum: 900000,
      description: "Conversation duration in milliseconds. Must be 1s..15m.",
    });
    assert.deepEqual(props.turn_timeout_ms, {
      type: "integer",
      minimum: 1000,
      maximum: 300000,
      description: "Per-turn deadline duration. Must be 1s..5m and <= timeout_ms.",
    });
    assert.deepEqual(props.wake_peer, {
      type: "boolean",
      description: "If true, explicitly reserves exactly one peer attempt.",
    });
    assert.deepEqual(tool.annotations, {
      openWorldHint: true,
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });
});

// ---------------------------------------------------------------------------
// T2 — required-field absence refused as tool+field
// ---------------------------------------------------------------------------

test("ask_peer refuses every absent required field as isError naming tool+field", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    for (const field of REQUIRED_FIELDS) {
      const args = honestArgs();
      delete args[field];
      const response = await client.callTool({
        name: "ask_peer",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `absent ${field}: must be a tool error; got: ${textOf(response)}`,
      );
      const text = textOf(response);
      assert.match(text, /ask_peer/, `absent ${field}: must name the tool; got: ${text}`);
      assert.match(
        text,
        new RegExp(`'${field}'`),
        `absent ${field}: must name the field; got: ${text}`,
      );
      const body = bodyOf(response);
      assert.equal(
        body.detail_fields,
        undefined,
        `absent ${field}: wire-boundary refusal must be jsonError, not jsonDiscussionError; got: ${JSON.stringify(body)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T3 — wire-boundary type validation, including wake_peer:"false"
// ---------------------------------------------------------------------------

test("ask_peer refuses non-string / non-integer / non-boolean shapes, including wake_peer:\"false\"", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const stringFields = ["from_agent_id", "to_agent_id", "fleet_id", "payload"] as const;
    const nonStringShapes: Array<{ label: string; v: unknown }> = [
      { label: "null", v: null },
      { label: "empty", v: "" },
      { label: "whitespace", v: "   " },
      { label: "number", v: 42 },
      { label: "boolean", v: false },
      { label: "array", v: ["x"] },
      { label: "object", v: { x: 1 } },
    ];
    for (const field of stringFields) {
      for (const { label, v } of nonStringShapes) {
        const args = honestArgs();
        args[field] = v;
        const response = await client.callTool({
          name: "ask_peer",
          arguments: args,
        });
        assert.equal(
          (response as ToolResponse).isError,
          true,
          `${field}=${label}: must be isError; got: ${textOf(response)}`,
        );
        const text = textOf(response);
        assert.match(text, /ask_peer/, `${field}=${label}: must name the tool; got: ${text}`);
        assert.match(
          text,
          new RegExp(`'${field}'`),
          `${field}=${label}: must name the field; got: ${text}`,
        );
      }
    }

    const integerFields = ["max_turns", "timeout_ms", "turn_timeout_ms"] as const;
    const badIntegerShapes: Array<{ label: string; v: unknown }> = [
      { label: "string", v: "4" },
      { label: "boolean", v: true },
      { label: "null", v: null },
      { label: "array", v: [4] },
      { label: "object", v: { v: 4 } },
      { label: "non-integer", v: 2.5 },
    ];
    for (const field of integerFields) {
      for (const { label, v } of badIntegerShapes) {
        const args = honestArgs();
        args[field] = v;
        const response = await client.callTool({
          name: "ask_peer",
          arguments: args,
        });
        assert.equal(
          (response as ToolResponse).isError,
          true,
          `${field}=${label}: must be isError; got: ${textOf(response)}`,
        );
        const text = textOf(response);
        assert.match(text, /ask_peer/, `${field}=${label}: must name the tool; got: ${text}`);
        assert.match(
          text,
          new RegExp(`'${field}'`),
          `${field}=${label}: must name the field; got: ${text}`,
        );
      }
    }

    // Named bug class: src/index.ts L2688-L2695 — previous boundary read
    // wake_peer for truthiness, so the string "false" reserved and launched.
    const nonBooleanShapes: Array<{ label: string; v: unknown }> = [
      { label: "string-true", v: "true" },
      { label: "string-false", v: "false" },
      { label: "string-empty", v: "" },
      { label: "string-truthy", v: "yes" },
      { label: "number-zero", v: 0 },
      { label: "number-one", v: 1 },
      { label: "null", v: null },
      { label: "array", v: [false] },
      { label: "object", v: { value: false } },
    ];
    for (const { label, v } of nonBooleanShapes) {
      const args = honestArgs();
      args.wake_peer = v;
      const response = await client.callTool({
        name: "ask_peer",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `wake_peer=${label}: must be isError (truthiness-defect class); got: ${textOf(response)}`,
      );
      const text = textOf(response);
      assert.match(text, /ask_peer/, `wake_peer=${label}: must name the tool; got: ${text}`);
      assert.match(text, /'wake_peer'/, `wake_peer=${label}: must name the field; got: ${text}`);
      assert.match(
        text,
        /boolean|truthiness|"false"/i,
        `wake_peer=${label}: must explain the boolean/truthiness rationale; got: ${text}`,
      );
      const body = bodyOf(response);
      assert.notEqual(
        body.error,
        "not_found",
        `wake_peer=${label}: must die at requireBoolean, never reach the store; got: ${JSON.stringify(body)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T4 — unknown agents surface as jsonDiscussionError not_found
// ---------------------------------------------------------------------------

test("ask_peer unknown agents return isError {error:not_found, detail_fields:{entity:agent}}", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const response = await client.callTool({
      name: "ask_peer",
      arguments: honestArgs(),
    });
    assert.equal(
      (response as ToolResponse).isError,
      true,
      `unknown agents MUST return isError; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.equal(body.error, "not_found", `got: ${JSON.stringify(body)}`);
    assert.deepEqual(
      body.detail_fields,
      { entity: "agent" },
      `DiscussionError must project snake_case detail_fields; got: ${JSON.stringify(body)}`,
    );
    assert.deepEqual(Object.keys(body).sort(), ["detail_fields", "error"]);
  });
});

// ---------------------------------------------------------------------------
// T5 — advertised min/max are store-enforced, not requireNumber-enforced
// ---------------------------------------------------------------------------

test("ask_peer out-of-range integers that pass requireNumber surface as store invalid_envelope", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const cases: ReadonlyArray<{
      label: string;
      patch: Record<string, unknown>;
      entity: string;
    }> = [
      { label: "max_turns=1 (below advertised minimum 2)", patch: { max_turns: 1 }, entity: "max_turns" },
      { label: "max_turns=33 (above advertised maximum 32)", patch: { max_turns: 33 }, entity: "max_turns" },
      { label: "timeout_ms=999 (below advertised minimum 1000)", patch: { timeout_ms: 999 }, entity: "timeout_ms" },
      {
        label: "turn_timeout_ms=500 (below advertised minimum 1000)",
        patch: { turn_timeout_ms: 500 },
        entity: "turn_timeout_ms",
      },
    ];
    for (const { label, patch, entity } of cases) {
      const response = await client.callTool({
        name: "ask_peer",
        arguments: { ...honestArgs(), ...patch },
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be isError; got: ${textOf(response)}`,
      );
      const body = bodyOf(response);
      assert.equal(
        body.error,
        "invalid_envelope",
        `${label}: advertised min/max are NOT requireNumber bounds — store must throw invalid_envelope; got: ${JSON.stringify(body)}`,
      );
      assert.deepEqual(
        body.detail_fields,
        { entity },
        `${label}: detail_fields.entity must name ${entity}; got: ${JSON.stringify(body)}`,
      );
      const text = textOf(response);
      assert.doesNotMatch(
        text,
        /is required and must be a finite number/,
        `${label}: must NOT be a requireNumber type error; got: ${text}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T6 — advertised additionalProperties:false is aspirational at the handler
// ---------------------------------------------------------------------------

test("ask_peer phantom top-level keys still reach the store (advertised additionalProperties:false is not handler-enforced)", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const phantomCases: ReadonlyArray<{ label: string; extra: Record<string, unknown> }> = [
      { label: "force", extra: { force: true } },
      { label: "retry", extra: { retry: 3 } },
      { label: "note", extra: { note: "for your eyes only" } },
    ];
    for (const { label, extra } of phantomCases) {
      const response = await client.callTool({
        name: "ask_peer",
        arguments: { ...honestArgs(), ...extra },
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `phantom ${label}: unknown agents still fail; got: ${textOf(response)}`,
      );
      const body = bodyOf(response);
      assert.equal(
        body.error,
        "not_found",
        `phantom ${label}: handler does not refuse extra keys — call must reach the store not_found path, not an additionalProperties error; got: ${JSON.stringify(body)}`,
      );
      assert.deepEqual(body.detail_fields, { entity: "agent" });
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

test("ask_peer handler source pins requireString x4, requireNumber integer x3, requireBoolean, openDiscussion+awaitAnswer, jsonDiscussionError", () => {
  const source = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");
  assert.match(
    source,
    /toolHandlers\["ask_peer"\]/,
    "ask_peer must be a top-level toolHandlers entry",
  );
  assert.ok(
    source.includes(
      '"Open a bounded, two-agent Discussion: sends the root question and (optionally) explicitly reserves one peer attempt, then waits until the conversation deadline for a settled answer.',
    ),
    "ask_peer description must keep the bounded two-agent Discussion surface text",
  );
  assert.ok(
    source.includes("Message arrival never starts an agent by itself"),
    "ask_peer description must keep the wake_peer invariant phrase",
  );

  const handlerMatch = source.match(
    /toolHandlers\["ask_peer"\] = async \(args\) => \{([\s\S]*?)\n\};\s*\n\s*toolHandlers\["wake_agent"\]/,
  );
  assert.ok(
    handlerMatch,
    "ask_peer handler block must be found immediately before wake_agent",
  );
  const handlerBody = handlerMatch[1]!;
  assert.match(
    handlerBody,
    /requireString\(\s*"ask_peer"\s*,\s*"from_agent_id"/,
    "handler must requireString from_agent_id",
  );
  assert.match(
    handlerBody,
    /requireString\(\s*"ask_peer"\s*,\s*"to_agent_id"/,
    "handler must requireString to_agent_id",
  );
  assert.match(
    handlerBody,
    /requireString\(\s*"ask_peer"\s*,\s*"fleet_id"/,
    "handler must requireString fleet_id",
  );
  assert.match(
    handlerBody,
    /requireString\(\s*"ask_peer"\s*,\s*"payload"/,
    "handler must requireString payload",
  );
  assert.match(
    handlerBody,
    /requireNumber\(\s*"ask_peer"\s*,\s*"max_turns"[\s\S]*?\{\s*integer:\s*true\s*\}/,
    "handler must requireNumber max_turns with integer:true",
  );
  assert.match(
    handlerBody,
    /requireNumber\(\s*"ask_peer"\s*,\s*"timeout_ms"[\s\S]*?\{\s*integer:\s*true\s*\}/,
    "handler must requireNumber timeout_ms with integer:true",
  );
  assert.match(
    handlerBody,
    /requireNumber\(\s*"ask_peer"\s*,\s*"turn_timeout_ms"[\s\S]*?\{\s*integer:\s*true\s*\}/,
    "handler must requireNumber turn_timeout_ms with integer:true",
  );
  assert.match(
    handlerBody,
    /requireBoolean\(\s*"ask_peer"\s*,\s*"wake_peer"/,
    "handler must requireBoolean wake_peer (never a truthiness read)",
  );
  assert.match(
    handlerBody,
    /if \(argErr\) return jsonError\(argErr\)/,
    "handler must return jsonError on the first wire-boundary failure",
  );
  assert.match(
    handlerBody,
    /getDiscussionStore\(\)\.openDiscussion\(params\)/,
    "success path must call getDiscussionStore().openDiscussion(params)",
  );
  assert.match(
    handlerBody,
    /getDiscussionStore\(\)\.awaitAnswer\(opened\.discussion_id, opened\.root_message_id\)/,
    "success path must awaitAnswer the opened discussion",
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
    /Boolean\(\s*(?:args|params).*wake_peer/,
    "handler must NOT reintroduce a truthiness read of wake_peer",
  );
  assert.doesNotMatch(
    handlerBody,
    /requireNumber\([\s\S]*min:/,
    "handler requireNumber calls must NOT pass min/max — advertised bounds are store-owned",
  );
});
