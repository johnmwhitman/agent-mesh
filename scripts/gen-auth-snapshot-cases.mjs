#!/usr/bin/env node
/**
 * generate-auth-snapshot-cases.mjs
 *
 * Generates the Section 9 authorization-snapshot field/grammar gates (A06)
 * for evaluate-local-admission: 18 new mandatory cases appended to
 * test/fixtures/a2a/local-admission/v0.1/corpus.json.
 *
 * Base fixture: authorization.boundary.duplicate-message-type (valid rule
 * with action/message_types/recipients present; duplicate message_types is
 * the only defect, so every other member is schema-valid).
 *
 * Every case keeps a VALID binding_snapshot + evidence + envelope so the
 * authorization snapshot is the only failure source. All rejections are
 * INVALID_AUTHORIZATION_SNAPSHOT with exact source paths, 0 oracle calls.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");

const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const base = corpus.cases.find((c) => c.id === "authorization.boundary.duplicate-message-type");
if (!base) throw new Error("base case authorization.boundary.duplicate-message-type not found");
if (!corpus.mandatory_case_ids.includes(base.id)) throw new Error("base case not mandatory");

const SNAPSHOT_VERSION = "meshfleet.a2a.authorization-snapshot.v0.1";
const PROVENANCE = "caller_supplied_fixture";
const RULE = {
  adapter_id: "local.adapter",
  principal_ref: "principal-ref",
  audience: "local-audience",
  session_ref: "session-ref",
  sender: { namespace: "local", agent_id: "agent-a" },
  action: "a2a.message.admit",
  message_types: ["handoff"],
  recipients: [{ namespace: "local", agent_id: "agent-b" }],
};
const SNAPSHOT = {
  snapshot_version: SNAPSHOT_VERSION,
  snapshot_id: "authorization-fixture",
  fixture_provenance: PROVENANCE,
  effective_from_ms: 0,
  effective_until_ms: 200,
  rules: [RULE],
};
const ENVELOPE = JSON.parse(base.invocation_args.envelope_json);
const REQUEST_FRAME = (() => {
  const rj = JSON.parse(base.invocation_args.request_json);
  delete rj.authorization_snapshot;
  return rj;
})();

const REJECT = (code, field_path) => ({
  result: { kind: "rejected", code, field_path },
  replay_oracle_calls: 0,
  replay_oracle_arguments: [],
});

function requestWith(snapshot) {
  return JSON.stringify({ ...REQUEST_FRAME, authorization_snapshot: snapshot });
}

const cases = [];

function add(id, mutate, expected) {
  const snapshot = JSON.parse(JSON.stringify(SNAPSHOT));
  mutate(snapshot);
  cases.push({
    id,
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: requestWith(snapshot),
      envelope_json: JSON.stringify(ENVELOPE),
      replay_oracle_result: "unseen",
    },
    expected,
  });
}

// --- snapshot root members (A06) ---
add("authorization.snapshot-version-invalid", (s) => { s.snapshot_version = "meshfleet.a2a.authorization-snapshot.v0.2"; },
  REJECT("INVALID_AUTHORIZATION_SNAPSHOT", "$.authorization_snapshot.snapshot_version"));
add("authorization.snapshot-id-invalid", (s) => { s.snapshot_id = "authorization fixture!"; },
  REJECT("INVALID_AUTHORIZATION_SNAPSHOT", "$.authorization_snapshot.snapshot_id"));
add("authorization.snapshot-provenance-invalid", (s) => { s.fixture_provenance = "admin_authority_fixture"; },
  REJECT("INVALID_AUTHORIZATION_SNAPSHOT", "$.authorization_snapshot.fixture_provenance"));
add("authorization.snapshot-from-invalid", (s) => { s.effective_from_ms = -1; },
  REJECT("MALFORMED_JSON", "$.authorization_snapshot.effective_from_ms"));
add("authorization.snapshot-from-fractional", (s) => { s.effective_from_ms = 0.5; },
  REJECT("MALFORMED_JSON", "$.authorization_snapshot.effective_from_ms"));
add("authorization.snapshot-from-unsafe", (s) => { s.effective_from_ms = 9007199254740992; },
  REJECT("MALFORMED_JSON", "$.authorization_snapshot.effective_from_ms"));
add("authorization.snapshot-until-invalid", (s) => { s.effective_until_ms = "200"; },
  REJECT("INVALID_AUTHORIZATION_SNAPSHOT", "$.authorization_snapshot.effective_until_ms"));
add("authorization.snapshot-until-inverted", (s) => { s.effective_from_ms = 300; s.effective_until_ms = 200; },
  REJECT("AUTHORIZATION_DENIED", "$"));
add("authorization.snapshot-unknown-member", (s) => { s.rotation_policy = "weekly"; },
  REJECT("INVALID_AUTHORIZATION_SNAPSHOT", "$.authorization_snapshot"));
add("authorization.snapshot-rules-not-array", (s) => { s.rules = {}; },
  REJECT("INVALID_AUTHORIZATION_SNAPSHOT", "$.authorization_snapshot.rules"));

// --- rule member paths (A06) ---
add("authorization.rule-adapter-invalid", (s) => { s.rules[0].adapter_id = "LOCAL.ADAPTER"; },
  REJECT("INVALID_AUTHORIZATION_SNAPSHOT", "$.authorization_snapshot.rules[0].adapter_id"));
add("authorization.rule-principal-invalid", (s) => { s.rules[0].principal_ref = "principal ref"; },
  REJECT("INVALID_AUTHORIZATION_SNAPSHOT", "$.authorization_snapshot.rules[0].principal_ref"));
add("authorization.rule-audience-invalid", (s) => { s.rules[0].audience = ""; },
  REJECT("INVALID_AUTHORIZATION_SNAPSHOT", "$.authorization_snapshot.rules[0].audience"));
add("authorization.rule-session-invalid", (s) => { s.rules[0].session_ref = ""; },
  REJECT("INVALID_AUTHORIZATION_SNAPSHOT", "$.authorization_snapshot.rules[0].session_ref"));
add("authorization.rule-sender-invalid", (s) => { s.rules[0].sender = { namespace: "local", agent_id: "*" }; },
  REJECT("INVALID_AUTHORIZATION_SNAPSHOT", "$.authorization_snapshot.rules[0].sender"));
add("authorization.rule-sender-unknown-member", (s) => { s.rules[0].sender = { namespace: "local", agent_id: "agent-a", role: "admin" }; },
  REJECT("INVALID_AUTHORIZATION_SNAPSHOT", "$.authorization_snapshot.rules[0].sender"));
add("authorization.rule-unknown-member", (s) => { s.rules[0].priority = 1; },
  REJECT("INVALID_AUTHORIZATION_SNAPSHOT", "$.authorization_snapshot.rules[0]"));
add("authorization.rule-missing-action", (s) => { delete s.rules[0].action; },
  REJECT("INVALID_AUTHORIZATION_SNAPSHOT", "$.authorization_snapshot.rules[0].action"));

// --- splice into corpus, semantic-order preserving (existing ids first, new ids after) ---
const existingIds = new Set(corpus.mandatory_case_ids);
const fresh = cases.filter((c) => !existingIds.has(c.id));
if (fresh.length !== cases.length) {
  const dups = cases.filter((c) => existingIds.has(c.id)).map((c) => c.id);
  throw new Error(`collision with existing ids: ${dups.join(", ")}`);
}

// append new cases at the end, keeping relative order of existing cases intact
corpus.cases.push(...fresh);
corpus.mandatory_case_ids.push(...fresh.map((c) => c.id));

writeFileSync(corpusPath, JSON.stringify(corpus) + "\n", "utf8");
console.log(`appended ${fresh.length} cases; corpus now ${corpus.cases.length} mandatory`);
for (const c of fresh) console.log(`  ${c.id} -> ${c.expected.result.code} ${c.expected.result.field_path}`);
