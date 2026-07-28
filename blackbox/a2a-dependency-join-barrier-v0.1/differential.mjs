import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
function run(command, args) { const p = spawnSync(command, args, { cwd: here, encoding: "buffer" }); if (p.error && p.error.code === "ENOENT") throw new Error("PYTHON_UNAVAILABLE"); if (p.status !== 0) throw new Error(`${command}_RUNNER_FAILED: ${p.stderr}`); return p.stdout; }
const jsCorpus = run(process.execPath, ["runner.mjs"]), pyCorpus = run("python3", ["python/runner.py"]), jsSelf = run(process.execPath, ["runner.mjs", "--self-test"]), pySelf = run("python3", ["python/runner.py", "--self-test"]);
if (!jsCorpus.equals(pyCorpus)) throw new Error("JS_PYTHON_CORPUS_MISMATCH");
if (!jsSelf.equals(pySelf)) throw new Error("JS_PYTHON_SELF_TEST_MISMATCH");
const transcript = Buffer.concat([jsCorpus, jsSelf]);
process.stdout.write(JSON.stringify({ corpus_sha256: createHash("sha256").update(jsCorpus).digest("hex"), profile: "meshfleet.a2a.dependency-join-barrier.v0.1", self_test_sha256: createHash("sha256").update(jsSelf).digest("hex"), sha256: createHash("sha256").update(transcript).digest("hex"), witness: "corpus_and_self_test_byte_identical" }) + "\n");
