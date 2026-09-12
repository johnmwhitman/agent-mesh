/**
 * tally_ratification MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names. Honesty-pattern refresh (2026-09-12).
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `tally_ratification` is the council
 * resolver WRITE that reads the live vote tally AND persists terminal
 * status (src/index.ts advertised schema at L931-L943 + handler at
 * toolHandlers["tally_ratification"] L2403-L2410 on origin/main 8433dcb8).
 * The 2026-09-08 worktree (agent-mesh-tally-ratification-mcp-contract-20260908)
 * and 2026-09-09 / 2026-09-11 cards never landed on origin/main. origin/main
 * already ships ratify.test.ts (direct core calls) and
 * mcp-tool-annotations.test.ts (readOnlyHint=false presence) but those do
 * NOT pin advertised-vs-handler honesty: additionalProperties absence,
 * the four annotations together, phantom extra keys, source-string shape,
 * or the named readOnlyHint-lie class (CHANGELOG: advertised
 * readOnlyHint:true while resolveRatification persists terminal status).
 * This card is a fresh origin/main pin with the 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — {type:object, properties:{message_id},
 *      required:[message_id]} with NO additionalProperties key
 *      (advertising false would be a lie; handler has no
 *      requireAllowedKeys) + annotations {readOnlyHint:false,
 *      idempotentHint:true, destructiveHint:false, openWorldHint:false}
 *      + description names "live vote tally" / "open / ratified /
 *      rejected / expired" / "persist the status" / "terminal state".
 *   2. required-string monad — missing / non-string / blank message_id
 *      all return isError:true naming tally_ratification + the field +
 *      non-empty string AND NEVER a phantom {status, tally} envelope
 *      (the historical defect: a coerced non-string message_id hashed
 *      into a lookup key and returned a fabricated tally).
 *   3. named readOnlyHint-lie class — the handler MUST call
 *      resolveRatification (which writes via withLedger when status
 *      becomes terminal) BEFORE tallyRatification, and the advertised
 *      annotation MUST be readOnlyHint:false. A future flip back to
 *      true would lie to MCP clients routing on hints. The source
 *      comment "Handler calls resolveRatification — persists terminal
 *      status. Idempotent, not read-only." is load-bearing.
 *   4. missing-ratification jsonError after the wire gate — honest-
 *      shape call (required field only) against an empty ledger
 *      returns isError naming "No such ratification" and MUST NOT
 *      carry a phantom status/tally.
 *   5. happy-path envelope — open_ratification(voters=["alice"],
 *      quorum=1) then tally_ratification returns EXACTLY
 *      {status, tally} with status==="open" and tally.pending===["alice"].
 *      After cast_vote(alice, true), a second tally_ratification
 *      returns status==="ratified" (the persist path) and a third
 *      call returns the SAME envelope (idempotentHint honored).
 *   6. advertised-vs-handler honesty — phantom top-level keys
 *      (phantom_filter/debug_emit/future_field/force/nested) are
 *      silently ignored AND no phantom keys leak into the response.
 *      This is HONEST: additionalProperties is not advertised,
 *      handler does not enforce it.
 *   7. source-string pin — handler destructures `{ message_id }` then
 *      requireString tally_ratification/message_id then
 *      resolveRatification(message_id) then jsonError("No such
 *      ratification") then jsonResult({ status, tally:
 *      tallyRatification(message_id) }), NO requireAllowedKeys, NO
 *      try/catch (siblings that write more have one; this handler
 *      is the short-form). Named bug class is the
 *      "persists terminal status. Idempotent, not read-only" comment.
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * WRITE-ISOLATION LAW: tally_ratification writes to the ledger when a
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-tally-ratification-mcp-20260912-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-tally-ratification-20260912-${dir}`,
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
    { name: "tally-ratification-contract-test", version: "1.0.0" },
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

const TALLY_RATIFICATION_ANNOTATIONS = {
  readOnlyHint: false,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

function extractHandlerBlock(src: string): string {
  const match = src.match(/toolHandlers\["tally_ratification"\][\s\S]*?^};/m);
  assert.ok(match, "tally_ratification handler block must be extractable");
  return match[0];
}

function extractSchemaBlock(src: string): {
  schema: string;
  annotations: string;
  description: string;
  comment: string;
} {
  const start = src.indexOf('name: "tally_ratification"');
  assert.notEqual(start, -1, "advertised tally_ratification schema block must be extractable");
  const window = src.slice(start, start + 1800);
  const descStart = window.indexOf("description:");
  const schemaStart = window.indexOf("inputSchema:");
  const commentStart = window.indexOf("// Handler calls resolveRatification");
  const annotationsStart = window.indexOf("annotations:");
  assert.ok(
    descStart >= 0 && schemaStart > descStart && annotationsStart > schemaStart,
    "description + inputSchema + annotations must follow name",
  );
  return {
    description: window.slice(descStart, schemaStart),
    schema: window.slice(schemaStart, annotationsStart),
    comment:
      commentStart >= 0
        ? window.slice(commentStart, annotationsStart)
        : "",
    annotations: window.slice(annotationsStart, annotationsStart + 220),
  };
}

async function openOneVoterCouncil(client: Client): Promise<string> {
  const response = await client.callTool({
    name: "open_ratification",
    arguments: {
      proposer: "carol",
      fleet_id: "fleet-x",
      subject: "single-vote-tally",
      quorum: 1,
      voters: ["alice"],
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

async function callOk(
  client: Client,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({
    name: "tally_ratification",
    arguments: args,
  });
  assert.notEqual(
    (response as ToolResponse).isError,
    true,
    `tally_ratification must succeed; got: ${textOf(response)}`,
  );
  return bodyOf(response);
}

// ─── Test 1: advertised schema + annotations + description honesty ───

test("tally_ratification: advertised schema requires message_id, no additionalProperties, four annotations with readOnlyHint=false + idempotentHint=true, description names live vote tally / persist terminal status", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "tally_ratification");
    assert.ok(tool, "tally_ratification must be advertised");

    assert.deepEqual(tool!.inputSchema, {
      type: "object",
      properties: {
        message_id: { type: "string" },
      },
      required: ["message_id"],
    });
    // Honesty: handler ignores extra keys and has no requireAllowedKeys.
    // Advertising additionalProperties:false would be a lie.
    assert.equal(
      "additionalProperties" in tool!.inputSchema,
      false,
      "root additionalProperties must be ABSENT — handler never enforces it; advertising false would be a lie",
    );

    assert.deepEqual(tool!.annotations, TALLY_RATIFICATION_ANNOTATIONS);
    assert.equal(
      tool!.annotations?.readOnlyHint,
      false,
      "tally_ratification calls resolveRatification and persists terminal status — readOnlyHint must be false (the named lie class)",
    );
    assert.equal(
      tool!.annotations?.idempotentHint,
      true,
      "tally_ratification re-calls return the persisted status — idempotentHint must be true",
    );

    const desc = tool!.description ?? "";
    assert.match(desc, /live vote tally/);
    assert.match(desc, /open \/ ratified \/ rejected \/ expired/);
    assert.match(desc, /persist the status/);
    assert.match(desc, /terminal state/);
  });
});

// ─── Test 2: required-string monad — missing / non-string / blank ───

test("tally_ratification: refuses missing / non-string / blank message_id with a named error (never a phantom status/tally)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const shapes: ReadonlyArray<{ label: string; value: unknown }> = [
      { label: "missing", value: undefined },
      { label: "null", value: null },
      { label: "number", value: 42 },
      { label: "boolean", value: true },
      { label: "array", value: ["x"] },
      { label: "object", value: { id: "x" } },
      { label: "empty-string", value: "" },
      { label: "whitespace-only", value: "   \t " },
    ];
    for (const { label, value } of shapes) {
      const args: Record<string, unknown> = {};
      if (value !== undefined) args.message_id = value;
      const response = await client.callTool({
        name: "tally_ratification",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `message_id ${label}: must be a tool error, not a phantom tally`,
      );
      assert.match(
        textOf(response),
        /tally_ratification: 'message_id' is required and must be a non-empty string/,
        `message_id ${label}: rejection text must name tally_ratification + message_id; got: ${textOf(response)}`,
      );
      assert.doesNotMatch(
        textOf(response),
        /"status"\s*:/,
        `message_id ${label}: a wrong-typed required string must NOT return a status envelope; got: ${textOf(response)}`,
      );
      assert.doesNotMatch(
        textOf(response),
        /"tally"\s*:/,
        `message_id ${label}: a wrong-typed required string must NOT return a tally envelope; got: ${textOf(response)}`,
      );
    }
  });
});

// ─── Test 3: named readOnlyHint-lie class ───

test("tally_ratification: named readOnlyHint-lie class — handler calls resolveRatification (WRITE) before tallyRatification; advertised readOnlyHint is false", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");
    const handlerBlock = extractHandlerBlock(src);
    const { comment, annotations } = extractSchemaBlock(src);

    // Named lie class: a prior ship advertised readOnlyHint:true while
    // the handler persisted terminal status via resolveRatification.
    // The comment next to the annotations is the documented fix.
    assert.match(
      comment,
      /Handler calls resolveRatification/,
      "schema comment must name resolveRatification as the write path",
    );
    assert.match(
      comment,
      /persists terminal status/,
      "schema comment must name the persist behavior",
    );
    assert.match(
      comment,
      /Idempotent, not read-only/,
      "schema comment must name the classified hint pair",
    );
    assert.match(annotations, /readOnlyHint:\s*false/);
    assert.match(annotations, /idempotentHint:\s*true/);

    const resolveIdx = handlerBlock.indexOf("resolveRatification(message_id)");
    const tallyIdx = handlerBlock.indexOf("tallyRatification(message_id)");
    assert.ok(resolveIdx >= 0, "handler must call resolveRatification(message_id)");
    assert.ok(tallyIdx >= 0, "handler must call tallyRatification(message_id)");
    assert.ok(
      resolveIdx < tallyIdx,
      "resolveRatification (WRITE, persists terminal status) must run BEFORE tallyRatification (pure read) so a first-call-that-crosses-the-line persists",
    );
    assert.doesNotMatch(
      handlerBlock,
      /readOnlyHint:\s*true/,
      "handler block must not re-introduce the lying readOnlyHint",
    );

    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "tally_ratification");
    assert.equal(tool!.annotations?.readOnlyHint, false);
  });
});

// ─── Test 4: missing-ratification jsonError after the wire gate ───

test("tally_ratification: honest-shape call against a missing ratification returns isError naming No such ratification (never a phantom status/tally)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "tally_ratification",
      arguments: {
        message_id: "msg-does-not-exist-xyz",
      },
    });
    assert.equal(
      (response as ToolResponse).isError,
      true,
      "missing ratification must be a tool error, not a silent success",
    );
    assert.match(
      textOf(response),
      /No such ratification: msg-does-not-exist-xyz/,
      `error must name the missing id; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.equal(body.status, undefined, "missing-ratification refuse must NOT carry a phantom status");
    assert.equal(body.tally, undefined, "missing-ratification refuse must NOT carry a stub tally");
  });
});

// ─── Test 5: happy-path envelope + persist + idempotent re-call ───

test("tally_ratification: returns EXACTLY {status, tally}; persists ratified after the crossing vote; re-call is identical (idempotentHint)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const messageId = await openOneVoterCouncil(client);
    const openResult = await callOk(client, { message_id: messageId });
    assert.deepEqual(
      Object.keys(openResult).sort(),
      ["status", "tally"],
      `success must return EXACTLY {status, tally}; got keys ${JSON.stringify(Object.keys(openResult).sort())}`,
    );
    assert.equal(
      openResult.status,
      "open",
      `quorum=1 with zero votes must stay open; got ${JSON.stringify(openResult.status)}`,
    );
    const openTally = openResult.tally as Record<string, unknown>;
    assert.deepEqual(openTally.approvals, []);
    assert.deepEqual(openTally.declines, []);
    assert.deepEqual(openTally.pending, ["alice"]);
    assert.equal(openTally.status, "open");
    assert.equal(openTally.quorum, 1);

    const vote = await client.callTool({
      name: "cast_vote",
      arguments: {
        agent_id: "alice",
        message_id: messageId,
        approve: true,
      },
    });
    assert.notEqual(
      (vote as ToolResponse).isError,
      true,
      `cast_vote must succeed for setup, got ${textOf(vote)}`,
    );

    const ratified = await callOk(client, { message_id: messageId });
    assert.equal(
      ratified.status,
      "ratified",
      `quorum=1 with a single approval must persist status='ratified'; got ${JSON.stringify(ratified.status)}`,
    );
    const ratifiedTally = ratified.tally as Record<string, unknown>;
    assert.deepEqual(ratifiedTally.approvals, ["alice"]);
    assert.deepEqual(ratifiedTally.declines, []);
    assert.deepEqual(ratifiedTally.pending, []);
    assert.equal(ratifiedTally.status, "ratified");
    assert.equal(ratifiedTally.quorum, 1);
    assert.deepEqual(
      Object.keys(ratified).sort(),
      ["status", "tally"],
    );

    const again = await callOk(client, { message_id: messageId });
    assert.deepEqual(
      again,
      ratified,
      "idempotentHint: a re-call on a terminal ratification must return the SAME envelope",
    );
  });
});

// ─── Test 6: phantom extra keys silently ignored (honesty) ───

test("tally_ratification: phantom extra keys are silently ignored (additionalProperties not advertised, handler does not enforce)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const messageId = await openOneVoterCouncil(client);
    const result = await callOk(client, {
      message_id: messageId,
      phantom_filter: "ignored",
      debug_emit: true,
      future_field: 42,
      force: "yes",
      nested: { a: 1 },
    });
    assert.equal(result.status, "open");
    assert.equal(result.phantom_filter, undefined);
    assert.equal(result.debug_emit, undefined);
    assert.equal(result.future_field, undefined);
    assert.equal(result.force, undefined);
    assert.equal(result.nested, undefined);
    const extraTop = Object.keys(result).filter(
      (k) => k !== "status" && k !== "tally",
    );
    assert.deepEqual(
      extraTop,
      [],
      `phantom keys must NOT leak into the response; extra: ${extraTop.join(",")}`,
    );
  });
});

// ─── Test 7: source-string pin ───

test("tally_ratification: source-string pin — args-destructure + requireString message_id + resolveRatification then jsonResult envelope, no allowedKeys", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    const registrations = src.match(/toolHandlers\["tally_ratification"\]/g) ?? [];
    assert.equal(
      registrations.length,
      1,
      `handler must be registered exactly once; got ${registrations.length}`,
    );

    const handlerBlock = extractHandlerBlock(src);
    assert.match(
      handlerBlock,
      /toolHandlers\["tally_ratification"\]\s*=\s*async\s*\(\s*args\s*\)\s*=>\s*\{/,
    );
    assert.match(
      handlerBlock,
      /const\s*\{\s*message_id\s*\}\s*=\s*args\s+as\s*\{\s*message_id:\s*string\s*\}/,
    );
    assert.match(
      handlerBlock,
      /requireString\(\s*"tally_ratification"\s*,\s*"message_id"\s*,\s*message_id\s*\)/,
    );
    assert.match(handlerBlock, /const\s+status\s*=\s*resolveRatification\(\s*message_id\s*\)/);
    assert.match(handlerBlock, /No such ratification/);
    assert.match(
      handlerBlock,
      /return\s+jsonResult\(\s*\{\s*status\s*,\s*tally:\s*tallyRatification\(\s*message_id\s*\)\s*\}\s*\)/,
    );
    assert.doesNotMatch(
      handlerBlock,
      /requireAllowedKeys/,
      "handler must NOT enforce additionalProperties (advertising false would be a lie)",
    );
    assert.doesNotMatch(
      handlerBlock,
      /spawnFleet|wakeAgent|fetch\(/,
    );
    // Short-form handler: no try/catch wrap (unlike cast_vote / open_ratification).
    assert.doesNotMatch(
      handlerBlock,
      /\bcatch\s*\(/,
      "tally_ratification handler is the short-form (no try/catch); adding one is a sibling-shape change that this pin must notice",
    );

    const { schema, annotations, description, comment } = extractSchemaBlock(src);
    assert.match(schema, /type:\s*"object"/);
    assert.match(schema, /message_id:\s*\{\s*type:\s*"string"\s*\}/);
    assert.match(schema, /required:\s*\[\s*"message_id"\s*\]/);
    assert.doesNotMatch(
      schema,
      /additionalProperties/,
      "advertised ROOT schema must NOT carry additionalProperties (handler does not enforce it)",
    );
    assert.match(annotations, /readOnlyHint:\s*false/);
    assert.match(annotations, /idempotentHint:\s*true/);
    assert.match(annotations, /destructiveHint:\s*false/);
    assert.match(annotations, /openWorldHint:\s*false/);
    assert.match(description, /live vote tally/);
    assert.match(description, /open \/ ratified \/ rejected \/ expired/);
    assert.match(description, /persist the status/);
    assert.match(description, /terminal state/);
    assert.match(comment, /Idempotent, not read-only/);

    // Live wire still refuses a missing message_id after the source pin.
    const response = await client.callTool({
      name: "tally_ratification",
      arguments: {},
    });
    assert.equal((response as ToolResponse).isError, true);
    assert.match(textOf(response), /tally_ratification: 'message_id' is required and must be a non-empty string/);
  });
});
