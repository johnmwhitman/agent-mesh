#!/usr/bin/env node
// Build the binding-slice corpus addition: 17 new mandatory cases (12 binding,
// 4 context-mismatch, 1 sender-mismatch) from the valid.admission-plan baseline.
// Usage: node scripts/gen-binding-cases.mjs > /tmp/binding-new-cases.json
import { readFileSync, writeFileSync } from "node:fs";

const corpus = JSON.parse(readFileSync(new URL("../test/fixtures/a2a/local-admission/v0.1/corpus.json", import.meta.url), "utf8"));
const base = corpus.cases.find((c) => c.id === "valid.admission-plan");
if (!base) throw new Error("baseline missing");

const baseReq = JSON.parse(base.invocation_args.request_json);
const baseEnv = JSON.parse(base.invocation_args.envelope_json);
const baseExpected = base.expected;

// The oracle receives the same arguments every admission-plan case (sender =
// envelope sender agent-a, message-ref, digest). All 17 cases are denials with
// zero oracle calls, so we only need the structural skeleton for the plan.
const plan = baseExpected.result;

const mk = (id, mutateReq, mutateEnv, expected, note) => {
  const req = JSON.parse(JSON.stringify(baseReq));
  const env = JSON.parse(JSON.stringify(baseEnv));
  if (mutateReq) mutateReq(req);
  if (mutateEnv) mutateEnv(env);
  return {
    id,
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: JSON.stringify(req),
      envelope_json: JSON.stringify(env),
      replay_oracle_result: "unseen",
    },
    expected,
    _note: note,
  };
};

const INVALID_BINDING = (field_path) => ({
  result: { kind: "rejected", code: "INVALID_BINDING_SNAPSHOT", field_path },
  replay_oracle_calls: 0,
  replay_oracle_arguments: [],
});
const DENIED = {
  result: { kind: "rejected", code: "AUTHORIZATION_DENIED", field_path: "$" },
  replay_oracle_calls: 0,
  replay_oracle_arguments: [],
};

const cases = [];

// ---- binding snapshot member/field/grammar failures (A05) ----
cases.push(mk(
  "binding.missing-snapshot-member",
  (r) => { delete r.binding_snapshot.fixture_provenance; },
  null,
  INVALID_BINDING("$.binding_snapshot.fixture_provenance"),
));
cases.push(mk(
  "binding.unknown-snapshot-member",
  (r) => { r.binding_snapshot.extra = true; },
  null,
  INVALID_BINDING("$.binding_snapshot"),
));
cases.push(mk(
  "binding.invalid-snapshot-id",
  (r) => { r.binding_snapshot.snapshot_id = "bad id!"; },
  null,
  INVALID_BINDING("$.binding_snapshot.snapshot_id"),
));
cases.push(mk(
  "binding.invalid-provenance",
  (r) => { r.binding_snapshot.fixture_provenance = "other"; },
  null,
  INVALID_BINDING("$.binding_snapshot.fixture_provenance"),
));
cases.push(mk(
  "binding.invalid-effective-from",
  (r) => { r.binding_snapshot.effective_from_ms = "not-a-time"; },
  null,
  INVALID_BINDING("$.binding_snapshot.effective_from_ms"),
));
cases.push(mk(
  "binding.invalid-effective-until",
  (r) => { r.binding_snapshot.effective_until_ms = [1]; },
  null,
  INVALID_BINDING("$.binding_snapshot.effective_until_ms"),
));

// ---- binding rule member/field/grammar failures (A05) ----
cases.push(mk(
  "binding.missing-rule-member",
  (r) => { delete r.binding_snapshot.rules[0].session_ref; },
  null,
  INVALID_BINDING("$.binding_snapshot.rules[0].session_ref"),
));
cases.push(mk(
  "binding.unknown-rule-member",
  (r) => { r.binding_snapshot.rules[0].action = "x"; },
  null,
  INVALID_BINDING("$.binding_snapshot.rules[0]"),
));
cases.push(mk(
  "binding.invalid-rule-adapter",
  (r) => { r.binding_snapshot.rules[0].adapter_id = "Bad Adapter!"; },
  null,
  INVALID_BINDING("$.binding_snapshot.rules[0].adapter_id"),
));
cases.push(mk(
  "binding.invalid-rule-principal",
  (r) => { r.binding_snapshot.rules[0].principal_ref = "bad ref"; },
  null,
  INVALID_BINDING("$.binding_snapshot.rules[0].principal_ref"),
));
cases.push(mk(
  "binding.invalid-rule-sender",
  (r) => { r.binding_snapshot.rules[0].sender = { namespace: "local", agent_id: "*" }; },
  null,
  INVALID_BINDING("$.binding_snapshot.rules[0].sender"),
));

// ---- binding duplicate key at the SECOND rule path (source-indexed) ----
cases.push(mk(
  "binding.duplicate-key-second-rule",
  (r) => {
    r.binding_snapshot.rules.push(JSON.parse(JSON.stringify(r.binding_snapshot.rules[0])));
  },
  null,
  INVALID_BINDING("$.binding_snapshot.rules[1]"),
));

// ---- context mismatch (A08): rule exists but one context member differs ----
cases.push(mk(
  "binding.context-mismatch-adapter",
  (r) => {
    // mismatch on the binding rule only; authorization rule keeps the evidence context
    r.binding_snapshot.rules[0].adapter_id = "other.adapter";
  },
  null,
  DENIED,
));
cases.push(mk(
  "binding.context-mismatch-principal",
  (r) => { r.binding_snapshot.rules[0].principal_ref = "other-principal"; },
  null,
  DENIED,
));
cases.push(mk(
  "binding.context-mismatch-audience",
  (r) => { r.binding_snapshot.rules[0].audience = "other-audience"; },
  null,
  DENIED,
));
cases.push(mk(
  "binding.context-mismatch-session",
  (r) => { r.binding_snapshot.rules[0].session_ref = "other-session"; },
  null,
  DENIED,
));

// ---- sender equality (A08): binding rule matches context but sender differs ----
cases.push(mk(
  "binding.sender-mismatch",
  (r) => {
    // binding rule matches context but its sender differs from the envelope sender
    r.binding_snapshot.rules[0].sender = { namespace: "local", agent_id: "agent-c" };
  },
  null,
  DENIED,
));

// sanity: every id unique
const ids = new Set(cases.map((c) => c.id));
if (ids.size !== cases.length) throw new Error("duplicate ids");
// NOTE: the branch HEAD corpus already contains these ids (this slice's own
// previous commit 3cf1e4d); the splice script regenerates the corpus from the
// pristine 112-case base (cd3cdc2) instead, so skip the already-present check here.

writeFileSync(new URL("/tmp/binding-new-cases.json", import.meta.url), JSON.stringify(cases, null, 2));
console.log(`wrote ${cases.length} cases -> /tmp/binding-new-cases.json`);
console.log(cases.map((c) => c.id).join("\n"));
