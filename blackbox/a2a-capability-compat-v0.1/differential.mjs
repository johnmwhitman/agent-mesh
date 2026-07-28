import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonical } from "./evaluator.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result.stdout.trim();
};
const javascript = run(process.execPath, ["runner.mjs"]);
const python = run("python3", ["python/runner.py"]);
if (javascript !== python) throw new Error("JavaScript/Python corpus transcript mismatch");
const parsed = JSON.parse(javascript);
process.stdout.write(`${canonical({
  ok: true,
  profile: parsed.profile,
  mandatory_cases: parsed.mandatory_cases,
  total_cases: parsed.total_cases,
  transcript_sha256: createHash("sha256").update(javascript, "utf8").digest("hex"),
})}\n`);
