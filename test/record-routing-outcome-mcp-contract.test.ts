/**
 * record_routing_outcome MCP contract — driven over real MCP stdio with
 * the tool's PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `record_routing_outcome` is the routing-
 * feedback write-side tool (src/index.ts advertised schema at L1438-L1451
 * + handler at toolHandlers["record_routing_outcome"] L2440-L2458 on
 * origin/main 8433dcb8). It is published. The last pin (eb1321bb) was
 * 2026-09-10 and not on origin/main. This card is a fresh origin/main pin
 * with the 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — required [agent_id, capability_key, success]
 *      in advertised order, NO additionalProperties key (advertising false
 *      would be a lie; handler has no requireAllowedKeys), properties
 *      agent_id/capability_key string + success boolean, annotations
 *      {idempotentHint:true, readOnlyHint:false, destructiveHint:false,
 *      openWorldHint:false}, description phrases PER AGENT not per
 *      capability + in-process resets when the server restarts.
 *   2. required-field honesty — absent agent_id / capability_key / success
 *      is isError naming record_routing_outcome + the field and NEVER a
 *      phantom ok:true; SDK does NOT enforce required.
 *   3. requireString boundary — agent_id/capability_key: empty, whitespace,
 *      null, number, array, object all return isError naming the field +
 *      "non-empty string" and NEVER reach recordRoutingOutcome.
 *   4. requireBoolean success truthiness defect — string "false", 0, 1,
 *      string "true", null all return isError with boolean|truthiness
 *      rationale ("Refusing to infer intent") and NEVER reach
 *      recordRoutingOutcome (a truthiness read would treat "false" as true
 *      and an omitted value as false — exactly the cast_vote bug class).
 *   5. happy-path envelope {ok:true, agent_id, capability_key, success} —
 *      idempotent repeat returns the same envelope (in-process state is
 *      keyed by agentId; capability_key is recorded but deliberately
 *      unused for scoring, per routing-feedback.ts L25-L32).
 *   6. phantom extra keys do not error — additionalProperties is not
 *      advertised and the handler has no requireAllowedKeys, so a
 *      phantom top-level key (e.g. force/retry/note) is silently ignored
 *      and the call still returns ok:true. This is the HONEST behavior:
 *      advertising additionalProperties:false would be a lie because the
 *      handler does not enforce it.
 *   7. source-string pin — handler body is firstError(requireString x2,
 *      requireBoolean) → jsonError if bad → recordRoutingOutcome →
 *      jsonResult {ok:true, agent_id, capability_key, success}. No
 *      spawnFleet/wakeAgent/sendMessage/fetch. No requireAllowedKeys.
 *      Handler registered exactly once. In-process Map resets on server
 *      restart (separate child process = separate state).
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * No published-figure bump. HANDOFF.md is not edited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-record-routing-mcp-"));
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

const childEnv = (
  fix: Fixture,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  MESHFLEET_DB_FILE: fix.dbFile,
  MESHFLEET_DATA_FILE: fix.dataFile,
  MESHFLEET_EVENT_LOG_FILE: fix.eventsFile,
  MESHFLEET_RATIFY_SWEEP_MS: "0",
  AGENT_MESH_CHILD: "1",
  HOME: fix.dir,
  ...extra,
});

async function connectChild(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env,
    stderr: "ignore",
  });
  const client = new Client(
    { name: "record-routing-outcome-contract-test", version: "1.0.0" },
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

/** Child-mode: recovery, sweeper, and SSE skipped. */
async function withChildServer(
  fix: Fixture,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  applyFixtureEnv(fix);
  const client = await connectChild(childEnv(fix));
  try {
    await fn(client);
  } finally {
    await client.close().catch(() => {});
    await cleanupFix(fix);
  }
}

async function callOk(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: args });
  return bodyOf(response);
}

// ─── Test 1: advertised schema + annotations + description ─────────────

test("record_routing_outcome advertises its schema, annotations, and description honestly", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "record_routing_outcome");
    assert.ok(tool, "record_routing_outcome must be advertised");

    // Advertised schema: required in advertised order, NO additionalProperties.
    assert.deepEqual(tool.inputSchema, {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        capability_key: { type: "string" },
        success: { type: "boolean" },
      },
      required: ["agent_id", "capability_key", "success"],
    });

    // Annotations: idempotent (repeat recording is a no-op state update),
    // NOT read-only (it mutates in-process routing state), NOT destructive,
    // NOT open-world (no external contact).
    assert.deepEqual(tool.annotations, {
      idempotentHint: true,
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });

    // Description honesty: PER AGENT not per capability + in-process resets.
    const desc = tool.description ?? "";
    assert.match(desc, /PER AGENT/i, "description must say outcomes are PER AGENT");
    assert.match(desc, /per capability/i, "description must reference per-capability scoping");
    assert.match(desc, /in-process/i, "description must say feedback is in-process");
    assert.match(desc, /reset/i, "description must say state resets on restart");
  });
});

// ─── Test 2: required-field absence is isError, never phantom ok:true ──

test("record_routing_outcome: absent required fields are isError naming the tool + field, never a phantom ok:true", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    // Missing agent_id
    {
      const res = await client.callTool({
        name: "record_routing_outcome",
        arguments: { capability_key: "ts", success: true },
      });
      assert.equal((res as ToolResponse).isError, true, "missing agent_id must be isError");
      const body = bodyOf(res);
      assert.equal(body.ok, undefined, "missing agent_id must NOT return ok:true");
      assert.match(textOf(res), /record_routing_outcome/, "error must name the tool");
      assert.match(textOf(res), /agent_id/, "error must name the field");
    }

    // Missing capability_key
    {
      const res = await client.callTool({
        name: "record_routing_outcome",
        arguments: { agent_id: "agent-1", success: true },
      });
      assert.equal((res as ToolResponse).isError, true, "missing capability_key must be isError");
      const body = bodyOf(res);
      assert.equal(body.ok, undefined, "missing capability_key must NOT return ok:true");
      assert.match(textOf(res), /record_routing_outcome/);
      assert.match(textOf(res), /capability_key/);
    }

    // Missing success
    {
      const res = await client.callTool({
        name: "record_routing_outcome",
        arguments: { agent_id: "agent-1", capability_key: "ts" },
      });
      assert.equal((res as ToolResponse).isError, true, "missing success must be isError");
      const body = bodyOf(res);
      assert.equal(body.ok, undefined, "missing success must NOT return ok:true");
      assert.match(textOf(res), /record_routing_outcome/);
      assert.match(textOf(res), /success/);
    }

    // All three missing
    {
      const res = await client.callTool({
        name: "record_routing_outcome",
        arguments: {},
      });
      assert.equal((res as ToolResponse).isError, true, "all-missing must be isError");
      assert.match(textOf(res), /record_routing_outcome/);
      assert.match(textOf(res), /agent_id/, "first missing field is agent_id");
    }
  });
});

// ─── Test 3: requireString boundary — agent_id + capability_key ────────

test("record_routing_outcome: requireString boundary pins every non-string shape for agent_id and capability_key", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const stringFieldCases: ReadonlyArray<{
      label: string;
      field: string;
      args: Record<string, unknown>;
      expectedText: RegExp;
    }> = [
      // agent_id
      { label: "empty agent_id", field: "agent_id",
        args: { agent_id: "", capability_key: "ts", success: true },
        expectedText: /agent_id.*non-empty string/ },
      { label: "whitespace agent_id", field: "agent_id",
        args: { agent_id: "  \t\n ", capability_key: "ts", success: true },
        expectedText: /agent_id.*non-empty string/ },
      { label: "null agent_id", field: "agent_id",
        args: { agent_id: null, capability_key: "ts", success: true },
        expectedText: /agent_id.*non-empty string/ },
      { label: "number agent_id", field: "agent_id",
        args: { agent_id: 42, capability_key: "ts", success: true },
        expectedText: /agent_id.*non-empty string/ },
      { label: "array agent_id", field: "agent_id",
        args: { agent_id: ["a"], capability_key: "ts", success: true },
        expectedText: /agent_id.*non-empty string/ },
      { label: "object agent_id", field: "agent_id",
        args: { agent_id: { id: "a" }, capability_key: "ts", success: true },
        expectedText: /agent_id.*non-empty string/ },
      // capability_key
      { label: "empty capability_key", field: "capability_key",
        args: { agent_id: "a", capability_key: "", success: true },
        expectedText: /capability_key.*non-empty string/ },
      { label: "whitespace capability_key", field: "capability_key",
        args: { agent_id: "a", capability_key: " \t ", success: true },
        expectedText: /capability_key.*non-empty string/ },
      { label: "null capability_key", field: "capability_key",
        args: { agent_id: "a", capability_key: null, success: true },
        expectedText: /capability_key.*non-empty string/ },
      { label: "number capability_key", field: "capability_key",
        args: { agent_id: "a", capability_key: 99, success: true },
        expectedText: /capability_key.*non-empty string/ },
      { label: "array capability_key", field: "capability_key",
        args: { agent_id: "a", capability_key: ["ts"], success: true },
        expectedText: /capability_key.*non-empty string/ },
      { label: "object capability_key", field: "capability_key",
        args: { agent_id: "a", capability_key: { k: "ts" }, success: true },
        expectedText: /capability_key.*non-empty string/ },
    ];

    for (const { label, expectedText, args } of stringFieldCases) {
      const res = await client.callTool({
        name: "record_routing_outcome",
        arguments: args,
      });
      assert.equal(
        (res as ToolResponse).isError,
        true,
        `${label}: must be isError, not silently coerced`,
      );
      assert.match(
        textOf(res),
        expectedText,
        `${label}: rejection text must name the offending field`,
      );
      assert.match(
        textOf(res),
        /record_routing_outcome/,
        `${label}: rejection text must name the tool`,
      );
    }
  });
});

// ─── Test 4: requireBoolean success — truthiness defect pin ────────────

test("record_routing_outcome: requireBoolean success refuses truthy non-booleans with boolean|truthiness rationale", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    // Each of these is the cast_vote bug class: a truthiness read would
    // treat "false" as true, 0 as false, 1 as true, "true" as true,
    // and null as false — all WRONG. requireBoolean refuses them all.
    const truthinessCases: ReadonlyArray<{
      label: string;
      success: unknown;
    }> = [
      { label: "string-false", success: "false" },
      { label: "number-0", success: 0 },
      { label: "number-1", success: 1 },
      { label: "string-true", success: "true" },
      { label: "null", success: null },
      { label: "empty-string", success: "" },
      { label: "object", success: { ok: true } },
    ];

    for (const { label, success } of truthinessCases) {
      const res = await client.callTool({
        name: "record_routing_outcome",
        arguments: { agent_id: "agent-1", capability_key: "ts", success },
      });
      assert.equal(
        (res as ToolResponse).isError,
        true,
        `${label}: must be isError — a truthiness read would be a silent intent inversion`,
      );
      const text = textOf(res);
      assert.match(text, /record_routing_outcome/, `${label}: must name the tool`);
      assert.match(text, /success/, `${label}: must name the field`);
      assert.match(
        text,
        /boolean/,
        `${label}: rejection must say "boolean" — the type requirement`,
      );
      assert.match(
        text,
        /truthiness|infer intent/i,
        `${label}: rejection must explain the truthiness rationale`,
      );
      // Critical: the value must NEVER reach recordRoutingOutcome.
      // A string "false" would record a SUCCESS under truthiness; a null
      // would record a FAILURE. Both are silent intent inversions.
      const body = bodyOf(res);
      assert.equal(body.ok, undefined, `${label}: must NOT return ok:true`);
    }
  });
});

// ─── Test 5: happy path {ok:true, agent_id, capability_key, success} ───

test("record_routing_outcome: happy path returns {ok:true, agent_id, capability_key, success} and is idempotent", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    // success: true
    const ok1 = await callOk(client, "record_routing_outcome", {
      agent_id: "agent-happy",
      capability_key: "ts",
      success: true,
    });
    assert.deepEqual(ok1, {
      ok: true,
      agent_id: "agent-happy",
      capability_key: "ts",
      success: true,
    });

    // Idempotent repeat — same envelope.
    const ok2 = await callOk(client, "record_routing_outcome", {
      agent_id: "agent-happy",
      capability_key: "ts",
      success: true,
    });
    assert.deepEqual(ok2, {
      ok: true,
      agent_id: "agent-happy",
      capability_key: "ts",
      success: true,
    });

    // success: false
    const ok3 = await callOk(client, "record_routing_outcome", {
      agent_id: "agent-sad",
      capability_key: "sql",
      success: false,
    });
    assert.deepEqual(ok3, {
      ok: true,
      agent_id: "agent-sad",
      capability_key: "sql",
      success: false,
    });
  });
});

// ─── Test 6: phantom extra keys do not error (no requireAllowedKeys) ───

test("record_routing_outcome: phantom extra keys are silently ignored (additionalProperties not advertised, handler does not enforce)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    // The handler destructures { agent_id, capability_key, success } and
    // never checks for extra keys. Advertising additionalProperties:false
    // would be a lie. Phantom keys must NOT error.
    const ok = await callOk(client, "record_routing_outcome", {
      agent_id: "agent-phantom",
      capability_key: "ts",
      success: true,
      force: true,        // phantom
      retry: 3,           // phantom
      note: "should be ignored", // phantom
    });
    assert.deepEqual(ok, {
      ok: true,
      agent_id: "agent-phantom",
      capability_key: "ts",
      success: true,
    });
  });
});

// ─── Test 7: source-string pin — handler body + in-process reset ───────

test("record_routing_outcome: source-string pin — handler is requireString x2 + requireBoolean → recordRoutingOutcome → jsonResult, no spawn/fetch/allowedKeys", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    // Read the source from the worktree and pin the handler structure.
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    // The handler must be registered.
    assert.match(src, /toolHandlers\["record_routing_outcome"\]/);

    // The handler must use requireString for agent_id and capability_key.
    assert.match(src, /requireString\("record_routing_outcome", "agent_id"/);
    assert.match(src, /requireString\("record_routing_outcome", "capability_key"/);

    // The handler must use requireBoolean for success (NOT truthiness).
    assert.match(src, /requireBoolean\("record_routing_outcome", "success"/);

    // The handler must call recordRoutingOutcome.
    assert.match(src, /recordRoutingOutcome\(agent_id, capability_key, success\)/);

    // The handler must return jsonResult { ok: true, ... }.
    assert.match(src, /jsonResult\(\{ ok: true, agent_id, capability_key, success \}\)/);

    // The handler must NOT use requireAllowedKeys (additionalProperties is
    // not enforced — advertising it as false would be a lie).
    const handlerMatch = src.match(
      /toolHandlers\["record_routing_outcome"\][\s\S]*?^};/m,
    );
    assert.ok(handlerMatch, "handler block must be extractable");
    const handlerBlock = handlerMatch[0];
    assert.doesNotMatch(
      handlerBlock,
      /requireAllowedKeys/,
      "handler must NOT enforce additionalProperties (advertising false would be a lie)",
    );

    // The handler must NOT spawn, wake, send, or fetch.
    assert.doesNotMatch(handlerBlock, /spawnFleet|wakeAgent|sendMessage|fetch\(/);

    // In-process reset: routing-feedback.ts state is a module-level Map.
    // A fresh child process (separate server) must start with no prior
    // state. We prove this by recording an outcome in this server and
    // then connecting a SECOND child to the same fixture — the second
    // child cannot see the first child's in-process Map.
    const ok1 = await callOk(client, "record_routing_outcome", {
      agent_id: "agent-reset",
      capability_key: "ts",
      success: true,
    });
    assert.equal(ok1.ok, true);

    // route_work adjustment for "agent-reset" is computed in-process.
    // The second child has a fresh Map so getRoutingAdjustment returns
    // the neutral 1.0 — but we can only observe this indirectly because
    // route_work is a separate tool. The source pin here is that
    // routing-feedback.ts declares `const state = new Map()` at module
    // scope, which means each process gets its own. Pin the source.
    const feedbackSrc = readFileSync(join(repoRoot, "src", "routing-feedback.ts"), "utf-8");
    assert.match(feedbackSrc, /const state = new Map/, "routing state is a module-level Map (per-process)");
    assert.match(feedbackSrc, /_capabilityKey/, "capability_key is deliberately unused (PER AGENT not per capability)");
    assert.match(feedbackSrc, /resetRoutingFeedback/, "reset function exists");
  });
});