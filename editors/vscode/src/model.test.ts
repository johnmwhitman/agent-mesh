import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLedgerExport, parseVerifyEnvelope, verdictFromVerifyOutput } from "./model.js";

const EXPORT = JSON.stringify({
  schema_version: 2,
  fleets: {
    f1: { id: "f1", status: "running", created_at: 1_000 },
    f2: { id: "f2", status: "complete", created_at: 500, completed_at: 2_000 },
  },
  agents: {
    a1: { id: "a1", fleet_id: "f1", role: "reviewer", prompt: "p", status: "running" },
    a2: { id: "a2", fleet_id: "f1", role: "tester", prompt: "p", status: "complete" },
    b1: { id: "b1", fleet_id: "f2", role: "writer", prompt: "p", status: "failed" },
  },
  messages: {},
  inboxes: {},
  capabilities: {},
  receipts: {
    "m1:a2:r-ack": { message_id: "m1", agent_id: "a2", action: "r-ack", timestamp: 1_500 },
  },
  ratifications: {
    m1: {
      message_id: "m1", proposer: "a1", fleet_id: "f1", subject: "adopt the plan",
      quorum: 2, voters: ["a2", "b1"], required_signoffs: [], opened_at: 1_200,
      silence_policy: "abstain", status: "open",
    },
  },
  templates: {},
});

test("parseLedgerExport shapes fleets with their agents, newest fleet first", () => {
  const m = parseLedgerExport(EXPORT);
  assert.equal(m.fleets.length, 2);
  assert.equal(m.fleets[0]!.id, "f1"); // created_at 1000 > 500
  assert.equal(m.fleets[0]!.status, "running");
  assert.deepEqual(m.fleets[0]!.agents.map((a) => a.role), ["reviewer", "tester"]);
  assert.equal(m.fleets[1]!.agents[0]!.status, "failed");
});

test("parseLedgerExport shapes councils with vote progress", () => {
  const m = parseLedgerExport(EXPORT);
  assert.equal(m.councils.length, 1);
  const c = m.councils[0]!;
  assert.equal(c.subject, "adopt the plan");
  assert.equal(c.status, "open");
  assert.equal(c.quorum, 2);
  assert.equal(c.approvals, 1); // a2's r-ack receipt
  assert.equal(c.voters, 2);
});

test("parseLedgerExport tolerates a ledger with no ratifications key", () => {
  const bare = JSON.stringify({ schema_version: 2, fleets: {}, agents: {}, messages: {}, inboxes: {}, capabilities: {} });
  const m = parseLedgerExport(bare);
  assert.deepEqual(m.fleets, []);
  assert.deepEqual(m.councils, []);
});

test("parseLedgerExport throws a readable error on non-JSON input", () => {
  assert.throws(() => parseLedgerExport("not json"), /ledger export was not valid JSON/);
});

test("verdictFromVerifyOutput classifies exit codes and extracts the summary line", () => {
  const ok = verdictFromVerifyOutput(0, "✔ OK — 0 errors, 0 warnings   (fleets 2 · agents 3 · messages 0 · receipts 1 · councils 1)\n");
  assert.equal(ok.ok, true);
  assert.match(ok.summary, /0 errors/);
  const bad = verdictFromVerifyOutput(1, "✖ FAIL — 2 errors, 1 warning   (…)\n  ERROR receipt.orphan_message …\n");
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /2 errors/);
});

test("parseVerifyEnvelope accepts a stable verify JSON envelope with zero findings", () => {
  const envelope = JSON.stringify({
    schema: "meshfleet.inspect/v1",
    kind: "verify",
    data: {
      ok: true,
      errors: 0,
      warnings: 0,
      counts: { fleets: 2, agents: 4, messages: 3, receipts: 1, councils: 1 },
      findings: [],
    },
  });

  const verdict = parseVerifyEnvelope(envelope);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.errors, 0);
  assert.equal(verdict.warnings, 0);
  assert.equal(verdict.summary, "0 errors, 0 warnings (fleets 2 · agents 4 · messages 3 · receipts 1 · councils 1)");
  assert.deepEqual(verdict.findings, []);
});

test("parseVerifyEnvelope parses failures and preserves findings", () => {
  const envelope = JSON.stringify({
    schema: "meshfleet.inspect/v1",
    kind: "verify",
    data: {
      ok: false,
      errors: 2,
      warnings: 1,
      counts: { fleets: 1, agents: 3, messages: 2, receipts: 0, councils: 5 },
      findings: [
        { severity: "ERROR", check: "receipt.orphan_message", detail: "message m1 missing" },
        { severity: "WARN", check: "fleet.stale", detail: "fleet f2 has no activity" },
      ],
    },
  });

  const verdict = parseVerifyEnvelope(envelope);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors, 2);
  assert.equal(verdict.warnings, 1);
  assert.equal(verdict.summary, "2 errors, 1 warnings (fleets 1 · agents 3 · messages 2 · receipts 0 · councils 5)");
  assert.deepEqual(verdict.findings, [
    { severity: "ERROR", check: "receipt.orphan_message", detail: "message m1 missing" },
    { severity: "WARN", check: "fleet.stale", detail: "fleet f2 has no activity" },
  ]);
});

test("parseVerifyEnvelope rejects unsupported kind", () => {
  const envelope = JSON.stringify({
    schema: "meshfleet.inspect/v1",
    kind: "export",
    data: { ok: true, errors: 0, warnings: 0, counts: { fleets: 0, agents: 0, messages: 0, receipts: 0, councils: 0 }, findings: [] },
  });
  assert.throws(
    () => parseVerifyEnvelope(envelope),
    /verify envelope has unexpected kind: export/,
  );
});

test("parseVerifyEnvelope rejects garbage JSON", () => {
  assert.throws(() => parseVerifyEnvelope("<<<not json>>>"), /not valid JSON/);
});

test("parseVerifyEnvelope enforces summary shape", () => {
  const envelope = JSON.stringify({
    schema: "meshfleet.inspect/v1",
    kind: "verify",
    data: {
      ok: false,
      errors: 12,
      warnings: 7,
      counts: { fleets: 9, agents: 8, messages: 7, receipts: 6, councils: 5 },
      findings: [],
    },
  });
  const verdict = parseVerifyEnvelope(envelope);
  assert.equal(verdict.summary, "12 errors, 7 warnings (fleets 9 · agents 8 · messages 7 · receipts 6 · councils 5)");
});
