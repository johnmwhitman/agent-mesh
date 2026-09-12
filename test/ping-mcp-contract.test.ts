/**
 * ping MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `ping` is the smallest liveness surface
 * in the runtime-health family (src/index.ts advertised schema at
 * L1526-L1529 + handler at toolHandlers["ping"] L2609-L2611 on
 * origin/main 8433dcb8). It is published. 2026-09-09 feat/ping-mcp-contract
 * (99e7c89a) and 2026-09-11 meshfleet/ping-mcp-contract (39910809)
 * worktrees never landed. This card is a fresh origin/main pin with the
 * 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — {type:object, properties:{}} with NO
 *      required array and NO additionalProperties key (advertising
 *      false would be a lie; handler never reads args and has no
 *      requireAllowedKeys) + annotations {readOnlyHint:true,
 *      idempotentHint:true, destructiveHint:false, openWorldHint:false}
 *      + description phrases "Minimal liveness" and "{ status: 'ok', timestamp }"
 *   2. empty-args call returns EXACTLY {status:'ok', timestamp:<number>}
 *      — both keys present, no isError, no ok/error/uptime_ms envelope
 *   3. status field is the literal string 'ok' (not 'healthy', not
 *      'alive', not truthy-checked)
 *   4. timestamp is a finite integer tracking wall-clock at call time
 *      (now-1000 <= ts <= now+1000)
 *   5. two back-to-back calls produce a non-decreasing timestamp
 *      (handler reads Date.now() at call time, not at module load)
 *   6. advertised-vs-handler honesty — phantom top-level keys
 *      (force/reason/unexpected) are silently ignored AND no phantom
 *      keys leak into the response. This is HONEST: additionalProperties
 *      is not advertised, handler does not enforce it
 *   7. source-string pin — handler is jsonResult(ping()) with NO args
 *      destructure, NO try/catch, NO requireString/requireAllowedKeys,
 *      NO spawnFleet/wakeAgent/sendMessage/fetch, registered exactly
 *      once. ping() at src/health.ts returns {status:'ok', timestamp:Date.now()}
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-ping-mcp-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-ping-${dir}`,
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
    { name: "ping-contract-test", version: "1.0.0" },
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

const PING_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

function extractHandlerBlock(src: string): string {
  const match = src.match(/toolHandlers\["ping"\][\s\S]*?^};/m);
  assert.ok(match, "ping handler block must be extractable");
  return match[0];
}

// ─── Test 1: advertised schema + annotations + description honesty ───

test("ping: advertised schema is empty-object with no required, no additionalProperties, four annotations, description names liveness + { status: 'ok', timestamp }", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "ping");
    assert.ok(tool, "ping must be advertised");

    // Empty-input contract. Handler at src/index.ts:2609-2611 never
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

    assert.deepEqual(tool!.annotations, PING_ANNOTATIONS);

    const desc = tool!.description ?? "";
    assert.match(desc, /Minimal liveness/i);
    assert.match(desc, /\{\s*status:\s*'ok',\s*timestamp\s*\}/);
    assert.doesNotMatch(
      desc,
      /write|mutate|delete|spawn/i,
      "read-only liveness description must not claim a write",
    );
  });
});

// ─── Test 2: empty-args call returns EXACTLY {status:'ok', timestamp:<number>} ───

test("ping: empty-args call returns EXACTLY {status:'ok', timestamp:<number>} with no error envelope", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "ping",
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
      ["status", "timestamp"],
      `response must have exactly {status, timestamp}; got: ${Object.keys(body).sort()}`,
    );
    assert.equal(body.status, "ok");
    assert.equal(typeof body.timestamp, "number");
    assert.equal(body.ok, undefined);
    assert.equal(body.error, undefined);
    assert.equal(body.uptime_ms, undefined);
  });
});

// ─── Test 3: status is the literal string 'ok' ───

test("ping: status field is the literal string 'ok' (not 'healthy', not 'alive', not truthy-checked)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "ping",
      arguments: {},
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `ping must succeed for the enum pin; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.equal(
      body.status,
      "ok",
      `ping status must be the literal string 'ok', got ${JSON.stringify(body.status)}`,
    );
    assert.notEqual(body.status, "healthy");
    assert.notEqual(body.status, "alive");
    assert.equal(typeof body.status, "string");
  });
});

// ─── Test 4: timestamp is a finite integer tracking wall-clock ───

test("ping: timestamp is a finite integer within 1s of the caller's wall-clock", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const beforeMs = Date.now();
    const response = await client.callTool({
      name: "ping",
      arguments: {},
    });
    const afterMs = Date.now();
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `ping must succeed for the timestamp window check; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.equal(
      typeof body.timestamp,
      "number",
      `ping timestamp must be a number, got ${typeof body.timestamp}`,
    );
    assert.ok(
      Number.isFinite(body.timestamp as number),
      `ping timestamp must be finite (not NaN/Infinity), got ${JSON.stringify(body.timestamp)}`,
    );
    assert.ok(
      Number.isInteger(body.timestamp as number),
      `ping timestamp must be an integer (milliseconds since epoch), got ${JSON.stringify(body.timestamp)}`,
    );
    const ts = body.timestamp as number;
    assert.ok(
      ts >= beforeMs - 1000 && ts <= afterMs + 1000,
      `ping timestamp must track wall-clock at call time: before=${beforeMs}, after=${afterMs}, ts=${ts}`,
    );
  });
});

// ─── Test 5: two back-to-back calls produce a non-decreasing timestamp ───

test("ping: two back-to-back calls produce a non-decreasing timestamp (handler reads Date.now() at call time, not at module load)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const r1 = await client.callTool({ name: "ping", arguments: {} });
    const r2 = await client.callTool({ name: "ping", arguments: {} });
    assert.notEqual(
      (r1 as ToolResponse).isError,
      true,
      `first ping must succeed; got: ${textOf(r1)}`,
    );
    assert.notEqual(
      (r2 as ToolResponse).isError,
      true,
      `second ping must succeed; got: ${textOf(r2)}`,
    );
    const b1 = bodyOf(r1);
    const b2 = bodyOf(r2);
    const ts1 = b1.timestamp as number;
    const ts2 = b2.timestamp as number;
    assert.ok(
      ts2 >= ts1,
      `two back-to-back pings must produce a non-decreasing timestamp: ts1=${ts1}, ts2=${ts2}`,
    );
    assert.deepEqual(
      Object.keys(b2).sort(),
      ["status", "timestamp"],
      `second ping must still return EXACTLY {status, timestamp}; got: ${Object.keys(b2).sort()}`,
    );
    assert.equal(b1.status, "ok");
    assert.equal(b2.status, "ok");
  });
});

// ─── Test 6: phantom extra keys silently ignored (honesty) ───

test("ping: phantom extra keys are silently ignored (additionalProperties not advertised, handler does not enforce)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "ping",
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
      ["status", "timestamp"],
      `ping with phantom args must STILL return EXACTLY {status, timestamp}; got: ${Object.keys(body).sort()}`,
    );
    assert.equal(body.status, "ok");
    assert.equal(typeof body.timestamp, "number");
    assert.equal(body.force, undefined);
    assert.equal(body.reason, undefined);
    assert.equal(body.unexpected, undefined);
  });
});

// ─── Test 7: source-string pin ───

test("ping: source-string pin — handler is jsonResult(ping()), no destructure/try/allowedKeys/spawn", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    const registrations = src.match(/toolHandlers\["ping"\]/g) ?? [];
    assert.equal(
      registrations.length,
      1,
      `handler must be registered exactly once; got ${registrations.length}`,
    );

    const handlerBlock = extractHandlerBlock(src);
    assert.match(
      handlerBlock,
      /toolHandlers\["ping"\]\s*=\s*async\s*\(\s*args\s*\)\s*=>\s*\{/,
    );
    assert.match(handlerBlock, /return\s+jsonResult\(\s*ping\(\)\s*\)\s*;/);
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
      /toolHandlers\["ping"\]\s*=\s*async\s*\(\s*\{/,
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
      /name:\s*"ping",[\s\S]*?inputSchema:\s*(\{[\s\S]*?\}),[\s\S]*?annotations:\s*(\{[\s\S]*?\})/,
    );
    assert.ok(schemaMatch, "advertised ping schema block must be extractable");
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
      /export function ping\(\):\s*PingResult\s*\{[\s\S]*?status:\s*'ok'[\s\S]*?timestamp:\s*Date\.now\(\)/,
    );

    const response = await client.callTool({
      name: "ping",
      arguments: {},
    });
    const body = bodyOf(response);
    assert.equal(body.status, "ok");
    assert.equal(typeof body.timestamp, "number");
  });
});
