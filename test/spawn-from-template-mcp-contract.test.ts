/**
 * spawn_from_template MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `spawn_from_template` is the READ
 * projection of a saved template onto a SpawnSpec ready to pass to
 * spawn_fleet (src/index.ts advertised schema + handler at
 * toolHandlers["spawn_from_template"]). It is published, yet origin/main
 * has no dedicated test pinning:
 *
 *   1. the advertised schema (properties={name:string}, required=["name"],
 *      annotations including readOnlyHint=true)
 *   2. name validation (missing / non-string / blank refused as isError
 *      that names tool+field — never coerced into "Template \"undefined\"
 *      not found")
 *   3. unknown-template refusal (literal Template "<name>" not found)
 *   4. save → spawn round-trip: {spec:{agents}} with preserved order,
 *      optional agent field, no FleetTemplate leak
 *   5. read-only: the call does not spawn a fleet / create agents
 *   6. open-world: phantom top-level args ignored, no leak into spec
 *   7. source-string pin on the handler body (requireString +
 *      spawnFromTemplateFn(tplName) + jsonResult({ spec }) + the
 *      literal "not found" error)
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * A 2026-09-09 worktree (e7900ff2) existed but never landed and bumped
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-spawn-from-template-mcp-"));
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
    { name: "spawn-from-template-contract-test", version: "1.0.0" },
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

async function saveNamed(
  client: Client,
  name: string,
  description: string,
  agents: Array<Record<string, unknown>>,
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

test("spawn_from_template advertises {name:string} required and readOnlyHint=true", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "spawn_from_template");
    assert.ok(tool, "spawn_from_template must be advertised");
    assert.deepEqual(tool.inputSchema, {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
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
// T2 — name validation: missing / non-string / blank refused as tool+field
// ---------------------------------------------------------------------------

test("spawn_from_template refuses missing / non-string / blank name as isError naming tool+field", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const cases: ReadonlyArray<{ label: string; args: Record<string, unknown> }> = [
      { label: "missing name", args: {} },
      { label: "null name", args: { name: null } },
      { label: "number name", args: { name: 42 } },
      { label: "boolean name", args: { name: true } },
      { label: "array name", args: { name: ["alpha"] } },
      { label: "object name", args: { name: { a: 1 } } },
      { label: "empty-string name", args: { name: "" } },
      { label: "whitespace-only name", args: { name: "   " } },
    ];
    for (const { label, args } of cases) {
      const response = await client.callTool({
        name: "spawn_from_template",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be a tool error, not a silent ok; got: ${textOf(response)}`,
      );
      const text = textOf(response);
      assert.match(
        text,
        /spawn_from_template/,
        `${label}: error must name the tool; got: ${text}`,
      );
      assert.match(
        text,
        /'name' is required/,
        `${label}: error must name the field; got: ${text}`,
      );
      assert.doesNotMatch(
        text,
        /not found/,
        `${label}: wrong-typed name must NOT be reported as Template \"…\" not found; got: ${text}`,
      );
      const body = bodyOf(response);
      assert.equal(
        body.spec,
        undefined,
        `${label}: malformed input must NOT surface a spec; got: ${JSON.stringify(body)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T3 — unknown template refusal
// ---------------------------------------------------------------------------

test("spawn_from_template unknown name returns isError Template \"<name>\" not found", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    await saveNamed(client, "exists", "exists desc", [
      { role: "r", prompt: "p" },
    ]);
    const response = await client.callTool({
      name: "spawn_from_template",
      arguments: { name: "no-such-template" },
    });
    assert.equal(
      (response as ToolResponse).isError,
      true,
      `unknown template MUST return isError; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.equal(
      body.error,
      'Template "no-such-template" not found',
      `parsed error must be the literal Template \"no-such-template\" not found; got: ${JSON.stringify(body)}`,
    );
    assert.equal(
      body.spec,
      undefined,
      `not-found response must NOT carry a spec; got: ${JSON.stringify(body)}`,
    );
    assert.deepEqual(Object.keys(body).sort(), ["error"]);
  });
});

// ---------------------------------------------------------------------------
// T4 — save → spawn round-trip: spec shape, order, optional agent field
// ---------------------------------------------------------------------------

test("spawn_from_template returns {spec:{agents}} with preserved order and no FleetTemplate leak", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    await saveNamed(client, "review-trio", "code review", [
      { role: "writer", prompt: "write a doc", agent: "codex" },
      { role: "reviewer", prompt: "review it" },
    ]);
    const response = await client.callTool({
      name: "spawn_from_template",
      arguments: { name: "review-trio" },
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `known template must not be an isError envelope; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.deepEqual(
      Object.keys(body).sort(),
      ["spec"],
      `response must have exactly {spec} as top-level keys; got: ${Object.keys(body).sort()}`,
    );
    const spec = body.spec as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(spec).sort(),
      ["agents"],
      `spec must carry exactly {agents} (no name/description/version/id leak); got: ${Object.keys(spec).sort()}`,
    );
    const agents = spec.agents as Array<Record<string, unknown>>;
    assert.equal(agents.length, 2, "both saved agents must surface");
    assert.equal(agents[0]!.role, "writer");
    assert.equal(agents[0]!.prompt, "write a doc");
    assert.equal(agents[0]!.agent, "codex");
    assert.equal(agents[1]!.role, "reviewer");
    assert.equal(agents[1]!.prompt, "review it");
    assert.ok(
      !("agent" in agents[1]!),
      `TemplateAgent without explicit 'agent' must NOT carry a phantom 'agent' key; got: ${JSON.stringify(agents[1])}`,
    );
    for (const leak of ["name", "description", "version", "id", "created_at"]) {
      assert.equal(
        spec[leak],
        undefined,
        `${leak} must NOT leak from FleetTemplate into SpawnSpec`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T5 — read-only: does not spawn a fleet or mutate templates
// ---------------------------------------------------------------------------

test("spawn_from_template is read-only: no fleet is spawned and the template ledger is unchanged", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    await saveNamed(client, "readonly-pin", "ro", [
      { role: "r", prompt: "p" },
    ]);
    const beforeList = bodyOf(
      await client.callTool({ name: "list_fleet_templates", arguments: {} }),
    );
    assert.equal(
      (beforeList.templates as unknown[]).length,
      1,
      "precondition: exactly one saved template",
    );

    const spawn = await client.callTool({
      name: "spawn_from_template",
      arguments: { name: "readonly-pin" },
    });
    assert.notEqual(
      (spawn as ToolResponse).isError,
      true,
      `spawn_from_template must succeed; got: ${textOf(spawn)}`,
    );

    const fleets = bodyOf(
      await client.callTool({ name: "list_fleets", arguments: {} }),
    );
    assert.deepEqual(
      fleets.fleets,
      [],
      `readOnlyHint=true means no fleet is spawned; got: ${JSON.stringify(fleets)}`,
    );

    const afterList = bodyOf(
      await client.callTool({ name: "list_fleet_templates", arguments: {} }),
    );
    assert.equal(
      (afterList.templates as unknown[]).length,
      1,
      "template ledger must be unchanged by spawn_from_template",
    );
    assert.equal(
      (afterList.templates as Array<Record<string, unknown>>)[0]!.name,
      "readonly-pin",
    );
  });
});

// ---------------------------------------------------------------------------
// T6 — open-world: phantom top-level args ignored, no leak into spec
// ---------------------------------------------------------------------------

test("spawn_from_template ignores phantom top-level args and keeps response keys exactly {spec}", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    await saveNamed(client, "open-world", "ow", [
      { role: "r", prompt: "p" },
    ]);
    const response = await client.callTool({
      name: "spawn_from_template",
      arguments: {
        name: "open-world",
        phantom_filter: "should-be-ignored",
        debug_emit: 42,
        future_field: { a: 1, b: [2, 3] },
        version: 99,
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
      ["spec"],
      `response must have exactly {spec} regardless of phantom args; got: ${Object.keys(body).sort()}`,
    );
    const spec = body.spec as Record<string, unknown>;
    assert.deepEqual(Object.keys(spec).sort(), ["agents"]);
    for (const phantom of [
      "phantom_filter",
      "debug_emit",
      "future_field",
      "version",
      "id",
    ]) {
      assert.equal(
        spec[phantom],
        undefined,
        `${phantom} must NOT leak into the SpawnSpec`,
      );
      assert.equal(
        body[phantom],
        undefined,
        `${phantom} must NOT leak into the top-level response`,
      );
    }
    const agents = spec.agents as Array<Record<string, unknown>>;
    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.role, "r");
  });
});

// ---------------------------------------------------------------------------
// T7 — source-string pin
// ---------------------------------------------------------------------------

test("spawn_from_template handler source pins requireString, spawnFromTemplateFn, jsonResult({ spec }), and the literal not-found error", () => {
  const source = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");
  assert.match(
    source,
    /toolHandlers\["spawn_from_template"\]/,
    "spawn_from_template must be a top-level toolHandlers entry",
  );
  assert.match(
    source,
    /jsonResult\(\s*\{\s*spec\s*\}\s*\)/,
    "handler must return jsonResult({ spec })",
  );

  const handlerMatch = source.match(
    /toolHandlers\["spawn_from_template"\] = async \(args\) => \{([\s\S]*?)\n\};\s*\n\n\/\/ -+\n\/\/ Discussions \(D3\)/,
  );
  assert.ok(
    handlerMatch,
    "spawn_from_template handler block must be found immediately before the Discussions (D3) section",
  );
  const handlerBody = handlerMatch[1]!;
  assert.match(
    handlerBody,
    /requireString\(\s*"spawn_from_template"\s*,\s*"name"\s*,\s*tplName\s*\)/,
    "handler must gate name through requireString before delegating",
  );
  assert.match(
    handlerBody,
    /spawnFromTemplateFn\(tplName\)/,
    "handler must call spawnFromTemplateFn(tplName) (name only — no version arg on the MCP surface)",
  );
  assert.match(
    handlerBody,
    /jsonError\(`Template "\$\{tplName\}" not found`\)/,
    "unknown-template path must use the literal Template \"${tplName}\" not found message",
  );
  assert.match(
    handlerBody,
    /jsonResult\(\s*\{\s*spec\s*\}\s*\)/,
    "success path must return jsonResult({ spec }) — shorthand, not { spec: … } wrapping extra fields",
  );
  assert.doesNotMatch(
    handlerBody,
    /spawnFleet/,
    "handler must NOT call spawnFleet (readOnlyHint=true — this tool returns a spec, it does not spawn)",
  );
  assert.doesNotMatch(
    handlerBody,
    /checkRateLimit/,
    "spawn_from_template handler must NOT contain checkRateLimit",
  );
  assert.doesNotMatch(
    handlerBody,
    /spawnFromTemplateFn\(\s*tplName\s*,/,
    "MCP handler must NOT pass a version argument — advertised schema is name-only",
  );
});
