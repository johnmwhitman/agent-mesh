/**
 * register_capability MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names. Honesty-pattern refresh (2026-09-12).
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `register_capability` is the WRITE surface
 * of the routing stack: every downstream `route_work` /
 * `recommend_route` / `compile_route_candidates` call scores the row this
 * tool writes (src/index.ts advertised schema at L952-L970 + handler at
 * toolHandlers["register_capability"] L2416-L2458 on origin/main 8433dcb8).
 * The 2026-09-09 worktree (345e9ee3) never landed on origin/main. origin/main
 * already ships register-capability-mcp.test.ts (snake_case wire path, 2
 * tests) and register-capability-refusal-mcp.test.ts (fleet-mismatch refusal,
 * 1 test) but those do NOT pin advertised-vs-handler honesty:
 * additionalProperties absence, the four annotations together, phantom extra
 * keys, source-string shape, or the named bug class (blind `args as {…}`
 * destructure-cast that lost snake_case→camelCase mapping, wrote a row keyed
 * "undefined", returned {ok:true}). This card is a fresh origin/main pin
 * with the 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — six named fields (agent_id string minLength=1,
 *      fleet_id string minLength=1, role string minLength=1, skills array of
 *      strings, model string, context_window number) + required=[agent_id,
 *      fleet_id, role, skills] + NO additionalProperties key (advertising
 *      false would be a lie; handler has no requireAllowedKeys) + annotations
 *      {idempotentHint:true, readOnlyHint:false, destructiveHint:false,
 *      openWorldHint:false} + description names "Register an agent's
 *      capabilities" / "role, skills, model" / "routing".
 *   2. wire-boundary refusal of the four REQUIRED fields — every non-string
 *      shape for agent_id/fleet_id/role (missing, empty, whitespace, null,
 *      number, boolean, array, object) and bad skills shapes (missing,
 *      bare-string, array-of-numbers, mixed-array, object, boolean, null)
 *      return isError naming register_capability + the field; NO row is
 *      written. The SDK does NOT enforce required; the handler's try/catch
 *      around registerCapability surfaces the throw as a readable jsonError.
 *   3. named poisoned-row class — agent_id of the literal string "undefined"
 *      or "null" is refused (would coerce to JS undefined/null via
 *      capabilities[undefined] and resurrect the exact poisoned-row bug this
 *      guard exists to prevent; isUsableAgentId rejects these in core.ts).
 *   4. optional field validation — context_window: "big" (string) refused as
 *      isError naming "finite number"; model: "" or "  " refused as isError
 *      naming "non-empty string"; model: 42 (non-string) refused; absent
 *      model/context_window is fine and yields a row with model=undefined,
 *      context_window=undefined. Optional means omittable, never any-typed.
 *   5. happy-path envelope — well-formed call returns EXACTLY
 *      {ok:true, agent_id, fleet_id} (three-key shape), the row is queryable
 *      via loadData().capabilities, and a follow-up route_work ranks the new
 *      agent (write→read round-trip).
 *   6. advertised-vs-handler honesty — phantom top-level keys
 *      (phantom_filter/debug_emit/future_field/force/nested/note) are
 *      silently ignored AND no phantom keys leak into the response. This is
 *      HONEST: additionalProperties is not advertised, handler does not
 *      enforce it (no requireAllowedKeys).
 *   7. source-string pin — handler destructure-casts
 *      `const { agent_id, fleet_id, role, skills, model, context_window } =
 *      args as {…}` then `firstError(optionalNonBlankString("register_capability",
 *      "model", model), optionalNumber("register_capability",
 *      "context_window", context_window))` then try/catch around
 *      registerCapability({agentId, fleetId, role, skills, model,
 *      contextWindow}) → jsonError(err) on throw → return jsonResult({ ok:
 *      true, agent_id, fleet_id }) with NO requireAllowedKeys, NO
 *      spawnFleet/wakeAgent/fetch, registered exactly once.
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * WRITE-ISOLATION LAW: register_capability writes to the ledger. Every run
 * that opens a child sets ALL THREE of MESHFLEET_DB_FILE,
 * MESHFLEET_DATA_FILE, MESHFLEET_EVENT_LOG_FILE to temp paths — never the
 * live ~/.config/opencode/agent-mesh.db.
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

import { loadData, registerAgentInLedger, type Agent } from "../src/core.js";
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
    join(tmpdir(), "meshfleet-register-capability-mcp-20260912-"),
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-register-capability-20260912-${dir}`,
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
    { name: "register-capability-contract-test", version: "1.0.0" },
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

const REGISTER_CAPABILITY_ANNOTATIONS = {
  idempotentHint: true,
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

function extractHandlerBlock(src: string): string {
  const match = src.match(/toolHandlers\["register_capability"\][\s\S]*?^};/m);
  assert.ok(match, "register_capability handler block must be extractable");
  return match[0];
}

function extractSchemaBlock(src: string): {
  schema: string;
  annotations: string;
  description: string;
} {
  const start = src.indexOf('name: "register_capability"');
  assert.notEqual(
    start,
    -1,
    "advertised register_capability schema block must be extractable",
  );
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

/**
 * A minimal Agent for registerAgentInLedger seeding. The child uses
 * `data.agents[input.agentId]` only to enforce the fleet/agent mismatch
 * check. The success test avoids seeding any agents at all so the
 * write-path validation passes against the empty store.
 */
const fixtureAgent = (id: string, fleetId: string): Agent => ({
  id,
  fleet_id: fleetId,
  role: `${id}-role`,
  prompt: `${id}-prompt`,
  status: "running",
});

async function callRaw(
  client: Client,
  args: Record<string, unknown>,
) {
  return client.callTool({ name: "register_capability", arguments: args });
}

async function callOk(
  client: Client,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await callRaw(client, args);
  assert.notEqual(
    isErrorEnvelope(response),
    true,
    `register_capability must succeed; got: ${textOf(response)}`,
  );
  return bodyOf(response);
}

// ─── Test 1: advertised schema + annotations + description honesty ───

test("register_capability: advertised schema pins six named fields, required array, no additionalProperties, four annotations with idempotentHint=true + readOnlyHint=false, description names Register/role, skills, model/routing", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "register_capability");
    assert.ok(tool, "register_capability must be advertised");

    const schema = tool!.inputSchema as Record<string, unknown>;
    assert.equal(schema.type, "object");
    const props = schema.properties as Record<string, Record<string, unknown>>;
    // Every documented field is present and typed.
    assert.equal(props.agent_id.type, "string");
    assert.equal(props.agent_id.minLength, 1);
    assert.equal(props.fleet_id.type, "string");
    assert.equal(props.fleet_id.minLength, 1);
    assert.equal(props.role.type, "string");
    assert.equal(props.role.minLength, 1);
    assert.equal(props.skills.type, "array");
    assert.deepEqual(props.skills.items, { type: "string" });
    assert.equal(props.model.type, "string");
    assert.equal(props.context_window.type, "number");
    // required is the published contract.
    assert.deepEqual(
      [...(schema.required as string[])].sort(),
      ["agent_id", "fleet_id", "role", "skills"],
    );
    // Honesty: handler ignores extra keys and has no requireAllowedKeys.
    // Advertising additionalProperties:false would be a lie.
    assert.equal(
      "additionalProperties" in schema,
      false,
      "root additionalProperties must be ABSENT — handler never enforces it; advertising false would be a lie",
    );

    assert.deepEqual(tool!.annotations, REGISTER_CAPABILITY_ANNOTATIONS);
    assert.equal(
      tool!.annotations?.readOnlyHint,
      false,
      "register_capability writes to the ledger — readOnlyHint must be false (the named lie class)",
    );
    assert.equal(
      tool!.annotations?.idempotentHint,
      true,
      "registering twice is a no-op overwrite of the same row — idempotentHint must be true",
    );

    const desc = tool!.description ?? "";
    assert.match(desc, /Register an agent's capabilities/);
    assert.match(desc, /role, skills, model/);
    assert.match(desc, /routing/);
  });
});

// ─── Test 2: wire-boundary refusal of the four REQUIRED fields ───

test("register_capability: every non-string shape for agent_id/fleet_id/role and bad skills shapes are refused as isError envelopes naming the field; no row is written", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  registerAgentInLedger(fixtureAgent("seed", "fleet-seed"));
  try {
    await withChildServer(fix, async (client) => {
      const badStringShapes: ReadonlyArray<{ label: string; value: unknown }> = [
        { label: "missing", value: undefined },
        { label: "empty", value: "" },
        { label: "whitespace", value: "   " },
        { label: "null", value: null },
        { label: "number", value: 42 },
        { label: "boolean", value: true },
        { label: "array", value: [] },
        { label: "object", value: {} },
      ];
      // Reject every bad shape for agent_id / fleet_id / role (the three
      // required strings). The handler throws from inside registerCapability
      // and the try/catch wraps it in a jsonError envelope.
      for (const field of ["agent_id", "fleet_id", "role"] as const) {
        for (const { label, value } of badStringShapes) {
          const args: Record<string, unknown> = {
            agent_id: "seed",
            fleet_id: "fleet-seed",
            role: "seed-role",
            skills: ["typescript"],
          };
          if (value === undefined) delete args[field];
          else args[field] = value;
          const r = await callRaw(client, args);
          assert.equal(
            isErrorEnvelope(r),
            true,
            `${field}=${label} (${JSON.stringify(value)}) must be an error envelope`,
          );
          const t = errorText(r);
          assert.match(t, /register_capability/, "error must name the tool");
          assert.match(
            t,
            new RegExp(field),
            `error must name the field ${field}`,
          );
          assert.doesNotMatch(
            t,
            /"ok"\s*:\s*true/,
            `${field}=${label}: a wrong-typed required string must NOT bank ok:true; got: ${t}`,
          );
        }
      }
      // Bad shapes for `skills` (required string array):
      const badSkills: ReadonlyArray<{
        label: string;
        value: unknown;
      }> = [
        { label: "missing", value: undefined },
        { label: "bare-string", value: "typescript" },
        { label: "array-of-numbers", value: [1, 2, 3] },
        { label: "mixed-array", value: ["ts", 1, true] },
        { label: "object", value: { ts: true } },
        { label: "boolean", value: true },
        { label: "null", value: null },
      ];
      for (const { label, value } of badSkills) {
        const args: Record<string, unknown> = {
          agent_id: "seed",
          fleet_id: "fleet-seed",
          role: "seed-role",
          skills: value,
        };
        if (value === undefined) delete args.skills;
        const r = await callRaw(client, args);
        assert.equal(
          isErrorEnvelope(r),
          true,
          `skills=${label} (${JSON.stringify(value)}) must be an error envelope`,
        );
        assert.match(
          errorText(r),
          /skills/,
          "error must name the field skills",
        );
      }
      // After all of the above rejections, NO capability row must exist.
      const before = loadData();
      assert.equal(
        Object.keys(before.capabilities).length,
        0,
        `no capability row must be written from rejected calls, got ${JSON.stringify(Object.keys(before.capabilities))}`,
      );
    });
  } finally {
    closeDb();
    rmSync(fix.dir, { recursive: true, force: true });
    clearFixtureEnv();
  }
});

// ─── Test 3: named poisoned-row class — "undefined"/"null" agent_id refused ───

test("register_capability: agent_id of the literal string 'undefined' or 'null' is refused (would coerce to JS undefined/null via capabilities[undefined] and resurrect the poisoned-row bug)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    for (const bad of ["undefined", "null"]) {
      const r = await callRaw(client, {
        agent_id: bad,
        fleet_id: "f",
        role: "r",
        skills: ["s"],
      });
      assert.equal(
        isErrorEnvelope(r),
        true,
        `agent_id=${JSON.stringify(bad)} must be an error envelope`,
      );
      assert.match(errorText(r), /register_capability/);
      assert.match(errorText(r), /agent_id/);
      assert.doesNotMatch(
        errorText(r),
        /"ok"\s*:\s*true/,
        `agent_id=${bad}: must NOT bank ok:true on a poisoned-id refusal`,
      );
    }
    // The capabilities map must still be empty — the refusal happened
    // BEFORE registerCapability wrote a row.
    const after = loadData();
    assert.equal(
      Object.keys(after.capabilities).length,
      0,
      `no poisoned row must be written from 'undefined'/'null' agent_id, got ${JSON.stringify(Object.keys(after.capabilities))}`,
    );
  });
});

// ─── Test 4: optional field validation (model + context_window) ───

test("register_capability: context_window string is refused, model empty/whitespace/non-string is refused, both absent is fine", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    // context_window: "big" must be refused — the optional means omittable
    // not any-typed; a non-numeric value would silently match nothing.
    const rBadCw = await callRaw(client, {
      agent_id: "a",
      fleet_id: "f",
      role: "r",
      skills: ["s"],
      context_window: "big",
    });
    assert.equal(
      isErrorEnvelope(rBadCw),
      true,
      `context_window="big" must be an error envelope, got ${JSON.stringify(rBadCw)}`,
    );
    assert.match(errorText(rBadCw), /context_window/);
    assert.match(errorText(rBadCw), /finite number/);

    // model: "" must be refused — optional non-blank means omittable or
    // non-blank; "" would silently write model="" and break callers that
    // read cap.model to decide routing.
    const rBadModel = await callRaw(client, {
      agent_id: "b",
      fleet_id: "f",
      role: "r",
      skills: ["s"],
      model: "",
    });
    assert.equal(
      isErrorEnvelope(rBadModel),
      true,
      `model="" must be an error envelope, got ${JSON.stringify(rBadModel)}`,
    );
    assert.match(errorText(rBadModel), /model/);

    // model: "   " (whitespace) must be refused.
    const rBadModelWs = await callRaw(client, {
      agent_id: "b2",
      fleet_id: "f",
      role: "r",
      skills: ["s"],
      model: "   ",
    });
    assert.equal(
      isErrorEnvelope(rBadModelWs),
      true,
      `model="   " must be an error envelope`,
    );
    assert.match(errorText(rBadModelWs), /model/);

    // model: 42 (non-string) must be refused.
    const rBadModelNum = await callRaw(client, {
      agent_id: "c",
      fleet_id: "f",
      role: "r",
      skills: ["s"],
      model: 42,
    });
    assert.equal(
      isErrorEnvelope(rBadModelNum),
      true,
      `model=42 must be an error envelope`,
    );
    assert.match(errorText(rBadModelNum), /model/);

    // Absent optional fields — must succeed and the row has model=undefined
    // and context_window=undefined.
    const rOk = await callOk(client, {
      agent_id: "d",
      fleet_id: "f",
      role: "r",
      skills: ["s"],
    });
    assert.deepEqual(
      Object.keys(rOk).sort(),
      ["agent_id", "fleet_id", "ok"],
      `absent optional fields must still return EXACTLY {ok, agent_id, fleet_id}, got keys ${JSON.stringify(Object.keys(rOk).sort())}`,
    );
    const after = loadData();
    assert.equal(after.capabilities["d"]?.agent_id, "d");
    assert.equal(after.capabilities["d"]?.model, undefined);
    assert.equal(after.capabilities["d"]?.context_window, undefined);
  });
});

// ─── Test 5: happy-path — row written, queryable, route_work round-trip ───

test("register_capability: valid call returns EXACTLY {ok:true, agent_id, fleet_id}, writes the row, and route_work ranks the new agent", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const r = await callRaw(client, {
      agent_id: "writer-1",
      fleet_id: "fleet-w",
      role: "router",
      skills: ["typescript", "agent-mesh"],
      model: "minimax/m3",
      context_window: 200000,
    });
    assert.notEqual(
      isErrorEnvelope(r),
      true,
      `valid register_capability must succeed, got ${JSON.stringify(r)}`,
    );
    const body = bodyOf(r);
    // EXACTLY three top-level keys. A regression that wrapped the
    // payload, added `role`/`skills` (a tempting echo), or dropped `ok`
    // would be caught here.
    assert.deepEqual(
      Object.keys(body).sort(),
      ["agent_id", "fleet_id", "ok"],
      `register_capability success must return EXACTLY {ok, agent_id, fleet_id}, got keys ${JSON.stringify(Object.keys(body).sort())}`,
    );
    assert.equal(body.ok, true);
    assert.equal(body.agent_id, "writer-1");
    assert.equal(body.fleet_id, "fleet-w");
    // The row IS in the ledger — visible to the parent's loadData
    // (parent + child share MESHFLEET_DB_FILE, so the child's write
    // is read-back-able after the call returns).
    const after = loadData();
    const row = after.capabilities["writer-1"];
    assert.ok(row, "writer-1 capability row must be written");
    assert.equal(row.agent_id, "writer-1");
    assert.equal(row.fleet_id, "fleet-w");
    assert.equal(row.role, "router");
    assert.deepEqual(row.skills, ["typescript", "agent-mesh"]);
    assert.equal(row.model, "minimax/m3");
    assert.equal(row.context_window, 200000);
    // End-to-end: route_work ranks the new agent.
    const routed = await client.callTool({
      name: "route_work",
      arguments: { description: "agent mesh typescript dispatch" },
    });
    assert.notEqual(
      isErrorEnvelope(routed),
      true,
      `route_work must succeed, got ${textOf(routed)}`,
    );
    const routedBody = bodyOf(routed);
    const matches = routedBody.matches as Array<Record<string, unknown>>;
    assert.ok(
      Array.isArray(matches) && matches.length >= 1,
      `route_work must return at least one match for the registered agent, got ${JSON.stringify(routedBody)}`,
    );
    assert.equal(
      matches[0]?.agent_id,
      "writer-1",
      `writer-1 must rank first on a description matching role/skills, got ${JSON.stringify(matches[0])}`,
    );
  });
});

// ─── Test 6: phantom extra keys silently ignored (honesty) ───

test("register_capability: phantom top-level args are silently ignored, success shape is unchanged, and the row is still written (additionalProperties not advertised, handler does not enforce)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const r = await callRaw(client, {
      agent_id: "phantom-1",
      fleet_id: "fleet-p",
      role: "router",
      skills: ["x"],
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
    // EXACTLY three keys — phantom args must not surface in the
    // response.
    assert.deepEqual(
      Object.keys(body).sort(),
      ["agent_id", "fleet_id", "ok"],
      `phantom args must NOT change the success shape, got keys ${JSON.stringify(Object.keys(body).sort())}`,
    );
    assert.equal(body.ok, true);
    assert.equal(body.agent_id, "phantom-1");
    assert.equal(body.fleet_id, "fleet-p");
    // No phantom keys leaked.
    assert.equal(body.phantom_filter, undefined);
    assert.equal(body.debug_emit, undefined);
    assert.equal(body.future_field, undefined);
    assert.equal(body.force, undefined);
    assert.equal(body.nested, undefined);
    assert.equal(body.note, undefined);
    // The row is still written — phantom args do not cancel the write.
    const after = loadData();
    assert.ok(
      after.capabilities["phantom-1"],
      `phantom-1 capability row must still be written, got ${JSON.stringify(Object.keys(after.capabilities))}`,
    );
  });
});

// ─── Test 7: source-string pin ───

test("register_capability: source-string pin — handler destructures six fields, validates optional model/context_window, wraps registerCapability in try/catch, returns jsonResult({ok:true, agent_id, fleet_id}), no requireAllowedKeys", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    const registrations =
      src.match(/toolHandlers\["register_capability"\]/g) ?? [];
    assert.equal(
      registrations.length,
      1,
      `handler must be registered exactly once; got ${registrations.length}`,
    );

    const handlerBlock = extractHandlerBlock(src);
    assert.match(
      handlerBlock,
      /toolHandlers\["register_capability"\]\s*=\s*async\s*\(\s*args\s*\)\s*=>\s*\{/,
    );
    // The explicit destructure of all six named fields — the historic bug
    // was a pass-through cast that lost the snake_case→camelCase mapping.
    assert.ok(
      /const\s*\{\s*agent_id\s*,\s*fleet_id\s*,\s*role\s*,\s*skills\s*,\s*model\s*,\s*context_window\s*\}\s*=\s*args/.test(
        handlerBlock,
      ),
      `handler must explicitly destructure all six fields — block=${JSON.stringify(handlerBlock.slice(0, 600))}`,
    );
    // The optional-field validation pair.
    assert.ok(
      /optionalNonBlankString\(\s*"register_capability"\s*,\s*"model"/.test(
        handlerBlock,
      ),
      `handler must validate model via optionalNonBlankString, got block=${JSON.stringify(handlerBlock.slice(0, 800))}`,
    );
    assert.ok(
      /optionalNumber\(\s*"register_capability"\s*,\s*"context_window"/.test(
        handlerBlock,
      ),
      `handler must validate context_window via optionalNumber, got block=${JSON.stringify(handlerBlock.slice(0, 800))}`,
    );
    // The try/catch wrap around registerCapability.
    assert.ok(
      /try\s*\{[\s\S]*registerCapability\(\s*\{/.test(handlerBlock),
      `handler must wrap registerCapability(...) in a try/catch, block=${JSON.stringify(handlerBlock.slice(0, 1200))}`,
    );
    assert.ok(
      /return\s+jsonError\(\s*err/.test(handlerBlock),
      `handler catch branch must return jsonError(err...), block=${JSON.stringify(handlerBlock.slice(0, 1200))}`,
    );
    // The success return shape MUST be EXACTLY jsonResult({ ok: true,
    // agent_id, fleet_id }).
    assert.ok(
      /return\s+jsonResult\(\s*\{\s*ok:\s*true\s*,\s*agent_id\s*,\s*fleet_id\s*\}\s*\)/.test(
        handlerBlock,
      ),
      `handler must end with return jsonResult({ ok: true, agent_id, fleet_id }), block=${JSON.stringify(handlerBlock)}`,
    );
    assert.doesNotMatch(
      handlerBlock,
      /requireAllowedKeys/,
      "handler must NOT enforce additionalProperties (advertising false would be a lie)",
    );
    assert.doesNotMatch(
      handlerBlock,
      /spawnFleet|wakeAgent|fetch\(/,
      "handler must NOT call spawnFleet/wakeAgent/fetch",
    );

    // Schema block pin.
    const { schema, annotations, description } = extractSchemaBlock(src);
    assert.match(schema, /type:\s*"object"/);
    assert.match(schema, /agent_id:\s*\{\s*type:\s*"string"\s*,\s*minLength:\s*1\s*\}/);
    assert.match(schema, /fleet_id:\s*\{\s*type:\s*"string"\s*,\s*minLength:\s*1\s*\}/);
    assert.match(schema, /role:\s*\{\s*type:\s*"string"\s*,\s*minLength:\s*1\s*\}/);
    assert.match(schema, /skills:\s*\{\s*type:\s*"array"\s*,\s*items:\s*\{\s*type:\s*"string"\s*\}\s*\}/);
    assert.match(schema, /model:\s*\{\s*type:\s*"string"\s*\}/);
    assert.match(schema, /context_window:\s*\{\s*type:\s*"number"\s*\}/);
    assert.match(
      schema,
      /required:\s*\[\s*"agent_id"\s*,\s*"fleet_id"\s*,\s*"role"\s*,\s*"skills"\s*\]/,
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
    assert.match(description, /Register an agent's capabilities/);
    assert.match(description, /role, skills, model/);
    assert.match(description, /routing/);

    // Live wire still refuses a missing agent_id after the source pin.
    const response = await callRaw(client, {
      fleet_id: "f",
      role: "r",
      skills: ["s"],
    });
    assert.equal(isErrorEnvelope(response), true);
    assert.match(textOf(response), /register_capability/);
    assert.match(textOf(response), /agent_id/);
  });
});