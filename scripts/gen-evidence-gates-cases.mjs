#!/usr/bin/env node
/**
 * gen-evidence-gates-cases.mjs
 *
 * Tick-57 (2026-08-17): Section 9 evidence-family gate closure —
 * every remaining field/type/grammar vector of the local
 * authentication_evidence object as mandatory corpus cases.
 *
 * Base fixture: evidence.invalid (valid envelope + binding + authorization,
 * evidence is the ONLY defect). 25 new cases appended to corpus.json;
 * pristine backup written first.
 *
 * Semantics verified against both witnesses before committing:
 *  - adapter_id grammar rejects: leading uppercase, uppercase, underscore,
 *    trailing dot, trailing dash, 65-byte (ADAPTER_ID lowercase alnum
 *    segments). Single-char "a" is GRAMMAR-VALID and denies only via the
 *    binding context mismatch (AUTHORIZATION_DENIED, pinned as the
 *    grammar-vs-policy boundary).
 *  - opaque-ref (principal_ref/audience/session_ref): leading punctuation,
 *    space, 129-byte rejects; UPPERCASE is OPAQUE-VALID and denies only via
 *    binding mismatch (pinned on all three fields).
 *  - local times: fraction/negative/exponent/over-safe lexemes are rejected
 *    by the REQUEST SCANNER (A02 precedes A06) as MALFORMED_JSON at the exact
 *    member path — the lexemes must be injected as raw text because
 *    JSON.stringify normalizes numbers; over-safe = MAX_SAFE+1
 *    (9007199254740992).
 *  - orderings: issued_at > evaluation_time and issued_at > expires_at deny
 *    as AUTHORIZATION_DENIED before any oracle call.
 *  - provenance: only the exact literal "trusted_local_adapter" admits;
 *    empty/uppercase reject at $.authentication_evidence.provenance.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const backupPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json.pristine-44");

if (!existsSync(backupPath)) {
  copyFileSync(corpusPath, backupPath);
  console.log("backed up pristine corpus -> corpus.json.pristine-44");
}

const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const base = corpus.cases.find((c) => c.id === "valid.admission-plan");
if (!base) throw new Error("base case valid.admission-plan not found");

const EVIDENCE = {
  adapter_id: "local.adapter",
  principal_ref: "principal-ref",
  audience: "local-audience",
  session_ref: "session-ref",
  issued_at_ms: 0,
  expires_at_ms: 200,
  provenance: "trusted_local_adapter",
};

// token -> replacement evidence object (single defect each)
const CASES = {
  "evidence.adapter-leading-uppercase": {
    ...EVIDENCE, adapter_id: "Local.adapter",
    expected: "INVALID_AUTHENTICATION_EVIDENCE", path: "$.authentication_evidence.adapter_id",
  },
  "evidence.adapter-uppercase": {
    ...EVIDENCE, adapter_id: "LOCAL",
    expected: "INVALID_AUTHENTICATION_EVIDENCE", path: "$.authentication_evidence.adapter_id",
  },
  "evidence.adapter-underscore": {
    ...EVIDENCE, adapter_id: "local_adapter",
    expected: "INVALID_AUTHENTICATION_EVIDENCE", path: "$.authentication_evidence.adapter_id",
  },
  "evidence.adapter-too-long": {
    ...EVIDENCE, adapter_id: "a".repeat(65),
    expected: "INVALID_AUTHENTICATION_EVIDENCE", path: "$.authentication_evidence.adapter_id",
  },
  "evidence.adapter-trailing-dot": {
    ...EVIDENCE, adapter_id: "local.adapter.",
    expected: "INVALID_AUTHENTICATION_EVIDENCE", path: "$.authentication_evidence.adapter_id",
  },
  "evidence.adapter-trailing-dash": {
    ...EVIDENCE, adapter_id: "local-",
    expected: "INVALID_AUTHENTICATION_EVIDENCE", path: "$.authentication_evidence.adapter_id",
  },
  "evidence.adapter-single-char-valid-denied": {
    ...EVIDENCE, adapter_id: "a",
    expected: "AUTHORIZATION_DENIED", path: "$",
  },
  "evidence.opaque-leading-punct": {
    ...EVIDENCE, principal_ref: ".principal",
    expected: "INVALID_AUTHENTICATION_EVIDENCE", path: "$.authentication_evidence.principal_ref",
  },
  "evidence.opaque-uppercase-valid-denied": {
    ...EVIDENCE, principal_ref: "PRINCIPAL",
    expected: "AUTHORIZATION_DENIED", path: "$",
  },
  "evidence.opaque-space": {
    ...EVIDENCE, principal_ref: "principal ref",
    expected: "INVALID_AUTHENTICATION_EVIDENCE", path: "$.authentication_evidence.principal_ref",
  },
  "evidence.opaque-too-long": {
    ...EVIDENCE, principal_ref: "a".repeat(129),
    expected: "INVALID_AUTHENTICATION_EVIDENCE", path: "$.authentication_evidence.principal_ref",
  },
  "evidence.audience-uppercase-valid-denied": {
    ...EVIDENCE, audience: "LOCAL-AUDIENCE",
    expected: "AUTHORIZATION_DENIED", path: "$",
  },
  "evidence.session-uppercase-valid-denied": {
    ...EVIDENCE, session_ref: "SESSION-REF",
    expected: "AUTHORIZATION_DENIED", path: "$",
  },
  "evidence.issued-before-evaluation": {
    ...EVIDENCE, issued_at_ms: 101,
    expected: "AUTHORIZATION_DENIED", path: "$",
  },
  "evidence.issued-after-expiry": {
    ...EVIDENCE, issued_at_ms: 201, expires_at_ms: 200,
    expected: "AUTHORIZATION_DENIED", path: "$",
  },
  "evidence.provenance-empty": {
    ...EVIDENCE, provenance: "",
    expected: "INVALID_AUTHENTICATION_EVIDENCE", path: "$.authentication_evidence.provenance",
  },
  "evidence.provenance-uppercase": {
    ...EVIDENCE, provenance: "TRUSTED_LOCAL_ADAPTER",
    expected: "INVALID_AUTHENTICATION_EVIDENCE", path: "$.authentication_evidence.provenance",
  },
};

// raw-lexeme cases: the number token is replaced INSIDE the request_json
// string because JSON.stringify normalizes 1e2 -> 100 and 0.5 stays 0.5 but
// the scanner must see the original lexeme. Expected: MALFORMED_JSON at the
// member path (A02 scanner precedes A06 evidence).
const LEXEME_CASES = {
  "evidence.issued-fraction": { member: "issued_at_ms", token: "0", lexeme: "0.5", path: "$.authentication_evidence.issued_at_ms" },
  "evidence.issued-negative": { member: "issued_at_ms", token: "0", lexeme: "-1", path: "$.authentication_evidence.issued_at_ms" },
  "evidence.issued-exponent": { member: "issued_at_ms", token: "0", lexeme: "1e2", path: "$.authentication_evidence.issued_at_ms" },
  "evidence.issued-over-safe": { member: "issued_at_ms", token: "0", lexeme: "9007199254740992", path: "$.authentication_evidence.issued_at_ms" },
  "evidence.expires-fraction": { member: "expires_at_ms", token: "200", lexeme: "200.5", path: "$.authentication_evidence.expires_at_ms" },
  "evidence.expires-negative": { member: "expires_at_ms", token: "200", lexeme: "-200", path: "$.authentication_evidence.expires_at_ms" },
  "evidence.expires-exponent": { member: "expires_at_ms", token: "200", lexeme: "2e2", path: "$.authentication_evidence.expires_at_ms" },
  "evidence.expires-over-safe": { member: "expires_at_ms", token: "200", lexeme: "9007199254740992", path: "$.authentication_evidence.expires_at_ms" },
};

const baseRequest = JSON.parse(base.invocation_args.request_json);
const envelopeJson = base.invocation_args.envelope_json;

function makeCase(id, request, expected, path) {
  return {
    id,
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: typeof request === "string" ? request : JSON.stringify(request),
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: { kind: "rejected", code: expected, field_path: path },
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  };
}

const newCases = [];
for (const [id, spec] of Object.entries(CASES)) {
  const request = structuredClone(baseRequest);
  const { expected, path, ...evidence } = spec;
  request.authentication_evidence = evidence;
  newCases.push(makeCase(id, request, expected, path));
}
for (const [id, spec] of Object.entries(LEXEME_CASES)) {
  const request = JSON.stringify(baseRequest);
  const needle = `"${spec.member}":${spec.token}`;
  if (!request.includes(needle)) throw new Error(`token ${needle} not found for ${id}`);
  const replaced = request.replace(needle, `"${spec.member}":${spec.lexeme}`);
  newCases.push(makeCase(id, replaced, "MALFORMED_JSON", spec.path));
}

const existing = new Set(corpus.mandatory_case_ids);
for (const item of newCases) {
  if (existing.has(item.id)) throw new Error(`duplicate case id: ${item.id}`);
  existing.add(item.id);
  corpus.cases.push(item);
}
corpus.mandatory_case_ids = [...existing];

writeFileSync(corpusPath, JSON.stringify(corpus), "utf8");
console.log(`appended ${newCases.length} evidence-gate cases; corpus now ${corpus.cases.length} mandatory cases`);
