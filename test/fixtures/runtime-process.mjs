const [mode = "success", prompt = ""] = process.argv.slice(2);

if (mode === "timeout") {
  setInterval(() => {}, 1_000);
} else if (mode === "term-exit") {
  process.stdout.write("before-term");
  process.on("SIGTERM", () => {
    process.stdout.write("term-exit");
    process.exit(0);
  });
  setInterval(() => {}, 1_000);
} else if (mode === "term-ignore") {
  process.stdout.write("before-term");
  process.on("SIGTERM", () => {
    process.stdout.write("ignored-term");
  });
  setInterval(() => {}, 1_000);
} else if (mode === "signal") {
  process.kill(process.pid, "SIGTERM");
} else if (mode === "failure") {
  process.stdout.write(`partial:${prompt}`);
  process.stderr.write("fixture failure");
  process.exitCode = 7;
} else if (mode === "empty") {
  process.exitCode = 0;
} else if (mode === "opencode") {
  process.stdout.write(`answer:${prompt}`);
  process.stderr.write("> oracle · anthropic/claude-sonnet-4\n");
} else {
  process.stdout.write(JSON.stringify({
    prompt,
    cwd: process.cwd(),
    allowed: process.env.MESH_ALLOWED ?? null,
    inheritedSecret: process.env.MESH_SECRET ?? null,
  }));
}
