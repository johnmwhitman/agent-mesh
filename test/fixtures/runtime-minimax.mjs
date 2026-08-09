const mode = process.env.MESH_MINIMAX_FAKE_MODE ?? "success";

if (mode === "empty") process.exit(0);
if (mode === "failure") {
  process.stderr.write("private provider detail must not cross the adapter boundary\n");
  process.exit(7);
}
if (mode === "hang") {
  setInterval(() => {}, 1_000);
} else {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { stdin += chunk; });
  await new Promise((resolve) => process.stdin.on("end", resolve));
  const observed = JSON.stringify({
    argv: process.argv.slice(2),
    stdin,
    promptInEnvironment: Object.values(process.env).includes(stdin),
    routeplane: process.env.ROUTEPLANE,
    noMemory: process.env.NO_MEMORY,
    hasHome: typeof process.env.HOME === "string" && process.env.HOME.length > 0,
    hasUser: typeof process.env.USER === "string" && process.env.USER.length > 0,
    hasPath: typeof process.env.PATH === "string" && process.env.PATH.length > 0,
    leakedSecret: process.env.UNRELATED_PRIVATE_TOKEN !== undefined,
  });
  if (mode === "plain") process.stdout.write("unstructured response");
  else if (mode === "blocked") process.stdout.write(JSON.stringify({
    schema: "mf.agent.text-result/v1",
    outcome: "blocked",
    summary: "fixture could not continue",
    reason: "fixture input was incomplete",
  }));
  else process.stdout.write(JSON.stringify({
    schema: "mf.agent.text-result/v1",
    outcome: "done",
    summary: "fixture completed",
    output: observed,
  }));
}
