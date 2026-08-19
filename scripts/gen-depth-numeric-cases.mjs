// Generator: depth/numeric mandatory corpus gates for the local-admission
// evidence-alpha corpus (coverage-ledger depth/numeric row).
//
// Closes the remaining gap: "request depth 8/9 and negative, -0, exponent,
// unsafe-integer boundaries" on top of the 44-case origin/main corpus.
// New cases: 6 (corpus 44 -> 50).
//
// Depth semantics (RequestScanner.value is entered at depth 1 for the root;
// MAX_REQUEST_DEPTH = 8):
//   - depth-8: deepest value sits at scanner depth 8 -> scanner admits,
//     semantic validation reports INVALID_AUTHENTICATION_EVIDENCE at the
//     missing adapter_id (evidence object was replaced by nested "x" keys).
//   - depth-9: deepest value sits at scanner depth 9 -> MAX_DEPTH_EXCEEDED
//     at $.authentication_evidence.
//   - existing request.depth-exceeded (depth 11) stays as the deeper probe.
//
// Numeric lexeme semantics (raw-string surgery, because JSON.stringify
// normalizes -0 -> 0 and 1e2 -> 100; tick-57 raw-surgery precedent):
//   - negative -1            -> MALFORMED_JSON at $.evaluation_time_ms
//   - negative zero lexeme   -> MALFORMED_JSON at $.evaluation_time_ms
//     (TS /^(?:0|[1-9][0-9]*)$/ and Python raw.isdigit() both reject "-0";
//      probe-verified byte-identical on both witnesses)
//   - exponent lexeme 1e2    -> MALFORMED_JSON at $.evaluation_time_ms
//   - unsafe integer 9007199254740992 -> MALFORMED_JSON at $.evaluation_time_ms
//   - max safe integer 9007199254740991 -> scanner-ACCEPTED (no MALFORMED_JSON),
//     evaluation time beyond the evidence window -> AUTHORIZATION_DENIED at "$"
//     with 0 oracle calls (same shape as evidence.expires-at-evaluation-denied).
//
// Every case: 0 replay oracle calls, envelope from valid.admission-plan.

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

const rejected = (code, fieldPath) => ({
  kind: "rejected",
  code,
  field_path: fieldPath,
});

// Build a request whose authentication_evidence is replaced by `n` nested
// "x" objects ending in v: 0. The scanner's known-shape walk keeps the path
// at $.authentication_evidence for unknown members, so depth errors surface
// there.
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

const depth8Request = JSON.stringify(nestedEvidence(5)); // deepest value at scanner depth 8
const depth9Request = JSON.stringify(nestedEvidence(6)); // deepest value at scanner depth 9

// Raw-string lexeme surgery on evaluation_time_ms (100 -> target lexeme).
// The rest of the request stays byte-identical to the valid fixture.
function lexemeRequest(lexeme) {
  const raw = JSON.stringify(baseRequest);
  const marker = '"evaluation_time_ms":100';
  if (!raw.includes(marker)) throw new Error(`marker not found for lexeme ${lexeme}`);
  return raw.replace(marker, `"evaluation_time_ms":${lexeme}`);
}

const cases = [
  {
    id: "request.depth-8",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: depth8Request,
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejected("INVALID_AUTHENTICATION_EVIDENCE", "$.authentication_evidence.adapter_id"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  {
    id: "request.depth-9",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: depth9Request,
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejected("MAX_DEPTH_EXCEEDED", "$.authentication_evidence"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  {
    id: "request.number-negative",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: lexemeRequest("-1"),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejected("MALFORMED_JSON", "$.evaluation_time_ms"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  {
    id: "request.number-negative-zero",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: lexemeRequest("-0"),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejected("MALFORMED_JSON", "$.evaluation_time_ms"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  {
    id: "request.number-exponent",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: lexemeRequest("1e2"),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejected("MALFORMED_JSON", "$.evaluation_time_ms"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  {
    id: "request.number-unsafe-integer",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: lexemeRequest("9007199254740992"),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejected("MALFORMED_JSON", "$.evaluation_time_ms"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  {
    id: "request.number-max-safe",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: lexemeRequest("9007199254740991"),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejected("AUTHORIZATION_DENIED", "$"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
];

// Verify the six new cases against the BUILT TypeScript evaluator before
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
const witness = spawnSync("python3", [join(root, "reference", "python", "a2a_local_admission_reference.py"), "--corpus", corpusPath], {
  encoding: "utf8",
  timeout: 30_000,
});
if (witness.status !== 0) {
  throw new Error(`python witness rejected spliced corpus: ${witness.stderr || witness.stdout}`);
}
const report = JSON.parse(witness.stdout);
if (!report.ok || report.case_count !== corpus.cases.length) {
  throw new Error(`witness report not ok: ${JSON.stringify(report).slice(0, 400)}`);
}

console.log(`OK: ${cases.length} new cases appended (corpus 44 -> ${corpus.cases.length}); TS probe 0 mismatches; Python witness ${report.case_count}/${report.case_count} ok`);
