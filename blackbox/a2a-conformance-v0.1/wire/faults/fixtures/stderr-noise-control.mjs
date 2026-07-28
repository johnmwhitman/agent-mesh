let input = "";
process.stderr.write("fault-control stderr noise\n");
process.stdin.on("data", (chunk) => {
  input += Buffer.from(chunk).toString("utf8");
  const boundary = input.indexOf("\n");
  if (boundary === -1) return;
  const request = JSON.parse(input.slice(0, boundary));
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "fault-control", version: "0.1" } } })}\n`);
  process.stdin.pause();
});
