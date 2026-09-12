/**
 * fleet_status MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `fleet_status` is the operator-facing
 * per-fleet status surface (src/index.ts advertised schema at L687-L694 +
 * handler at toolHandlers["fleet_status"] L1883-L1900 on origin/main
 * 8433dcb8). It is published. 2026-09-09 and 2026-09-11
 * fleet-status-mcp-contract worktrees never landed on origin/main.
 * This card is a fresh origin/main pin with the 2026-09-12 honesty
 * pattern:
 *
 *   1. advertised schema pin — {type:object, properties:{fleet_id:{type:string}},
 *      required:[fleet_id]} with NO additionalProperties key (advertising
 *      false would be a lie; handler has no requireAllowedKeys) +
 *      annotations {readOnlyHint:true, idempotentHint:true,
 *      destructiveHint:false, openWorldHint:false} + description
 *      "Check fleet and agent status."
 *   2. boundary validation — 8 non-string/missing/blank fleet_id shapes
 *      (missing, null, number, boolean, array, object, empty-string,
 *      whitespace-only) all return isError:true with
 *      /fleet_id.*non-empty string/ rejection text. A wrong-typed
 *      fleet_id must be NAMED, not shrugged into a lookup miss
 *      (the 2026 defect the handler comment documents).
 *   3. real-fleet response — createFleet + registerAgentInLedger seeded
 *      before child connects, response { fleet, agents } with fleet.id
 *      matching, fleet.status running, agents listing both seeded ids.
 *      JSON.stringify drops undefined; no isError/ok/error envelope.
 *   4. nonexistent-fleet response — { fleet: undefined, agents: [] }
 *      which JSON.stringify collapses to { agents: [] }.
 *   5. two back-to-back calls return structurally identical
 *      fleet+agents snapshots (idempotentHint honored).
 *   6. advertised-vs-handler honesty — phantom top-level keys
 *      (phantom_filter/debug_emit/future_field/force/nested/note) are
 *      silently ignored AND no phantom keys leak into the response.
 *      This is HONEST: additionalProperties is not advertised,
 *      handler does not enforce it.
 *   7. source-string pin — handler is checkRateLimit(ip, "read") then
 *      requireString("fleet_status","fleet_id",fleet_id) then
 *      jsonResult({ fleet, agents }) with NO try/catch, NO
 *      requireAllowedKeys, NO spawnFleet/wakeAgent/sendMessage/fetch,
 *      registered exactly once. Fleet interface at src/core.ts pins
 *      id/status/created_at.
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
  createFleet,
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-fleet-status-mcp-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-fleet-status-${dir}`,
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
    { name: "fleet-status-contract-test", version: "1.0.0" },
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

const FLEET_STATUS_ANNOTATIONS = {
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
  const match = src.match(/toolHandlers\["fleet_status"\][\s\S]*?^};/m);
  assert.ok(match, "fleet_status handler block must be extractable");
  return match[0];
}

function extractSchemaBlock(src: string): { schema: string; annotations: string } {
  const start = src.indexOf('name: "fleet_status"');
  assert.notEqual(start, -1, "advertised fleet_status schema block must be extractable");
  const window = src.slice(start, start + 700);
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
  const response = await client.callTool({ name: "fleet_status", arguments: args });
  assert.notEqual(
    (response as ToolResponse).isError,
    true,
    `fleet_status must succeed; got: ${textOf(response)}`,
  );
  return bodyOf(response);
}

// ─── Test 1: advertised schema + annotations + description honesty ───

test("fleet_status: advertised schema requires fleet_id string, no additionalProperties, four annotations, description names Check fleet and agent status", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "fleet_status");
    assert.ok(tool, "fleet_status must be advertised");

    assert.deepEqual(tool!.inputSchema, {
      type: "object",
      properties: { fleet_id: { type: "string" } },
      required: ["fleet_id"],
    });
    // Honesty: handler ignores extra keys and has no requireAllowedKeys.
    // Advertising additionalProperties:false would be a lie.
    assert.equal(
      "additionalProperties" in tool!.inputSchema,
      false,
      "additionalProperties must be ABSENT — handler never enforces it; advertising false would be a lie",
    );

    assert.deepEqual(tool!.annotations, FLEET_STATUS_ANNOTATIONS);

    const desc = tool!.description ?? "";
    assert.match(desc, /Check fleet and agent status/i);
    assert.doesNotMatch(
      desc,
      /write|mutate|delete|spawn/i,
      "read-only status description must not claim a write",
    );
  });
});

// ─── Test 2: boundary validation — missing / non-string / blank fleet_id ───

test("fleet_status: refuses missing / non-string / blank fleet_id with a named error (not a silent lookup miss)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const cases: ReadonlyArray<{
      label: string;
      args: Record<string, unknown>;
    }> = [
      { label: "missing fleet_id", args: {} },
      { label: "null fleet_id", args: { fleet_id: null } },
      { label: "number fleet_id", args: { fleet_id: 42 } },
      { label: "boolean fleet_id", args: { fleet_id: true } },
      { label: "array fleet_id", args: { fleet_id: ["f"] } },
      { label: "object fleet_id", args: { fleet_id: { id: "f" } } },
      { label: "empty-string fleet_id", args: { fleet_id: "" } },
      { label: "whitespace-only fleet_id", args: { fleet_id: "   \t " } },
    ];
    for (const { label, args } of cases) {
      const response = await client.callTool({
        name: "fleet_status",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be a tool error, not a silent lookup miss`,
      );
      assert.match(
        textOf(response),
        /fleet_id.*non-empty string/,
        `${label}: rejection text must name fleet_id; got: ${textOf(response)}`,
      );
    }
  });
});

// ─── Test 3: real fleet returns { fleet, agents } with seeded data ───

test("fleet_status: returns { fleet, agents } for a fleet with registered agents", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  createFleet("test-fleet-real");
  registerAgentInLedger(fixtureAgent("agent-a", "test-fleet-real"));
  registerAgentInLedger(fixtureAgent("agent-b", "test-fleet-real"));

  await withChildServer(fix, async (client) => {
    const result = await callOk(client, { fleet_id: "test-fleet-real" });
    assert.equal(typeof result.fleet, "object", "fleet must be an object");
    const fleet = result.fleet as Record<string, unknown>;
    assert.equal(fleet.id, "test-fleet-real");
    assert.equal(fleet.status, "running");
    assert.equal(typeof fleet.created_at, "number");

    const agents = result.agents as Array<Record<string, unknown>>;
    assert.equal(agents.length, 2, "both seeded agents must be returned");
    const ids = agents.map((a) => a.id).sort();
    assert.deepEqual(ids, ["agent-a", "agent-b"]);

    assert.equal(result.ok, undefined);
    assert.equal(result.error, undefined);
    const extraTop = Object.keys(result).filter(
      (k) => k !== "fleet" && k !== "agents",
    );
    assert.deepEqual(
      extraTop,
      [],
      `response must be exactly {fleet, agents}; extra: ${extraTop.join(",")}`,
    );
  });
});

// ─── Test 4: nonexistent fleet returns { fleet: undefined, agents: [] } ───

test("fleet_status: returns { fleet: undefined, agents: [] } for a nonexistent fleet", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const result = await callOk(client, { fleet_id: "no-such-fleet-xyz" });
    // data.fleets[fleet_id] is undefined; JSON.stringify drops the key,
    // so the parsed body is { agents: [] }.
    assert.equal(result.fleet, undefined, "fleet must be undefined/absent");
    assert.deepEqual(result.agents, []);
    assert.equal(result.ok, undefined);
    assert.equal(result.error, undefined);
  });
});

// ─── Test 5: two back-to-back calls are identical (idempotentHint) ───

test("fleet_status: two back-to-back calls return identical fleet+agents snapshots", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  createFleet("idempotent-fleet");
  registerAgentInLedger(fixtureAgent("agent-x", "idempotent-fleet"));

  await withChildServer(fix, async (client) => {
    const first = await callOk(client, { fleet_id: "idempotent-fleet" });
    const second = await callOk(client, { fleet_id: "idempotent-fleet" });
    assert.deepEqual(
      first,
      second,
      "two quiet fleet_status calls must return identical snapshots (idempotentHint)",
    );
    assert.equal((first.fleet as Record<string, unknown>).id, "idempotent-fleet");
    assert.equal((first.agents as Array<Record<string, unknown>>).length, 1);
  });
});

// ─── Test 6: phantom extra keys silently ignored (honesty) ───

test("fleet_status: phantom extra keys are silently ignored (additionalProperties not advertised, handler does not enforce)", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  createFleet("phantom-fleet");

  await withChildServer(fix, async (client) => {
    const result = await callOk(client, {
      fleet_id: "phantom-fleet",
      phantom_filter: "ignored",
      debug_emit: true,
      future_field: 42,
      force: "yes",
      nested: { a: 1 },
      note: "should be ignored",
    });
    assert.equal((result.fleet as Record<string, unknown>).id, "phantom-fleet");
    assert.deepEqual(result.agents, []);
    assert.equal(result.phantom_filter, undefined);
    assert.equal(result.debug_emit, undefined);
    assert.equal(result.future_field, undefined);
    assert.equal(result.force, undefined);
    assert.equal(result.nested, undefined);
    assert.equal(result.note, undefined);
    const extraTop = Object.keys(result).filter(
      (k) => k !== "fleet" && k !== "agents",
    );
    assert.deepEqual(
      extraTop,
      [],
      `phantom keys must NOT leak into the response; extra: ${extraTop.join(",")}`,
    );
  });
});

// ─── Test 7: source-string pin ───

test("fleet_status: source-string pin — checkRateLimit read gate + requireString fleet_id + jsonResult({fleet, agents}), no allowedKeys/spawn", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    const registrations = src.match(/toolHandlers\["fleet_status"\]/g) ?? [];
    assert.equal(
      registrations.length,
      1,
      `handler must be registered exactly once; got ${registrations.length}`,
    );

    const handlerBlock = extractHandlerBlock(src);
    assert.match(
      handlerBlock,
      /toolHandlers\["fleet_status"\]\s*=\s*async\s*\(\s*args\s*\)\s*=>\s*\{/,
    );
    assert.match(handlerBlock, /checkRateLimit\(\s*ip\s*,\s*"read"\s*\)/);
    assert.match(handlerBlock, /Read rate limit exceeded\. Slow down\./);
    assert.match(
      handlerBlock,
      /requireString\(\s*"fleet_status"\s*,\s*"fleet_id"\s*,\s*fleet_id\s*\)/,
    );
    assert.match(
      handlerBlock,
      /return\s+jsonResult\(\s*\{\s*fleet\s*,\s*agents\s*\}\s*\)\s*;/,
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
      /toolHandlers\["fleet_status"\]\s*=\s*async\s*\(\s*\{/,
      "handler must NOT destructure-cast args",
    );
    assert.doesNotMatch(
      handlerBlock,
      /\btry\s*\{/,
      "handler must NOT wrap its body in try/catch (would change isError semantics)",
    );

    const { schema, annotations } = extractSchemaBlock(src);
    assert.match(schema, /type:\s*"object"/);
    assert.match(schema, /fleet_id:\s*\{\s*type:\s*"string"\s*\}/);
    assert.match(schema, /required:\s*\[\s*"fleet_id"\s*\]/);
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
    const ifaceStart = core.indexOf("export interface Fleet {");
    assert.notEqual(ifaceStart, -1, "src/core.ts must export interface Fleet");
    const window = core.slice(ifaceStart, ifaceStart + 1200);
    const blockEnd = window.indexOf("\nexport ");
    const block = blockEnd === -1 ? window : window.slice(0, blockEnd);
    for (const field of ["id", "status", "created_at"]) {
      const present = block.includes(`${field}:`) || block.includes(`${field}?:`);
      assert.ok(
        present,
        `Fleet interface MUST define \`${field}:\`; block:\n${block.slice(0, 400)}`,
      );
    }

    const response = await client.callTool({
      name: "fleet_status",
      arguments: { fleet_id: "source-pin-empty" },
    });
    const body = bodyOf(response);
    assert.equal(body.fleet, undefined);
    assert.deepEqual(body.agents, []);
  });
});
