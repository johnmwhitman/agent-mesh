#!/usr/bin/env node
/**
 * gen-request-boundary-cases.mjs
 *
 * Tick-160 (4C-1 BOM-path slice): rebuild the request-raw/path corpus on top
 * of the in-repo pristine sentinel
 * (`test/fixtures/a2a/local-admission/v0.1/corpus.json.pristine-73` — note
 * the file name follows the task body's plan; the actual content is the
 * 70-case train/20260820 HEAD baseline, and the file is the canonical
 * pre-splice root for the 4C-1 slice).
 *
 * Seven new mandatory cases pin the Section 9 request-raw/path boundary
 * (src/a2a/local-admission.ts):
 *   - request.bom-at-start     : BOM (\uFEFF) prefix -> INVALID_UTF8 at $
 *                                  (parseRequest line 477 short-circuits
 *                                  BEFORE the scanner sees the BOM)
 *   - request.leading-whitespace-tab : leading TAB accepted (whitespace set
 *                                      at 0x20/0x09/0x0a/0x0d) -> admission_plan
 *   - request.js-line-comment-prefix : "// hi\n<base>" rejected by stdlib
 *                                      JSON.parse -> MALFORMED_JSON at $
 *   - request.js-block-comment-prefix: "/* hi *\/ <base>" rejected
 *                                      by stdlib JSON.parse -> MALFORMED_JSON
 *                                      at $
 *   - request.trailing-whitespace-multiple: "<base>\n\n\t" accepted
 *                                      (trailing whitespace in same set)
 *                                      -> admission_plan
 *   - request.leading-carriage-return : "\r<base>" accepted (CR is
 *                                      whitespace) -> admission_plan
 *   - request.bom-only         : lone BOM -> INVALID_UTF8 at $
 *                                  (same line-477 short-circuit)
 *
 * Pure-node-fs design mirroring the 4aced61 (binding-rules-count) writer
 * pattern: reads the in-repo pristine-73 fixture as the integrity baseline,
 * refuses partial splice (corpus must still be in the 70-case pristine shape),
 * and appends the seven new cases to `corpus.json`.
 *
 * No `/tmp` sentinel, no `bash -c`, no `git show origin/main:...`.
 * Run from `scripts/splice-request-boundary-cases.mjs` (which makes the
 * in-repo fixture + the dynamic-import contract).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const sentinelPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json.pristine-73");

const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const sentinel = JSON.parse(readFileSync(sentinelPath, "utf8"));

// Refuse if the corpus has drifted from the in-repo pristine root.
if (corpus.cases.length !== sentinel.cases.length) {
  throw new Error(
    `corpus already spliced or drifted: cases=${corpus.cases.length}, pristine=${sentinel.cases.length} ` +
    `(this writer is single-shot; re-running on a 70-case baseline only)`,
  );
}
if (corpus.mandatory_case_ids.length !== sentinel.mandatory_case_ids.length) {
  throw new Error("corpus already spliced or drifted: mandatory_case_ids length mismatch");
}
for (let i = 0; i < sentinel.cases.length; i += 1) {
  if (corpus.cases[i].id !== sentinel.cases[i].id) {
    throw new Error(`corpus drift at case[${i}]: ${corpus.cases[i].id} != ${sentinel.cases[i].id}`);
  }
}

// Base case: valid.admission-plan gives the canonical 4A envelope digest we
// need for the 3 "admit" cases (leading TAB, trailing whitespace, leading CR).
const validBase = corpus.cases.find((c) => c.id === "valid.admission-plan");
if (!validBase) throw new Error("missing base case valid.admission-plan");
const baseReq = JSON.parse(validBase.invocation_args.request_json);
const basePlan = validBase.expected.result;

const baseReqJson = JSON.stringify(baseReq);

const cases = [];

function REJECT(code, field_path) {
  return {
    result: { kind: "rejected", code, field_path },
    replay_oracle_calls: 0,
    replay_oracle_arguments: [],
  };
}

function mk(id, request_json, expected) {
  return {
    id,
    api: "evaluate-local-admission",
    invocation_args: {
      request_json,
      envelope_json: validBase.invocation_args.envelope_json,
      replay_oracle_result: "unseen",
    },
    expected,
  };
}

// `JSON.stringify` produces a legal JSON object with no leading whitespace.
// The 3 admit cases pin the EXACT whitespace boundary the scanner accepts:
// 0x09 (TAB), 0x0d (CR), and 0x0a/0x09 (LF TAB).
// The 4 reject cases pin the EXACT boundary the scanner rejects:
// 0xFEFF (BOM) [INVALID_UTF8 via line-477 short-circuit] and the JSON5
// `//` / `/* *\/` comment syntaxes [MALFORMED_JSON via stdlib JSON.parse].

// 1. request.bom-at-start
//    0xFEFF triggers the explicit parseRequest short-circuit
//    (line 477: value.charCodeAt(0) === 0xfeff) BEFORE the scanner sees
//    the BOM. The case pin is INVALID_UTF8 at $; the scanner-route
//    MALFORMED_JSON is never reached for BOM-prefixed requests.
cases.push(
  mk(
    "request.bom-at-start",
    "\uFEFF" + baseReqJson,
    REJECT("INVALID_UTF8", "$"),
  ),
);

// 2. request.leading-whitespace-tab (admit)
//    TAB (0x09) is in the scanner's whitespace set; stdlib JSON.parse
//    also accepts it. The base request parses unchanged -> the same
//    admission_plan result as valid.admission-plan.
cases.push(
  mk(
    "request.leading-whitespace-tab",
    "\t" + baseReqJson,
    {
      result: basePlan,
      replay_oracle_calls: 1,
      replay_oracle_arguments: [{
        principal_ref: "principal-ref",
        request_id: "request-ref",
        sender: { namespace: "local", agent_id: "agent-a" },
        message_id: "message-ref",
        envelope_digest: basePlan.envelope_digest,
      }],
    },
  ),
);

// 3. request.js-line-comment-prefix
//    `// ...` is not legal JSON; stdlib JSON.parse rejects
//    "Expecting value"; the hand-rolled scanner likewise matches no
//    branch in `value()` for the leading `/` character and reports
//    MALFORMED_JSON at $.
cases.push(
  mk(
    "request.js-line-comment-prefix",
    "// boundary-case line-comment\n" + baseReqJson,
    REJECT("MALFORMED_JSON", "$"),
  ),
);

// 4. request.js-block-comment-prefix
//    `/* ... */` is not legal JSON; stdlib JSON.parse rejects
//    "Unexpected token"; the hand-rolled scanner likewise matches no
//    branch in `value()` for the leading `/` character and reports
//    MALFORMED_JSON at $.
cases.push(
  mk(
    "request.js-block-comment-prefix",
    "/* boundary-case block-comment */ " + baseReqJson,
    REJECT("MALFORMED_JSON", "$"),
  ),
);

// 5. request.trailing-whitespace-multiple (admit)
//    All three trailing chars (LF TAB LF) are in the scanner's whitespace
//    set AND stdlib JSON.parse also accepts trailing whitespace.
cases.push(
  mk(
    "request.trailing-whitespace-multiple",
    baseReqJson + "\n\t\n",
    {
      result: basePlan,
      replay_oracle_calls: 1,
      replay_oracle_arguments: [{
        principal_ref: "principal-ref",
        request_id: "request-ref",
        sender: { namespace: "local", agent_id: "agent-a" },
        message_id: "message-ref",
        envelope_digest: basePlan.envelope_digest,
      }],
    },
  ),
);

// 6. request.leading-carriage-return (admit)
//    CR (0x0d) is in the scanner's whitespace set; stdlib JSON.parse
//    also accepts it. The base request parses unchanged.
cases.push(
  mk(
    "request.leading-carriage-return",
    "\r" + baseReqJson,
    {
      result: basePlan,
      replay_oracle_calls: 1,
      replay_oracle_arguments: [{
        principal_ref: "principal-ref",
        request_id: "request-ref",
        sender: { namespace: "local", agent_id: "agent-a" },
        message_id: "message-ref",
        envelope_digest: basePlan.envelope_digest,
      }],
    },
  ),
);

// 7. request.bom-only
//    A request body consisting solely of the BOM fires the same
//    line-477 INVALID_UTF8 short-circuit. The scanner character-switch
//    is never reached.
cases.push(
  mk(
    "request.bom-only",
    "\uFEFF",
    REJECT("INVALID_UTF8", "$"),
  ),
);

// Refuse partial splice: every id in `cases` must be unique AND not
// already present (corpus integrity preserved above so the latter is
// always true; the dup check is belt-and-braces).
const newIds = cases.map((c) => c.id);
if (new Set(newIds).size !== newIds.length) {
  throw new Error("refusing: duplicate ids in cases");
}
const existingIds = new Set(corpus.cases.map((c) => c.id));
const existingMandatory = new Set(corpus.mandatory_case_ids);
for (const id of newIds) {
  if (existingIds.has(id)) throw new Error(`dup id ${id} already in corpus`);
  if (existingMandatory.has(id)) throw new Error(`dup id ${id} already in mandatory_case_ids`);
}

// Splice: append in the same order as the generator emitted them.
corpus.cases = [...corpus.cases, ...cases];
corpus.mandatory_case_ids = [...corpus.mandatory_case_ids, ...newIds];

writeFileSync(corpusPath, `${JSON.stringify(corpus)}\n`, "utf8");
console.log(`Spliced ${newIds.length} request-boundary cases (corpus ${sentinel.cases.length} -> ${corpus.cases.length}).`);
console.log(`New ids: ${newIds.join(", ")}`);
