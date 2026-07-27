process.stdin.once("data", () => {
  process.stdout.write('{"jsonrpc":"2.0"');
  process.exit(0);
});
process.stdin.resume();
