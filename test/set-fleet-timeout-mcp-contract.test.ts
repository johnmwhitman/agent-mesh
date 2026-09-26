/**
 * set_fleet_timeout MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names. Honesty-pattern refresh (2026-09-12).
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `set_fleet_timeout` is the per-fleet
 * timeout WRITE path (src/index.ts advertised schema at L706-L718 +
 * handler at toolHandlers["set_fleet_timeout"] L1910-L1944 on origin/main
 * 8433dcb8). It is published. The 2026-09-09 worktree (3738f520) never
 * landed on origin/main. origin/main already ships two boundary
 * witnesses in test/tool-boundary-validation.test.ts (timeout_ms:0 and
 * timeout_ms:2147483648) but those do NOT pin advertised-vs-handler
 * honesty: additionalProperties absence, the four annotations, phantom
 * extra keys, source-string shape, fleet-not-found, success-echo, or
 * the named bug class (handler destructure-cast of args). This card is
 * a fresh origin/main pin with the 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — {type:object,
 *      properties:{fleet_id:{type:string},
 *      timeout_ms:{type:integer, minimum:1, maximum:2147483647}},
 *      required:[fleet_id, timeout_ms]} with NO additionalProperties
 *      key (advertising false would be a lie; handler has no
 *      requireAllowedKeys) + annotations {idempotentHint:true,
 *      readOnlyHint:false, destructiveHint:false, openWorldHint:false}
 *      + description names "per-fleet timeout override" /
 *      "milliseconds" / "auto-failed".
 *   2. fleet_id boundary — missing / non-string / blank fleet_id all
 *      return isError:true naming set_fleet_timeout + fleet_id +
 *      non-empty string AND NEVER "Fleet ... not found" (a wrong-typed
 *      fleet_id must be NAMED, not shrugged into a lookup miss).
 *   3. timeout_ms requireNumber — missing / non-number / non-integer /
 *      0 / -1 / 2147483648 all return isError:true naming timeout_ms.
 *      Named bug class is the original 0-persists defect (src/index.ts
 *      L1912-L1913): the env path demanded > 0; the tool path accepted
 *      0, which stores a timeout that fails every agent the instant it
 *      starts. Node also clamps delays above MAX_FLEET_TIMEOUT_MS to
 *      1ms, so 2147483648 must refuse.
 *   4. unknown-fleet jsonError `Fleet ${id} not found` after the wire
 *      gate (honest-shape call against an empty ledger).
 *   5. happy-path success-echo — createFleet seeded before child
 *      connects; well-formed call returns EXACTLY {ok:true,
 *      timeout_ms:<number>} and a second identical call returns the
 *      same snapshot (idempotentHint).
 *   6. advertised-vs-handler honesty — phantom top-level keys
 *      (phantom_filter/debug_emit/future_field/force/nested/note) are
 *      silently ignored AND no phantom keys leak into the response.
 *      This is HONEST: additionalProperties is not advertised,
 *      handler does not enforce it.
 *   7. source-string pin — handler destructure-casts
 *      `const { fleet_id, timeout_ms } = args as { fleet_id: string;
 *      timeout_ms: number }` then firstError(requireString
 *      ("set_fleet_timeout","fleet_id",fleet_id), requireNumber
 *      ("set_fleet_timeout","timeout_ms",timeout_ms,{min:1,
 *      max:MAX_FLEET_TIMEOUT_MS, integer:true})) then setFleetTimeout
 *      + updateTimeout + lifecycleCoordinator.updateFleetRuntimeTimeout
 *      + appendEvent("fleet_timeout_set") + fleetTimeoutEnforcer.refresh
 *      then jsonResult({ ok: true, timeout_ms: getFleetTimeoutMs(fleet_id) })
 *      with a catch jsonError, NO requireAllowedKeys, registered
 *      exactly once. Named bug class is the handler destructure-cast
 *      of args (null/non-object args throw instead of jsonError) PLUS
 *      the original 0-persists defect.
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * WRITE-ISOLATION LAW: set_fleet_timeout writes to the ledger. Every
 * run that opens a child sets ALL THREE of MESHFLEET_DB_FILE,
 * MESHFLEET_DATA_FILE, MESHFLEET_EVENT_LOG_FILE to temp paths — never
 * the live ~/.config/opencode/agent-mesh.db.
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

import { createFleet, getFleetTimeoutMs } from "../src/core.js";
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-set-fleet-timeout-mcp-20260912-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-set-fleet-timeout-20260912-${dir}`,
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
 * applyFixtureEnv MUST be called BEFORE the child connects so the
 * cached better-sqlite3 handle inside src/db.ts opens against the
 * tempdir, not the live ~/.config/opencode/agent-mesh.db (which is on
 * storage_schema_version=5 and would raise unsupported-newer-schema).
 * HOME points at the tempdir so any discoverPremadeAgents() call
 * the handler chain hits cannot fail from a missing HOME.
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
    { name: "set-fleet-timeout-contract-test", version: "1.0.0" },
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

const SET_FLEET_TIMEOUT_ANNOTATIONS = {
  idempotentHint: true,
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const MAX_FLEET_TIMEOUT_MS = 2_147_483_647;

function extractHandlerBlock(src: string): string {
  const match = src.match(/toolHandlers\["set_fleet_timeout"\][\s\S]*?^};/m);
  assert.ok(match, "set_fleet_timeout handler block must be extractable");
  return match[0];
}

function extractSchemaBlock(src: string): { schema: string; annotations: string; description: string } {
  const start = src.indexOf('name: "set_fleet_timeout"');
  assert.notEqual(start, -1, "advertised set_fleet_timeout schema block must be extractable");
  const window = src.slice(start, start + 900);
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

async function callOk(
  client: Client,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name: "set_fleet_timeout", arguments: args });
  assert.notEqual(
    (response as ToolResponse).isError,
    true,
    `set_fleet_timeout must succeed; got: ${textOf(response)}`,
  );
  return bodyOf(response);
}

// ─── Test 1: advertised schema + annotations + description honesty ───

test("set_fleet_timeout: advertised schema requires fleet_id+timeout_ms integer 1..MAX, no additionalProperties, four annotations, description names per-fleet timeout override", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "set_fleet_timeout");
    assert.ok(tool, "set_fleet_timeout must be advertised");

    assert.deepEqual(tool!.inputSchema, {
      type: "object",
      properties: {
        fleet_id: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1, maximum: MAX_FLEET_TIMEOUT_MS },
      },
      required: ["fleet_id", "timeout_ms"],
    });
    // Honesty: handler ignores extra keys and has no requireAllowedKeys.
    // Advertising additionalProperties:false would be a lie.
    assert.equal(
      "additionalProperties" in tool!.inputSchema,
      false,
      "additionalProperties must be ABSENT — handler never enforces it; advertising false would be a lie",
    );

    assert.deepEqual(tool!.annotations, SET_FLEET_TIMEOUT_ANNOTATIONS);

    const desc = tool!.description ?? "";
    assert.match(desc, /per-fleet timeout override/i);
    assert.match(desc, /milliseconds/i);
    assert.match(desc, /auto-failed/i);
  });
});

// ─── Test 2: fleet_id boundary — missing / non-string / blank ───

test("set_fleet_timeout: refuses missing / non-string / blank fleet_id with a named error (never Fleet-not-found)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const cases: ReadonlyArray<{
      label: string;
      args: Record<string, unknown>;
    }> = [
      { label: "missing fleet_id", args: { timeout_ms: 30000 } },
      { label: "null fleet_id", args: { fleet_id: null, timeout_ms: 30000 } },
      { label: "number fleet_id", args: { fleet_id: 42, timeout_ms: 30000 } },
      { label: "boolean fleet_id", args: { fleet_id: true, timeout_ms: 30000 } },
      { label: "array fleet_id", args: { fleet_id: ["f"], timeout_ms: 30000 } },
      { label: "object fleet_id", args: { fleet_id: { id: "f" }, timeout_ms: 30000 } },
      { label: "empty-string fleet_id", args: { fleet_id: "", timeout_ms: 30000 } },
      { label: "whitespace-only fleet_id", args: { fleet_id: "   \t ", timeout_ms: 30000 } },
    ];
    for (const { label, args } of cases) {
      const response = await client.callTool({
        name: "set_fleet_timeout",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be a tool error, not a silent lookup miss`,
      );
      assert.match(
        textOf(response),
        /set_fleet_timeout: 'fleet_id' is required and must be a non-empty string/,
        `${label}: rejection text must name set_fleet_timeout + fleet_id; got: ${textOf(response)}`,
      );
      assert.doesNotMatch(
        textOf(response),
        /Fleet .* not found/,
        `${label}: a wrong-typed fleet_id must NOT become a lookup miss; got: ${textOf(response)}`,
      );
    }
  });
});

// ─── Test 3: timeout_ms requireNumber — the original 0-persists defect ───

test("set_fleet_timeout: refuses missing / non-number / non-integer / 0 / -1 / MAX+1 timeout_ms (the original 0-persists defect)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const cases: ReadonlyArray<{
      label: string;
      args: Record<string, unknown>;
      needle: RegExp;
    }> = [
      {
        label: "missing timeout_ms",
        args: { fleet_id: "valid-id" },
        needle: /set_fleet_timeout: 'timeout_ms' is required and must be a finite number/,
      },
      {
        label: "null timeout_ms",
        args: { fleet_id: "valid-id", timeout_ms: null },
        needle: /set_fleet_timeout: 'timeout_ms' is required and must be a finite number/,
      },
      {
        label: "string timeout_ms",
        args: { fleet_id: "valid-id", timeout_ms: "30000" },
        needle: /set_fleet_timeout: 'timeout_ms' is required and must be a finite number/,
      },
      {
        label: "boolean timeout_ms",
        args: { fleet_id: "valid-id", timeout_ms: true },
        needle: /set_fleet_timeout: 'timeout_ms' is required and must be a finite number/,
      },
      {
        label: "array timeout_ms",
        args: { fleet_id: "valid-id", timeout_ms: [30000] },
        needle: /set_fleet_timeout: 'timeout_ms' is required and must be a finite number/,
      },
      {
        label: "object timeout_ms",
        args: { fleet_id: "valid-id", timeout_ms: { ms: 30000 } },
        needle: /set_fleet_timeout: 'timeout_ms' is required and must be a finite number/,
      },
      {
        label: "non-integer timeout_ms",
        args: { fleet_id: "valid-id", timeout_ms: 1.5 },
        needle: /set_fleet_timeout: 'timeout_ms' must be an integer/,
      },
      {
        label: "timeout_ms:0 (original 0-persists defect)",
        args: { fleet_id: "valid-id", timeout_ms: 0 },
        needle: /set_fleet_timeout: 'timeout_ms' must be >= 1, got 0/,
      },
      {
        label: "timeout_ms:-1",
        args: { fleet_id: "valid-id", timeout_ms: -1 },
        needle: /set_fleet_timeout: 'timeout_ms' must be >= 1, got -1/,
      },
      {
        label: "timeout_ms:MAX+1 (Node would clamp to 1ms)",
        args: { fleet_id: "valid-id", timeout_ms: MAX_FLEET_TIMEOUT_MS + 1 },
        needle: /set_fleet_timeout: 'timeout_ms' must be <= 2147483647, got 2147483648/,
      },
    ];
    for (const { label, args, needle } of cases) {
      const response = await client.callTool({
        name: "set_fleet_timeout",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be a tool error, not a persisted timeout`,
      );
      assert.match(
        textOf(response),
        needle,
        `${label}: rejection text must name timeout_ms; got: ${textOf(response)}`,
      );
      assert.doesNotMatch(
        textOf(response),
        /Fleet .* not found/,
        `${label}: a range/type violation must fire BEFORE fleet lookup; got: ${textOf(response)}`,
      );
    }
  });
});

// ─── Test 4: unknown fleet refused as jsonError after the wire gate ───

test("set_fleet_timeout: honest-shape call against a missing fleet returns isError Fleet <id> not found", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "set_fleet_timeout",
      arguments: { fleet_id: "no-such-fleet-yet", timeout_ms: 30000 },
    });
    assert.equal(
      (response as ToolResponse).isError,
      true,
      "unknown fleet_id must be a tool error, not a silent persist",
    );
    const body = bodyOf(response);
    assert.equal(
      body.error,
      "Fleet no-such-fleet-yet not found",
      `error must be exactly 'Fleet <id> not found', got: ${JSON.stringify(body)}`,
    );
  });
});

// ─── Test 5: happy-path success-echo + idempotentHint ───

test("set_fleet_timeout: returns EXACTLY {ok:true, timeout_ms} and a second identical call matches (idempotentHint)", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  createFleet("timeout-fleet");

  await withChildServer(fix, async (client) => {
    const first = await callOk(client, { fleet_id: "timeout-fleet", timeout_ms: 60000 });
    assert.equal(first.ok, true);
    assert.equal(first.timeout_ms, 60000);
    assert.deepEqual(
      Object.keys(first).sort(),
      ["ok", "timeout_ms"],
      `success must return EXACTLY {ok, timeout_ms}; got keys ${JSON.stringify(Object.keys(first).sort())}`,
    );

    const second = await callOk(client, { fleet_id: "timeout-fleet", timeout_ms: 60000 });
    assert.deepEqual(
      first,
      second,
      "two quiet identical set_fleet_timeout calls must return the same snapshot (idempotentHint)",
    );

    assert.equal(
      getFleetTimeoutMs("timeout-fleet"),
      60000,
      "ledger must persist the echoed timeout_ms",
    );
  });
});

// ─── Test 6: phantom extra keys silently ignored (honesty) ───

test("set_fleet_timeout: phantom extra keys are silently ignored (additionalProperties not advertised, handler does not enforce)", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  createFleet("phantom-timeout-fleet");

  await withChildServer(fix, async (client) => {
    const result = await callOk(client, {
      fleet_id: "phantom-timeout-fleet",
      timeout_ms: 45000,
      phantom_filter: "ignored",
      debug_emit: true,
      future_field: 42,
      force: "yes",
      nested: { a: 1 },
      note: "should be ignored",
    });
    assert.equal(result.ok, true);
    assert.equal(result.timeout_ms, 45000);
    assert.equal(result.phantom_filter, undefined);
    assert.equal(result.debug_emit, undefined);
    assert.equal(result.future_field, undefined);
    assert.equal(result.force, undefined);
    assert.equal(result.nested, undefined);
    assert.equal(result.note, undefined);
    const extraTop = Object.keys(result).filter(
      (k) => k !== "ok" && k !== "timeout_ms",
    );
    assert.deepEqual(
      extraTop,
      [],
      `phantom keys must NOT leak into the response; extra: ${extraTop.join(",")}`,
    );
  });
});

// ─── Test 7: source-string pin ───

test("set_fleet_timeout: source-string pin — destructure-cast + requireString fleet_id + requireNumber timeout_ms min1/MAX/integer + jsonResult echo, no allowedKeys", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    const registrations = src.match(/toolHandlers\["set_fleet_timeout"\]/g) ?? [];
    assert.equal(
      registrations.length,
      1,
      `handler must be registered exactly once; got ${registrations.length}`,
    );

    const handlerBlock = extractHandlerBlock(src);
    assert.match(
      handlerBlock,
      /toolHandlers\["set_fleet_timeout"\]\s*=\s*async\s*\(\s*args\s*\)\s*=>\s*\{/,
    );
    assert.match(
      handlerBlock,
      /const\s*\{\s*fleet_id\s*,\s*timeout_ms\s*\}\s*=\s*args\s+as\s+\{\s*fleet_id:\s*string;\s*timeout_ms:\s*number\s*\}/,
    );
    assert.match(
      handlerBlock,
      /requireString\(\s*"set_fleet_timeout"\s*,\s*"fleet_id"\s*,\s*fleet_id\s*\)/,
    );
    assert.match(
      handlerBlock,
      /requireNumber\(\s*"set_fleet_timeout"\s*,\s*"timeout_ms"\s*,\s*timeout_ms\s*,\s*\{\s*min:\s*1\s*,\s*max:\s*MAX_FLEET_TIMEOUT_MS\s*,\s*integer:\s*true\s*,?\s*\}\s*\)/,
    );
    assert.match(handlerBlock, /setFleetTimeout\(\s*fleet_id\s*,\s*timeout_ms\s*\)/);
    assert.match(handlerBlock, /active\.handle\.updateTimeout\?\.\(\s*timeout_ms\s*\)/);
    assert.match(
      handlerBlock,
      /lifecycleCoordinator\.updateFleetRuntimeTimeout\(\s*fleet_id\s*,\s*timeout_ms\s*\)/,
    );
    assert.match(handlerBlock, /appendEvent\(\s*"fleet_timeout_set"/);
    assert.match(handlerBlock, /fleetTimeoutEnforcer\.refresh\(\s*fleet_id\s*\)/);
    assert.match(
      handlerBlock,
      /return\s+jsonResult\(\s*\{\s*ok:\s*true\s*,\s*timeout_ms:\s*getFleetTimeoutMs\(\s*fleet_id\s*\)\s*\}\s*\)/,
    );
    assert.match(handlerBlock, /\bcatch\s*\(/);
    assert.match(handlerBlock, /jsonError\(/);
    assert.doesNotMatch(
      handlerBlock,
      /requireAllowedKeys/,
      "handler must NOT enforce additionalProperties (advertising false would be a lie)",
    );
    assert.doesNotMatch(
      handlerBlock,
      /spawnFleet|wakeAgent|sendMessage|fetch\(/,
    );
    // Named 0-persists defect comment must still document why min:1 exists.
    assert.match(
      handlerBlock,
      /The env path for this same value demands > 0/,
    );
    assert.match(
      handlerBlock,
      /tool path accepted 0/,
    );

    const { schema, annotations, description } = extractSchemaBlock(src);
    assert.match(schema, /type:\s*"object"/);
    assert.match(schema, /fleet_id:\s*\{\s*type:\s*"string"\s*\}/);
    assert.match(schema, /timeout_ms:\s*\{\s*type:\s*"integer"\s*,\s*minimum:\s*1\s*,\s*maximum:\s*MAX_FLEET_TIMEOUT_MS\s*\}/);
    assert.match(schema, /required:\s*\[\s*"fleet_id"\s*,\s*"timeout_ms"\s*\]/);
    assert.doesNotMatch(
      schema,
      /additionalProperties/,
      "advertised schema must NOT carry additionalProperties (handler does not enforce it)",
    );
    assert.match(annotations, /idempotentHint:\s*true/);
    assert.match(annotations, /readOnlyHint:\s*false/);
    assert.match(annotations, /destructiveHint:\s*false/);
    assert.match(annotations, /openWorldHint:\s*false/);
    assert.match(description, /per-fleet timeout override/);
    assert.match(description, /milliseconds/);
    assert.match(description, /auto-failed/);

    const core = readFileSync(join(repoRoot, "src", "core.ts"), "utf-8");
    assert.match(core, /export const MAX_FLEET_TIMEOUT_MS = 2_147_483_647;/);
    assert.match(
      core,
      /export function setFleetTimeout\(fleetId: string, timeoutMs: number\): void/,
    );
    assert.match(core, /if \(!fleet\) throw new Error\(`Fleet \$\{fleetId\} not found`\);/);

    // Live wire still refuses a missing timeout after the source pin.
    const response = await client.callTool({
      name: "set_fleet_timeout",
      arguments: { fleet_id: "source-pin-empty" },
    });
    assert.equal((response as ToolResponse).isError, true);
    assert.match(
      textOf(response),
      /set_fleet_timeout: 'timeout_ms' is required and must be a finite number/,
    );
  });
});
