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

test("local admission corpus is closed, complete, and raw-text only", () => {
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
  const sidecarSource = readFileSync(join(root, "src", "a2a", "static-harness-mapping.ts"), "utf8");
  const witnessSource = readFileSync(pythonWitness, "utf8");
  assert.match(localSource, /^import .*"\.\/codec\.js";$/m);
  assert.doesNotMatch(localSource, /^import .*"\.\/(?:db|mcp|runtime|transport|lifecycle|durable-acceptance)/m);
  assert.doesNotMatch(sidecarSource, /^\s*import /m);
  assert.doesNotMatch(witnessSource, /^\s*(?:from|import)\s+(?:sqlite3|socket|urllib|http|requests|subprocess)\b/m);
  assert.doesNotMatch(readFileSync(join(root, "package.json"), "utf8"), /static-harness-mapping|local-admission/);
});
