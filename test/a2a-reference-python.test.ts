import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

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
    v01: { case_count: number; failures: unknown[] };
    ingress: { case_count: number; failures: unknown[] };
  };
  assert.equal(report.ok, true);
  assert.equal(report.label, "reference-conformance-only-not-production-public-durable-authenticated");
  assert.equal(report.v01.case_count, JSON.parse(readFileSync(v01Corpus, "utf8")).length);
  assert.ok(report.ingress.case_count >= 7);
  assert.deepEqual(report.v01.failures, []);
  assert.deepEqual(report.ingress.failures, []);
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
