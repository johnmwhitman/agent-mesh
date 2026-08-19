#!/usr/bin/env node
// Splice the 7 generated binding-grammar-gaps cases into the corpus,
// preserving the EXACT original case order (semantic grouping) and the
// original compact serialization (no indent, no trailing newline).
// Starts from the pristine 44-case corpus at origin/main base c571928.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const corpusPath = new URL("../test/fixtures/a2a/local-admission/v0.1/corpus.json", import.meta.url);
const repoRoot = new URL("..", import.meta.url).pathname;
const baseCorpusPath = "/tmp/binding-grammar-base-corpus.json";
if (!existsSync(baseCorpusPath)) {
  execFileSync("bash", ["-c", `cd "${repoRoot}" && git show c571928:test/fixtures/a2a/local-admission/v0.1/corpus.json > /tmp/binding-grammar-base-corpus.json`]);
}
const corpus = JSON.parse(readFileSync(baseCorpusPath, "utf8"));
const fresh = JSON.parse(readFileSync("/tmp/binding-grammar-new-cases.json", "utf8"));

for (const item of fresh) {
  if (corpus.cases.some((x) => x.id === item.id)) throw new Error(`dup id ${item.id}`);
  if (corpus.mandatory_case_ids.includes(item.id)) throw new Error(`dup mandatory ${item.id}`);
  const { _note, ...clean } = item;
  corpus.cases.push(clean);
  corpus.mandatory_case_ids.push(clean.id);
}
// cases and mandatory_case_ids must stay aligned in the SAME order
// (cases order preserved: original 44 + 7 appended; mandatory mirrors cases)
corpus.cases = corpus.cases.sort((a, b) => {
  // keep semantic grouping: append new binding.* cases after existing binding.*,
  // and new authorization.* cases after existing authorization.*
  const rank = (id) => {
    if (id.startsWith("authorization.")) return 1;
    if (id.startsWith("binding.")) return 2;
    return 0;
  };
  const ra = rank(a.id), rb = rank(b.id);
  if (ra !== rb) return ra - rb;
  return corpus.mandatory_case_ids.indexOf(a.id) - corpus.mandatory_case_ids.indexOf(b.id);
});
corpus.mandatory_case_ids = corpus.cases.map((x) => x.id);

writeFileSync(corpusPath, JSON.stringify(corpus));
console.log("corpus now:", corpus.cases.length, "cases /", corpus.mandatory_case_ids.length, "mandatory");
