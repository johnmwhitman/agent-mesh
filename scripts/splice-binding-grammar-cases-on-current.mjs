#!/usr/bin/env node
// Splice 7 binding-grammar-gaps cases into the CURRENT corpus (preserving
// existing cases, compact serialization, no trailing newline).
// Reads the 7 new cases from /tmp/binding-grammar-new-cases.json (produced by
// gen-binding-grammar-cases.mjs). Appends them to cases[] + mandatory_case_ids[]
// in matching order, mirroring the splice-binding-grammar-cases.mjs contract
// but starting from whatever the current corpus is (44/49/...).
import { readFileSync, writeFileSync } from "node:fs";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = resolve(here, "../test/fixtures/a2a/local-admission/v0.1/corpus.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const fresh = JSON.parse(readFileSync("/tmp/binding-grammar-new-cases.json", "utf8"));

for (const item of fresh) {
  if (corpus.cases.some((x) => x.id === item.id)) throw new Error(`dup id ${item.id}`);
  if (corpus.mandatory_case_ids.includes(item.id)) throw new Error(`dup mandatory ${item.id}`);
  const { _note, ...clean } = item;
  corpus.cases.push(clean);
  corpus.mandatory_case_ids.push(clean.id);
}
// keep alignment
if (corpus.cases.length !== corpus.mandatory_case_ids.length) {
  throw new Error(`length mismatch cases=${corpus.cases.length} mandatory=${corpus.mandatory_case_ids.length}`);
}
writeFileSync(corpusPath, JSON.stringify(corpus));
console.log("corpus now:", corpus.cases.length, "cases /", corpus.mandatory_case_ids.length, "mandatory");