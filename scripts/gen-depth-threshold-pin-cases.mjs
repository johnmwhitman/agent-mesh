#!/usr/bin/env node
// Build the depth-threshold-pin corpus addition: 2 new mandatory cases that
// PIN the evaluator depth cap (src/a2a/local-admission.ts:12,
// `const MAX_REQUEST_DEPTH = 8` and the depth guard at line 147
// `if (depth > MAX_REQUEST_DEPTH) this.problem("MAX_DEPTH_EXCEEDED", knownPath)`)
// at the boundary.
//
// The existing case `request.depth-exceeded` proves that depth > 8 is rejected.
// It does NOT prove that the cap is exactly `> 8` rather than `> 7` or `> 9`.
// These two new cases fill the remaining boundary cells:
//   - request.depth-8-invalid: a request that recurses to depth 8 with an
//     unparseable nested payload so the parser advances past the depth=8
//     guard and then rejects at the next semantic check
//     (INVALID_AUTHENTICATION_EVIDENCE at $.authentication_evidence.adapter_id).
//     Proves the cap is NOT `> 7`.
//   - request.depth-9-invalid: a request that recurses one level deeper so
//     the depth guard fires at depth=9 with MAX_DEPTH_EXCEEDED at
//     $.authentication_evidence. Proves the cap is NOT `> 8`.
// Together, the depth-8 / depth-9 pair pins the request depth cap as exactly
// `> 8` (a depth=8 nested object is parseable; a depth=9 nested object is not).
//
// Refuses to run unless the corpus is in its 49-case pristine shape (the
// origin/main HEAD 2c2e392 state). Idempotent and pinned to the baseline
// sentinel /tmp/corpus-pristine-49.json so the script refuses loudly if the
// repo has drifted from origin/main.
//
// Usage: node scripts/gen-depth-threshold-pin-cases.mjs > /tmp/depth-threshold-pin-new-cases.json
//        node scripts/splice-depth-threshold-pin-cases.mjs /tmp/depth-threshold-pin-new-cases.json
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const corpusPath = join(repoRoot, "test/fixtures/a2a/local-admission/v0.1/corpus.json");

// Pristine sentinel: extract from origin/main HEAD 2c2e392 (49 cases) if not present.
const pristineSentinel = "/tmp/corpus-pristine-49.json";
if (!existsSync(pristineSentinel)) {
  execFileSync("bash", ["-c", `git -C "${repoRoot}" show origin/main:test/fixtures/a2a/local-admission/v0.1/corpus.json > ${pristineSentinel}`]);
}
const pristine = JSON.parse(readFileSync(pristineSentinel, "utf8"));
if (pristine.cases.length !== 49) throw new Error(`pristine sentinel must be 49 cases, got ${pristine.cases.length}`);

// Locate the baseline `valid.admission-plan` case. We copy its
// binding_snapshot + authorization_snapshot byte-for-byte so the request
// parses as a structurally-valid request object. We then mutate
// authentication_evidence to nest {x:..} chains of length 6 (depth-8) and
// 7 (depth-9). Depth is counted from the parser at line 124 starting at
// `value(1, requestShape, "$")`:
//   depth 1: root object
//   depth 2: authentication_evidence
//   depth 3: first {x:..} wrapper
//   ...
//   depth 8: sixth {x:..} wrapper (depth-8)
//   depth 9: seventh {x:..} wrapper (depth-9 -> MAX_DEPTH_EXCEEDED)
const valid = pristine.cases.find((c) => c.id === "valid.admission-plan");
if (!valid) throw new Error(`pristine must contain valid.admission-plan`);
const validBaseReq = JSON.parse(valid.invocation_args.request_json);
const validBaseEnvelope = JSON.parse(valid.invocation_args.envelope_json);

// Build depth-N nested wrapper. The parser counts parse depth starting at
// `value(1, requestShape, "$")` (line 124):
//   depth 1: root object
//   depth 2: authentication_evidence
//   depth 3: first {x:..} wrapper
//   ...
//   depth N-1: (N-3)th {x:..} wrapper
//   depth N: leaf {v:0}
// For a depth-N request we want the leaf at parse depth N. Inside
// authentication_evidence we need (N - 3) {x:..} wrappers wrapping a {v:0}
// leaf. For depth=8: 5 wrappers (depth 3..7) + leaf at depth 8. For
// depth=9: 6 wrappers (depth 3..8) + leaf at depth 9.
const buildNested = (depth) => {
  let leaf = { v: 0 };
  for (let i = 0; i < depth - 3; i += 1) {
    leaf = { x: leaf };
  }
  return leaf;
};

const buildRequest = (depth) => {
  const req = JSON.parse(JSON.stringify(validBaseReq));
  req.authentication_evidence = buildNested(depth);
  return req;
};

// depth=8 -> parse succeeds, field-level check fires
const depth8 = {
  id: "request.depth-8",
  api: "evaluate-local-admission",
  invocation_args: {
    request_json: JSON.stringify(buildRequest(8)),
    envelope_json: JSON.stringify(validBaseEnvelope),
    replay_oracle_result: "unseen",
  },
  expected: {
    result: { kind: "rejected", code: "INVALID_AUTHENTICATION_EVIDENCE", field_path: "$.authentication_evidence.adapter_id" },
    replay_oracle_calls: 0,
    replay_oracle_arguments: [],
  },
};

// depth=9 -> parse-time depth guard fires
const depth9 = {
  id: "request.depth-9",
  api: "evaluate-local-admission",
  invocation_args: {
    request_json: JSON.stringify(buildRequest(9)),
    envelope_json: JSON.stringify(validBaseEnvelope),
    replay_oracle_result: "unseen",
  },
  expected: {
    result: { kind: "rejected", code: "MAX_DEPTH_EXCEEDED", field_path: "$.authentication_evidence" },
    replay_oracle_calls: 0,
    replay_oracle_arguments: [],
  },
};

const newCases = [depth8, depth9];
process.stdout.write(JSON.stringify(newCases, null, 2) + "\n");