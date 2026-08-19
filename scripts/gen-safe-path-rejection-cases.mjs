#!/usr/bin/env node
// Generator: request-raw/path safe-path rejection gates for the local-admission
// evidence-alpha corpus (coverage-ledger request-raw/path row, "every safe-path
// class" subfamily).
//
// Closes the final remaining gap in the request-raw/path row:
//   "BOM, whitespace/comment/trailing variants, literal/escaped duplicates in
//    every request object, and every safe-path class"
//
// Prior slices in this lane closed the BOM/whitespace/comment/trailing variants
// (tick-62) and the literal/escaped duplicates in the top-level request
// (tick-92) and per-request-object (tick-97). This slice closes the
// "every safe-path class" gap: when a request object declares an UNKNOWN member
// at a safe-path parent, the evaluator rejects at the SAFE PATH PARENT
// projection — never at the unknown member's projected dotted form, because
// the member name itself is not in the allowlist.
//
// New cases (corpus 49 -> 54):
//   - request.safe-path-auth-evidence-unknown-member
//       inject {"bogus_evidence_member":"x"} at the START of authentication_evidence
//       -> INVALID_AUTHENTICATION_EVIDENCE at $.authentication_evidence
//   - request.safe-path-binding-snapshot-unknown-member
//       inject {"bogus_snapshot_member":"x"} at the START of binding_snapshot
//       -> INVALID_BINDING_SNAPSHOT at $.binding_snapshot
//   - request.safe-path-authorization-snapshot-unknown-member
//       inject {"bogus_authorization_member":"x"} at the START of
//       authorization_snapshot
//       -> INVALID_AUTHORIZATION_SNAPSHOT at $.authorization_snapshot
//   - request.safe-path-binding-rules-unknown-member
//       inject {"bogus_rule_member":"x"} at the START of binding_snapshot.rules[0]
//       -> INVALID_BINDING_SNAPSHOT at $.binding_snapshot.rules[0]
//   - request.safe-path-authorization-rules-unknown-member
//       inject {"bogus_authz_rule_member":"x"} at the START of
//       authorization_snapshot.rules[0]
//       -> INVALID_AUTHORIZATION_SNAPSHOT at $.authorization_snapshot.rules[0]
//
// The unknown member name matches pathMember()'s /^[A-Za-z_][A-Za-z0-9_]*$/
// regex so the dotted form WOULD be visible if the evaluator ever tried to
// surface it — the parent-rejection behavior is the gate this slice proves.
//
// Every case rejects during request parsing / snapshot validation and never
// reaches envelope decode or the replay oracle (replay_oracle_calls: 0).
//
// Pristine-49 backup: this script requires the corpus to be at 49 cases before
// splicing. The script is idempotent after splicing because every inserted
// case id is unique.

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const pristineBackup = "/tmp/corpus-pristine-49.json";

if (existsSync(pristineBackup)) {
  // already backed up earlier in the session
} else {
  copyFileSync(corpusPath, pristineBackup);
  console.log(`Backed up pristine-49 corpus to ${pristineBackup}`);
}

const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const pristine = JSON.parse(readFileSync(pristineBackup, "utf8"));
if (corpus.cases.length !== pristine.cases.length) {
  throw new Error(
    `corpus at ${corpus.cases.length} cases (expected pristine ${pristine.cases.length}). ` +
    `Refusing to splice into a corpus that has already been modified. ` +
    `Restore from ${pristineBackup} or rebase onto origin/main.`,
  );
}

const valid = corpus.cases.find((c) => c.id === "valid.admission-plan");
if (!valid) throw new Error("valid.admission-plan fixture missing");

const envelopeJson = valid.invocation_args.envelope_json;
const baseRequest = valid.invocation_args.request_json;

// Per-case raw-string surgery: each anchor is unique to its parent
// object so the .replace() cannot match elsewhere. The injected member
// name matches pathMember()'s safe-name regex so the projected dotted
// form WOULD be visible if the evaluator ever tried to surface it —
// the parent-rejection behavior is the gate this slice proves.
const surgeries = [
  // authentication_evidence: anchor on the unique provenance string
  {
    id: "request.safe-path-auth-evidence-unknown-member",
    needle: '{"adapter_id":"local.adapter","principal_ref":"principal-ref","audience":"local-audience","session_ref":"session-ref","issued_at_ms":0,"expires_at_ms":200,"provenance":"trusted_local_adapter"}',
    insertion: '{"bogus_evidence_member":"x","adapter_id":"local.adapter","principal_ref":"principal-ref","audience":"local-audience","session_ref":"session-ref","issued_at_ms":0,"expires_at_ms":200,"provenance":"trusted_local_adapter"}',
    expectedCode: "INVALID_AUTHENTICATION_EVIDENCE",
    expectedPath: "$.authentication_evidence",
  },
  // binding_snapshot: anchor on the unique snapshot_id value "binding-fixture"
  {
    id: "request.safe-path-binding-snapshot-unknown-member",
    needle: '"snapshot_id":"binding-fixture"',
    insertion: '"bogus_snapshot_member":"x","snapshot_id":"binding-fixture"',
    expectedCode: "INVALID_BINDING_SNAPSHOT",
    expectedPath: "$.binding_snapshot",
  },
  // authorization_snapshot: anchor on the unique snapshot_id value "authorization-fixture"
  {
    id: "request.safe-path-authorization-snapshot-unknown-member",
    needle: '"snapshot_id":"authorization-fixture"',
    insertion: '"bogus_authorization_member":"x","snapshot_id":"authorization-fixture"',
    expectedCode: "INVALID_AUTHORIZATION_SNAPSHOT",
    expectedPath: "$.authorization_snapshot",
  },
  // binding_snapshot.rules[0]: anchor on the unique rule body (binding rules
  // have ONLY 5 known members: adapter_id, principal_ref, audience, session_ref,
  // sender — no action/message_types/recipients)
  {
    id: "request.safe-path-binding-rules-unknown-member",
    needle: '[{"adapter_id":"local.adapter","principal_ref":"principal-ref","audience":"local-audience","session_ref":"session-ref","sender":{"namespace":"local","agent_id":"agent-a"}}]',
    insertion: '[{"bogus_rule_member":"x","adapter_id":"local.adapter","principal_ref":"principal-ref","audience":"local-audience","session_ref":"session-ref","sender":{"namespace":"local","agent_id":"agent-a"}}]',
    expectedCode: "INVALID_BINDING_SNAPSHOT",
    expectedPath: "$.binding_snapshot.rules[0]",
  },
  // authorization_snapshot.rules[0]: anchor on the unique rule body
  // (authorization rules have action/message_types/recipients in addition to
  // the 5 binding-common members)
  {
    id: "request.safe-path-authorization-rules-unknown-member",
    needle: '[{"adapter_id":"local.adapter","principal_ref":"principal-ref","audience":"local-audience","session_ref":"session-ref","sender":{"namespace":"local","agent_id":"agent-a"},"action":"a2a.message.admit","message_types":["handoff"],"recipients":[{"namespace":"local","agent_id":"agent-b"}]}]',
    insertion: '[{"bogus_authz_rule_member":"x","adapter_id":"local.adapter","principal_ref":"principal-ref","audience":"local-audience","session_ref":"session-ref","sender":{"namespace":"local","agent_id":"agent-a"},"action":"a2a.message.admit","message_types":["handoff"],"recipients":[{"namespace":"local","agent_id":"agent-b"}]}]',
    expectedCode: "INVALID_AUTHORIZATION_SNAPSHOT",
    expectedPath: "$.authorization_snapshot.rules[0]",
  },
];

// Apply the surgery for each case.
const rejectRaw = (code, path) => ({ kind: "rejected", code, field_path: path });

const newCases = surgeries.map(({ id, needle, insertion, expectedCode, expectedPath }) => {
  if (!baseRequest.includes(needle)) {
    throw new Error(`anchor for ${id} not found in base request — anchor must be unique to the parent object`);
  }
  const occurrenceCount = baseRequest.split(needle).length - 1;
  if (occurrenceCount !== 1) {
    throw new Error(`anchor for ${id} matched ${occurrenceCount} times (expected exactly 1) — pick a more specific anchor`);
  }
  const modifiedRequest = baseRequest.replace(needle, insertion);
  if (!modifiedRequest.includes(insertion)) {
    throw new Error(`insertion for ${id} not applied — check the replacement`);
  }
  return {
    id,
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: modifiedRequest,
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejectRaw(expectedCode, expectedPath),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  };
});

// Splice in semantic-order after the last existing request.* case on origin/main
// so the request.* prefix group remains monotonic in the corpus file.
const lastRequestCaseId = "request.byte-262145";
const idx = corpus.cases.findIndex((c) => c.id === lastRequestCaseId);
if (idx === -1) throw new Error(`${lastRequestCaseId} not found in corpus`);

// Refuse to double-insert.
for (const item of newCases) {
  if (corpus.cases.some((c) => c.id === item.id)) {
    throw new Error(`case ${item.id} already present — refusing to double-insert`);
  }
  if (corpus.mandatory_case_ids.includes(item.id)) {
    throw new Error(`id ${item.id} already in mandatory_case_ids — refusing to double-insert`);
  }
}

corpus.cases.splice(idx + 1, 0, ...newCases);
corpus.mandatory_case_ids = corpus.cases.map((c) => c.id);

const unique = new Set(corpus.mandatory_case_ids);
if (unique.size !== corpus.mandatory_case_ids.length) {
  throw new Error("duplicate ids after splice");
}

writeFileSync(corpusPath, JSON.stringify(corpus) + "\n");
console.log(`Spliced ${newCases.length} safe-path rejection cases into the corpus.`);
console.log(`Corpus size: ${corpus.cases.length} cases (${corpus.mandatory_case_ids.length} mandatory ids).`);