import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, digest, parseStrictJson } from "./evaluator.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: path.resolve(root, "../.."), encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status})\n${result.stderr}`);
  }
  return result.stdout.trim();
}

try {
  const js = run(process.execPath, [path.join(root, "runner.mjs")]);
  const py = run("python3", [path.join(root, "python/runner.py")]);
  const jsCanonical = canonical(parseStrictJson(js));
  const pyCanonical = canonical(parseStrictJson(py));
  if (jsCanonical !== pyCanonical) throw new Error("JavaScript/Python transcript mismatch");
  const parsed = parseStrictJson(jsCanonical);
  process.stdout.write(`${canonical({
    ok: true,
    profile: parsed.profile,
    cases: parsed.total_cases,
    mandatory_cases: parsed.mandatory_cases,
    transcript_sha256: digest(parsed),
  })}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}
