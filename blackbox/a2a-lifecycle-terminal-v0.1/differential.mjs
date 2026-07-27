#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonical, parseStrictJson, sha256 } from "./evaluator.mjs";

const root = dirname(fileURLToPath(import.meta.url));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: null });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr.toString("utf8")}`);
  }
  return result.stdout;
}

const javascript = run(process.execPath, [join(root, "runner.mjs"), "--emit-cases"]);
const python = run(process.env.PYTHON ?? "python3", [join(root, "python/runner.py"), "--emit-cases"]);
const equal = javascript.equals(python);

function verifyReceipts(bytes) {
  const receipts = parseStrictJson(bytes.toString("utf8").trim());
  if (!Array.isArray(receipts) || receipts.length === 0) throw new Error("empty transcript");
  for (const receipt of receipts) {
    const { receipt_sha256: digest, ...body } = receipt;
    if (typeof digest !== "string" || sha256(body) !== digest) return { valid: false, count: receipts.length, receipts };
  }
  return { valid: true, count: receipts.length, receipts };
}

const verified = verifyReceipts(javascript);
const pythonVerified = verifyReceipts(python);
const mutated = JSON.parse(JSON.stringify(verified.receipts));
mutated[0].top_code = "__MUTATED__";
const controlDetected = !verifyReceipts(Buffer.from(canonical(mutated), "utf8")).valid;

const receipt = {
  profile: "meshfleet.a2a.lifecycle-terminal.v0.1",
  witness: "javascript-python-byte-differential",
  equal,
  control_detected: controlDetected,
  receipts_verified: verified.valid && pythonVerified.valid ? verified.count : 0,
  byte_count: javascript.length,
  transcript_sha256: sha256(javascript.toString("utf8"))
};
process.stdout.write(`${canonical(receipt)}\n`);
if (!equal || !controlDetected || !verified.valid || !pythonVerified.valid) process.exitCode = 1;
