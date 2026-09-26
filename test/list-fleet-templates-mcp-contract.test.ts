/**
 * list_fleet_templates MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `list_fleet_templates` is the READ
 * complement to save_fleet_template (src/index.ts advertised schema +
 * handler at toolHandlers["list_fleet_templates"]). It is published, yet
 * origin/main has no dedicated test pinning:
 *
 *   1. the advertised schema (empty properties, no required, annotations
 *      including readOnlyHint=true)
 *   2. empty-ledger surface returns exactly {templates: []}
 *   3. sorted-by-name output regardless of save order
 *   4. FleetTemplate 5-key shape with no internal `id` leak
 *   5. multi-template aggregation + save→list content round-trip
 *   6. open-world: phantom top-level args ignored, no leak into response
 *   7. source-string pin on the handler body (listFleetTemplatesFn +
 *      jsonResult({ templates: ... }) + NO args destructure / try/catch /
 *      currentTemplates / requireString / checkRateLimit)
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * A 2026-09-09 worktree (887fa559) existed but never landed and bumped
 * HANDOFF; this card is a fresh origin/main pin with no published-figure
 * bump.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { closeDb } from "../src/db.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-list-fleet-templates-mcp-"));
  return {
    dir,
    dataFile: join(dir, "ledger.json"),
    dbFile: join(dir, "ledger.db"),
    eventsFile: join(dir, "events.jsonl"),
  };
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

async function connectChild(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env,
    stderr: "ignore",
  });
  const client = new Client(
    { name: "list-fleet-templates-contract-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

async function withServer(
  fix: Fixture,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  process.env.MESHFLEET_DB_FILE = fix.dbFile;
  process.env.MESHFLEET_DATA_FILE = fix.dataFile;
  process.env.MESHFLEET_EVENT_LOG_FILE = fix.eventsFile;

  const client = await connectChild(childEnv(fix));
  try {
    await fn(client);
  } finally {
    await client.close().catch(() => {});
    rmSync(fix.dir, { recursive: true, force: true });
    closeDb();
    delete process.env.MESHFLEET_DB_FILE;
  }
}

const FLEET_TEMPLATE_KEYS = [
  "agents",
  "created_at",
  "description",
  "name",
  "version",
];

async function saveNamed(
  client: Client,
  name: string,
  description: string,
  agents: Array<Record<string, unknown>> = [{ role: "r", prompt: "p" }],
): Promise<void> {
  const response = await client.callTool({
    name: "save_fleet_template",
    arguments: { name, description, agents },
  });
  assert.notEqual(
    (response as ToolResponse).isError,
    true,
    `save of ${name} must succeed; got: ${textOf(response)}`,
  );
}

// ---------------------------------------------------------------------------
// T1 — advertised schema pin
// ---------------------------------------------------------------------------

test("list_fleet_templates advertises empty-object schema and readOnlyHint=true", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "list_fleet_templates");
    assert.ok(tool, "list_fleet_templates must be advertised");
    assert.deepEqual(tool.inputSchema, {
      type: "object",
      properties: {},
    });
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });
});

// ---------------------------------------------------------------------------
// T2 — empty ledger returns exactly {templates: []}
// ---------------------------------------------------------------------------

test("list_fleet_templates empty ledger returns {templates: []} with no error envelope", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const response = await client.callTool({
      name: "list_fleet_templates",
      arguments: {},
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `empty ledger must not be an isError envelope; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.deepEqual(
      Object.keys(body).sort(),
      ["templates"],
      `response must have exactly {templates} as top-level keys; got: ${Object.keys(body).sort()}`,
    );
    assert.deepEqual(
      body.templates,
      [],
      `empty ledger must return {templates: []}; got: ${JSON.stringify(body)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T3 — sorted-by-name regardless of save order
// ---------------------------------------------------------------------------

test("list_fleet_templates returns templates sorted by name regardless of save order", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    for (const name of ["zebra", "alpha", "mango"]) {
      await saveNamed(client, name, `${name} desc`);
    }
    const body = bodyOf(
      await client.callTool({
        name: "list_fleet_templates",
        arguments: {},
      }),
    );
    const names = (body.templates as Array<Record<string, unknown>>).map(
      (t) => t.name,
    );
    assert.deepEqual(
      names,
      ["alpha", "mango", "zebra"],
      `templates must be sorted alphabetically by name; got: ${JSON.stringify(names)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T4 — FleetTemplate 5-key shape, no internal id leak
// ---------------------------------------------------------------------------

test("list_fleet_templates entries carry exactly the 5 documented FleetTemplate keys and never id", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    await saveNamed(client, "shape-test", "shape desc", [
      { role: "r1", prompt: "p1" },
    ]);
    const body = bodyOf(
      await client.callTool({
        name: "list_fleet_templates",
        arguments: {},
      }),
    );
    const templates = body.templates as Array<Record<string, unknown>>;
    assert.equal(templates.length, 1, "exactly one template persisted");
    const tpl = templates[0]!;
    assert.deepEqual(
      Object.keys(tpl).sort(),
      FLEET_TEMPLATE_KEYS,
      `FleetTemplate must carry exactly the 5 documented keys; got: ${Object.keys(tpl).sort()}`,
    );
    assert.equal(tpl.id, undefined, "internal ledger id must not leak");
    assert.equal(tpl.name, "shape-test");
    assert.equal(tpl.description, "shape desc");
    assert.equal(tpl.version, 1, "first save of a name has version=1");
    assert.equal(typeof tpl.created_at, "number");
    assert.ok(
      Number.isFinite(tpl.created_at) && (tpl.created_at as number) > 0,
      `created_at must be a positive finite number; got: ${tpl.created_at}`,
    );
    const agents = tpl.agents as Array<Record<string, unknown>>;
    assert.equal(agents.length, 1);
    assert.deepEqual(Object.keys(agents[0]!).sort(), ["prompt", "role"]);
    assert.equal(agents[0]!.role, "r1");
    assert.equal(agents[0]!.prompt, "p1");
  });
});

// ---------------------------------------------------------------------------
// T5 — multi-template aggregation + save→list content round-trip
// ---------------------------------------------------------------------------

test("list_fleet_templates surfaces every saved template with full content (no truncation)", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    await saveNamed(client, "alpha", "first", [
      { role: "writer", prompt: "write a doc", agent: "codex" },
      { role: "reviewer", prompt: "review it" },
    ]);
    await saveNamed(client, "beta", "second", [{ role: "r", prompt: "p" }]);

    const body = bodyOf(
      await client.callTool({
        name: "list_fleet_templates",
        arguments: {},
      }),
    );
    const templates = body.templates as Array<Record<string, unknown>>;
    assert.equal(
      templates.length,
      2,
      `must surface both saved templates; got: ${templates.map((t) => t.name).join(",")}`,
    );
    assert.deepEqual(
      templates.map((t) => t.name),
      ["alpha", "beta"],
    );
    assert.deepEqual(
      templates.map((t) => t.version),
      [1, 1],
    );

    const alpha = templates.find((t) => t.name === "alpha")!;
    assert.equal(alpha.description, "first");
    const agents = alpha.agents as Array<Record<string, unknown>>;
    assert.equal(agents.length, 2);
    const writer = agents.find((a) => a.role === "writer")!;
    const reviewer = agents.find((a) => a.role === "reviewer")!;
    assert.equal(writer.agent, "codex");
    assert.ok(
      !("agent" in reviewer),
      `TemplateAgent without explicit 'agent' must NOT carry a phantom 'agent' key; got: ${JSON.stringify(reviewer)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T6 — open-world: phantom top-level args ignored, no leak into response
// ---------------------------------------------------------------------------

test("list_fleet_templates ignores phantom top-level args and keeps response keys exactly {templates}", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    await saveNamed(client, "open-world", "ow");
    const response = await client.callTool({
      name: "list_fleet_templates",
      arguments: {
        phantom_filter: "should-be-ignored",
        debug_emit: 42,
        future_field: { a: 1, b: [2, 3] },
      },
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `phantom top-level args must NOT surface as an isError envelope; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.deepEqual(
      Object.keys(body).sort(),
      ["templates"],
      `response must have exactly {templates} as top-level keys regardless of phantom args; got: ${Object.keys(body).sort()}`,
    );
    const templates = body.templates as Array<Record<string, unknown>>;
    assert.equal(templates.length, 1);
    assert.equal(templates[0]!.name, "open-world");
    for (const phantom of ["phantom_filter", "debug_emit", "future_field", "id"]) {
      assert.equal(
        templates[0]![phantom],
        undefined,
        `${phantom} must NOT leak into a listed template`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T7 — source-string pin
// ---------------------------------------------------------------------------

test("list_fleet_templates handler source pins listFleetTemplatesFn, jsonResult({ templates }), and the absence of args/try/currentTemplates/requireString/checkRateLimit", () => {
  const source = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");
  assert.match(
    source,
    /toolHandlers\["list_fleet_templates"\]/,
    "list_fleet_templates must be a top-level toolHandlers entry",
  );
  assert.match(
    source,
    /jsonResult\(\s*\{\s*templates:\s*listFleetTemplatesFn\(\)\s*\}\s*\)/,
    "handler must return jsonResult({ templates: listFleetTemplatesFn() })",
  );

  const handlerMatch = source.match(
    /toolHandlers\["list_fleet_templates"\] = async \(args\) => \{([\s\S]*?)\n\};\s*\n\ntoolHandlers\["spawn_from_template"\]/,
  );
  assert.ok(
    handlerMatch,
    "list_fleet_templates handler block must be found immediately before spawn_from_template",
  );
  const handlerBody = handlerMatch[1]!;
  assert.match(
    handlerBody,
    /listFleetTemplatesFn\(\)/,
    "handler must call listFleetTemplatesFn() (the stripMeta'd, sorted-by-name surface)",
  );
  assert.doesNotMatch(
    handlerBody,
    /\bargs\s*\./,
    "handler body must NOT read fields off args (would silently start respecting phantom args)",
  );
  assert.doesNotMatch(
    handlerBody,
    /\bargs\s*\?\./,
    "handler body must NOT use args?. either",
  );
  assert.doesNotMatch(
    handlerBody,
    /\btry\s*\{/,
    "handler body must NOT wrap in try/catch (would change isError semantics for a no-failure path)",
  );
  assert.doesNotMatch(
    handlerBody,
    /currentTemplates\s*\(/,
    "handler must NOT call currentTemplates() (would leak the internal TemplateWithMeta id field)",
  );
  assert.doesNotMatch(
    handlerBody,
    /requireString/,
    "list_fleet_templates handler currently has NO requireString gate (no inputs); pinning this absence prevents a silent add/remove without a conscious decision",
  );
  assert.doesNotMatch(
    handlerBody,
    /checkRateLimit/,
    "list_fleet_templates handler must NOT contain checkRateLimit",
  );
});
