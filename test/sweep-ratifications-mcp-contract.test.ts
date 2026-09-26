/**
 * sweep_ratifications MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names. Honesty-pattern refresh (2026-09-12).
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `sweep_ratifications` is the council
 * deadline sweeper WRITE that evaluates every open ratification AND
 * persists any that reached a terminal state (src/index.ts advertised
 * schema at L945-L949 + handler at toolHandlers["sweep_ratifications"]
 * L2412-L2414 on origin/main 8433dcb8). The 2026-08-20 worktree
 * (agent-mesh-sweep-ratifications-contract-20260820) and 2026-09-08
 * card never landed on origin/main. origin/main already ships
 * ratify.test.ts (direct core calls) but those do NOT pin
 * advertised-vs-handler honesty: additionalProperties absence, the
 * four annotations together, phantom extra keys, source-string shape,
 * or the named readOnlyHint-lie class (handler writes via
 * sweepRatifications → withLedger while a future flip of
 * readOnlyHint:true would lie to MCP clients). This card is a fresh
 * origin/main pin with the 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — {type:object, properties:{}} with NO
 *      required array and NO additionalProperties key (advertising
 *      false would be a lie; handler never reads args and has no
 *      requireAllowedKeys) + annotations {readOnlyHint:false,
 *      idempotentHint:true, destructiveHint:false, openWorldHint:false}
 *      + description names "Evaluate every open ratification" /
 *      "persist any that reached a terminal state" / "deadline expiry"
 *      / "silent-approval" / "unreachable quorum" /
 *      "AGENT_MESH_RATIFY_SWEEP_MS".
 *   2. empty-args call on an empty ledger returns EXACTLY
 *      {checked:0, resolved:{}} — both keys present, no isError, no
 *      phantom status/tally/ok envelope.
 *   3. named readOnlyHint-lie class — the handler MUST call
 *      sweepRatifications() (which writes via withLedger when any
 *      open ratification becomes terminal) and the advertised
 *      annotation MUST be readOnlyHint:false. A future flip back to
 *      true would lie to MCP clients routing on hints.
 *   4. open-not-crossed — an open ratification that has NOT crossed
 *      a deadline/quorum line is counted under `checked` but is NOT
 *      in `resolved`; a follow-up tally_ratification still returns
 *      status==="open" (silent no-op, no ledger mutation).
 *   5. happy-path persist + idempotent re-call — deadline +
 *      silence_policy=approve lands under resolved as "ratified";
 *      a second sweep returns {checked:0, resolved:{}} (idempotentHint
 *      honored) and tally_ratification still reports "ratified".
 *   6. advertised-vs-handler honesty — phantom top-level keys
 *      (force/id_prefix/debug_emit/future_field/nested) are silently
 *      ignored AND no phantom keys leak into the response. This is
 *      HONEST: additionalProperties is not advertised, handler does
 *      not enforce it.
 *   7. source-string pin — handler is `return jsonResult(sweepRatifications());`
 *      with NO args destructure, NO try/catch, NO
 *      requireString/requireAllowedKeys, NO spawnFleet/wakeAgent/fetch,
 *      registered exactly once. sweepRatifications() at src/ratify.ts
 *      runs inside withLedger and returns {checked, resolved}.
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * WRITE-ISOLATION LAW: sweep_ratifications writes to the ledger when a
 * ratification has reached a terminal state. Every run that opens a
 * child sets ALL THREE of MESHFLEET_DB_FILE, MESHFLEET_DATA_FILE,
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

type Fixture = {
  dir: string;
  dataFile: string;
  dbFile: string;
  eventsFile: string;
};

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-sweep-ratifications-mcp-20260912-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-sweep-ratifications-20260912-${dir}`,
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
    { name: "sweep-ratifications-contract-test", version: "1.0.0" },
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

const SWEEP_RATIFICATIONS_ANNOTATIONS = {
  readOnlyHint: false,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

function extractHandlerBlock(src: string): string {
  const match = src.match(/toolHandlers\["sweep_ratifications"\][\s\S]*?^};/m);
  assert.ok(match, "sweep_ratifications handler block must be extractable");
  return match[0];
}

function extractSchemaBlock(src: string): {
  schema: string;
  annotations: string;
  description: string;
} {
  const start = src.indexOf('name: "sweep_ratifications"');
  assert.notEqual(start, -1, "advertised sweep_ratifications schema block must be extractable");
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

async function callOk(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: args });
  assert.notEqual(
    (response as ToolResponse).isError,
    true,
    `${name} must succeed; got: ${textOf(response)}`,
  );
  return bodyOf(response);
}

async function openCouncil(
  client: Client,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const response = await client.callTool({
    name: "open_ratification",
    arguments: {
      proposer: "carol",
      fleet_id: "fleet-x",
      subject: `sweep-honesty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      quorum: 2,
      voters: ["alice", "bob"],
      ...extra,
    },
  });
  assert.notEqual(
    (response as ToolResponse).isError,
    true,
    `open_ratification must succeed for setup, got ${textOf(response)}`,
  );
  const messageId = bodyOf(response).message_id;
  assert.equal(typeof messageId, "string");
  assert.ok((messageId as string).length > 0, "message_id must be non-empty");
  return messageId as string;
}

function assertExactEnvelope(body: Record<string, unknown>, label: string): void {
  assert.deepEqual(
    Object.keys(body).sort(),
    ["checked", "resolved"],
    `${label}: success must return EXACTLY {checked, resolved}; got keys ${JSON.stringify(Object.keys(body).sort())}`,
  );
  assert.equal(typeof body.checked, "number", `${label}: checked must be a number`);
  assert.equal(typeof body.resolved, "object", `${label}: resolved must be an object`);
  assert.notEqual(body.resolved, null, `${label}: resolved must not be null`);
  assert.equal(Array.isArray(body.resolved), false, `${label}: resolved must not be an array`);
}

// ─── Test 1: advertised schema + annotations + description honesty ───

test("sweep_ratifications: advertised schema is empty-object with no required, no additionalProperties, four annotations with readOnlyHint=false + idempotentHint=true, description names evaluate/persist/deadline/silence", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "sweep_ratifications");
    assert.ok(tool, "sweep_ratifications must be advertised");

    assert.deepEqual(tool!.inputSchema, {
      type: "object",
      properties: {},
    });
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
      "root additionalProperties must be ABSENT — handler never enforces it; advertising false would be a lie",
    );

    assert.deepEqual(tool!.annotations, SWEEP_RATIFICATIONS_ANNOTATIONS);
    assert.equal(
      tool!.annotations?.readOnlyHint,
      false,
      "sweep_ratifications calls sweepRatifications and persists terminal status — readOnlyHint must be false (the named lie class)",
    );
    assert.equal(
      tool!.annotations?.idempotentHint,
      true,
      "sweep_ratifications re-calls return the already-resolved ledger — idempotentHint must be true",
    );

    const desc = tool!.description ?? "";
    assert.match(desc, /Evaluate every open ratification/);
    assert.match(desc, /persist any that reached a terminal state/);
    assert.match(desc, /deadline expiry/);
    assert.match(desc, /silent-approval/);
    assert.match(desc, /unreachable quorum/);
    assert.match(desc, /AGENT_MESH_RATIFY_SWEEP_MS/);
  });
});

// ─── Test 2: empty-args empty-ledger envelope ───

test("sweep_ratifications: empty-args call on an empty ledger returns EXACTLY {checked:0, resolved:{}} with no error envelope", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "sweep_ratifications",
      arguments: {},
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `empty args must not be an isError envelope; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assertExactEnvelope(body, "empty-ledger");
    assert.equal(body.checked, 0, "empty ledger => checked:0");
    assert.deepEqual(body.resolved, {}, "empty ledger => resolved={}");
    assert.equal(body.status, undefined, "empty-ledger must NOT carry a phantom status");
    assert.equal(body.tally, undefined, "empty-ledger must NOT carry a phantom tally");
    assert.equal(body.ok, undefined, "empty-ledger must NOT carry a phantom ok");
    assert.equal(body.error, undefined, "empty-ledger must NOT carry a phantom error");
  });
});

// ─── Test 3: named readOnlyHint-lie class ───

test("sweep_ratifications: named readOnlyHint-lie class — handler calls sweepRatifications (WRITE via withLedger); advertised readOnlyHint is false", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");
    const handlerBlock = extractHandlerBlock(src);
    const { annotations, description } = extractSchemaBlock(src);

    assert.match(
      handlerBlock,
      /return\s+jsonResult\(\s*sweepRatifications\(\)\s*\)/,
      "handler must call sweepRatifications() (WRITE via withLedger)",
    );
    assert.match(annotations, /readOnlyHint:\s*false/);
    assert.match(annotations, /idempotentHint:\s*true/);
    assert.match(description, /persist any that reached a terminal state/);
    assert.doesNotMatch(
      handlerBlock,
      /readOnlyHint:\s*true/,
      "handler block must not re-introduce the lying readOnlyHint",
    );

    const ratify = readFileSync(join(repoRoot, "src", "ratify.ts"), "utf-8");
    assert.match(
      ratify,
      /export function sweepRatifications[\s\S]*?return withLedger/,
      "sweepRatifications must write inside withLedger (the named write path)",
    );

    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "sweep_ratifications");
    assert.equal(tool!.annotations?.readOnlyHint, false);
  });
});

// ─── Test 4: open ratification that has NOT crossed the line ───

test("sweep_ratifications: an open ratification that has NOT crossed the line is counted under checked but NOT in resolved (silent no-op)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const messageId = await openCouncil(client);
    const result = await callOk(client, "sweep_ratifications", {});
    assertExactEnvelope(result, "open-not-crossed");
    assert.equal(result.checked, 1, "one open ratification => checked:1");
    assert.deepEqual(
      result.resolved,
      {},
      "an open ratification that has NOT crossed the line must NOT appear under resolved (silent no-op)",
    );

    const tally = await callOk(client, "tally_ratification", { message_id: messageId });
    assert.equal(
      tally.status,
      "open",
      "sweep must NOT have mutated the ledger for an open ratification",
    );
  });
});

// ─── Test 5: happy-path persist + idempotent re-call ───

test("sweep_ratifications: deadline + silence_policy=approve persists ratified; second sweep returns {checked:0, resolved:{}} (idempotentHint)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const messageId = await openCouncil(client, {
      quorum: 1,
      voters: ["alice"],
      silence_policy: "approve",
      deadline: Date.now() - 60_000,
    });

    const first = await callOk(client, "sweep_ratifications", {});
    assertExactEnvelope(first, "first-sweep");
    assert.equal(first.checked, 1, "first sweep: the open ratification IS counted under checked");
    const resolved = first.resolved as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(resolved),
      [messageId],
      "first sweep: the cross-the-line ratification IS in resolved",
    );
    assert.equal(
      resolved[messageId],
      "ratified",
      "deadline + silence_policy=approve + pending_weight>=quorum => ratified",
    );

    const tally = await callOk(client, "tally_ratification", { message_id: messageId });
    assert.equal(tally.status, "ratified");

    const second = await callOk(client, "sweep_ratifications", {});
    assertExactEnvelope(second, "second-sweep");
    assert.equal(second.checked, 0, "second sweep after every ratification resolved => checked:0");
    assert.deepEqual(second.resolved, {}, "second sweep after every ratification resolved => resolved={}");

    const tallyAgain = await callOk(client, "tally_ratification", { message_id: messageId });
    assert.equal(
      tallyAgain.status,
      "ratified",
      "idempotentHint: a re-sweep must not flip an already-ratified council",
    );
  });
});

// ─── Test 6: phantom extra keys silently ignored (honesty) ───

test("sweep_ratifications: phantom extra keys are silently ignored (additionalProperties not advertised, handler does not enforce)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "sweep_ratifications",
      arguments: {
        force: "yes",
        id_prefix: "msg-",
        debug_emit: true,
        future_field: 42,
        nested: { a: 1 },
        phantom_filter: "ignored",
      },
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `phantom keys must NOT error; advertising additionalProperties:false would be a lie. got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assertExactEnvelope(body, "phantom-keys");
    assert.equal(body.checked, 0);
    assert.deepEqual(body.resolved, {});
    assert.equal(body.force, undefined);
    assert.equal(body.id_prefix, undefined);
    assert.equal(body.debug_emit, undefined);
    assert.equal(body.future_field, undefined);
    assert.equal(body.nested, undefined);
    assert.equal(body.phantom_filter, undefined);
  });
});

// ─── Test 7: source-string pin ───

test("sweep_ratifications: source-string pin — handler is jsonResult(sweepRatifications()), no destructure/try/allowedKeys/spawn", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    const registrations = src.match(/toolHandlers\["sweep_ratifications"\]/g) ?? [];
    assert.equal(
      registrations.length,
      1,
      `handler must be registered exactly once; got ${registrations.length}`,
    );

    const handlerBlock = extractHandlerBlock(src);
    assert.match(
      handlerBlock,
      /toolHandlers\["sweep_ratifications"\]\s*=\s*async\s*\(\s*args\s*\)\s*=>\s*\{/,
    );
    assert.match(handlerBlock, /return\s+jsonResult\(\s*sweepRatifications\(\)\s*\)\s*;/);
    assert.doesNotMatch(
      handlerBlock,
      /requireAllowedKeys/,
      "handler must NOT enforce additionalProperties (advertising false would be a lie)",
    );
    assert.doesNotMatch(handlerBlock, /requireString|requireBoolean|requireNumber/);
    assert.doesNotMatch(
      handlerBlock,
      /spawnFleet|wakeAgent|sendMessage|fetch\(/,
    );
    assert.doesNotMatch(
      handlerBlock,
      /toolHandlers\["sweep_ratifications"\]\s*=\s*async\s*\(\s*\{/,
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

    const { schema, annotations, description } = extractSchemaBlock(src);
    assert.match(schema, /type:\s*"object"/);
    assert.match(schema, /properties:\s*\{\s*\}/);
    assert.doesNotMatch(
      schema,
      /additionalProperties/,
      "advertised ROOT schema must NOT carry additionalProperties (handler does not enforce it)",
    );
    assert.match(annotations, /readOnlyHint:\s*false/);
    assert.match(annotations, /idempotentHint:\s*true/);
    assert.match(annotations, /destructiveHint:\s*false/);
    assert.match(annotations, /openWorldHint:\s*false/);
    assert.match(description, /Evaluate every open ratification/);
    assert.match(description, /persist any that reached a terminal state/);
    assert.match(description, /AGENT_MESH_RATIFY_SWEEP_MS/);

    const ratify = readFileSync(join(repoRoot, "src", "ratify.ts"), "utf-8");
    assert.match(
      ratify,
      /export function sweepRatifications\(now:\s*number\s*=\s*Date\.now\(\)\):\s*SweepResult/,
    );
    assert.match(
      ratify,
      /return \{\s*checked:\s*open\.length,\s*resolved\s*\}/,
    );

    const response = await client.callTool({
      name: "sweep_ratifications",
      arguments: {},
    });
    assert.notEqual((response as ToolResponse).isError, true);
    const body = bodyOf(response);
    assertExactEnvelope(body, "source-pin-live");
    assert.equal(body.checked, 0);
    assert.deepEqual(body.resolved, {});
  });
});
