#!/usr/bin/env node
/**
 * receipted-fleet.mjs — the full Meshfleet loop in one runnable script:
 *
 *   spawn_fleet → real agent work → get_receipts → open_ratification
 *   → cast_vote (each agent's own verdict) → tally_ratification
 *
 * Three reviewers independently assess the same proposal, each ends with a
 * machine-readable VERDICT line, and a council ratifies the outcome. Every
 * message and vote leaves a per-recipient receipt in the ledger file, so when
 * it's done you can answer: who saw what, who approved it — from the record,
 * not from memory.
 *
 * Self-contained: no repo, no network beyond your model provider. The fleet
 * reviews an inline API-change proposal (below). Swap PROPOSAL and the agent
 * prompts for your real work.
 *
 * Prereqs: OpenCode installed (agents spawn via `opencode run`), meshfleet
 * built (`npm run build` in the repo root, or installed from npm).
 *
 * Usage: node examples/receipted-fleet.mjs
 * Output: ./out-receipted-fleet/ — the ledger (agent-mesh.json) IS the receipt.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist/index.js");
if (!existsSync(SERVER)) {
  console.error("dist/index.js not found — run `npm run build` first (or point SERVER at the npm install).");
  process.exit(1);
}

const OUT = join(process.cwd(), "out-receipted-fleet");
mkdirSync(OUT, { recursive: true });
const LEDGER = join(OUT, "agent-mesh.json");

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  env: { ...process.env, AGENT_MESH_DATA_FILE: LEDGER },
  stderr: "ignore",
});
const client = new Client({ name: "receipted-fleet-example", version: "1.0.0" });
await client.connect(transport);

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return text; }
};
const step = (msg) => console.log(`\n▸ ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the subject
const PROPOSAL = `
API change proposal: our public /search endpoint currently returns results as a
bare JSON array. Proposal: wrap it in an envelope object — {results: [...],
total: n, next_cursor: string|null} — so we can add pagination and metadata
without another breaking change later. This IS a breaking change for existing
clients. Ship it in the next minor version with a 90-day deprecation header on
the old shape, or hold for the next major?
`.trim();

const VERDICT_SUFFIX =
  "\n\nEnd your output with exactly one line starting with 'VERDICT:' — either " +
  "'VERDICT: APPROVE — <one sentence why>' or 'VERDICT: REJECT — <one sentence why>'. " +
  "This line is read programmatically, so use that exact literal prefix.";

const agents = [
  {
    role: "API design reviewer",
    prompt:
      "You are reviewing this API change proposal on its design merits — envelope vs bare " +
      "array, forward-compatibility, REST conventions:\n\n" + PROPOSAL +
      "\n\nGive a short, concrete assessment." + VERDICT_SUFFIX,
  },
  {
    role: "Compatibility skeptic",
    prompt:
      "You are the breaking-change skeptic reviewing this proposal. Focus ONLY on client " +
      "impact: who breaks, how loudly, whether a 90-day deprecation header is actually " +
      "discoverable, and what a safer rollout would look like:\n\n" + PROPOSAL +
      "\n\nBe adversarial but fair." + VERDICT_SUFFIX,
  },
  {
    role: "Operations reviewer",
    prompt:
      "You are reviewing this proposal from the operations side: monitoring the migration, " +
      "supporting two response shapes during the deprecation window, and the cost of holding " +
      "for a major version instead:\n\n" + PROPOSAL +
      "\n\nGive a short, concrete assessment." + VERDICT_SUFFIX,
  },
];

// ------------------------------------------------------------- 1. spawn_fleet
step("spawn_fleet — 3 independent reviewers, real OS processes");
const spawnRes = await call("spawn_fleet", { agents });
const fleetId = spawnRes.fleet_id;
const agentIds = spawnRes.agent_ids;
console.log(`fleet: ${fleetId}`);
console.log(agentIds.map((id, i) => `  ${agents[i].role} = ${id}`).join("\n"));

// ------------------------------------------------- 2. watch the board until done
const ledger = () => JSON.parse(readFileSync(LEDGER, "utf8"));
const start = Date.now();
let final;
for (;;) {
  const d = ledger();
  const live = agentIds.map((id) => d.agents[id]);
  const status = d.fleets[fleetId]?.status;
  console.log(
    `[${Math.round((Date.now() - start) / 1000)}s] fleet=${status} ` +
      live.map((a) => `${a?.role}:${a?.status}`).join(" | ")
  );
  if (status === "complete" || status === "failed") { final = live; break; }
  await sleep(10000);
}

// -------------------------------------------------------- 3. parsed verdicts
step("collect each agent's verdict from its output");
const verdicts = {};
for (const [i, a] of final.entries()) {
  const id = agentIds[i];
  const output = (a?.output ?? "").trim();
  writeFileSync(join(OUT, `output-${i}-${agents[i].role.replace(/\s+/g, "-")}.txt`), output);
  const m = output.match(/VERDICT:\s*(APPROVE|REJECT)\s*[—-]?\s*(.*)/i);
  verdicts[id] = m
    ? { approve: /APPROVE/i.test(m[1]), note: m[2].slice(0, 200) }
    : { approve: false, note: "no VERDICT line found — treated as reject" };
  console.log(`  ${agents[i].role}: ${verdicts[id].approve ? "APPROVE" : "REJECT"} — ${verdicts[id].note}`);
}

// -------------------------------------------------- 4. council ratification
step("open_ratification — the decision goes on the record");
const openRes = await call("open_ratification", {
  proposer: agentIds[0],
  fleet_id: fleetId,
  subject: "Adopt the envelope response shape in the next minor version with a 90-day deprecation window.",
  quorum: 2,
  voters: agentIds,
});
const proposalId = typeof openRes === "string" ? openRes : (openRes.message_id ?? openRes);
console.log(`proposal: ${proposalId}`);

step("cast_vote — each agent's own verdict, relayed verbatim");
for (const id of agentIds) {
  await call("cast_vote", {
    agent_id: id,
    message_id: proposalId,
    approve: verdicts[id].approve,
    note: verdicts[id].note,
  });
}

step("tally_ratification");
const tally = await call("tally_ratification", { message_id: proposalId });
console.log(JSON.stringify(tally, null, 2));

// Receipts attach to MESSAGES (get_receipts takes message_id, not agent_id).
// The proposal's trail is the interesting record: every vote is a receipt row.
step("get_receipts on the proposal — who saw it, who acted, from the record");
const trail = await call("get_receipts", { message_id: proposalId });
console.log(JSON.stringify(trail, null, 2));

console.log(`\nDone. The ledger at ${LEDGER} is the receipt:`);
console.log("  every message, delivery receipt, and vote above is a queryable row in it.");
await client.close();
process.exit(0);
