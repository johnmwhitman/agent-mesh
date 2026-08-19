#!/usr/bin/env node
// Build the binding duplicate-source-index corpus addition: 1 new mandatory case.
// Pushes a duplicate of the baseline binding rule at rules[1] so the duplicate
// 4-tuple key (adapter_id+principal_ref+audience+session_ref) detection at
// src/a2a/local-admission.ts:413-414 rejects at the non-zero source index
// $.binding_snapshot.rules[1]. The envelope and authorization_snapshot stay
// byte-identical to valid.admission-plan.
// Usage: node scripts/gen-binding-dup-source-index-cases.mjs
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

const cases = [];

// ---- binding duplicate source index (4-tuple key duplicated at rules[1]) ----
// Push a deep clone of rules[0] as rules[1]; the source-indexed duplicate check
// in local-admission.ts:413-414 (key = adapter_id+principal_ref+audience+session_ref)
// fires on the second iteration of the seen set, returning the rejection at the
// non-zero source index path rules[1].
cases.push(mk(
  "binding.duplicate-source-index",
  (r) => {
    r.binding_snapshot.rules.push(JSON.parse(JSON.stringify(r.binding_snapshot.rules[0])));
  },
  INVALID_BINDING("$.binding_snapshot.rules[1]"),
));

// sanity: every id unique
const ids = new Set(cases.map((c) => c.id));
if (ids.size !== cases.length) throw new Error("duplicate ids");
// no id may already exist in the current corpus (splice asserts this too)
for (const c of cases) {
  if (corpus.cases.some((x) => x.id === c.id)) throw new Error(`id already present: ${c.id}`);
}

writeFileSync("/tmp/binding-dup-source-index-new-cases.json", JSON.stringify(cases, null, 2));
console.log(`wrote ${cases.length} cases -> /tmp/binding-dup-source-index-new-cases.json`);
console.log(cases.map((c) => c.id).join("\n"));
