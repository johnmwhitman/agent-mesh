/**
 * list_agents MCP contract — driven over real MCP stdio with the
 * tool's PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1. GOAL-PROMPT says every published
 * tool gets a stdio contract pin. `list_agents` is the canonical READ of
 * the .opencode/agents/ + ~/.config/opencode/agents/ directory pair
 * (src/index.ts advertised schema at L1486-L1491 + handler at
 * toolHandlers["list_agents"] L2493-L2496 on origin/main 8433dcb8). It
 * is published. 2026-09-08 a82568ce / 2026-09-09 / 2026-09-11
 * list-agents-mcp-contract worktrees never landed. This card is a fresh
 * origin/main pin with the 2026-09-12 honesty pattern:
 *
 *   1. advertised schema pin — {type:object, properties:{}} with NO
 *      required array and NO additionalProperties key (advertising
 *      false would be a lie; handler never reads args and has no
 *      requireAllowedKeys) + annotations {readOnlyHint:true,
 *      idempotentHint:true, destructiveHint:false, openWorldHint:false}
 *      + description phrases "premade agents" and ".opencode/agents/"
 *   2. empty-discovery surface returns exactly {count:0, agents:[]} —
 *      both keys present, no isError, no ok/error/status envelope
 *   3. PremadeAgent 4-key shape — each entry is EXACTLY
 *      {filename, name, description, mode}; no path/dir leak
 *   4. front-matter + defaults — name:/description:/mode: populate;
 *      missing description -> ""; missing mode -> "subagent"; missing
 *      name -> stem. Body text never bleeds into description
 *   5. skip + cwd-wins — a .md with no --- fence is skipped (no
 *      isError, count does not increment); the same stem in cwd
 *      `.opencode/agents/` and HOME `~/.config/opencode/agents/`
 *      surfaces ONCE, cwd copy winning
 *   6. advertised-vs-handler honesty — phantom top-level keys
 *      (filter/dir/include_user) are silently ignored AND no phantom
 *      keys leak into the response. This is HONEST: additionalProperties
 *      is not advertised, handler does not enforce it
 *   7. source-string pin — handler is discoverPremadeAgents() →
 *      jsonResult({ count: agents.length, agents }) with NO args
 *      destructure, NO try/catch, NO requireString/requireAllowedKeys,
 *      NO spawnFleet/wakeAgent/sendMessage/fetch, registered exactly
 *      once
 *
 * Each invariant is independently falsifiable. The SDK enforces neither
 * `required` nor `type`; toolHandlers is typed `(args: any)`.
 *
 * No published-figure bump. HANDOFF.md is not edited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
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
  agentsDir: string;
  homeAgentsDir: string;
};

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-list-agents-mcp-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `meshfleet-list-agents-${dir}`,
      private: true,
      version: "1.0.0",
    }) + "\n",
  );
  const agentsDir = join(dir, ".opencode", "agents");
  const homeAgentsDir = join(dir, ".config", "opencode", "agents");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(homeAgentsDir, { recursive: true });
  return {
    dir,
    dataFile: join(dir, "ledger.json"),
    dbFile: join(dir, "ledger.db"),
    eventsFile: join(dir, "events.jsonl"),
    agentsDir,
    homeAgentsDir,
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
    // Child cwd MUST be the fixture so discoverPremadeAgents() reads
    // join(process.cwd(), ".opencode", "agents") from the temp tree,
    // not the worktree. Absolute tsx loader so resolution does not
    // depend on the fixture having node_modules.
    cwd: fix.dir,
    env: childEnv(fix),
    stderr: "ignore",
  });
  const client = new Client(
    { name: "list-agents-contract-test", version: "1.0.0" },
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

/** Write a .md agent file with optional YAML front-matter. */
function writeAgent(
  dir: string,
  stem: string,
  frontMatter: { name?: string; description?: string; mode?: string } | null,
  body = "",
): string {
  const path = join(dir, `${stem}.md`);
  if (frontMatter === null) {
    writeFileSync(path, body || `# ${stem}\nno front matter here\n`);
    return path;
  }
  const lines = ["---"];
  if (frontMatter.name !== undefined) lines.push(`name: ${frontMatter.name}`);
  if (frontMatter.description !== undefined) {
    lines.push(`description: ${frontMatter.description}`);
  }
  if (frontMatter.mode !== undefined) lines.push(`mode: ${frontMatter.mode}`);
  lines.push("---", "");
  if (body) lines.push(body);
  writeFileSync(path, lines.join("\n"));
  return path;
}

const PREMADE_KEYS = ["description", "filename", "mode", "name"];

const LIST_AGENTS_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

function extractHandlerBlock(src: string): string {
  const match = src.match(/toolHandlers\["list_agents"\][\s\S]*?^};/m);
  assert.ok(match, "list_agents handler block must be extractable");
  return match[0];
}

// ─── Test 1: advertised schema + annotations + description honesty ───

test("list_agents: advertised schema is empty-object with no required, no additionalProperties, four annotations, description names .opencode/agents/", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "list_agents");
    assert.ok(tool, "list_agents must be advertised");

    // Empty-input contract. Handler at src/index.ts:2493-2496 never
    // reads args. Adding `dir` / `include_user` would change every
    // dashboard that ships against "this tool takes no arguments".
    assert.equal(tool!.inputSchema.type, "object");
    assert.deepEqual(tool!.inputSchema.properties, {});
    assert.equal(
      "required" in tool!.inputSchema,
      false,
      "required must be absent (no documented required inputs); advertising [] is also empty but origin/main omits the key",
    );
    // Honesty: handler ignores extra keys and has no requireAllowedKeys.
    // Advertising additionalProperties:false would be a lie.
    assert.equal(
      "additionalProperties" in tool!.inputSchema,
      false,
      "additionalProperties must be ABSENT — handler never enforces it; advertising false would be a lie",
    );

    assert.deepEqual(tool!.annotations, LIST_AGENTS_ANNOTATIONS);

    const desc = tool!.description ?? "";
    assert.match(desc, /premade agents/i);
    assert.match(desc, /\.opencode\/agents\//);
    assert.doesNotMatch(
      desc,
      /write|mutate|delete|spawn/i,
      "read-only discovery description must not claim a write",
    );
  });
});

// ─── Test 2: empty discovery surface {count:0, agents:[]} ───

test("list_agents: empty agents dir returns exactly {count: 0, agents: []} with no error envelope", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "list_agents",
      arguments: {},
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `empty dir must not be an isError envelope; got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.deepEqual(
      Object.keys(body).sort(),
      ["agents", "count"],
      `response must have exactly {count, agents}; got: ${Object.keys(body).sort()}`,
    );
    assert.equal(body.count, 0);
    assert.deepEqual(body.agents, []);
  });
});

// ─── Test 3: PremadeAgent 4-key shape, no path/dir leak ───

test("list_agents: each entry carries exactly the 4 documented PremadeAgent keys and never path/dir", async () => {
  const fix = makeFixture();
  writeAgent(fix.agentsDir, "frontend-developer", {
    name: "Frontend Developer",
    description: "Builds UI components.",
    mode: "subagent",
  });
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "list_agents",
      arguments: {},
    });
    const body = bodyOf(response);
    const agents = body.agents as Array<Record<string, unknown>>;
    assert.equal(agents.length, 1, "exactly one agent persisted");
    assert.equal(body.count, 1, "count must equal agents.length");
    const agent = agents[0]!;
    assert.deepEqual(
      Object.keys(agent).sort(),
      PREMADE_KEYS,
      `PremadeAgent must carry exactly the 4 documented keys; got: ${Object.keys(agent).sort()}`,
    );
    assert.equal(agent.filename, "frontend-developer");
    assert.equal(agent.name, "Frontend Developer");
    assert.equal(agent.description, "Builds UI components.");
    assert.equal(agent.mode, "subagent");
    assert.equal(agent.path, undefined, "internal path must not leak");
    assert.equal(agent.dir, undefined, "internal dir must not leak");
  });
});

// ─── Test 4: front-matter parsing + documented defaults ───

test("list_agents: front-matter populates name/description/mode; missing fields fall back; body never bleeds", async () => {
  const fix = makeFixture();
  writeAgent(
    fix.agentsDir,
    "backend-specialist",
    {
      name: "Backend Specialist",
      description: "Owns server-side correctness.",
      mode: "primary",
    },
    "# Backend Specialist\n\nLong body text here that should NOT bleed into description.\n",
  );
  writeAgent(fix.agentsDir, "minimal-agent", { name: "Minimal Agent" });
  writeAgent(fix.agentsDir, "stem-named", { description: "only desc" });
  await withChildServer(fix, async (client) => {
    const body = bodyOf(
      await client.callTool({ name: "list_agents", arguments: {} }),
    );
    const agents = body.agents as Array<Record<string, unknown>>;
    assert.equal(body.count, 3);
    assert.equal(agents.length, 3);

    const byFile = Object.fromEntries(agents.map((a) => [a.filename, a]));

    const full = byFile["backend-specialist"]!;
    assert.equal(full.name, "Backend Specialist");
    assert.equal(full.description, "Owns server-side correctness.");
    assert.equal(full.mode, "primary");
    assert.equal(
      (full.description as string).includes("Long body text"),
      false,
      `description leaked body text; got: ${full.description}`,
    );

    const minimal = byFile["minimal-agent"]!;
    assert.equal(minimal.name, "Minimal Agent");
    assert.equal(
      minimal.description,
      "",
      `missing description must default to empty string; got: ${JSON.stringify(minimal.description)}`,
    );
    assert.equal(
      minimal.mode,
      "subagent",
      `missing mode must default to 'subagent'; got: ${JSON.stringify(minimal.mode)}`,
    );

    const stem = byFile["stem-named"]!;
    assert.equal(
      stem.name,
      "stem-named",
      "missing name must fall back to file stem",
    );
    assert.equal(stem.description, "only desc");
    assert.equal(stem.mode, "subagent");
  });
});

// ─── Test 5: skip no-frontmatter + cwd wins over HOME on same stem ───

test("list_agents: no-frontmatter files are skipped; cwd copy wins over HOME on the same stem", async () => {
  const fix = makeFixture();
  writeAgent(fix.agentsDir, "good-agent", { name: "Good Agent" });
  writeAgent(
    fix.agentsDir,
    "broken-agent",
    null,
    "# Broken Agent\nThis file has no front-matter at all.\n",
  );
  writeAgent(fix.agentsDir, "shadowed", { name: "CWD Copy" });
  writeAgent(fix.homeAgentsDir, "shadowed", { name: "HOME Copy" });
  writeAgent(fix.homeAgentsDir, "home-only", { name: "Home Only" });
  await withChildServer(fix, async (client) => {
    const body = bodyOf(
      await client.callTool({ name: "list_agents", arguments: {} }),
    );
    const agents = body.agents as Array<Record<string, unknown>>;
    const filenames = agents.map((a) => a.filename).sort();
    assert.deepEqual(
      filenames,
      ["good-agent", "home-only", "shadowed"],
      `no-frontmatter must be skipped and cwd+HOME unique stems listed; got: ${JSON.stringify(filenames)}`,
    );
    assert.equal(body.count, 3);
    const shadowed = agents.find((a) => a.filename === "shadowed")!;
    assert.equal(
      shadowed.name,
      "CWD Copy",
      "cwd .opencode/agents/ must win over HOME ~/.config/opencode/agents/ on the same stem",
    );
  });
});

// ─── Test 6: phantom extra keys silently ignored (honesty) ───

test("list_agents: phantom extra keys are silently ignored (additionalProperties not advertised, handler does not enforce)", async () => {
  const fix = makeFixture();
  writeAgent(fix.agentsDir, "phantom-args-agent", { name: "Phantom Args Agent" });
  await withChildServer(fix, async (client) => {
    const response = await client.callTool({
      name: "list_agents",
      arguments: {
        filter: "smuggled",
        dir: "/etc",
        include_user: true,
        force: true,
        retry: 3,
        note: "should be ignored",
      },
    });
    assert.notEqual(
      (response as ToolResponse).isError,
      true,
      `phantom keys must NOT error; advertising additionalProperties:false would be a lie. got: ${textOf(response)}`,
    );
    const body = bodyOf(response);
    assert.deepEqual(Object.keys(body).sort(), ["agents", "count"]);
    assert.equal(body.count, 1);
    const agents = body.agents as Array<Record<string, unknown>>;
    assert.equal(agents[0]!.filename, "phantom-args-agent");
    assert.deepEqual(Object.keys(agents[0]!).sort(), PREMADE_KEYS);
    assert.equal(body.filter, undefined);
    assert.equal(body.dir, undefined);
    assert.equal(body.include_user, undefined);
  });
});

// ─── Test 7: source-string pin ───

test("list_agents: source-string pin — handler is discoverPremadeAgents → jsonResult({count, agents}), no destructure/try/allowedKeys/spawn", async () => {
  const fix = makeFixture();
  await withChildServer(fix, async (client) => {
    const src = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");

    const registrations = src.match(/toolHandlers\["list_agents"\]/g) ?? [];
    assert.equal(
      registrations.length,
      1,
      `handler must be registered exactly once; got ${registrations.length}`,
    );

    const handlerBlock = extractHandlerBlock(src);
    assert.match(
      handlerBlock,
      /const\s+agents\s*=\s*discoverPremadeAgents\(\);/,
    );
    assert.match(
      handlerBlock,
      /jsonResult\(\{\s*count:\s*agents\.length,\s*agents\s*\}\)/,
    );
    assert.doesNotMatch(
      handlerBlock,
      /requireAllowedKeys/,
      "handler must NOT enforce additionalProperties (advertising false would be a lie)",
    );
    assert.doesNotMatch(handlerBlock, /requireString|requireBoolean/);
    assert.doesNotMatch(
      handlerBlock,
      /spawnFleet|wakeAgent|sendMessage|fetch\(/,
    );
    assert.doesNotMatch(
      handlerBlock,
      /toolHandlers\["list_agents"\]\s*=\s*async\s*\(\s*\{/,
      "handler must NOT destructure-cast args",
    );
    assert.doesNotMatch(
      handlerBlock,
      /\btry\s*\{/,
      "handler must NOT wrap its body in try/catch (would change isError semantics)",
    );

    const schemaMatch = src.match(
      /name:\s*"list_agents",[\s\S]*?inputSchema:\s*(\{[\s\S]*?\}),[\s\S]*?annotations:\s*(\{[\s\S]*?\})/,
    );
    assert.ok(schemaMatch, "advertised list_agents schema block must be extractable");
    assert.match(schemaMatch[1]!, /type:\s*"object"/);
    assert.match(schemaMatch[1]!, /properties:\s*\{\s*\}/);
    assert.doesNotMatch(
      schemaMatch[1]!,
      /additionalProperties/,
      "advertised schema must NOT carry additionalProperties (handler does not enforce it)",
    );
    assert.match(schemaMatch[2]!, /readOnlyHint:\s*true/);
    assert.match(schemaMatch[2]!, /idempotentHint:\s*true/);
    assert.match(schemaMatch[2]!, /destructiveHint:\s*false/);
    assert.match(schemaMatch[2]!, /openWorldHint:\s*false/);

    const response = await client.callTool({
      name: "list_agents",
      arguments: {},
    });
    const body = bodyOf(response);
    assert.equal(body.count, 0, "empty fixture must return count: 0");
    assert.deepEqual(body.agents, []);
  });
});
