#!/usr/bin/env node
// Build the binding-rules-count corpus addition: 3 new mandatory cases pinning
// the binding rule-count boundary (lines src/a2a/local-admission.ts:389):
//   - 0 rules -> AUTHORIZATION_DENIED at $ (no rule matches, line 551)
//   - 256 rules (max valid) -> admission_plan with the unchanged 4A digest
//   - 257 rules -> INVALID_BINDING_SNAPSHOT at $.binding_snapshot.rules
// Usage: node scripts/gen-binding-rules-count-cases.mjs > /tmp/binding-rules-count-new-cases.json
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const corpusPath = new URL("../test/fixtures/a2a/local-admission/v0.1/corpus.json", import.meta.url);
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const base = corpus.cases.find((c) => c.id === "valid.admission-plan");
if (!base) throw new Error("baseline valid.admission-plan missing");

// pristine-44 sentinel (other lane generators also use it; this script is idempotent
// and refuses partial splicing so we never accidentally half-splice a count).
const pristineSentinel = "/tmp/corpus-pristine-44.json";
if (!existsSync(pristineSentinel)) {
  const repoRoot = new URL("..", import.meta.url).pathname;
  const { execFileSync } = await import("node:child_process");
  execFileSync("bash", ["-c", `git -C "${repoRoot}" show c571928:test/fixtures/a2a/local-admission/v0.1/corpus.json > ${pristineSentinel}`]);
}
const pristine = JSON.parse(readFileSync(pristineSentinel, "utf8"));
if (pristine.cases.length !== 44) throw new Error(`pristine sentinel must be 44 cases, got ${pristine.cases.length}`);

const baseReq = JSON.parse(base.invocation_args.request_json);
const baseEnv = JSON.parse(base.invocation_args.envelope_json);
const basePlan = base.expected.result;

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

// ---- 0 rules: empty binding rule list ----
// No rule matches -> AUTHORIZATION_DENIED at $ (local-admission.ts:551).
// The binding snapshot itself is otherwise valid (members, version, id, provenance, interval).
cases.push(mk(
  "binding.rules-empty-0",
  (r) => { r.binding_snapshot.rules = []; },
  null,
  DENIED,
  "0 binding rules; no rule matches the (adapter_id, principal_ref, audience, session_ref) tuple -> AUTHORIZATION_DENIED@$",
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
  "256 binding rules (max valid); original matching rule at index 0 plus 255 unique non-matching rules; find returns the matching rule -> admission_plan with unchanged 4A digest",
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
  "257 binding rules (cap exceeded); line 389 length check rejects with INVALID_BINDING_SNAPSHOT at $.binding_snapshot.rules",
));

// Refuse partial splice: every id in `cases` must be unique AND not already present.
const existingIds = new Set(corpus.cases.map((c) => c.id));
const existingMandatory = new Set(corpus.mandatory_case_ids);
for (const c of cases) {
  if (existingIds.has(c.id)) throw new Error(`dup id ${c.id} already in corpus`);
  if (existingMandatory.has(c.id)) throw new Error(`dup id ${c.id} already in mandatory_case_ids`);
}

// stdout: the new cases array (idempotent re-run produces same output as long as
// the corpus still starts from the 44-case base)
process.stdout.write(JSON.stringify(cases, null, 2) + "\n");