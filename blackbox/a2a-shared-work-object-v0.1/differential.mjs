import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonical } from "./evaluator.mjs";
import { runCorpus } from "./runner.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const js = runCorpus();
const python = spawnSync("python3", ["python/runner.py"], {
  cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
});
if (python.status !== 0) throw new Error(`Python corpus runner failed: ${python.stderr}`);
const py = JSON.parse(python.stdout);
if (canonical(js) !== canonical(py)) throw new Error("JavaScript/Python corpus transcript mismatch");
process.stdout.write(`${canonical({
  ok: true,
  profile: js.profile,
  total_cases: js.total_cases,
  mandatory_cases: js.mandatory_cases,
  transcript_sha256: (await import("node:crypto")).createHash("sha256").update(canonical(js)).digest("hex"),
})}\n`);
