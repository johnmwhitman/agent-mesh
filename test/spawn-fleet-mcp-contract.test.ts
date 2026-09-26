/**
 * spawn_fleet MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names. Honesty-pattern refresh (2026-09-12).
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `spawn_fleet` is the only WRITE tool that
 * starts OS processes off the request (src/index.ts advertised schema at
 * L660-L717 + handler at toolHandlers["spawn_fleet"] L1759-L1914 on
 * origin/main 8433dcb8). It is the highest-blast-radius member of the
 * family. The 2026-09-09 worktree (5ff637d7) never landed on origin/main
 * and mixed a published-figure bump (HANDOFF 1809 -> 1816) into the same
 * card. origin/main already ships refusal-before-write witnesses in
 * test/spawn-contract.test.ts (missing prompt / non-string role / model
 * selector / accepted-call control) but those do NOT pin advertised-vs-
 * handler honesty: additionalProperties absence, the four annotations,
 * description phrases, phantom extra keys, source-string shape, unknown-
 * runtime refuse-before-write, or the named bug class (blind
 * `args as { agents: ... }` destructure-cast plus missing-prompt returning
 * a fleet_id, committing a NULL-prompt row, and calling trySpawn). This
 * card is a fresh origin/main pin with the 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — {type:object,
 *      properties:{agents:{type:array, items:{type:object,
 *      properties:{role,prompt,agent?,model?,runtime?,workspace_binding?,
 *      expects_artifact?}, required:[role,prompt]}}}, required:[agents]}
 *      with NO additionalProperties key (advertising false would be a lie;
 *      handler has no requireAllowedKeys) + annotations {openWorldHint:true,
 *      readOnlyHint:false, destructiveHint:false, idempotentHint:false}
 *      + description phrases "Spawn parallel agents", "Returns fleet_id",
 *      and "banks complete only when result_contract is ok".
 *   2. agents container-level — missing / undefined / non-array agents
 *      all return isError:true naming spawn_fleet + agents + array AND
 *      NEVER a phantom fleet_id (the published-required gate the SDK
 *      does not enforce).
 *   3. named bug class — a missing / non-string / blank role or prompt
 *      (and a present-but-wrong-typed agent) used to stringify into a
 *      spawn identity. requireString must fire BEFORE withLedger /
 *      trySpawn. The measured defect: `{"agents":[{"role":"reviewer"}]}`
 *      returned a fleet_id, committed a fleet + agent row whose prompt
 *      was NULL, and called trySpawn (handler comment at L1733-L1740).
 *   4. unknown-runtime jsonError BEFORE the transaction and the spawn
 *      (`spawn_fleet: unknown runtime '...'`). Resolving lazily inside
 *      trySpawn would throw AFTER the fleet row was committed.
 *   5. happy-path envelope — well-formed call returns EXACTLY
 *      {fleet_id:string, agent_ids:string[]} with agent_ids.length ==
 *      agents.length and unique ids. AGENT_MESH_CHILD=1 + a stub
 *      `opencode` on PATH keep the spawn hermetic.
 *   6. advertised-vs-handler honesty — phantom top-level keys
 *      (phantom_filter/debug_emit/future_field/force/nested/note) are
 *      silently ignored AND no phantom keys leak into the response.
 *      This is HONEST: additionalProperties is not advertised,
 *      handler does not enforce it.
 *   7. source-string pin — handler destructure-casts
 *      `const { agents } = args as { agents: {...}[] }` then
 *      `if (!Array.isArray(agents)) return jsonError("spawn_fleet: 'agents'
 *      is required and must be an array")` then unknown-runtime refuse
 *      then firstError(requireString role, requireString prompt, optional
 *      agent, optionalModelSelector, optionalBoolean expects_artifact)
 *      then jsonResult({ fleet_id, agent_ids }) with NO requireAllowedKeys
 *      and NO String(agents). Named bug class is the handler
 *      destructure-cast of args PLUS the missing-prompt NULL-row spawn.
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * WRITE-ISOLATION LAW: spawn_fleet writes to the ledger AND starts a
 * process. Every run that opens a child sets ALL THREE of
 * MESHFLEET_DB_FILE, MESHFLEET_DATA_FILE, MESHFLEET_EVENT_LOG_FILE to
 * temp paths — never the live ~/.config/opencode/agent-mesh.db — plus
 * AGENT_MESH_CHILD=1 and a stub `opencode` on PATH so accepted-call
 * legs cannot launch the operator's real OpenCode.
 *
 * No published-figure bump. HANDOFF.md is not edited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
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
  binDir: string;
};

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-spawn-fleet-mcp-20260912-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-spawn-fleet-20260912-${dir}`,
      private: true,
      version: "1.0.0",
    }) + "\n",
  );
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const opencodePath = join(binDir, "opencode");
  writeFileSync(
    opencodePath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const modelIndex = args.indexOf("--model");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "openai/gpt-5";
process.stdout.write("boundary test complete\\n");
process.stderr.write("> boundary-test · " + model + "\\n");
`,
    { mode: 0o755 },
  );
  chmodSync(opencodePath, 0o755);
  return {
    dir,
    dataFile: join(dir, "ledger.json"),
    dbFile: join(dir, "ledger.db"),
    eventsFile: join(dir, "events.jsonl"),
    binDir,
  };
}

/**
 * applyFixtureEnv MUST be called BEFORE the child connects so the
 * cached better-sqlite3 handle inside src/db.ts opens against the
 * tempdir, not the live ~/.config/opencode/agent-mesh.db (which is on
 * storage_schema_version=5 and would raise unsupported-newer-schema).
 * HOME points at the tempdir so any discoverPremadeAgents() call
 * the handler chain hits cannot fail from a missing HOME.
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
  PATH: `${fix.binDir}:${process.env.PATH ?? ""}`,
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
    { name: "spawn-fleet-contract-test", version: "1.0.0" },
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

const SPAWN_FLEET_ANNOTATIONS = {
  openWorldHint: true,
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
} as const;

const AGENT_DESCRIPTION =
  "Premade agent filename stem (e.g. 'frontend-developer'). See list_agents.";
const MODEL_DESCRIPTION =
  "Optional OpenCode model selector as provider/model (e.g. 'opencode-go/minimax-m3').";
const RUNTIME_DESCRIPTION =
  "Runtime adapter to spawn this agent under. Omit for the default. `model` " +
  "is adapter-specific (the default OpenCode runtime accepts it); `runtime` " +
  "picks the harness itself, so agents " +
  "in one fleet can run under different CLIs and one provider outage cannot stop " +
  "every agent at once. Not supported in durable lifecycle mode.";
const WORKSPACE_BINDING_DESCRIPTION =
  "Opaque identifier for a workspace the caller asserts is verified isolation. " +
  "Never a path. Some runtimes refuse to edit files without one, and the claim " +
  "grants nothing on its own — the runtime independently admits the identifier " +
  "from operator configuration. Ignored when 'runtime' is omitted.";
const EXPECTS_ARTIFACT_DESCRIPTION =
  "Declare that this agent's result envelope must name at least one produced " +
  "file: a 'done' declaration with no artifacts is recorded as " +
  "result_contract 'artifact_missing' instead of 'ok' and banks failed; the agent is told " +
  "so in its prompt. Restricted text runtimes refuse this request. Named " +
  "paths are existence-checked only — this is a " +
  "declared-output check, never a content or quality guarantee.";

function extractHandlerBlock(src: string): string {
  const match = src.match(/toolHandlers\["spawn_fleet"\][\s\S]*?^};/m);
  assert.ok(match, "spawn_fleet handler block must be extractable");
  return match[0];
}

function extractSchemaBlock(src: string): {
  schema: string;
  annotations: string;
  description: string;
} {
  const start = src.indexOf('name: "spawn_fleet"');
  assert.notEqual(start, -1, "advertised spawn_fleet schema block must be extractable");
  const window = src.slice(start, start + 4200);
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

function assertNoPhantomFleetId(body: Record<string, unknown>, label: string): void {
  assert.equal(
    "fleet_id" in body,
    false,
    `${label}: MUST NOT carry a phantom fleet_id; got: ${JSON.stringify(body)}`,
  );
  assert.equal(
    "agent_ids" in body,
    false,
    `${label}: MUST NOT carry a phantom agent_ids; got: ${JSON.stringify(body)}`,
  );
}

async function callOk(
  client: Client,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name: "spawn_fleet", arguments: args });
  assert.notEqual(
    (response as ToolResponse).isError,
    true,
    `spawn_fleet must succeed; got: ${textOf(response)}`,
  );
  return bodyOf(response);
}

// ─── Test 1: advertised schema + annotations + description honesty ───

test("spawn_fleet: advertised schema requires agents[] with role+prompt, no additionalProperties, four annotations, description names Spawn parallel agents", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "spawn_fleet");
    assert.ok(tool, "spawn_fleet must be advertised");

    assert.deepEqual(tool!.inputSchema, {
      type: "object",
      properties: {
        agents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string" },
              prompt: { type: "string" },
              agent: {
                type: "string",
                description: AGENT_DESCRIPTION,
              },
              model: {
                type: "string",
                description: MODEL_DESCRIPTION,
              },
              runtime: {
                type: "string",
                description: RUNTIME_DESCRIPTION,
              },
              workspace_binding: {
                type: "string",
                description: WORKSPACE_BINDING_DESCRIPTION,
              },
              expects_artifact: {
                type: "boolean",
                description: EXPECTS_ARTIFACT_DESCRIPTION,
              },
            },
            required: ["role", "prompt"],
          },
        },
      },
      required: ["agents"],
    });
    // Honesty: handler ignores extra keys and has no requireAllowedKeys.
    // Advertising additionalProperties:false would be a lie.
    assert.equal(
      "additionalProperties" in tool!.inputSchema,
      false,
      "additionalProperties must be ABSENT — handler never enforces it; advertising false would be a lie",
    );

    assert.deepEqual(tool!.annotations, SPAWN_FLEET_ANNOTATIONS);

    const desc = tool!.description ?? "";
    assert.match(desc, /Spawn parallel agents/);
    assert.match(desc, /Returns fleet_id/);
    assert.match(desc, /banks complete only when result_contract is ok/);
    // Description also names the failed result_contract values so callers
    // can distinguish them from ok without reading the source.
    assert.match(desc, /refused/);
    assert.match(desc, /blocked/);
    assert.match(desc, /artifact_missing/);
    assert.match(desc, /invalid/);
    assert.match(desc, /absent/);
  });
});

// ─── Test 2: agents container-level — missing / non-array ───

test("spawn_fleet: refuses missing / non-array agents with a named error (never a phantom fleet_id)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const cases: ReadonlyArray<{
      label: string;
      args: Record<string, unknown>;
    }> = [
      { label: "missing agents", args: {} },
      { label: "null agents", args: { agents: null } },
      { label: "string agents", args: { agents: "reviewer" } },
      { label: "number agents", args: { agents: 7 } },
      { label: "boolean agents", args: { agents: true } },
      { label: "object agents", args: { agents: { role: "reviewer", prompt: "go" } } },
    ];
    for (const { label, args } of cases) {
      const response = await client.callTool({
        name: "spawn_fleet",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be a tool error, not a silent spawn`,
      );
      assert.match(
        textOf(response),
        /spawn_fleet: 'agents' is required and must be an array/,
        `${label}: rejection text must name spawn_fleet + agents + array; got: ${textOf(response)}`,
      );
      assertNoPhantomFleetId(bodyOf(response), label);
    }
  });
});

// ─── Test 3: named bug class — missing/wrong-typed role/prompt/agent ───

test("spawn_fleet: refuses missing / non-string / blank role or prompt (and wrong-typed agent) BEFORE any write — the NULL-prompt spawn defect", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const cases: ReadonlyArray<{
      label: string;
      args: Record<string, unknown>;
      needle: RegExp;
    }> = [
      {
        label: "missing prompt (the documented NULL-row spawn defect)",
        args: { agents: [{ role: "reviewer" }] },
        needle: /spawn_fleet: 'agents\[0\]\.prompt' is required and must be a non-empty string/,
      },
      {
        label: "missing role",
        args: { agents: [{ prompt: "do the thing" }] },
        needle: /spawn_fleet: 'agents\[0\]\.role' is required and must be a non-empty string/,
      },
      {
        label: "number role",
        args: { agents: [{ role: 42, prompt: "do the thing" }] },
        needle: /spawn_fleet: 'agents\[0\]\.role' is required and must be a non-empty string/,
      },
      {
        label: "boolean prompt",
        args: { agents: [{ role: "worker", prompt: false }] },
        needle: /spawn_fleet: 'agents\[0\]\.prompt' is required and must be a non-empty string/,
      },
      {
        label: "empty-string role",
        args: { agents: [{ role: "", prompt: "do the thing" }] },
        needle: /spawn_fleet: 'agents\[0\]\.role' is required and must be a non-empty string/,
      },
      {
        label: "whitespace-only prompt",
        args: { agents: [{ role: "worker", prompt: "   " }] },
        needle: /spawn_fleet: 'agents\[0\]\.prompt' is required and must be a non-empty string/,
      },
      {
        label: "null prompt",
        args: { agents: [{ role: "worker", prompt: null }] },
        needle: /spawn_fleet: 'agents\[0\]\.prompt' is required and must be a non-empty string/,
      },
      {
        label: "array role",
        args: { agents: [{ role: ["reviewer"], prompt: "do the thing" }] },
        needle: /spawn_fleet: 'agents\[0\]\.role' is required and must be a non-empty string/,
      },
      {
        label: "object prompt",
        args: { agents: [{ role: "worker", prompt: { text: "go" } }] },
        needle: /spawn_fleet: 'agents\[0\]\.prompt' is required and must be a non-empty string/,
      },
      {
        label: "number agent (present-but-wrong-typed)",
        args: { agents: [{ role: "worker", prompt: "do the thing", agent: 7 }] },
        needle: /spawn_fleet: 'agents\[0\]\.agent' is required and must be a non-empty string/,
      },
      {
        label: "empty-string agent",
        args: { agents: [{ role: "worker", prompt: "do the thing", agent: "" }] },
        needle: /spawn_fleet: 'agents\[0\]\.agent' is required and must be a non-empty string/,
      },
    ];
    for (const { label, args, needle } of cases) {
      const response = await client.callTool({
        name: "spawn_fleet",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be a tool error, not a NULL-prompt spawn`,
      );
      assert.match(
        textOf(response),
        needle,
        `${label}: rejection text must name the field; got: ${textOf(response)}`,
      );
      assertNoPhantomFleetId(bodyOf(response), label);
    }
  });
});

// ─── Test 4: unknown runtime refused BEFORE the transaction and the spawn ───

test("spawn_fleet: unknown runtime returns isError naming spawn_fleet + unknown runtime BEFORE any write", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "spawn_fleet",
      arguments: {
        agents: [
          {
            role: "worker",
            prompt: "do the thing",
            runtime: "definitely-not-a-registered-runtime",
          },
        ],
      },
    });
    assert.equal(
      (response as ToolResponse).isError,
      true,
      "unknown runtime must be a tool error, not a committed fleet whose agents never start",
    );
    assert.match(
      textOf(response),
      /spawn_fleet: unknown runtime 'definitely-not-a-registered-runtime'/,
      `error must name spawn_fleet + unknown runtime + the id; got: ${textOf(response)}`,
    );
    assert.match(
      textOf(response),
      /Available:/,
      `error must list Available runtimes; got: ${textOf(response)}`,
    );
    assertNoPhantomFleetId(bodyOf(response), "unknown runtime");
  });
});

// ─── Test 5: happy-path success envelope ───

test("spawn_fleet: returns EXACTLY {fleet_id, agent_ids} with unique ids matching agents.length", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const agents = [
      { role: "reviewer", prompt: "score the candidate" },
      { role: "explainer", prompt: "explain your reasoning" },
      { role: "summariser", prompt: "summarise the result" },
    ];
    const body = await callOk(client, { agents });
    assert.deepEqual(
      Object.keys(body).sort(),
      ["agent_ids", "fleet_id"],
      `success must return EXACTLY {fleet_id, agent_ids}; got keys ${JSON.stringify(Object.keys(body).sort())}`,
    );
    assert.equal(typeof body.fleet_id, "string");
    assert.ok(
      (body.fleet_id as string).length > 0,
      "fleet_id must be a non-empty string",
    );
    assert.ok(Array.isArray(body.agent_ids), "agent_ids must be an array");
    const agentIds = body.agent_ids as string[];
    assert.equal(
      agentIds.length,
      agents.length,
      "agent_ids length must equal agents.length",
    );
    assert.equal(
      new Set(agentIds).size,
      agentIds.length,
      "every agent_id must be unique (a duplicate would alias two agents to one inbox)",
    );
    for (const id of agentIds) {
      assert.equal(typeof id, "string");
      assert.ok(id.length > 0, "every agent_id must be a non-empty string");
    }
  });
});

// ─── Test 6: phantom extra keys silently ignored (honesty) ───

test("spawn_fleet: phantom extra keys are silently ignored (additionalProperties not advertised, handler does not enforce)", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const result = await callOk(client, {
      agents: [{ role: "worker", prompt: "do the thing" }],
      phantom_filter: "ignored",
      debug_emit: true,
      future_field: 42,
      force: "yes",
      nested: { a: 1 },
      note: "should be ignored",
    });
    assert.equal(typeof result.fleet_id, "string");
    assert.ok(Array.isArray(result.agent_ids));
    assert.equal((result.agent_ids as string[]).length, 1);
    assert.equal(result.phantom_filter, undefined);
    assert.equal(result.debug_emit, undefined);
    assert.equal(result.future_field, undefined);
    assert.equal(result.force, undefined);
    assert.equal(result.nested, undefined);
    assert.equal(result.note, undefined);
    const extraTop = Object.keys(result).filter(
      (k) => k !== "fleet_id" && k !== "agent_ids",
    );
    assert.deepEqual(
      extraTop,
      [],
      `phantom keys must NOT leak into the response; extra: ${extraTop.join(",")}`,
    );
  });
});

// ─── Test 7: source-string pin ───

test("spawn_fleet: source-string pin — destructure-cast + Array.isArray agents + requireString role/prompt + unknown-runtime refuse + jsonResult envelope, no allowedKeys", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    const registrations = src.match(/toolHandlers\["spawn_fleet"\]/g) ?? [];
    assert.equal(
      registrations.length,
      1,
      `handler must be registered exactly once; got ${registrations.length}`,
    );

    const handlerBlock = extractHandlerBlock(src);
    assert.match(
      handlerBlock,
      /toolHandlers\["spawn_fleet"\]\s*=\s*async\s*\(\s*args\s*\)\s*=>\s*\{/,
    );
    assert.match(
      handlerBlock,
      /const\s*\{\s*agents\s*\}\s*=\s*args\s+as\s+\{/,
    );
    assert.match(
      handlerBlock,
      /if\s*\(\s*!Array\.isArray\(\s*agents\s*\)\s*\)/,
    );
    assert.match(
      handlerBlock,
      /jsonError\(\s*"spawn_fleet: 'agents' is required and must be an array"\s*\)/,
    );
    assert.match(
      handlerBlock,
      /availableRuntimeIds\(\s*\)/,
    );
    assert.match(
      handlerBlock,
      /unknown runtime '\$\{badRuntimeAgent\.runtime\}'/,
    );
    assert.match(
      handlerBlock,
      /requireString\(\s*"spawn_fleet"\s*,\s*`agents\[\$\{i\}\]\.role`\s*,\s*a\?\.role\s*\)/,
    );
    assert.match(
      handlerBlock,
      /requireString\(\s*"spawn_fleet"\s*,\s*`agents\[\$\{i\}\]\.prompt`\s*,\s*a\?\.prompt\s*\)/,
    );
    assert.match(
      handlerBlock,
      /a\?\.agent === undefined\s*\n?\s*\? null\s*\n?\s*: requireString\(\s*"spawn_fleet"\s*,\s*`agents\[\$\{i\}\]\.agent`\s*,\s*a\.agent\s*\)/,
    );
    assert.match(
      handlerBlock,
      /optionalModelSelector\(\s*"spawn_fleet"\s*,\s*`agents\[\$\{i\}\]\.model`\s*,\s*a\?\.model\s*\)/,
    );
    assert.match(
      handlerBlock,
      /optionalBoolean\(\s*"spawn_fleet"\s*,\s*`agents\[\$\{i\}\]\.expects_artifact`\s*,\s*a\?\.expects_artifact\s*\)/,
    );
    assert.match(
      handlerBlock,
      /return jsonResult\(\s*\{\s*fleet_id:\s*fleetId\s*,\s*agent_ids:\s*specs\.map\(\(s\)\s*=>\s*s\.agentId\)\s*\}\s*\)/,
    );
    assert.match(handlerBlock, /trySpawn\(/);
    assert.match(handlerBlock, /appendEvent\(\s*"spawn_fleet_called"/);
    assert.doesNotMatch(
      handlerBlock,
      /requireAllowedKeys/,
      "handler must NOT enforce additionalProperties (advertising false would be a lie)",
    );
    assert.doesNotMatch(
      handlerBlock,
      /String\s*\(\s*agents\s*\)/,
      "handler must NOT coerce agents via String() — that is the stringified-lookup-key defect",
    );
    // Named NULL-prompt spawn defect comment must still document why
    // requireString fires before the transaction.
    assert.match(
      handlerBlock,
      /blind cast above let `\{"agents":\[\{"role":"reviewer"\}\]\}` return a normal/,
    );
    assert.match(
      handlerBlock,
      /prompt is NULL/,
    );
    assert.match(
      handlerBlock,
      /highest-blast-radius member/,
    );
    assert.match(
      handlerBlock,
      /Refuse an unknown runtime BEFORE the transaction and the spawn/,
    );

    const { schema, annotations, description } = extractSchemaBlock(src);
    assert.match(schema, /type:\s*"object"/);
    assert.match(schema, /required:\s*\[\s*"agents"\s*\]/);
    assert.match(schema, /required:\s*\[\s*"role"\s*,\s*"prompt"\s*\]/);
    assert.doesNotMatch(
      schema,
      /additionalProperties/,
      "advertised schema must NOT carry additionalProperties (handler does not enforce it)",
    );
    assert.match(annotations, /openWorldHint:\s*true/);
    assert.match(annotations, /readOnlyHint:\s*false/);
    assert.match(annotations, /destructiveHint:\s*false/);
    assert.match(annotations, /idempotentHint:\s*false/);
    assert.match(description, /Spawn parallel agents/);
    assert.match(description, /Returns fleet_id/);
    assert.match(description, /banks complete only when result_contract is ok/);

    // Live wire still refuses a missing prompt after the source pin.
    const response = await client.callTool({
      name: "spawn_fleet",
      arguments: { agents: [{ role: "reviewer" }] },
    });
    assert.equal((response as ToolResponse).isError, true);
    assert.match(
      textOf(response),
      /spawn_fleet: 'agents\[0\]\.prompt' is required and must be a non-empty string/,
    );
    assertNoPhantomFleetId(bodyOf(response), "source-pin live wire");
  });
});

// ─── Test 8: restricted text-only runtime refuses incompatible options ───

/**
 * The minimax-cli adapter is permissions.mode "restricted" (text-only). When a
 * caller asks for agent, model, workspace_binding, or expects_artifact on a
 * restricted runtime, the handler must refuse BEFORE the transaction with a
 * named error. A regression that dropped the incompatibleRestricted check
 * would let a text-only lane silently ignore these options (or worse, try to
 * honor them and crash mid-spawn).
 *
 * We register minimax-cli by setting MESHFLEET_MINIMAX_COMMAND + VERSION in
 * the child env, pointing at a dummy absolute path. The refusal happens
 * before any spawn, so the dummy is never executed.
 */
test("spawn_fleet: restricted text-only runtime refuses agent/model/workspace_binding/expects_artifact BEFORE any write", async () => {
  const fix = makeFixture();
  // Register minimax-cli in the child by pointing at a dummy command.
  // The handler validates permissions.mode === "restricted" from the
  // descriptor, not by executing the command, so a non-existent binary
  // is sufficient — the refusal fires before any spawn.
  const dummyMmx = join(fix.binDir, "mmx");
  writeFileSync(dummyMmx, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
  chmodSync(dummyMmx, 0o755);

  const restrictedEnv = (fix: Fixture): Record<string, string> => ({
    ...childEnv(fix),
    MESHFLEET_MINIMAX_COMMAND: dummyMmx,
    MESHFLEET_MINIMAX_VERSION: "0.0.0-test",
  });

  applyFixtureEnv(fix);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs"),
      join(repoRoot, "src", "index.ts"),
    ],
    cwd: fix.dir,
    env: restrictedEnv(fix),
    stderr: "ignore",
  });
  const client = new Client(
    { name: "spawn-fleet-restricted-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    // First confirm minimax-cli is registered and restricted.
    const badRuntimeResponse = await client.callTool({
      name: "spawn_fleet",
      arguments: {
        agents: [
          {
            role: "worker",
            prompt: "do the thing",
            runtime: "minimax-cli",
            model: "minimax/m3",
          },
        ],
      },
    });
    assert.equal(
      (badRuntimeResponse as ToolResponse).isError,
      true,
      "restricted runtime + model must be refused, not silently ignored",
    );
    assert.match(
      textOf(badRuntimeResponse),
      /spawn_fleet: runtime 'minimax-cli' is text-only/,
      "error must name the restricted runtime and its text-only mode",
    );
    assert.match(
      textOf(badRuntimeResponse),
      /omit agent, model, workspace_binding, and expects_artifact/,
      "error must list all four incompatible options",
    );
    assertNoPhantomFleetId(bodyOf(badRuntimeResponse), "restricted+model");

    // Each incompatible option alone must also be refused.
    for (const incompatible of [
      { label: "agent", key: "agent", val: "frontend-developer" },
      { label: "model", key: "model", val: "minimax/m3" },
      { label: "workspace_binding", key: "workspace_binding", val: "ws-1" },
      { label: "expects_artifact", key: "expects_artifact", val: true },
    ] as const) {
      const response = await client.callTool({
        name: "spawn_fleet",
        arguments: {
          agents: [
            {
              role: "worker",
              prompt: "do the thing",
              runtime: "minimax-cli",
              [incompatible.key]: incompatible.val,
            },
          ],
        },
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `restricted runtime + ${incompatible.label} must be refused`,
      );
      assert.match(
        textOf(response),
        /spawn_fleet: runtime 'minimax-cli' is text-only/,
        `${incompatible.label}: error must name the restricted runtime`,
      );
      assertNoPhantomFleetId(bodyOf(response), `restricted+${incompatible.label}`);
    }

    // Restricted runtime with NO incompatible options should NOT be refused
    // by the incompatibleRestricted check (it may fail later in durable
    // mode or succeed in legacy mode — we only pin that the restricted
    // check itself does not fire).
    // We only assert that the error (if any) is NOT the text-only message.
    const cleanResponse = await client.callTool({
      name: "spawn_fleet",
      arguments: {
        agents: [
          {
            role: "worker",
            prompt: "do the thing",
            runtime: "minimax-cli",
          },
        ],
      },
    });
    const cleanText = textOf(cleanResponse);
    assert.doesNotMatch(
      cleanText,
      /is text-only/,
      "restricted runtime without incompatible options must NOT hit the text-only refusal",
    );
  } finally {
    await client.close().catch(() => {});
    await cleanupFix(fix);
  }
});

// ─── Test 9: durable lifecycle mode refuses per-agent runtime ───

/**
 * In durable lifecycle mode, the handler refuses per-agent runtime because
 * the persisted Agent row has no runtime column — a durable respawn would
 * come back on the default adapter. This refusal must happen BEFORE
 * lifecycleCoordinator.createFleet, so the error surfaces without a
 * committed fleet row.
 *
 * We set MESHFLEET_LIFECYCLE_MODE=durable in the child env. The refusal
 * fires before createFleet, so no durable-mode DB machinery is exercised.
 */
test("spawn_fleet: durable lifecycle mode refuses per-agent runtime BEFORE createFleet", async () => {
  const fix = makeFixture();
  const durableEnv = (fix: Fixture): Record<string, string> => ({
    ...childEnv(fix),
    MESHFLEET_LIFECYCLE_MODE: "durable",
  });

  applyFixtureEnv(fix);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs"),
      join(repoRoot, "src", "index.ts"),
    ],
    cwd: fix.dir,
    env: durableEnv(fix),
    stderr: "ignore",
  });
  const client = new Client(
    { name: "spawn-fleet-durable-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    const response = await client.callTool({
      name: "spawn_fleet",
      arguments: {
        agents: [
          {
            role: "worker",
            prompt: "do the thing",
            runtime: "local-demo",
          },
        ],
      },
    });
    assert.equal(
      (response as ToolResponse).isError,
      true,
      "durable mode + per-agent runtime must be refused, not silently downgraded to default adapter",
    );
    assert.match(
      textOf(response),
      /spawn_fleet: per-agent 'runtime' is not supported in durable lifecycle mode/,
      "error must name the durable-mode runtime refusal",
    );
    assert.match(
      textOf(response),
      /durable respawn rehydrates from the agent row and the row does not persist it/,
      "error must explain why: the agent row has no runtime column",
    );
    assert.match(
      textOf(response),
      /Use legacy or shadow mode, or omit 'runtime'/,
      "error must offer the workaround",
    );
    assertNoPhantomFleetId(bodyOf(response), "durable+runtime");

    // Durable mode WITHOUT runtime should NOT hit this refusal. It may
    // succeed or fail in createFleet, but the error (if any) must NOT be
    // the durable-runtime refusal.
    const cleanResponse = await client.callTool({
      name: "spawn_fleet",
      arguments: {
        agents: [{ role: "worker", prompt: "do the thing" }],
      },
    });
    const cleanText = textOf(cleanResponse);
    assert.doesNotMatch(
      cleanText,
      /not supported in durable lifecycle mode/,
      "durable mode without per-agent runtime must NOT hit the durable-runtime refusal",
    );
  } finally {
    await client.close().catch(() => {});
    await cleanupFix(fix);
  }
});
