process.stdin.once("data", () => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: "wrong-id", result: {} })}\n`));
process.stdin.resume();
