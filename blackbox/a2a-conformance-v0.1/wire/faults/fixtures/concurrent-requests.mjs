// Responds to the initialize request, then immediately sends two notification-like
// frames before the client can send its next request — simulating a misbehaving server
// that pushes unsolicited data. Tests that the wire runner handles unexpected traffic.
let input = "";
process.stdin.on("data", (chunk) => {
  input += Buffer.from(chunk).toString("utf8");
  const boundary = input.indexOf("\n");
  if (boundary === -1) return;
  const request = JSON.parse(input.slice(0, boundary));
  const response = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "concurrent", version: "0.1" } } });
  const unsolicited1 = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "surprise1" } });
  const unsolicited2 = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "surprise2" } });
  process.stdout.write(response + "\n" + unsolicited1 + "\n" + unsolicited2 + "\n");
  process.stdin.pause();
});
