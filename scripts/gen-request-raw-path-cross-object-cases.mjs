#!/usr/bin/env node
// Generator: request-raw/path cross-object / array-boundary / non-safe-member
// gates for the local-admission evidence-alpha corpus
// (coverage-ledger request-raw/path row, "remaining exact gap" subfamily).
//
// Closes the third bounded subfamily on the row that the coverage-ledger
// names as "cross-object/array-boundary duplicates, non-safe-member projection":
//
//   1. cross-object duplicate (negative pin) — same key NAME appearing
//      in two different request objects must NOT be detected as a
//      DUPLICATE_JSON_KEY (each object has its own keys Set).
//   2. array-boundary duplicate (negative pin) — same key NAME appearing
//      in two different array elements must NOT be detected as a
//      DUPLICATE_JSON_KEY (each array element is a fresh object with
//      its own keys Set).
//   3. non-safe-member duplicate (positive pin) — a duplicate key whose
//      name contains a non-safe character (e.g. "-") IS detected as a
//      DUPLICATE_JSON_KEY, but pathMember() drops the suffix because
//      the safe-name regex is /^[A-Za-z_][A-Za-z0-9_]*$/ — the projected
//      path is the parent object (or the array path when the duplicate
//      is inside an array element whose known shape is []).
//
// Tick-62 closed the BOM/whitespace/comment/trailing + literal-escaped
// top-level subfamily. Tick-68 closed the per-object literal/escaped
// subfamily. This slice closes the remaining cross-object / array-boundary
// / non-safe-member subfamily.
//
// New cases (corpus 44 -> 49):
//   - request.cross-object-binding-rules-session-ref
//       replace binding_snapshot.rules[0].session_ref value "session-ref"
//       with "dup"; the key "session_ref" now appears in both
//       authentication_evidence (value "session-ref") AND
//       binding_snapshot.rules[0] (value "dup"). Each object has its own
//       keys Set, so the scanner does NOT detect a cross-object duplicate.
//       The binding tuple check fails (session_ref mismatch) ->
//       AUTHORIZATION_DENIED @ $ with 0 replay-oracle calls.
//   - request.array-boundary-binding-rules-adapter-id
//       add a second binding rule with adapter_id="local.adapter" and a
//       different principal_ref="other-principal"; rules[0] and rules[1]
//       share the adapter_id NAME (different VALUE) but each array
//       element has its own keys Set, so the scanner does NOT detect
//       the array-boundary duplicate. rules[0] still matches the
//       evidence tuple -> admission_plan with the unchanged 4A digest
//       and 1 replay-oracle call (envelope_digest matches
//       valid.admission-plan).
//   - request.non-safe-member-auth-evidence-session-ref-dash
//       inject two keys with the non-safe name "session-ref" (dash) at
//       the head of authentication_evidence; Set sees both as the same
//       key, the scanner throws DUPLICATE_JSON_KEY, and pathMember
//       drops the suffix because the safe-name regex rejects names
//       containing "-". Projected path: $.authentication_evidence.
//       0 replay-oracle calls.
//   - request.non-safe-member-binding-snapshot-snapshot-id-dash
//       inject two keys with the non-safe name "snapshot-id" before
//       binding_snapshot.snapshot_id; the duplicate is detected and
//       pathMember drops the suffix. Projected path: $.binding_snapshot.
//       0 replay-oracle calls.
//   - request.non-safe-member-auth-rules-message-types-dash
//       inject two keys with the non-safe name "message-types" before
//       authorization_snapshot.rules[0].message_types; the duplicate is
//       detected and pathMember drops the suffix. Projected path:
//       $.authorization_snapshot.rules (the scanner drops the [position]
//       suffix because the known shape is [], per tick-68 precedent).
//       0 replay-oracle calls.
//
// Pristine-44 backup: this script requires the corpus to be at 44 cases
// before splicing. The script is idempotent after splicing because every
// inserted case id is unique.
//
// Write format: JSON.stringify(corpus) + "\n" (compact + trailing newline)
// to preserve the existing test "Python witness rejects ambiguous,
// nonstandard, and open corpus documents" whose first mutation expects
// compact whitespace.
//
// Authoritative outcomes: every case's expected outcome is pinned by a
// TS dist probe (scripts/probe-cross-object.mjs, run before splice) and
// a Python witness (post-splice, 49/49 ok). Authoritative envelope
// digest for the array-boundary case: 9dd42da4...c5606 (unchanged 4A).

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
// Replay-oracle arguments for the array-boundary case mirror the
// canonical valid.admission-plan replay query (the array-boundary case
// admits with the unchanged 4A digest and triggers exactly one
// replay-oracle call with the same arguments).
const replayOracleArgs = valid.expected.replay_oracle_arguments;

// Each surgery mutates the request via raw-string surgery. Every anchor
// is unique to its parent context so the .replace() cannot match
// elsewhere. The cross-object and array-boundary cases use anchor-once
// replacement (the needle appears exactly once in baseRequest); the
// non-safe-member cases insert a new pair of keys before an existing
// unique anchor.
const surgeries = [
  // cross-object: change binding rule's session_ref value from
  // "session-ref" to "dup". The key "session_ref" already exists in
  // authentication_evidence with value "session-ref"; the per-object
  // Set keeps these independent. Result: AUTHORIZATION_DENIED @ $.
  {
    id: "request.cross-object-binding-rules-session-ref",
    needle:
      '"rules":[{"adapter_id":"local.adapter","principal_ref":"principal-ref","audience":"local-audience","session_ref":"session-ref","sender":{"namespace":"local","agent_id":"agent-a"}}]}',
    insertion:
      '"rules":[{"adapter_id":"local.adapter","principal_ref":"principal-ref","audience":"local-audience","session_ref":"dup","sender":{"namespace":"local","agent_id":"agent-a"}}]}',
    expected: { code: "AUTHORIZATION_DENIED", field_path: "$" },
    replay_calls: 0,
    replay_args: [],
  },
  // array-boundary: add a second binding rule that shares the
  // adapter_id NAME with rules[0] but has a different principal_ref.
  // Each array element has its own Set so the scanner does not detect
  // a duplicate. Result: admission_plan with unchanged 4A digest,
  // 1 replay-oracle call.
  {
    id: "request.array-boundary-binding-rules-adapter-id",
    needle:
      '"rules":[{"adapter_id":"local.adapter","principal_ref":"principal-ref","audience":"local-audience","session_ref":"session-ref","sender":{"namespace":"local","agent_id":"agent-a"}}]},"authorization_snapshot"',
    insertion:
      '"rules":[{"adapter_id":"local.adapter","principal_ref":"principal-ref","audience":"local-audience","session_ref":"session-ref","sender":{"namespace":"local","agent_id":"agent-a"}},{"adapter_id":"local.adapter","principal_ref":"other-principal","audience":"local-audience","session_ref":"session-ref","sender":{"namespace":"local","agent_id":"agent-a"}}]},"authorization_snapshot"',
    expected: { code: "admission_plan" },
    replay_calls: 1,
    replay_args: replayOracleArgs,
  },
  // non-safe-member (auth evidence): two "session-ref" keys with a
  // dash. Set detects duplicate, pathMember drops suffix -> parent.
    // Anchor: the start of authentication_evidence (must be unique
    // to that object — it appears only at the start of the evidence
    // object inside the request).
  {
    id: "request.non-safe-member-auth-evidence-session-ref-dash",
    needle:
      '{"adapter_id":"local.adapter","principal_ref":"principal-ref","audience":"local-audience","session_ref":"session-ref","issued_at_ms":0,"expires_at_ms":200,"provenance":"trusted_local_adapter"}',
    insertion:
      '{"session-ref":"dup","session-ref":"real","adapter_id":"local.adapter","principal_ref":"principal-ref","audience":"local-audience","session_ref":"session-ref","issued_at_ms":0,"expires_at_ms":200,"provenance":"trusted_local_adapter"}',
    expected: { code: "DUPLICATE_JSON_KEY", field_path: "$.authentication_evidence" },
    replay_calls: 0,
    replay_args: [],
  },
  // non-safe-member (binding snapshot): two "snapshot-id" keys with a
  // dash before the original "snapshot_id". Anchor: unique value
  // "binding-fixture" (appears only inside binding_snapshot).
  {
    id: "request.non-safe-member-binding-snapshot-snapshot-id-dash",
    needle: '"snapshot_id":"binding-fixture"',
    insertion: '"snapshot-id":"dup","snapshot-id":"real","snapshot_id":"binding-fixture"',
    expected: { code: "DUPLICATE_JSON_KEY", field_path: "$.binding_snapshot" },
    replay_calls: 0,
    replay_args: [],
  },
  // non-safe-member (authorization rules): two "message-types" keys
  // with a dash. Anchor: unique value "handoff" inside the message
  // types array (appears only inside authorization_snapshot.rules[0]).
  {
    id: "request.non-safe-member-auth-rules-message-types-dash",
    needle: '"message_types":["handoff"]',
    insertion: '"message-types":["dup"],"message-types":["real"],"message_types":["handoff"]',
    expected: { code: "DUPLICATE_JSON_KEY", field_path: "$.authorization_snapshot.rules" },
    replay_calls: 0,
    replay_args: [],
  },
];

// Apply the surgery for each case.
const newCases = surgeries.map(({ id, needle, insertion, expected, replay_calls, replay_args }) => {
  if (!baseRequest.includes(needle)) {
    throw new Error(`anchor for ${id} not found in base request — anchor must be unique to the parent context`);
  }
  const occurrenceCount = baseRequest.split(needle).length - 1;
  if (occurrenceCount !== 1) {
    throw new Error(`anchor for ${id} matched ${occurrenceCount} times (expected exactly 1) — pick a more specific anchor`);
  }
  const modifiedRequest = baseRequest.replace(needle, insertion);
  if (!modifiedRequest.includes(insertion)) {
    throw new Error(`insertion for ${id} not applied — check the surgery`);
  }
  const expectedResult =
    expected.code === "admission_plan"
      ? valid.expected.result
      : { kind: "rejected", code: expected.code, field_path: expected.field_path };
  return {
    id,
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: modifiedRequest,
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: expectedResult,
      replay_oracle_calls: replay_calls,
      replay_oracle_arguments: replay_args,
    },
  };
});

// Splice in semantic-order after request.unknown-malformed-child so the
// request.* prefix group remains monotonic in the corpus file (matches
// tick-62 + tick-68 splice-order convention).
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
console.log(`Spliced ${newCases.length} request-raw/path cross-object / array-boundary / non-safe-member cases into the corpus.`);
console.log(`Corpus size: ${corpus.cases.length} cases (${corpus.mandatory_case_ids.length} mandatory ids).`);
console.log(`New ids: ${newCases.map((c) => c.id).join(", ")}`);
