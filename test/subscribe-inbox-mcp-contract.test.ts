/**
 * subscribe_inbox MCP contract — driven over real MCP stdio with the tool's
 * PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `subscribe_inbox` is the operator-facing
 * SSE inbox-push discovery surface (src/index.ts advertised schema at
 * L1532-L1546 + handler at toolHandlers["subscribe_inbox"] L2617-L2655
 * on origin/main 8433dcb8). It is published, yet origin/main has no
 * dedicated stdio contract pinning the 2026-09-12 honesty pattern:
 *
 *   1. the advertised schema (required agent_id, NO additionalProperties
 *      key, annotations including readOnlyHint=true + idempotentHint=true
 *      + openWorldHint=false) plus description phrases SSE / get_inbox
 *      fallback / MESHFLEET_AUTH_TOKEN
 *   2. required-field absence refused as isError naming tool + field
 *   3. wire-boundary type validation on agent_id — the named bug class:
 *      a wrong-typed agent_id used to stringify into the lookup key and
 *      return a legitimate-looking "not found" (graceful by luck, not
 *      by contract). requireString must fire BEFORE readLedger.
 *   4. unknown-agent jsonError `Agent "${id}" not found`, and that
 *      check fires BEFORE the SSE-down guard (guard-order pin)
 *   5. SSE-down with a known agent is jsonError naming the live
 *      endpoint, NEVER a phantom stream_url
 *   6. advertised-vs-handler drift honesty — schema does NOT advertise
 *      additionalProperties:false, and phantom top-level keys still
 *      reach the handler (no requireAllowedKeys)
 *   7. source-string pin on the handler body + named-bug comment
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * A 2026-09-09 worktree (5abbf449) existed for subscribe_inbox but never
 * landed; its T6 happy-path was a source-string pin only (child-mode
 * skips SSE) and its T7 claimed phantom keys were a silent drop without
 * naming that additionalProperties is not advertised. This card is a
 * fresh origin/main pin with the 2026-09-12 honesty pattern, including
 * a real SSE-running stdio happy path.
 *
 * No published-figure bump. HANDOFF.md is not edited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createFleet, registerAgentInLedger, type Agent } from "../src/core.js";
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-subscribe-inbox-mcp-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-subscribe-inbox-${dir}`,
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

const childEnv = (
  fix: Fixture,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  MESHFLEET_DB_FILE: fix.dbFile,
  MESHFLEET_DATA_FILE: fix.dataFile,
  MESHFLEET_EVENT_LOG_FILE: fix.eventsFile,
  MESHFLEET_RATIFY_SWEEP_MS: "0",
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
    { name: "subscribe-inbox-contract-test", version: "1.0.0" },
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

/** Child-mode: recovery, sweeper, and SSE skipped (src/index.ts L3092). */
async function withChildServer(
  fix: Fixture,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  applyFixtureEnv(fix);
  const client = await connectChild(
    childEnv(fix, { AGENT_MESH_CHILD: "1" }),
  );
  try {
    await fn(client);
  } finally {
    await client.close().catch(() => {});
    await cleanupFix(fix);
  }
}

let nextPort = 37710;

/** Full main(): SSE listener binds on a per-test MESHFLEET_SSE_PORT. */
async function withSseServer(
  fix: Fixture,
  fn: (client: Client, port: number) => Promise<void>,
): Promise<void> {
  applyFixtureEnv(fix);
  const port = nextPort++;
  const client = await connectChild(
    childEnv(fix, {
      MESHFLEET_SSE_PORT: String(port),
      MESHFLEET_SSE_HOST: "127.0.0.1",
    }),
  );
  try {
    await fn(client, port);
  } finally {
    await client.close().catch(() => {});
    await cleanupFix(fix);
  }
}

const fixtureAgent = (id: string, fleetId: string): Agent => ({
  id,
  fleet_id: fleetId,
  role: `${id}-role`,
  prompt: `${id}-prompt`,
  status: "running",
});

function seedLedger(fleetId: string, agentIds: string[]): void {
  createFleet(fleetId);
  for (const aid of agentIds) {
    registerAgentInLedger(fixtureAgent(aid, fleetId));
  }
}

const SUBSCRIBE_INBOX_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

// ---------------------------------------------------------------------------
// T1 — advertised schema pin
// ---------------------------------------------------------------------------

test("subscribe_inbox advertises required agent_id, no additionalProperties, and read-only/idempotent annotations", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "subscribe_inbox");
    assert.ok(tool, "subscribe_inbox must be advertised");
    const schema = tool.inputSchema as {
      type: string;
      required?: string[];
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["agent_id"]);
    assert.equal(
      schema.additionalProperties,
      undefined,
      "subscribe_inbox schema MUST NOT advertise additionalProperties (handler has no requireAllowedKeys; advertising false would be a lie)",
    );
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(props).sort(), ["agent_id"]);
    assert.deepEqual(props.agent_id, {
      type: "string",
      description: "The agent whose inbox to subscribe to.",
    });
    assert.deepEqual(tool.annotations, SUBSCRIBE_INBOX_ANNOTATIONS);
    assert.ok(
      typeof tool.description === "string" &&
        tool.description.includes("Server-Sent Events (SSE)"),
      `description must keep the SSE phrase; got: ${tool.description}`,
    );
    assert.ok(
      typeof tool.description === "string" &&
        tool.description.includes("Falls back to polling get_inbox"),
      `description must keep the get_inbox fallback phrase; got: ${tool.description}`,
    );
    assert.ok(
      typeof tool.description === "string" &&
        tool.description.includes("MESHFLEET_AUTH_TOKEN"),
      `description must keep the MESHFLEET_AUTH_TOKEN phrase; got: ${tool.description}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T2 — required-field absence refused as tool+field, NEVER "not found"
// ---------------------------------------------------------------------------

test("subscribe_inbox refuses absent agent_id as isError naming tool+field", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "subscribe_inbox",
      arguments: {} as Record<string, unknown>,
    });
    assert.equal(
      (response as ToolResponse).isError,
      true,
      `absent agent_id: must be a tool error; got: ${textOf(response)}`,
    );
    const text = textOf(response);
    assert.match(text, /subscribe_inbox/, `absent agent_id: must name the tool; got: ${text}`);
    assert.match(text, /'agent_id'/, `absent agent_id: must name the field; got: ${text}`);
    assert.match(
      text,
      /is required and must be a non-empty string/,
      `absent agent_id: must use the requireString envelope; got: ${text}`,
    );
    const body = bodyOf(response);
    assert.equal(
      "stream_url" in body,
      false,
      `absent agent_id: MUST NOT carry a stream_url; got: ${JSON.stringify(body)}`,
    );
    assert.equal(
      typeof body.error === "string" && body.error.includes("not found"),
      false,
      `absent agent_id: must die at requireString, never the agent-lookup "not found"; got: ${JSON.stringify(body)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T3 — named bug class: wrong-typed agent_id must NEVER stringify into "not found"
// ---------------------------------------------------------------------------

test("subscribe_inbox refuses non-string shapes on agent_id (stringified-lookup-key bug class)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const nonStringShapes: Array<{ label: string; v: unknown }> = [
      { label: "null", v: null },
      { label: "empty", v: "" },
      { label: "whitespace", v: "   " },
      { label: "number", v: 42 },
      { label: "boolean", v: false },
      { label: "array", v: ["x"] },
      { label: "object", v: { x: 1 } },
    ];
    for (const { label, v } of nonStringShapes) {
      const response = await client.callTool({
        name: "subscribe_inbox",
        arguments: { agent_id: v },
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `agent_id=${label}: must be isError; got: ${textOf(response)}`,
      );
      const text = textOf(response);
      assert.match(
        text,
        /subscribe_inbox/,
        `agent_id=${label}: must name the tool; got: ${text}`,
      );
      assert.match(
        text,
        /'agent_id'/,
        `agent_id=${label}: must name the field; got: ${text}`,
      );
      assert.doesNotMatch(
        text,
        /not found/i,
        `agent_id=${label}: MUST NOT stringify into a legitimate-looking not-found (named bug class at src/index.ts:2619-2621); got: ${text}`,
      );
      const body = bodyOf(response);
      assert.equal(
        "stream_url" in body,
        false,
        `agent_id=${label}: MUST NOT carry a stream_url; got: ${JSON.stringify(body)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T4 — unknown agent surfaces as jsonError "not found" BEFORE SSE-down
// ---------------------------------------------------------------------------

test("subscribe_inbox unknown agent returns isError naming the agent, even when SSE is down", async () => {
  const fix = makeFixture();
  // Child-mode skips SSE. Guard order at src/index.ts:2622-2642 is
  // (1) requireString, (2) agent-exists, (3) SSE-up, (4) jsonResult.
  // An unknown agent MUST surface as "Agent \"...\" not found" and MUST
  // NOT be swallowed by the SSE-down branch.
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "subscribe_inbox",
      arguments: { agent_id: "agent-that-does-not-exist-xyzzy" },
    });
    assert.equal(
      (response as ToolResponse).isError,
      true,
      `unknown agent MUST return isError; got: ${textOf(response)}`,
    );
    const text = textOf(response);
    assert.match(
      text,
      /agent-that-does-not-exist-xyzzy/,
      `error must name the agent id; got: ${text}`,
    );
    assert.match(
      text,
      /not found/i,
      `error must use the "not found" class; got: ${text}`,
    );
    assert.doesNotMatch(
      text,
      /no live SSE endpoint/i,
      `unknown agent must fire BEFORE the SSE-down guard; got: ${text}`,
    );
    const body = bodyOf(response);
    assert.equal(
      "stream_url" in body,
      false,
      `unknown agent MUST NOT carry a stream_url; got: ${JSON.stringify(body)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T5 — SSE-down with a known agent is jsonError, NEVER a phantom stream_url
// ---------------------------------------------------------------------------

test("subscribe_inbox SSE-down with a known agent is isError, not a phantom stream_url", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  seedLedger("fleet-A", ["sse-test-agent"]);
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "subscribe_inbox",
      arguments: { agent_id: "sse-test-agent" },
    });
    assert.equal(
      (response as ToolResponse).isError,
      true,
      `SSE-down MUST surface as isError; got: ${textOf(response)}`,
    );
    const text = textOf(response);
    assert.match(
      text,
      /subscribe_inbox/,
      `SSE-down must name the tool; got: ${text}`,
    );
    assert.match(
      text,
      /no live SSE endpoint/,
      `SSE-down must name the live-endpoint condition; got: ${text}`,
    );
    assert.match(
      text,
      /Poll get_inbox instead/,
      `SSE-down must keep the get_inbox source-of-truth instruction; got: ${text}`,
    );
    const body = bodyOf(response);
    assert.equal(
      "stream_url" in body,
      false,
      `SSE-down MUST NOT carry a stream_url; got: ${JSON.stringify(body)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T6 — SSE-running happy path + advertised-vs-handler phantom-key honesty
// ---------------------------------------------------------------------------

test("subscribe_inbox SSE-running happy path returns four-key envelope; phantom keys still reach the handler", async () => {
  const fix = makeFixture();
  applyFixtureEnv(fix);
  seedLedger("fleet-A", ["happy-agent"]);
  await withSseServer(fix, async (client, port) => {
    const response = await client.callTool({
      name: "subscribe_inbox",
      arguments: { agent_id: "happy-agent" },
    });
    assert.equal(
      (response as ToolResponse).isError,
      undefined,
      `SSE-running happy-path MUST NOT be isError; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.deepEqual(
      Object.keys(body).sort(),
      ["agent_id", "instructions", "served_by_this_process_only", "stream_url"],
      `response must have exactly the four documented keys; got: ${Object.keys(body).sort()}`,
    );
    assert.equal(body.agent_id, "happy-agent");
    assert.equal(body.served_by_this_process_only, true);
    assert.equal(
      body.stream_url,
      `http://127.0.0.1:${port}/inbox/happy-agent/stream`,
    );
    assert.match(
      String(body.instructions),
      /poll get_inbox for the complete, durable view/i,
      `instructions must keep the get_inbox source-of-truth wording; got: ${body.instructions}`,
    );
    assert.match(
      String(body.instructions),
      /SSE is advisory only/i,
      `instructions must keep the SSE-is-advisory honesty; got: ${body.instructions}`,
    );

    // Honesty: schema does not advertise additionalProperties:false, and
    // the handler has no requireAllowedKeys. Phantom keys must still
    // reach the success path, not an additional-properties refusal.
    const phantom = await client.callTool({
      name: "subscribe_inbox",
      arguments: {
        agent_id: "happy-agent",
        force: true,
        retry: 3,
        note: "for your eyes only",
      },
    });
    assert.equal(
      (phantom as ToolResponse).isError,
      undefined,
      `phantom keys MUST still succeed (additionalProperties is not advertised and not handler-enforced); got: ${textOf(phantom)}`,
    );
    const phantomBody = bodyOf(phantom);
    assert.equal(phantomBody.agent_id, "happy-agent");
    assert.equal(phantomBody.served_by_this_process_only, true);
    assert.equal(
      phantomBody.stream_url,
      `http://127.0.0.1:${port}/inbox/happy-agent/stream`,
    );
    for (const k of ["force", "retry", "note"]) {
      assert.equal(
        k in phantomBody,
        false,
        `phantom arg "${k}" MUST NOT leak into the response`,
      );
    }
    const phantomText = textOf(phantom);
    assert.doesNotMatch(
      phantomText,
      /additionalProperties|unknown (key|field|property)|not allowed/i,
      `phantom keys must NOT be refused as an additional-properties schema error; got: ${phantomText}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T7 — source-string pin
// ---------------------------------------------------------------------------

test("subscribe_inbox handler source pins requireString agent_id, named stringified-lookup-key bug, SSE-down guard, four-key jsonResult", () => {
  const source = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");
  assert.match(
    source,
    /toolHandlers\["subscribe_inbox"\]/,
    "subscribe_inbox must be a top-level toolHandlers entry",
  );
  assert.ok(
    source.includes("Subscribe to an agent's inbox via Server-Sent Events (SSE)."),
    "subscribe_inbox description must keep the SSE phrase",
  );
  assert.ok(
    source.includes("Falls back to polling get_inbox if SSE is unreachable."),
    "subscribe_inbox description must keep the get_inbox fallback phrase",
  );
  assert.ok(
    source.includes("MESHFLEET_AUTH_TOKEN"),
    "subscribe_inbox description must keep the MESHFLEET_AUTH_TOKEN phrase",
  );

  const schemaMatch = source.match(
    /name: "subscribe_inbox",[\s\S]*?inputSchema: \{([\s\S]*?)\},\s*annotations:/,
  );
  assert.ok(schemaMatch, "subscribe_inbox inputSchema block must be found");
  const schemaBody = schemaMatch[1]!;
  assert.doesNotMatch(
    schemaBody,
    /additionalProperties/,
    "advertised schema must NOT declare additionalProperties — advertising false would be a lie (handler has no requireAllowedKeys)",
  );
  assert.match(
    schemaBody,
    /required: \["agent_id"\]/,
    "advertised schema must require agent_id",
  );

  const handlerMatch = source.match(
    /toolHandlers\["subscribe_inbox"\] = async \(args\) => \{([\s\S]*?)\n\};\s*\n\s*toolHandlers\["subscribe_events"\]/,
  );
  assert.ok(
    handlerMatch,
    "subscribe_inbox handler block must be found immediately before subscribe_events",
  );
  const handlerBody = handlerMatch[1]!;
  assert.match(
    handlerBody,
    /requireString\(\s*"subscribe_inbox"\s*,\s*"agent_id"/,
    "handler must requireString agent_id",
  );
  assert.match(
    handlerBody,
    /stringified into the lookup key/,
    "handler comment must keep the named stringified-lookup-key bug class",
  );
  assert.match(
    handlerBody,
    /graceful by luck, not by[\s\S]*contract/,
    "handler comment must keep the 'graceful by luck, not by contract' rationale",
  );
  assert.match(
    handlerBody,
    /if \(invalidSubscribe\) return jsonError\(invalidSubscribe\)/,
    "handler must return jsonError on the requireString failure",
  );
  assert.match(
    handlerBody,
    /const data = readLedger\(\)/,
    "handler must readLedger after the wire-boundary check",
  );
  assert.match(
    handlerBody,
    /if \(!data\.agents\[agent_id\]\)/,
    "handler must refuse unknown agents before the SSE-down guard",
  );
  assert.match(
    handlerBody,
    /Agent "\$\{agent_id\}" not found/,
    "unknown-agent jsonError must use the Agent \"${id}\" not found envelope",
  );
  assert.match(
    handlerBody,
    /if \(!isSseServerRunning\(\)\)/,
    "handler must refuse when this process has no live SSE endpoint",
  );
  assert.match(
    handlerBody,
    /no live SSE endpoint/,
    "SSE-down jsonError must name the live-endpoint condition",
  );
  assert.match(
    handlerBody,
    /Poll get_inbox instead/,
    "SSE-down jsonError must keep the get_inbox source-of-truth instruction",
  );
  assert.match(
    handlerBody,
    /const streamUrl = subscribeInboxUrl\(agent_id\)/,
    "success path must call subscribeInboxUrl(agent_id)",
  );
  assert.match(
    handlerBody,
    /return jsonResult\(\{/,
    "success path must return jsonResult({...})",
  );
  assert.match(
    handlerBody,
    /served_by_this_process_only:\s*true/,
    "success path must pin served_by_this_process_only: true (the documented honesty claim)",
  );
  for (const key of ["agent_id", "stream_url", "served_by_this_process_only", "instructions"]) {
    assert.ok(
      handlerBody.includes(key),
      `subscribe_inbox handler MUST include response key "${key}" in its jsonResult`,
    );
  }
  assert.doesNotMatch(
    handlerBody,
    /requireAllowedKeys/,
    "handler must NOT call requireAllowedKeys — additionalProperties is not advertised and not handler-enforced",
  );
  assert.doesNotMatch(
    handlerBody,
    /String\s*\(\s*agent_id\s*\)/,
    "handler must NOT coerce agent_id via String() — that is the stringified-lookup-key defect",
  );
});
