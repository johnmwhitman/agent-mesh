import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CAPABILITY_PROFILE_V01_EXTENSION_REGISTRY,
  capabilityClaimFingerprint,
  capabilityProfileFingerprint,
  compareProfiles,
  renderConformance,
  translateProfile,
  validateProfile,
  validateTranslationResult,
} from "../src/a2a/capability-profile.js";

type CorpusCase = { case_id: string; api: string; invocation_args: Record<string, unknown>; expected: unknown };
const root = process.cwd();
const corpusPath = join(root, "test", "fixtures", "a2a", "capability", "v0.1", "corpus.json");
const pythonWitness = join(root, "reference", "python", "a2a_capability_profile_reference.py");

function invoke(item: CorpusCase): unknown {
  const args = item.invocation_args;
  switch (item.api) {
    case "validate-profile": return validateProfile(args.raw_profile, args.evaluation_time_ms);
    case "compare-profiles": return compareProfiles(args.raw_profiles, args.evaluation_time_ms);
    case "translate-profile": return translateProfile(args.input, args.evaluation_time_ms);
    case "validate-translation-result": return validateTranslationResult(args.result);
    case "render-conformance": return renderConformance(args.result, args.registry_record);
    default: throw new Error(`unknown corpus API ${item.api}`);
  }
}

test("Slice 4C-0 TypeScript reference exactly satisfies the five-operation corpus", () => {
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as CorpusCase[];
  assert.equal(corpus.length, 84);
  assert.equal(corpus.filter((item) => item.case_id.startsWith("extension.")).length, 56);
  assert.deepEqual(corpus.filter((item) => /^result\.r(?:0[0-9]|1[0-9]|2[0-2])$/.test(item.case_id)).map((item) => item.case_id), Array.from({ length: 23 }, (_, index) => `result.r${String(index).padStart(2, "0")}`));
  for (const item of corpus) assert.deepEqual(invoke(item), item.expected, item.case_id);
});

test("independent Python witness produces byte-equivalent corpus envelopes", (t) => {
  const available = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (available.status !== 0) { t.skip("python3 unavailable"); return; }
  const run = spawnSync("python3", [pythonWitness, "--corpus", corpusPath], { encoding: "utf8", timeout: 10_000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout) as { ok: boolean; case_count: number; failures: string[]; outcomes: Array<{ case_id: string; actual: unknown }> };
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as CorpusCase[];
  assert.equal(report.ok, true);
  assert.equal(report.case_count, corpus.length);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.outcomes.map((item) => item.case_id), corpus.map((item) => item.case_id));
  assert.deepEqual(report.outcomes.map((item) => item.actual), corpus.map((item) => item.expected));
});

test("fingerprints bind the complete profile identity and extension registry remains empty", () => {
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as CorpusCase[];
  const profile = structuredClone(corpus.find((item) => item.case_id === "profile.valid")!.invocation_args.raw_profile) as Record<string, unknown>;
  const changed = structuredClone(profile) as Record<string, unknown>;
  changed.profile_id = "cp_zzzzzzzzzzzzzzzzzzzz";
  assert.notEqual(capabilityProfileFingerprint(profile), capabilityProfileFingerprint(changed));
  assert.deepEqual(CAPABILITY_PROFILE_V01_EXTENSION_REGISTRY, {});
  assert.throws(() => capabilityClaimFingerprint(profile), /claim is unavailable/);
});

test("offline import boundary excludes integrations and authority surfaces", () => {
  const source = readFileSync(join(root, "src", "a2a", "capability-profile.ts"), "utf8");
  const python = readFileSync(pythonWitness, "utf8");
  assert.match(source, /^import \{ createHash \} from "node:crypto";/m);
  assert.doesNotMatch(source, /from "(?:\.\.\/)?(?:db|core|index|mcp|runtime|transport|provider|auth|credential)/);
  assert.doesNotMatch(source, /process\.env|fetch\(|http:|https:|spawn\(|exec\(/);
  assert.doesNotMatch(python, /^\s*(?:from|import)\s+(?:sqlite3|socket|urllib|http|requests|subprocess|os)\b/m);
  assert.doesNotMatch(source, /export function (?:send_a2a|authorize|recordDurableAcceptance)\b/);
});
