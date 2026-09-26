/**
 * get_health MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `get_health` is the operator-facing
 * observability surface in the runtime-health family (src/index.ts
 * advertised schema at L1530-L1535 + handler at
 * toolHandlers["get_health"] L2579-L2581 on origin/main 8433dcb8). It
 * is published. 2026-09-09 feat/get-health-mcp-contract (a02b15ce) and
 * 2026-09-11 meshfleet/get-health-mcp-contract worktrees never landed
 * on origin/main. This card is a fresh origin/main pin with the
 * 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — {type:object, properties:{}} with NO
 *      required array and NO additionalProperties key (advertising
 *      false would be a lie; handler never reads args and has no
 *      requireAllowedKeys) + annotations {readOnlyHint:true,
 *      idempotentHint:true, destructiveHint:false, openWorldHint:false}
 *      + description phrases "Health report" and "ledger size" and
 *      "monitoring"
 *   2. empty-args call on a fresh ledger returns the closed 10-key
 *      HealthReport surface (status, uptime_ms, fleets, agents,
 *      messages, capabilities, events, abandoned_fleets, ledger_bytes,
 *      events_log_bytes) — last_event_timestamp is OPTIONAL and ABSENT
 *      on an empty log. No isError, no ok/error envelope, no
 *      loadData() map leak
 *   3. status field on a fresh healthy ledger is the literal string
 *      'ok' (not 'healthy', not 'alive', not 'warning'; the documented
 *      union is 'ok' | 'degraded' | 'error')
 *   4. counts are non-negative integers; uptime_ms is a finite integer
 *      >= 0 and < 60s on the first call of a just-spawned child
 *   5. two back-to-back calls: ledger counts + status identical
 *      (idempotentHint honored) and uptime_ms non-decreasing (handler
 *      reads Date.now() - PROCESS_START_MS at call time)
 *   6. advertised-vs-handler honesty — phantom top-level keys
 *      (force/reason/unexpected) are silently ignored AND no phantom
 *      keys leak into the response. This is HONEST: additionalProperties
 *      is not advertised, handler does not enforce it
 *   7. source-string pin — handler is jsonResult(getHealth()) with NO
 *      args destructure, NO try/catch, NO requireString/requireAllowedKeys,
 *      NO spawnFleet/wakeAgent/sendMessage/fetch, registered exactly
 *      once. getHealth() at src/health.ts returns a HealthReport whose
 *      status is 'ok' | 'degraded' | 'error'
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-get-health-mcp-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-get-health-${dir}`,
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
    { name: "get-health-contract-test", version: "1.0.0" },
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

const HEALTH_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const EMPTY_LEDGER_KEYS = [
  "abandoned_fleets",
  "agents",
  "capabilities",
  "events",
  "events_log_bytes",
  "fleets",
  "ledger_bytes",
  "messages",
  "status",
  "uptime_ms",
].sort();

const COUNT_KEYS = [
  "abandoned_fleets",
  "agents",
  "capabilities",
  "events",
  "fleets",
  "messages",
] as const;

function extractHandlerBlock(src: string): string {
  const match = src.match(/toolHandlers\["get_health"\][\s\S]*?^};/m);
  assert.ok(match, "get_health handler block must be extractable");
  return match[0];
}

// ─── Test 1: advertised schema + annotations + description honesty ───

test("get_health: advertised schema is empty-object with no required, no additionalProperties, four annotations, description names Health report + ledger size + monitoring", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "get_health");
    assert.ok(tool, "get_health must be advertised");

    // Empty-input contract. Handler at src/index.ts:2579-2581 never
    // reads args. Adding `verbose` / `force` would change every
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

    assert.deepEqual(tool!.annotations, HEALTH_ANNOTATIONS);

    const desc = tool!.description ?? "";
    assert.match(desc, /Health report/i);
    assert.match(desc, /ledger size/i);
    assert.match(desc, /monitoring/i);
    assert.doesNotMatch(
      desc,
      /write|mutate|delete|spawn/i,
      "read-only health description must not claim a write",
    );
  });
});

// ─── Test 2: empty-args call returns the closed 10-key HealthReport ───

test("get_health: empty-args call on a fresh ledger returns the closed 10-key HealthReport with no error envelope and no last_event_timestamp", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "get_health",
      arguments: {},
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `empty args must not be an isError envelope; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.deepEqual(
      Object.keys(body).sort(),
      EMPTY_LEDGER_KEYS,
      `response must have exactly the closed 10-key HealthReport; got: ${Object.keys(body).sort()}`,
    );
    assert.equal(body.status, "ok");
    assert.equal(typeof body.uptime_ms, "number");
    for (const k of COUNT_KEYS) {
      assert.equal(body[k], 0, `${k} must be 0 on an empty ledger`);
    }
    assert.equal(body.ok, undefined);
    assert.equal(body.error, undefined);
    assert.equal(body.last_event_seq, undefined);
    assert.equal(body.agents_by_fleet, undefined);
    assert.equal(
      "last_event_timestamp" in body,
      false,
      "last_event_timestamp must be absent on an empty ledger (optional in HealthReport)",
    );
  });
});

// ─── Test 3: status is the literal string 'ok' on a fresh ledger ───

test("get_health: status field on a fresh healthy ledger is the literal string 'ok' (not 'healthy', not 'alive', not 'warning')", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "get_health",
      arguments: {},
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `get_health must succeed for the enum pin; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.equal(
      body.status,
      "ok",
      `get_health status on a fresh ledger must be the literal string 'ok', got ${JSON.stringify(body.status)}`,
    );
    assert.notEqual(body.status, "healthy");
    assert.notEqual(body.status, "alive");
    assert.notEqual(body.status, "warning");
    assert.equal(typeof body.status, "string");
    assert.ok(
      (["ok", "degraded", "error"] as string[]).includes(body.status as string),
      `status enum must be exactly ok|degraded|error (got ${String(body.status)})`,
    );
  });
});

// ─── Test 4: counts are non-negative integers; uptime_ms is a finite integer ───

test("get_health: counts are non-negative integers and uptime_ms is a finite integer < 60s on first call of a just-spawned child", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "get_health",
      arguments: {},
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `get_health must succeed for the numeric pin; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    for (const k of [
      ...COUNT_KEYS,
      "ledger_bytes",
      "events_log_bytes",
      "uptime_ms",
    ] as const) {
      assert.equal(
        typeof body[k],
        "number",
        `${k} must be a number, got ${typeof body[k]}`,
      );
      assert.ok(
        Number.isFinite(body[k] as number),
        `${k} must be finite (not NaN/Infinity), got ${JSON.stringify(body[k])}`,
      );
      assert.ok(
        Number.isInteger(body[k] as number),
        `${k} must be an integer, got ${JSON.stringify(body[k])}`,
      );
      assert.ok(
        (body[k] as number) >= 0,
        `${k} must be non-negative, got ${JSON.stringify(body[k])}`,
      );
    }
    const uptime = body.uptime_ms as number;
    assert.ok(
      uptime < 60_000,
      `first-call uptime_ms must be < 60s (got ${uptime}) — a larger value suggests PROCESS_START_MS is stale`,
    );
    assert.equal(
      body.events_log_bytes,
      0,
      "events_log_bytes on no events file is 0 (not -1, which is the unreadable sentinel)",
    );
  });
});

// ─── Test 5: two back-to-back calls — counts identical, uptime non-decreasing ───

test("get_health: two back-to-back calls keep counts+status identical and produce a non-decreasing uptime_ms", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const r1 = await client.callTool({ name: "get_health", arguments: {} });
    await new Promise((r) => setTimeout(r, 25));
    const r2 = await client.callTool({ name: "get_health", arguments: {} });
    assert.notEqual(
      (r1 as ToolResponse).isError,
      true,
      `first get_health must succeed; got: ${textOf(r1)}`,
    );
    assert.notEqual(
      (r2 as ToolResponse).isError,
      true,
      `second get_health must succeed; got: ${textOf(r2)}`,
    );
    const b1 = bodyOf(r1);
    const b2 = bodyOf(r2);
    for (const k of COUNT_KEYS) {
      assert.equal(
        b1[k],
        b2[k],
        `${k} must be identical across two quiet calls (got ${String(b1[k])} then ${String(b2[k])})`,
      );
    }
    assert.equal(b1.status, b2.status);
    assert.equal(b1.status, "ok");
    const u1 = b1.uptime_ms as number;
    const u2 = b2.uptime_ms as number;
    assert.ok(
      u2 >= u1,
      `two back-to-back get_health calls must produce a non-decreasing uptime_ms: u1=${u1}, u2=${u2}`,
    );
    assert.deepEqual(
      Object.keys(b2).sort(),
      EMPTY_LEDGER_KEYS,
      `second get_health must still return the closed 10-key HealthReport; got: ${Object.keys(b2).sort()}`,
    );
  });
});

// ─── Test 6: phantom extra keys silently ignored (honesty) ───

test("get_health: phantom extra keys are silently ignored (additionalProperties not advertised, handler does not enforce)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "get_health",
      arguments: {
        force: "yes",
        reason: "phantom",
        unexpected: true,
        nested: { a: 1, b: [2, 3] },
        retry: 3,
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
      EMPTY_LEDGER_KEYS,
      `get_health with phantom args must STILL return the closed 10-key HealthReport; got: ${Object.keys(body).sort()}`,
    );
    assert.equal(body.status, "ok");
    assert.equal(body.force, undefined);
    assert.equal(body.reason, undefined);
    assert.equal(body.unexpected, undefined);
    assert.equal(body.nested, undefined);
    assert.equal(body.retry, undefined);
    assert.equal(body.note, undefined);
  });
});

// ─── Test 7: source-string pin ───

test("get_health: source-string pin — handler is jsonResult(getHealth()), no destructure/try/allowedKeys/spawn", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    const registrations = src.match(/toolHandlers\["get_health"\]/g) ?? [];
    assert.equal(
      registrations.length,
      1,
      `handler must be registered exactly once; got ${registrations.length}`,
    );

    const handlerBlock = extractHandlerBlock(src);
    assert.match(
      handlerBlock,
      /toolHandlers\["get_health"\]\s*=\s*async\s*\(\s*args\s*\)\s*=>\s*\{/,
    );
    assert.match(handlerBlock, /return\s+jsonResult\(\s*getHealth\(\)\s*\)\s*;/);
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
      /toolHandlers\["get_health"\]\s*=\s*async\s*\(\s*\{/,
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
      /name:\s*"get_health",[\s\S]*?inputSchema:\s*(\{[\s\S]*?\}),[\s\S]*?annotations:\s*(\{[\s\S]*?\})/,
    );
    assert.ok(schemaMatch, "advertised get_health schema block must be extractable");
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

    const health = readFileSync(join(repoRoot, "src", "health.ts"), "utf-8");
    assert.match(
      health,
      /export function getHealth\(\):\s*HealthReport\s*\{/,
    );
    assert.match(
      health,
      /status:\s*'ok'\s*\|\s*'degraded'\s*\|\s*'error'/,
    );
    assert.match(health, /abandoned_fleets:/);

    const response = await client.callTool({
      name: "get_health",
      arguments: {},
    });
    const body = bodyOf(response);
    assert.equal(body.status, "ok");
    assert.equal(typeof body.uptime_ms, "number");
  });
});
