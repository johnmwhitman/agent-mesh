import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as admission from "../src/a2a/local-admission.js";
import { validateStaticHarnessMapping } from "../src/a2a/static-harness-mapping.js";

type CorpusCase = {
  id: string;
  api: "evaluate-local-admission";
  invocation_args: { request_json: string; envelope_json: string; replay_oracle_result: unknown };
  expected: { result: unknown; replay_oracle_calls: number; replay_oracle_arguments: unknown[] };
};

const root = process.cwd();
const corpusPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");
const sidecarPath = join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "static-harness-mappings.json");
const pythonWitness = join(root, "reference", "python", "a2a_local_admission_reference.py");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as { mandatory_case_ids: string[]; cases: CorpusCase[] };
const localAdmissionCorpusCountDocs = [
  join(root, "COMPATIBILITY.md"),
  join(root, "docs", "A2A-PROGRAM.md"),
  join(root, "docs", "A2A-HANDOFF-CURRENT.md"),
  join(root, "docs", "A2A-LOCAL-ADMISSION-PROFILE-v0.1.md"),
];

function evaluate(item: CorpusCase) {
  const calls: unknown[] = [];
  const result = admission.evaluateLocalAdmission(
    item.invocation_args.request_json,
    item.invocation_args.envelope_json,
    (argument) => {
      calls.push(argument);
      if (item.invocation_args.replay_oracle_result === "throws") throw new Error("fixture");
      return item.invocation_args.replay_oracle_result as never;
    },
  );
  return { result, replay_oracle_calls: calls.length, replay_oracle_arguments: calls };
}

test("local admission evidence-alpha corpus is closed, self-consistent, and raw-text only", () => {
  assert.deepEqual(Object.keys(admission), ["evaluateLocalAdmission"]);
  assert.equal(admission.evaluateLocalAdmission.length, 3);
  assert.deepEqual(corpus.cases.map((item) => item.id), corpus.mandatory_case_ids);
  for (const item of corpus.cases) {
    assert.deepEqual(Object.keys(item).sort(), ["api", "expected", "id", "invocation_args"]);
    assert.equal(item.api, "evaluate-local-admission");
    assert.deepEqual(Object.keys(item.invocation_args).sort(), ["envelope_json", "replay_oracle_result", "request_json"]);
    assert.deepEqual(Object.keys(item.expected).sort(), ["replay_oracle_arguments", "replay_oracle_calls", "result"]);
    assert.equal(typeof item.invocation_args.request_json, "string");
    assert.equal(typeof item.invocation_args.envelope_json, "string");
    assert.equal(item.invocation_args.request_json.includes("\"envelope\""), false);
  }
});

test("stable local-admission case-count prose reconciles against the canonical corpus", () => {
  assert.equal(corpus.mandatory_case_ids.length, corpus.cases.length);
  for (const path of localAdmissionCorpusCountDocs) {
    const text = readFileSync(path, "utf8");
    assert.match(
      text,
      new RegExp(`\\b${corpus.cases.length}\\s+mandatory cases\\b`),
      `${path} must state the canonical local-admission corpus count`,
    );
  }
});

test("authorization boundary evidence covers the next feasible Section 9 cardinality slice", () => {
  assert.deepEqual(
    corpus.mandatory_case_ids.filter((id) => id.startsWith("authorization.boundary.")),
    [
      "authorization.boundary.message-types-5",
      "authorization.boundary.message-types-6",
      "authorization.boundary.recipients-128",
      "authorization.boundary.recipients-129",
      "authorization.boundary.duplicate-message-type",
      "authorization.boundary.duplicate-recipient",
      "authorization.boundary.all-recipient-denied",
    ],
  );
});

test("authorization context mismatch on any single policy field denies the request", () => {
  const contextCases = corpus.cases.filter((item) => item.id.startsWith("authorization.context."));
  assert.deepEqual(
    contextCases.map((item) => item.id),
    [
      "authorization.context.adapter-mismatch",
      "authorization.context.principal-mismatch",
      "authorization.context.audience-mismatch",
      "authorization.context.session-mismatch",
      "authorization.context.sender-mismatch",
    ],
  );
  for (const item of contextCases) {
    assert.deepEqual(
      item.expected,
      { result: { kind: "rejected", code: "AUTHORIZATION_DENIED", field_path: "$" }, replay_oracle_calls: 0, replay_oracle_arguments: [] },
      item.id,
    );
    assert.equal(item.invocation_args.replay_oracle_result, "unseen", item.id);
  }
});

test("authorization snapshot field/grammar gates pin every exact source path", () => {
  const snapshotIds = corpus.mandatory_case_ids.filter((id) => id.startsWith("authorization.snapshot-"));
  const ruleIds = corpus.mandatory_case_ids.filter((id) => id.startsWith("authorization.rule-"));
  assert.deepEqual(snapshotIds, [
    "authorization.snapshot-version-invalid",
    "authorization.snapshot-id-invalid",
    "authorization.snapshot-provenance-invalid",
    "authorization.snapshot-from-invalid",
    "authorization.snapshot-from-fractional",
    "authorization.snapshot-from-unsafe",
    "authorization.snapshot-until-invalid",
    "authorization.snapshot-until-inverted",
    "authorization.snapshot-unknown-member",
    "authorization.snapshot-rules-not-array",
  ]);
  assert.deepEqual(ruleIds, [
    "authorization.rule-adapter-invalid",
    "authorization.rule-principal-invalid",
    "authorization.rule-audience-invalid",
    "authorization.rule-session-invalid",
    "authorization.rule-sender-invalid",
    "authorization.rule-sender-unknown-member",
    "authorization.rule-unknown-member",
    "authorization.rule-missing-action",
  ]);
  const cases = corpus.cases.filter((item) => snapshotIds.includes(item.id) || ruleIds.includes(item.id));
  assert.equal(cases.length, 18);
  for (const item of cases) {
    assert.equal(item.expected.replay_oracle_calls, 0, item.id);
    const result = item.expected.result as { kind: string; code: string; field_path: string };
    assert.equal(result.kind, "rejected", item.id);
    assert.equal(item.invocation_args.request_json.includes("authorization_snapshot"), true, item.id);
    assert.equal(item.invocation_args.request_json.includes("binding_snapshot"), true, item.id);
    assert.equal(item.invocation_args.request_json.includes("authentication_evidence"), true, item.id);
    if (item.id === "authorization.snapshot-until-inverted") {
      assert.deepEqual(result, { kind: "rejected", code: "AUTHORIZATION_DENIED", field_path: "$" });
      continue;
    }
    // every snapshot grammar rejection reports an exact source path inside the snapshot
    assert.match(result.field_path, /^\$\.authorization_snapshot(?:$|\.|\.rules\[\d+\](?:\.|$))/, item.id);
    if (["authorization.snapshot-from-invalid", "authorization.snapshot-from-fractional", "authorization.snapshot-from-unsafe"].includes(item.id)) {
      // raw number lexemes fail at the scanner before semantic snapshot validation
      assert.deepEqual(result, { kind: "rejected", code: "MALFORMED_JSON", field_path: "$.authorization_snapshot.effective_from_ms" });
    } else {
      assert.equal(result.code, "INVALID_AUTHORIZATION_SNAPSHOT", item.id);
    }
  }
});

test("authentication-evidence boundaries stay ordered and preserve their terminal semantics", () => {
  const evidenceCases = corpus.cases.filter((item) => item.id.startsWith("evidence."));
  assert.deepEqual(
    evidenceCases.map((item) => item.id),
    [
      "evidence.invalid",
      "evidence.provenance-invalid",
      "evidence.issued-at-evaluation-valid",
      "evidence.expires-at-evaluation-denied",
      "evidence.lifetime-300000-valid",
      "evidence.lifetime-300001-denied",
    ],
  );
  assert.deepEqual(
    evidenceCases.slice(1).map((item) => item.expected),
    [
      { result: { kind: "rejected", code: "INVALID_AUTHENTICATION_EVIDENCE", field_path: "$.authentication_evidence.provenance" }, replay_oracle_calls: 0, replay_oracle_arguments: [] },
      corpus.cases[0]!.expected,
      { result: { kind: "rejected", code: "AUTHORIZATION_DENIED", field_path: "$" }, replay_oracle_calls: 0, replay_oracle_arguments: [] },
      corpus.cases[0]!.expected,
      { result: { kind: "rejected", code: "AUTHORIZATION_DENIED", field_path: "$" }, replay_oracle_calls: 0, replay_oracle_arguments: [] },
    ],
  );
  assert.deepEqual(
    evidenceCases.slice(1).map((item) => {
      const request = JSON.parse(item.invocation_args.request_json) as { authentication_evidence: unknown };
      return request.authentication_evidence;
    }),
    [
      { adapter_id: "local.adapter", principal_ref: "principal-ref", audience: "local-audience", session_ref: "session-ref", issued_at_ms: 0, expires_at_ms: 200, provenance: "untrusted_local_adapter" },
      { adapter_id: "local.adapter", principal_ref: "principal-ref", audience: "local-audience", session_ref: "session-ref", issued_at_ms: 100, expires_at_ms: 200, provenance: "trusted_local_adapter" },
      { adapter_id: "local.adapter", principal_ref: "principal-ref", audience: "local-audience", session_ref: "session-ref", issued_at_ms: 0, expires_at_ms: 100, provenance: "trusted_local_adapter" },
      { adapter_id: "local.adapter", principal_ref: "principal-ref", audience: "local-audience", session_ref: "session-ref", issued_at_ms: 0, expires_at_ms: 300000, provenance: "trusted_local_adapter" },
      { adapter_id: "local.adapter", principal_ref: "principal-ref", audience: "local-audience", session_ref: "session-ref", issued_at_ms: 0, expires_at_ms: 300001, provenance: "trusted_local_adapter" },
    ],
  );
});

test("the 2048-rule profile row exceeds the raw request ceiling by authorization-rule lower bound", () => {
  const shortestRule = JSON.stringify({
    adapter_id: "a",
    principal_ref: "a",
    audience: "a",
    session_ref: "a",
    sender: { namespace: "a", agent_id: "a" },
    action: "a2a.message.admit",
    message_types: ["alert"],
    recipients: [{ namespace: "a", agent_id: "a" }],
  });
  assert.equal(Buffer.byteLength(shortestRule, "utf8"), 216);
  assert.ok(216 * 2048 > 262144, "2048 minimum authorization rules exceed the request cap before array punctuation or request fields");
});

test("request-boundary corpus pin covers the BOM/leading-CR/leading-TAB/js-comment-prefix/trailing-multiple slice (4C-1)", () => {
  // Filter by id prefix so the request-boundary row stays correct after later
  // slices append additional cases at the end of the corpus (mirrors the
  // binding rules-count closure test shape at line ~210).
  const requestBoundaryCases = corpus.cases.filter((item) => item.id.startsWith("request.") &&
    [
      "request.bom-at-start",
      "request.leading-whitespace-tab",
      "request.js-line-comment-prefix",
      "request.js-block-comment-prefix",
      "request.trailing-whitespace-multiple",
      "request.leading-carriage-return",
      "request.bom-only",
    ].includes(item.id));
  assert.deepEqual(
    requestBoundaryCases.map((item) => item.id),
    [
      "request.bom-at-start",
      "request.leading-whitespace-tab",
      "request.js-line-comment-prefix",
      "request.js-block-comment-prefix",
      "request.trailing-whitespace-multiple",
      "request.leading-carriage-return",
      "request.bom-only",
    ],
  );
  // 7 cases. Mirror the binding rules-count test's stripPrivate pattern.
  const stripPrivate = (expected: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(expected)) {
      if (!k.startsWith("_")) out[k] = (expected as Record<string, unknown>)[k]!;
    }
    return out;
  };
  assert.deepEqual(
    requestBoundaryCases.map((item) => stripPrivate(item.expected as Record<string, unknown>)),
    [
      // BOM (\uFEFF) prefix: parseRequest short-circuits with INVALID_UTF8 at $
      // (line 477 explicit BOM check: value.charCodeAt(0) === 0xfeff), so the
      // BOM character never reaches the scanner character-switch.
      { result: { kind: "rejected", code: "INVALID_UTF8", field_path: "$" }, replay_oracle_calls: 0, replay_oracle_arguments: [] },
      // leading TAB: 0x09 is in the scanner whitespace set (0x20/0x09/0x0a/0x0d)
      // -> admission_plan with the unchanged 4A digest.
      { result: corpus.cases[0]!.expected.result, replay_oracle_calls: 1, replay_oracle_arguments: [{
        principal_ref: "principal-ref",
        request_id: "request-ref",
        sender: { namespace: "local", agent_id: "agent-a" },
        message_id: "message-ref",
        envelope_digest: (corpus.cases[0]!.expected.result as { kind: "admission_plan"; envelope_digest: string }).envelope_digest,
      }] },
      // JS "// hi\n<base>": not legal JSON (stdlib JSON.parse rejects
      // "Expecting value"); scanner character-switch matches no branch
      // -> MALFORMED_JSON at $.
      { result: { kind: "rejected", code: "MALFORMED_JSON", field_path: "$" }, replay_oracle_calls: 0, replay_oracle_arguments: [] },
      // JS "/* hi *\/ <base>": not legal JSON (stdlib JSON.parse rejects
      // "Unexpected token"); scanner character-switch matches no branch
      // -> MALFORMED_JSON at $.
      { result: { kind: "rejected", code: "MALFORMED_JSON", field_path: "$" }, replay_oracle_calls: 0, replay_oracle_arguments: [] },
      // trailing LF TAB LF: trailing whitespace in the same set is accepted
      // by the scanner + stdlib JSON.parse -> admission_plan with unchanged 4A digest.
      { result: corpus.cases[0]!.expected.result, replay_oracle_calls: 1, replay_oracle_arguments: [{
        principal_ref: "principal-ref",
        request_id: "request-ref",
        sender: { namespace: "local", agent_id: "agent-a" },
        message_id: "message-ref",
        envelope_digest: (corpus.cases[0]!.expected.result as { kind: "admission_plan"; envelope_digest: string }).envelope_digest,
      }] },
      // leading CR: 0x0d is in the scanner whitespace set -> admission_plan.
      { result: corpus.cases[0]!.expected.result, replay_oracle_calls: 1, replay_oracle_arguments: [{
        principal_ref: "principal-ref",
        request_id: "request-ref",
        sender: { namespace: "local", agent_id: "agent-a" },
        message_id: "message-ref",
        envelope_digest: (corpus.cases[0]!.expected.result as { kind: "admission_plan"; envelope_digest: string }).envelope_digest,
      }] },
      // BOM-only: lone BOM triggers the same line-477 INVALID_UTF8 short-circuit.
      { result: { kind: "rejected", code: "INVALID_UTF8", field_path: "$" }, replay_oracle_calls: 0, replay_oracle_arguments: [] },
    ],
  );
  // Per-case literal boundary proof: confirm the exact first / last character
  // of each generated request_json matches the bounded-subfamily name.
  for (const item of requestBoundaryCases) {
    const rj = item.invocation_args.request_json;
    if (item.id === "request.bom-at-start") {
      assert.equal(rj.charCodeAt(0), 0xfeff, `${item.id} must start with U+FEFF BOM`);
    }
    if (item.id === "request.leading-whitespace-tab") {
      assert.equal(rj.charCodeAt(0), 0x09, `${item.id} must start with U+0009 TAB`);
    }
    if (item.id === "request.js-line-comment-prefix") {
      assert.equal(rj.slice(0, 2), "//", `${item.id} must start with "//"`);
    }
    if (item.id === "request.js-block-comment-prefix") {
      assert.equal(rj.slice(0, 2), "/*", `${item.id} must start with "/*"`);
    }
    if (item.id === "request.trailing-whitespace-multiple") {
      // trailing LF TAB LF (three bytes: 0x0a, 0x09, 0x0a)
      assert.deepEqual(
        [rj.charCodeAt(rj.length - 3), rj.charCodeAt(rj.length - 2), rj.charCodeAt(rj.length - 1)],
        [0x0a, 0x09, 0x0a],
        `${item.id} must end with LF TAB LF`,
      );
    }
    if (item.id === "request.leading-carriage-return") {
      assert.equal(rj.charCodeAt(0), 0x0d, `${item.id} must start with U+000D CR`);
    }
    if (item.id === "request.bom-only") {
      assert.equal(rj.length, 1, `${item.id} must be the singleton BOM`);
      assert.equal(rj.charCodeAt(0), 0xfeff, `${item.id} must be a single U+FEFF BOM`);
    }
  }
});

test("request-boundary reject-code text invariants pin whitespace, punctuation, and capitalization (4C-2)", () => {
  // 4C-2 slice: collect the error-message fixtures emitted by the
  // request-boundary subfamily (all 21 request.* cases that reject) and pin
  // their text-shape invariants. The 4C-1 test pins the literal bytes of
  // the 4C-1 subfamily (BOM/whitespace/comment, 4 of those 7 reject at $);
  // 4C-2 pins the SEMANTIC shape (whitespace, punctuation, capitalization)
  // AND the literal code + field_path bytes for the ENTIRE request-boundary
  // reject family, so a refactor that changed "INVALID_UTF8" to
  // "InvalidUtf8" or "INVALID-UTF8" or " INVALID_UTF8" would be caught
  // here even if the deepEqual accidentally still passed.
  //
  // Filter by id prefix AND by kind === "rejected" so the row stays correct
  // after later slices append additional request-boundary cases (mirrors
  // the binding rules-count closure test shape). The 3 admit cases
  // (leading-tab, trailing-whitespace-multiple, leading-carriage-return)
  // have result.kind === "admission_plan" and produce no rejection code,
  // so they are out of scope for this text-invariant row.
  const requestBoundaryRejectCases = corpus.cases.filter((item) =>
    item.id.startsWith("request.") &&
    (item.expected.result as { kind: string }).kind === "rejected"
  );
  // Closure pin: exactly 21 request.*-rejected cases in the corpus today.
  // If a later slice adds or removes a request-boundary reject case, this
  // deepEqual fails first so the row is updated deliberately rather than
  // silently drifting.
  assert.deepEqual(
    requestBoundaryRejectCases.map((item) => item.id),
    [
      "request.too-large",
      "request.invalid-utf8-surrogate",
      "request.malformed-json",
      "request.duplicate-key",
      "request.depth-exceeded",
      "request.invalid-root",
      "request.missing-required",
      "request.unknown-core",
      "request.unsupported-version",
      "request.invalid-evaluation",
      "request.invalid-request-id",
      "request.invalid-action",
      "request.number-fraction",
      "request.unknown-malformed-child",
      "request.byte-262143",
      "request.byte-262144",
      "request.byte-262145",
      "request.bom-at-start",
      "request.js-line-comment-prefix",
      "request.js-block-comment-prefix",
      "request.bom-only",
    ],
    "4C-2 row expects exactly 21 reject cases from the request-boundary subfamily (closure pin)",
  );
  // Pin the exact bytes of the reject codes for the full 4C-2 subfamily.
  // A refactor that drops the underscore (e.g. "INVALIDUTF8") or adds
  // punctuation (e.g. "INVALID_UTF8.") would fail this deepEqual before
  // it ever reached the regex shape assertion below.
  assert.deepEqual(
    requestBoundaryRejectCases.map((item) => (item.expected.result as { code: string }).code),
    [
      "REQUEST_TOO_LARGE",
      "INVALID_UTF8",
      "MALFORMED_JSON",
      "DUPLICATE_JSON_KEY",
      "MAX_DEPTH_EXCEEDED",
      "INVALID_REQUEST",
      "MISSING_REQUIRED_FIELD",
      "UNKNOWN_CORE_FIELD",
      "UNSUPPORTED_PROFILE_VERSION",
      "INVALID_EVALUATION_TIME",
      "INVALID_REQUEST_ID",
      "INVALID_REQUEST",
      "MALFORMED_JSON",
      "MALFORMED_JSON",
      "UNKNOWN_CORE_FIELD",
      "UNKNOWN_CORE_FIELD",
      "REQUEST_TOO_LARGE",
      "INVALID_UTF8",
      "MALFORMED_JSON",
      "MALFORMED_JSON",
      "INVALID_UTF8",
    ],
    "4C-2 reject codes must be exactly the SCREAMING_SNAKE_CASE literals for all 21 request-boundary reject cases",
  );
  assert.deepEqual(
    requestBoundaryRejectCases.map((item) => (item.expected.result as { field_path: string }).field_path),
    [
      "$",
      "$",
      "$",
      "$",
      "$.authentication_evidence",
      "$",
      "$.version",
      "$",
      "$.version",
      "$.evaluation_time_ms",
      "$.request_id",
      "$.action",
      "$.evaluation_time_ms",
      "$",
      "$",
      "$",
      "$",
      "$",
      "$",
      "$",
      "$",
    ],
    "4C-2 field_paths for the 21 request-boundary reject cases must be exactly the documented source paths (root '$' OR '$.segment' dotted paths, no whitespace)",
  );
  // Text-shape invariants. These assertions hold for ANY RejectCode +
  // field_path the request-boundary scanner emits, so the slice is
  // forward-compatible with later sub-slices that add more reject codes.
  const codeShape = /^[A-Z][A-Z0-9_]*$/;
  const fieldPathShape = /^(?:\$|\$\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*)$/;
  for (const item of requestBoundaryRejectCases) {
    const code = (item.expected.result as { code: string }).code;
    const fieldPath = (item.expected.result as { field_path: string }).field_path;
    // Capitalization + punctuation invariant: SCREAMING_SNAKE_CASE,
    // ASCII letters / digits / underscore only, leading char must be a
    // capital letter (no leading digit, no leading underscore, no
    // leading hyphen, no leading whitespace).
    assert.match(code, codeShape, `${item.id}.code=${JSON.stringify(code)} must match ${codeShape} (SCREAMING_SNAKE_CASE, ASCII only, no punctuation other than '_')`);
    // Whitespace invariants on code: explicit length-before/after check
    // (the regex above already enforces this, but a redundant literal
    // proof makes a regression in the regex itself visible — e.g. if a
    // future edit changes the regex to allow leading whitespace, the
    // explicit no-leading / no-trailing whitespace assertion still
    // catches it).
    assert.equal(code, code.trim(), `${item.id}.code=${JSON.stringify(code)} must have no leading or trailing whitespace`);
    assert.equal(code.length, [...code].length, `${item.id}.code=${JSON.stringify(code)} must be ASCII (codepoint count equals code-unit count)`);
    // Forbidden-punctuation invariants: no hyphen, no period, no comma,
    // no colon, no semicolon, no slash, no backslash, no parentheses,
    // no brackets, no braces, no quote characters, no space.
    assert.ok(!/[ \-./,:;\\()\[\]{}'"]/.test(code), `${item.id}.code=${JSON.stringify(code)} must contain no whitespace, hyphen, period, comma, colon, semicolon, slash, backslash, paren, bracket, brace, or quote`);
    // field_path shape: root '$' exactly OR dotted path with array
    // indices, no whitespace, no empty segments, leading '$' is
    // mandatory.
    assert.match(fieldPath, fieldPathShape, `${item.id}.field_path=${JSON.stringify(fieldPath)} must match ${fieldPathShape} ('$' alone OR '$.segment.segment[N]' paths, no whitespace, no empty segments)`);
    assert.equal(fieldPath, fieldPath.trim(), `${item.id}.field_path=${JSON.stringify(fieldPath)} must have no leading or trailing whitespace`);
    assert.equal(fieldPath.length, [...fieldPath].length, `${item.id}.field_path=${JSON.stringify(fieldPath)} must be ASCII (codepoint count equals code-unit count)`);
  }
});

test("request-boundary admit-case summary text invariants pin the 4C-1 subfamily (4C-3)", () => {
  // 4C-3 slice: collect the 3 admission_plan results emitted by the
  // request-boundary subfamily (the 4C-1 subfamily's leading-whitespace-tab,
  // trailing-whitespace-multiple, and leading-carriage-return cases) and
  // pin their summary-field text-shape invariants.
  //
  // 4C-1 pinned the literal bytes of the 4 request-boundary reject outputs
  // (BOM / comment-prefix cases); 4C-2 pinned the SEMANTIC shape of those
  // 4 reject outputs (SCREAMING_SNAKE_CASE codes, dotted-path field_paths,
  // no whitespace / ASCII / no forbidden punctuation). 4C-3 mirrors 4C-2
  // for the 3 ADMIT cases in the same request-boundary subfamily: it pins
  // the summary fields of the admission_plan result (kind, version,
  // action, audience, message_type, request_identity.*, semantic_identity.*,
  // envelope_digest shape) so a refactor that introduced "Admission_Plan"
  // or "HANDOFF" or "a2a_message_admit" would be caught here even if the
  // deepEqual accidentally still passed.
  //
  // Filter by id prefix + an explicit 3-id whitelist + kind === "admission_plan"
  // so the row stays correct after later slices append additional
  // request-boundary cases (mirrors the binding-rules-count closure test
  // shape, and the explicit 4C-2 closure comment notes that the 3 admit
  // cases are out of scope for 4C-2 by design).
  const requestBoundaryAdmitCases = corpus.cases.filter((item) =>
    item.id.startsWith("request.") &&
    [
      "request.leading-whitespace-tab",
      "request.trailing-whitespace-multiple",
      "request.leading-carriage-return",
    ].includes(item.id) &&
    (item.expected.result as { kind: string }).kind === "admission_plan"
  );
  // Closure pin: exactly 3 request.*-admitted cases from the 4C-1 subfamily.
  // If a later slice adds or removes a request-boundary admit case, this
  // deepEqual fails first so the row is updated deliberately rather than
  // silently drifting.
  assert.deepEqual(
    requestBoundaryAdmitCases.map((item) => item.id),
    [
      "request.leading-whitespace-tab",
      "request.trailing-whitespace-multiple",
      "request.leading-carriage-return",
    ],
    "4C-3 row expects exactly 3 admit cases from the 4C-1 request-boundary subfamily",
  );
  // Pin the exact summary-field bytes for the 3 admit cases. A refactor
  // that dropped the underscore in the version string, swapped the
  // SCREAMING_SNAKE_CASE action for camelCase, or capitalized the
  // lowercase-with-dashes message_type would fail this deepEqual before
  // it ever reached the shape assertion below.
  type AdmitSummary = {
    kind: "admission_plan";
    version: string;
    action: string;
    audience: string;
    message_type: string;
    envelope_digest: string;
    request_identity: { principal_ref: string; request_id: string };
    semantic_identity: {
      sender: { namespace: string; agent_id: string };
      message_id: string;
    };
    recipients: Array<{ namespace: string; agent_id: string }>;
  };
  const summaries = requestBoundaryAdmitCases.map((item) => {
    const r = item.expected.result as AdmitSummary;
    return {
      kind: r.kind,
      version: r.version,
      action: r.action,
      audience: r.audience,
      message_type: r.message_type,
      envelope_digest: r.envelope_digest,
      request_identity: r.request_identity,
      semantic_identity: r.semantic_identity,
      recipients: r.recipients,
    };
  });
  assert.deepEqual(
    summaries.map((s) => s.kind),
    ["admission_plan", "admission_plan", "admission_plan"],
    "4C-3 admit kind must be exactly the snake_case literal 'admission_plan' for all 3 cases",
  );
  assert.deepEqual(
    summaries.map((s) => s.version),
    [
      "meshfleet.a2a.local-admission.v0.1",
      "meshfleet.a2a.local-admission.v0.1",
      "meshfleet.a2a.local-admission.v0.1",
    ],
    "4C-3 admit version must be exactly the dotted prefix-and-version literal 'meshfleet.a2a.local-admission.v0.1' for all 3 cases",
  );
  assert.deepEqual(
    summaries.map((s) => s.action),
    ["a2a.message.admit", "a2a.message.admit", "a2a.message.admit"],
    "4C-3 admit action must be exactly the lowercase-dotted literal 'a2a.message.admit' for all 3 cases",
  );
  assert.deepEqual(
    summaries.map((s) => s.audience),
    ["local-audience", "local-audience", "local-audience"],
    "4C-3 admit audience must be exactly the literal 'local-audience' for all 3 cases",
  );
  assert.deepEqual(
    summaries.map((s) => s.message_type),
    ["handoff", "handoff", "handoff"],
    "4C-3 admit message_type must be exactly the lowercase literal 'handoff' for all 3 cases",
  );
  assert.deepEqual(
    summaries.map((s) => s.request_identity),
    [
      { principal_ref: "principal-ref", request_id: "request-ref" },
      { principal_ref: "principal-ref", request_id: "request-ref" },
      { principal_ref: "principal-ref", request_id: "request-ref" },
    ],
    "4C-3 admit request_identity must be exactly {principal_ref, request_id} for all 3 cases",
  );
  assert.deepEqual(
    summaries.map((s) => s.semantic_identity),
    [
      { sender: { namespace: "local", agent_id: "agent-a" }, message_id: "message-ref" },
      { sender: { namespace: "local", agent_id: "agent-a" }, message_id: "message-ref" },
      { sender: { namespace: "local", agent_id: "agent-a" }, message_id: "message-ref" },
    ],
    "4C-3 admit semantic_identity must be exactly {sender, message_id} for all 3 cases",
  );
  assert.deepEqual(
    summaries.map((s) => s.recipients),
    [
      [{ namespace: "local", agent_id: "agent-b" }],
      [{ namespace: "local", agent_id: "agent-b" }],
      [{ namespace: "local", agent_id: "agent-b" }],
    ],
    "4C-3 admit recipients must be exactly the singleton [{namespace:'local',agent_id:'agent-b'}] for all 3 cases",
  );
  // envelope_digest: literal prefix pin + per-case exact digest equality.
  // The 3 admit cases share the same canonical digest (the unchanged 4A
  // digest, because the 4C-1 subfamily intentionally only touches the
  // scanner whitespace layer — the envelope payload is byte-identical so
  // the digest cannot change). Pin both the prefix shape and the literal
  // hex suffix in corpus order so a future edit that mutated the digest
  // algorithm (or accidentally re-canonicalized the envelope) trips both
  // the prefix regex AND the literal deepEqual at the same time.
  const envelopeDigestPrefix = "meshfleet.a2a.fingerprint.v1:sha256:";
  const envelopeDigestShape = new RegExp(`^${envelopeDigestPrefix.replace(/\./g, "\\.").replace(/:/g, ":")}[0-9a-f]{64}$`);
  const digests = summaries.map((s) => s.envelope_digest);
  assert.deepEqual(
    digests,
    [
      "meshfleet.a2a.fingerprint.v1:sha256:9dd42da42a919761fb2f5bc007c03dd948ba0e6f4dcd9be80d556c31339c5606",
      "meshfleet.a2a.fingerprint.v1:sha256:9dd42da42a919761fb2f5bc007c03dd948ba0e6f4dcd9be80d556c31339c5606",
      "meshfleet.a2a.fingerprint.v1:sha256:9dd42da42a919761fb2f5bc007c03dd948ba0e6f4dcd9be80d556c31339c5606",
    ],
    "4C-3 admit envelope_digest must be the unchanged 4A literal digest for all 3 cases (scanner-whitespace-only mutations preserve the envelope fingerprint)",
  );
  // Text-shape invariants. These assertions hold for ANY summary field
  // string the admission planner emits, so the slice is forward-compatible
  // with later sub-slices that add more admit cases.
  const versionShape = /^meshfleet\.a2a\.[a-z][a-z0-9-]*\.v\d+\.\d+$/;
  const actionShape = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
  const audienceShape = /^[a-z][a-z0-9-]*$/;
  const messageTypeShape = /^[a-z][a-z0-9-]*$/;
  const principalRefShape = /^[a-z][a-z0-9-]*$/;
  const requestIdShape = /^[a-z][a-z0-9-]*$/;
  const namespaceShape = /^[a-z][a-z0-9-]*$/;
  const agentIdShape = /^[a-z][a-z0-9-]*$/;
  for (const [index, item] of requestBoundaryAdmitCases.entries()) {
    const s = summaries[index]!;
    // kind: literal snake_case
    assert.equal(s.kind, "admission_plan", `${item.id}.kind must be exactly 'admission_plan' (literal snake_case, no leading or trailing whitespace)`);
    assert.equal(s.kind, s.kind.trim(), `${item.id}.kind must have no leading or trailing whitespace`);
    assert.equal(s.kind.length, [...s.kind].length, `${item.id}.kind must be ASCII`);
    // version: dotted prefix + semantic version, no whitespace
    assert.match(s.version, versionShape, `${item.id}.version=${JSON.stringify(s.version)} must match ${versionShape} ('meshfleet.a2a.<name>.v<major>.<minor>' with ASCII lowercase / digits / dashes / dots only)`);
    assert.equal(s.version, s.version.trim(), `${item.id}.version must have no leading or trailing whitespace`);
    assert.equal(s.version.length, [...s.version].length, `${item.id}.version must be ASCII`);
    // action: dotted snake_case with at least one dot
    assert.match(s.action, actionShape, `${item.id}.action=${JSON.stringify(s.action)} must match ${actionShape} (lowercase dotted snake_case, at least one '.' separator)`);
    assert.equal(s.action, s.action.trim(), `${item.id}.action must have no leading or trailing whitespace`);
    assert.equal(s.action.length, [...s.action].length, `${item.id}.action must be ASCII`);
    assert.ok(!/[ \-/:;\\()\[\]{}'"]/.test(s.action), `${item.id}.action=${JSON.stringify(s.action)} must contain no whitespace, hyphen, slash, colon, semicolon, backslash, paren, bracket, brace, or quote`);
    // audience: lowercase-with-dashes, no whitespace
    assert.match(s.audience, audienceShape, `${item.id}.audience=${JSON.stringify(s.audience)} must match ${audienceShape} (lowercase ASCII, digits, dashes only)`);
    assert.equal(s.audience, s.audience.trim(), `${item.id}.audience must have no leading or trailing whitespace`);
    assert.equal(s.audience.length, [...s.audience].length, `${item.id}.audience must be ASCII`);
    // message_type: lowercase-with-dashes, no whitespace
    assert.match(s.message_type, messageTypeShape, `${item.id}.message_type=${JSON.stringify(s.message_type)} must match ${messageTypeShape} (lowercase ASCII, digits, dashes only)`);
    assert.equal(s.message_type, s.message_type.trim(), `${item.id}.message_type must have no leading or trailing whitespace`);
    assert.equal(s.message_type.length, [...s.message_type].length, `${item.id}.message_type must be ASCII`);
    // request_identity.{principal_ref, request_id}: lowercase-with-dashes each
    assert.match(s.request_identity.principal_ref, principalRefShape, `${item.id}.request_identity.principal_ref must match ${principalRefShape}`);
    assert.equal(s.request_identity.principal_ref, s.request_identity.principal_ref.trim(), `${item.id}.request_identity.principal_ref must have no leading or trailing whitespace`);
    assert.equal(s.request_identity.principal_ref.length, [...s.request_identity.principal_ref].length, `${item.id}.request_identity.principal_ref must be ASCII`);
    assert.match(s.request_identity.request_id, requestIdShape, `${item.id}.request_identity.request_id must match ${requestIdShape}`);
    assert.equal(s.request_identity.request_id, s.request_identity.request_id.trim(), `${item.id}.request_identity.request_id must have no leading or trailing whitespace`);
    assert.equal(s.request_identity.request_id.length, [...s.request_identity.request_id].length, `${item.id}.request_identity.request_id must be ASCII`);
    // semantic_identity.sender.{namespace, agent_id}: lowercase-with-dashes each
    assert.match(s.semantic_identity.sender.namespace, namespaceShape, `${item.id}.semantic_identity.sender.namespace must match ${namespaceShape}`);
    assert.equal(s.semantic_identity.sender.namespace, s.semantic_identity.sender.namespace.trim(), `${item.id}.semantic_identity.sender.namespace must have no leading or trailing whitespace`);
    assert.equal(s.semantic_identity.sender.namespace.length, [...s.semantic_identity.sender.namespace].length, `${item.id}.semantic_identity.sender.namespace must be ASCII`);
    assert.match(s.semantic_identity.sender.agent_id, agentIdShape, `${item.id}.semantic_identity.sender.agent_id must match ${agentIdShape}`);
    assert.equal(s.semantic_identity.sender.agent_id, s.semantic_identity.sender.agent_id.trim(), `${item.id}.semantic_identity.sender.agent_id must have no leading or trailing whitespace`);
    assert.equal(s.semantic_identity.sender.agent_id.length, [...s.semantic_identity.sender.agent_id].length, `${item.id}.semantic_identity.sender.agent_id must be ASCII`);
    // semantic_identity.message_id: lowercase-with-dashes
    assert.match(s.semantic_identity.message_id, requestIdShape, `${item.id}.semantic_identity.message_id must match ${requestIdShape}`);
    assert.equal(s.semantic_identity.message_id, s.semantic_identity.message_id.trim(), `${item.id}.semantic_identity.message_id must have no leading or trailing whitespace`);
    assert.equal(s.semantic_identity.message_id.length, [...s.semantic_identity.message_id].length, `${item.id}.semantic_identity.message_id must be ASCII`);
    // envelope_digest: prefix + 64 lowercase hex chars
    assert.match(s.envelope_digest, envelopeDigestShape, `${item.id}.envelope_digest=${JSON.stringify(s.envelope_digest)} must match ${envelopeDigestShape} ('${envelopeDigestPrefix}<64 hex chars>')`);
    assert.equal(s.envelope_digest, s.envelope_digest.trim(), `${item.id}.envelope_digest must have no leading or trailing whitespace`);
    assert.equal(s.envelope_digest.length, [...s.envelope_digest].length, `${item.id}.envelope_digest must be ASCII`);
    // recipients: each entry's namespace and agent_id are lowercase-with-dashes
    for (const recipient of s.recipients) {
      assert.match(recipient.namespace, namespaceShape, `${item.id}.recipients[].namespace=${JSON.stringify(recipient.namespace)} must match ${namespaceShape}`);
      assert.equal(recipient.namespace, recipient.namespace.trim(), `${item.id}.recipients[].namespace must have no leading or trailing whitespace`);
      assert.equal(recipient.namespace.length, [...recipient.namespace].length, `${item.id}.recipients[].namespace must be ASCII`);
      assert.match(recipient.agent_id, agentIdShape, `${item.id}.recipients[].agent_id=${JSON.stringify(recipient.agent_id)} must match ${agentIdShape}`);
      assert.equal(recipient.agent_id, recipient.agent_id.trim(), `${item.id}.recipients[].agent_id must have no leading or trailing whitespace`);
      assert.equal(recipient.agent_id.length, [...recipient.agent_id].length, `${item.id}.recipients[].agent_id must be ASCII`);
    }
  }
});

test("binding rules-count covers the 0/256/257 cardinality boundary for binding_snapshot.rules", () => {
  // Filter by id prefix so the binding rules-count row stays correct after
  // later slices (e.g. authorization snapshot/rule field/grammar) append
  // additional cases at the end of the corpus.
  const bindingRulesCountCases = corpus.cases.filter((item) => item.id.startsWith("binding.rules-"));
  assert.deepEqual(
    bindingRulesCountCases.map((item) => item.id),
    [
      "binding.rules-empty-0",
      "binding.rules-256-admit",
      "binding.rules-257-reject",
    ],
  );
  // Strip any private (_-prefixed) fields before comparing expected bytes,
  // since the corpus shape is only the documented fields.
  const stripPrivate = (expected: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(expected)) {
      if (!k.startsWith("_")) out[k] = (expected as Record<string, unknown>)[k]!;
    }
    return out;
  };
  assert.deepEqual(
    bindingRulesCountCases.map((item) => stripPrivate(item.expected as Record<string, unknown>)),
    [
      // 0 rules: no rule matches -> AUTHORIZATION_DENIED at $
      { result: { kind: "rejected", code: "AUTHORIZATION_DENIED", field_path: "$" }, replay_oracle_calls: 0, replay_oracle_arguments: [] },
      // 256 rules: max valid; original matching rule plus 255 unique non-matching rules
      // -> admission_plan with the unchanged 4A digest (same digest as the valid base)
      { result: corpus.cases[0]!.expected.result, replay_oracle_calls: 1, replay_oracle_arguments: [{
        principal_ref: "principal-ref",
        request_id: "request-ref",
        sender: { namespace: "local", agent_id: "agent-a" },
        message_id: "message-ref",
        envelope_digest: (corpus.cases[0]!.expected.result as { kind: "admission_plan"; envelope_digest: string }).envelope_digest,
      }] },
      // 257 rules: cap exceeded -> INVALID_BINDING_SNAPSHOT at $.binding_snapshot.rules
      { result: { kind: "rejected", code: "INVALID_BINDING_SNAPSHOT", field_path: "$.binding_snapshot.rules" }, replay_oracle_calls: 0, replay_oracle_arguments: [] },
    ],
  );
  // Per-case rule-count proof: confirm the literal count of binding_snapshot.rules
  // for each generated case matches the bounded-subfamily name.
  for (const item of bindingRulesCountCases) {
    const request = JSON.parse(item.invocation_args.request_json) as { binding_snapshot: { rules: unknown[] } };
    const count = request.binding_snapshot.rules.length;
    if (item.id === "binding.rules-empty-0") assert.equal(count, 0, `${item.id} must have 0 rules`);
    if (item.id === "binding.rules-256-admit") assert.equal(count, 256, `${item.id} must have 256 rules`);
    if (item.id === "binding.rules-257-reject") assert.equal(count, 257, `${item.id} must have 257 rules`);
  }
});

test("local admission evaluates every required corpus record with exact output bytes and replay evidence", () => {
  for (const item of corpus.cases) {
    const actual = evaluate(item);
    assert.equal(JSON.stringify(actual), JSON.stringify(item.expected), item.id);
  }
});

test("the raw boundary rejects invalid UTF-8 representatives without creating an object entrypoint", () => {
  const first = corpus.cases[0]!;
  assert.deepEqual(
    admission.evaluateLocalAdmission(Buffer.from([0xff]) as unknown as string, first.invocation_args.envelope_json, () => "unseen"),
    { kind: "rejected", code: "INVALID_UTF8", field_path: "$" },
  );
  assert.deepEqual(
    admission.evaluateLocalAdmission("\ud800", first.invocation_args.envelope_json, () => "unseen"),
    { kind: "rejected", code: "INVALID_UTF8", field_path: "$" },
  );
});

test("ingress recipient normalization is order-independent and agrees across witnesses", (t) => {
  const first = corpus.cases[0]!;
  const request = JSON.parse(first.invocation_args.request_json) as {
    authorization_snapshot: { rules: Array<{ recipients: Array<{ namespace: string; agent_id: string }> }> };
  };
  const envelope = JSON.parse(first.invocation_args.envelope_json) as {
    recipients: Array<{ namespace: string; agent_id: string }>;
  };
  const sortedRecipients = [
    { namespace: "local", agent_id: "agent-b" },
    { namespace: "local", agent_id: "agent-c" },
  ];
  request.authorization_snapshot.rules[0]!.recipients = structuredClone(sortedRecipients);
  envelope.recipients = structuredClone(sortedRecipients).reverse();
  const invocation = {
    request_json: JSON.stringify(request),
    envelope_json: JSON.stringify(envelope),
    replay_oracle_result: "unseen",
  };
  const calls: unknown[] = [];
  const result = admission.evaluateLocalAdmission(
    invocation.request_json,
    invocation.envelope_json,
    (argument) => {
      calls.push(argument);
      return "unseen";
    },
  );
  assert.equal(result.kind, "admission_plan");
  if (result.kind !== "admission_plan") return;
  assert.deepEqual(result.recipients, sortedRecipients);
  assert.equal(result.envelope_digest, "meshfleet.a2a.fingerprint.v1:sha256:a59c52ffb3c2d02d77e89a402b24659d4fd5666848f496b9bc4a44db604b6d65");
  assert.deepEqual(calls, [{
    principal_ref: "principal-ref",
    request_id: "request-ref",
    sender: { namespace: "local", agent_id: "agent-a" },
    message_id: "message-ref",
    envelope_digest: "meshfleet.a2a.fingerprint.v1:sha256:a59c52ffb3c2d02d77e89a402b24659d4fd5666848f496b9bc4a44db604b6d65",
  }]);

  const available = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (available.status !== 0) {
    t.skip("python3 unavailable");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "meshfleet-local-admission-order-"));
  try {
    const path = join(directory, "invocation.json");
    writeFileSync(path, JSON.stringify(invocation), "utf8");
    const witness = spawnSync("python3", [pythonWitness, "--evaluate-file", path], { encoding: "utf8", timeout: 20_000 });
    assert.equal(witness.status, 0, witness.stderr || witness.stdout);
    assert.equal(witness.stdout.trim(), JSON.stringify({
      result,
      replay_oracle_calls: calls.length,
      replay_oracle_arguments: calls,
    }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("TypeScript and the mandatory Python reference agree on canonical result bytes for every admission case", (t) => {
  const available = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (available.status !== 0) {
    t.skip("python3 unavailable");
    return;
  }
  const run = spawnSync("python3", [pythonWitness, "--corpus", corpusPath], { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout) as {
    ok: boolean;
    case_count: number;
    outputs: Array<{ id: string; result_json: string; replay_oracle_calls: number; replay_oracle_arguments: unknown[] }>;
    failures: string[];
  };
  assert.equal(report.ok, true);
  assert.equal(report.case_count, corpus.cases.length);
  assert.deepEqual(report.failures, []);
  for (const [index, item] of corpus.cases.entries()) {
    const actual = evaluate(item);
    const witness = report.outputs[index]!;
    assert.equal(witness.id, item.id);
    assert.equal(witness.result_json, JSON.stringify(actual.result), item.id);
    assert.equal(witness.replay_oracle_calls, actual.replay_oracle_calls, item.id);
    assert.equal(JSON.stringify(witness.replay_oracle_arguments), JSON.stringify(actual.replay_oracle_arguments), item.id);
  }
});

test("expected-data and witness-output mutation canaries fail closed", (t) => {
  const first = corpus.cases[0]!;
  const actual = evaluate(first);
  const mutatedExpected = { ...first.expected, result: { kind: "rejected", code: "INVALID_REQUEST", field_path: "$" } };
  assert.notEqual(JSON.stringify(actual), JSON.stringify(mutatedExpected));

  const available = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (available.status !== 0) {
    t.skip("python3 unavailable");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "meshfleet-local-admission-"));
  try {
    const mutated = structuredClone(corpus) as typeof corpus;
    mutated.cases[0]!.expected = mutatedExpected;
    const path = join(directory, "mutated.json");
    writeFileSync(path, JSON.stringify(mutated), "utf8");
    const expectedFailure = spawnSync("python3", [pythonWitness, "--corpus", path], { encoding: "utf8", timeout: 20_000 });
    assert.notEqual(expectedFailure.status, 0);
    const witnessFailure = spawnSync("python3", [pythonWitness, "--corpus", corpusPath, "--mutate-output"], { encoding: "utf8", timeout: 20_000 });
    assert.notEqual(witnessFailure.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Python witness rejects ambiguous, nonstandard, and open corpus documents", (t) => {
  const available = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (available.status !== 0) {
    t.skip("python3 unavailable");
    return;
  }
  const raw = readFileSync(corpusPath, "utf8");
  const mutations = [
    raw.replace('{"mandatory_case_ids":', '{"mandatory_case_ids":[],"mandatory_case_ids":'),
    `{"poison":NaN,${raw.slice(1)}`,
    `{"extra":false,${raw.slice(1)}`,
  ];
  const directory = mkdtempSync(join(tmpdir(), "meshfleet-local-admission-corpus-"));
  try {
    for (const [index, mutation] of mutations.entries()) {
      const path = join(directory, `mutated-${index}.json`);
      writeFileSync(path, mutation, "utf8");
      const witness = spawnSync("python3", [pythonWitness, "--corpus", path], { encoding: "utf8", timeout: 20_000 });
      assert.notEqual(witness.status, 0, `mutation ${index} unexpectedly passed`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Python witness cannot treat a request kind field as a forged result", (t) => {
  const available = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (available.status !== 0) {
    t.skip("python3 unavailable");
    return;
  }
  const first = corpus.cases[0]!;
  const request = JSON.parse(first.invocation_args.request_json) as Record<string, unknown>;
  request.kind = "admission_plan";
  const invocation = {
    request_json: JSON.stringify(request),
    envelope_json: first.invocation_args.envelope_json,
    replay_oracle_result: "unseen",
  };
  const expected = {
    result: { kind: "rejected", code: "UNKNOWN_CORE_FIELD", field_path: "$" },
    replay_oracle_calls: 0,
    replay_oracle_arguments: [],
  };
  assert.deepEqual(
    evaluate({
      ...first,
      invocation_args: invocation,
    }),
    expected,
  );

  const directory = mkdtempSync(join(tmpdir(), "meshfleet-local-admission-kind-"));
  try {
    const path = join(directory, "invocation.json");
    writeFileSync(path, JSON.stringify(invocation), "utf8");
    const witness = spawnSync("python3", [pythonWitness, "--evaluate-file", path], { encoding: "utf8", timeout: 20_000 });
    assert.equal(witness.status, 0, witness.stderr || witness.stdout);
    assert.deepEqual(JSON.parse(witness.stdout), expected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("self-recipient envelope failures use the same safe recipients path across witnesses", (t) => {
  const available = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (available.status !== 0) {
    t.skip("python3 unavailable");
    return;
  }
  const first = corpus.cases[0]!;
  const envelope = JSON.parse(first.invocation_args.envelope_json) as {
    sender: { namespace: string; agent_id: string };
    recipients: Array<{ namespace: string; agent_id: string }>;
  };
  envelope.recipients = [structuredClone(envelope.sender)];
  const invocation = {
    request_json: first.invocation_args.request_json,
    envelope_json: JSON.stringify(envelope),
    replay_oracle_result: "unseen",
  };
  const expected = {
    result: { kind: "rejected", code: "MALFORMED_ENVELOPE", field_path: "$.envelope.recipients" },
    replay_oracle_calls: 0,
    replay_oracle_arguments: [],
  };
  assert.deepEqual(
    evaluate({
      ...first,
      invocation_args: invocation,
    }),
    expected,
  );

  const directory = mkdtempSync(join(tmpdir(), "meshfleet-local-admission-self-"));
  try {
    const path = join(directory, "invocation.json");
    writeFileSync(path, JSON.stringify(invocation), "utf8");
    const witness = spawnSync("python3", [pythonWitness, "--evaluate-file", path], { encoding: "utf8", timeout: 20_000 });
    assert.equal(witness.status, 0, witness.stderr || witness.stdout);
    assert.deepEqual(JSON.parse(witness.stdout), expected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the static sidecar has seven exact-null positives and all required closed negative cases", () => {
  const fixture = JSON.parse(readFileSync(sidecarPath, "utf8")) as {
    positive: Array<{ id: string; mapping: unknown }>;
    negative: Array<{ id: string; mapping: unknown }>;
  };
  assert.equal(fixture.positive.length, 7);
  assert.equal(fixture.negative.length, 14);
  for (const item of fixture.positive) assert.doesNotThrow(() => validateStaticHarnessMapping(item.mapping), item.id);
  for (const item of fixture.negative) assert.throws(() => validateStaticHarnessMapping(item.mapping), item.id);
});

test("local admission and sidecar stay offline, dormant, and outside renderer and package surfaces", () => {
  const localSource = readFileSync(join(root, "src", "a2a", "local-admission.ts"), "utf8");
  const replaySource = readFileSync(join(root, "src", "a2a", "replay-decision.ts"), "utf8");
  const sidecarSource = readFileSync(join(root, "src", "a2a", "static-harness-mapping.ts"), "utf8");
  const witnessSource = readFileSync(pythonWitness, "utf8");
  assert.match(localSource, /^import .*"\.\/codec\.js";$/m);
  assert.doesNotMatch(localSource, /^import .*"\.\/(?:db|mcp|runtime|transport|lifecycle|durable-acceptance)/m);
  assert.match(replaySource, /^import type \{ AgentRef \} from "\.\/types\.js";$/m);
  assert.doesNotMatch(replaySource, /^import .*"\.\/(?:codec|db|mcp|runtime|transport|lifecycle|durable-acceptance)/m);
  assert.doesNotMatch(sidecarSource, /^\s*import /m);
  assert.doesNotMatch(witnessSource, /^\s*(?:from|import)\s+(?:sqlite3|socket|urllib|http|requests|subprocess)\b/m);
  assert.doesNotMatch(readFileSync(join(root, "package.json"), "utf8"), /static-harness-mapping|local-admission|replay-decision/);
});
