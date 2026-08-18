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
const coverageLedgerPath = join(root, "docs", "ops", "A2A-LOCAL-ADMISSION-COVERAGE-LEDGER-2026-07-29.md");
const namedInventoryBranchNames = [
  "feat/request-raw-path-gates-20260818",
  "feat/request-raw-path-per-object-gates-20260818",
  "feat/request-raw-path-cross-object-gates-20260818",
  "feat/independent-input-gates-20260818",
  "feat/depth-numeric-gates-20260818",
  "feat/envelope-member-gates-20260817",
  "feat/envelope-path-precision-20260817",
  "feat/evidence-field-gates-20260817",
  "feat/evidence-field-grammar-20260818",
  "feat/binding-grammar-gaps-20260817",
  "feat/binding-interval-edges-20260818",
  "feat/binding-rules-count-gates-20260818",
  "feat/binding-slice-20260817",
  "feat/authorization-snapshot-gates-20260817",
  "feat/auth-context-gates-20260818",
  "feat/relativity-changed-fixtures-20260818",
  "feat/oracle-malformed-gates-20260818",
  "feat/rejected-code-inventory-20260817",
  "feat/privacy-invariance-matrix-20260817",
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

test("coverage-ledger named inventory pins the 19 merge-ready Section 9 closure branches", () => {
  const text = readFileSync(coverageLedgerPath, "utf8");
  for (const name of namedInventoryBranchNames) {
    assert.match(
      text,
      new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `coverage-ledger must name the merge-ready branch ${name} (Section 9 named inventory)`,
    );
  }
});

// Tick-81 (2026-08-18): the local-refs existence pin introduced in 5b42642 was
// dropped because the contract it asserts is unsatisfiable in the long-lived
// lifecycle of this branch. CI `actions/checkout` materialises only the PR's
// source branch + origin's default branch as `refs/heads/*`; the 19 named
// merge-ready branches are not in `refs/remotes/origin/*`, so a fresh clone
// fails the suite even when the ledger names are correct. The test also locks
// permanently red once the merge-ready branches land and their worktrees are
// pruned (the runner-prune-worktrees branch is queued MERGE-READY). The
// text-presence pin above is the right contract for "this branch's name lives
// in the ledger".

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

test("Section 9 precedence family: 13 adjacent A00-A13 canaries are pinned in the canonical corpus", () => {
  const PRECEDENCE_PAIR_IDS = [
    "precedence.A00-A01", "precedence.A01-A02", "precedence.A02-A03",
    "precedence.A03-A04", "precedence.A04-A05", "precedence.A05-A06",
    "precedence.A06-A07", "precedence.A07-A08", "precedence.A08-A09",
    "precedence.A09-A10", "precedence.A10-A11", "precedence.A11-A12",
    "precedence.A12-A13",
  ] as const;
  const LATER_ONLY_IDS = PRECEDENCE_PAIR_IDS.map((id) => id.replace("precedence.", "control.") + ".later");
  const allCanaryIds = [...PRECEDENCE_PAIR_IDS, ...LATER_ONLY_IDS];

  // 1. Pin family: every canary id is mandatory in the corpus.
  for (const id of allCanaryIds) {
    assert.ok(corpus.mandatory_case_ids.includes(id), `${id} must be a mandatory corpus case`);
  }
  // 2. Pin family order: the canary lands BEFORE its later-only control.
  for (const pairId of PRECEDENCE_PAIR_IDS) {
    const laterId = pairId.replace("precedence.", "control.") + ".later";
    const canaryPos = corpus.mandatory_case_ids.indexOf(pairId);
    const laterPos = corpus.mandatory_case_ids.indexOf(laterId);
    assert.ok(canaryPos < laterPos, `${pairId} (${canaryPos}) must precede ${laterId} (${laterPos})`);
  }

  // 3. Per-pair precedence outcome: each canary's expected result matches the
  //    EARLIER step's failure code (or AUTHORIZATION_DENIED for the A07-A08/A08-A09
  //    collapsed public pair). The canary must FAIL CLOSED by being adjacent-ORDER:
  //    the canary's actual observation must NOT match the later-only control unless
  //    the pair is documented as collapsed.
  const COLLAPSED_PUBLIC_PAIRS = new Set(["precedence.A07-A08", "precedence.A08-A09"]);
  const casesById = new Map(corpus.cases.map((item) => [item.id, item]));

  // Encode the canonical "earlier step wins" outcome per pair. This is the
  // closed authoritative ordering from docs/A2A-LOCAL-ADMISSION-PROFILE-v0.1.md
  // Section 6: A00 -> A01 -> ... -> A13. Each canary matches the EARLIER step.
  const EARLIER_STEP_OUTCOMES: Record<string, string> = {
    "precedence.A00-A01": "rejected:REQUEST_TOO_LARGE@$",
    "precedence.A01-A02": "rejected:UNKNOWN_CORE_FIELD@$",
    "precedence.A02-A03": "rejected:INVALID_REQUEST@$.action",
    "precedence.A03-A04": "rejected:MALFORMED_ENVELOPE@$.envelope",
    "precedence.A04-A05": "rejected:INVALID_AUTHENTICATION_EVIDENCE@$.authentication_evidence.provenance",
    "precedence.A05-A06": "rejected:INVALID_BINDING_SNAPSHOT@$.binding_snapshot.snapshot_version",
    "precedence.A06-A07": "rejected:INVALID_AUTHORIZATION_SNAPSHOT@$.authorization_snapshot.snapshot_version",
    "precedence.A07-A08": "rejected:AUTHORIZATION_DENIED@$",
    "precedence.A08-A09": "rejected:AUTHORIZATION_DENIED@$",
    "precedence.A09-A10": "rejected:AUTHORIZATION_DENIED@$",
    "precedence.A10-A11": "rejected:REPLAY_PROTECTION_UNAVAILABLE@$",
    "precedence.A11-A12": "not_admitted:duplicate",
    "precedence.A12-A13": "not_admitted:expired_at_acceptance",
  };
  for (const pairId of PRECEDENCE_PAIR_IDS) {
    const canary = casesById.get(pairId)!;
    const expected = EARLIER_STEP_OUTCOMES[pairId]!;
    const result = canary.expected.result as { kind: string; code?: string; disposition?: string; field_path?: string };
    let actual: string;
    if (result.kind === "rejected") actual = `rejected:${result.code}@${result.field_path}`;
    else actual = `not_admitted:${result.disposition}`;
    assert.equal(actual, expected, `${pairId} per-pair precedence outcome must match the earlier step`);
  }

  // 4. Observation mismatch: the canary must not equal the later-only control.
  //    For collapsed pairs (A07-A08, A08-A09), both project AUTHORIZATION_DENIED at $;
  //    the canary's proof is that it made zero oracle calls (denied-before-oracle).
  for (const pairId of PRECEDENCE_PAIR_IDS) {
    const canary = casesById.get(pairId)!;
    const laterId = pairId.replace("precedence.", "control.") + ".later";
    const control = casesById.get(laterId)!;
    if (COLLAPSED_PUBLIC_PAIRS.has(pairId)) {
      assert.deepEqual(canary.expected.result, control.expected.result, `${pairId} collapses to the same public result as ${laterId}`);
      assert.equal(canary.expected.replay_oracle_calls, 0, `${pairId} must deny before the oracle`);
    } else {
      assert.notEqual(
        JSON.stringify(canary.expected),
        JSON.stringify(control.expected),
        `${pairId} must not match ${laterId}; skipping the earlier row would collapse this canary onto the later-only control`,
      );
    }
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
