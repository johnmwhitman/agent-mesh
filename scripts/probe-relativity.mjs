#!/usr/bin/env node
// Probe the 8 new relativity cases against the TypeScript implementation and
// the mandatory Python witness BEFORE splicing into the corpus.
// Usage: node scripts/probe-relativity.mjs
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { evaluateLocalAdmission } from "../dist/a2a/local-admission.js";

const freshPath = "/tmp/relativity-new-cases.json";
const cases = JSON.parse(readFileSync(freshPath, "utf8"));

let tsPass = 0, tsFail = 0;
const tsResults = [];
for (const c of cases) {
  const calls = [];
  const result = evaluateLocalAdmission(
    c.invocation_args.request_json,
    c.invocation_args.envelope_json,
    (arg) => { calls.push(arg); return c.invocation_args.replay_oracle_result; },
  );
  const actual = {
    result,
    replay_oracle_calls: calls.length,
    replay_oracle_arguments: calls,
  };
  const expected = c.expected;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  tsResults.push({ id: c.id, ok, actual, expected });
  if (ok) tsPass++; else tsFail++;
}

console.log("=== TS probe ===");
for (const r of tsResults) {
  console.log(`${r.ok ? "OK " : "BAD"} ${r.id}`);
  if (!r.ok) {
    console.log("  expected:", JSON.stringify(r.expected));
    console.log("  actual:  ", JSON.stringify(r.actual));
  }
}
console.log(`TS: ${tsPass}/${cases.length} pass`);

// Now the witness for the same 8 cases
const pythonWitness = join(process.cwd(), "reference", "python", "a2a_local_admission_reference.py");
const available = spawnSync("python3", ["--version"], { encoding: "utf8" });
if (available.status !== 0) {
  console.log("python3 unavailable; skipping witness probe");
  process.exit(tsFail === 0 ? 0 : 1);
}
const dir = mkdtempSync(join(tmpdir(), "mf-relativity-probe-"));
try {
  let pyPass = 0, pyFail = 0;
  for (const c of cases) {
    const path = join(dir, `${c.id}.json`);
    writeFileSync(path, JSON.stringify({
      request_json: c.invocation_args.request_json,
      envelope_json: c.invocation_args.envelope_json,
      replay_oracle_result: c.invocation_args.replay_oracle_result,
    }));
    const r = spawnSync("python3", [pythonWitness, "--evaluate-file", path], { encoding: "utf8" });
    if (r.status !== 0) {
      pyFail++;
      console.log(`BAD ${c.id} (python exit ${r.status})`);
      console.log("  stderr:", r.stderr);
      continue;
    }
    let actual;
    try {
      actual = JSON.parse(r.stdout);
    } catch (e) {
      pyFail++;
      console.log(`BAD ${c.id} (json parse): ${r.stdout.slice(0, 200)}`);
      continue;
    }
    // The witness emits { result, replay_oracle_calls, replay_oracle_arguments }
    const ok = JSON.stringify(actual) === JSON.stringify(c.expected);
    if (ok) pyPass++; else pyFail++;
    if (!ok) {
      console.log(`BAD ${c.id}`);
      console.log("  expected:", JSON.stringify(c.expected));
      console.log("  actual:  ", JSON.stringify(actual));
    }
  }
  console.log(`Python witness: ${pyPass}/${cases.length} pass`);
  process.exit((tsFail === 0 && pyFail === 0) ? 0 : 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}