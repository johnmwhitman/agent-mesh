// Adds authorization.field-* cases to the corpus and updates mandatory_case_ids.
// Subfamily: invalid authorization_snapshot fields (snapshot_version, snapshot_id,
// fixture_provenance, effective_from_ms, effective_until_ms, rules) — each invalid
// field representative is rejected with INVALID_AUTHORIZATION_SNAPSHOT at the exact
// field path, 0 replay calls.
//
// Closes the bounded "snapshot fields/provenance" subfamily listed in
// docs/ops/A2A-LOCAL-ADMISSION-COVERAGE-LEDGER-2026-07-29.md
// (remaining exact gap: snapshot fields/provenance).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

// Find the authorization.invalid case to use as the template for request/envelope shape.
// authorization.invalid already exercises .rules[0].action (rules-array depth),
// so we use it as the base and override the fields it doesn't touch.
const authInvalid = corpus.cases.find((c) => c.id === "authorization.invalid");
const baseRequest = JSON.parse(authInvalid.invocation_args.request_json);

// Fix the authorization snapshot so its top-level fields are valid (we will
// then mutate exactly one field at a time).
baseRequest.authorization_snapshot.snapshot_version = "meshfleet.a2a.authorization-snapshot.v0.1";
baseRequest.authorization_snapshot.snapshot_id = "authorization-fixture";
baseRequest.authorization_snapshot.fixture_provenance = "caller_supplied_fixture";
baseRequest.authorization_snapshot.effective_from_ms = 0;
baseRequest.authorization_snapshot.effective_until_ms = 200;
baseRequest.authorization_snapshot.rules[0].action = "a2a.message.admit";

// Validator order in src/a2a/local-admission.ts snapshot<AuthorizationRule>:
//   1. snapshot_version (line 384) — must equal AUTHORIZATION_VERSION
//   2. snapshot_id     (line 385) — must match OPAQUE_REF
//   3. fixture_provenance (line 386) — must equal FIXTURE_PROVENANCE
//   4. effective_from_ms (line 387) — must be localTime number
//   5. effective_until_ms (line 388) — must be localTime number
//   6. rules            (line 389) — must be array with length <= 2048
const fieldCases = [
  {
    id: "authorization.field-snapshot-version",
    mutate: (req) => { req.authorization_snapshot.snapshot_version = "other"; },
    field_path: "$.authorization_snapshot.snapshot_version",
  },
  {
    id: "authorization.field-snapshot-id",
    mutate: (req) => { req.authorization_snapshot.snapshot_id = ""; }, // empty string fails OPAQUE_REF
    field_path: "$.authorization_snapshot.snapshot_id",
  },
  {
    id: "authorization.field-fixture-provenance",
    mutate: (req) => { req.authorization_snapshot.fixture_provenance = "untrusted_fixture"; },
    field_path: "$.authorization_snapshot.fixture_provenance",
  },
  {
    id: "authorization.field-effective-from",
    mutate: (req) => { req.authorization_snapshot.effective_from_ms = "0"; }, // string fails localTime
    field_path: "$.authorization_snapshot.effective_from_ms",
  },
  {
    id: "authorization.field-effective-until",
    mutate: (req) => { req.authorization_snapshot.effective_until_ms = "200"; }, // string fails localTime
    field_path: "$.authorization_snapshot.effective_until_ms",
  },
  {
    id: "authorization.field-rules-not-array",
    mutate: (req) => { req.authorization_snapshot.rules = {}; }, // object fails rules Array.isArray
    field_path: "$.authorization_snapshot.rules",
  },
];

const newCases = fieldCases.map(({ id, mutate, field_path }) => {
  const req = JSON.parse(JSON.stringify(baseRequest));
  mutate(req);
  return {
    id,
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: JSON.stringify(req),
      envelope_json: authInvalid.invocation_args.envelope_json,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: {
        kind: "rejected",
        code: "INVALID_AUTHORIZATION_SNAPSHOT",
        field_path,
      },
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  };
});

// Insert after authorization.invalid in the cases array and mandatory_case_ids.
const insertAfter = "authorization.invalid";
const caseIdx = corpus.cases.findIndex((c) => c.id === insertAfter);
corpus.cases.splice(caseIdx + 1, 0, ...newCases);

const idIdx = corpus.mandatory_case_ids.indexOf(insertAfter);
corpus.mandatory_case_ids.splice(idIdx + 1, 0, ...newCases.map((c) => c.id));

writeFileSync(corpusPath, JSON.stringify(corpus) + "\n", "utf8");
console.log(`Added ${newCases.length} authorization.field-* cases after index ${caseIdx + 1}`);
console.log("Total cases:", corpus.cases.length);
console.log("Mandatory IDs:", corpus.mandatory_case_ids.length);
