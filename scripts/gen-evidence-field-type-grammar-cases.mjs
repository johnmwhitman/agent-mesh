#!/usr/bin/env node
// Generator for Section 9 authentication-evidence field-type and field-grammar
// bounded subfamily cases. Idempotent: running on a corpus that already contains
// the six cases is a no-op; running on the pristine 49-case corpus adds them.
//
// Cases added (6):
//   evidence.adapter_id-invalid-type       — number 42 (fails validAdapter typeof-string)
//   evidence.adapter_id-invalid-grammar    — "-leading-dash" (fails ADAPTER_ID regex leading-char)
//   evidence.principal_ref-invalid-type    — boolean true (fails validOpaque typeof-string)
//   evidence.principal_ref-invalid-grammar — "" (fails OPAQUE_REF min-length)
//   evidence.issued_at_ms-invalid-type     — string "abc" (fails localTime typeof-number)
//   evidence.expires_at_ms-invalid-type    — boolean false (fails localTime typeof-number)
//
// All six reject as INVALID_AUTHENTICATION_EVIDENCE at their exact field path
// with zero replay oracle calls. issued_at_ms/expires_at_ms grammar is not
// tested separately because the scanner admits numeric lexemes only and the
// type check covers non-number values; numeric-lexeme boundaries belong to the
// depth/numeric family.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");

const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

const newCaseIds = [
  "evidence.adapter_id-invalid-type",
  "evidence.adapter_id-invalid-grammar",
  "evidence.principal_ref-invalid-type",
  "evidence.principal_ref-invalid-grammar",
  "evidence.issued_at_ms-invalid-type",
  "evidence.expires_at_ms-invalid-type",
];

// Idempotency: if all six already exist, no-op.
const existing = new Set(corpus.mandatory_case_ids);
if (newCaseIds.every((id) => existing.has(id))) {
  console.log(`All ${newCaseIds.length} evidence field-type/grammar cases already present; no-op.`);
  process.exit(0);
}

// Find the valid.admission-plan case (corpus.cases[0]) to clone the base shape.
const validCase = corpus.cases.find((c) => c.id === "valid.admission-plan");
if (!validCase) {
  console.error("FATAL: valid.admission-plan case not found in corpus.");
  process.exit(1);
}

const validRequest = JSON.parse(validCase.invocation_args.request_json);
const validEvidence = validRequest.authentication_evidence;

// Base evidence for mutation — same as the valid case but with 200ms lifetime.
const baseEvidence = {
  adapter_id: "local.adapter",
  principal_ref: "principal-ref",
  audience: "local-audience",
  session_ref: "session-ref",
  issued_at_ms: 0,
  expires_at_ms: 200,
  provenance: "trusted_local_adapter",
};

const rejected = (fieldPath) => ({
  result: { kind: "rejected", code: "INVALID_AUTHENTICATION_EVIDENCE", field_path: fieldPath },
  replay_oracle_calls: 0,
  replay_oracle_arguments: [],
});

const mutations = [
  {
    id: "evidence.adapter_id-invalid-type",
    evidence: { ...baseEvidence, adapter_id: 42 },
    expected: rejected("$.authentication_evidence.adapter_id"),
    note: "number 42 — fails validAdapter typeof-string requirement",
  },
  {
    id: "evidence.adapter_id-invalid-grammar",
    evidence: { ...baseEvidence, adapter_id: "-leading-dash" },
    expected: rejected("$.authentication_evidence.adapter_id"),
    note: '"-leading-dash" — fails ADAPTER_ID regex leading-char requirement',
  },
  {
    id: "evidence.principal_ref-invalid-type",
    evidence: { ...baseEvidence, principal_ref: true },
    expected: rejected("$.authentication_evidence.principal_ref"),
    note: "boolean true — fails validOpaque typeof-string requirement",
  },
  {
    id: "evidence.principal_ref-invalid-grammar",
    evidence: { ...baseEvidence, principal_ref: "" },
    expected: rejected("$.authentication_evidence.principal_ref"),
    note: 'empty string "" — fails OPAQUE_REF regex min-length requirement',
  },
  {
    id: "evidence.issued_at_ms-invalid-type",
    evidence: { ...baseEvidence, issued_at_ms: "abc" },
    expected: rejected("$.authentication_evidence.issued_at_ms"),
    note: 'string "abc" — scanner admits as string, then localTime typeof-number rejects',
  },
  {
    id: "evidence.expires_at_ms-invalid-type",
    evidence: { ...baseEvidence, expires_at_ms: false },
    expected: rejected("$.authentication_evidence.expires_at_ms"),
    note: "boolean false — scanner admits as boolean, then localTime typeof-number rejects",
  },
];

// Insert new cases right after the existing evidence cases (after evidence.lifetime-300001-denied).
const lastEvidenceIdx = corpus.cases.findIndex((c) => c.id === "evidence.lifetime-300001-denied");
if (lastEvidenceIdx === -1) {
  console.error("FATAL: evidence.lifetime-300001-denied not found — corpus shape changed.");
  process.exit(1);
}

const newCases = [];
for (const m of mutations) {
  if (existing.has(m.id)) continue;
  const request = { ...validRequest, authentication_evidence: m.evidence };
  newCases.push({
    id: m.id,
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: JSON.stringify(request),
      envelope_json: validCase.invocation_args.envelope_json,
      replay_oracle_result: "unseen",
    },
    expected: m.expected,
  });
}

// Insert after last evidence case.
corpus.cases.splice(lastEvidenceIdx + 1, 0, ...newCases);

// Update mandatory_case_ids to match the new case order.
corpus.mandatory_case_ids = corpus.cases.map((c) => c.id);

writeFileSync(corpusPath, JSON.stringify(corpus, null, 2) + "\n", "utf8");
console.log(`Added ${newCases.length} evidence field-type/grammar cases. Corpus now ${corpus.mandatory_case_ids.length} cases.`);