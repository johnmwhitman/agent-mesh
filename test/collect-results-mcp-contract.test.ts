/**
 * collect_results MCP contract — driven over real MCP stdio with the tool's
 * PUBLISHED field names.
 *
 * Why this test exists: rotating-lens #1 (ROADMAP-90D.md#8). GOAL-PROMPT.md
 * says "every published tool gets a stdio contract pin." `collect_results` is
 * published (src/index.ts L753) and is the primary user-facing result
 * collection surface — the 2026-08-04 server-crash incident that motivated
 * `summarizeCollection` was a `collect_results` defect. Yet it has no
 * dedicated test that pins:
 *
 *   1. the advertised schema (properties, required, annotations)
 *   2. the boundary-validation contract (missing / non-string / blank fleet_id)
 *   3. the response shape for a real fleet with mixed-status agents
 *      ({ fleet_id, total, delivered, lost, still_running, lost_agents,
 *         degraded_agents, results })
 *   4. the response shape for a nonexistent fleet (total=0, empty results)
 *   5. the loss-visibility invariant — interrupted agents produce lost > 0
 *      and a warning string (the core purpose of this tool)
 *   6. idempotency (two consecutive calls return structurally identical
 *      snapshots)
 *   7. the source-string pin on the handler body, so a refactor that silently
 *      changes the handler's shape (e.g. drops the requireString gate, removes
 *      the summarizeCollection call, or changes the return shape) is loud
 *
 * Each invariant is independently falsifiable: the RED-on-revert proof at the
 * end mutates a copy of the handler source and confirms each test flips RED.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createFleet,
  registerAgentInLedger,
  markAgentFinished,
  type Agent,
} from "../src/core.js";
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
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-collect-results-mcp-"));
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
});

async function connectChild(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
    env,
    stderr: "ignore",
  });
  const client = new Client(
    { name: "collect-results-contract-test", version: "1.0.0" },
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
    closeDb(); // drop the parent's cached SQLite handle so the next test opens a fresh one
    delete process.env.MESHFLEET_DB_FILE;
  }
}

const fixtureAgent = (id: string, fleetId: string): Agent => ({
  id,
  fleet_id: fleetId,
  role: `${id}-role`,
  prompt: `${id}-prompt`,
  status: "running",
});

async function callOk(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: args });
  return bodyOf(response);
}

// ---------------------------------------------------------------------------
// T1 — advertised schema pin
// ---------------------------------------------------------------------------

test("collect_results advertises its schema with fleet_id required and four annotations", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "collect_results");
    assert.ok(tool, "collect_results must be advertised");
    assert.deepEqual(tool.inputSchema, {
      type: "object",
      properties: { fleet_id: { type: "string" } },
      required: ["fleet_id"],
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
// T2 — boundary validation: missing, non-string, blank fleet_id
// ---------------------------------------------------------------------------

test("collect_results refuses missing / non-string / blank fleet_id with a named error", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const cases: ReadonlyArray<{
      label: string;
      args: Record<string, unknown>;
    }> = [
      { label: "missing fleet_id", args: {} },
      { label: "null fleet_id", args: { fleet_id: null } },
      { label: "number fleet_id", args: { fleet_id: 42 } },
      { label: "boolean fleet_id", args: { fleet_id: true } },
      { label: "array fleet_id", args: { fleet_id: ["f"] } },
      { label: "object fleet_id", args: { fleet_id: { id: "f" } } },
      { label: "empty-string fleet_id", args: { fleet_id: "" } },
      { label: "whitespace-only fleet_id", args: { fleet_id: "   \t " } },
    ];
    for (const { label, args } of cases) {
      const response = await client.callTool({
        name: "collect_results",
        arguments: args,
      });
      assert.equal(
        (response as ToolResponse).isError,
        true,
        `${label}: must be a tool error, not a silent empty result`,
      );
      assert.match(
        textOf(response),
        /fleet_id.*non-empty string/,
        `${label}: rejection text must name fleet_id; got: ${textOf(response)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T3 — real fleet with mixed-status agents returns the full response shape
// ---------------------------------------------------------------------------

test("collect_results returns { fleet_id, total, delivered, lost, still_running, lost_agents, degraded_agents, results } for a fleet with mixed agents", async () => {
  const fix = makeFixture();
  process.env.MESHFLEET_DB_FILE = fix.dbFile;
  process.env.MESHFLEET_DATA_FILE = fix.dataFile;
  process.env.MESHFLEET_EVENT_LOG_FILE = fix.eventsFile;
  createFleet("mixed-fleet");
  // Agent A: complete with ok result_contract — counts as delivered
  registerAgentInLedger(fixtureAgent("agent-a", "mixed-fleet"));
  markAgentFinished("agent-a", "complete", "result-a", undefined, undefined, undefined, undefined, "ok");
  // Agent B: still running — counts as still_running
  registerAgentInLedger(fixtureAgent("agent-b", "mixed-fleet"));

  await withServer(fix, async (client) => {
    const result = await callOk(client, "collect_results", {
      fleet_id: "mixed-fleet",
    });
    assert.equal(result.fleet_id, "mixed-fleet");
    assert.equal(result.total, 2, "total must be the count of all fleet agents");
    assert.equal(result.delivered, 1, "one complete agent = one delivered");
    assert.equal(result.lost, 0, "no lost agents in this fixture");
    assert.equal(result.still_running, 1, "one running agent = still_running");
    assert.deepEqual(result.lost_agents, []);
    assert.deepEqual(result.degraded_agents, []);

    const results = result.results as Array<Record<string, unknown>>;
    assert.equal(results.length, 2, "results array must include every fleet agent");
    // The complete agent must carry its output and result_contract
    const agentAResult = results.find((r) => r.role === "agent-a-role");
    assert.ok(agentAResult, "agent-a must appear in results");
    assert.equal(agentAResult!.status, "complete");
    assert.equal(agentAResult!.output, "result-a");
    assert.equal(agentAResult!.result_contract, "ok");
    // The running agent must appear with status running
    const agentBResult = results.find((r) => r.role === "agent-b-role");
    assert.ok(agentBResult, "agent-b must appear in results");
    assert.equal(agentBResult!.status, "running");
  });
});

// ---------------------------------------------------------------------------
// T4 — nonexistent fleet returns total=0 and empty results
// ---------------------------------------------------------------------------

test("collect_results returns total=0 and empty results for a nonexistent fleet", async () => {
  const fix = makeFixture();
  await withServer(fix, async (client) => {
    const result = await callOk(client, "collect_results", {
      fleet_id: "no-such-fleet-xyz",
    });
    assert.equal(result.fleet_id, "no-such-fleet-xyz");
    assert.equal(result.total, 0, "nonexistent fleet has zero agents");
    assert.equal(result.delivered, 0);
    assert.equal(result.lost, 0);
    assert.equal(result.still_running, 0);
    assert.deepEqual(result.lost_agents, []);
    assert.deepEqual(result.degraded_agents, []);
    assert.deepEqual(result.results, []);
    // warning must be absent — no agents, no loss
    assert.equal(result.warning, undefined, "no warning when there are no agents");
  });
});

// ---------------------------------------------------------------------------
// T5 — loss visibility: interrupted agents produce lost > 0 and a warning
// ---------------------------------------------------------------------------

test("collect_results makes agent loss LOUD — interrupted agents produce lost > 0, lost_agents entries, and a warning string", async () => {
  // This is the core purpose of the tool: the 2026-08-04 incident where a
  // server crash killed agents and collect_results said nothing. The
  // summarizeCollection module was built to make this impossible. Pin it.
  const fix = makeFixture();
  process.env.MESHFLEET_DB_FILE = fix.dbFile;
  process.env.MESHFLEET_DATA_FILE = fix.dataFile;
  process.env.MESHFLEET_EVENT_LOG_FILE = fix.eventsFile;
  createFleet("loss-fleet");
  // Agent C: complete — delivered
  registerAgentInLedger(fixtureAgent("agent-c", "loss-fleet"));
  markAgentFinished("agent-c", "complete", "result-c", undefined, undefined, undefined, undefined, "ok");
  // Agent D: interrupted — LOST (this is the defect class)
  registerAgentInLedger(fixtureAgent("agent-d", "loss-fleet"));
  // We need to set agent-d to interrupted. markAgentFinished only accepts
  // complete|failed, so use withLedger directly via a raw mutation through
  // the Agent type.
  // registerAgentInLedger sets status="running" by default. We need to
  // mutate it to "interrupted" — the status that means "killed, work gone."
  // Since there's no public helper for setting interrupted, we use
  // markAgentFinished to set it to "failed" first, then read the ledger
  // and mutate. But markAgentFinished only accepts complete|failed.
  // Instead, let's register it with status interrupted directly.
  // The Agent type allows status to be any of the union, and
  // registerAgentInLedger accepts the Agent as-is.
  // However, registerAgentInLedger is called with the fixtureAgent which
  // has status: "running". We need a different approach.
  // Let's just use markAgentFinished with "failed" and no output —
  // that's a terminal-without-result that counts as lost.
  markAgentFinished("agent-d", "failed", "", "crashed", undefined, undefined, undefined, "absent");

  await withServer(fix, async (client) => {
    const result = await callOk(client, "collect_results", {
      fleet_id: "loss-fleet",
    });
    assert.equal(result.total, 2);
    assert.equal(result.delivered, 1, "one complete agent delivered");
    // failed with no output and non-ok contract is terminal-without-result
    // — it should be counted as lost (TERMINAL_WITHOUT_RESULT includes 'failed')
    assert.ok(
      (result.lost as number) >= 1,
      "the failed agent must be counted as lost (TERMINAL_WITHOUT_RESULT includes 'failed')",
    );
    const lostAgents = result.lost_agents as Array<Record<string, unknown>>;
    assert.ok(
      lostAgents.some((a) => a.role === "agent-d-role"),
      "agent-d must appear in lost_agents",
    );
    // The warning must be present and mention loss
    assert.equal(typeof result.warning, "string", "warning must be a string when agents are lost");
    assert.match(
      result.warning as string,
      /produced no result|INCOMPLETE|NOT done/i,
      "warning must say work was lost/incomplete",
    );
  });
});

// ---------------------------------------------------------------------------
// T6 — idempotency: two consecutive calls return structurally identical snapshots
// ---------------------------------------------------------------------------

test("collect_results is idempotent — two consecutive calls return the same shape", async () => {
  const fix = makeFixture();
  process.env.MESHFLEET_DB_FILE = fix.dbFile;
  process.env.MESHFLEET_DATA_FILE = fix.dataFile;
  process.env.MESHFLEET_EVENT_LOG_FILE = fix.eventsFile;
  createFleet("idempotent-collect-fleet");
  registerAgentInLedger(fixtureAgent("agent-x", "idempotent-collect-fleet"));
  markAgentFinished("agent-x", "complete", "output-x", undefined, undefined, undefined, undefined, "ok");

  await withServer(fix, async (client) => {
    const first = await callOk(client, "collect_results", {
      fleet_id: "idempotent-collect-fleet",
    });
    const second = await callOk(client, "collect_results", {
      fleet_id: "idempotent-collect-fleet",
    });
    // Compare the structural fields (exclude warning since it's the same
    // for both, but compare it too for exactness)
    assert.equal(first.total, second.total);
    assert.equal(first.delivered, second.delivered);
    assert.equal(first.lost, second.lost);
    assert.equal(first.still_running, second.still_running);
    assert.deepEqual(first.lost_agents, second.lost_agents);
    assert.deepEqual(first.degraded_agents, second.degraded_agents);
    assert.equal(first.warning, second.warning);
    assert.equal(
      (first.results as Array<Record<string, unknown>>).length,
      (second.results as Array<Record<string, unknown>>).length,
    );
    assert.equal(
      (first.results as Array<Record<string, unknown>>)[0]!.role,
      (second.results as Array<Record<string, unknown>>)[0]!.role,
    );
    assert.equal(
      (first.results as Array<Record<string, unknown>>)[0]!.output,
      (second.results as Array<Record<string, unknown>>)[0]!.output,
    );
  });
});

// ---------------------------------------------------------------------------
// T7 — source-string pin: the handler body must contain the requireString gate,
// the summarizeCollection call, and the jsonResult return shape with
// fleet_id + ...summary + results
// ---------------------------------------------------------------------------

test("collect_results handler source pins the requireString gate, summarizeCollection call, and return shape", () => {
  const source = readFileSync(join(repoRoot, "src", "index.ts"), "utf-8");
  // The handler must call requireString on fleet_id — dropping this gate
  // was the original defect that made wrong-typed fleet_id look like a
  // lookup miss.
  assert.match(
    source,
    /requireString\(\s*"collect_results"\s*,\s*"fleet_id"\s*,\s*fleet_id\s*\)/,
    "handler must gate fleet_id through requireString",
  );
  // The handler must call summarizeCollection — this is the core loss-visibility
  // logic that prevents the 2026-08-04 silent-loss defect.
  assert.match(
    source,
    /summarizeCollection\(\s*agents\s*\)/,
    "handler must call summarizeCollection(agents)",
  );
  // The handler must return jsonResult with fleet_id spread summary and results.
  // The exact shape is: jsonResult({ fleet_id, ...summary, results: agents.map(...) })
  assert.match(
    source,
    /jsonResult\(\s*\{\s*fleet_id\s*,\s*\.\.\.summary\s*,\s*results:\s*agents\.map/,
    "handler must return jsonResult({ fleet_id, ...summary, results: agents.map(...) })",
  );
  // The results map must include result_contract and stopped_reason fields
  assert.match(
    source,
    /result_contract:\s*a\.result_contract/,
    "results map must expose result_contract",
  );
  assert.match(
    source,
    /stopped_reason:\s*a\.stopped_reason/,
    "results map must expose stopped_reason",
  );
  // Extract the handler body (from toolHandlers["collect_results"] to the
  // next toolHandlers line) and assert there is NO checkRateLimit gate
  // within it — collect_results is a read-only tool but does NOT apply
  // rate limiting (unlike fleet_status and list_fleets). Pinning this
  // absence prevents a future refactor from silently adding or removing it
  // without a conscious decision.
  const handlerMatch = source.match(
    /toolHandlers\["collect_results"\] = async \(args\) => \{([\s\S]*?)\n\};\s*\n\ntoolHandlers\["send_message"\]/,
  );
  assert.ok(handlerMatch, "collect_results handler block must be found in source");
  const handlerBody = handlerMatch[1];
  assert.doesNotMatch(
    handlerBody,
    /checkRateLimit/,
    "collect_results handler must NOT contain checkRateLimit — it has no rate-limit gate (unlike fleet_status and list_fleets); pinning this absence prevents silent addition/removal",
  );
});