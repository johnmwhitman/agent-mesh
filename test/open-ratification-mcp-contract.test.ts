/**
 * open_ratification MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names. Honesty-pattern refresh (2026-09-12).
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `open_ratification` is the quorum-council
 * WRITE entry (src/index.ts advertised schema at L855-L880 + handler at
 * toolHandlers["open_ratification"] L2291-L2340 on origin/main 8433dcb8).
 * It broadcasts a proposal and records vote config in ONE txn. The
 * 2026-09-08 worktree (b35b915f) never landed on origin/main and mixed a
 * published-figure bump (HANDOFF 1809 -> 1816) into the same card.
 * origin/main already ships ratify.test.ts / ratify-privacy.test.ts /
 * ratify-weights.test.ts (direct core calls) but those do NOT pin
 * advertised-vs-handler honesty: additionalProperties absence, the four
 * annotations, phantom extra keys, source-string shape, or the named
 * four-governance-defect class (handler comment at L2304-L2311). This
 * card is a fresh origin/main pin with the 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — {type:object, properties:{proposer,fleet_id,
 *      subject,payload?,quorum,voters?,required_signoffs?,deadline?,
 *      silence_policy?,weights?}, required:[proposer,fleet_id,subject,quorum]}
 *      with NO additionalProperties key on the root object (advertising
 *      false would be a lie; handler has no requireAllowedKeys) +
 *      annotations {readOnlyHint:false, destructiveHint:false,
 *      idempotentHint:false, openWorldHint:false} + description names
 *      "quorum vote" / "council" / "cast_vote" / "message_id".
 *   2. required-string triad — missing / non-string / blank proposer,
 *      fleet_id, AND subject all return isError:true naming
 *      open_ratification + the field + non-empty string AND NEVER a
 *      phantom message_id (the historical defect: omitted subject wrote
 *      `undefined` as the proposal's subject).
 *   3. named four-governance-defect class — (a) voters as a bare string
 *      ("alice") refuses BEFORE openRatification (would have been spread
 *      into five single-character voters); (b) silence_policy "APPROVE"
 *      refuses (case-sensitive enum; would have silently degraded to
 *      abstain); (c) deadline as an ISO string refuses (optionalNumber;
 *      would have made now >= deadline compare false forever); (d) quorum
 *      0 / non-integer / missing refuse (requireNumber min:1 integer).
 *   4. empty-fleet jsonError after the wire gate — honest-shape call
 *      (required fields only, no voters) against an empty ledger returns
 *      isError naming the fleet id + "no recipients" and MUST NOT carry
 *      a phantom message_id.
 *   5. happy-path envelope — registerAgentInLedger seeded before child
 *      connects; well-formed call returns EXACTLY {message_id, tally}
 *      with tally.status==="open" and unique non-empty message_id.
 *   6. advertised-vs-handler honesty — phantom top-level keys
 *      (phantom_filter/debug_emit/future_field/force/nested/note) are
 *      silently ignored AND no phantom keys leak into the response.
 *      This is HONEST: additionalProperties is not advertised,
 *      handler does not enforce it.
 *   7. source-string pin — handler casts `const a = args as { proposer,
 *      fleet_id, subject, payload?, quorum, voters?, required_signoffs?,
 *      deadline?, silence_policy?, weights? }` then firstError(
 *      requireString proposer/fleet_id/subject, requireNumber quorum
 *      {min:1, integer:true}, requireStringArray voters/required_signoffs
 *      {optional:true}, optionalNumber deadline, requireEnum
 *      silence_policy ["abstain","approve"] {optional:true}) then
 *      jsonResult({ message_id, tally: tallyRatification(messageId) })
 *      with a catch jsonError, NO requireAllowedKeys, registered
 *      exactly once. Named bug class is the four-governance-defect
 *      comment (subject/voters/deadline/silence_policy).
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * WRITE-ISOLATION LAW: open_ratification writes to the ledger. Every
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

import { registerAgentInLedger, type Agent } from "../src/core.js";
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-open-ratification-mcp-20260912-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-open-ratification-20260912-${dir}`,
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
 * applyFixtureEnv MUST be called BEFORE any registerAgentInLedger in the
 * parent so the cached better-sqlite3 handle inside src/db.ts opens
 * against the tempdir, not the live ~/.config/opencode/agent-mesh.db
 * (which is on storage_schema_version=5 and would raise
 * unsupported-newer-schema). HOME points at the tempdir so any
 * discoverPremadeAgents() call the handler chain hits cannot fail from
 * a missing HOME.
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
    { name: "open-ratification-contract-test", version: "1.0.0" },
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

const OPEN_RATIFICATION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

function agent(id: string, fleetId: string): Agent {
  return { id, fleet_id: fleetId, role: "peer", prompt: "p", status: "running" };
}

function seedCouncil(fleetId: string): void {
  registerAgentInLedger(agent("proposer", fleetId));
  registerAgentInLedger(agent("voter-a", fleetId));
  registerAgentInLedger(agent("voter-b", fleetId));
}

function extractHandlerBlock(src: string): string {
  const match = src.match(/toolHandlers\["open_ratification"\][\s\S]*?^};/m);
  assert.ok(match, "open_ratification handler block must be extractable");
  return match[0];
}

function extractSchemaBlock(src: string): { schema: string; annotations: string; description: string } {
  const start = src.indexOf('name: "open_ratification"');
  assert.notEqual(start, -1, "advertised open_ratification schema block must be extractable");
  const window = src.slice(start, start + 2500);
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
  const response = await client.callTool({ name: "open_ratification", arguments: args });
  assert.notEqual(
    (response as ToolResponse).isError,
    true,
    `open_ratification must succeed; got: ${textOf(response)}`,
  );
  return bodyOf(response);
}

const HONEST_REQUIRED = {
  proposer: "proposer",
  fleet_id: "council-fleet",
  subject: "amend §4",
  quorum: 2,
} as const;

// ─── Test 1: advertised schema + annotations + description honesty ───

test("open_ratification: advertised schema requires proposer+fleet_id+subject+quorum, no additionalProperties, four annotations, description names council/cast_vote/message_id", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "open_ratification");
    assert.ok(tool, "open_ratification must be advertised");

    assert.deepEqual(tool!.inputSchema, {
      type: "object",
      properties: {
        proposer: { type: "string" },
        fleet_id: { type: "string" },
        subject: { type: "string" },
        payload: { type: "string", description: "Full proposal text (defaults to subject)" },
        quorum: { type: "number", description: "Approvals required to ratify" },
        voters: {
          type: "array",
          items: { type: "string" },
          description: "Eligible voters; defaults to every other agent in the fleet",
        },
        required_signoffs: {
          type: "array",
          items: { type: "string" },
          description: "Agents whose approval is mandatory regardless of quorum (e.g. a T5 authority)",
        },
        deadline: { type: "number", description: "Epoch ms; after it, silence_policy applies" },
        silence_policy: {
          type: "string",
          enum: ["abstain", "approve"],
          description: "How non-voters count once the deadline passes (default abstain)",
        },
        weights: {
          type: "object",
          additionalProperties: { type: "number" },
          description:
            "Tiered councils: per-voter positive-integer weights (max 1000000). Unlisted voters weigh 1, so quorum becomes a weight threshold. Weight never satisfies a required signoff.",
        },
      },
      required: ["proposer", "fleet_id", "subject", "quorum"],
    });
    // Honesty: handler ignores extra keys and has no requireAllowedKeys.
    // Advertising additionalProperties:false would be a lie. Nested
    // weights.additionalProperties is a per-key type, not a root close.
    assert.equal(
      "additionalProperties" in tool!.inputSchema,
      false,
      "root additionalProperties must be ABSENT — handler never enforces it; advertising false would be a lie",
    );

    assert.deepEqual(tool!.annotations, OPEN_RATIFICATION_ANNOTATIONS);

    const desc = tool!.description ?? "";
    assert.match(desc, /quorum vote/i);
    assert.match(desc, /council/i);
    assert.match(desc, /cast_vote/);
    assert.match(desc, /message_id/);
  });
});

// ─── Test 2: required-string triad — missing / non-string / blank ───

test("open_ratification: refuses missing / non-string / blank proposer, fleet_id, subject with a named error (never a phantom message_id)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const fields = ["proposer", "fleet_id", "subject"] as const;
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
        const args: Record<string, unknown> = { ...HONEST_REQUIRED };
        if (value === undefined) delete args[field];
        else args[field] = value;
        const response = await client.callTool({
          name: "open_ratification",
          arguments: args,
        });
        assert.equal(
          (response as ToolResponse).isError,
          true,
          `${field} ${label}: must be a tool error, not a phantom open`,
        );
        assert.match(
          textOf(response),
          new RegExp(`open_ratification: '${field}' is required and must be a non-empty string`),
          `${field} ${label}: rejection text must name open_ratification + ${field}; got: ${textOf(response)}`,
        );
        assert.doesNotMatch(
          textOf(response),
          /"message_id"/,
          `${field} ${label}: a wrong-typed required string must NOT mint a message_id; got: ${textOf(response)}`,
        );
      }
    }
  });
});

// ─── Test 3: named four-governance-defect class ───

test("open_ratification: refuses the four named governance defects (bare-string voters, APPROVE silence_policy, ISO deadline, quorum 0) BEFORE openRatification", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const cases: ReadonlyArray<{
      label: string;
      args: Record<string, unknown>;
      needle: RegExp;
    }> = [
      {
        label: "voters as bare string (five-character-voter defect)",
        args: { ...HONEST_REQUIRED, voters: "alice" },
        needle: /open_ratification: 'voters' must be an ARRAY of strings, got the bare string/,
      },
      {
        label: "voters as number",
        args: { ...HONEST_REQUIRED, voters: 3 },
        needle: /open_ratification: 'voters' must be an array of non-empty strings/,
      },
      {
        label: "silence_policy APPROVE (case-sensitive; would degrade to abstain)",
        args: { ...HONEST_REQUIRED, silence_policy: "APPROVE" },
        needle: /open_ratification: 'silence_policy' must be exactly one of abstain \| approve/,
      },
      {
        label: "silence_policy reject (unrecognized would fall through to default)",
        args: { ...HONEST_REQUIRED, silence_policy: "reject" },
        needle: /open_ratification: 'silence_policy' must be exactly one of abstain \| approve/,
      },
      {
        label: "deadline as ISO string (would never expire)",
        args: { ...HONEST_REQUIRED, deadline: "2026-09-12T00:00:00Z" },
        needle: /open_ratification: 'deadline' must be a finite number when provided/,
      },
      {
        label: "missing quorum",
        args: { proposer: "proposer", fleet_id: "council-fleet", subject: "amend §4" },
        needle: /open_ratification: 'quorum' is required and must be a finite number/,
      },
      {
        label: "quorum 0 (original non-positive defect)",
        args: { ...HONEST_REQUIRED, quorum: 0 },
        needle: /open_ratification: 'quorum' must be >= 1, got 0/,
      },
      {
        label: "quorum 1.5 (non-integer)",
        args: { ...HONEST_REQUIRED, quorum: 1.5 },
        needle: /open_ratification: 'quorum' must be an integer, got 1.5/,
      },
      {
        label: "quorum as string",
        args: { ...HONEST_REQUIRED, quorum: "2" },
        needle: /open_ratification: 'quorum' is required and must be a finite number/,
      },
    ];
    for (const { label, args, needle } of cases) {
      const response = await client.callTool({
        name: "open_ratification",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be a tool error, not a successful open`,
      );
      assert.match(
        textOf(response),
        needle,
        `${label}: rejection text must name the field; got: ${textOf(response)}`,
      );
      assert.doesNotMatch(
        textOf(response),
        /"message_id"/,
        `${label}: a governance-defect shape must NOT mint a message_id; got: ${textOf(response)}`,
      );
      assert.doesNotMatch(
        textOf(response),
        /no recipients/,
        `${label}: a type/enum/range violation must fire BEFORE the broadcast; got: ${textOf(response)}`,
      );
    }
  });
});

// ─── Test 4: empty-fleet jsonError after the wire gate ───

test("open_ratification: honest-shape call against an empty ledger returns isError naming the fleet + no recipients (never a phantom message_id)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "open_ratification",
      arguments: { ...HONEST_REQUIRED },
    });
    assert.equal(
      (response as ToolResponse).isError,
      true,
      "empty fleet must be a tool error, not a silent open",
    );
    const body = bodyOf(response);
    assert.equal(
      body.error,
      "Broadcast in fleet council-fleet has no recipients (no other agents registered)",
      `error must be exactly the no-recipients envelope, got: ${JSON.stringify(body)}`,
    );
    assert.equal(
      body.message_id,
      undefined,
      "empty-fleet refuse must NOT carry a phantom message_id",
    );
  });
});

// ─── Test 5: happy-path envelope ───

test("open_ratification: returns EXACTLY {message_id, tally} with tally.status===open", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  seedCouncil("council-fleet");

  await withChildServer(fix, async (client) => {
    const result = await callOk(client, { ...HONEST_REQUIRED });
    assert.equal(typeof result.message_id, "string");
    assert.ok(
      (result.message_id as string).length > 0,
      "message_id must be a non-empty string the cast_vote tool can target",
    );
    assert.equal(
      typeof result.tally,
      "object",
      "success must include a live tally snapshot",
    );
    const tally = result.tally as Record<string, unknown>;
    assert.equal(tally.status, "open");
    assert.equal(tally.quorum, 2);
    assert.deepEqual(
      Object.keys(result).sort(),
      ["message_id", "tally"],
      `success must return EXACTLY {message_id, tally}; got keys ${JSON.stringify(Object.keys(result).sort())}`,
    );
  });
});

// ─── Test 6: phantom extra keys silently ignored (honesty) ───

test("open_ratification: phantom extra keys are silently ignored (additionalProperties not advertised, handler does not enforce)", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  seedCouncil("council-fleet");

  await withChildServer(fix, async (client) => {
    const result = await callOk(client, {
      ...HONEST_REQUIRED,
      phantom_filter: "ignored",
      debug_emit: true,
      future_field: 42,
      force: "yes",
      nested: { a: 1 },
      note: "should be ignored",
    });
    assert.equal(typeof result.message_id, "string");
    assert.equal((result.tally as Record<string, unknown>).status, "open");
    assert.equal(result.phantom_filter, undefined);
    assert.equal(result.debug_emit, undefined);
    assert.equal(result.future_field, undefined);
    assert.equal(result.force, undefined);
    assert.equal(result.nested, undefined);
    assert.equal(result.note, undefined);
    const extraTop = Object.keys(result).filter(
      (k) => k !== "message_id" && k !== "tally",
    );
    assert.deepEqual(
      extraTop,
      [],
      `phantom keys must NOT leak into the response; extra: ${extraTop.join(",")}`,
    );
  });
});

// ─── Test 7: source-string pin ───

test("open_ratification: source-string pin — args-cast + requireString triad + requireNumber quorum min1/integer + four-governance-defect comment + jsonResult envelope, no allowedKeys", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    const registrations = src.match(/toolHandlers\["open_ratification"\]/g) ?? [];
    assert.equal(
      registrations.length,
      1,
      `handler must be registered exactly once; got ${registrations.length}`,
    );

    const handlerBlock = extractHandlerBlock(src);
    assert.match(
      handlerBlock,
      /toolHandlers\["open_ratification"\]\s*=\s*async\s*\(\s*args\s*\)\s*=>\s*\{/,
    );
    assert.match(
      handlerBlock,
      /const\s+a\s*=\s*args\s+as\s+\{/,
    );
    assert.match(
      handlerBlock,
      /requireString\(\s*"open_ratification"\s*,\s*"proposer"\s*,\s*a\.proposer\s*\)/,
    );
    assert.match(
      handlerBlock,
      /requireString\(\s*"open_ratification"\s*,\s*"fleet_id"\s*,\s*a\.fleet_id\s*\)/,
    );
    assert.match(
      handlerBlock,
      /requireString\(\s*"open_ratification"\s*,\s*"subject"\s*,\s*a\.subject\s*\)/,
    );
    assert.match(
      handlerBlock,
      /requireNumber\(\s*"open_ratification"\s*,\s*"quorum"\s*,\s*a\.quorum\s*,\s*\{\s*min:\s*1\s*,\s*integer:\s*true\s*,?\s*\}\s*\)/,
    );
    assert.match(
      handlerBlock,
      /requireStringArray\(\s*"open_ratification"\s*,\s*"voters"\s*,\s*a\.voters\s*,\s*\{\s*optional:\s*true\s*,?\s*\}\s*\)/,
    );
    assert.match(
      handlerBlock,
      /requireStringArray\(\s*"open_ratification"\s*,\s*"required_signoffs"\s*,\s*a\.required_signoffs\s*,\s*\{\s*optional:\s*true\s*,?\s*\}\s*\)/,
    );
    assert.match(
      handlerBlock,
      /optionalNumber\(\s*"open_ratification"\s*,\s*"deadline"\s*,\s*a\.deadline\s*\)/,
    );
    assert.match(
      handlerBlock,
      /requireEnum\(\s*"open_ratification"\s*,\s*"silence_policy"\s*,\s*a\.silence_policy\s*,\s*\[\s*"abstain"\s*,\s*"approve"\s*\]\s*,\s*\{\s*optional:\s*true\s*,?\s*\}\s*\)/,
    );
    assert.match(handlerBlock, /openRatification\(\s*\{/);
    assert.match(handlerBlock, /proposer:\s*a\.proposer/);
    assert.match(handlerBlock, /fleetId:\s*a\.fleet_id/);
    assert.match(handlerBlock, /subject:\s*a\.subject/);
    assert.match(handlerBlock, /payload:\s*a\.payload/);
    assert.match(handlerBlock, /quorum:\s*a\.quorum/);
    assert.match(handlerBlock, /voters:\s*a\.voters/);
    assert.match(handlerBlock, /requiredSignoffs:\s*a\.required_signoffs/);
    assert.match(handlerBlock, /deadline:\s*a\.deadline/);
    assert.match(handlerBlock, /silencePolicy:\s*a\.silence_policy/);
    assert.match(handlerBlock, /weights:\s*a\.weights/);
    assert.match(
      handlerBlock,
      /return\s+jsonResult\(\s*\{\s*message_id:\s*messageId\s*,\s*tally:\s*tallyRatification\(\s*messageId\s*\)\s*\}\s*\)/,
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
    // Named four-governance-defect comment must still document why the
    // wire gate exists.
    assert.match(handlerBlock, /Four governance defects lived here/);
    assert.match(handlerBlock, /subject` omitted wrote `undefined`/);
    assert.match(handlerBlock, /voters: "alice"/);
    assert.match(handlerBlock, /five single-character voters/);
    assert.match(handlerBlock, /deadline` as an ISO string/);
    assert.match(handlerBlock, /silence_policy: "APPROVE"/);

    const { schema, annotations, description } = extractSchemaBlock(src);
    assert.match(schema, /type:\s*"object"/);
    assert.match(schema, /proposer:\s*\{\s*type:\s*"string"\s*\}/);
    assert.match(schema, /fleet_id:\s*\{\s*type:\s*"string"\s*\}/);
    assert.match(schema, /subject:\s*\{\s*type:\s*"string"\s*\}/);
    assert.match(schema, /required:\s*\[\s*"proposer"\s*,\s*"fleet_id"\s*,\s*"subject"\s*,\s*"quorum"\s*\]/);
    assert.doesNotMatch(
      schema.replace(/weights:\s*\{[\s\S]*?additionalProperties[\s\S]*?\}/, ""),
      /additionalProperties/,
      "advertised ROOT schema must NOT carry additionalProperties (handler does not enforce it)",
    );
    assert.match(annotations, /readOnlyHint:\s*false/);
    assert.match(annotations, /destructiveHint:\s*false/);
    assert.match(annotations, /idempotentHint:\s*false/);
    assert.match(annotations, /openWorldHint:\s*false/);
    assert.match(description, /quorum vote/);
    assert.match(description, /council/);
    assert.match(description, /cast_vote/);
    assert.match(description, /message_id/);

    // Live wire still refuses a missing subject after the source pin.
    const response = await client.callTool({
      name: "open_ratification",
      arguments: { proposer: "proposer", fleet_id: "council-fleet", quorum: 2 },
    });
    assert.equal((response as ToolResponse).isError, true);
    assert.match(
      textOf(response),
      /open_ratification: 'subject' is required and must be a non-empty string/,
    );
  });
});
