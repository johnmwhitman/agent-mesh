/**
 * list_fleets MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `list_fleets` is the operator-facing
 * fleet-inventory surface (src/index.ts advertised schema at L730-L736 +
 * handler at toolHandlers["list_fleets"] L1935-L1941 on origin/main
 * 8433dcb8). It is published. 2026-09-09 feat/list-fleets-mcp-contract
 * (7a96f8c5) never landed on origin/main. This card is a fresh
 * origin/main pin with the 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — {type:object, properties:{}} with NO
 *      required array and NO additionalProperties key (advertising
 *      false would be a lie; handler never reads args and has no
 *      requireAllowedKeys) + annotations {readOnlyHint:true,
 *      idempotentHint:true, destructiveHint:false, openWorldHint:false}
 *      + description phrases "List all fleets" and "summaries"
 *   2. empty-ledger surface returns exactly {fleets:[]} — the key is
 *      present even when empty, no isError, no ok/error/status envelope
 *   3. seeded FleetSummary shape — required keys id/status/created_at/
 *      agent_count/agents_complete/agents_failed/agents_running; optional
 *      completed_at (JSON.stringify drops undefined)
 *   4. counter roll-up — interrupted agents count in agent_count but
 *      NOT in agents_complete / agents_failed / agents_running
 *   5. two back-to-back calls return identical fleet summaries
 *      (idempotentHint honored)
 *   6. advertised-vs-handler honesty — phantom top-level keys
 *      (phantom_filter/debug_emit/future_field) are silently ignored
 *      AND no phantom keys leak into the response. This is HONEST:
 *      additionalProperties is not advertised, handler does not
 *      enforce it
 *   7. source-string pin — handler is checkRateLimit("read") then
 *      jsonResult({ fleets: listFleets() }) with NO args destructure,
 *      NO try/catch, NO requireString/requireAllowedKeys, NO
 *      spawnFleet/wakeAgent/sendMessage/fetch, registered exactly
 *      once. FleetSummary at src/core.ts pins the eight documented
 *      fields.
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

import { createFleet, registerAgentInLedger } from "../src/core.js";
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-list-fleets-mcp-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-list-fleets-${dir}`,
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
    { name: "list-fleets-contract-test", version: "1.0.0" },
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

const LIST_FLEETS_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const FLEET_SUMMARY_REQUIRED_KEYS = [
  "agent_count",
  "agents_complete",
  "agents_failed",
  "agents_running",
  "created_at",
  "id",
  "status",
];

function extractHandlerBlock(src: string): string {
  const match = src.match(/toolHandlers\["list_fleets"\][\s\S]*?^};/m);
  assert.ok(match, "list_fleets handler block must be extractable");
  return match[0];
}

function seedCounterFleet(): void {
  createFleet("f-counter");
  for (const [id, status] of [
    ["a1", "complete"],
    ["a2", "complete"],
    ["a3", "interrupted"],
    ["a4", "interrupted"],
    ["a5", "failed"],
  ] as const) {
    registerAgentInLedger({
      id,
      fleet_id: "f-counter",
      role: id,
      prompt: `prompt for ${id}`,
      status,
    });
  }
}

// ─── Test 1: advertised schema + annotations + description honesty ───

test("list_fleets: advertised schema is empty-object with no required, no additionalProperties, four annotations, description names List all fleets + summaries", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "list_fleets");
    assert.ok(tool, "list_fleets must be advertised");

    // Empty-input contract. Handler at src/index.ts:1935-1941 never
    // reads args. Adding `since` / `status_filter` would change every
    // dashboard that ships against "this tool takes no arguments".
    assert.equal(tool!.inputSchema.type, "object");
    assert.deepEqual(tool!.inputSchema.properties, {});
    assert.equal(
      "required" in tool!.inputSchema,
      false,
      "required must be absent (no documented required inputs); advertising [] is also empty but origin/main omits the key",
    );
    // Honesty: handler ignores extra keys and has no requireAllowedKeys.
    // Advertising additionalProperties:false would be a lie.
    assert.equal(
      "additionalProperties" in tool!.inputSchema,
      false,
      "additionalProperties must be ABSENT — handler never enforces it; advertising false would be a lie",
    );

    assert.deepEqual(tool!.annotations, LIST_FLEETS_ANNOTATIONS);

    const desc = tool!.description ?? "";
    assert.match(desc, /List all fleets/i);
    assert.match(desc, /summar/i);
    assert.doesNotMatch(
      desc,
      /write|mutate|delete|spawn/i,
      "read-only inventory description must not claim a write",
    );
  });
});

// ─── Test 2: empty ledger returns exactly {fleets:[]} ───

test("list_fleets: empty ledger returns exactly {fleets: []} with no error envelope", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "list_fleets",
      arguments: {},
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `empty ledger must not be an isError envelope; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.deepEqual(
      Object.keys(body).sort(),
      ["fleets"],
      `response must have exactly {fleets}; got: ${Object.keys(body).sort()}`,
    );
    assert.deepEqual(body.fleets, []);
    assert.equal(body.ok, undefined);
    assert.equal(body.error, undefined);
    assert.equal(body.status, undefined);
  });
});

// ─── Test 3: seeded FleetSummary shape ───

test("list_fleets: seeded fleet surfaces with the published FleetSummary required keys (completed_at optional)", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  createFleet("f-empty");
  createFleet("f-with-agents");
  registerAgentInLedger({
    id: "a1",
    fleet_id: "f-with-agents",
    role: "r1",
    prompt: "p1",
    status: "complete",
  });
  registerAgentInLedger({
    id: "a2",
    fleet_id: "f-with-agents",
    role: "r2",
    prompt: "p2",
    status: "failed",
  });
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "list_fleets",
      arguments: {},
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `seeded list_fleets must succeed; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.deepEqual(Object.keys(body).sort(), ["fleets"]);
    const fleets = body.fleets as Array<Record<string, unknown>>;
    assert.equal(fleets.length, 2, "two seeded fleets must surface");

    const empty = fleets.find((f) => f.id === "f-empty");
    const populated = fleets.find((f) => f.id === "f-with-agents");
    assert.ok(empty, "seeded f-empty must appear");
    assert.ok(populated, "seeded f-with-agents must appear");

    for (const fleet of [empty!, populated!]) {
      const keys = Object.keys(fleet);
      for (const field of FLEET_SUMMARY_REQUIRED_KEYS) {
        assert.ok(
          keys.includes(field),
          `FleetSummary MUST include \`${field}\`; got: ${keys.sort().join(",")}`,
        );
      }
      if (keys.includes("completed_at")) {
        assert.equal(
          typeof fleet.completed_at,
          "number",
          "optional completed_at if present must be a number ms-epoch",
        );
      }
      const extras = keys.filter(
        (k) =>
          !FLEET_SUMMARY_REQUIRED_KEYS.includes(k) && k !== "completed_at",
      );
      assert.deepEqual(
        extras,
        [],
        `FleetSummary must not leak extra keys; got: ${extras.join(",")}`,
      );
      assert.equal(typeof fleet.id, "string");
      assert.equal(typeof fleet.status, "string");
      assert.equal(typeof fleet.created_at, "number");
      assert.equal(typeof fleet.agent_count, "number");
      assert.ok(
        ["running", "complete", "failed", "abandoned"].includes(
          fleet.status as string,
        ),
        `status must be one of running|complete|failed|abandoned; got ${String(fleet.status)}`,
      );
    }

    assert.equal(empty!.agent_count, 0);
    assert.equal(empty!.agents_complete, 0);
    assert.equal(empty!.agents_failed, 0);
    assert.equal(empty!.agents_running, 0);
    assert.equal(populated!.agent_count, 2);
  });
});

// ─── Test 4: counter roll-up — interrupted counts in agent_count only ───

test("list_fleets: per-fleet counters roll up; interrupted counts in agent_count only", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  seedCounterFleet();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "list_fleets",
      arguments: {},
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `counter list_fleets must succeed; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    const fleets = body.fleets as Array<Record<string, unknown>>;
    const target = fleets.find((f) => f.id === "f-counter");
    assert.ok(target, "f-counter must appear in list_fleets output");
    // Four buckets in src/core.ts:777-794:
    //   agents_running  <- status === "running"
    //   agents_complete <- status === "complete"
    //   agents_failed   <- status === "failed"
    // Anything else (pending, interrupted) does NOT count in those
    // three buckets but DOES count in agent_count.
    assert.equal(target!.agent_count, 5, "agent_count must be 5 (interrupted counts)");
    assert.equal(
      target!.agents_complete,
      2,
      `agents_complete must be 2 (a1, a2 only); got ${JSON.stringify(target!)}`,
    );
    assert.equal(target!.agents_failed, 1, "agents_failed must be 1 (a5 only)");
    assert.equal(
      target!.agents_running,
      0,
      "agents_running must be 0 (no agent was seeded as running)",
    );
  });
});

// ─── Test 5: two back-to-back calls are identical (idempotentHint) ───

test("list_fleets: two back-to-back calls return identical fleet summaries", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  seedCounterFleet();
  await withChildServer(fix, async (client) => {
    const r1 = await client.callTool({ name: "list_fleets", arguments: {} });
    const r2 = await client.callTool({ name: "list_fleets", arguments: {} });
    assert.notEqual(
      (r1 as ToolResponse).isError,
      true,
      `first list_fleets must succeed; got: ${textOf(r1)}`,
    );
    assert.notEqual(
      (r2 as ToolResponse).isError,
      true,
      `second list_fleets must succeed; got: ${textOf(r2)}`,
    );
    const b1 = bodyOf(r1);
    const b2 = bodyOf(r2);
    assert.deepEqual(
      b1,
      b2,
      "two quiet list_fleets calls must return identical summaries (idempotentHint)",
    );
    assert.deepEqual(Object.keys(b2).sort(), ["fleets"]);
  });
});

// ─── Test 6: phantom extra keys silently ignored (honesty) ───

test("list_fleets: phantom extra keys are silently ignored (additionalProperties not advertised, handler does not enforce)", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  seedCounterFleet();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "list_fleets",
      arguments: {
        phantom_filter: "ignored",
        debug_emit: true,
        future_field: 42,
        force: "yes",
        nested: { a: 1 },
        note: "should be ignored",
      },
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `phantom keys must NOT error; advertising additionalProperties:false would be a lie. got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.deepEqual(
      Object.keys(body).sort(),
      ["fleets"],
      `list_fleets with phantom args must STILL return exactly {fleets}; got: ${Object.keys(body).sort()}`,
    );
    const fleets = body.fleets as Array<Record<string, unknown>>;
    assert.equal(fleets.length, 1);
    assert.equal(fleets[0]!.id, "f-counter");
    assert.equal(body.phantom_filter, undefined);
    assert.equal(body.debug_emit, undefined);
    assert.equal(body.future_field, undefined);
    assert.equal(body.force, undefined);
    assert.equal(body.nested, undefined);
    assert.equal(body.note, undefined);
  });
});

// ─── Test 7: source-string pin ───

test("list_fleets: source-string pin — handler is checkRateLimit then jsonResult({fleets: listFleets()}), no destructure/try/allowedKeys/spawn", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    const registrations = src.match(/toolHandlers\["list_fleets"\]/g) ?? [];
    assert.equal(
      registrations.length,
      1,
      `handler must be registered exactly once; got ${registrations.length}`,
    );

    const handlerBlock = extractHandlerBlock(src);
    assert.match(
      handlerBlock,
      /toolHandlers\["list_fleets"\]\s*=\s*async\s*\(\s*args\s*\)\s*=>\s*\{/,
    );
    assert.match(handlerBlock, /checkRateLimit\(\s*ip\s*,\s*"read"\s*\)/);
    assert.match(handlerBlock, /Read rate limit exceeded\./);
    assert.match(
      handlerBlock,
      /return\s+jsonResult\(\s*\{\s*fleets:\s*listFleets\(\)\s*\}\s*\)\s*;/,
    );
    assert.doesNotMatch(
      handlerBlock,
      /requireAllowedKeys/,
      "handler must NOT enforce additionalProperties (advertising false would be a lie)",
    );
    assert.doesNotMatch(handlerBlock, /requireString|requireBoolean/);
    assert.doesNotMatch(
      handlerBlock,
      /spawnFleet|wakeAgent|sendMessage|fetch\(/,
    );
    assert.doesNotMatch(
      handlerBlock,
      /toolHandlers\["list_fleets"\]\s*=\s*async\s*\(\s*\{/,
      "handler must NOT destructure-cast args",
    );
    assert.doesNotMatch(
      handlerBlock,
      /\btry\s*\{/,
      "handler must NOT wrap its body in try/catch (would change isError semantics)",
    );
    assert.doesNotMatch(
      handlerBlock,
      /\bargs\./,
      "handler body must not read any field off args",
    );

    const schemaMatch = src.match(
      /name:\s*"list_fleets",[\s\S]*?inputSchema:\s*(\{[\s\S]*?\}),[\s\S]*?annotations:\s*(\{[\s\S]*?\})/,
    );
    assert.ok(schemaMatch, "advertised list_fleets schema block must be extractable");
    assert.match(schemaMatch[1]!, /type:\s*"object"/);
    assert.match(schemaMatch[1]!, /properties:\s*\{\s*\}/);
    assert.doesNotMatch(
      schemaMatch[1]!,
      /additionalProperties/,
      "advertised schema must NOT carry additionalProperties (handler does not enforce it)",
    );
    assert.match(schemaMatch[2]!, /readOnlyHint:\s*true/);
    assert.match(schemaMatch[2]!, /idempotentHint:\s*true/);
    assert.match(schemaMatch[2]!, /destructiveHint:\s*false/);
    assert.match(schemaMatch[2]!, /openWorldHint:\s*false/);

    const core = readFileSync(join(repoRoot, "src", "core.ts"), "utf-8");
    const ifaceStart = core.indexOf("export interface FleetSummary");
    assert.notEqual(ifaceStart, -1, "src/core.ts must export interface FleetSummary");
    const window = core.slice(ifaceStart, ifaceStart + 800);
    const blockEnd = window.indexOf("}");
    assert.notEqual(blockEnd, -1, "FleetSummary block must close");
    const block = window.slice(0, blockEnd + 1);
    for (const field of [
      "id",
      "status",
      "created_at",
      "completed_at",
      "agent_count",
      "agents_complete",
      "agents_failed",
      "agents_running",
    ]) {
      const present =
        block.includes(`${field}:`) || block.includes(`${field}?:`);
      assert.ok(
        present,
        `FleetSummary interface MUST define \`${field}:\` (or \`${field}?:\` when optional); block:\n${block}`,
      );
    }
    assert.match(core, /export function listFleets\(\):\s*FleetSummary\[\]/);

    const response = await client.callTool({
      name: "list_fleets",
      arguments: {},
    });
    const body = bodyOf(response);
    assert.deepEqual(body.fleets, []);
  });
});
