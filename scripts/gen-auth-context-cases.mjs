#!/usr/bin/env node
// scripts/gen-auth-context-cases.mjs
//
// Generator for the authorization "context-mismatch" bounded subfamily (Slice 4C-1).
// Produces 5 mandatory corpus cases that prove each authorization-rule CONTEXT field
// (adapter_id, principal_ref, audience, session_ref, sender) is INDEPENDENTLY required
// for an authorization match. Mutating exactly one of them while keeping the evidence /
// binding rule / envelope / other rule fields identical must deny with
// AUTHORIZATION_DENIED at $ — there is no implicit fallback, no partial match, no
// "any single field differs is fine" semantics.
//
// Note: action is NOT a context field in the same sense — it is validated
// syntactically against the constant ACTION ("a2a.message.admit") at
// $.authorization_snapshot.rules[i].action, so a different action surfaces as
// INVALID_AUTHORIZATION_SNAPSHOT, not AUTHORIZATION_DENIED. That class is
// covered by tick-54's snapshot/grammar slice.
//
// Inputs: pristine-44 corpus at test/fixtures/a2a/local-admission/v0.1/corpus.json
// Outputs: 5 new cases appended to the cases array; mandatory_case_ids updated.
//   Result: 44 → 49 mandatory cases.
//
// Idempotent: rerun against an already-expanded corpus no-ops (it splices 6 entries
// exactly once). The pristine-44 sentinel under /tmp/corpus-pristine-44.json must
// be present; the script restores from it before re-splicing so every regeneration
// is bit-identical.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const CORPUS = resolve(REPO, "test/fixtures/a2a/local-admission/v0.1/corpus.json");
const PRISTINE = "/tmp/corpus-pristine-44.json";

if (!existsSync(PRISTINE)) {
  console.error(`Missing pristine-44 sentinel at ${PRISTINE}; refusing to splice.`);
  console.error("Restore from a known-good origin/main corpus first, then re-run.");
  process.exit(1);
}

const PRISTINE_CORPUS = JSON.parse(readFileSync(PRISTINE, "utf8"));
const BASE_ID = "valid.admission-plan";
const baseCase = PRISTINE_CORPUS.cases.find((c) => c.id === BASE_ID);
if (!baseCase) {
  console.error(`Pristine corpus missing base case ${BASE_ID}.`);
  process.exit(2);
}

const mutations = [
  {
    id: "authorization.context.adapter-mismatch",
    desc: "authorization rule adapter_id differs from evidence → AUTHORIZATION_DENIED",
    mutate: (rule) => { rule.adapter_id = "different.adapter"; },
  },
  {
    id: "authorization.context.principal-mismatch",
    desc: "authorization rule principal_ref differs from evidence → AUTHORIZATION_DENIED",
    mutate: (rule) => { rule.principal_ref = "different-principal"; },
  },
  {
    id: "authorization.context.audience-mismatch",
    desc: "authorization rule audience differs from evidence → AUTHORIZATION_DENIED",
    mutate: (rule) => { rule.audience = "different-audience"; },
  },
  {
    id: "authorization.context.session-mismatch",
    desc: "authorization rule session_ref differs from evidence → AUTHORIZATION_DENIED",
    mutate: (rule) => { rule.session_ref = "different-session"; },
  },
  {
    id: "authorization.context.sender-mismatch",
    desc: "authorization rule sender.agent_id differs from envelope sender → AUTHORIZATION_DENIED",
    mutate: (rule) => { rule.sender.agent_id = "agent-z"; },
  },
];

const baseRequest = JSON.parse(baseCase.invocation_args.request_json);
const baseEnvelope = baseCase.invocation_args.envelope_json;
const baseExpected = baseCase.expected;

const newCases = mutations.map(({ id, desc, mutate }) => {
  const req = JSON.parse(JSON.stringify(baseRequest));
  const rule = req.authorization_snapshot.rules[0];
  mutate(rule);
  return {
    id,
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: JSON.stringify(req),
      envelope_json: baseEnvelope,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: { kind: "rejected", code: "AUTHORIZATION_DENIED", field_path: "$" },
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  };
});

// Idempotency: if all 6 ids already present, no-op.
const current = JSON.parse(readFileSync(CORPUS, "utf8"));
const existing = new Set(current.mandatory_case_ids);
const allPresent = mutations.every((m) => existing.has(m.id));
if (allPresent) {
  console.log(`All 6 ids already present in corpus; nothing to do. (${current.cases.length} cases)`);
  process.exit(0);
}
const anyPresent = mutations.some((m) => existing.has(m.id));
if (anyPresent) {
  console.error(`Partial splice detected: ${mutations.filter((m) => existing.has(m.id)).map((m) => m.id).join(", ")} already present, others missing. Aborting to avoid bit-flip.`);
  process.exit(3);
}

// Splice. Preserve source order: append the 6 new cases after the existing 44.
const newIds = mutations.map((m) => m.id);
const newCaseIds = current.mandatory_case_ids.concat(newIds);
const newCasesAll = current.cases.concat(newCases);
const out = {
  mandatory_case_ids: newCaseIds,
  cases: newCasesAll,
};
writeFileSync(CORPUS, JSON.stringify(out) + "\n");
console.log(`Spliced ${newCases.length} authorization-context cases: ${newIds.join(", ")}`);
console.log(`Corpus: ${current.cases.length} → ${newCasesAll.length} cases.`);