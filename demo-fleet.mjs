import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
});

const client = new Client({ name: "demo", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

console.log("Spawning 4-agent fleet (the same work that timed out in background tasks)...\n");

const start = Date.now();

const result = await client.callTool({
  name: "spawn_fleet",
  arguments: {
    agents: [
      { role: "explore", prompt: "List all .md files in /tmp/demo-source/docs and count them." },
      { role: "explore", prompt: "Describe the hero section structure on openrouter.ai homepage." },
      { role: "librarian", prompt: "Summarize best practices for combining marketing and docs sites from Tailscale and OpenRouter." },
      { role: "explore", prompt: "What is the current version in /tmp/demo-source/Cargo.toml workspace?" },
    ],
  },
});

console.log("Fleet spawned:", result.content[0].text);
console.log("\nWaiting 10 seconds for agents to complete...\n");
await new Promise(r => setTimeout(r, 10000));

const status = await client.callTool({
  name: "fleet_status",
  arguments: { fleet_id: JSON.parse(result.content[0].text).fleet_id },
});

console.log("Fleet status:", JSON.stringify(JSON.parse(status.content[0].text), null, 2));

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\nTotal time: ${elapsed}s (would have timed out at 30min with background tasks)`);

await client.close();
