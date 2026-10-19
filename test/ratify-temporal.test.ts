// Ratification temporal invariants — `opened_at` and `resolved_at` are
// server-side metadata written by the open/resolve/sweep paths from
// Date.now() and are NOT covered by the ratification payload digest, so the
// verifier is the only path that can see tampering. Three sibling
// invariants: opened_in_future (relative-to-now), resolved_in_future
// (relative-to-now), resolved_before_opened (within-row impossibility).
//
// Same family as work_receipt.recorded_in_future (cycle-892) and
// capability.registered_in_future (cycle-894), applied to the ratification
// stream. All three must exist for full coverage of server-side-metadata
// tampering on ratification rows.

import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyMeshData, type VerifyReport } from "../src/verify.js";
import type { MeshData, Ratification } from "../src/core.js";

const NOW_MS = 1_700_000_000_000; // arbitrary fixed-epoch ms

type RatificationSeed = Pick<Ratification,
  "message_id" | "proposer" | "fleet_id" | "subject" | "quorum" | "voters" |
  "required_signoffs" | "opened_at" | "resolved_at" | "silence_policy" | "status"
>;

function ledgerWith(r: RatificationSeed, opts: {
  ackTs?: number;
  messageTs?: number;
}): MeshData {
  const messageTs = opts.messageTs ?? r.opened_at;
  const receipts: Record<string, any> = {};
  if (opts.ackTs !== undefined) {
    receipts[`${r.message_id}:a:r-ack`] = {
      message_id: r.message_id,
      agent_id: "a",
      action: "r-ack",
      timestamp: opts.ackTs,
    };
  }
  return {
    fleets: { f1: { id: "f1", status: "running", created_at: 1_000 } },
    agents: {
      p: { id: "p", fleet_id: "f1", role: "r", prompt: "x", status: "running" },
      a: { id: "a", fleet_id: "f1", role: "r", prompt: "x", status: "running" },
    },
    messages: {
      [r.message_id]: {
        id: r.message_id, from_agent_id: "p", to_agent_id: "*",
        fleet_id: "f1", type: "question", payload: "q",
        timestamp: messageTs, acknowledged: false,
        recipients: ["p", "a"],
      },
    },
    inboxes: { p: [], a: [r.message_id] },
    capabilities: {},
    receipts,
    ratifications: { [r.message_id]: r },
  };
}

function countFindings(report: VerifyReport, check: string, subject: string): number {
  return report.findings.filter((f) => f.check === check && f.subject === subject).length;
}

test("opened_in_future — planted; honest control silent", () => {
  const planted = verifyMeshData(
    ledgerWith({
      message_id: "p1", proposer: "p", fleet_id: "f1", subject: "s",
      quorum: 1, voters: ["a"], required_signoffs: [],
      opened_at: NOW_MS + 3_600_000, // 1h in the future
      silence_policy: "abstain", status: "open",
    }, {}),
    NOW_MS,
  );
  assert.equal(countFindings(planted, "ratification.opened_in_future", "p1"), 1, JSON.stringify(planted.findings));

  const honest = verifyMeshData(
    ledgerWith({
      message_id: "p2", proposer: "p", fleet_id: "f1", subject: "s",
      quorum: 1, voters: ["a"], required_signoffs: [],
      opened_at: NOW_MS - 3_000,
      silence_policy: "abstain", status: "open",
    }, {}),
    NOW_MS,
  );
  assert.equal(countFindings(honest, "ratification.opened_in_future", "p2"), 0, JSON.stringify(honest.findings));
});

test("resolved_in_future — planted; honest control silent", () => {
  // Use 'expired' to isolate the temporal defect from any status_mismatch side-effect.
  const planted = verifyMeshData(
    ledgerWith({
      message_id: "p1", proposer: "p", fleet_id: "f1", subject: "s",
      quorum: 1, voters: ["a"], required_signoffs: [],
      opened_at: NOW_MS - 60_000,
      resolved_at: NOW_MS + 3_600_000, // 1h in the future
      silence_policy: "abstain", status: "expired",
    }, {}),
    NOW_MS,
  );
  assert.equal(countFindings(planted, "ratification.resolved_in_future", "p1"), 1, JSON.stringify(planted.findings));

  const honest = verifyMeshData(
    ledgerWith({
      message_id: "p2", proposer: "p", fleet_id: "f1", subject: "s",
      quorum: 1, voters: ["a"], required_signoffs: [],
      opened_at: NOW_MS - 60_000,
      resolved_at: NOW_MS - 1_000,
      silence_policy: "abstain", status: "ratified",
    }, { ackTs: NOW_MS - 30_000 }),
    NOW_MS,
  );
  assert.equal(countFindings(honest, "ratification.resolved_in_future", "p2"), 0, JSON.stringify(honest.findings));
});

test("resolved_before_opened — planted within-row impossibility; honest control silent", () => {
  // Status 'ratified' with an ack before resolved_at: tests that the
  // dedicated temporal check fires INDEPENDENTLY of the receipts-as-of-resolution
  // recount, so the side-effect status_mismatch does not double-fire the temporal
  // finding (and vice versa).
  const planted = verifyMeshData(
    ledgerWith({
      message_id: "p1", proposer: "p", fleet_id: "f1", subject: "s",
      quorum: 1, voters: ["a"], required_signoffs: [],
      opened_at: NOW_MS - 60_000,
      resolved_at: NOW_MS - 3_600_000, // 1h before opened_at
      silence_policy: "abstain", status: "ratified",
    }, { ackTs: NOW_MS - 3_500_000 }), // ack strictly before resolved_at (so no before_message)
    NOW_MS,
  );
  assert.equal(countFindings(planted, "ratification.resolved_before_opened", "p1"), 1, JSON.stringify(planted.findings));

  // Equal timestamps: legitimate single-decision case the sweep would have produced
  // for itself — strict-less-than keeps this silent.
  const honestEqual = verifyMeshData(
    ledgerWith({
      message_id: "p2", proposer: "p", fleet_id: "f1", subject: "s",
      quorum: 1, voters: ["a"], required_signoffs: [],
      opened_at: NOW_MS - 1_000,
      resolved_at: NOW_MS - 1_000,
      silence_policy: "abstain", status: "ratified",
    }, { ackTs: NOW_MS - 1_000 }),
    NOW_MS,
  );
  assert.equal(countFindings(honestEqual, "ratification.resolved_before_opened", "p2"), 0, JSON.stringify(honestEqual.findings));
});

test("each planted row fires EXACTLY once on its own invariant", () => {
  const data: MeshData = {
    fleets: { f1: { id: "f1", status: "running", created_at: 1_000 } },
    agents: {
      p: { id: "p", fleet_id: "f1", role: "r", prompt: "x", status: "running" },
      a: { id: "a", fleet_id: "f1", role: "r", prompt: "x", status: "running" },
    },
    messages: {
      h: { id: "h", from_agent_id: "p", to_agent_id: "*", fleet_id: "f1", type: "question", payload: "q", timestamp: NOW_MS - 60_000, acknowledged: false, recipients: ["p", "a"] },
      a_msg: { id: "a_msg", from_agent_id: "p", to_agent_id: "*", fleet_id: "f1", type: "question", payload: "q", timestamp: NOW_MS + 3_600_000, acknowledged: false, recipients: ["p", "a"] },
      b_msg: { id: "b_msg", from_agent_id: "p", to_agent_id: "*", fleet_id: "f1", type: "question", payload: "q", timestamp: NOW_MS - 60_000, acknowledged: false, recipients: ["p", "a"] },
      c_msg: { id: "c_msg", from_agent_id: "p", to_agent_id: "*", fleet_id: "f1", type: "question", payload: "q", timestamp: NOW_MS - 60_000, acknowledged: false, recipients: ["p", "a"] },
    },
    inboxes: { p: [], a: ["h", "a_msg", "b_msg", "c_msg"] },
    capabilities: {},
    receipts: {
      "h:a:r-ack": { message_id: "h", agent_id: "a", action: "r-ack", timestamp: NOW_MS - 30_000 },
    },
    ratifications: {
      // honest: opened well before now, resolved well before now, ack between
      h: { message_id: "h", proposer: "p", fleet_id: "f1", subject: "h", quorum: 1, voters: ["a"], required_signoffs: [], opened_at: NOW_MS - 60_000, resolved_at: NOW_MS - 1_000, silence_policy: "abstain", status: "ratified" },
      // p_a: opened in the future (status 'open' so no temporal-mismatch side-effect)
      a_msg: { message_id: "a_msg", proposer: "p", fleet_id: "f1", subject: "a_msg", quorum: 1, voters: ["a"], required_signoffs: [], opened_at: NOW_MS + 3_600_000, silence_policy: "abstain", status: "open" },
      // p_b: resolved in the future (status 'expired' so no status_mismatch side-effect)
      b_msg: { message_id: "b_msg", proposer: "p", fleet_id: "f1", subject: "b_msg", quorum: 1, voters: ["a"], required_signoffs: [], opened_at: NOW_MS - 60_000, resolved_at: NOW_MS + 3_600_000, silence_policy: "abstain", status: "expired" },
      // p_c: resolved before opened (status 'ratified' so the receipt.asOf recompute DOES fire
      // status_mismatch — verify the temporal finding fires INDEPENDENTLY of that)
      c_msg: { message_id: "c_msg", proposer: "p", fleet_id: "f1", subject: "c_msg", quorum: 1, voters: ["a"], required_signoffs: [], opened_at: NOW_MS - 60_000, resolved_at: NOW_MS - 3_600_000, silence_policy: "abstain", status: "ratified" },
    },
  };
  const report = verifyMeshData(data, NOW_MS);
  // honest silent on all three new checks
  assert.equal(countFindings(report, "ratification.opened_in_future", "h"), 0);
  assert.equal(countFindings(report, "ratification.resolved_in_future", "h"), 0);
  assert.equal(countFindings(report, "ratification.resolved_before_opened", "h"), 0);
  // p_a fires once on opened_in_future only
  assert.equal(countFindings(report, "ratification.opened_in_future", "a_msg"), 1);
  assert.equal(countFindings(report, "ratification.resolved_in_future", "a_msg"), 0);
  assert.equal(countFindings(report, "ratification.resolved_before_opened", "a_msg"), 0);
  // p_b fires once on resolved_in_future only
  assert.equal(countFindings(report, "ratification.opened_in_future", "b_msg"), 0);
  assert.equal(countFindings(report, "ratification.resolved_in_future", "b_msg"), 1);
  assert.equal(countFindings(report, "ratification.resolved_before_opened", "b_msg"), 0);
  // p_c fires once on resolved_before_opened (status_mismatch is a tangential side-effect)
  assert.equal(countFindings(report, "ratification.opened_in_future", "c_msg"), 0);
  assert.equal(countFindings(report, "ratification.resolved_in_future", "c_msg"), 0);
  assert.equal(countFindings(report, "ratification.resolved_before_opened", "c_msg"), 1);
});

test("invalid_timestamp — non-finite opened_at / resolved_at also fire the temporal check", () => {
  const data: MeshData = {
    fleets: { f1: { id: "f1", status: "running", created_at: 1_000 } },
    agents: {
      p: { id: "p", fleet_id: "f1", role: "r", prompt: "x", status: "running" },
      a: { id: "a", fleet_id: "f1", role: "r", prompt: "x", status: "running" },
    },
    messages: {
      o: { id: "o", from_agent_id: "p", to_agent_id: "*", fleet_id: "f1", type: "question", payload: "q", timestamp: 1_000, acknowledged: false, recipients: ["p", "a"] },
      r: { id: "r", from_agent_id: "p", to_agent_id: "*", fleet_id: "f1", type: "question", payload: "q", timestamp: 1_000, acknowledged: false, recipients: ["p", "a"] },
    },
    inboxes: { p: [], a: ["o", "r"] },
    capabilities: {},
    receipts: {},
    ratifications: {
      // Non-finite opened_at — caught by ratification.invalid_timestamp BEFORE the *_in_future branch
      o: { message_id: "o", proposer: "p", fleet_id: "f1", subject: "o", quorum: 1, voters: ["a"], required_signoffs: [], opened_at: Number.NaN as unknown as number, silence_policy: "abstain", status: "open" },
      // Non-finite resolved_at
      r: { message_id: "r", proposer: "p", fleet_id: "f1", subject: "r", quorum: 1, voters: ["a"], required_signoffs: [], opened_at: 1_000, resolved_at: Infinity, silence_policy: "abstain", status: "open" },
    },
  };
  const report = verifyMeshData(data, NOW_MS);
  // Non-finite opened_at fires ratification.invalid_timestamp ONCE, not opened_in_future
  assert.equal(countFindings(report, "ratification.invalid_timestamp", "o"), 1, JSON.stringify(report.findings));
  assert.equal(countFindings(report, "ratification.opened_in_future", "o"), 0);
  // Non-finite resolved_at fires ratification.invalid_timestamp ONCE, not resolved_in_future
  assert.equal(countFindings(report, "ratification.invalid_timestamp", "r"), 1, JSON.stringify(report.findings));
  assert.equal(countFindings(report, "ratification.resolved_in_future", "r"), 0);
  assert.equal(countFindings(report, "ratification.resolved_before_opened", "r"), 0);
});
