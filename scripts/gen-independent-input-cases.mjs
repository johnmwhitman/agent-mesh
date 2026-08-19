// Generator: independent-input mandatory corpus gates for the local-admission
// evidence-alpha corpus (coverage-ledger independent-input row).
//
// Closes the remaining gap: "independent depth/byte collision vectors and
// double-encoding vectors" on top of the 44-case origin/main corpus.
// New cases: 6 (corpus 44 -> 50).
//
// Required coverage (Section 9 / Section 3.2 of the profile):
//   - request contains no envelope member (root + nested)
//   - envelope is not double-encoded
//   - each input's byte/depth limit is independent
//   - request error wins collision with envelope error
//
// Depth semantics (RequestScanner.value is entered at depth 1 for the root;
// MAX_REQUEST_DEPTH = 8):
//   - depth-8: deepest value sits at scanner depth 8 -> scanner admits
//   - depth-9: deepest value sits at scanner depth 9 -> MAX_DEPTH_EXCEEDED
//
// Byte semantics: MAX_REQUEST_BYTES = 262144
//   - 262143: scanner admits (independent of envelope)
//   - 262145: REQUEST_TOO_LARGE (request error wins)
//
// Collision vector proof:
//   - request error with envelope error in the same call -> request error wins
//     (request is parsed first; envelope is never reached).
//   - request near-limit with envelope malformed -> envelope error wins
//     (request is structurally valid; envelope decoder surfaces error).
//
// Every new case: 0 replay oracle calls (request is rejected before oracle).
// Each envelope carries: malformed = "{", depth-8 admit uses the canonical
// envelope from valid.admission-plan.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = process.cwd();
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

const valid = corpus.cases.find((c) => c.id === "valid.admission-plan");
if (!valid) throw new Error("valid.admission-plan fixture missing");
const baseRequest = JSON.parse(valid.invocation_args.request_json);
const envelopeJson = valid.invocation_args.envelope_json;
const malformedEnvelope = "{";

const rejected = (code, fieldPath) => ({
  kind: "rejected",
  code,
  field_path: fieldPath,
});

// Build a request whose authentication_evidence is replaced by `n` nested
// "x" objects ending in v: 0. Scanner depth = 2 + n + 1 (the v leaf).
// n=5 -> depth 8 (admit); n=6 -> depth 9 (fail).
function nestedEvidence(n) {
  const request = JSON.parse(JSON.stringify(baseRequest));
  let cursor = {};
  request.authentication_evidence = cursor;
  for (let i = 0; i < n; i += 1) {
    cursor.x = {};
    cursor = cursor.x;
  }
  cursor.v = 0;
  return request;
}

// Build a request whose raw byte length is exactly `target`. Pads by
// appending an OPAQUE_REF-valid "request_id" string (128 chars) and adding
// more padding characters until the request JSON hits the target byte
// length. Mirrors the existing request.byte-262143/-262144/-262145 pattern
// (protocol uses an unknown top-level "extra" field for byte padding,
// which fires UNKNOWN_CORE_FIELD at the top level - the byte check both
// happens-and-admits; the unknown field is what trips the validator).
function paddedRequest(target, baseBytes) {
  const padChars = Math.max(0, target - baseBytes);
  const request = JSON.parse(JSON.stringify(baseRequest));
  // The natural request_id is 11 chars; OPAQUE_REF max length is 128.
  // The padding must still parse; the unknown field is what trips the
  // validator and lets us isolate the byte limit's admit decision.
  // Use a tail-padded request_id + a "extra" field whose value is a
  // short x-string (OPAQUE_REF N/A - extra is a custom name; the byte
  // limit check happens even if the field is unknown later).
  request.request_id = "r" + "r".repeat(Math.min(127, padChars > 0 ? 127 : 0));
  let raw = JSON.stringify(request);
  // Add an "extra" field containing the remaining bytes; the x-string
  // will be adjusted once we know how many bytes "extra":"" adds.
  const header = ',"extra":"';
  const tail = '"}';
  let bodyLen = padChars - header.length - tail.length;
  if (bodyLen < 0) bodyLen = 0;
  raw = raw.slice(0, -1) + header + "x".repeat(bodyLen) + tail;
  const final = JSON.stringify(JSON.parse(raw)); // canonicalise, then trim
  // If we're still short, append x's to the extra value; if too long,
  // trim. The raw byte length of the final string is what the byte
  // limit scans.
  const finalRaw = JSON.stringify(JSON.parse(raw));
  let delta = Buffer.byteLength(finalRaw, "utf8") - target;
  if (delta > 0) {
    // shrink the extra value
    const newRaw = finalRaw.slice(0, finalRaw.length - tail.length - delta) + tail;
    return newRaw;
  }
  if (delta < 0) {
    // grow the extra value
    const newRaw = finalRaw.slice(0, finalRaw.length - tail.length) + "x".repeat(-delta) + tail;
    return newRaw;
  }
  return finalRaw;
}

// Raw-string surgery: add byte payload (the existing byte-262143 case uses
// an "extra" field with a long x-string; reuse byte-verified structure).
function paddedRequest262143() {
  const k = corpus.cases.find((c) => c.id === "request.byte-262143");
  if (!k) throw new Error("request.byte-262143 fixture missing");
  return k.invocation_args.request_json;
}
function paddedRequest262145() {
  const k = corpus.cases.find((c) => c.id === "request.byte-262145");
  if (!k) throw new Error("request.byte-262145 fixture missing");
  return k.invocation_args.request_json;
}

const depth8Request = JSON.stringify(nestedEvidence(5)); // admit (depth 8)
const depth9Request = JSON.stringify(nestedEvidence(6)); // fail (depth 9)

// Double-encoded envelope: top-level "envelope" key is unknown core field.
const envelopeRootRequest = JSON.stringify({
  ...baseRequest,
  envelope: "{}",
});

// Double-encoded envelope: nested "envelope" key under authentication_evidence
// is unknown auth_evidence member.
const envelopeNestedRequest = JSON.stringify({
  ...baseRequest,
  authentication_evidence: {
    ...baseRequest.authentication_evidence,
    envelope: "{}",
  },
});

const cases = [
  // 1. request.envelope-member-root: no top-level envelope member allowed.
  {
    id: "request.envelope-member-root",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: envelopeRootRequest,
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejected("UNKNOWN_CORE_FIELD", "$"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  // 2. request.envelope-member-nested: no nested envelope member allowed.
  {
    id: "request.envelope-member-nested",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: envelopeNestedRequest,
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejected("INVALID_AUTHENTICATION_EVIDENCE", "$.authentication_evidence"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  // 3. request.depth-9-envelope-malformed: request error wins collision.
  {
    id: "request.depth-9-envelope-malformed",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: depth9Request,
      envelope_json: malformedEnvelope,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejected("MAX_DEPTH_EXCEEDED", "$.authentication_evidence"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  // 4. request.byte-262145-envelope-malformed: request error wins collision.
  {
    id: "request.byte-262145-envelope-malformed",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: paddedRequest262145(),
      envelope_json: malformedEnvelope,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejected("REQUEST_TOO_LARGE", "$"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  // 5. request.depth-8-envelope-malformed: envelope error wins (request OK).
  // depth-8 admits; envelope malformed -> MALFORMED_ENVELOPE.
  {
    id: "request.depth-8-envelope-malformed",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: depth8Request,
      envelope_json: malformedEnvelope,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejected("MALFORMED_ENVELOPE", "$.envelope"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  // 6. request.byte-262143-envelope-malformed: request error wins (extra
  // unknown field is reported at top level, not envelope).
  {
    id: "request.byte-262143-envelope-malformed",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: paddedRequest262143(),
      envelope_json: malformedEnvelope,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejected("UNKNOWN_CORE_FIELD", "$"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
];

// Verify the new cases against the BUILT TypeScript evaluator before
// splicing them into the corpus.
const { evaluateLocalAdmission } = await import("../dist/a2a/local-admission.js");
const failures = [];
for (const item of cases) {
  const calls = [];
  const result = evaluateLocalAdmission(
    item.invocation_args.request_json,
    item.invocation_args.envelope_json,
    (argument) => {
      calls.push(argument);
      if (item.invocation_args.replay_oracle_result === "throws") throw new Error("fixture");
      return item.invocation_args.replay_oracle_result;
    },
  );
  const actual = { result, replay_oracle_calls: calls.length, replay_oracle_arguments: calls };
  if (JSON.stringify(actual) !== JSON.stringify(item.expected)) {
    failures.push(`${item.id}: expected ${JSON.stringify(item.expected)} got ${JSON.stringify(actual)}`);
  }
}
if (failures.length > 0) {
  throw new Error(`probe mismatch:\n${failures.join("\n")}`);
}

// Splice: append to cases, append ids to mandatory_case_ids (positional order
// preserved: test asserts cases.map(id) === mandatory_case_ids).
corpus.cases.push(...cases);
corpus.mandatory_case_ids.push(...cases.map((c) => c.id));
writeFileSync(corpusPath, JSON.stringify(corpus), "utf8");

// Also verify the Python witness agrees over the spliced corpus.
import { spawnSync } from "node:child_process";
const witness = spawnSync(
  "python3",
  [join(root, "reference", "python", "a2a_local_admission_reference.py"), "--corpus", corpusPath],
  { encoding: "utf8", timeout: 30_000 },
);
if (witness.status !== 0) {
  throw new Error(`python witness rejected spliced corpus: ${witness.stderr || witness.stdout}`);
}
const report = JSON.parse(witness.stdout);
if (!report.ok || report.case_count !== corpus.cases.length) {
  throw new Error(`witness report not ok: ${JSON.stringify(report).slice(0, 400)}`);
}

console.log(`OK: ${cases.length} new cases appended (corpus 44 -> ${corpus.cases.length}); TS probe 0 mismatches; Python witness ${report.case_count}/${report.case_count} ok`);
