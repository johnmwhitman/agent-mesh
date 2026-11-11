import { test } from "node:test";
import assert from "node:assert/strict";

import { decideReplay, type ReplayQuery } from "../src/a2a/replay-decision.js";

const query: ReplayQuery = {
  principal_ref: "principal-ref",
  request_id: "request-ref",
  sender: { namespace: "local", agent_id: "agent-a" },
  message_id: "message-ref",
  envelope_digest: "meshfleet.a2a.fingerprint.v1:sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

test("replay decision invokes a transport-neutral oracle once with an isolated canonical query", () => {
  let calls = 0;
  const result = decideReplay(query, (argument) => {
    calls += 1;
    assert.deepEqual(argument, query);
    argument.sender.agent_id = "mutated-by-oracle";
    return "unseen";
  });

  assert.deepEqual(result, { kind: "unseen" });
  assert.equal(calls, 1);
  assert.deepEqual(query.sender, { namespace: "local", agent_id: "agent-a" });
});

test("replay decision preserves each closed non-admission disposition", () => {
  for (const verdict of ["replayed_request", "request_id_reuse", "duplicate", "message_id_conflict"] as const) {
    assert.deepEqual(decideReplay(query, () => verdict), { kind: "not_admitted", disposition: verdict });
  }
});

test("replay decision fails closed for an unavailable, malformed, or throwing oracle", () => {
  for (const oracle of [
    () => "unavailable",
    () => "unexpected",
    () => { throw new Error("offline fixture"); },
  ]) {
    assert.deepEqual(decideReplay(query, oracle), { kind: "unavailable" });
  }
});

test("boundary case: duplicate delivery resolves to closed duplicate disposition with query isolation", () => {
  // Model duplicate delivery attempts where the oracle recognizes a previous delivery
  // and classifies subsequent deliveries as duplicate or replayed_request.
  let callCount = 0;
  const observedQueries: ReplayQuery[] = [];
  const duplicateOracle = (arg: ReplayQuery) => {
    callCount += 1;
    observedQueries.push(arg);
    arg.sender.agent_id = `mutated-call-${callCount}`;
    return callCount === 1 ? "unseen" : "duplicate";
  };

  const firstResult = decideReplay(query, duplicateOracle);
  assert.deepEqual(firstResult, { kind: "unseen" });
  assert.equal(callCount, 1);
  assert.deepEqual(query.sender, { namespace: "local", agent_id: "agent-a" });

  const secondResult = decideReplay(query, duplicateOracle);
  assert.deepEqual(secondResult, { kind: "not_admitted", disposition: "duplicate" });
  assert.equal(callCount, 2);
  assert.deepEqual(query.sender, { namespace: "local", agent_id: "agent-a" });

  // Verify that an alternate duplicate delivery disposition like replayed_request also holds
  const replayedResult = decideReplay(query, () => "replayed_request");
  assert.deepEqual(replayedResult, { kind: "not_admitted", disposition: "replayed_request" });

  // Ensure query passed to oracle was copied on each call and query mutated in oracle didn't bleed
  assert.equal(observedQueries.length, 2);
  assert.notEqual(observedQueries[0], observedQueries[1]);
  assert.notEqual(observedQueries[0], query);
});

test("boundary case: out-of-order trace surfaces as oracle sequencing anomalies and fails closed", () => {
  // Model out-of-order trace events where an oracle detects sequence regression,
  // inverted lifecycle events, or unexpected sequence steps and raises or returns invalid status.
  const sequencingAnomalies = [
    () => {
      const err = new Error("ORDER_VIOLATION: sequence regression in delivery trace");
      err.name = "OrderViolationError";
      throw err;
    },
    () => ({ error: "ORDER_VIOLATION", precedence_row: "D08" }),
    () => "ORDER_VIOLATION",
    () => "out_of_order",
    () => null,
    () => undefined,
  ];

  for (const anomalyOracle of sequencingAnomalies) {
    const result = decideReplay(query, anomalyOracle);
    assert.deepEqual(result, { kind: "unavailable" });
  }

  // Also verify sequence tracking across out-of-order calls fails closed when sequence jumps
  let lastSequence = 2;
  const traceSequenceOracle = (arg: ReplayQuery) => {
    const incomingSequence = arg.request_id === "req-seq-1" ? 1 : 3;
    if (incomingSequence <= lastSequence) {
      throw new Error(`ORDER_VIOLATION: event sequence ${incomingSequence} <= previous ${lastSequence}`);
    }
    lastSequence = incomingSequence;
    return "unseen";
  };

  const outOfOrderQuery: ReplayQuery = { ...query, request_id: "req-seq-1" };
  assert.deepEqual(decideReplay(outOfOrderQuery, traceSequenceOracle), { kind: "unavailable" });
});

test("boundary case: missing original fails closed for unresolvable or missing reference records", () => {
  // When the oracle expects an original message/request reference (e.g. for correlating
  // an acknowledgment, retry, or receipt) but the original record is missing from the ledger
  // or replay store, the oracle signals missing original by throwing or returning unresolvable status.
  const missingOriginalOracles = [
    () => {
      throw new Error("MISSING_ORIGINAL: message-ref not found in replay journal");
    },
    () => ({ error: "MISSING_ORIGINAL", message_id: query.message_id }),
    () => "missing_original",
    () => "not_found",
    () => false,
  ];

  for (const missingOracle of missingOriginalOracles) {
    const result = decideReplay(query, missingOracle);
    assert.deepEqual(result, { kind: "unavailable" });
  }

  // Verify that an isolated query with empty or unknown principal/request fails closed when oracle rejects it
  const missingRefOracle = (arg: ReplayQuery) => {
    if (!arg.request_id || !arg.message_id || arg.principal_ref === "unknown") {
      throw new Error("MISSING_ORIGINAL_REFERENCE");
    }
    return "unseen";
  };
  const unknownOriginalQuery: ReplayQuery = { ...query, principal_ref: "unknown" };
  assert.deepEqual(decideReplay(unknownOriginalQuery, missingRefOracle), { kind: "unavailable" });
});
