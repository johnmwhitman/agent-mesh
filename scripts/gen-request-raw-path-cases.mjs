#!/usr/bin/env node
// Generator: request-raw/path bounded subfamily gates for the
// local-admission evidence-alpha corpus (coverage-ledger request-raw/path
// row, "BOM / whitespace / comment / trailing variants" subfamily).
//
// Closes a portion of the remaining gap:
//   "BOM, whitespace/comment/trailing variants, literal/escaped
//    duplicates in every request object, and every safe-path class"
// This slice covers the BOM/whitespace/comment/trailing + literal-escaped
// duplicate half, leaving "literal/escaped duplicates in every request
// object" (per-member coverage across authentication_evidence /
// binding_snapshot / authorization_snapshot) and "every safe-path class"
// for a future approved slice. The 11 new cases pin exact prefixes so
// the parser cannot silently accept a non-JSON or comment-shaped input.
//
// New cases (corpus 44 -> 55):
//   - request.bom-leading                 leading U+FEFF -> INVALID_UTF8 at $
//   - request.whitespace-form-feed        U+000C between { and content -> MALFORMED_JSON at $
//   - request.whitespace-vertical-tab     U+000B -> MALFORMED_JSON at $
//   - request.whitespace-nel              U+0085 NEL -> MALFORMED_JSON at $
//   - request.whitespace-line-separator   U+2028 LS -> MALFORMED_JSON at $
//   - request.whitespace-paragraph-separator U+2029 PS -> MALFORMED_JSON at $
//   - request.comment-line                leading // line comment -> MALFORMED_JSON at $
//   - request.comment-block               leading /* */ block comment -> MALFORMED_JSON at $
//   - request.trailing-garbage            valid + "{"
//                                         -> MALFORMED_JSON at $
//   - request.trailing-comma              valid + " ,\n"
//                                         -> MALFORMED_JSON at $
//   - request.literal-escaped-duplicate-key
//                                         "version" + "\u0076ersion" keys both present
//                                         -> DUPLICATE_JSON_KEY at $
//                                         (raw-string surgery required because
//                                          JSON.stringify normalizes \u0076 -> v)
//
// Authoritative outcome: every case is rejected before envelope decode
// and never reaches the replay oracle (replay_oracle_calls: 0).
//
// Pristine-44 backup: scripts/gen-request-raw-path-cases.mjs requires
// the corpus to be at 44 cases before splicing. The script is idempotent
// after splicing because it locates the insert anchor ("request.unknown-malformed-child")
// which is unique to the 44-case corpus.

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
const baseObj = JSON.parse(baseRequest);

// All request.* cases share the same envelope (envelope decode happens after
// raw-text gate so the rejection never reaches the envelope digest).
// replay_oracle_calls: 0 because rejection is pre-envelope.
const envelopeDigest = "meshfleet.a2a.fingerprint.v1:sha256:9dd42da42a919761fb2f5bc007c03dd948ba0e6f4dcd9be80d556c31339c5606";

// 1. BOM leading
const bomLeading = "\uFEFF" + baseRequest;
// 2-6. Non-standard whitespace inserted between { and the first content
// (the scanner's whitespace() only accepts 0x20 0x09 0x0A 0x0D).
const nonStandardWs = (ch) => "{" + ch + JSON.stringify(baseObj).slice(1);
const wsFormFeed     = nonStandardWs("\u000C");
const wsVerticalTab  = nonStandardWs("\u000B");
const wsNel          = nonStandardWs("\u0085");
const wsLineSep      = nonStandardWs("\u2028");
const wsParaSep      = nonStandardWs("\u2029");
// 7. Line comment
const commentLine    = "// a comment\n" + baseRequest;
// 8. Block comment
const commentBlock   = "/* a comment */\n" + baseRequest;
// 9. Trailing garbage
const trailingGarbage = baseRequest + "{";
// 10. Trailing whitespace + comma (no value after)
const trailingComma = baseRequest.slice(0, -1) + " ,\n";
// 11. Literal-escaped duplicate key — raw surgery (JSON.stringify normalizes
// escape sequences, so JSON.parse-then-stringify collapses the duplicate).
const literalEscapedDup = baseRequest
  .replace('"version"', '"version"')  // anchor (no-op)
  .replace(',"action"', ',"\\u0076ersion":"x","action"');

const rejectRaw = (code, path) => ({ kind: "rejected", code, field_path: path });

const newCases = [
  {
    id: "request.bom-leading",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: bomLeading,
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejectRaw("INVALID_UTF8", "$"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  {
    id: "request.whitespace-form-feed",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: wsFormFeed,
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejectRaw("MALFORMED_JSON", "$"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  {
    id: "request.whitespace-vertical-tab",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: wsVerticalTab,
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejectRaw("MALFORMED_JSON", "$"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  {
    id: "request.whitespace-nel",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: wsNel,
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejectRaw("MALFORMED_JSON", "$"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  {
    id: "request.whitespace-line-separator",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: wsLineSep,
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejectRaw("MALFORMED_JSON", "$"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  {
    id: "request.whitespace-paragraph-separator",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: wsParaSep,
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejectRaw("MALFORMED_JSON", "$"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  {
    id: "request.comment-line",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: commentLine,
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejectRaw("MALFORMED_JSON", "$"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  {
    id: "request.comment-block",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: commentBlock,
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejectRaw("MALFORMED_JSON", "$"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  {
    id: "request.trailing-garbage",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: trailingGarbage,
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejectRaw("MALFORMED_JSON", "$"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  {
    id: "request.trailing-comma",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: trailingComma,
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejectRaw("MALFORMED_JSON", "$"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
  {
    id: "request.literal-escaped-duplicate-key",
    api: "evaluate-local-admission",
    invocation_args: {
      request_json: literalEscapedDup,
      envelope_json: envelopeJson,
      replay_oracle_result: "unseen",
    },
    expected: {
      result: rejectRaw("DUPLICATE_JSON_KEY", "$"),
      replay_oracle_calls: 0,
      replay_oracle_arguments: [],
    },
  },
];

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
console.log(`Spliced ${newCases.length} request-raw/path cases into the corpus.`);
console.log(`Corpus size: ${corpus.cases.length} cases (${corpus.mandatory_case_ids.length} mandatory ids).`);
console.log(`New ids: ${newCases.map((c) => c.id).join(", ")}`);
