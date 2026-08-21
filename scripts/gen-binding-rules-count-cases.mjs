#!/usr/bin/env node
/**
 * gen-binding-rules-count-cases.mjs
 *
 * Tick-158 refactor: rebuild the binding rule-count corpus on top of the
 * in-repo pristine sentinel (`test/fixtures/a2a/local-admission/v0.1/
 * corpus.json.pristine-49`).
 *
 * Three new mandatory cases pin the binding rule-count boundary
 * (src/a2a/local-admission.ts:389):
 *   - 0 rules   -> AUTHORIZATION_DENIED at $ (no rule matches, line 551)
 *   - 256 rules -> admission_plan with the unchanged 4A digest
 *   - 257 rules -> INVALID_BINDING_SNAPSHOT at $.binding_snapshot.rules
 *
 * Pure-node-fs design mirroring the 984465e (auth-snapshot) writer pattern:
 *   - reads the in-repo pristine-49 fixture as the integrity baseline
 *   - appends the three new cases to `corpus.json`
 *   - refuses to partial-splice / re-run (if the corpus is already 52 or
 *     longer, abort with a precise count + id diff)
 * No `/tmp` sentinel, no `bash -c`, no `git show origin/main:...`.
 * Run from `scripts/splice-binding-rules-count-cases.mjs` (which makes the
 * pristine-49 backup of the current corpus first and then `await import()`s
 * this script).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const pristinePath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json.pristine-49");

const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const pristine = JSON.parse(readFileSync(pristinePath, "utf8"));

// Integrity: pristine must be exactly the 49-case origin/main state.
if (pristine.cases.length !== 49) {
  throw new Error(`pristine sentinel must be 49 cases, got ${pristine.cases.length}`);
}

// Integrity: current corpus must still BE the pristine 49-case state.
// If it's already spliced (52) or drifted, refuse loudly — never partial-splice.
if (corpus.cases.length !== pristine.cases.length) {
  throw new Error(
    `corpus already spliced or drifted: cases=${corpus.cases.length}, pristine=${pristine.cases.length} ` +
      `(this writer is single-shot; re-running on a 49-case baseline only)`,
  );
}
if (corpus.mandatory_case_ids.length !== pristine.mandatory_case_ids.length) {
  throw new Error(
    `mandatory_case_ids drift: corpus=${corpus.mandatory_case_ids.length}, pristine=${pristine.mandatory_case_ids.length}`,
  );
}
for (let i = 0; i < pristine.cases.length; i += 1) {
  if (corpus.cases[i].id !== pristine.cases[i].id) {
    throw new Error(
      `case[${i}].id drift: corpus="${corpus.cases[i].id}", pristine="${pristine.cases[i].id}"`,
    );
  }
}

const base = corpus.cases.find((c) => c.id === "valid.admission-plan");
if (!base) throw new Error("baseline valid.admission-plan missing");

const baseReq = JSON.parse(base.invocation_args.request_json);
const baseEnv = JSON.parse(base.invocation_args.envelope_json);
const basePlan = base.expected.result;

const mk = (id, mutateReq, mutateEnv, expected) => {
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

// ---- 0 rules: empty binding rule list ----
// No rule matches -> AUTHORIZATION_DENIED at $ (local-admission.ts:551).
// The binding snapshot itself is otherwise valid (members, version, id, provenance, interval).
cases.push(mk(
  "binding.rules-empty-0",
  (r) => { r.binding_snapshot.rules = []; },
  null,
  DENIED,
));

// ---- 256 rules: max valid count ----
// Keep the original matching rule at index 0; add 255 rules with unique
// (adapter_id, principal_ref, audience, session_ref) keys so dedup passes
// (line 416). Each new rule uses a distinct lowercase adapter_id, distinct
// opaque-refs, and a distinct localRef sender.
const ADAPTER_RX = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const OPAQUE_RX = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const checkAdapter = (s) => ADAPTER_RX.test(s);
const checkOpaque = (s) => OPAQUE_RX.test(s);
for (let i = 1; i <= 255; i += 1) {
  const adapter_id = `extra.adapter.${i}`;
  const principal_ref = `extra-principal-${i}`;
  const audience = `extra-audience-${i}`;
  const session_ref = `extra-session-${i}`;
  const sender = { namespace: "other", agent_id: `agent-other-${i}` };
  if (!checkAdapter(adapter_id)) throw new Error(`bad adapter ${adapter_id}`);
  if (!checkOpaque(principal_ref)) throw new Error(`bad principal ${principal_ref}`);
  if (!checkOpaque(audience)) throw new Error(`bad audience ${audience}`);
  if (!checkOpaque(session_ref)) throw new Error(`bad session_ref ${session_ref}`);
  if (sender.namespace.length === 0) throw new Error(`bad sender ${sender.agent_id}`);
}
const newRules = [];
for (let i = 1; i <= 255; i += 1) {
  newRules.push({
    adapter_id: `extra.adapter.${i}`,
    principal_ref: `extra-principal-${i}`,
    audience: `extra-audience-${i}`,
    session_ref: `extra-session-${i}`,
    sender: { namespace: "other", agent_id: `agent-other-${i}` },
  });
}
cases.push(mk(
  "binding.rules-256-admit",
  (r) => { r.binding_snapshot.rules = [...r.binding_snapshot.rules, ...newRules]; },
  null,
  // unchanged 4A digest -> admission_plan with the same expected plan as the valid base
  {
    result: basePlan,
    replay_oracle_calls: 1,
    replay_oracle_arguments: [{
      principal_ref: "principal-ref",
      request_id: "request-ref",
      sender: { namespace: "local", agent_id: "agent-a" },
      message_id: "message-ref",
      envelope_digest: basePlan.envelope_digest,
    }],
  },
));

// ---- 257 rules: one beyond the cap ----
// Same construction as the 256-admit case plus one extra rule. The check at
// line 389 is value.rules.length > 256, so 257 rejects with INVALID_BINDING_SNAPSHOT
// at $.binding_snapshot.rules.
const extra257Rules = [...newRules, {
  adapter_id: "extra.adapter.256",
  principal_ref: "extra-principal-256",
  audience: "extra-audience-256",
  session_ref: "extra-session-256",
  sender: { namespace: "other", agent_id: "agent-other-256" },
}];
if (extra257Rules.length !== 256) throw new Error(`extra257Rules length must be 256, got ${extra257Rules.length}`);
cases.push(mk(
  "binding.rules-257-reject",
  (r) => { r.binding_snapshot.rules = [...r.binding_snapshot.rules, ...extra257Rules]; },
  null,
  INVALID_BINDING("$.binding_snapshot.rules"),
));

// Refuse partial splice: every id in `cases` must be unique AND not already present.
const existingIds = new Set(corpus.cases.map((c) => c.id));
const existingMandatory = new Set(corpus.mandatory_case_ids);
for (const c of cases) {
  if (existingIds.has(c.id)) throw new Error(`dup id ${c.id} already in corpus`);
  if (existingMandatory.has(c.id)) throw new Error(`dup id ${c.id} already in mandatory_case_ids`);
}

// Splice: append in the same order as the generator emitted them.
const newIds = cases.map((c) => c.id);
corpus.cases = [...corpus.cases, ...cases];
corpus.mandatory_case_ids = [...corpus.mandatory_case_ids, ...newIds];

writeFileSync(corpusPath, `${JSON.stringify(corpus)}\n`, "utf8");
console.log(`Spliced ${newIds.length} binding-rules-count cases (corpus ${pristine.cases.length} -> ${corpus.cases.length}).`);
