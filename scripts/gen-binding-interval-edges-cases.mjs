#!/usr/bin/env node
// Build the binding-interval-edges corpus addition: 6 new mandatory cases pinning
// the binding/authorization interval equality boundaries at src/a2a/local-admission.ts:530-542:
//
// For each of binding_snapshot and authorization_snapshot:
//   - zero-length interval  (effective_from_ms == effective_until_ms) -> AUTHORIZATION_DENIED at $
//   - from-edge             (evaluation_time_ms == effective_from_ms)  -> admit (the `<` check is strict)
//   - until-edge            (evaluation_time_ms == effective_until_ms) -> AUTHORIZATION_DENIED at $ (the `>=` check is non-strict)
//
// The valid fixture uses evaluation_time_ms=100, evidence=(0,200), binding=(0,200), authorization=(0,200).
// Each case mutates exactly one snapshot's interval (or evaluation_time), keeps the rest byte-identical.
//
// Usage: node scripts/gen-binding-interval-edges-cases.mjs > /tmp/binding-interval-edges-new-cases.json
import { readFileSync, existsSync } from "node:fs";

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

const DENIED = {
  result: { kind: "rejected", code: "AUTHORIZATION_DENIED", field_path: "$" },
  replay_oracle_calls: 0,
  replay_oracle_arguments: [],
};

// Expected admission_plan mirrors the baseline; same 4A digest (binding/authorization snapshots
// are still well-formed and have an applicable rule) and the same replay_oracle_arguments.
// The policy_basis reflects the *post-mutation* snapshot intervals (since the caller asked for
// these intervals), so the helper builds a custom expected from the mutated request.
const ADMIT_FOR = (mutateReq) => {
  const req = JSON.parse(JSON.stringify(baseReq));
  mutateReq(req);
  const plan = {
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
    policy_basis: {
      binding_snapshot: {
        snapshot_version: "meshfleet.a2a.binding-snapshot.v0.1",
        snapshot_id: "binding-fixture",
        effective_from_ms: req.binding_snapshot.effective_from_ms,
        effective_until_ms: req.binding_snapshot.effective_until_ms,
      },
      authorization_snapshot: {
        snapshot_version: "meshfleet.a2a.authorization-snapshot.v0.1",
        snapshot_id: "authorization-fixture",
        effective_from_ms: req.authorization_snapshot.effective_from_ms,
        effective_until_ms: req.authorization_snapshot.effective_until_ms,
      },
    },
  };
  return {
    result: plan,
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

// === binding_snapshot interval edges ===

// 1. binding zero-length: from = until = 100 (eval_time = 100) -> AUTHORIZATION_DENIED
//    The `binding.effective_from_ms >= binding.effective_until_ms` check (line 534) triggers at equality.
cases.push(mk(
  "binding.interval-zero-length",
  (r) => { r.binding_snapshot.effective_from_ms = 100; r.binding_snapshot.effective_until_ms = 100; },
  null,
  DENIED,
  "binding_snapshot.effective_from_ms == effective_until_ms == 100; the `from >= until` boundary at equality denies",
));

// 3. binding until-edge: from=0, until=100, eval_time=100 -> AUTHORIZATION_DENIED
//    The `evaluationTime >= binding.effective_until_ms` check (line 537) triggers at equality.
cases.push(mk(
  "binding.interval-until-edge",
  (r) => { r.binding_snapshot.effective_from_ms = 0; r.binding_snapshot.effective_until_ms = 100; },
  null,
  DENIED,
  "evaluation_time_ms (100) == binding.effective_until_ms (100); the `>=` boundary at equality denies",
));

// 2. binding from-edge: from=100, until=200, eval_time=100 -> admit
//    The `evaluationTime < binding.effective_from_ms` check (line 536) is FALSE at equality (`<` is strict).
//    The `evaluationTime >= binding.effective_until_ms` check (line 537) is FALSE (100 < 200).
//    Evidence interval (0, 200) is satisfied (0 <= 100 < 200).
//    Authorization snapshot (0, 200) is satisfied (0 <= 100 < 200). The applicable rule matches.
cases.push(mk(
  "binding.interval-from-edge",
  (r) => { r.binding_snapshot.effective_from_ms = 100; r.binding_snapshot.effective_until_ms = 200; },
  null,
  ADMIT_FOR((r) => { r.binding_snapshot.effective_from_ms = 100; r.binding_snapshot.effective_until_ms = 200; }),
  "evaluation_time_ms (100) == binding.effective_from_ms (100); the `<` boundary at equality admits (strict `<`); evidence (0,200) and authorization (0,200) both satisfied",
));

// === authorization_snapshot interval edges ===

// 4. authorization zero-length: from = until = 100 -> AUTHORIZATION_DENIED
//    The `authorization.effective_from_ms >= authorization.effective_until_ms` check (line 535) triggers at equality.
cases.push(mk(
  "authorization.interval-zero-length",
  (r) => { r.authorization_snapshot.effective_from_ms = 100; r.authorization_snapshot.effective_until_ms = 100; },
  null,
  DENIED,
  "authorization_snapshot.effective_from_ms == effective_until_ms == 100; the `from >= until` boundary at equality denies",
));

// 6. authorization until-edge: from=0, until=100, eval_time=100 -> AUTHORIZATION_DENIED
//    The `evaluationTime >= authorization.effective_until_ms` check (line 539) triggers at equality.
cases.push(mk(
  "authorization.interval-until-edge",
  (r) => { r.authorization_snapshot.effective_from_ms = 0; r.authorization_snapshot.effective_until_ms = 100; },
  null,
  DENIED,
  "evaluation_time_ms (100) == authorization.effective_until_ms (100); the `>=` boundary at equality denies",
));

// 5. authorization from-edge: from=100, until=200, eval_time=100 -> admit
//    The `evaluationTime < authorization.effective_from_ms` check (line 538) is FALSE at equality (`<` is strict).
//    The `evaluationTime >= authorization.effective_until_ms` check (line 539) is FALSE (100 < 200).
//    Evidence (0, 200) and binding (0, 200) are satisfied. The applicable rule matches.
cases.push(mk(
  "authorization.interval-from-edge",
  (r) => { r.authorization_snapshot.effective_from_ms = 100; r.authorization_snapshot.effective_until_ms = 200; },
  null,
  ADMIT_FOR((r) => { r.authorization_snapshot.effective_from_ms = 100; r.authorization_snapshot.effective_until_ms = 200; }),
  "evaluation_time_ms (100) == authorization.effective_from_ms (100); the `<` boundary at equality admits (strict `<`); evidence (0,200) and binding (0,200) both satisfied",
));

console.log(JSON.stringify(cases, null, 2));