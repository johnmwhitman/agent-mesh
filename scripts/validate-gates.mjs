#!/usr/bin/env node
/**
 * Meshfleet release-gate runner: F2 (10/10 sequential fleets) and
 * F3 (3 concurrent fleets, no cross-corruption).
 *
 * Real MCP server (built dist), real spawned `opencode run` children,
 * isolated throwaway ledger. Fleet status is read from the ledger file
 * (ground truth), not parsed out of tool responses.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MESH = join(process.env.HOME, ".config/opencode/mcp-servers/agent-mesh");
const dir = mkdtempSync(join(tmpdir(), "mesh-gates-"));
const LEDGER = join(dir, "agent-mesh.json");
console.log(`ledger: ${LEDGER}`);

const transport = new StdioClientTransport({
  command: "node",
  args: [join(MESH, "dist/index.js")],
  env: {
    ...process.env,
    AGENT_MESH_DATA_FILE: LEDGER,
    MESHFLEET_SSE_PORT: "13977", // avoid colliding with any real instance
  },
  stderr: "ignore",
});
const client = new Client({ name: "gate-runner", version: "1.0.0" });
await client.connect(transport);

const ledger = () => JSON.parse(readFileSync(LEDGER, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function spawnFleet(tag) {
  const res = await client.callTool({
    name: "spawn_fleet",
    arguments: {
      agents: [
        { role: `echo-${tag}`, prompt: `Reply with exactly this string and nothing else: GATE-${tag}` },
        { role: `math-${tag}`, prompt: "What is 19*3? Reply with just the number." },
      ],
    },
  });
  const text = res.content?.[0]?.text ?? "";
  const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  if (!m) throw new Error(`no fleet id in spawn response: ${text.slice(0, 200)}`);
  return m[0];
}

function fleetState(fleetId) {
  const d = ledger();
  const agents = Object.values(d.agents).filter((a) => a.fleet_id === fleetId);
  return {
    fleet: d.fleets[fleetId]?.status,
    agents: agents.map((a) => ({ role: a.role, status: a.status, out: (a.output ?? "").trim().slice(0, 30) })),
    interrupted: agents.filter((a) => a.status === "interrupted").length,
  };
}

async function awaitFleet(fleetId, timeoutMs = 120_000) {
  const start = Date.now();
  for (;;) {
    const s = fleetState(fleetId);
    if (s.fleet === "complete" || s.fleet === "failed") return { ...s, secs: Math.round((Date.now() - start) / 1000) };
    if (Date.now() - start > timeoutMs) return { ...s, secs: Math.round((Date.now() - start) / 1000), timeout: true };
    await sleep(2000);
  }
}

// ---- F2: 10 sequential fleets ----------------------------------------------
console.log("\n=== F2: 10 sequential trivial fleets ===");
let f2pass = 0;
for (let i = 1; i <= 10; i++) {
  const id = await spawnFleet(`F2-${i}`);
  const r = await awaitFleet(id);
  const ok = r.fleet === "complete" && r.agents.every((a) => a.status === "complete") && r.interrupted === 0;
  if (ok) f2pass++;
  console.log(`  fleet ${i}: ${r.fleet} in ${r.secs}s ${r.timeout ? "TIMEOUT" : ""} | ${r.agents.map((a) => `${a.status}:${a.out}`).join(" | ")}`);
}
console.log(`F2 RESULT: ${f2pass}/10 ${f2pass === 10 ? "PASS" : "FAIL"}`);

// ---- F3: 3 concurrent fleets ------------------------------------------------
console.log("\n=== F3: 3 concurrent fleets ===");
const ids = [];
for (const tag of ["F3-a", "F3-b", "F3-c"]) ids.push(await spawnFleet(tag));
const results = await Promise.all(ids.map((id) => awaitFleet(id)));
let f3pass = 0;
results.forEach((r, i) => {
  const ok = r.fleet === "complete" && r.agents.every((a) => a.status === "complete") && r.interrupted === 0;
  if (ok) f3pass++;
  console.log(`  fleet ${ids[i].slice(0, 8)}: ${r.fleet} in ${r.secs}s | interrupted=${r.interrupted} | ${r.agents.map((a) => `${a.status}:${a.out}`).join(" | ")}`);
});
// cross-corruption check: NOTHING in the ledger may be interrupted
const finalLedger = ledger();
const anyInterrupted = Object.values(finalLedger.agents).filter((a) => a.status === "interrupted").length;
console.log(`F3 RESULT: ${f3pass}/3 fleets, ${anyInterrupted} interrupted agents ledger-wide → ${f3pass === 3 && anyInterrupted === 0 ? "PASS" : "FAIL"}`);

console.log(`\nGATES: F2=${f2pass === 10 ? "PASS" : "FAIL"} F3=${f3pass === 3 && anyInterrupted === 0 ? "PASS" : "FAIL"}`);
await client.close();
process.exit(f2pass === 10 && f3pass === 3 && anyInterrupted === 0 ? 0 : 1);
