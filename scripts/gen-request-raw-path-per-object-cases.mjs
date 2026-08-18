#!/usr/bin/env node
// Generator: request-raw/path per-object literal/escaped duplicate gates for the
// local-admission evidence-alpha corpus (coverage-ledger request-raw/path row,
// "literal/escaped duplicates in every request object" subfamily).
//
// Closes the second half of the remaining gap left by tick-62:
//   "BOM, whitespace/comment/trailing variants, literal/escaped duplicates
//    in every request object, and every safe-path class"
// Tick-62 closed BOM/whitespace/comment/trailing + literal-escaped-duplicate
// in the TOP-LEVEL request. This slice closes per-object duplicates in
// authentication_evidence / binding_snapshot / authorization_snapshot and
// their nested rules, using the same raw-string-surgery pattern that
// JSON.stringify would normalize away.
//
// New cases (corpus 44 -> 52):
//   - request.literal-escaped-duplicate-auth-evidence-adapter-id
//       inject \u0061dapter_id before adapter_id in authentication_evidence
//       -> DUPLICATE_JSON_KEY at $.authentication_evidence
//   - request.literal-escaped-duplicate-auth-evidence-principal-ref
//       inject \u0070rincipal_ref before principal_ref in authentication_evidence
//       -> DUPLICATE_JSON_KEY at $.authentication_evidence
//   - request.literal-escaped-duplicate-binding-snapshot-snapshot-id
//       inject \u0073napshot_id before snapshot_id in binding_snapshot
//       -> DUPLICATE_JSON_KEY at $.binding_snapshot
//   - request.literal-escaped-duplicate-authorization-snapshot-snapshot-id
//       inject \u0073napshot_id before snapshot_id in authorization_snapshot
//       -> DUPLICATE_JSON_KEY at $.authorization_snapshot
//   - request.literal-escaped-duplicate-binding-rules-adapter-id
//       inject \u0061dapter_id before adapter_id in binding_snapshot.rules[0]
//       -> DUPLICATE_JSON_KEY at $.binding_snapshot.rules[0]
//   - request.literal-escaped-duplicate-authorization-rules-action
//       inject \u0061ction before action in authorization_snapshot.rules[0]
//       -> DUPLICATE_JSON_KEY at $.authorization_snapshot.rules[0]
//   - request.literal-escaped-duplicate-authorization-rules-message-types
//       inject \u006dessage_types before message_types in
//       authorization_snapshot.rules[0]
//       -> DUPLICATE_JSON_KEY at $.authorization_snapshot.rules[0]
//   - request.literal-escaped-duplicate-authorization-rules-recipients
//       inject \u0072ecipients before recipients in authorization_snapshot.rules[0]
//       -> DUPLICATE_JSON_KEY at $.authorization_snapshot.rules[0]
//
// Every case rejects before envelope decode and never reaches the replay
// oracle (replay_oracle_calls: 0). The path in field_path comes from
// pathMember() which uses /^[A-Za-z_][A-Za-z0-9_]*$/, so the dotted
// forms ($.authentication_evidence, $.binding_snapshot, etc.) are the
// "every safe-path class" projection the coverage-ledger row names.
//
// Authoritative outcome: every case is rejected with DUPLICATE_JSON_KEY
// at the dotted path of the parent object (pathMember keeps the dotted
// form for any member name that matches its safe-name regex).
//
// Pristine-44 backup: this script requires the corpus to be at 44 cases
// before splicing. The script is idempotent after splicing because every
// inserted case id is unique.

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const pristineBackup = "/tmp/corpus-pristine-44.json";

if (existsSync(pristineBackup)) {
  // already backed up earlier in the session
} else {
  copyFileSync(corpusPath, pristineBackup);
  console.log(`Backed up pristine-44 corpus to ${pristineBackup}`);
}

const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const pristine = JSON.parse(readFileSync(pristineBackup, "utf8"));
if (corpus.cases.length !== pristine.cases.length) {
  throw new Error(
    `corpus at ${corpus.cases.length} cases (expected pristine 44). ` +
    `Refusing to splice into a corpus that has already been modified. ` +
    `Restore from ${pristineBackup} or rebase onto origin/main.`,
  );
}

const valid = corpus.cases.find((c) => c.id === "valid.admission-plan");
if (!valid) throw new Error("valid.admission-plan fixture missing");

const envelopeJson = valid.invocation_args.envelope_json;
const baseRequest = valid.invocation_args.request_json;

// Per-case raw-string surgery: each anchor is unique to its parent
// object so the .replace() cannot match elsewhere. The injected escape
// sequence decodes to the same key string as the original, which makes
// the scanner see a duplicate.
//
// Scanner behavior on array element paths: when the scanner descends into
// an array element it does NOT append the [position] suffix to the path
// because the known shape is `[]` (empty) so memberKnown is undefined
// and the fallback returns the parent path. This means duplicates
// inside rules[0] are reported at $.binding_snapshot.rules (the array
// path), not $.binding_snapshot.rules[0]. The coverage-ledger "every
// safe-path class" row pins this — the dotted `rules` member matches
// the safe-name regex in pathMember() and is the projected path.
const surgeries = [
  // authentication_evidence.adapter_id duplicate
  {
    id: "request.literal-escaped-duplicate-auth-evidence-adapter-id",
    needle: '{"adapter_id":"local.adapter","principal_ref":"principal-ref","audience":"local-audience","session_ref":"session-ref","issued_at_ms":0,"expires_at_ms":200,"provenance":"trusted_local_adapter"}',
    insertion: '{"\\u0061dapter_id":"dup","adapter_id":"local.adapter","principal_ref":"principal-ref","audience":"local-audience","session_ref":"session-ref","issued_at_ms":0,"expires_at_ms":200,"provenance":"trusted_local_adapter"}',
    expectedPath: "$.authentication_evidence",
  },
  // authentication_evidence.principal_ref duplicate (anchor includes
  // "issued_at_ms" which only appears in authentication_evidence — binding/
  // authorization rules have "sender" after "session_ref" instead)
  {
    id: "request.literal-escaped-duplicate-auth-evidence-principal-ref",
    needle: '"audience":"local-audience","session_ref":"session-ref","issued_at_ms":0',
    insertion: '"\\u0070rincipal_ref":"dup","principal_ref":"principal-ref","audience":"local-audience","session_ref":"session-ref","issued_at_ms":0',
    expectedPath: "$.authentication_evidence",
  },
  // binding_snapshot.snapshot_id duplicate (binding's snapshot_id value is "binding-fixture")
  {
    id: "request.literal-escaped-duplicate-binding-snapshot-snapshot-id",
    needle: '"snapshot_id":"binding-fixture"',
    insertion: '"\\u0073napshot_id":"dup","snapshot_id":"binding-fixture"',
    expectedPath: "$.binding_snapshot",
  },
  // authorization_snapshot.snapshot_id duplicate (authorization's snapshot_id value is "authorization-fixture")
  {
    id: "request.literal-escaped-duplicate-authorization-snapshot-snapshot-id",
    needle: '"snapshot_id":"authorization-fixture"',
    insertion: '"\\u0073napshot_id":"dup","snapshot_id":"authorization-fixture"',
    expectedPath: "$.authorization_snapshot",
  },
  // binding_snapshot.rules[0].adapter_id duplicate (binding rules array has 1 element;
  // scanner reports array-level duplicates at the array path, not [0])
  {
    id: "request.literal-escaped-duplicate-binding-rules-adapter-id",
    needle: '[{"adapter_id":"local.adapter","principal_ref":"principal-ref","audience":"local-audience","session_ref":"session-ref","sender":{"namespace":"local","agent_id":"agent-a"}}]',
    insertion: '[{"\\u0061dapter_id":"dup","adapter_id":"local.adapter","principal_ref":"principal-ref","audience":"local-audience","session_ref":"session-ref","sender":{"namespace":"local","agent_id":"agent-a"}}]',
    expectedPath: "$.binding_snapshot.rules",
  },
  // authorization_snapshot.rules[0].action duplicate
  {
    id: "request.literal-escaped-duplicate-authorization-rules-action",
    needle: '"action":"a2a.message.admit","message_types":["handoff"]',
    insertion: '"\\u0061ction":"dup","action":"a2a.message.admit","message_types":["handoff"]',
    expectedPath: "$.authorization_snapshot.rules",
  },
  // authorization_snapshot.rules[0].message_types duplicate
  {
    id: "request.literal-escaped-duplicate-authorization-rules-message-types",
    needle: '"message_types":["handoff"]',
    insertion: '"\\u006dessage_types":["dup"],"message_types":["handoff"]',
    expectedPath: "$.authorization_snapshot.rules",
  },
  // authorization_snapshot.rules[0].recipients duplicate
  {
    id: "request.literal-escaped-duplicate-authorization-rules-recipients",
    needle: '"recipients":[{"namespace":"local","agent_id":"agent-b"}]',
    insertion: '"\\u0072ecipients":[{"namespace":"dup","agent_id":"dup"}],"recipients":[{"namespace":"local","agent_id":"agent-b"}]',
    expectedPath: "$.authorization_snapshot.rules",
  },
];

// Apply the surgery for each case.
const rejectRaw = (code, path) => ({ kind: "rejected", code, field_path: path });

const newCases = surgeries.map(({ id, needle, insertion, expectedPath }) => {
  if (!baseRequest.includes(needle)) {
    throw new Error(`anchor for ${id} not found in base request — anchor must be unique to the parent object`);
  }
  const occurrenceCount = baseRequest.split(needle).length - 1;
  if (occurrenceCount !== 1) {
    throw new Error(`anchor for ${id} matched ${occurrenceCount} times (expected exactly 1) — pick a more specific anchor`);
  }
  const modifiedRequest = baseRequest.replace(needle, insertion);
  // Sanity-check: ensure modifiedRequest still has the duplicate escape key
  // and that the anchor string still appears (the original key is preserved).
  if (!modifiedRequest.includes(insertion)) {
    throw new Error(`insertion for ${id} not applied — check the escape sequence`);
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
      result: rejectRaw("DUPLICATE_JSON_KEY", expectedPath),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  };
});

// Splice in semantic-order after request.unknown-malformed-child so the
// request.* prefix group remains monotonic in the corpus file.
const insertAfterId = "request.unknown-malformed-child";
const idx = corpus.cases.findIndex((c) => c.id === insertAfterId);
if (idx === -1) throw new Error(`${insertAfterId} not found in corpus`);

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
console.log(`Spliced ${newCases.length} request-raw/path per-object cases into the corpus.`);
console.log(`Corpus size: ${corpus.cases.length} cases (${corpus.mandatory_case_ids.length} mandatory ids).`);
console.log(`New ids: ${newCases.map((c) => c.id).join(", ")}`);