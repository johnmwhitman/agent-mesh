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
