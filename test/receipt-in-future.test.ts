/**
 * verify_ledger must report a receipt whose server-side timestamp is after the
 * audit's now — `receipt.in_future`. Pre-fix the verifier covered
 * receipt.invalid_timestamp (non-finite) and receipt.before_message
 * (`r.timestamp < msg.timestamp` past-impossibility), but never compared
 * `r.timestamp` to the audit's now. A tampered receipt.timestamp set to
 * `now + 3600` verified silently with zero findings.
 *
 * The receipt schema has no `payload_sha256` (delivery receipts are not
 * `work_receipts`), so the timestamp is server-side metadata set by
 * `writeReceipt` from `Date.now()` and nothing else scans it. Same blind-spot
 * class as work_receipt.recorded_in_future (cycle-892 PR 216 unmerged),
 * capability.registered_in_future (cycle-894 PR 218 unmerged), and
 * ratification.opened_in_future / resolved_in_future (cycle-895 PR 219
 * unmerged), but on a DIFFERENT server-side-metadata surface.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyMeshData } from "../src/verify.js";
import type { MeshData } from "../src/core.js";

const NOW = 1_800_000_000_000;

const base = (): MeshData => ({
  fleets: { f1: { id: "f1", status: "complete", created_at: NOW - 9000, completed_at: NOW - 1 } },
  agents: {
    a1: { id: "a1", fleet_id: "f1", role: "Proposer", prompt: "p", status: "complete", started_at: NOW - 9000, completed_at: NOW - 1000 },
    a2: { id: "a2", fleet_id: "f1", role: "Reviewer", prompt: "p", status: "complete", started_at: NOW - 9000, completed_at: NOW - 1000 },
  },
  messages: {
    m1: { id: "m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1", type: "handoff", payload: "review", timestamp: NOW - 500, acknowledged: true },
  },
  inboxes: { a1: [], a2: [] },
  capabilities: {},
  receipts: {
    "m1:a2:ack": { message_id: "m1", agent_id: "a2", action: "ack", timestamp: NOW - 400 },
  },
  ratifications: {},
  templates: {},
});

test("receipt.in_future fires once on a planted future receipt timestamp", () => {
  const data = base();
  data.receipts!["m1:a2:ack"].timestamp = NOW + 3600_000; // ~1h ahead of now
  const report = verifyMeshData(data, NOW);
  const hits = report.findings.filter((f) => f.check === "receipt.in_future");
  assert.equal(hits.length, 1, `expected exactly one receipt.in_future, got ${hits.length}`);
  assert.equal(hits[0].severity, "error");
  assert.equal(hits[0].subject, "m1:a2:ack");
  assert.equal(report.ok, false);
});

test("a receipt timestamp exactly equal to now is silent (strictly greater than now fires)", () => {
  const data = base();
  data.receipts!["m1:a2:ack"].timestamp = NOW;
  const report = verifyMeshData(data, NOW);
  const hits = report.findings.filter((f) => f.check === "receipt.in_future");
  assert.equal(hits.length, 0, `boundary timestamp == now must not fire, got ${hits.length}`);
});

test("a receipt timestamp one millisecond past now fires once", () => {
  const data = base();
  data.receipts!["m1:a2:ack"].timestamp = NOW + 1;
  const report = verifyMeshData(data, NOW);
  const hits = report.findings.filter((f) => f.check === "receipt.in_future");
  assert.equal(hits.length, 1);
  assert.equal(report.ok, false);
});

test("honest receipt timestamps in the past do NOT fire receipt.in_future", () => {
  const data = base();
  // baseline receipt is at NOW - 400; honest control
  const report = verifyMeshData(data, NOW);
  const hits = report.findings.filter((f) => f.check === "receipt.in_future");
  assert.equal(hits.length, 0, `honest control must be silent, got ${hits.length}`);
  assert.equal(report.ok, true);
});
