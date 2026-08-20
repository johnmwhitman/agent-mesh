#!/usr/bin/env node
// Splice the binding-cap-threshold-pin cases produced by
// gen-binding-cap-threshold-pin-cases.mjs into
// test/fixtures/a2a/local-admission/v0.1/corpus.json.
//
// Refuses to run unless the corpus is still in its 52-case pristine shape
// (the post-binding-rules-count state, matching the train/20260820 baseline).
// Idempotent and pinned to /tmp/corpus-pristine-52.json.
//
// Usage: node scripts/gen-binding-cap-threshold-pin-cases.mjs > /tmp/binding-cap-threshold-pin-new-cases.json
//        node scripts/splice-binding-cap-threshold-pin-cases.mjs /tmp/binding-cap-threshold-pin-new-cases.json
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const corpusPath = join(repoRoot, "test/fixtures/a2a/local-admission/v0.1/corpus.json");

const newCasesPath = process.argv[2];
if (!newCasesPath) {
  console.error("usage: splice-binding-cap-threshold-pin-cases.mjs <new-cases.json>");
  process.exit(2);
}

const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const newCases = JSON.parse(readFileSync(newCasesPath, "utf8"));

// Pristine check: must be exactly the 52-case post-binding-rules-count state.
const PR = "/tmp/corpus-pristine-52.json";
if (!existsSync(PR)) {
  execFileSync("bash", ["-c", `git -C "${repoRoot}" show train/20260820:test/fixtures/a2a/local-admission/v0.1/corpus.json > ${PR}`]);
}
const pristine = JSON.parse(readFileSync(PR, "utf8"));
if (corpus.cases.length !== pristine.cases.length) {
  console.error(`refusing: corpus.cases.length=${corpus.cases.length} != pristine ${pristine.cases.length} (already spliced or drifted)`);
  process.exit(1);
}
if (corpus.mandatory_case_ids.length !== pristine.mandatory_case_ids.length) {
  console.error(`refusing: mandatory_case_ids length drift (got ${corpus.mandatory_case_ids.length}, pristine ${pristine.mandatory_case_ids.length})`);
  process.exit(1);
}
for (let i = 0; i < pristine.cases.length; i += 1) {
  if (corpus.cases[i].id !== pristine.cases[i].id) {
    console.error(`refusing: case[${i}].id drift (got ${corpus.cases[i].id}, pristine ${pristine.cases[i].id})`);
    process.exit(1);
  }
}

// Refuse if any new id already present or new cases introduce duplicates.
const newIds = newCases.map((c) => c.id);
if (new Set(newIds).size !== newIds.length) {
  console.error("refusing: duplicate ids in new-cases input");
  process.exit(1);
}
const existingIds = new Set(corpus.cases.map((c) => c.id));
for (const id of newIds) {
  if (existingIds.has(id)) {
    console.error(`refusing: ${id} already present`);
    process.exit(1);
  }
}

// Splice: append in the same order as the generator emitted them.
corpus.cases = [...corpus.cases, ...newCases];
corpus.mandatory_case_ids = [...corpus.mandatory_case_ids, ...newIds];

writeFileSync(corpusPath, `${JSON.stringify(corpus)}\n`, "utf8");
console.log(`Spliced ${newIds.length} binding-cap-threshold-pin cases (corpus ${pristine.cases.length} -> ${corpus.cases.length}).`);
