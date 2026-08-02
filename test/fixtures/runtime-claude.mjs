import { readFileSync } from "node:fs";

const mode = process.env.MESH_CLAUDE_FAKE_MODE ?? "success";
const stdin = readFileSync(0, "utf8");

if (mode === "empty") process.exit(0);
if (mode === "failure") {
  process.stderr.write("private authentication detail\n");
  process.exit(7);
}
if (mode === "oversize") {
  process.stdout.write("x".repeat(4096));
  process.exit(0);
}

process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  stdin,
  promptInEnvironment: Object.values(process.env).includes(stdin),
  environmentKeys: Object.keys(process.env).sort(),
}));
