/**
 * fleet_status — opt-in summary verbosity, default bytes unchanged.
 *
 * HANDOFF "Next public work": add compact status output only as an opt-in projection and
 * preserve current output bytes by default. `fleet_status` is polled in a loop and its default
 * response carries every agent's prompt, output, error and diagnostics in full.
 *
 * Contract under test:
 *   1. No `verbosity` and `verbosity: "full"` return the same bytes as the prior handler,
 *      `JSON.stringify({ fleet, agents })` over the unprojected rows.
 *   2. `verbosity: "summary"` returns each agent row as a key-subset of its full row with
 *      identical values, minus exactly prompt/output/error/diagnostics, and names the omitted
 *      fields so an absent `error` cannot be read as "no error".
 *   3. An unknown verbosity is refused, never silently served as "full".
 *   4. Every `Agent` field has an explicit keep/omit disposition (compile-time via `Record`,
 *      and here via a `Required<Agent>` fixture that stops compiling when `Agent` grows).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Agent, Fleet } from "../src/core.js";
import { closeDb } from "../src/db.js";
import {
  AGENT_SUMMARY_FIELDS,
  FLEET_SUMMARY_FIELDS,
  OMITTED_AGENT_FIELDS,
  projectFleetStatus,
  summarizeAgent,
  summarizeFleet,
} from "../src/fleet-status.js";
import { GOT_ECHO_MAX_CHARS, requireEnum } from "../src/tool-args.js";
import { withTempDb } from "./helpers/with-temp-db.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0]!.text;

const BIG_PROMPT = "PROMPT-MARKER " + "p".repeat(4_000);
const BIG_OUTPUT = "OUTPUT-MARKER " + "o".repeat(8_000);
const BIG_ERROR = "ERROR-MARKER " + "e".repeat(2_000);
const DIAG_TEXT = "DIAG-MARKER rate limited once";

/** Every Agent field populated. `Required<Agent>` makes this stop compiling when Agent grows. */
const FULL_AGENT: Required<Agent> = {
  id: "agent-full",
  fleet_id: "fleet-a",
  role: "builder",
  prompt: BIG_PROMPT,
  agent_file: "builder.md",
  requested_model: "model-x",
  pid: 4242,
  status: "failed",
  output: BIG_OUTPUT,
  error: BIG_ERROR,
  diagnostics: [{ severity: "warning", message: DIAG_TEXT }],
  started_at: 1_700_000_000_000,
  completed_at: 1_700_000_060_000,
  retry_count: 1,
  runtime_agent: "opencode-cli",
  runtime_model: "model-x",
  runtime_attempts: ["opencode-cli", "kimi-cli"],
  spawn_attempt: 2,
  result_contract: "blocked",
  expects_artifact: true,
  stopped_reason: "process_lost",
};

const FLEET: Fleet = { id: "fleet-a", status: "failed", created_at: 1_700_000_000_000, completed_at: 1_700_000_060_000 };

const COMPLETE_AGENT: Agent = {
  id: "agent-done",
  fleet_id: "fleet-a",
  role: "writer",
  prompt: BIG_PROMPT,
  status: "complete",
  output: BIG_OUTPUT,
  started_at: 1_700_000_000_000,
  completed_at: 1_700_000_030_000,
  result_contract: "ok",
};

test("summary omits exactly prompt, output, error and diagnostics", () => {
  assert.deepEqual([...OMITTED_AGENT_FIELDS], ["prompt", "output", "error", "diagnostics"]);
});

test("every Agent field has a disposition", () => {
  assert.deepEqual(
    Object.keys(FULL_AGENT).sort(),
    Object.keys(AGENT_SUMMARY_FIELDS).sort(),
    "the Required<Agent> fixture and the disposition table must name the same fields",
  );
});

test("full projection is the unprojected { fleet, agents } object", () => {
  const agents = [FULL_AGENT, COMPLETE_AGENT];
  const projected = projectFleetStatus(FLEET, agents);
  assert.equal(JSON.stringify(projected), JSON.stringify({ fleet: FLEET, agents }));
  assert.equal(JSON.stringify(projectFleetStatus(FLEET, agents, "full")), JSON.stringify({ fleet: FLEET, agents }));
  assert.equal(projected.agents, agents, "full must not copy or rewrite rows");
});

test("a summary row is its full row minus the omitted fields, values and order unchanged", () => {
  const row = summarizeAgent(FULL_AGENT);
  const expected: Record<string, unknown> = { ...FULL_AGENT };
  for (const key of OMITTED_AGENT_FIELDS) delete expected[key];
  assert.equal(JSON.stringify(row), JSON.stringify(expected));
  for (const key of OMITTED_AGENT_FIELDS) assert.equal(key in row, false, `${key} leaked into summary`);
  assert.equal(row.runtime_attempts, FULL_AGENT.runtime_attempts, "kept values are copied by reference, not rebuilt");
});

test("summary does not invent fields a row lacks", () => {
  const row = summarizeAgent(COMPLETE_AGENT);
  assert.deepEqual(Object.keys(row), ["id", "fleet_id", "role", "status", "started_at", "completed_at", "result_contract"]);
  assert.equal("stopped_reason" in row, false);
  assert.equal("pid" in row, false);
});

test("summary drops keys Agent does not declare", () => {
  const foreign = { ...COMPLETE_AGENT, transcript: "x".repeat(10_000) } as unknown as Agent;
  const row = summarizeAgent(foreign) as Record<string, unknown>;
  assert.equal("transcript" in row, false);
});

test("summary response names the omitted fields and keeps every declared fleet field", () => {
  const out = projectFleetStatus(FLEET, [FULL_AGENT], "summary");
  assert.ok("omitted_agent_fields" in out);
  assert.deepEqual(out.omitted_agent_fields, OMITTED_AGENT_FIELDS);
  assert.equal(JSON.stringify(out.fleet), JSON.stringify(FLEET), "a declared-only fleet row serializes unchanged");
  assert.deepEqual(Object.keys(out), ["fleet", "agents", "omitted_agent_fields"]);
});

/** Every Fleet field populated. `Required<Fleet>` makes this stop compiling when Fleet grows. */
const FULL_FLEET: Required<Fleet> = {
  id: "fleet-full",
  status: "abandoned",
  created_at: 1_700_000_000_000,
  completed_at: 1_700_000_090_000,
  timeout_ms: 600_000,
  stopped_reason: "server_crash",
};

test("every Fleet field has a disposition, and all are kept", () => {
  assert.deepEqual(
    Object.keys(FULL_FLEET).sort(),
    Object.keys(FLEET_SUMMARY_FIELDS).sort(),
    "the Required<Fleet> fixture and the fleet disposition table must name the same fields",
  );
  assert.equal(JSON.stringify(summarizeFleet(FULL_FLEET)), JSON.stringify(FULL_FLEET));
  assert.equal(summarizeFleet(undefined), undefined);
});

test("summary drops keys Fleet does not declare; full keeps them", () => {
  const foreign = { ...FLEET, legacy_notes: "FLEET-FOREIGN-MARKER " + "n".repeat(5_000), owner: { name: "x" } } as unknown as Fleet;
  const summary = projectFleetStatus(foreign, [COMPLETE_AGENT], "summary");
  assert.equal(JSON.stringify(summary.fleet), JSON.stringify(FLEET), "summary fleet = declared fields only, order kept");
  assert.equal(JSON.stringify(summary).includes("FLEET-FOREIGN-MARKER"), false);
  assert.equal("owner" in (summary.fleet as Record<string, unknown>), false);
  const full = projectFleetStatus(foreign, [COMPLETE_AGENT]);
  assert.equal(full.fleet, foreign, "full returns the stored fleet row untouched");
  assert.ok(JSON.stringify(full).includes("FLEET-FOREIGN-MARKER"));
});

test("a refusal echoes at most GOT_ECHO_MAX_CHARS of the rejected value, with an ellipsis", () => {
  assert.equal(GOT_ECHO_MAX_CHARS, 200);
  const huge = "Z".repeat(50_000);
  const msg = requireEnum("fleet_status", "verbosity", huge, ["full", "summary"], { optional: true })!;
  const echoed = JSON.stringify(huge).slice(0, GOT_ECHO_MAX_CHARS);
  assert.ok(msg.includes(`got ${echoed}… (string)`), msg.slice(0, 400));
  assert.ok(msg.length < 500, `refusal is ${msg.length} chars`);
  // A short value is echoed whole, exactly as before.
  assert.equal(
    requireEnum("fleet_status", "verbosity", "compact", ["full", "summary"], { optional: true }),
    `fleet_status: 'verbosity' must be exactly one of full | summary, got "compact" (string). ` +
      `An unrecognized value would silently fall through to a default.`,
  );
  // A rendering of exactly the cap is not cut.
  const atCap = "y".repeat(GOT_ECHO_MAX_CHARS - 2); // JSON adds two quotes
  assert.ok(requireEnum("t", "f", atCap, ["a"])!.includes(`got ${JSON.stringify(atCap)} (string)`));
  // The cut never leaves half of a surrogate pair.
  const emoji = "x".repeat(GOT_ECHO_MAX_CHARS - 2) + "\u{1F600}" + "x".repeat(10);
  const cut = requireEnum("t", "f", emoji, ["a"])!;
  assert.ok(cut.includes("…"));
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), false, "lone high surrogate in refusal");
});

test("an unknown fleet serializes the same way at both verbosities apart from the omission list", () => {
  assert.equal(JSON.stringify(projectFleetStatus(undefined, [])), '{"agents":[]}');
  assert.equal(
    JSON.stringify(projectFleetStatus(undefined, [], "summary")),
    '{"agents":[],"omitted_agent_fields":["prompt","output","error","diagnostics"]}',
  );
});

// ---------------------------------------------------------------------------------------------
// Real MCP server over stdio, against a seeded ledger.
// ---------------------------------------------------------------------------------------------

async function withSeededServer(fn: (client: Client, dir: string) => Promise<void>, fleet: Fleet = FLEET): Promise<void> {
  const db = withTempDb();
  db.seed({
    fleets: { [fleet.id]: fleet },
    agents: { [FULL_AGENT.id]: FULL_AGENT, [COMPLETE_AGENT.id]: COMPLETE_AGENT },
  });
  closeDb();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env: {
      ...(process.env as Record<string, string>),
      MESHFLEET_DB_FILE: db.dbFile,
      MESHFLEET_DATA_FILE: join(db.dir, "ledger.json"),
      MESHFLEET_EVENT_LOG_FILE: join(db.dir, "events.log"),
      MESHFLEET_RATIFY_SWEEP_MS: "0",
      AGENT_MESH_CHILD: "1",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "fleet-status-summary-test", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    await fn(client, db.dir);
  } finally {
    await client.close().catch(() => {});
    db.cleanup();
  }
}

test("MCP: default and full return identical bytes carrying the full rows", async () => {
  await withSeededServer(async (client) => {
    const dflt = textOf(await client.callTool({ name: "fleet_status", arguments: { fleet_id: FLEET.id } }));
    const full = textOf(await client.callTool({ name: "fleet_status", arguments: { fleet_id: FLEET.id, verbosity: "full" } }));
    assert.equal(full, dflt, "verbosity=full must be the default response, byte for byte");
    const parsed = JSON.parse(dflt) as { fleet: Fleet; agents: Agent[] };
    assert.deepEqual(Object.keys(parsed), ["fleet", "agents"], "default shape gains no keys");
    assert.equal(dflt, JSON.stringify({ fleet: parsed.fleet, agents: parsed.agents }));
    const byId = new Map(parsed.agents.map((a) => [a.id, a]));
    assert.equal(byId.get(FULL_AGENT.id)?.prompt, BIG_PROMPT);
    assert.equal(byId.get(FULL_AGENT.id)?.output, BIG_OUTPUT);
    assert.equal(byId.get(FULL_AGENT.id)?.error, BIG_ERROR);
    assert.deepEqual(byId.get(FULL_AGENT.id)?.diagnostics, FULL_AGENT.diagnostics);
  });
});

test("MCP: summary omits the free text, keeps status evidence, and is smaller", async () => {
  await withSeededServer(async (client) => {
    const full = textOf(await client.callTool({ name: "fleet_status", arguments: { fleet_id: FLEET.id } }));
    const summary = textOf(await client.callTool({ name: "fleet_status", arguments: { fleet_id: FLEET.id, verbosity: "summary" } }));
    for (const marker of ["PROMPT-MARKER", "OUTPUT-MARKER", "ERROR-MARKER", "DIAG-MARKER"]) {
      assert.equal(summary.includes(marker), false, `${marker} reached the summary payload`);
    }
    const s = JSON.parse(summary) as { fleet: Fleet; agents: Array<Record<string, unknown>>; omitted_agent_fields: string[] };
    const f = JSON.parse(full) as { fleet: Fleet; agents: Array<Record<string, unknown>> };
    assert.deepEqual(s.omitted_agent_fields, ["prompt", "output", "error", "diagnostics"]);
    assert.deepEqual(s.fleet, f.fleet);
    assert.deepEqual(s.agents.map((a) => a.id), f.agents.map((a) => a.id), "same agents, same order");
    for (let i = 0; i < f.agents.length; i++) {
      const expected = { ...f.agents[i] };
      for (const key of s.omitted_agent_fields) delete expected[key];
      assert.equal(JSON.stringify(s.agents[i]), JSON.stringify(expected), "summary row = full row minus omitted fields");
    }
    const failed = s.agents.find((a) => a.id === FULL_AGENT.id)!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.result_contract, "blocked");
    assert.equal(failed.stopped_reason, "process_lost");
    assert.ok(summary.length * 10 < full.length, `summary ${summary.length}B should be far below full ${full.length}B`);
  });
});

test("MCP: an unknown verbosity is refused, not served as full", async () => {
  await withSeededServer(async (client) => {
    for (const verbosity of ["compact", "SUMMARY", "", 1, true]) {
      const res = await client.callTool({
        name: "fleet_status",
        arguments: { fleet_id: FLEET.id, verbosity } as Record<string, unknown>,
      });
      const text = textOf(res);
      assert.match(text, /fleet_status: 'verbosity' must be exactly one of full \| summary/, `verbosity=${JSON.stringify(verbosity)}`);
      assert.equal(text.includes("OUTPUT-MARKER"), false);
    }
  });
});

test("MCP: an undeclared key on the stored fleet row is absent from summary and present in full", async () => {
  const foreignFleet = { ...FLEET, legacy_notes: "FLEET-FOREIGN-MARKER " + "n".repeat(3_000) } as unknown as Fleet;
  await withSeededServer(async (client) => {
    const full = textOf(await client.callTool({ name: "fleet_status", arguments: { fleet_id: FLEET.id } }));
    const summary = textOf(await client.callTool({ name: "fleet_status", arguments: { fleet_id: FLEET.id, verbosity: "summary" } }));
    assert.ok(full.includes("FLEET-FOREIGN-MARKER"), "the seeded foreign key must survive into the stored row");
    assert.equal(summary.includes("FLEET-FOREIGN-MARKER"), false, "undeclared fleet key reached the summary");
    const s = JSON.parse(summary) as { fleet: Record<string, unknown> };
    const f = JSON.parse(full) as { fleet: Record<string, unknown> };
    const expected = { ...f.fleet };
    delete expected.legacy_notes;
    assert.equal(JSON.stringify(s.fleet), JSON.stringify(expected), "summary fleet = stored fleet minus undeclared keys");
  }, foreignFleet);
});

test("MCP: tools/list advertises the optional verbosity enum and keeps fleet_id required", async () => {
  await withSeededServer(async (client) => {
    const tool = (await client.listTools()).tools.find((t) => t.name === "fleet_status");
    assert.ok(tool, "fleet_status missing from tools/list");
    const schema = tool.inputSchema as { properties: Record<string, { enum?: string[] }>; required?: string[] };
    assert.deepEqual(schema.properties.verbosity?.enum, ["full", "summary"]);
    assert.deepEqual(schema.required, ["fleet_id"]);
  });
});
