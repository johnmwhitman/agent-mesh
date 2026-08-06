// Measure result-contract adoption in a meshfleet ledger, read-only.
//
// WHY THIS EXISTS: the result contract shipped observe-first so callers could
// "measure adoption before behaviour moves" (HANDOFF.md). The enforcement flip
// is gated on exactly one number — what fraction of terminal agents carry a
// contract value at all — and that number deserves a repeatable instrument,
// not a hand-written query whose author has already misread an epoch once.
//
// USAGE:  node scripts/contract-adoption.mjs <path-to-ledger.db>
// Build first (`npm run build`) — this imports from dist/ so it runs the same
// code a published install runs. The path argument is REQUIRED on purpose:
// this script never guesses at, or defaults to, anyone's live ledger.
//
// READ-ONLY by construction: `readLedgerFile` audits a private temp copy of
// the file; the ledger you point it at is never opened for writing.
//
// The one distinction that matters when reading the output:
//   "unset"  — the row carries NO contract field. Written by a pre-contract
//              server. This is the NON-ADOPTION signal: it counts servers
//              that have not been upgraded/redeployed, not agents that failed
//              to comply.
//   "absent" — a post-contract server evaluated the spawn and found no
//              envelope. This is the NON-COMPLIANCE signal: the agent was
//              taught the contract and wrote nothing.
// Conflating the two turns "the fleet runs an old server" into "agents
// ignore the contract" — opposite remediations, one flattering number.
import { readLedgerFile } from "../dist/db.js";

const TERMINAL = new Set(["complete", "failed", "interrupted"]);

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/contract-adoption.mjs <path-to-ledger.db>");
  console.error("The path is required — this tool never assumes a ledger location.");
  process.exit(2);
}

const data = readLedgerFile(file);
const agents = Object.values(data.agents);
const terminal = agents.filter((a) => TERMINAL.has(a.status));

const tally = (values) => {
  const out = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([, a], [, b]) => b - a));
};

const contract = tally(terminal.map((a) => a.result_contract ?? "unset"));
const unset = contract.unset ?? 0;
const withValue = terminal.length - unset;

console.log(JSON.stringify({
  ledger: file,
  agents_total: agents.length,
  terminal_total: terminal.length,
  status: tally(terminal.map((a) => a.status)),
  result_contract: contract,
  adoption: {
    rows_with_contract_value: withValue,
    rows_unset_pre_contract_server: unset,
    adopted_fraction: terminal.length === 0 ? null : Number((withValue / terminal.length).toFixed(4)),
  },
  stopped_reason: tally(
    terminal.filter((a) => a.status === "interrupted").map((a) => a.stopped_reason ?? "unattributed"),
  ),
  expects_artifact_flagged: agents.filter((a) => a.expects_artifact === true).length,
}, null, 2));
