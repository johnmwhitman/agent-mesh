#!/usr/bin/env node
// Splice the 17 generated binding-slice cases into the corpus: append cases
// (in id order), append ids to mandatory_case_ids (sorted), keep everything else.
import { readFileSync, writeFileSync } from "node:fs";

const corpusPath = new URL("../test/fixtures/a2a/local-admission/v0.1/corpus.json", import.meta.url);
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const fresh = JSON.parse(readFileSync("/tmp/binding-new-cases.json", "utf8"));

for (const item of fresh) {
  if (corpus.cases.some((x) => x.id === item.id)) throw new Error(`dup id ${item.id}`);
  if (corpus.mandatory_case_ids.includes(item.id)) throw new Error(`dup mandatory ${item.id}`);
  const { _note, ...clean } = item;
  corpus.cases.push(clean);
}
corpus.cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
corpus.mandatory_case_ids = [...corpus.mandatory_case_ids, ...fresh.map((x) => x.id)].sort();

writeFileSync(corpusPath, JSON.stringify(corpus, null, 2) + "\n");
console.log("corpus now:", corpus.cases.length, "cases /", corpus.mandatory_case_ids.length, "mandatory");
