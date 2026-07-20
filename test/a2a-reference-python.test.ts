import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = process.cwd();
const witness = join(root, "reference", "python", "a2a_reference.py");
const v01Corpus = join(root, "test", "fixtures", "a2a", "v0.1", "corpus.json");
const ingressCorpus = join(root, "test", "fixtures", "a2a", "ingress", "v0.1", "corpus.json");

test("Python reference witness agrees with the v0.1 and ingress corpora when Python 3 is available", (t) => {
  const availability = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (availability.error || availability.status !== 0) {
    t.skip("python3 is unavailable; cross-language witness execution skipped");
    return;
  }
  const run = spawnSync("python3", [witness, "--v01-corpus", v01Corpus, "--ingress-corpus", ingressCorpus], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout) as {
    ok: boolean;
    label: string;
    v01: { case_count: number; outcomes: Array<{ name: string }>; failures: unknown[] };
    ingress: { case_count: number; outcomes: Array<{ name: string; outcomes: Array<{ code: string }> }>; failures: unknown[] };
  };
  assert.equal(report.ok, true);
  assert.equal(report.label, "reference-conformance-only-not-production-public-durable-authenticated");
  const expectedV01 = JSON.parse(readFileSync(v01Corpus, "utf8")) as Array<{ name: string }>;
  const expectedIngress = JSON.parse(readFileSync(ingressCorpus, "utf8")) as {
    cases: Array<{ name: string; steps: unknown[] }>;
  };
  assert.equal(report.v01.case_count, expectedV01.length);
  assert.deepEqual(report.v01.outcomes.map(({ name }) => name), expectedV01.map(({ name }) => name));
  assert.equal(report.ingress.case_count, expectedIngress.cases.length);
  assert.deepEqual(report.ingress.outcomes.map(({ name }) => name), expectedIngress.cases.map(({ name }) => name));
  assert.deepEqual(
    report.ingress.outcomes.map(({ outcomes }) => outcomes.length),
    expectedIngress.cases.map(({ steps }) => steps.length),
  );
  const externalCodes = report.ingress.outcomes.flatMap(({ outcomes }) => outcomes.map(({ code }) => code));
  assert.doesNotMatch(
    externalCodes.join("\n"),
    /PRINCIPAL_UNKNOWN|SENDER_BINDING_DENIED|RECIPIENT_AUTHORIZATION_DENIED|TYPE_NOT_AUTHORIZED|AUDIENCE_NOT_AUTHORIZED/,
  );
  assert.deepEqual(report.v01.failures, []);
  assert.deepEqual(report.ingress.failures, []);
});

test("Python witness exits nonzero when a fixture expectation is mutated", (t) => {
  const availability = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (availability.error || availability.status !== 0) {
    t.skip("python3 is unavailable; negative witness self-test skipped");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "meshfleet-a2a-reference-"));
  try {
    const mutatedPath = join(directory, "mutated-v01.json");
    const mutated = JSON.parse(readFileSync(v01Corpus, "utf8")) as Array<Record<string, unknown>>;
    mutated[0] = { ...mutated[0], expected: "invalid" };
    writeFileSync(mutatedPath, JSON.stringify(mutated), "utf8");
    const run = spawnSync("python3", [witness, "--v01-corpus", mutatedPath, "--ingress-corpus", ingressCorpus], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(run.status, 0, run.stdout);
    const report = JSON.parse(run.stdout) as { ok: boolean; v01: { failures: Array<{ name: string }> } };
    assert.equal(report.ok, false);
    assert.equal(report.v01.failures[0]?.name, "valid-direct");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Python witness rejects nonstandard constants in a raw corpus document", (t) => {
  const availability = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (availability.error || availability.status !== 0) {
    t.skip("python3 is unavailable; strict corpus parsing self-test skipped");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "meshfleet-a2a-reference-json-"));
  try {
    const invalidPath = join(directory, "invalid-v01.json");
    writeFileSync(invalidPath, "[{\"value\":NaN}]", "utf8");
    const run = spawnSync("python3", [witness, "--v01-corpus", invalidPath, "--ingress-corpus", ingressCorpus], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /invalid_corpus_json/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Python witness is standalone, offline, and has no forbidden integration references", () => {
  assert.equal(existsSync(witness), true);
  const source = readFileSync(witness, "utf8");
  assert.doesNotMatch(source, /\b(?:mcp|runtime|opencode|pid|ndjson|network)\b/i);
  assert.doesNotMatch(source, /^\s*(?:from|import)\s+(?:sqlite3|socket|urllib|http|requests|subprocess)\b/m);
});

test("production MCP registry remains free of a canonical send_a2a tool", () => {
  const source = readFileSync(join(root, "src", "index.ts"), "utf8");
  assert.doesNotMatch(source, /name:\s*["']send_a2a["']/);
});
