#!/usr/bin/env node
// Build the binding-grammar-gaps corpus addition: 7 new mandatory cases
// (5 binding rule sender-agent-reference grammar classes, 2 source-indexed
// authorization duplicate classes) from the valid.admission-plan baseline.
// Usage: node scripts/gen-binding-grammar-cases.mjs
import { readFileSync, writeFileSync } from "node:fs";

const corpus = JSON.parse(readFileSync(new URL("../test/fixtures/a2a/local-admission/v0.1/corpus.json", import.meta.url), "utf8"));
const base = corpus.cases.find((c) => c.id === "valid.admission-plan");
if (!base) throw new Error("baseline missing");

const baseReq = JSON.parse(base.invocation_args.request_json);

const mk = (id, mutateReq, expected) => {
  const req = JSON.parse(JSON.stringify(baseReq));
  if (mutateReq) mutateReq(req);
  return {
    id,
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: JSON.stringify(req),
      envelope_json: base.invocation_args.envelope_json,
      replay_oracle_result: "unseen",
    },
    expected,
  };
};

const INVALID_BINDING = (field_path) => ({
  result: { kind: "rejected", code: "INVALID_BINDING_SNAPSHOT", field_path },
  replay_oracle_calls: 0,
  replay_oracle_arguments: [],
});
const INVALID_AUTHORIZATION = (field_path) => ({
  result: { kind: "rejected", code: "INVALID_AUTHORIZATION_SNAPSHOT", field_path },
  replay_oracle_calls: 0,
  replay_oracle_arguments: [],
});

const cases = [];

// ---- binding rule sender agent-reference grammar classes (beyond wildcard) ----
cases.push(mk(
  "binding.rule-sender-missing-namespace",
  (r) => { delete r.binding_snapshot.rules[0].sender.namespace; },
  INVALID_BINDING("$.binding_snapshot.rules[0].sender"),
));
cases.push(mk(
  "binding.rule-sender-missing-agent-id",
  (r) => { delete r.binding_snapshot.rules[0].sender.agent_id; },
  INVALID_BINDING("$.binding_snapshot.rules[0].sender"),
));
cases.push(mk(
  "binding.rule-sender-extra-member",
  (r) => { r.binding_snapshot.rules[0].sender.extra = "x"; },
  INVALID_BINDING("$.binding_snapshot.rules[0].sender"),
));
cases.push(mk(
  "binding.rule-sender-nonstring-agent-id",
  (r) => { r.binding_snapshot.rules[0].sender.agent_id = 7; },
  INVALID_BINDING("$.binding_snapshot.rules[0].sender"),
));
cases.push(mk(
  "binding.rule-sender-empty-namespace",
  (r) => { r.binding_snapshot.rules[0].sender.namespace = ""; },
  INVALID_BINDING("$.binding_snapshot.rules[0].sender"),
));

// ---- source-indexed duplicates in authorization objects ----
// duplicate authorization rule key at the SECOND rule path (rule 0 is the
// evidence-context-matching rule; rule 1 duplicates the full 5-field key incl.
// sender) -> INVALID_AUTHORIZATION_SNAPSHOT at rules[1]
cases.push(mk(
  "authorization.duplicate-key-second-rule",
  (r) => {
    const first = r.authorization_snapshot.rules[0];
    r.authorization_snapshot.rules.push(JSON.parse(JSON.stringify(first)));
  },
  INVALID_AUTHORIZATION("$.authorization_snapshot.rules[1]"),
));

// duplicate recipient within ONE authorization rule at source index 1
// (the recipient-key check is per-rule; a duplicate in a later rule is a
// different rule key and is not a duplicate class, so the in-rule pin is the
// only source-indexed recipient duplicate)
cases.push(mk(
  "authorization.duplicate-recipient-in-rule",
  (r) => {
    const rule = r.authorization_snapshot.rules[0];
    rule.recipients.push(JSON.parse(JSON.stringify(rule.recipients[0])));
  },
  INVALID_AUTHORIZATION("$.authorization_snapshot.rules[0].recipients[1]"),
));

// sanity: every id unique
const ids = new Set(cases.map((c) => c.id));
if (ids.size !== cases.length) throw new Error("duplicate ids");
// no id may already exist in the current corpus (splice asserts this too)
for (const c of cases) {
  if (corpus.cases.some((x) => x.id === c.id)) throw new Error(`id already present: ${c.id}`);
}

writeFileSync("/tmp/binding-grammar-new-cases.json", JSON.stringify(cases, null, 2));
console.log(`wrote ${cases.length} cases -> /tmp/binding-grammar-new-cases.json`);
console.log(cases.map((c) => c.id).join("\n"));
