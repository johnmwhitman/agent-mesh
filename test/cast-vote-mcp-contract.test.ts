/**
 * cast_vote MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names. Honesty-pattern refresh (2026-09-12).
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `cast_vote` is the council WRITE that
 * records a vote (src/index.ts advertised schema at L915-L928 + handler at
 * toolHandlers["cast_vote"] L2375-L2401 on origin/main 8433dcb8).
 * It is the highest-blast-radius member of the typed-but-unenforced family:
 * every council member calls it, and the truthiness-vs-strict-boolean
 * divide is the exact failure mode named at tool-args.ts (omitting
 * `approve` recorded a binding DECLINE; `approve: "false"` recorded an
 * APPROVAL — a polarity inversion on a council vote). The 2026-09-08
 * worktree (5e39d4b8) and 2026-09-11 worktree (d3b0b5a7) never landed on
 * origin/main. origin/main already ships ratify.test.ts (direct core
 * calls) and tool-boundary-validation.test.ts (in-process handler) but
 * those do NOT pin advertised-vs-handler honesty: additionalProperties
 * absence, the four annotations (idempotentHint=true is load-bearing),
 * phantom extra keys, source-string shape, or the named truthiness-
 * footgun class. This card is a fresh origin/main pin with the
 * 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — {type:object, properties:{agent_id,
 *      message_id, approve, note?}, required:[agent_id, message_id,
 *      approve]} with NO additionalProperties key (advertising false
 *      would be a lie; handler has no requireAllowedKeys) +
 *      annotations {idempotentHint:true, readOnlyHint:false,
 *      destructiveHint:false, openWorldHint:false} + description names
 *      "Cast a vote" / "approve=true" / "Re-casting" / "no-op".
 *   2. required-string dyad — missing / non-string / blank agent_id
 *      AND message_id all return isError:true naming cast_vote + the
 *      field + non-empty string AND NEVER a phantom ok:true (the
 *      historical defect: omitted agent_id wrote `undefined` as the
 *      voter, collapsing every vote onto one ledger row).
 *   3. named truthiness-footgun class — approve as "false" / "" / 0 /
 *      1 / null / [] / {} / omitted all refuse BEFORE castVote with
 *      the anti-footgun token "Refusing to guess a vote" (a truthiness
 *      reading would record "false" as an APPROVAL and an omitted
 *      value as a DECLINE).
 *   4. missing-ratification jsonError after the wire gate — honest-
 *      shape call (required fields only, boolean approve) against an
 *      empty ledger returns isError naming "No such ratification" and
 *      MUST NOT carry ok:true.
 *   5. happy-path envelope — open_ratification(voters=["alice"],
 *      quorum=1) then cast_vote(alice, true) returns EXACTLY
 *      {ok, status, tally} with status==="ratified" and
 *      tally.approvals===["alice"].
 *   6. advertised-vs-handler honesty — phantom top-level keys
 *      (phantom_filter/debug_emit/future_field/force/nested) are
 *      silently ignored AND no phantom keys leak into the response.
 *      This is HONEST: additionalProperties is not advertised,
 *      handler does not enforce it.
 *   7. source-string pin — handler destructures
 *      `{ agent_id, message_id, approve, note }` then firstError(
 *      requireString agent_id/message_id) then typeof approve !==
 *      "boolean" with the anti-footgun message, then
 *      jsonResult({ ok, status: resolveRatification(message_id),
 *      tally: tallyRatification(message_id) }) with a catch jsonError,
 *      NO requireAllowedKeys. Named bug class is the "Refusing to
 *      guess a vote" comment.
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * WRITE-ISOLATION LAW: cast_vote writes to the ledger. Every run that
 * opens a child sets ALL THREE of MESHFLEET_DB_FILE, MESHFLEET_DATA_FILE,
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-cast-vote-mcp-20260912-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-cast-vote-20260912-${dir}`,
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
    { name: "cast-vote-contract-test", version: "1.0.0" },
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

const CAST_VOTE_ANNOTATIONS = {
  idempotentHint: true,
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

function extractHandlerBlock(src: string): string {
  const match = src.match(/toolHandlers\["cast_vote"\][\s\S]*?^};/m);
  assert.ok(match, "cast_vote handler block must be extractable");
  return match[0];
}

function extractSchemaBlock(src: string): {
  schema: string;
  annotations: string;
  description: string;
} {
  const start = src.indexOf('name: "cast_vote"');
  assert.notEqual(start, -1, "advertised cast_vote schema block must be extractable");
  const window = src.slice(start, start + 1800);
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

async function openOneVoterCouncil(client: Client): Promise<string> {
  const response = await client.callTool({
    name: "open_ratification",
    arguments: {
      proposer: "carol",
      fleet_id: "fleet-x",
      subject: "single-vote",
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
  const response = await client.callTool({ name: "cast_vote", arguments: args });
  assert.notEqual(
    (response as ToolResponse).isError,
    true,
    `cast_vote must succeed; got: ${textOf(response)}`,
  );
  return bodyOf(response);
}

// ─── Test 1: advertised schema + annotations + description honesty ───

test("cast_vote: advertised schema requires agent_id+message_id+approve, no additionalProperties, four annotations with idempotentHint=true, description names Cast a vote / approve=true / Re-casting / no-op", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "cast_vote");
    assert.ok(tool, "cast_vote must be advertised");

    assert.deepEqual(tool!.inputSchema, {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        message_id: { type: "string" },
        approve: { type: "boolean" },
        note: { type: "string" },
      },
      required: ["agent_id", "message_id", "approve"],
    });
    // Honesty: handler ignores extra keys and has no requireAllowedKeys.
    // Advertising additionalProperties:false would be a lie.
    assert.equal(
      "additionalProperties" in tool!.inputSchema,
      false,
      "root additionalProperties must be ABSENT — handler never enforces it; advertising false would be a lie",
    );

    assert.deepEqual(tool!.annotations, CAST_VOTE_ANNOTATIONS);

    const desc = tool!.description ?? "";
    assert.match(desc, /Cast a vote/);
    assert.match(desc, /approve=true/);
    assert.match(desc, /Re-casting/);
    assert.match(desc, /no-op/);
  });
});

// ─── Test 2: required-string dyad — missing / non-string / blank ───

test("cast_vote: refuses missing / non-string / blank agent_id and message_id with a named error (never a phantom ok:true vote)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const fields = ["agent_id", "message_id"] as const;
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
    for (const field of fields) {
      for (const { label, value } of shapes) {
        const args: Record<string, unknown> = {
          agent_id: "alice",
          message_id: "msg-placeholder",
          approve: true,
        };
        if (value === undefined) delete args[field];
        else args[field] = value;
        const response = await client.callTool({
          name: "cast_vote",
          arguments: args,
        });
        assert.equal(
          (response as ToolResponse).isError,
          true,
          `${field} ${label}: must be a tool error, not a phantom vote`,
        );
        assert.match(
          textOf(response),
          new RegExp(`cast_vote: '${field}' is required and must be a non-empty string`),
          `${field} ${label}: rejection text must name cast_vote + ${field}; got: ${textOf(response)}`,
        );
        assert.doesNotMatch(
          textOf(response),
          /"ok"\s*:\s*true/,
          `${field} ${label}: a wrong-typed required string must NOT bank a vote; got: ${textOf(response)}`,
        );
      }
    }
  });
});

// ─── Test 3: named truthiness-footgun class ───

test("cast_vote: refuses the named truthiness-footgun class (approve as 'false'/''/0/1/null/[]/{}/omitted) BEFORE castVote", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const cases: ReadonlyArray<{ label: string; approve?: unknown }> = [
      { label: 'approve as string "false" (truthy → APPROVAL under truthiness)', approve: "false" },
      { label: "approve as empty string (falsy → DECLINE under truthiness)", approve: "" },
      { label: "approve as 0 (falsy → DECLINE under truthiness)", approve: 0 },
      { label: "approve as 1 (truthy → APPROVAL under truthiness)", approve: 1 },
      { label: "approve as null", approve: null },
      { label: "approve as array", approve: [] },
      { label: "approve as object", approve: {} },
      { label: "approve omitted (falsy → DECLINE under truthiness)" },
    ];
    for (const c of cases) {
      const args: Record<string, unknown> = {
        agent_id: "alice",
        message_id: "msg-placeholder",
      };
      if ("approve" in c) args.approve = c.approve;
      const response = await client.callTool({
        name: "cast_vote",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${c.label}: must be a tool error, not a guessed vote`,
      );
      assert.match(
        textOf(response),
        /Refusing to guess a vote/,
        `${c.label}: rejection text must carry the anti-footgun token; got: ${textOf(response)}`,
      );
      assert.match(
        textOf(response),
        /must be a boolean/,
        `${c.label}: rejection text must name the type expectation; got: ${textOf(response)}`,
      );
      assert.doesNotMatch(
        textOf(response),
        /No such ratification/,
        `${c.label}: a type violation must fire BEFORE castVote; got: ${textOf(response)}`,
      );
      assert.doesNotMatch(
        textOf(response),
        /"ok"\s*:\s*true/,
        `${c.label}: a guessed vote must NOT bank ok:true; got: ${textOf(response)}`,
      );
    }
  });
});

// ─── Test 4: missing-ratification jsonError after the wire gate ───

test("cast_vote: honest-shape call against a missing ratification returns isError naming No such ratification (never ok:true)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "cast_vote",
      arguments: {
        agent_id: "alice",
        message_id: "msg-does-not-exist-xyz",
        approve: true,
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
    assert.notEqual(body.ok, true, "missing-ratification refuse must NOT carry ok:true");
    assert.equal(body.status, undefined, "missing-ratification refuse must NOT carry a phantom status");
    assert.equal(body.tally, undefined, "missing-ratification refuse must NOT carry a stub tally");
  });
});

// ─── Test 5: happy-path envelope ───

test("cast_vote: returns EXACTLY {ok, status, tally} with status===ratified and approvals=['alice'] on a 1-voter quorum=1 council", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const messageId = await openOneVoterCouncil(client);
    const result = await callOk(client, {
      agent_id: "alice",
      message_id: messageId,
      approve: true,
    });
    assert.deepEqual(
      Object.keys(result).sort(),
      ["ok", "status", "tally"],
      `success must return EXACTLY {ok, status, tally}; got keys ${JSON.stringify(Object.keys(result).sort())}`,
    );
    assert.equal(result.ok, true);
    assert.equal(
      result.status,
      "ratified",
      `quorum=1 with a single approval must persist status='ratified'; got ${JSON.stringify(result.status)}`,
    );
    const tally = result.tally as Record<string, unknown>;
    assert.deepEqual(tally.approvals, ["alice"]);
    assert.deepEqual(tally.declines, []);
    assert.deepEqual(tally.pending, []);
    assert.equal(tally.status, "ratified");
    assert.equal(tally.quorum, 1);
  });
});

// ─── Test 6: phantom extra keys silently ignored (honesty) ───

test("cast_vote: phantom extra keys are silently ignored (additionalProperties not advertised, handler does not enforce)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const messageId = await openOneVoterCouncil(client);
    const result = await callOk(client, {
      agent_id: "alice",
      message_id: messageId,
      approve: true,
      phantom_filter: "ignored",
      debug_emit: true,
      future_field: 42,
      force: "yes",
      nested: { a: 1 },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "ratified");
    assert.equal(result.phantom_filter, undefined);
    assert.equal(result.debug_emit, undefined);
    assert.equal(result.future_field, undefined);
    assert.equal(result.force, undefined);
    assert.equal(result.nested, undefined);
    const extraTop = Object.keys(result).filter(
      (k) => k !== "ok" && k !== "status" && k !== "tally",
    );
    assert.deepEqual(
      extraTop,
      [],
      `phantom keys must NOT leak into the response; extra: ${extraTop.join(",")}`,
    );
  });
});

// ─── Test 7: source-string pin ───

test("cast_vote: source-string pin — args-destructure + requireString dyad + typeof-boolean anti-footgun + jsonResult envelope, no allowedKeys", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    const registrations = src.match(/toolHandlers\["cast_vote"\]/g) ?? [];
    assert.equal(
      registrations.length,
      1,
      `handler must be registered exactly once; got ${registrations.length}`,
    );

    const handlerBlock = extractHandlerBlock(src);
    assert.match(
      handlerBlock,
      /toolHandlers\["cast_vote"\]\s*=\s*async\s*\(\s*args\s*\)\s*=>\s*\{/,
    );
    assert.match(
      handlerBlock,
      /const\s*\{\s*agent_id\s*,\s*message_id\s*,\s*approve\s*,\s*note\s*\}\s*=\s*args\s+as\s*\{/,
    );
    assert.match(
      handlerBlock,
      /requireString\(\s*"cast_vote"\s*,\s*"agent_id"\s*,\s*agent_id\s*\)/,
    );
    assert.match(
      handlerBlock,
      /requireString\(\s*"cast_vote"\s*,\s*"message_id"\s*,\s*message_id\s*\)/,
    );
    assert.match(handlerBlock, /const\s+bad\s*=\s*firstError\(/);
    assert.match(handlerBlock, /typeof\s+approve\s*!==\s*"boolean"/);
    assert.match(handlerBlock, /Refusing to guess a vote/);
    assert.match(
      handlerBlock,
      /truthiness reading would record/,
    );
    assert.match(
      handlerBlock,
      /castVote\(\s*agent_id\s*,\s*message_id\s*,\s*approve\s*,\s*note\s*\)/,
    );
    assert.match(handlerBlock, /No such ratification/);
    assert.match(
      handlerBlock,
      /return\s+jsonResult\(\s*\{\s*ok\s*,\s*status:\s*resolveRatification\(\s*message_id\s*\)\s*,\s*tally:\s*tallyRatification\(\s*message_id\s*\)\s*\}\s*\)/,
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
      /spawnFleet|wakeAgent|fetch\(/,
    );

    const { schema, annotations, description } = extractSchemaBlock(src);
    assert.match(schema, /type:\s*"object"/);
    assert.match(schema, /agent_id:\s*\{\s*type:\s*"string"\s*\}/);
    assert.match(schema, /message_id:\s*\{\s*type:\s*"string"\s*\}/);
    assert.match(schema, /approve:\s*\{\s*type:\s*"boolean"\s*\}/);
    assert.match(schema, /note:\s*\{\s*type:\s*"string"\s*\}/);
    assert.match(
      schema,
      /required:\s*\[\s*"agent_id"\s*,\s*"message_id"\s*,\s*"approve"\s*\]/,
    );
    assert.doesNotMatch(
      schema,
      /additionalProperties/,
      "advertised ROOT schema must NOT carry additionalProperties (handler does not enforce it)",
    );
    assert.match(annotations, /idempotentHint:\s*true/);
    assert.match(annotations, /readOnlyHint:\s*false/);
    assert.match(annotations, /destructiveHint:\s*false/);
    assert.match(annotations, /openWorldHint:\s*false/);
    assert.match(description, /Cast a vote/);
    assert.match(description, /approve=true/);
    assert.match(description, /Re-casting/);
    assert.match(description, /no-op/);

    // Live wire still refuses a missing approve after the source pin.
    const response = await client.callTool({
      name: "cast_vote",
      arguments: { agent_id: "alice", message_id: "msg-placeholder" },
    });
    assert.equal((response as ToolResponse).isError, true);
    assert.match(textOf(response), /Refusing to guess a vote/);
  });
});
