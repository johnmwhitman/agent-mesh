#!/usr/bin/env node
// Splice the binding-rules-count cases produced by gen-binding-rules-count-cases.mjs
// into test/fixtures/a2a/local-admission/v0.1/corpus.json.
//
// Refuses to run unless the corpus is still in its 49-case pristine shape
// (i.e. exactly the state we expect on a freshly-merged origin/main). This is
// the same self-heal pattern as gen-auth-context-cases.mjs +
// splice-auth-context-cases.mjs: an idempotent two-script split, each script
// pinned to a named baseline, that aborts loudly if the repo has drifted.
//
// Usage: node scripts/gen-binding-rules-count-cases.mjs > /tmp/binding-rules-count-new-cases.json
//        node scripts/splice-binding-rules-count-cases.mjs /tmp/binding-rules-count-new-cases.json
import { readFileSync, writeFileSync } from "node:fs";

const newCasesPath = process.argv[2];
if (!newCasesPath) {
  console.error("usage: splice-binding-rules-count-cases.mjs <new-cases.json>");
  process.exit(2);
}

const corpusPath = new URL("../test/fixtures/a2a/local-admission/v0.1/corpus.json", import.meta.url);
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const newCases = JSON.parse(readFileSync(newCasesPath, "utf8"));

// Pristine check: must be exactly the 49-case origin/main state.
const PR = "/tmp/corpus-pristine-49.json";
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
console.log(`Spliced ${newIds.length} binding-rules-count cases (corpus ${pristine.cases.length} -> ${corpus.cases.length}).`);