#!/usr/bin/env node
// Splice the 3 generated binding-rules-count cases into the corpus: append cases
// (in id order), append ids to mandatory_case_ids (sorted), keep everything else.
// Idempotent: refuses to splice if any id already present (so a stale /tmp file
// from a prior run can't half-splice).
import { readFileSync, writeFileSync } from "node:fs";

const corpusPath = new URL("../test/fixtures/a2a/local-admission/v0.1/corpus.json", import.meta.url);
const freshPath = "/tmp/binding-rules-count-new-cases.json";

const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const fresh = JSON.parse(readFileSync(freshPath, "utf8"));

const existingIds = new Set(corpus.cases.map((c) => c.id));
const existingMandatory = new Set(corpus.mandatory_case_ids);
for (const item of fresh) {
  if (existingIds.has(item.id)) throw new Error(`dup id ${item.id} already in cases`);
  if (existingMandatory.has(item.id)) throw new Error(`dup id ${item.id} already in mandatory_case_ids`);
}

for (const item of fresh) {
  const { _note, ...clean } = item;
  corpus.cases.push(clean);
}
// cases[] preserves insertion order; mandatory_case_ids[] also preserves insertion order.
// The "local admission evidence-alpha corpus is closed, self-consistent, and raw-text only"
// test asserts that cases.map(id) deep-equals mandatory_case_ids, so they MUST agree on
// order. Family-pin tests (e.g. authorization.boundary.*) further expect a stable insertion
// sequence. Alphabetical sort breaks both classes of assertion, so we append.
corpus.mandatory_case_ids = [...corpus.mandatory_case_ids, ...fresh.map((x) => x.id)];

writeFileSync(corpusPath, JSON.stringify(corpus) + "\n");
console.log("corpus now:", corpus.cases.length, "cases /", corpus.mandatory_case_ids.length, "mandatory");