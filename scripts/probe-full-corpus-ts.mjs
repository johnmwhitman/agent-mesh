#!/usr/bin/env node
// Run the FULL corpus (44 baseline) through TS to make sure no other case
// is broken by reading the corpus before we splice. Run from a worktree
// root: node scripts/probe-full-corpus-ts.mjs
import { readFileSync } from "node:fs";
import { evaluateLocalAdmission } from "../dist/a2a/local-admission.js";

const corpus = JSON.parse(readFileSync(process.cwd() + "/test/fixtures/a2a/local-admission/v0.1/corpus.json", "utf8"));
let pass = 0, fail = 0;
for (const c of corpus.cases) {
  const calls = [];
  const result = evaluateLocalAdmission(
    c.invocation_args.request_json,
    c.invocation_args.envelope_json,
    (arg) => { calls.push(arg); if (c.invocation_args.replay_oracle_result === "throws") throw new Error("fixture"); return c.invocation_args.replay_oracle_result; },
  );
  const actual = { result, replay_oracle_calls: calls.length, replay_oracle_arguments: calls };
  if (JSON.stringify(actual) === JSON.stringify(c.expected)) pass++;
  else { fail++; console.log("FAIL", c.id); }
}
console.log("TS corpus:", pass, "pass /", fail, "fail /", corpus.cases.length, "total");