process.stdin.once("data", () => process.stdout.write(Buffer.concat([Buffer.alloc(256 * 1024 + 1, 0x78), Buffer.from("\n")])))
process.stdin.resume();
