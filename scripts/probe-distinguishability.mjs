
import { readFileSync } from "node:fs";
import * as admission from "../dist/a2a/local-admission.js";

const corpus = JSON.parse(readFileSync(process.argv[2], "utf8"));
const cases = new Map(corpus.cases.map((c) => [c.id, c]));

const PRECEDENCE_PAIR_IDS = [
  "precedence.A00-A01", "precedence.A01-A02", "precedence.A02-A03",
  "precedence.A03-A04", "precedence.A04-A05", "precedence.A05-A06",
  "precedence.A06-A07", "precedence.A07-A08", "precedence.A08-A09",
  "precedence.A09-A10", "precedence.A10-A11", "precedence.A11-A12",
  "precedence.A12-A13",
];

// A07, A08, A09 all collapse to AUTHORIZATION_DENIED at $ — the canary
// denies-before-oracle, so we cannot distinguish by result bytes; the proof
// is that the canary must NOT call the oracle in those cases.
const COLLAPSED = new Set(["precedence.A07-A08", "precedence.A08-A09"]);

function observe(req, env, replay) {
  const calls = [];
  const oracle = (arg) => { calls.push(arg); if (replay === "throws") throw new Error("fixture"); return replay; };
  const result = admission.evaluateLocalAdmission(req, env, oracle);
  return { result, replay_oracle_calls: calls.length, replay_oracle_arguments: calls };
}

let fails = 0;
for (const pairId of PRECEDENCE_PAIR_IDS) {
  const canary = cases.get(pairId);
  const laterId = pairId.replace("precedence.", "control.") + ".later";
  const control = cases.get(laterId);
  if (!canary || !control) { console.log("MISSING:", pairId, laterId); fails++; continue; }
  const c = observe(canary.invocation_args.request_json, canary.invocation_args.envelope_json, canary.invocation_args.replay_oracle_result);
  const l = observe(control.invocation_args.request_json, control.invocation_args.envelope_json, control.invocation_args.replay_oracle_result);
  if (COLLAPSED.has(pairId)) {
    // Both collapse to same result; the proof is zero oracle calls in the canary.
    const sameResult = JSON.stringify(c.result) === JSON.stringify(l.result);
    const noOracle = c.replay_oracle_calls === 0;
    if (sameResult && noOracle) {
      console.log(`${pairId}: OK (collapsed, deny-before-oracle proven)`);
    } else {
      console.log(`${pairId}: FAIL collapsed=${sameResult} noOracle=${noOracle}`);
      fails++;
    }
  } else {
    if (JSON.stringify(c) !== JSON.stringify(l)) {
      console.log(`${pairId}: OK (distinguishable)`);
    } else {
      console.log(`${pairId}: FAIL identical to ${laterId} — earlier step did not fire`);
      fails++;
    }
  }
}
console.log(`\n${fails} fail(s)`);
process.exit(fails > 0 ? 1 : 0);
