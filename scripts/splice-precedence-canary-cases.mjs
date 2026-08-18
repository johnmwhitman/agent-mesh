#!/usr/bin/env node
/**
 * Splices the precedence canary cases (generator output) into
 * test/fixtures/a2a/local-admission/v0.1/corpus.json. The corpus is kept in
 * compact JSON.stringify(corpus) + "\n" form (never pretty-printed — tick-62
 * lesson: pretty-print breaks test 80 mutation).
 *
 * IDs are appended to mandatory_case_ids atomically. Existing 44 cases are
 * preserved unchanged; the new cases land at the tail. The added case count
 * is deterministic and driven by the generator (13 canaries + 13 controls).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const generator = join(here, "gen-precedence-canary-cases.mjs");
const corpusPath = join(here, "..", "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json");

const generated = spawnSync("node", [generator], { encoding: "utf8" });
if (generated.status !== 0) {
  console.error("generator failed:", generated.stderr);
  process.exit(1);
}
const { canaries, controls } = JSON.parse(generated.stdout);

const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const existingIds = new Set(corpus.mandatory_case_ids);
const newCases = [...canaries, ...controls];
for (const item of newCases) {
  if (existingIds.has(item.id)) {
    console.error(`FATAL: canary id "${item.id}" already exists in corpus`);
    process.exit(1);
  }
}

// Wrap each generated canary into the canonical corpus case shape.
const wrapped = newCases.map((item) => ({
  id: item.id,
  api: "evaluate-local-admission",
  invocation_args: {
    request_json: item.request_json,
    envelope_json: item.envelope_json,
    replay_oracle_result: item.replay_oracle_result,
  },
  expected: item.expected,
}));

corpus.cases = [...corpus.cases, ...wrapped];
corpus.mandatory_case_ids = [...corpus.mandatory_case_ids, ...newCases.map((item) => item.id)];

// Compact serialize: JSON.stringify with no indentation, trailing newline.
writeFileSync(corpusPath, JSON.stringify(corpus) + "\n");

console.log(`spliced ${canaries.length} canaries + ${controls.length} controls = ${newCases.length} new cases`);
console.log(`corpus now: ${corpus.cases.length} cases, ${corpus.mandatory_case_ids.length} mandatory ids`);
console.log(`wrote ${corpusPath}`);
