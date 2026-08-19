// Generator: oracle/results "malformed oracle case" mandatory corpus gates
// for the local-admission evidence-alpha corpus (coverage-ledger
// oracle/results row, malformed-orcase subfamily).
//
// Closes the remaining gap: every non-verdict JSON value the oracle can
// produce must map to REPLAY_PROTECTION_UNAVAILABLE at $. The 6 verdict
// strings ("unseen", "replayed_request", "request_id_reuse", "duplicate",
// "message_id_conflict", "unavailable") and the special "throws" marker
// are already covered by the existing 44-case corpus. This slice adds 6
// non-verdict classes on top.
//
// New cases (corpus 44 -> 50):
//   - oracle.malformed-object      oracle returns {"verdict":"unseen"}:
//                                  object shape with verdict-like key
//                                  (probes that no shallow verdict extraction
//                                  is performed)
//   - oracle.malformed-number      oracle returns 42: number, no string
//                                  (probes the type-tag guard)
//   - oracle.malformed-null        oracle returns null: JSON null literal
//                                  (probes the null guard)
//   - oracle.malformed-empty-array oracle returns []: empty array literal
//                                  (probes the array-shape guard)
//   - oracle.malformed-uppercase   oracle returns "UNSEEN": uppercase
//                                  canonical verdict (probes the
//                                  no-uppercase-generic-replay property
//                                  from the oracle/results profile row)
//   - oracle.malformed-empty-string oracle returns "": empty string
//                                  (probes the empty-string guard)
//
// Every case: 1 replay oracle call, envelope + request reused from
// valid.admission-plan, expected verdict = REPLAY_PROTECTION_UNAVAILABLE
// at $ (the existing oracle.unavailable and oracle.throws cases pin the
// same rejection code at $).
//
// Authoritative oracle verdict set (decideReplay + Python witness):
//   "unseen" | "replayed_request" | "request_id_reuse" | "duplicate"
//   | "message_id_conflict" | "unavailable"
// Throws (caught) and any other value map to {kind:"unavailable"}. This
// generator's 6 cases exercise the "any other value" half of that mapping.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

const valid = corpus.cases.find((c) => c.id === "valid.admission-plan");
if (!valid) throw new Error("valid.admission-plan fixture missing");

const envelopeJson = valid.invocation_args.envelope_json;
const requestJson = valid.invocation_args.request_json;
// Envelope digest is identical to valid.admission-plan's because the
// envelope bytes are unchanged; this is verified by the family-pin test
// below. The TS evaluator's admission_plan shape is exactly the same as
// valid.admission-plan's, modulo the verdict -> unavailable rewrite.
const envelopeDigest = "meshfleet.a2a.fingerprint.v1:sha256:9dd42da42a919761fb2f5bc007c03dd948ba0e6f4dcd9be80d556c31339c5606";

const replayOracleArgument = {
  principal_ref: "principal-ref",
  request_id: "request-ref",
  sender: { namespace: "local", agent_id: "agent-a" },
  message_id: "message-ref",
  envelope_digest: envelopeDigest,
};

const rejectedUnavailable = {
  kind: "rejected",
  code: "REPLAY_PROTECTION_UNAVAILABLE",
  field_path: "$",
};

const newCases = [
  {
    id: "oracle.malformed-object",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: requestJson,
      envelope_json: envelopeJson,
      replay_oracle_result: { verdict: "unseen" },
    },
    expected: {
      result: rejectedUnavailable,
      replay_oracle_calls: 1,
      replay_oracle_arguments: [replayOracleArgument],
    },
  },
  {
    id: "oracle.malformed-number",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: requestJson,
      envelope_json: envelopeJson,
      replay_oracle_result: 42,
    },
    expected: {
      result: rejectedUnavailable,
      replay_oracle_calls: 1,
      replay_oracle_arguments: [replayOracleArgument],
    },
  },
  {
    id: "oracle.malformed-null",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: requestJson,
      envelope_json: envelopeJson,
      replay_oracle_result: null,
    },
    expected: {
      result: rejectedUnavailable,
      replay_oracle_calls: 1,
      replay_oracle_arguments: [replayOracleArgument],
    },
  },
  {
    id: "oracle.malformed-empty-array",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: requestJson,
      envelope_json: envelopeJson,
      replay_oracle_result: [],
    },
    expected: {
      result: rejectedUnavailable,
      replay_oracle_calls: 1,
      replay_oracle_arguments: [replayOracleArgument],
    },
  },
  {
    id: "oracle.malformed-uppercase",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: requestJson,
      envelope_json: envelopeJson,
      replay_oracle_result: "UNSEEN",
    },
    expected: {
      result: rejectedUnavailable,
      replay_oracle_calls: 1,
      replay_oracle_arguments: [replayOracleArgument],
    },
  },
  {
    id: "oracle.malformed-empty-string",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: requestJson,
      envelope_json: envelopeJson,
      replay_oracle_result: "",
    },
    expected: {
      result: rejectedUnavailable,
      replay_oracle_calls: 1,
      replay_oracle_arguments: [replayOracleArgument],
    },
  },
];

// Splice into the corpus just after the existing oracle.throws case to
// keep oracle-family ordering monotonic. mandatory_case_ids must mirror
// case ids in order (a2a-local-admission.test.ts line 47).
const insertAfterId = "oracle.throws";
const idx = corpus.cases.findIndex((c) => c.id === insertAfterId);
if (idx === -1) throw new Error(`${insertAfterId} not found in corpus`);
corpus.cases.splice(idx + 1, 0, ...newCases);
corpus.mandatory_case_ids = corpus.cases.map((c) => c.id);

const unique = new Set(corpus.mandatory_case_ids);
if (unique.size !== corpus.mandatory_case_ids.length) throw new Error("duplicate ids after splice");

writeFileSync(corpusPath, JSON.stringify(corpus) + "\n");
console.log(`Spliced ${newCases.length} new oracle malformed cases into the corpus.`);
console.log(`Corpus size: ${corpus.cases.length} cases (${corpus.mandatory_case_ids.length} mandatory ids).`);
console.log(`New ids: ${newCases.map((c) => c.id).join(", ")}`);
