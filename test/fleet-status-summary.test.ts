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
import { GOT_ECHO_MAX_CHARS, echoRejected, echoRejectedRaw, requireEnum, requireStringArray } from "../src/tool-args.js";
import { validateWorkReceipt } from "../src/work-receipt.js";
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

test("summary: an id naming an inherited Object member is still an unknown fleet (no fleet member)", () => {
  // The handler looks fleets up in a plain {} dict, so these ids resolve to Object.prototype members.
  const fleets: Record<string, unknown> = {};
  for (const id of ["constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "__defineGetter__"]) {
    const inherited = fleets[id] as Fleet | undefined;
    const full = JSON.stringify(projectFleetStatus(inherited, [], "full"));
    const summary = JSON.stringify(projectFleetStatus(inherited, [], "summary"));
    assert.equal(full, '{"agents":[]}', `${id}: full`);
    assert.equal(summary, '{"agents":[],"omitted_agent_fields":["prompt","output","error","diagnostics"]}', `${id}: summary invented a fleet`);
  }
});

test("summary: a non-object stored fleet row is returned as stored, never rewritten or thrown on", () => {
  for (const raw of ["null", "[1,2,3]", '"a string row"', "5", "true"]) {
    const row = JSON.parse(raw) as Fleet;
    let summary: ReturnType<typeof projectFleetStatus> | undefined;
    assert.doesNotThrow(() => { summary = projectFleetStatus(row, [], "summary"); }, `${raw}: summary threw`);
    assert.equal(JSON.stringify(summary!.fleet), JSON.stringify(projectFleetStatus(row, [], "full").fleet), `${raw}: summary rewrote the row`);
    assert.equal(JSON.stringify(summary!.fleet), raw);
  }
});

test("echo cap: the cut never splits a JSON escape and stays well-formed", () => {
  const escaped: unknown[] = [
    '"'.repeat(300), // \" escapes
    "\\".repeat(300), // \\ escapes
    "\u0001".repeat(100), // \u0001 six-unit escapes
    "a".repeat(198) + "\uD83Dzz", // lone surrogate renders as a \ud83d escape straddling the cut
    "a".repeat(197) + "\u{1F600}xx",
    "\u{1F600}".repeat(999),
    "a".repeat(196) + "\n" + "b".repeat(20),
  ];
  for (const v of escaped) {
    const shown = echoRejected(v);
    assert.ok(shown.endsWith("…"), "long value must be cut");
    const body = shown.slice(0, -1);
    assert.ok(body.length <= GOT_ECHO_MAX_CHARS, `echo is ${body.length} code units`);
    assert.ok((shown as unknown as { isWellFormed(): boolean }).isWellFormed(), "ill-formed UTF-16");
    // A cut on a token boundary of a JSON string rendering closes into valid JSON.
    assert.doesNotThrow(() => JSON.parse(body + '"'), `partial escape at the cut: ${JSON.stringify(body.slice(-8))}`);
    assert.ok(JSON.stringify(v).startsWith(body), "the echo is a prefix of the rendering");
  }
  // Non-string renderings are cut on the same boundary rules and keep the type suffix.
  for (const v of [{ k: "v".repeat(400) }, Array.from({ length: 300 }, (_, i) => i)]) {
    assert.match(requireEnum("t", "f", v, ["a"])!, /… \(object\)\. /);
  }
  assert.equal(echoRejected(undefined), "undefined");
  assert.equal(echoRejected("short"), '"short"');
});

test("echo cap: the other refusal sites use the same capped renderer", () => {
  const big = "Z".repeat(50_000);
  const bare = requireStringArray("open_ratification", "voters", big, { optional: true })!;
  assert.ok(bare.includes(`got the bare string ${echoRejected(big)}. `), bare.slice(0, 300));
  assert.ok(bare.length < 600, `requireStringArray bare-string refusal is ${bare.length} chars`);
  const wr = validateWorkReceipt({ schema: big, task_id: big, assignee: 7, terminal_outcome: big, result_contract: big, quality_gate: big, payload_sha256: big, evidence: [{ kind: big, handle: "h" }] });
  assert.equal(wr.ok, false);
  const reasons = (wr as { reasons: string[] }).reasons;
  assert.ok(reasons.length > 0);
  for (const r of reasons) assert.ok(r.length < 600, `work-receipt reason is ${r.length} chars: ${r.slice(0, 120)}`);
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

test("MCP: summary for an id naming an inherited Object member reports no fleet, as base did", async () => {
  await withSeededServer(async (client) => {
    for (const fleet_id of ["constructor", "toString", "__defineGetter__"]) {
      const full = textOf(await client.callTool({ name: "fleet_status", arguments: { fleet_id } }));
      const summary = textOf(await client.callTool({ name: "fleet_status", arguments: { fleet_id, verbosity: "summary" } }));
      assert.equal(full, '{"agents":[]}', fleet_id);
      assert.equal(summary, '{"agents":[],"omitted_agent_fields":["prompt","output","error","diagnostics"]}', fleet_id);
    }
  });
});

test("MCP: refusals on several tools echo a capped rejected value", async () => {
  const big = "Z".repeat(50_000);
  await withSeededServer(async (client) => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["fleet_status", { fleet_id: FLEET.id, verbosity: big }],
      ["open_ratification", { proposer: "p", fleet_id: FLEET.id, subject: "s", quorum: 1, voters: big }],
      ["cast_vote", { agent_id: "a", message_id: "m", approve: big }],
      ["record_work_receipt", { schema: big, task_id: big, assignee: big }],
      ["register_capability", { agent_id: "a", fleet_id: "f", role: "r", skills: big }],
      // A valid source and a grammar-valid task_id, so the call reaches the not-found message,
      // which echoes task_id. (source "hermes" stopped at the short unknown-source reason.)
      ["get_work_receipt", { source: "hermes-kanban", task_id: "t_" + big, run_id: 1 }],
      ["get_work_receipt", { source: big, task_id: "t_x", run_id: 1 }],
    ];
    for (const [name, args] of calls) {
      const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean };
      const text = textOf(res);
      assert.equal(res.isError, true, `${name} should refuse`);
      assert.ok(text.length < 2_000, `${name} refusal is ${text.length} chars`);
    }
    const notFound = (JSON.parse(textOf(await client.callTool({
      name: "get_work_receipt",
      arguments: { source: "hermes-kanban", task_id: "t_" + big, run_id: 1 },
    }))) as { error: string }).error;
    assert.ok(
      notFound.startsWith(`get_work_receipt: no work receipt for source="hermes-kanban" task_id="t_ZZZ`),
      `get_work_receipt did not reach the not-found echo: ${notFound.slice(0, 120)}`,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Caller-id refusals that interpolate the id raw (no JSON rendering). Each must cap a 1 MB id
// and keep the exact prior bytes for an id of 200 UTF-16 code units or fewer.
// ---------------------------------------------------------------------------------------------

const RUNTIME_TAIL = ". A runtime is available only once registered, and some require configuration.";

/** One entry per refusal site: the call for a given id, and the exact message it must produce. */
const CALLER_ID_SITES: Array<{
  site: string;
  call: (id: string) => [string, Record<string, unknown>];
  message: (id: string) => string;
}> = [
  { site: "set_fleet_timeout.fleet_id", call: (id) => ["set_fleet_timeout", { fleet_id: id, timeout_ms: 1_000 }], message: (id) => `Fleet ${id} not found` },
  { site: "attach_agent.fleet_id", call: (id) => ["attach_agent", { fleet_id: id, role: "r", prompt: "p" }], message: (id) => `Fleet ${id} not found` },
  { site: "receipt.message_id", call: (id) => ["receipt", { agent_id: "a", message_id: id, action: "read" }], message: (id) => `No such message: ${id}` },
  { site: "cast_vote.message_id", call: (id) => ["cast_vote", { agent_id: "a", message_id: id, approve: true }], message: (id) => `No such ratification: ${id}` },
  { site: "tally_ratification.message_id", call: (id) => ["tally_ratification", { message_id: id }], message: (id) => `No such ratification: ${id}` },
  {
    site: "open_ratification.fleet_id",
    call: (id) => ["open_ratification", { proposer: "p", fleet_id: id, subject: "s", quorum: 1 }],
    message: (id) => `Broadcast in fleet ${id} has no recipients (no other agents registered)`,
  },
  { site: "subscribe_inbox.agent_id", call: (id) => ["subscribe_inbox", { agent_id: id }], message: (id) => `Agent "${id}" not found` },
  { site: "spawn_from_template.name", call: (id) => ["spawn_from_template", { name: id }], message: (id) => `Template "${id}" not found` },
  {
    site: "spawn_fleet.agents[].runtime",
    call: (id) => ["spawn_fleet", { agents: [{ role: "r", prompt: "p", runtime: id }] }],
    // The Available list depends on the registered runtimes; the test pins everything around it.
    message: (id) => `spawn_fleet: unknown runtime '${id}'. Available: `,
  },
  {
    site: "get_work_receipt.source",
    call: (id) => ["get_work_receipt", { source: id, task_id: "t_x", run_id: 1 }],
    message: (id) => `get_work_receipt: unknown source "${id}"; MeshFleet only records source=hermes-kanban`,
  },
];

async function refusalOf(client: Client, [name, args]: [string, Record<string, unknown>]): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean };
  assert.equal(res.isError, true, `${name} should refuse`);
  return (JSON.parse(textOf(res)) as { error: string }).error;
}

function assertSiteMessage(site: string, got: string, expected: string): void {
  if (site === "spawn_fleet.agents[].runtime") {
    assert.ok(got.startsWith(expected), `${site}: ${got.slice(0, 300)}`);
    assert.ok(got.endsWith(RUNTIME_TAIL), `${site}: ${got.slice(-200)}`);
    assert.equal(got.includes("Q".repeat(GOT_ECHO_MAX_CHARS + 1)), false, `${site}: the id reached the Available list`);
  } else {
    assert.equal(got, expected, site);
  }
}

test("raw echo: a value of at most the cap is unchanged; a longer one is cut on a code-point boundary", () => {
  for (const n of [0, 1, 199, GOT_ECHO_MAX_CHARS]) assert.equal(echoRejectedRaw("r".repeat(n)), "r".repeat(n));
  assert.equal(echoRejectedRaw("r".repeat(GOT_ECHO_MAX_CHARS + 1)), "r".repeat(GOT_ECHO_MAX_CHARS) + "…");
  assert.equal(echoRejectedRaw("Q".repeat(1_000_000)), "Q".repeat(GOT_ECHO_MAX_CHARS) + "…");
  // A backslash is an ordinary character in a raw value, not the start of an escape. An even
  // run of backslashes cannot tell the two cuts apart, so each case puts a backslash on an odd
  // offset or across the cap, where a JSON-escape-aware cut would stop one or more units early.
  assert.equal(echoRejectedRaw("\\".repeat(300)), "\\".repeat(GOT_ECHO_MAX_CHARS) + "…");
  assert.equal(echoRejectedRaw("a" + "\\".repeat(300)), "a" + "\\".repeat(GOT_ECHO_MAX_CHARS - 1) + "…");
  const r = "r".repeat(GOT_ECHO_MAX_CHARS - 1);
  assert.equal(echoRejectedRaw(r + "\\n" + "z".repeat(50)), r + "\\…");
  const u = "r".repeat(GOT_ECHO_MAX_CHARS - 4);
  assert.equal(echoRejectedRaw(u + "\\u0041" + "z".repeat(50)), u + "\\u00…");
  // A surrogate pair straddling the cap is dropped whole, never halved.
  const straddle = "a".repeat(GOT_ECHO_MAX_CHARS - 1) + "\u{1F600}" + "b";
  assert.equal(echoRejectedRaw(straddle), "a".repeat(GOT_ECHO_MAX_CHARS - 1) + "…");
  const fits = "a".repeat(GOT_ECHO_MAX_CHARS - 2) + "\u{1F600}" + "b";
  assert.equal(echoRejectedRaw(fits), "a".repeat(GOT_ECHO_MAX_CHARS - 2) + "\u{1F600}…");
  for (const v of ["\u{1F600}".repeat(999), "x" + "\u{1F600}".repeat(999), "e\u0301".repeat(300), "\u{1F469}\u200D\u{1F4BB}".repeat(100)]) {
    const shown = echoRejectedRaw(v);
    assert.ok(shown.endsWith("…"));
    assert.ok(shown.length - 1 <= GOT_ECHO_MAX_CHARS, `echo is ${shown.length - 1} code units`);
    assert.ok((shown as unknown as { isWellFormed(): boolean }).isWellFormed(), "the cut created a lone surrogate");
    assert.ok(v.startsWith(shown.slice(0, -1)), "the echo is a prefix of the value");
  }
  // A lone surrogate the caller sent is echoed as sent, not repaired or dropped.
  assert.equal(echoRejectedRaw("id\uD83D"), "id\uD83D");
  // Non-string values echo their String form, which is what template interpolation gave for
  // every value except a primitive Symbol: String() gives "Symbol()" where the template threw.
  for (const v of [5, true, null, undefined, ["a", "b"], { k: 1 }]) assert.equal(echoRejectedRaw(v), `${v}`);
  assert.equal(echoRejectedRaw(Symbol()), "Symbol()");
  assert.equal(echoRejectedRaw(["Q".repeat(1_000)]), "Q".repeat(GOT_ECHO_MAX_CHARS) + "…");
});

test("MCP: ten caller-id refusals cap a 1 MB id at 200 code units plus an ellipsis", async () => {
  const big = "Q".repeat(1_000_000);
  const capped = "Q".repeat(GOT_ECHO_MAX_CHARS) + "…";
  await withSeededServer(async (client) => {
    for (const { site, call, message } of CALLER_ID_SITES) {
      const got = await refusalOf(client, call(big));
      assert.ok(got.length < 2_000, `${site} refusal is ${got.length} chars`);
      assertSiteMessage(site, got, message(capped));
    }
  });
});

test("MCP: ten caller-id refusals keep their exact bytes for an id of at most 200 code units", async () => {
  const ids = ["nope", "q".repeat(GOT_ECHO_MAX_CHARS), "a\\b\"c\u00e9\u{1F600}", "x".repeat(GOT_ECHO_MAX_CHARS - 2) + "\u{1F600}"];
  await withSeededServer(async (client) => {
    for (const { site, call, message } of CALLER_ID_SITES) {
      for (const id of ids) {
        assert.ok(id.length <= GOT_ECHO_MAX_CHARS);
        assertSiteMessage(site, await refusalOf(client, call(id)), message(id));
      }
    }
  });
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
