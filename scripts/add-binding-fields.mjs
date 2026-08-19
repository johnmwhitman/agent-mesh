// Adds binding.field-* cases to the corpus and updates mandatory_case_ids.
// Subfamily: invalid binding_snapshot fields (snapshot_id, fixture_provenance,
// effective_from_ms, effective_until_ms) — each invalid field representative
// is rejected with INVALID_BINDING_SNAPSHOT at the exact field path, 0 replay calls.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

// Find the binding.invalid case to use as template for request/envelope structure.
const bindingInvalid = corpus.cases.find((c) => c.id === "binding.invalid");

// The binding.invalid case has snapshot_version = "other" (invalid).
// We need a valid binding snapshot as the base, then mutate one field at a time.
const baseRequest = JSON.parse(bindingInvalid.invocation_args.request_json);
// Fix the binding snapshot to be valid (correct version, valid opaque snapshot_id,
// correct fixture_provenance, valid time interval).
baseRequest.binding_snapshot.snapshot_version = "meshfleet.a2a.binding-snapshot.v0.1";
baseRequest.binding_snapshot.snapshot_id = "binding-fixture";
baseRequest.binding_snapshot.fixture_provenance = "caller_supplied_fixture";
baseRequest.binding_snapshot.effective_from_ms = 0;
baseRequest.binding_snapshot.effective_until_ms = 200;

// Build the 4 field-invalid cases. Each mutates exactly one field to an invalid value.
// Validator order: snapshot_version (already covered by binding.invalid), snapshot_id,
// fixture_provenance, effective_from_ms, effective_until_ms.
const fieldCases = [
  {
    id: "binding.field-snapshot-id",
    mutate: (req) => { req.binding_snapshot.snapshot_id = ""; },  // empty string fails OPAQUE_REF
    field_path: "$.binding_snapshot.snapshot_id",
  },
  {
    id: "binding.field-fixture-provenance",
    mutate: (req) => { req.binding_snapshot.fixture_provenance = "untrusted_fixture"; },
    field_path: "$.binding_snapshot.fixture_provenance",
  },
  {
    id: "binding.field-effective-from",
    mutate: (req) => { req.binding_snapshot.effective_from_ms = "0"; },  // string fails localTime (typeof !== "number")
    field_path: "$.binding_snapshot.effective_from_ms",
  },
  {
    id: "binding.field-effective-until",
    mutate: (req) => { req.binding_snapshot.effective_until_ms = "200"; },  // string fails localTime
    field_path: "$.binding_snapshot.effective_until_ms",
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
      envelope_json: bindingInvalid.invocation_args.envelope_json,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: {
        kind: "rejected",
        code: "INVALID_BINDING_SNAPSHOT",
        field_path,
      },
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  };
});

// Insert after binding.invalid in the cases array and mandatory_case_ids
const insertAfter = "binding.invalid";
const caseIdx = corpus.cases.findIndex((c) => c.id === insertAfter);
corpus.cases.splice(caseIdx + 1, 0, ...newCases);

const idIdx = corpus.mandatory_case_ids.indexOf(insertAfter);
corpus.mandatory_case_ids.splice(idIdx + 1, 0, ...newCases.map((c) => c.id));

writeFileSync(corpusPath, JSON.stringify(corpus) + "\n", "utf8");
console.log(`Added ${newCases.length} binding.field-* cases after index ${caseIdx + 1}`);
console.log("Total cases:", corpus.cases.length);
console.log("Mandatory IDs:", corpus.mandatory_case_ids.length);