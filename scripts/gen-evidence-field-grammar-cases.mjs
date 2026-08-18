// Generator: evidence field-type/grammar mandatory corpus gates for the
// local-admission evidence-alpha corpus (coverage-ledger evidence row).
//
// Closes the remaining gap: "every remaining field/type/grammar vector"
// on top of the 44-case origin/main corpus. Tick-57 (cb8f057) closed
// provenance equality + issued-at/expires-at equality + lifetime bounds
// (300000/300001). This slice closes the field-type/grammar axis for the
// remaining 5 evidence fields: adapter_id (type + grammar), principal_ref
// (type + grammar), issued_at_ms (type), expires_at_ms (type).
//
// New cases: 6 (corpus 44 -> 50).
//
// Evidence grammar (src/a2a/local-admission.ts:310-320):
//   - adapter_id: typeof string + ADAPTER_ID regex `^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$`
//   - principal_ref / audience / session_ref: typeof string + OPAQUE_REF
//     regex `^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$`
//   - issued_at_ms / expires_at_ms: typeof number + isSafeInteger + >= 0
//     (numeric lexeme scan precedes: -1, -0, 1e2, 9007199254740992 are
//     MALFORMED_JSON at the field path; covered by tick-58 depth/numeric;
//     this slice covers ONLY non-numeric types that pass the scanner.)
//
// Type-invalid axis (scanner accepts, evidence() rejects):
//   - adapter_id: 42    -> INVALID_AUTHENTICATION_EVIDENCE@$.authentication_evidence.adapter_id
//     (typeof number, fails validAdapter which requires typeof string)
//   - principal_ref: true -> INVALID_AUTHENTICATION_EVIDENCE@$.authentication_evidence.principal_ref
//     (typeof boolean, fails validOpaque which requires typeof string)
//
// Grammar-invalid axis (string type passes, regex fails):
//   - adapter_id: "-leading-dash" -> INVALID_AUTHENTICATION_EVIDENCE@$.authentication_evidence.adapter_id
//     (ADAPTER_ID regex starts with [a-z0-9], rejects leading dash)
//   - principal_ref: "" -> INVALID_AUTHENTICATION_EVIDENCE@$.authentication_evidence.principal_ref
//     (OPAQUE_REF regex requires at least 1 char)
//
// Time-field type-invalid axis (numeric scanner would fail with MALFORMED_JSON;
// string type passes the scanner, evidence() rejects with INVALID_AUTHENTICATION_EVIDENCE):
//   - issued_at_ms: "abc" -> INVALID_AUTHENTICATION_EVIDENCE@$.authentication_evidence.issued_at_ms
//     (typeof string, fails localTime which requires typeof number)
//   - expires_at_ms: false -> INVALID_AUTHENTICATION_EVIDENCE@$.authentication_evidence.expires_at_ms
//     (typeof boolean, fails localTime which requires typeof number)
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

// Build a request whose authentication_evidence is a deep clone of the
// baseline evidence with the named field replaced by `value`. JSON.stringify
// preserves the new value's type byte-identically (number -> unquoted,
// boolean -> unquoted true/false, string -> quoted).
function evidenceWith(field, value) {
  const request = JSON.parse(JSON.stringify(baseRequest));
  request.authentication_evidence[field] = value;
  return JSON.stringify(request);
}

const cases = [
  {
    id: "evidence.adapter_id-invalid-type",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: evidenceWith("adapter_id", 42),
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
    id: "evidence.adapter_id-invalid-grammar",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: evidenceWith("adapter_id", "-leading-dash"),
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
    id: "evidence.principal_ref-invalid-type",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: evidenceWith("principal_ref", true),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejected("INVALID_AUTHENTICATION_EVIDENCE", "$.authentication_evidence.principal_ref"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  {
    id: "evidence.principal_ref-invalid-grammar",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: evidenceWith("principal_ref", ""),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejected("INVALID_AUTHENTICATION_EVIDENCE", "$.authentication_evidence.principal_ref"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  {
    id: "evidence.issued_at_ms-invalid-type",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: evidenceWith("issued_at_ms", "abc"),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejected("INVALID_AUTHENTICATION_EVIDENCE", "$.authentication_evidence.issued_at_ms"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  {
    id: "evidence.expires_at_ms-invalid-type",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: evidenceWith("expires_at_ms", false),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejected("INVALID_AUTHENTICATION_EVIDENCE", "$.authentication_evidence.expires_at_ms"),
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
