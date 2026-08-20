// Adds binding.context-mismatch case to the corpus and updates mandatory_case_ids.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

// Find the binding.invalid case to use as template for request/envelope structure.
const bindingInvalid = corpus.cases.find((c) => c.id === "binding.invalid");
const validCase = corpus.cases[0];

// Build a request where binding_snapshot is valid but the rule's context
// (adapter_id/principal_ref/audience/session_ref) does NOT match the auth evidence.
// Auth evidence: adapter_id="local.adapter", principal_ref="principal-ref",
//   audience="local-audience", session_ref="session-ref"
// Binding rule uses: principal_ref="other-principal" (mismatch)
const request = JSON.parse(bindingInvalid.invocation_args.request_json);
// Fix the binding snapshot to be valid (correct version)
request.binding_snapshot.snapshot_version = "meshfleet.a2a.binding-snapshot.v0.1";
// Mismatch the context: change principal_ref in the binding rule
request.binding_snapshot.rules[0].principal_ref = "other-principal";

const newCase = {
  id: "binding.context-mismatch",
  api: "evaluate-local-admission",
  invocation_args: {
    request_json: JSON.stringify(request),
    envelope_json: bindingInvalid.invocation_args.envelope_json,
    replay_oracle_result: "unseen",
  },
  expected: {
    result: {
      kind: "rejected",
      code: "AUTHORIZATION_DENIED",
      field_path: "$",
    },
    replay_oracle_calls: 0,
    replay_oracle_arguments: [],
  },
};

// Insert after binding.invalid in the cases array and mandatory_case_ids
const insertAfter = "binding.invalid";
const caseIdx = corpus.cases.findIndex((c) => c.id === insertAfter);
corpus.cases.splice(caseIdx + 1, 0, newCase);

const idIdx = corpus.mandatory_case_ids.indexOf(insertAfter);
corpus.mandatory_case_ids.splice(idIdx + 1, 0, "binding.context-mismatch");

writeFileSync(corpusPath, JSON.stringify(corpus) + "\n", "utf8");
console.log("Added binding.context-mismatch at index", caseIdx + 1);
console.log("Total cases:", corpus.cases.length);
console.log("Mandatory IDs:", corpus.mandatory_case_ids.length);