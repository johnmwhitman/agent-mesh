#!/usr/bin/env node
/**
 * V1 dogfood run #1: HOOL book research fan-out — REAL work, real output files.
 * Isolated ledger (John's stale live session never sees it); fixed dist build.
 * Config mirror of ~/AI/meshfleet-dogfood/hool-research-fanout.json.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MESH = join(process.env.HOME, ".config/opencode/mcp-servers/agent-mesh");
const dir = mkdtempSync(join(tmpdir(), "mesh-dogfood-"));
const LEDGER = join(dir, "agent-mesh.json");
console.log(`ledger: ${LEDGER}`);

const transport = new StdioClientTransport({
  command: "node",
  args: [join(MESH, "dist/index.js")],
  env: { ...process.env, AGENT_MESH_DATA_FILE: LEDGER, MESHFLEET_SSE_PORT: "13979" },
  stderr: "ignore",
});
const client = new Client({ name: "dogfood-hool", version: "1.0.0" });
await client.connect(transport);

const cfg = JSON.parse(readFileSync(join(process.env.HOME, "AI/meshfleet-dogfood/hool-research-fanout.json"), "utf8"));
const res = await client.callTool({ name: "spawn_fleet", arguments: { agents: cfg.agents } });
const text = res.content?.[0]?.text ?? "";
const fleetId = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
if (!fleetId) { console.error(`no fleet id: ${text.slice(0, 300)}`); process.exit(1); }
console.log(`fleet: ${fleetId} (3 agents, HOOL research fan-out)`);

const ledger = () => JSON.parse(readFileSync(LEDGER, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const start = Date.now();
for (;;) {
  const d = ledger();
  const agents = Object.values(d.agents).filter((a) => a.fleet_id === fleetId);
  const status = d.fleets[fleetId]?.status;
  const line = agents.map((a) => `${a.role}:${a.status}`).join(" | ");
  console.log(`[${Math.round((Date.now() - start) / 1000)}s] fleet=${status} ${line}`);
  if (status === "complete" || status === "failed") {
    console.log(`\nFLEET ${status.toUpperCase()} in ${Math.round((Date.now() - start) / 1000)}s`);
    for (const a of agents) {
      console.log(`\n--- ${a.role} (${a.status}) ---\n${(a.output ?? "").trim().slice(0, 1500)}`);
    }
    const interrupted = agents.filter((a) => a.status === "interrupted").length;
    console.log(`\ninterrupted: ${interrupted}`);
    process.exit(status === "complete" && interrupted === 0 ? 0 : 1);
  }
  await sleep(15000);
}
