#!/usr/bin/env node
// Splice the depth-threshold-pin new cases into the local-admission corpus,
// pinned to its 49-case pristine shape. Refuses to run if the corpus has
// drifted (the post-binding-rules-count train state has 52 cases; the
// depth-threshold-pin slice is layered onto the origin/main HEAD 2c2e392
// 49-case baseline so it does not race the train's binding subfamily).
//
// Usage: node scripts/splice-depth-threshold-pin-cases.mjs /tmp/depth-threshold-pin-new-cases.json
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const corpusPath = join(repoRoot, "test/fixtures/a2a/local-admission/v0.1/corpus.json");

const newCasesPath = process.argv[2];
if (!newCasesPath) throw new Error(`usage: splice-depth-threshold-pin-cases.mjs <new-cases-json>`);
const newCases = JSON.parse(readFileSync(newCasesPath, "utf8"));
if (!Array.isArray(newCases) || newCases.length !== 2) {
  throw new Error(`expected 2 new cases, got ${Array.isArray(newCases) ? newCases.length : typeof newCases}`);
}

const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
if (corpus.cases.length !== 49) {
  throw new Error(`corpus must be 49 cases for splice (origin/main HEAD 2c2e392 state), got ${corpus.cases.length}`);
}

const idsToAppend = newCases.map((c) => c.id);
for (const id of idsToAppend) {
  if (corpus.cases.some((c) => c.id === id)) {
    throw new Error(`corpus already contains ${id} (idempotency guard)`);
  }
}

// Append in stable insertion order (matches the binding-cap-threshold-pin
// pattern at scripts/splice-binding-cap-threshold-pin-cases.mjs).
corpus.cases.push(...newCases);
corpus.mandatory_case_ids.push(...idsToAppend);

// Sanity: cases.map(c => c.id) must equal mandatory_case_ids (the corpus
// shape guard in test/a2a-local-admission.test.ts checks this).
const deepEqual = JSON.stringify(corpus.cases.map((c) => c.id)) === JSON.stringify(corpus.mandatory_case_ids);
if (!deepEqual) throw new Error(`cases.map(id) != mandatory_case_ids after splice (corpus shape violated)`);

writeFileSync(corpusPath, JSON.stringify(corpus, null, 0) + "\n");
console.log(`spliced ${newCases.length} depth-threshold cases into corpus (49 -> ${corpus.cases.length})`);
console.log(`appended ids: ${idsToAppend.join(", ")}`);