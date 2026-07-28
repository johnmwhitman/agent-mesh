let input = "";
process.stdin.on("data", (chunk) => {
  input += Buffer.from(chunk).toString("utf8");
  const boundary = input.indexOf("\n");
  if (boundary === -1) return;
  JSON.parse(input.slice(0, boundary));
  process.stdin.pause();
  setTimeout(() => process.exit(0), 25);
});
