#!/usr/bin/env node
// Build the binding-cap-threshold-pin corpus addition: 2 new mandatory cases
// that PIN the evaluator cap (src/a2a/local-admission.ts:389, the check
// `value.rules.length > (kind === "binding" ? 256 : 2048)`) at the boundary.
//
// The existing trio `binding.rules-empty-0` / `binding.rules-256-admit` /
// `binding.rules-257-reject` proves (a) 0 admits-the-empty (actually denied
// because no rule matches) and (b) the boundary between 256 and 257. It does
// NOT prove that the boundary is exactly `> 256` rather than `> 255` or
// `> 257`. These two new cases fill the remaining boundary cells:
//   - binding.rules-255-admit: one below the admit ceiling. 255 rules
//     admit, identical to the existing 256-admit in result bytes. Proves
//     the cap is NOT `> 255`.
//   - binding.rules-258-reject: two above the admit ceiling. 258 rules
//     reject with INVALID_BINDING_SNAPSHOT at $.binding_snapshot.rules.
//     Proves the cap is NOT `> 257`.
// Together, the five-case family pins the binding cap as exactly `> 256`.
//
// Refuses to run unless the corpus is still in its 52-case pristine shape
// (the post-binding-rules-count state). Idempotent and pinned to the
// baseline sentinel /tmp/corpus-pristine-52.json so the script refuses
// loudly if the repo has drifted from train/20260820.
//
// Usage: node scripts/gen-binding-cap-threshold-pin-cases.mjs > /tmp/binding-cap-threshold-pin-new-cases.json
//        node scripts/splice-binding-cap-threshold-pin-cases.mjs /tmp/binding-cap-threshold-pin-new-cases.json
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const corpusPath = join(repoRoot, "test/fixtures/a2a/local-admission/v0.1/corpus.json");

// Pristine sentinel: extract from train/20260820 (52 cases) if not present.
const pristineSentinel = "/tmp/corpus-pristine-52.json";
if (!existsSync(pristineSentinel)) {
  execFileSync("bash", ["-c", `git -C "${repoRoot}" show train/20260820:test/fixtures/a2a/local-admission/v0.1/corpus.json > ${pristineSentinel}`]);
}
const pristine = JSON.parse(readFileSync(pristineSentinel, "utf8"));
if (pristine.cases.length !== 52) throw new Error(`pristine sentinel must be 52 cases, got ${pristine.cases.length}`);

// Locate the baseline `valid.admission-plan` case. We will copy its
// binding_snapshot + authorization_snapshot + request envelope bytes
// byte-for-byte and only mutate the binding_snapshot.rules length, so
// the result bytes for 255-admit match the valid base exactly (same
// envelope digest, same policy_basis, same request_identity).
const valid = pristine.cases.find((c) => c.id === "valid.admission-plan");
if (!valid) throw new Error(`pristine must contain valid.admission-plan`);
const validBaseDigest = valid.expected.result.envelope_digest;
const validBaseReq = JSON.parse(valid.invocation_args.request_json);

const OPAQUE_RX = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const ADAPTER_RX = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const checkAdapter = (s) => ADAPTER_RX.test(s);
const checkOpaque = (s) => OPAQUE_RX.test(s);
const checkAgentId = (s) => ADAPTER_RX.test(s);

// Build a rule identical to the baseline valid rule (matches the binding context tuple).
const baselineRule = JSON.parse(JSON.stringify(validBaseReq.binding_snapshot.rules[0]));

// Helper: build N distinct non-matching rules (each differs from baseline
// on at least one key so the dedup walker at line 416 doesn't collapse
// them). For 255-admit we need 254 non-matching rules plus the baseline
// matching rule; for 258-reject we need 257 non-matching rules plus the
// baseline. Same construction in both cases, the cap is what differs.
const buildNonMatchingRules = (n) => {
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    out.push({
      adapter_id: `pin.adapter.${i}`,
      principal_ref: `pin-principal-${i}`,
      audience: `pin-audience-${i}`,
      session_ref: `pin-session-${i}`,
      sender: { namespace: "other", agent_id: `agent-pin-${i}` },
    });
  }
  // Sanity-check all generated rules against the evaluator's per-rule
  // regexes so a future change to the regex bounds fails loudly here.
  for (const r of out) {
    if (!checkAdapter(r.adapter_id)) throw new Error(`adapter_id failed: ${r.adapter_id}`);
    if (!checkOpaque(r.principal_ref)) throw new Error(`principal_ref failed: ${r.principal_ref}`);
    if (!checkOpaque(r.audience)) throw new Error(`audience failed: ${r.audience}`);
    if (!checkOpaque(r.session_ref)) throw new Error(`session_ref failed: ${r.session_ref}`);
    if (!checkAgentId(r.sender.agent_id)) throw new Error(`agent_id failed: ${r.sender.agent_id}`);
  }
  return out;
};

const cases = [];

// 255 rules: cap-1 from the admit ceiling. Total = 1 (baseline) + 254 non-matching = 255.
// The evaluator's `value.rules.length > 256` is false, so the cap check passes,
// the dedup walker walks all 255 unique keys, then `find` returns the baseline
// matching rule at index 0. Result: identical admission_plan to the valid base.
const nonMatching254 = buildNonMatchingRules(254);
if (nonMatching254.length !== 254) throw new Error(`nonMatching254 length must be 254, got ${nonMatching254.length}`);
cases.push({
  id: "binding.rules-255-admit",
  api: "evaluate-local-admission",
  invocation_args: {
    request_json: JSON.stringify({
      ...validBaseReq,
      binding_snapshot: {
        ...validBaseReq.binding_snapshot,
        rules: [baselineRule, ...nonMatching254],
      },
    }),
    envelope_json: valid.invocation_args.envelope_json,
    replay_oracle_result: "unseen",
  },
  expected: {
    result: valid.expected.result,
    replay_oracle_calls: 1,
    replay_oracle_arguments: [{
      principal_ref: "principal-ref",
      request_id: "request-ref",
      sender: { namespace: "local", agent_id: "agent-a" },
      message_id: "message-ref",
      envelope_digest: validBaseDigest,
    }],
  },
});

// 258 rules: cap+2 from the admit ceiling (258 > 256). Total = 1 (baseline) + 257 non-matching = 258.
// The evaluator's `value.rules.length > 256` is true, so the cap check fires
// at line 389 with INVALID_BINDING_SNAPSHOT at $.binding_snapshot.rules BEFORE
// any rule walk. Result: identical to the existing 257-reject case in field_path
// and code; differs only in the literal rule count, which the family-pin test
// asserts by parsing the request_json.
const nonMatching257 = buildNonMatchingRules(257);
if (nonMatching257.length !== 257) throw new Error(`nonMatching257 length must be 257, got ${nonMatching257.length}`);
cases.push({
  id: "binding.rules-258-reject",
  api: "evaluate-local-admission",
  invocation_args: {
    request_json: JSON.stringify({
      ...validBaseReq,
      binding_snapshot: {
        ...validBaseReq.binding_snapshot,
        rules: [baselineRule, ...nonMatching257],
      },
    }),
    envelope_json: valid.invocation_args.envelope_json,
    replay_oracle_result: "unseen",
  },
  expected: {
    result: { kind: "rejected", code: "INVALID_BINDING_SNAPSHOT", field_path: "$.binding_snapshot.rules" },
    replay_oracle_calls: 0,
    replay_oracle_arguments: [],
  },
});

// Idempotency: refuse duplicates.
const newIds = cases.map((c) => c.id);
if (new Set(newIds).size !== newIds.length) throw new Error(`duplicate ids in generated cases: ${newIds.join(", ")}`);

// Emit to stdout as a JSON array (splicer reads it back).
process.stdout.write(JSON.stringify(cases, null, 2) + "\n");

// Stash for the splicer convenience if needed (matches the pattern of the
// rules-count gen/splice pair).
writeFileSync("/tmp/binding-cap-threshold-pin-new-cases.json", JSON.stringify(cases, null, 2) + "\n", "utf8");
console.error(`Generated ${cases.length} binding-cap-threshold-pin cases.`);
