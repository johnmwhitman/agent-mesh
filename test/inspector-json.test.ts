import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  buildCouncilsJson,
  buildFleetsJson,
  buildVerifyJson,
  formatReceiptTrail,
  INSPECT_JSON_SCHEMA,
  PROVISIONAL_NOTE,
  type FleetSummary,
} from "../src/inspector.js";
import type { MeshData, Ratification, Receipt } from "../src/core.js";
import type { VerifyReport } from "../src/verify.js";
import { closeDb, getDbPathOverride, importSnapshot, setDbPath } from "../src/db.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSPECT = join(ROOT, "src", "bin", "inspect.ts");

function runInspect(dbFile: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", INSPECT, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, MESHFLEET_DB_FILE: dbFile, ...extraEnv },
    },
  );
}

function withCliLedger(run: (dbFile: string) => void, snapshot: Partial<MeshData> = {}): void {
  const previous = getDbPathOverride();
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-inspect-json-"));
  const dbFile = join(dir, "ledger.db");
  try {
    setDbPath(dbFile);
    const base: MeshData = {
      fleets: {
        f1: { id: "f1", status: "running", created_at: 1_000 },
      },
      agents: {
        a1: { id: "a1", fleet_id: "f1", role: "worker", prompt: "p", status: "running" },
      },
      messages: {},
      inboxes: { a1: [] },
      capabilities: {},
      receipts: {},
      ratifications: {},
      templates: {},
    };
    importSnapshot({ ...base, ...snapshot });
    closeDb();
    run(dbFile);
  } finally {
    closeDb();
    setDbPath(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the envelope schema id is stable", () => {
  assert.equal(INSPECT_JSON_SCHEMA, "meshfleet.inspect/v1");
});

test("buildVerifyJson wraps the full VerifyReport under kind 'verify'", () => {
  const report: VerifyReport = {
    ok: false,
    errors: 1,
    warnings: 0,
    counts: { fleets: 1, agents: 2, messages: 3, receipts: 4, ratifications: 5 },
    findings: [{ severity: "error", check: "receipt.orphan_message", subject: "s", detail: "d" }],
  };
  const out = buildVerifyJson(report);
  assert.equal(out.schema, "meshfleet.inspect/v1");
  assert.equal(out.kind, "verify");
  assert.deepEqual(out.data, report);
  // Round-trips through JSON without loss (the CLI prints JSON.stringify of this).
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

test("buildFleetsJson wraps the fleet summaries under kind 'fleets'", () => {
  const fleets: FleetSummary[] = [
    {
      id: "f1",
      status: "complete",
      created_at: 1_000,
      completed_at: 2_000,
      agent_count: 3,
      agents_complete: 3,
      agents_failed: 0,
      agents_running: 0,
    },
  ];
  const out = buildFleetsJson(fleets);
  assert.equal(out.schema, "meshfleet.inspect/v1");
  assert.equal(out.kind, "fleets");
  assert.deepEqual(out.data, fleets);
  const row = out.data[0]!;
  // Stable field names — scripts key off these.
  for (const k of ["id", "status", "created_at", "agent_count", "agents_complete", "agents_failed", "agents_running"]) {
    assert.ok(k in row, `fleet row must carry ${k}`);
  }
});

function ratification(over: Partial<Ratification> = {}): Ratification {
  return {
    message_id: "p1",
    proposer: "a1",
    fleet_id: "f1",
    subject: "adopt the plan",
    quorum: 2,
    voters: ["a1", "a2", "a3"],
    required_signoffs: ["a1"],
    opened_at: 1_000,
    silence_policy: "abstain",
    status: "open",
    ...over,
  };
}

function vote(agentId: string, action: string): Receipt {
  return { message_id: "p1", agent_id: agentId, action, timestamp: 2_000 };
}

test("buildCouncilsJson carries the ratification plus the vote breakdown the text view shows", () => {
  const rat = ratification();
  const out = buildCouncilsJson([
    { ratification: rat, votes: [vote("a1", "r-ack"), vote("a2", "r-decline"), vote("a9", "seen")] },
  ]);
  assert.equal(out.schema, "meshfleet.inspect/v1");
  assert.equal(out.kind, "councils");
  assert.equal(out.data.length, 1);
  const c = out.data[0]!;
  assert.deepEqual(c.ratification, rat);
  assert.deepEqual(c.approvals, ["a1"]);
  assert.deepEqual(c.declines, ["a2"]);
  assert.deepEqual(c.pending, ["a3"], "eligible voters with no vote are surfaced, non-votes ignored");
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

test("buildCouncilsJson of an empty list is an empty data array (not a prose message)", () => {
  const out = buildCouncilsJson([]);
  assert.equal(out.kind, "councils");
  assert.deepEqual(out.data, []);
});

test("the inspect CLI advertises and wires --json for the scriptable trio", () => {
  const src = readFileSync(join(ROOT, "src", "bin", "inspect.ts"), "utf8");
  assert.match(src, /--json/, "usage text must document the flag");
  assert.match(src, /buildVerifyJson/);
  assert.match(src, /buildFleetsJson/);
  assert.match(src, /buildCouncilsJson/);
});

test("inspect JSON modes emit one versioned document without provisional prose", () => {
  withCliLedger((dbFile) => {
    const cases = [
      {
        args: ["--json", "f1"],
        assertOutput: (out: any) => {
          assert.equal(out.schema, INSPECT_JSON_SCHEMA);
          assert.equal(out.kind, "fleet");
          assert.equal(out.data.fleet.id, "f1");
          assert.equal(out.data.agents[0].id, "a1");
        },
      },
      {
        args: ["--json", "--receipts"],
        assertOutput: (out: any) => {
          assert.equal(out.schema, "meshfleet.receipts/v1");
          assert.deepEqual(out.items, []);
        },
      },
      {
        args: ["--json", "--metrics"],
        assertOutput: (out: any) => {
          assert.equal(out.schema, INSPECT_JSON_SCHEMA);
          assert.equal(out.kind, "metrics");
          assert.equal(out.data.total_fleets, 1);
        },
      },
      {
        args: ["--json", "--events", "2"],
        assertOutput: (out: any) => {
          assert.equal(out.schema, INSPECT_JSON_SCHEMA);
          assert.equal(out.kind, "events");
          assert.ok(Array.isArray(out.data));
        },
      },
    ];

    for (const { args, assertOutput } of cases) {
      const result = runInspect(dbFile, args);
      assert.equal(result.status, 0, `${args.join(" ")} should succeed: ${result.stderr}`);
      assert.equal(result.stderr, "");
      assert.doesNotMatch(result.stdout, /Provisional/);
      const parsed = JSON.parse(result.stdout);
      assertOutput(parsed);
      assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed);
    }
  });
});

test("inspect --json missing fleet returns exit 1 and one JSON error document", () => {
  withCliLedger((dbFile) => {
    const result = runInspect(dbFile, ["--json", "missing"]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.schema, INSPECT_JSON_SCHEMA);
    assert.equal(parsed.kind, "error");
    assert.equal(parsed.error, "Fleet missing not found");
  });
});

test("inspect text fleet detail remains the existing non-JSON output", () => {
  withCliLedger((dbFile) => {
    const result = runInspect(dbFile, ["f1"]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      "Fleet f1\n" +
        "Status: running\n" +
        "Created: 1970-01-01T00:00:01.000Z\n" +
        "\nAgents (1):\n" +
        "  ◐  worker  running \n",
    );
    assert.doesNotMatch(result.stdout, /\"schema\"|\"kind\"|\"data\"/);
  });
});

test("inspect JSON receipts includes a non-empty message and receipt trail", () => {
  const message = {
    id: "m1",
    from_agent_id: "a1",
    to_agent_id: "a2",
    fleet_id: "f1",
    type: "result" as const,
    payload: "result payload",
    timestamp: 2_000,
    acknowledged: true,
  };
  const receipt = {
    message_id: "m1",
    agent_id: "a2",
    action: "ack",
    timestamp: 3_000,
  };

  withCliLedger((dbFile) => {
    const result = runInspect(dbFile, ["--json", "--receipts"]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /Provisional/);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.schema, "meshfleet.receipts/v1");
    assert.equal(parsed.items.length, 1);
    assert.deepEqual(parsed.items[0].message, message);
    assert.deepEqual(parsed.items[0].receipts, [receipt]);
  }, {
    agents: {
      a1: { id: "a1", fleet_id: "f1", role: "worker", prompt: "p", status: "running" },
      a2: { id: "a2", fleet_id: "f1", role: "reviewer", prompt: "p", status: "running" },
    },
    messages: { m1: message },
    receipts: { "m1:a2:ack": receipt },
    inboxes: { a1: [], a2: [] },
  });
});

test("JSON missing-fleet handling uses exitCode so stdout can flush", () => {
  const src = readFileSync(join(ROOT, "src", "bin", "inspect.ts"), "utf8");
  const printOneFleet = src.slice(src.indexOf("function printOneFleet"));
  assert.match(printOneFleet, /process\.exitCode\s*=\s*1/);
  assert.doesNotMatch(printOneFleet, /process\.exit\(1\)/);
});

test("inspect text receipts remain byte-compatible for a non-empty trail", () => {
  const message = {
    id: "m1",
    from_agent_id: "a1",
    to_agent_id: "a2",
    fleet_id: "f1",
    type: "result" as const,
    payload: "result payload",
    timestamp: 2_000,
    acknowledged: true,
  };
  const receipt = {
    message_id: "m1",
    agent_id: "a2",
    action: "ack",
    timestamp: 3_000,
  };

  withCliLedger((dbFile) => {
    const result = runInspect(dbFile, ["--receipts"]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      PROVISIONAL_NOTE + "\n\n" + formatReceiptTrail(message, [receipt]) + "\n\n",
    );
    assert.doesNotMatch(result.stdout, /\"schema\"|\"kind\"|\"data\"/);
  }, {
    agents: {
      a1: { id: "a1", fleet_id: "f1", role: "worker", prompt: "p", status: "running" },
      a2: { id: "a2", fleet_id: "f1", role: "reviewer", prompt: "p", status: "running" },
    },
    messages: { m1: message },
    receipts: { "m1:a2:ack": receipt },
    inboxes: { a1: [], a2: [] },
  });
});

test("inspect text metrics remain byte-compatible", () => {
  withCliLedger((dbFile) => {
    const result = runInspect(dbFile, ["--metrics"]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      "Agent Mesh — Fleet Metrics\n\n" +
        "Total fleets:       1\n" +
        "  completed:        0\n" +
        "  failed:           0\n" +
        "  running:          1\n" +
        "Total agents:       1\n" +
        "Total messages:     0\n" +
        "Total capabilities: 0\n" +
        "Avg fleet duration: 0ms\n" +
        "Success rate:       0.0%\n",
    );
    assert.doesNotMatch(result.stdout, /\"schema\"|\"kind\"|\"data\"/);
  });
});

test("inspect text events remain byte-compatible", () => {
  const home = mkdtempSync(join(tmpdir(), "meshfleet-inspect-events-"));
  try {
    withCliLedger((dbFile) => {
      const result = runInspect(dbFile, ["--events", "2"], { HOME: home });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, "No events recorded.\n");
      assert.doesNotMatch(result.stdout, /\"schema\"|\"kind\"|\"data\"/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
