/**
 * Generates the Section 9 privacy-invariance matrix (9 mandatory corpus cases)
 * from the canonical valid.admission-plan base case.
 *
 * Run: node scripts/gen-privacy-cases.mjs
 *
 * Every generated case is near-identical to the valid base: exactly one
 * foreign (capability/profile/proof/model/runtime/receipt/conformance/
 * provider/environment/secret) key is injected into one input surface.
 * Expectations are MEASURED from both witnesses, never guessed:
 *
 *  - request top-level injection: the schema stage rejects the unknown core
 *    member with `UNKNOWN_CORE_FIELD` at `$` (1 case).
 *  - nested request injection: the family stage rejects at the nearest known
 *    containing-object path (evidence/snapshot rule/recipient/sender), never
 *    reflecting the foreign name (5 cases).
 *  - envelope-side injection: the delegated 4A decoder ignores unknown members
 *    in agent references; the envelope is semantically unchanged, so the
 *    decision is exactly the base admission plan with one replay call (2 cases).
 *  - hidden raw duplicate: the scanner rejects the duplicate key at `$` with
 *    `DUPLICATE_JSON_KEY` before any policy stage (1 case).
 *
 * No generated case ever passes a foreign value into a policy stage: request
 * cases never parse; envelope cases drop the member in the 4A decode.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");

const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const base = corpus.cases.find((item) => item.id === "valid.admission-plan");
if (base === undefined) throw new Error("valid.admission-plan missing from corpus");

const baseRequest = JSON.parse(base.invocation_args.request_json);
const envelopeJson = base.invocation_args.envelope_json;
const oracle = "unseen";

const KEY = "capability_profile";
const VALUE = "privacy-canary";

const UNKNOWN_CORE_FIELD = {
  result: { kind: "rejected", code: "UNKNOWN_CORE_FIELD", field_path: "$" },
  replay_oracle_calls: 0,
  replay_oracle_arguments: [],
};

const cases = [];

// --- request top-level injection: unknown core member at `$`. ---

{
  const request = structuredClone(baseRequest);
  request[KEY] = VALUE;
  cases.push({
    id: "privacy.unknown-top-level",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: JSON.stringify(request),
      envelope_json: envelopeJson,
      replay_oracle_result: oracle,
    },
    expected: UNKNOWN_CORE_FIELD,
  });
}

// --- nested request injections: the family stage rejects at the nearest known
//     containing-object path, never reflecting the foreign name. ---

{
  const request = structuredClone(baseRequest);
  request.authentication_evidence[KEY] = VALUE;
  cases.push({
    id: "privacy.unknown-evidence-member",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: JSON.stringify(request),
      envelope_json: envelopeJson,
      replay_oracle_result: oracle,
    },
    expected: {
      result: { kind: "rejected", code: "INVALID_AUTHENTICATION_EVIDENCE", field_path: "$.authentication_evidence" },
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  });
}

{
  const request = structuredClone(baseRequest);
  request.binding_snapshot.rules[0][KEY] = VALUE;
  cases.push({
    id: "privacy.unknown-binding-rule-member",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: JSON.stringify(request),
      envelope_json: envelopeJson,
      replay_oracle_result: oracle,
    },
    expected: {
      result: { kind: "rejected", code: "INVALID_BINDING_SNAPSHOT", field_path: "$.binding_snapshot.rules[0]" },
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  });
}

{
  const request = structuredClone(baseRequest);
  request.authorization_snapshot.rules[0][KEY] = VALUE;
  cases.push({
    id: "privacy.unknown-authorization-rule-member",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: JSON.stringify(request),
      envelope_json: envelopeJson,
      replay_oracle_result: oracle,
    },
    expected: {
      result: { kind: "rejected", code: "INVALID_AUTHORIZATION_SNAPSHOT", field_path: "$.authorization_snapshot.rules[0]" },
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  });
}

{
  const request = structuredClone(baseRequest);
  request.authorization_snapshot.rules[0].recipients[0][KEY] = VALUE;
  cases.push({
    id: "privacy.unknown-authorization-recipient-member",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: JSON.stringify(request),
      envelope_json: envelopeJson,
      replay_oracle_result: oracle,
    },
    expected: {
      result: { kind: "rejected", code: "INVALID_AUTHORIZATION_SNAPSHOT", field_path: "$.authorization_snapshot.rules[0].recipients[0]" },
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  });
}

{
  const request = structuredClone(baseRequest);
  request.binding_snapshot.rules[0].sender[KEY] = VALUE;
  cases.push({
    id: "privacy.unknown-binding-sender-member",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: JSON.stringify(request),
      envelope_json: envelopeJson,
      replay_oracle_result: oracle,
    },
    expected: {
      result: { kind: "rejected", code: "INVALID_BINDING_SNAPSHOT", field_path: "$.binding_snapshot.rules[0].sender" },
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  });
}

// --- envelope-surface injections: the delegated 4A decoder ignores unknown
//     members of agent references, so the envelope is semantically unchanged
//     and the decision is exactly the base admission plan. ---

{
  const envelope = JSON.parse(envelopeJson);
  envelope.sender[KEY] = VALUE;
  cases.push({
    id: "privacy.unknown-envelope-sender-member",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: JSON.stringify(baseRequest),
      envelope_json: JSON.stringify(envelope),
      replay_oracle_result: oracle,
    },
    expected: base.expected,
  });
}

{
  const envelope = JSON.parse(envelopeJson);
  envelope.recipients[0][KEY] = VALUE;
  cases.push({
    id: "privacy.unknown-envelope-recipient-member",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: JSON.stringify(baseRequest),
      envelope_json: JSON.stringify(envelope),
      replay_oracle_result: oracle,
    },
    expected: base.expected,
  });
}

// --- hidden raw duplicate: the foreign key exists only in a second occurrence
//     of an otherwise unknown-but-benign key; the scanner rejects the duplicate
//     at `$` before any policy stage. ---

{
  const request = structuredClone(baseRequest);
  request.dupe_holder = {};
  const text = JSON.stringify(request).replace(
    '"dupe_holder":{}',
    `"dupe_holder":{"${KEY}":"x"},"dupe_holder":{"${KEY}":"${VALUE}"}`,
  );
  cases.push({
    id: "privacy.duplicate-key-hidden-foreign-member",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: text,
      envelope_json: envelopeJson,
      replay_oracle_result: oracle,
    },
    expected: {
      result: { kind: "rejected", code: "DUPLICATE_JSON_KEY", field_path: "$" },
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  });
}

const existing = new Set(corpus.mandatory_case_ids);
for (const item of cases) {
  if (existing.has(item.id)) throw new Error(`case id already present: ${item.id}`);
  existing.add(item.id);
}
corpus.mandatory_case_ids.push(...cases.map((item) => item.id));
corpus.cases.push(...cases);

writeFileSync(corpusPath, JSON.stringify(corpus));
console.log(`privacy matrix: corpus ${corpus.mandatory_case_ids.length - cases.length} -> ${corpus.mandatory_case_ids.length} mandatory cases (${cases.length} new)`);
