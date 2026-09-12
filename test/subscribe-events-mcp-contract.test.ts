/**
 * subscribe_events MCP contract — driven over real MCP stdio with the tool's
 * PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `subscribe_events` is the operator-facing
 * unified fleet-wide SSE event-stream discovery surface (src/index.ts
 * advertised schema at L1548-L1560 + handler at
 * toolHandlers["subscribe_events"] L2657-L2682 on origin/main 8433dcb8).
 * It is published, yet origin/main has no dedicated stdio contract pinning
 * the 2026-09-12 honesty pattern:
 *
 *   1. the advertised schema (optional fleet_id, NO required array, NO
 *      additionalProperties key, annotations including readOnlyHint=true
 *      + idempotentHint=true + openWorldHint=false) plus description
 *      phrases SSE / Keep-alive :hb / MESHFLEET_AUTH_TOKEN / Omit to
 *      receive all events
 *   2. optional-field honesty — absent fleet_id is NOT a required-field
 *      refusal; in child-mode it falls through to the SSE-down guard
 *   3. wire-boundary type validation on fleet_id when provided — the
 *      named bug class: a wrong-typed fleet_id used to stringify into
 *      `?fleet_id=<coerced>` and look like a legitimate filter.
 *      optionalNonBlankString must fire BEFORE isSseServerRunning /
 *      subscribeEventsUrl
 *   4. SSE-down with a provided fleet_id is jsonError naming the live
 *      endpoint, NEVER a phantom stream_url
 *   5. SSE-running no-filter happy path (fleet_id serialized as null) +
 *      advertised-vs-handler drift honesty — schema does NOT advertise
 *      additionalProperties:false, and phantom top-level keys still
 *      reach the handler (no requireAllowedKeys)
 *   6. SSE-running with-filter happy path (fleet_id echoed, URL query,
 *      conditional "Only events carrying..." instructions)
 *   7. source-string pin on the handler body
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * A 2026-09-09 worktree (8204b1d0) existed for subscribe_events but never
 * landed and mixed a 6-test pin without the SSE-down never-phantom-URL
 * honesty or the additionalProperties-undefined advertisement pin. A
 * 2026-09-11 worktree (16f363d8) was a 5-test pin that mixed the
 * source-string check into the phantom-args test, used a hard line-slice
 * of src/index.ts:2657-2682 (fragile against any insert above the
 * handler), and never exercised child-mode SSE-down. This card is a
 * fresh origin/main pin with the 2026-09-12 honesty pattern, including
 * a real SSE-running stdio happy path AND the SSE-down never-phantom-URL
 * pin.
 *
 * No published-figure bump. HANDOFF.md is not edited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-subscribe-events-mcp-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-subscribe-events-${dir}`,
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

const childEnv = (
  fix: Fixture,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  MESHFLEET_DB_FILE: fix.dbFile,
  MESHFLEET_DATA_FILE: fix.dataFile,
  MESHFLEET_EVENT_LOG_FILE: fix.eventsFile,
  MESHFLEET_RATIFY_SWEEP_MS: "0",
  HOME: fix.dir,
  ...extra,
});

async function connectChild(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env,
    stderr: "ignore",
  });
  const client = new Client(
    { name: "subscribe-events-contract-test", version: "1.0.0" },
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

/** Child-mode: recovery, sweeper, and SSE skipped (src/index.ts L3092). */
async function withChildServer(
  fix: Fixture,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  applyFixtureEnv(fix);
  const client = await connectChild(
    childEnv(fix, { AGENT_MESH_CHILD: "1" }),
  );
  try {
    await fn(client);
  } finally {
    await client.close().catch(() => {});
    await cleanupFix(fix);
  }
}

let nextPort = 37810;

/** Full main(): SSE listener binds on a per-test MESHFLEET_SSE_PORT. */
async function withSseServer(
  fix: Fixture,
  fn: (client: Client, port: number) => Promise<void>,
): Promise<void> {
  applyFixtureEnv(fix);
  const port = nextPort++;
  const client = await connectChild(
    childEnv(fix, {
      MESHFLEET_SSE_PORT: String(port),
      MESHFLEET_SSE_HOST: "127.0.0.1",
    }),
  );
  try {
    await fn(client, port);
  } finally {
    await client.close().catch(() => {});
    await cleanupFix(fix);
  }
}

const SUBSCRIBE_EVENTS_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const ENVELOPE_KEYS = [
  "fleet_id",
  "instructions",
  "served_by_this_process_only",
  "stream_url",
];

// ---------------------------------------------------------------------------
// T1 — advertised schema pin
// ---------------------------------------------------------------------------

test("subscribe_events advertises optional fleet_id, no required, no additionalProperties, and read-only/idempotent annotations", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "subscribe_events");
    assert.ok(tool, "subscribe_events must be advertised");
    const schema = tool.inputSchema as {
      type: string;
      required?: string[];
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    assert.equal(schema.type, "object");
    assert.equal(
      schema.required,
      undefined,
      "subscribe_events schema MUST NOT advertise required — fleet_id is documented as optional (\"Omit to receive all events\")",
    );
    assert.equal(
      schema.additionalProperties,
      undefined,
      "subscribe_events schema MUST NOT advertise additionalProperties (handler has no requireAllowedKeys; advertising false would be a lie)",
    );
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(props).sort(), ["fleet_id"]);
    assert.deepEqual(props.fleet_id, {
      type: "string",
      description: "Optional fleet ID to filter events. Omit to receive all events.",
    });
    assert.deepEqual(tool.annotations, SUBSCRIBE_EVENTS_ANNOTATIONS);
    assert.ok(
      typeof tool.description === "string" &&
        tool.description.includes("Server-Sent Events (SSE)"),
      `description must keep the SSE phrase; got: ${tool.description}`,
    );
    assert.ok(
      typeof tool.description === "string" &&
        tool.description.includes("Keep-alive :hb comment frames are sent every 30s"),
      `description must keep the keep-alive :hb phrase; got: ${tool.description}`,
    );
    assert.ok(
      typeof tool.description === "string" &&
        tool.description.includes("MESHFLEET_AUTH_TOKEN"),
      `description must keep the MESHFLEET_AUTH_TOKEN phrase; got: ${tool.description}`,
    );
    assert.ok(
      typeof tool.description === "string" &&
        tool.description.includes("Optional fleet_id filter"),
      `description must keep the optional fleet_id filter phrase; got: ${tool.description}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T2 — optional-field honesty: absent fleet_id is NOT a required-field refusal
// ---------------------------------------------------------------------------

test("subscribe_events treats absent fleet_id as optional; child-mode falls through to SSE-down, never 'is required'", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "subscribe_events",
      arguments: {} as Record<string, unknown>,
    });
    assert.equal(
      (response as ToolResponse).isError,
      true,
      `absent fleet_id in child-mode must be a tool error (SSE-down); got: ${textOf(response)}`,
    );
    const text = textOf(response);
    assert.match(
      text,
      /subscribe_events/,
      `absent fleet_id: must name the tool; got: ${text}`,
    );
    assert.match(
      text,
      /no live SSE endpoint/,
      `absent fleet_id: optional field must fall through to the SSE-down guard; got: ${text}`,
    );
    assert.doesNotMatch(
      text,
      /is required/,
      `absent fleet_id: MUST NOT be refused as a required field; fleet_id is documented as optional; got: ${text}`,
    );
    const body = bodyOf(response);
    assert.equal(
      "stream_url" in body,
      false,
      `absent fleet_id SSE-down MUST NOT carry a stream_url; got: ${JSON.stringify(body)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T3 — named bug class: wrong-typed fleet_id must NEVER stringify into a filter
// ---------------------------------------------------------------------------

test("subscribe_events refuses non-string shapes on fleet_id (stringified-filter-key bug class)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
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
        name: "subscribe_events",
        arguments: { fleet_id: v },
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `fleet_id=${label}: must be isError; got: ${textOf(response)}`,
      );
      const text = textOf(response);
      assert.match(
        text,
        /subscribe_events/,
        `fleet_id=${label}: must name the tool; got: ${text}`,
      );
      assert.match(
        text,
        /'fleet_id'/,
        `fleet_id=${label}: must name the field; got: ${text}`,
      );
      assert.match(
        text,
        /must be a non-empty string when provided/,
        `fleet_id=${label}: must use the optionalNonBlankString envelope; got: ${text}`,
      );
      assert.doesNotMatch(
        text,
        /no live SSE endpoint/i,
        `fleet_id=${label}: MUST fire BEFORE the SSE-down guard; got: ${text}`,
      );
      assert.doesNotMatch(
        text,
        /events\/stream/i,
        `fleet_id=${label}: MUST NOT stringify into a legitimate-looking stream_url (named bug class at src/index.ts:2659-2661); got: ${text}`,
      );
      const body = bodyOf(response);
      assert.equal(
        "stream_url" in body,
        false,
        `fleet_id=${label}: MUST NOT carry a stream_url; got: ${JSON.stringify(body)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T4 — SSE-down with a provided fleet_id is jsonError, NEVER a phantom stream_url
// ---------------------------------------------------------------------------

test("subscribe_events SSE-down with a provided fleet_id is isError, not a phantom stream_url", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "subscribe_events",
      arguments: { fleet_id: "fleet-that-exists-or-not" },
    });
    assert.equal(
      (response as ToolResponse).isError,
      true,
      `SSE-down MUST surface as isError; got: ${textOf(response)}`,
    );
    const text = textOf(response);
    assert.match(
      text,
      /subscribe_events/,
      `SSE-down must name the tool; got: ${text}`,
    );
    assert.match(
      text,
      /no live SSE endpoint/,
      `SSE-down must name the live-endpoint condition; got: ${text}`,
    );
    assert.match(
      text,
      /NDJSON event log or poll get_health/,
      `SSE-down must keep the NDJSON / get_health source-of-truth instruction; got: ${text}`,
    );
    const body = bodyOf(response);
    assert.equal(
      "stream_url" in body,
      false,
      `SSE-down MUST NOT carry a stream_url; got: ${JSON.stringify(body)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T5 — SSE-running no-filter happy path + advertised-vs-handler phantom-key honesty
// ---------------------------------------------------------------------------

test("subscribe_events SSE-running no-filter happy path returns four-key envelope with fleet_id null; phantom keys still reach the handler", async () => {
  const fix = makeFixture();
  await withSseServer(fix, async (client, port) => {
    const response = await client.callTool({
      name: "subscribe_events",
      arguments: {},
    });
    assert.equal(
      (response as ToolResponse).isError,
      undefined,
      `SSE-running no-filter happy-path MUST NOT be isError; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.deepEqual(
      Object.keys(body).sort(),
      ENVELOPE_KEYS,
      `response must have exactly the four documented keys; got: ${Object.keys(body).sort()}`,
    );
    assert.equal(
      body.fleet_id,
      null,
      `no-filter happy-path MUST serialize fleet_id as null (handler does fleet_id ?? null); got: ${JSON.stringify(body.fleet_id)}`,
    );
    assert.equal(body.served_by_this_process_only, true);
    assert.equal(
      body.stream_url,
      `http://127.0.0.1:${port}/events/stream`,
    );
    assert.match(
      String(body.instructions),
      /All ledger events are emitted\./,
      `instructions must keep the no-filter wording; got: ${body.instructions}`,
    );
    assert.match(
      String(body.instructions),
      /NDJSON event log is the durable source of truth/,
      `instructions must keep the NDJSON source-of-truth honesty; got: ${body.instructions}`,
    );
    assert.match(
      String(body.instructions),
      /Heartbeat comment frames `:hb\\n\\n` are sent every 30s/,
      `instructions must keep the heartbeat wording; got: ${body.instructions}`,
    );

    // Honesty: schema does not advertise additionalProperties:false, and
    // the handler has no requireAllowedKeys. Phantom keys must still
    // reach the success path, not an additional-properties refusal.
    const phantom = await client.callTool({
      name: "subscribe_events",
      arguments: {
        force: true,
        retry: 3,
        note: "for your eyes only",
      },
    });
    assert.equal(
      (phantom as ToolResponse).isError,
      undefined,
      `phantom keys MUST still succeed (additionalProperties is not advertised and not handler-enforced); got: ${textOf(phantom)}`,
    );
    const phantomBody = bodyOf(phantom);
    assert.equal(phantomBody.fleet_id, null);
    assert.equal(phantomBody.served_by_this_process_only, true);
    assert.equal(
      phantomBody.stream_url,
      `http://127.0.0.1:${port}/events/stream`,
    );
    for (const k of ["force", "retry", "note"]) {
      assert.equal(
        k in phantomBody,
        false,
        `phantom arg "${k}" MUST NOT leak into the response`,
      );
    }
    const phantomText = textOf(phantom);
    assert.doesNotMatch(
      phantomText,
      /additionalProperties|unknown (key|field|property)|not allowed/i,
      `phantom keys must NOT be refused as an additional-properties schema error; got: ${phantomText}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T6 — SSE-running with-filter happy path
// ---------------------------------------------------------------------------

test("subscribe_events SSE-running with-filter happy path echoes fleet_id, appends ?fleet_id=, and uses the scoped instructions", async () => {
  const fix = makeFixture();
  await withSseServer(fix, async (client, port) => {
    const response = await client.callTool({
      name: "subscribe_events",
      arguments: { fleet_id: "f-x" },
    });
    assert.equal(
      (response as ToolResponse).isError,
      undefined,
      `SSE-running with-filter happy-path MUST NOT be isError; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.deepEqual(
      Object.keys(body).sort(),
      ENVELOPE_KEYS,
      `response must have exactly the four documented keys; got: ${Object.keys(body).sort()}`,
    );
    assert.equal(body.fleet_id, "f-x");
    assert.equal(body.served_by_this_process_only, true);
    assert.equal(
      body.stream_url,
      `http://127.0.0.1:${port}/events/stream?fleet_id=f-x`,
    );
    assert.match(
      String(body.instructions),
      /Only events carrying fleet_id="f-x" are emitted\./,
      `instructions must keep the scoped-filter wording; got: ${body.instructions}`,
    );
    assert.doesNotMatch(
      String(body.instructions),
      /All ledger events are emitted/,
      `with-filter instructions MUST NOT claim all events are emitted; got: ${body.instructions}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T7 — source-string pin
// ---------------------------------------------------------------------------

test("subscribe_events handler source pins optionalNonBlankString fleet_id, SSE-down guard, four-key jsonResult, fleet_id ?? null", () => {
  const source = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");
  assert.match(
    source,
    /toolHandlers\["subscribe_events"\]/,
    "subscribe_events must be a top-level toolHandlers entry",
  );
  assert.ok(
    source.includes("Subscribe to the unified fleet-wide event stream via Server-Sent Events (SSE)."),
    "subscribe_events description must keep the unified fleet-wide SSE phrase",
  );
  assert.ok(
    source.includes("Keep-alive :hb comment frames are sent every 30s."),
    "subscribe_events description must keep the keep-alive :hb phrase",
  );
  assert.ok(
    source.includes("MESHFLEET_AUTH_TOKEN"),
    "subscribe_events description must keep the MESHFLEET_AUTH_TOKEN phrase",
  );
  assert.ok(
    source.includes("Omit to receive all events."),
    "subscribe_events fleet_id description must keep the omit-to-receive-all-events phrase",
  );

  const schemaMatch = source.match(
    /name: "subscribe_events",[\s\S]*?inputSchema: \{([\s\S]*?)\},\s*annotations:/,
  );
  assert.ok(schemaMatch, "subscribe_events inputSchema block must be found");
  const schemaBody = schemaMatch[1]!;
  assert.doesNotMatch(
    schemaBody,
    /additionalProperties/,
    "advertised schema must NOT declare additionalProperties — advertising false would be a lie (handler has no requireAllowedKeys)",
  );
  assert.doesNotMatch(
    schemaBody,
    /required:/,
    "advertised schema must NOT declare required — fleet_id is documented as optional",
  );
  assert.match(
    schemaBody,
    /fleet_id: \{/,
    "advertised schema must declare the optional fleet_id property",
  );

  const handlerMatch = source.match(
    /toolHandlers\["subscribe_events"\] = async \(args\) => \{([\s\S]*?)\n\};\s*\n\s*toolHandlers\["save_fleet_template"\]/,
  );
  assert.ok(
    handlerMatch,
    "subscribe_events handler block must be found immediately before save_fleet_template",
  );
  const handlerBody = handlerMatch[1]!;
  assert.match(
    handlerBody,
    /const \{ fleet_id \} = args as \{ fleet_id\?: string \}/,
    "handler must destructure optional fleet_id from args",
  );
  assert.match(
    handlerBody,
    /if \(fleet_id !== undefined\)/,
    "handler must only validate fleet_id when it was actually provided",
  );
  assert.match(
    handlerBody,
    /optionalNonBlankString\(\s*"subscribe_events"\s*,\s*"fleet_id"/,
    "handler must optionalNonBlankString fleet_id (not requireString — the field is optional)",
  );
  assert.match(
    handlerBody,
    /if \(invalid\) return jsonError\(invalid\)/,
    "handler must return jsonError on the optionalNonBlankString failure",
  );
  assert.match(
    handlerBody,
    /if \(!isSseServerRunning\(\)\)/,
    "handler must refuse when this process has no live SSE endpoint",
  );
  assert.match(
    handlerBody,
    /no live SSE endpoint/,
    "SSE-down jsonError must name the live-endpoint condition",
  );
  assert.match(
    handlerBody,
    /NDJSON event log or poll get_health/,
    "SSE-down jsonError must keep the NDJSON / get_health source-of-truth instruction",
  );
  assert.match(
    handlerBody,
    /const streamUrl = subscribeEventsUrl\(fleet_id\)/,
    "success path must call subscribeEventsUrl(fleet_id)",
  );
  assert.match(
    handlerBody,
    /return jsonResult\(\{/,
    "success path must return jsonResult({...})",
  );
  assert.match(
    handlerBody,
    /fleet_id: fleet_id \?\? null/,
    "success path must coerce missing fleet_id to null (JSON.stringify would otherwise drop undefined)",
  );
  assert.match(
    handlerBody,
    /served_by_this_process_only:\s*true/,
    "success path must pin served_by_this_process_only: true (the documented honesty claim)",
  );
  assert.match(
    handlerBody,
    /Only events carrying fleet_id=\\?"\$\{fleet_id\}\\?" are emitted/,
    "success path must keep the scoped-filter instruction wording",
  );
  assert.match(
    handlerBody,
    /All ledger events are emitted/,
    "success path must keep the no-filter instruction wording",
  );
  for (const key of ["stream_url", "fleet_id", "served_by_this_process_only", "instructions"]) {
    assert.ok(
      handlerBody.includes(key),
      `subscribe_events handler MUST include response key "${key}" in its jsonResult`,
    );
  }
  assert.doesNotMatch(
    handlerBody,
    /requireAllowedKeys/,
    "handler must NOT call requireAllowedKeys — additionalProperties is not advertised and not handler-enforced",
  );
  assert.doesNotMatch(
    handlerBody,
    /requireString/,
    "handler must NOT call requireString — fleet_id is optional; optionalNonBlankString is the contract",
  );
  assert.doesNotMatch(
    handlerBody,
    /String\s*\(\s*fleet_id\s*\)/,
    "handler must NOT coerce fleet_id via String() — that is the stringified-filter-key defect",
  );
});
