
import { readFileSync } from "node:fs";
import * as admission from "../dist/a2a/local-admission.js";

const corpus = JSON.parse(readFileSync(process.argv[2], "utf8"));
const canaries = corpus.cases.filter((c) => c.id.startsWith("precedence.") || c.id.startsWith("control."));
for (const c of canaries) {
  const calls = [];
  const oracle = (arg) => { calls.push(arg); if (c.invocation_args.replay_oracle_result === "throws") throw new Error("fixture"); return c.invocation_args.replay_oracle_result; };
  const result = admission.evaluateLocalAdmission(c.invocation_args.request_json, c.invocation_args.envelope_json, oracle);
  const actual = { result, replay_oracle_calls: calls.length, replay_oracle_arguments: calls };
  const expected = c.expected;
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${c.id}: ${same ? "OK" : "FAIL"}`);
  if (!same) {
    console.log("  expected:", JSON.stringify(expected));
    console.log("  actual:  ", JSON.stringify(actual));
  }
}
