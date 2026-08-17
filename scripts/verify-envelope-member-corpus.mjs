#!/usr/bin/env node
// Splice helper: verify the final corpus against TS dist + Python witness and
// print the exact diffs for the envelope member cases (tick 56).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(readFileSync(join(root, "test", "fixtures", "a2a", "local-admission", "v0.1", "corpus.json"), "utf8"));

// TS dist parity
const admission = await import("../dist/a2a/local-admission.js");
let bad = 0;
for (const c of corpus.cases) {
  const calls = [];
  const r = admission.evaluateLocalAdmission(c.invocation_args.request_json, c.invocation_args.envelope_json, (a) => { calls.push(a); return c.invocation_args.replay_oracle_result; });
  const ok = JSON.stringify(r) === JSON.stringify(c.expected.result) && calls.length === c.expected.replay_oracle_calls;
  if (!ok) { bad += 1; console.log("TS DIFF", c.id, JSON.stringify(r)); }
}
console.log(`TS parity: ${corpus.cases.length - bad}/${corpus.cases.length}`);

// Python witness parity
const py = spawnSync("/opt/homebrew/bin/python3", ["reference/python/a2a_local_admission_reference.py", "--corpus", "test/fixtures/a2a/local-admission/v0.1/corpus.json"], { cwd: root, encoding: "utf8", timeout: 60000 });
const report = JSON.parse(py.stdout);
console.log(`Python witness: ok=${report.ok} case_count=${report.case_count} failures=${JSON.stringify(report.failures ?? [])}`);
process.exit(report.ok && bad === 0 ? 0 : 1);
