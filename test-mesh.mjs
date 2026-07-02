import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
});

const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
console.log("Tools:", tools.tools.map(t => t.name));

const result = await client.callTool({
  name: "spawn_fleet",
  arguments: {
    agents: [
      { role: "test", prompt: "echo 'hello from mesh agent 1'" },
      { role: "test", prompt: "echo 'hello from mesh agent 2'" },
    ],
  },
});
console.log("Spawn result:", result.content[0].text);

await client.close();
console.log("Mesh test passed");
