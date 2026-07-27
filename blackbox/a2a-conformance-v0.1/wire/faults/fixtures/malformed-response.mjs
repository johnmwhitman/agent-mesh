process.stdin.once("data", () => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: "fault-probe", method: "not-a-response", result: {} })}\n`));
process.stdin.resume();
