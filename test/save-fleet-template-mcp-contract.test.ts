/**
 * save_fleet_template MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `save_fleet_template` is the only WRITE
 * tool on the template surface (src/index.ts advertised schema + handler
 * at toolHandlers["save_fleet_template"]). It is published, yet origin/main
 * has no dedicated test pinning:
 *
 *   1. the advertised schema (properties, required=[name, agents],
 *      annotations including readOnlyHint=false)
 *   2. name validation (empty / uppercase / spaces / dots refused)
 *   3. the empty-template trap (agents=[] refused)
 *   4. wrong-typed role / prompt / agent refused BEFORE the write
 *   5. durable write: { template: FleetTemplate } 5-key shape, no internal
 *      `id` leak, visible via list_fleet_templates; second save of the
 *      same name versions (v1 then v2) rather than overwriting
 *   6. open-world: phantom top-level args are ignored and do not leak
 *   7. source-string pin on the handler body (saveFleetTemplateFn +
 *      jsonResult({ template: tpl }) + NO requireString / checkRateLimit)
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-save-fleet-template-mcp-"));
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
    { name: "save-fleet-template-contract-test", version: "1.0.0" },
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

// ---------------------------------------------------------------------------
// T1 — advertised schema pin
// ---------------------------------------------------------------------------

test("save_fleet_template advertises schema with name+agents required and readOnlyHint=false", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "save_fleet_template");
    assert.ok(tool, "save_fleet_template must be advertised");
    assert.deepEqual(tool.inputSchema, {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        agents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string" },
              prompt: { type: "string" },
              agent: { type: "string" },
            },
            required: ["role", "prompt"],
          },
        },
      },
      required: ["name", "agents"],
    });
    assert.deepEqual(tool.annotations, {
      idempotentHint: true,
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });
});

// ---------------------------------------------------------------------------
// T2 — name validation: empty / uppercase / spaces / dots refused
// ---------------------------------------------------------------------------

test("save_fleet_template refuses empty / uppercase / spaced / dotted names with a named error", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const validAgents = [{ role: "worker", prompt: "do the thing" }];
    const cases: ReadonlyArray<{ label: string; name: string }> = [
      { label: "empty-string name", name: "" },
      { label: "whitespace-only name", name: "  " },
      { label: "uppercase name", name: "UPPER" },
      { label: "spaced name", name: "has space" },
      { label: "dotted name", name: "with.dot" },
    ];
    for (const { label, name } of cases) {
      const response = await client.callTool({
        name: "save_fleet_template",
        arguments: { name, agents: validAgents },
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be a tool error, not a silent ok`,
      );
      assert.match(
        textOf(response),
        /Template name/,
        `${label}: rejection text must name the validation rule; got: ${textOf(response)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T3 — empty-template trap: agents=[] refused
// ---------------------------------------------------------------------------

test("save_fleet_template refuses agents=[] as an isError envelope (the empty-template trap)", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const response = await client.callTool({
      name: "save_fleet_template",
      arguments: { name: "empty-template", agents: [] },
    });
    assert.equal(
      (response as ToolResponse).isError,
      true,
      "agents=[] must surface as an isError envelope",
    );
    assert.match(textOf(response), /at least one agent/);
  });
});

// ---------------------------------------------------------------------------
// T4 — wrong-typed role / prompt / agent refused BEFORE the write
// ---------------------------------------------------------------------------

test("save_fleet_template refuses wrong-typed role / prompt / agent as an isError envelope", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const cases: ReadonlyArray<{
      label: string;
      args: Record<string, unknown>;
    }> = [
      {
        label: "truthy non-string role",
        args: { name: "t1", agents: [{ role: 42, prompt: "do the thing" }] },
      },
      {
        label: "truthy non-string prompt",
        args: { name: "t2", agents: [{ role: "worker", prompt: false }] },
      },
      {
        label: "truthy non-string agent",
        args: {
          name: "t3",
          agents: [{ role: "worker", prompt: "do the thing", agent: 7 }],
        },
      },
      {
        label: "empty-string role",
        args: { name: "t4", agents: [{ role: "", prompt: "do the thing" }] },
      },
      {
        label: "whitespace-only prompt",
        args: { name: "t5", agents: [{ role: "worker", prompt: "   " }] },
      },
      {
        label: "empty-string agent",
        args: {
          name: "t6",
          agents: [{ role: "worker", prompt: "do the thing", agent: "" }],
        },
      },
    ];
    for (const { label, args } of cases) {
      const response = await client.callTool({
        name: "save_fleet_template",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be a tool error before any write; got: ${textOf(response)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T5 — durable write + 5-key FleetTemplate + versioning (v1 then v2)
// ---------------------------------------------------------------------------

test("save_fleet_template returns the published FleetTemplate shape, is durable via list_fleet_templates, and versions a second save", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const saved = await client.callTool({
      name: "save_fleet_template",
      arguments: {
        name: "reviewer",
        description: "an LLM-as-judge template",
        agents: [
          { role: "judge", prompt: "score the candidate response" },
          { role: "explainer", prompt: "explain your reasoning" },
        ],
      },
    });
    assert.notEqual(
      (saved as ToolResponse).isError,
      true,
      `first save must succeed; got: ${textOf(saved)}`,
    );
    const tpl = bodyOf(saved).template as Record<string, unknown>;
    assert.ok(tpl, "response must surface { template: ... }");
    assert.deepEqual(
      Object.keys(tpl).sort(),
      FLEET_TEMPLATE_KEYS,
      "FleetTemplate response must contain exactly the documented 5 keys (no internal id leak)",
    );
    assert.equal(tpl.id, undefined, "internal ledger id must not leak");
    assert.equal(tpl.name, "reviewer");
    assert.equal(tpl.description, "an LLM-as-judge template");
    assert.equal(tpl.version, 1);
    assert.equal(typeof tpl.created_at, "number");
    const agents = tpl.agents as Array<Record<string, unknown>>;
    assert.equal(agents.length, 2);
    assert.deepEqual(
      agents.map((a) => a.role),
      ["judge", "explainer"],
    );

    const listed = bodyOf(
      await client.callTool({
        name: "list_fleet_templates",
        arguments: {},
      }),
    );
    const templates = listed.templates as Array<Record<string, unknown>>;
    assert.equal(templates.length, 1);
    assert.equal(templates[0]!.name, "reviewer");
    assert.equal(templates[0]!.version, 1);
    assert.equal(templates[0]!.id, undefined, "list must also strip id");

    // Second save of the same name is append-versioning, not overwrite.
    const savedV2 = await client.callTool({
      name: "save_fleet_template",
      arguments: {
        name: "reviewer",
        description: "v2 of the judge template",
        agents: [{ role: "judge", prompt: "score v2" }],
      },
    });
    assert.notEqual(
      (savedV2 as ToolResponse).isError,
      true,
      `second save must succeed as v2; got: ${textOf(savedV2)}`,
    );
    const tplV2 = bodyOf(savedV2).template as Record<string, unknown>;
    assert.equal(tplV2.version, 2);
    assert.equal(tplV2.description, "v2 of the judge template");

    const listedV2 = bodyOf(
      await client.callTool({
        name: "list_fleet_templates",
        arguments: {},
      }),
    );
    const all = listedV2.templates as Array<Record<string, unknown>>;
    assert.equal(all.length, 2, "both versions must remain visible");
    const versions = all.map((t) => t.version).sort();
    assert.deepEqual(versions, [1, 2]);
  });
});

// ---------------------------------------------------------------------------
// T6 — open-world: phantom top-level args ignored, no leak into template
// ---------------------------------------------------------------------------

test("save_fleet_template ignores phantom top-level args and does not leak them into the template", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const response = await client.callTool({
      name: "save_fleet_template",
      arguments: {
        name: "open-world",
        description: "open-world pin",
        agents: [{ role: "worker", prompt: "do the thing" }],
        phantom_filter: "x",
        debug_emit: true,
        future_field: 42,
      },
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `phantom top-level args must NOT surface as an isError envelope; got: ${textOf(response)}`,
    );
    const tpl = bodyOf(response).template as Record<string, unknown>;
    for (const phantom of ["phantom_filter", "debug_emit", "future_field", "id"]) {
      assert.equal(
        tpl[phantom],
        undefined,
        `${phantom} must NOT leak into the response template`,
      );
    }
    assert.deepEqual(Object.keys(tpl).sort(), FLEET_TEMPLATE_KEYS);
    assert.equal(tpl.name, "open-world");
    assert.equal(tpl.version, 1);
  });
});

// ---------------------------------------------------------------------------
// T7 — source-string pin
// ---------------------------------------------------------------------------

test("save_fleet_template handler source pins saveFleetTemplateFn, jsonResult({ template: tpl }), and the absence of requireString/checkRateLimit", () => {
  const source = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");
  assert.match(
    source,
    /toolHandlers\["save_fleet_template"\]/,
    "save_fleet_template must be a top-level toolHandlers entry",
  );
  assert.match(
    source,
    /saveFleetTemplateFn\(\s*tplName\s*,\s*agents\s*,\s*description\s*\?\?\s*""\s*\)/,
    "handler must call saveFleetTemplateFn(tplName, agents, description ?? '')",
  );
  assert.match(
    source,
    /jsonResult\(\s*\{\s*template:\s*tpl\s*\}\s*\)/,
    "handler must return jsonResult({ template: tpl })",
  );

  const handlerMatch = source.match(
    /toolHandlers\["save_fleet_template"\] = async \(args\) => \{([\s\S]*?)\n\};\s*\n\ntoolHandlers\["list_fleet_templates"\]/,
  );
  assert.ok(
    handlerMatch,
    "save_fleet_template handler block must be found immediately before list_fleet_templates",
  );
  const handlerBody = handlerMatch[1]!;
  assert.doesNotMatch(
    handlerBody,
    /requireString/,
    "save_fleet_template handler currently has NO requireString gate (validation lives in saveFleetTemplateFn); pinning this absence prevents a silent add/remove without a conscious decision",
  );
  assert.doesNotMatch(
    handlerBody,
    /checkRateLimit/,
    "save_fleet_template handler must NOT contain checkRateLimit",
  );
  assert.doesNotMatch(
    handlerBody,
    /importFleetTemplate\s*\(/,
    "handler must not call importFleetTemplate (different version semantics)",
  );
});
