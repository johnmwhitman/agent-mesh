/**
 * route_work MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names. Honesty-pattern refresh (2026-09-12).
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `route_work` is the highest-traffic READ
 * path in the routing stack: every external caller (conductor, peer lanes,
 * dashboards) uses it to pick which agent should answer a request
 * (src/index.ts advertised schema at L973-L989 + handler at
 * toolHandlers["route_work"] L2460-L2471 on origin/main 8433dcb8). The
 * 2026-09-09 worktree never landed on origin/main. origin/main already
 * ships test/route-work.test.ts (core scorer: default top_n, ranking,
 * empty-n, ties) plus enrichment/weighting-order files, but those do NOT
 * pin advertised-vs-handler honesty: additionalProperties absence, the
 * four annotations together, phantom extra keys, source-string shape, or
 * the named bug class (non-string description reaching tokenize().toLowerCase()
 * and escaping as a protocol-level fault). This card is a fresh origin/main
 * pin with the 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — two named fields (description string,
 *      top_n number default=1 minimum=1) + required=["description"] +
 *      NO additionalProperties key (advertising false would be a lie;
 *      handler has no requireAllowedKeys) + annotations
 *      {readOnlyHint:true, idempotentHint:true, destructiveHint:false,
 *      openWorldHint:false} + description names "Route a work
 *      description" / "keyword" / "top_n".
 *   2. wire-boundary refusal of the REQUIRED description field — every
 *      non-string shape (missing, empty, whitespace, null, number,
 *      boolean, array, object) returns isError naming route_work +
 *      description. The SDK does NOT enforce required; the handler's
 *      requireString is the real gate. A drop of that gate would let
 *      {description: undefined} reach tokenize().toLowerCase() — the
 *      original protocol-fault defect (src/index.ts:2462-2464).
 *   3. named tokenize-protocol-fault class — a truthy non-string
 *      description (42 / true / [] / {}) MUST surface as a readable
 *      isError envelope naming description, NEVER as a JSON-RPC-level
 *      crash / missing content[0].
 *   4. optional top_n honesty — optionalNumber checks TYPENESS not
 *      RANGE despite advertised minimum:1. top_n:"three" / true /
 *      "1" are refused naming finite number; top_n:0 and top_n:-1
 *      are NOT refused — they reach routeWork() where `if (topN <= 0)
 *      return []` short-circuits to a well-formed {matches:[]} success.
 *      Tightening the runtime to also enforce minimum:1 would break
 *      that measured empty-success path.
 *   5. happy-path envelope — well-formed call against an empty ledger
 *      returns EXACTLY {matches:[]} (one-key shape); after a
 *      register_capability write, route_work ranks the new agent
 *      (write→read round-trip) with match items carrying agent_id /
 *      score / role (weight optional).
 *   6. advertised-vs-handler honesty — phantom top-level keys
 *      (phantom_filter/debug_emit/future_field/force/nested/note) are
 *      silently ignored AND no phantom keys leak into the response.
 *      This is HONEST: additionalProperties is not advertised, handler
 *      does not enforce it (no requireAllowedKeys).
 *   7. source-string pin — handler destructure-casts
 *      `const { description, top_n } = args as {…}` then
 *      `firstError(requireString("route_work","description",description),
 *      optionalNumber("route_work","top_n",top_n))` then
 *      `return jsonResult({ matches: routeWork(description, top_n ?? 1) })`
 *      with NO try/catch, NO requireAllowedKeys, NO spawnFleet/wakeAgent/
 *      fetch, registered exactly once.
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * WRITE-ISOLATION LAW: register_capability (used in the happy-path
 * round-trip) writes to the ledger. Every run that opens a child sets
 * ALL THREE of MESHFLEET_DB_FILE, MESHFLEET_DATA_FILE,
 * MESHFLEET_EVENT_LOG_FILE to temp paths — never the live
 * ~/.config/opencode/agent-mesh.db.
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

const isErrorEnvelope = (r: unknown): boolean =>
  (r as ToolResponse).isError === true;
const errorText = (r: unknown): string => textOf(r);

type Fixture = {
  dir: string;
  dataFile: string;
  dbFile: string;
  eventsFile: string;
};

function makeFixture(): Fixture {
  const dir = mkdtempSync(
    join(tmpdir(), "meshfleet-route-work-mcp-20260912-"),
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-route-work-20260912-${dir}`,
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
 * applyFixtureEnv MUST be called BEFORE any parent-side ledger write so
 * the cached better-sqlite3 handle inside src/db.ts opens against the
 * tempdir, not the live ~/.config/opencode/agent-mesh.db (which is on
 * storage_schema_version=5 and would raise unsupported-newer-schema).
 * HOME points at the tempdir so any discoverPremadeAgents() call the
 * handler chain hits cannot fail from a missing HOME.
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
    { name: "route-work-contract-test", version: "1.0.0" },
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

const ROUTE_WORK_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

function extractHandlerBlock(src: string): string {
  const match = src.match(/toolHandlers\["route_work"\][\s\S]*?^};/m);
  assert.ok(match, "route_work handler block must be extractable");
  return match[0];
}

function extractSchemaBlock(src: string): {
  schema: string;
  annotations: string;
  description: string;
} {
  const start = src.indexOf('name: "route_work"');
  assert.notEqual(
    start,
    -1,
    "advertised route_work schema block must be extractable",
  );
  const window = src.slice(start, start + 1400);
  const descStart = window.indexOf("description:");
  const schemaStart = window.indexOf("inputSchema:");
  const annotationsStart = window.indexOf("annotations:");
  assert.ok(
    descStart >= 0 && schemaStart > descStart && annotationsStart > schemaStart,
    "description + inputSchema + annotations must follow name",
  );
  return {
    description: window.slice(descStart, schemaStart),
    schema: window.slice(schemaStart, annotationsStart),
    annotations: window.slice(annotationsStart, annotationsStart + 220),
  };
}

async function callRaw(
  client: Client,
  args: Record<string, unknown>,
) {
  return client.callTool({ name: "route_work", arguments: args });
}

async function callOk(
  client: Client,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await callRaw(client, args);
  assert.notEqual(
    isErrorEnvelope(response),
    true,
    `route_work must succeed; got: ${textOf(response)}`,
  );
  return bodyOf(response);
}

// ─── Test 1: advertised schema + annotations + description honesty ───

test("route_work: advertised schema pins description+top_n, required=[description], no additionalProperties, four annotations with readOnlyHint=true, description names Route/keyword/top_n", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "route_work");
    assert.ok(tool, "route_work must be advertised");

    const schema = tool!.inputSchema as Record<string, unknown>;
    assert.equal(schema.type, "object");
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.equal(props.description.type, "string");
    assert.equal(props.top_n.type, "number");
    assert.equal(props.top_n.default, 1);
    assert.equal(props.top_n.minimum, 1);
    assert.equal(
      props.top_n.description,
      "Maximum number of matches to return (default 1).",
    );
    assert.deepEqual(schema.required, ["description"]);
    // Honesty: handler ignores extra keys and has no requireAllowedKeys.
    // Advertising additionalProperties:false would be a lie.
    assert.equal(
      "additionalProperties" in schema,
      false,
      "root additionalProperties must be ABSENT — handler never enforces it; advertising false would be a lie",
    );

    assert.deepEqual(tool!.annotations, ROUTE_WORK_ANNOTATIONS);
    assert.equal(
      tool!.annotations?.readOnlyHint,
      true,
      "route_work only loadData-scores — readOnlyHint must be true (the named lie class if flipped)",
    );
    assert.equal(
      tool!.annotations?.idempotentHint,
      true,
      "identical description+top_n is a pure re-score — idempotentHint must be true",
    );

    const desc = tool!.description ?? "";
    assert.match(desc, /Route a work description/);
    assert.match(desc, /keyword/);
    assert.match(desc, /top_n/);
  });
});

// ─── Test 2: wire-boundary refusal of REQUIRED description ───

test("route_work: every non-string shape for description is refused as an isError envelope naming route_work + description", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const badShapes: ReadonlyArray<{ label: string; value: unknown }> = [
      { label: "missing", value: undefined },
      { label: "empty", value: "" },
      { label: "whitespace", value: "   " },
      { label: "null", value: null },
      { label: "number", value: 42 },
      { label: "boolean", value: true },
      { label: "array", value: [] },
      { label: "object", value: {} },
    ];
    for (const { label, value } of badShapes) {
      const args: Record<string, unknown> = {};
      if (value !== undefined) args.description = value;
      const r = await callRaw(client, args);
      assert.equal(
        isErrorEnvelope(r),
        true,
        `description=${label} (${JSON.stringify(value)}) must be an error envelope`,
      );
      const t = errorText(r);
      assert.match(t, /route_work/, "error must name the tool");
      assert.match(
        t,
        /description/,
        `error must name the field description; got: ${t}`,
      );
      assert.doesNotMatch(
        t,
        /"matches"\s*:/,
        `description=${label}: a wrong-typed required string must NOT bank a matches envelope; got: ${t}`,
      );
    }
  });
});

// ─── Test 3: named tokenize-protocol-fault class ───

test("route_work: truthy non-string description surfaces as a readable isError envelope, NEVER as a JSON-RPC-level crash (the tokenize().toLowerCase() protocol-fault class)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    for (const value of [42, true, ["review"], { text: "review" }]) {
      const r = await callRaw(client, { description: value });
      // Must be a TOOL error envelope, not a transport/protocol fault.
      assert.equal(
        isErrorEnvelope(r),
        true,
        `description=${JSON.stringify(value)} must surface as isError, not a protocol crash`,
      );
      const content = (r as ToolResponse).content;
      assert.ok(
        Array.isArray(content) && content.length >= 1 && typeof content[0]?.text === "string",
        `description=${JSON.stringify(value)} must carry readable content[0].text; a missing body is the original protocol-fault regression`,
      );
      assert.match(content[0]!.text, /description/);
      assert.match(content[0]!.text, /route_work/);
    }
  });
});

// ─── Test 4: optional top_n honesty (TYPENESS not RANGE) ───

test("route_work: top_n non-number is refused naming finite number; top_n:0 and top_n:-1 are well-formed {matches:[]} (advertised minimum:1 is NOT runtime-enforced)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    for (const value of ["three", true, "1"]) {
      const r = await callRaw(client, {
        description: "review the diff",
        top_n: value,
      });
      assert.equal(
        isErrorEnvelope(r),
        true,
        `top_n=${JSON.stringify(value)} must be an error envelope`,
      );
      const t = errorText(r);
      assert.match(t, /route_work/);
      assert.match(t, /top_n/);
      assert.match(t, /finite number/);
    }

    // Measured contract: advertised minimum:1 is NOT a runtime gate.
    // routeWork() short-circuits `if (topN <= 0) return []`.
    for (const n of [0, -1]) {
      const body = await callOk(client, {
        description: "review the diff",
        top_n: n,
      });
      assert.deepEqual(
        Object.keys(body).sort(),
        ["matches"],
        `top_n=${n} must still be a one-key success, got keys ${JSON.stringify(Object.keys(body).sort())}`,
      );
      assert.deepEqual(
        body.matches,
        [],
        `top_n=${n} must short-circuit to matches=[] (range is NOT refused); got ${JSON.stringify(body)}`,
      );
    }
  });
});

// ─── Test 5: happy-path envelope + register_capability round-trip ───

test("route_work: empty ledger returns EXACTLY {matches:[]}; after register_capability, route_work ranks the new agent with agent_id/score/role", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const empty = await callOk(client, {
      description: "review the diff and write a verdict",
    });
    assert.deepEqual(
      Object.keys(empty).sort(),
      ["matches"],
      `empty-ledger success must contain EXACTLY matches — no phantom top-level keys, got ${JSON.stringify(Object.keys(empty).sort())}`,
    );
    assert.deepEqual(
      empty.matches,
      [],
      "an empty ledger returns matches=[]; a regression that raised would break every fresh-fleet first-call",
    );

    const registered = await client.callTool({
      name: "register_capability",
      arguments: {
        agent_id: "writer-1",
        fleet_id: "fleet-w",
        role: "router",
        skills: ["typescript", "agent-mesh"],
      },
    });
    assert.notEqual(
      isErrorEnvelope(registered),
      true,
      `register_capability must succeed so the round-trip can rank, got ${textOf(registered)}`,
    );

    const routed = await callOk(client, {
      description: "agent mesh typescript dispatch",
    });
    assert.deepEqual(
      Object.keys(routed).sort(),
      ["matches"],
      `ranked success must still be EXACTLY {matches}, got keys ${JSON.stringify(Object.keys(routed).sort())}`,
    );
    const matches = routed.matches as Array<Record<string, unknown>>;
    assert.ok(
      Array.isArray(matches) && matches.length >= 1,
      `route_work must return at least one match for the registered agent, got ${JSON.stringify(routed)}`,
    );
    assert.equal(
      matches[0]?.agent_id,
      "writer-1",
      `writer-1 must rank first on a description matching role/skills, got ${JSON.stringify(matches[0])}`,
    );
    assert.equal(typeof matches[0]?.score, "number");
    assert.equal(matches[0]?.role, "router");
    assert.ok(
      Number.isFinite(matches[0]?.score as number) &&
        (matches[0]?.score as number) > 0,
      `score must be a positive finite number, got ${JSON.stringify(matches[0])}`,
    );
  });
});

// ─── Test 6: phantom extra keys silently ignored (honesty) ───

test("route_work: phantom top-level args are silently ignored, success shape is unchanged (additionalProperties not advertised, handler does not enforce)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const r = await callRaw(client, {
      description: "review the diff",
      phantom_filter: "ignored",
      debug_emit: true,
      future_field: 42,
      force: "yes",
      nested: { a: 1 },
      note: "phantom",
    });
    assert.notEqual(
      isErrorEnvelope(r),
      true,
      `phantom args must NOT be refused, got ${JSON.stringify(r)}`,
    );
    const body = bodyOf(r);
    assert.deepEqual(
      Object.keys(body).sort(),
      ["matches"],
      `phantom args must NOT change the success shape, got keys ${JSON.stringify(Object.keys(body).sort())}`,
    );
    assert.equal(body.phantom_filter, undefined);
    assert.equal(body.debug_emit, undefined);
    assert.equal(body.future_field, undefined);
    assert.equal(body.force, undefined);
    assert.equal(body.nested, undefined);
    assert.equal(body.note, undefined);
    assert.ok(Array.isArray(body.matches));
  });
});

// ─── Test 7: source-string pin ───

test("route_work: source-string pin — handler destructures description+top_n, requireString+optionalNumber, returns jsonResult({matches: routeWork(description, top_n ?? 1)}), no requireAllowedKeys", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    const registrations = src.match(/toolHandlers\["route_work"\]/g) ?? [];
    assert.equal(
      registrations.length,
      1,
      `handler must be registered exactly once; got ${registrations.length}`,
    );

    const handlerBlock = extractHandlerBlock(src);
    assert.match(
      handlerBlock,
      /toolHandlers\["route_work"\]\s*=\s*async\s*\(\s*args\s*\)\s*=>\s*\{/,
    );
    assert.ok(
      /const\s*\{\s*description\s*,\s*top_n\s*\}\s*=\s*args/.test(handlerBlock),
      `handler must explicitly destructure description+top_n — block=${JSON.stringify(handlerBlock.slice(0, 600))}`,
    );
    assert.ok(
      /requireString\(\s*"route_work"\s*,\s*"description"\s*,\s*description\s*\)/.test(
        handlerBlock,
      ),
      `handler must call requireString("route_work", "description", description) — the tokenize() protocol-fault gate`,
    );
    assert.ok(
      /optionalNumber\(\s*"route_work"\s*,\s*"top_n"\s*,\s*top_n\s*\)/.test(
        handlerBlock,
      ),
      `handler must call optionalNumber("route_work", "top_n", top_n)`,
    );
    assert.ok(
      /return\s+jsonResult\(\s*\{\s*matches:\s*routeWork\(\s*description\s*,\s*top_n\s*\?\?\s*1\s*\)\s*\}\s*\)/.test(
        handlerBlock,
      ),
      `handler must end with return jsonResult({ matches: routeWork(description, top_n ?? 1) }), block=${JSON.stringify(handlerBlock)}`,
    );
    assert.doesNotMatch(
      handlerBlock,
      /requireAllowedKeys/,
      "handler must NOT enforce additionalProperties (advertising false would be a lie)",
    );
    assert.doesNotMatch(
      handlerBlock,
      /try\s*\{/,
      "handler must NOT wrap routeWork in try/catch — requireString is the readable-error gate",
    );
    assert.doesNotMatch(
      handlerBlock,
      /spawnFleet|wakeAgent|fetch\(/,
      "handler must NOT call spawnFleet/wakeAgent/fetch",
    );

    const { schema, annotations, description } = extractSchemaBlock(src);
    assert.match(schema, /type:\s*"object"/);
    assert.match(schema, /description:\s*\{\s*type:\s*"string"\s*\}/);
    assert.match(schema, /top_n:\s*\{/);
    assert.match(schema, /type:\s*"number"/);
    assert.match(schema, /default:\s*1/);
    assert.match(schema, /minimum:\s*1/);
    assert.match(schema, /required:\s*\[\s*"description"\s*\]/);
    assert.doesNotMatch(
      schema,
      /additionalProperties/,
      "advertised ROOT schema must NOT carry additionalProperties (handler does not enforce it)",
    );
    assert.match(annotations, /readOnlyHint:\s*true/);
    assert.match(annotations, /idempotentHint:\s*true/);
    assert.match(annotations, /destructiveHint:\s*false/);
    assert.match(annotations, /openWorldHint:\s*false/);
    assert.match(description, /Route a work description/);
    assert.match(description, /keyword/);
    assert.match(description, /top_n/);

    // Live wire still refuses a missing description after the source pin.
    const response = await callRaw(client, {});
    assert.equal(isErrorEnvelope(response), true);
    assert.match(textOf(response), /route_work/);
    assert.match(textOf(response), /description/);
  });
});
