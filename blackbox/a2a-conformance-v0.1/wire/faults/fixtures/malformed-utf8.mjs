process.stdin.once("data", () => process.stdout.write(Buffer.from([0xff, 0x0a])));
process.stdin.resume();
