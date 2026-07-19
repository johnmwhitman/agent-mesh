import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  buildCouncilsJson,
  buildFleetsJson,
  buildVerifyJson,
  INSPECT_JSON_SCHEMA,
  type FleetSummary,
} from "../src/inspector.js";
import type { Ratification, Receipt } from "../src/core.js";
import type { VerifyReport } from "../src/verify.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
