#!/usr/bin/env node
// Build the relativity corpus addition: 8 new mandatory cases pinning that
// changed fixture values cause the expected decision changes at
// src/a2a/local-admission.ts:384-386 (snapshot_version / snapshot_id /
// fixture_provenance validity), and that a like-for-like fixture rename keeps
// the decision while the policy_basis reports the new fixture identity.
//
// For each of binding_snapshot and authorization_snapshot:
//   1. snapshot_version changed to a non-matching string
//        -> INVALID_*_SNAPSHOT at $.binding_snapshot.snapshot_version /
//           $.authorization_snapshot.snapshot_version
//   2. fixture_provenance changed to anything other than "caller_supplied_fixture"
//        -> INVALID_*_SNAPSHOT at $.binding_snapshot.fixture_provenance /
//           $.authorization_snapshot.fixture_provenance
//   3. snapshot_id changed to an invalid opaque-ref (leading-punct)
//        -> INVALID_*_SNAPSHOT at $.binding_snapshot.snapshot_id /
//           $.authorization_snapshot.snapshot_id
//   4. snapshot_id changed to a different VALID opaque-ref
//        -> admission_plan with policy_basis mirrors the renamed snapshot_id
//           (proves the plan reflects the new fixture identity; no spurious
//            decision flip)
//
// The valid baseline uses evaluation_time_ms=100, evidence=(0,200), binding=(0,200),
// authorization=(0,200). Each case mutates exactly one snapshot field, keeps the
// rest byte-identical.
//
// Usage: node scripts/gen-relativity-cases.mjs > /tmp/relativity-new-cases.json
import { readFileSync, existsSync } from "node:fs";

const corpusPath = new URL("../test/fixtures/a2a/local-admission/v0.1/corpus.json", import.meta.url);
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const base = corpus.cases.find((c) => c.id === "valid.admission-plan");
if (!base) throw new Error("baseline valid.admission-plan missing");

// pristine-50 sentinel (the f37c01e base has 50 cases from interval-edges; this
// script is idempotent and refuses partial splicing so we never accidentally
// half-splice a count).
const pristineSentinel = "/tmp/corpus-pristine-50.json";
if (!existsSync(pristineSentinel)) {
  const repoRoot = new URL("..", import.meta.url).pathname;
  const { execFileSync } = await import("node:child_process");
  execFileSync("bash", ["-c", `git -C "${repoRoot}" show f37c01e:test/fixtures/a2a/local-admission/v0.1/corpus.json > ${pristineSentinel}`]);
}
const pristine = JSON.parse(readFileSync(pristineSentinel, "utf8"));
if (pristine.cases.length !== 50) throw new Error(`pristine sentinel must be 50 cases, got ${pristine.cases.length}`);

const baseReq = JSON.parse(base.invocation_args.request_json);
const baseEnv = JSON.parse(base.invocation_args.envelope_json);
const basePlan = base.expected.result;
if (basePlan.kind !== "admission_plan") throw new Error(`baseline must be admission_plan, got ${basePlan.kind}`);
const baseDigest = basePlan.envelope_digest;

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

const INVALID_BINDING = (fieldPath) => ({
  result: { kind: "rejected", code: "INVALID_BINDING_SNAPSHOT", field_path: fieldPath },
  replay_oracle_calls: 0,
  replay_oracle_arguments: [],
});
const INVALID_AUTHORIZATION = (fieldPath) => ({
  result: { kind: "rejected", code: "INVALID_AUTHORIZATION_SNAPSHOT", field_path: fieldPath },
  replay_oracle_calls: 0,
  replay_oracle_arguments: [],
});

// ADMIT_FOR returns the admission_plan whose policy_basis mirrors the mutated
// snapshot identity; the 4A digest and replay_oracle_arguments stay byte-identical
// to the valid baseline (envelope is unchanged).
const ADMIT_FOR = (kind, mutateReq) => {
  const req = JSON.parse(JSON.stringify(baseReq));
  mutateReq(req);
  const policyBasis = {
    binding_snapshot: {
      snapshot_version: req.binding_snapshot.snapshot_version,
      snapshot_id: req.binding_snapshot.snapshot_id,
      effective_from_ms: req.binding_snapshot.effective_from_ms,
      effective_until_ms: req.binding_snapshot.effective_until_ms,
    },
    authorization_snapshot: {
      snapshot_version: req.authorization_snapshot.snapshot_version,
      snapshot_id: req.authorization_snapshot.snapshot_id,
      effective_from_ms: req.authorization_snapshot.effective_from_ms,
      effective_until_ms: req.authorization_snapshot.effective_until_ms,
    },
  };
  return {
    result: {
      kind: "admission_plan",
      version: "meshfleet.a2a.local-admission.v0.1",
      request_identity: { principal_ref: "principal-ref", request_id: "request-ref" },
      semantic_identity: {
        sender: { namespace: "local", agent_id: "agent-a" },
        message_id: "message-ref",
      },
      action: "a2a.message.admit",
      audience: "local-audience",
      message_type: "handoff",
      recipients: [{ namespace: "local", agent_id: "agent-b" }],
      envelope_digest: baseDigest,
      evaluation_time_ms: 100,
      policy_basis: policyBasis,
    },
    replay_oracle_calls: 1,
    replay_oracle_arguments: [
      {
        principal_ref: "principal-ref",
        request_id: "request-ref",
        sender: { namespace: "local", agent_id: "agent-a" },
        message_id: "message-ref",
        envelope_digest: baseDigest,
      },
    ],
  };
};

const cases = [];

// 1. binding.snapshot_version changed to a non-matching string -> INVALID
cases.push(mk(
  "relativity.binding.snapshot-version-invalid",
  (req) => { req.binding_snapshot.snapshot_version = "meshfleet.a2a.binding-snapshot.v9.9"; },
  null,
  INVALID_BINDING("$.binding_snapshot.snapshot_version"),
  "binding fixture: snapshot_version differs from BINDING_VERSION constant",
));

// 2. binding.fixture_provenance changed to anything else -> INVALID
cases.push(mk(
  "relativity.binding.fixture-provenance-invalid",
  (req) => { req.binding_snapshot.fixture_provenance = "operator_supplied_fixture"; },
  null,
  INVALID_BINDING("$.binding_snapshot.fixture_provenance"),
  "binding fixture: fixture_provenance differs from FIXTURE_PROVENANCE constant",
));

// 3. binding.snapshot_id changed to an invalid opaque-ref (leading-punct) -> INVALID
cases.push(mk(
  "relativity.binding.snapshot-id-invalid-opaque",
  (req) => { req.binding_snapshot.snapshot_id = "-binding-fixture"; },
  null,
  INVALID_BINDING("$.binding_snapshot.snapshot_id"),
  "binding fixture: snapshot_id fails the opaque-ref grammar (leading dash)",
));

// 4. binding.snapshot_id renamed to a different VALID opaque-ref -> admit, plan mirrors new id
cases.push(mk(
  "relativity.binding.snapshot-id-renamed-valid",
  (req) => { req.binding_snapshot.snapshot_id = "binding-fixture-2"; },
  null,
  ADMIT_FOR("binding", (req) => { req.binding_snapshot.snapshot_id = "binding-fixture-2"; }),
  "binding fixture: snapshot_id renamed to a different valid opaque-ref; plan reports the new id in policy_basis",
));

// 5. authorization.snapshot_version changed -> INVALID
cases.push(mk(
  "relativity.authorization.snapshot-version-invalid",
  (req) => { req.authorization_snapshot.snapshot_version = "meshfleet.a2a.authorization-snapshot.v9.9"; },
  null,
  INVALID_AUTHORIZATION("$.authorization_snapshot.snapshot_version"),
  "authorization fixture: snapshot_version differs from AUTHORIZATION_VERSION constant",
));

// 6. authorization.fixture_provenance changed -> INVALID
cases.push(mk(
  "relativity.authorization.fixture-provenance-invalid",
  (req) => { req.authorization_snapshot.fixture_provenance = "operator_supplied_fixture"; },
  null,
  INVALID_AUTHORIZATION("$.authorization_snapshot.fixture_provenance"),
  "authorization fixture: fixture_provenance differs from FIXTURE_PROVENANCE constant",
));

// 7. authorization.snapshot_id changed to an invalid opaque-ref -> INVALID
cases.push(mk(
  "relativity.authorization.snapshot-id-invalid-opaque",
  (req) => { req.authorization_snapshot.snapshot_id = "-authorization-fixture"; },
  null,
  INVALID_AUTHORIZATION("$.authorization_snapshot.snapshot_id"),
  "authorization fixture: snapshot_id fails the opaque-ref grammar (leading dash)",
));

// 8. authorization.snapshot_id renamed to a different VALID opaque-ref -> admit, plan mirrors new id
cases.push(mk(
  "relativity.authorization.snapshot-id-renamed-valid",
  (req) => { req.authorization_snapshot.snapshot_id = "authorization-fixture-2"; },
  null,
  ADMIT_FOR("authorization", (req) => { req.authorization_snapshot.snapshot_id = "authorization-fixture-2"; }),
  "authorization fixture: snapshot_id renamed to a different valid opaque-ref; plan reports the new id in policy_basis",
));

console.log(JSON.stringify(cases, null, 2));