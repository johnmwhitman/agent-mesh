import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { evaluateBytes, PROFILE } from "./evaluator.mjs";

const root = dirname(fileURLToPath(import.meta.url));
let state = 0x4d1ce11f;
function next() { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; }
function digest(seed) { let value = seed >>> 0; let output = ""; for (let index = 0; index < 64; index += 1) { value = (Math.imul(value ^ (value >>> 13), 1103515245) + 12345) >>> 0; output += "0123456789abcdef"[value & 15]; } return output; }
function encode(value) { if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value); if (typeof value === "string") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encode(value[key])}`).join(",")}}`; }
function expected(declarations) {
  const keys = new Map();
  for (const item of declarations) {
    let digests = keys.get(item.effect_key);
    if (!digests) {
      digests = new Map();
      keys.set(item.effect_key, digests);
    }
    digests.set(item.effect_digest, (digests.get(item.effect_digest) ?? 0) + 1);
  }
  return {
    profile: PROFILE,
    outcome: "classified",
    groups: [...keys.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, digests]) => ({
      effect_key: key,
      classification: digests.size === 1 ? "single_digest" : "digest_conflict",
      digests: [...digests.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([value, count]) => ({ effect_digest: value, declaration_count: count })),
    })),
  };
}
function python(raw) { const result = spawnSync("python3", ["python/runner.py", "--raw-base64url", Buffer.from(raw).toString("base64url")], { cwd: root, encoding: "utf8" }); if (result.status !== 0) throw new Error(result.stderr || result.stdout); return JSON.parse(result.stdout); }
function assertOutput(raw, wanted, label) { const javascript = evaluateBytes(raw); const other = python(raw); if (encode(javascript) !== encode(wanted) || encode(other) !== encode(wanted) || encode(javascript) !== encode(other)) throw new Error(label); }
function shuffled(values) { const output = [...values]; for (let index = output.length - 1; index > 0; index -= 1) { const target = next() % (index + 1); [output[index], output[target]] = [output[target], output[index]]; } return output; }
const keyPool = ["constructor", "toString", "hasOwnProperty", "K0", "K1", "K2", "K3", "K4"];
for (let scenario = 0; scenario < 400; scenario += 1) { const declarations = []; const size = next() % 65; const keyCount = Math.max(1, Math.min(keyPool.length, (next() % keyPool.length) + 1)); for (let index = 0; index < size; index += 1) { const key = keyPool[next() % keyCount]; const value = digest((next() % 3 === 0 ? next() : key.length * 17) ^ scenario); declarations.push({ effect_key: key, effect_digest: value }); } const wanted = expected(declarations); assertOutput(Buffer.from(JSON.stringify({ profile: PROFILE, declarations })), wanted, `generated-${scenario}`); assertOutput(Buffer.from(JSON.stringify({ profile: PROFILE, declarations: shuffled(declarations) })), wanted, `permuted-${scenario}`); }
const invalid = [
  [JSON.stringify({ profile: PROFILE, declarations: Array.from({ length: 65 }, () => ({ effect_key: "K", effect_digest: "a".repeat(64) })) }), "DECLARATION_COUNT_LIMIT"],
  [JSON.stringify({ profile: PROFILE, declarations: [{ effect_key: "1bad", effect_digest: "a".repeat(64) }] }), "INVALID_EFFECT_KEY"],
  [JSON.stringify({ profile: PROFILE, declarations: [{ effect_key: "K", effect_digest: "A".repeat(64) }] }), "INVALID_EFFECT_DIGEST"],
  ["{\"profile\":1.0,\"profile\":\"x\",\"declarations\":[]}", "NON_CANONICAL_INTEGER"],
  ["{\"profile\":\"x\",\"profile\":\"\\ud800\",\"declarations\":[]}", "DUPLICATE_JSON_KEY"],
];
for (const [raw, errorCode] of invalid) assertOutput(Buffer.from(raw), { profile: PROFILE, outcome: "rejected", error_code: errorCode }, `invalid-${errorCode}`);
for (const [raw, errorCode] of [[Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "BOM_NOT_ALLOWED"], [Buffer.from([0xc3, 0x28]), "INVALID_UTF8"], [Buffer.from("[".repeat(2048) + "0" + "]".repeat(2048)), "JSON_DEPTH_LIMIT"]]) assertOutput(raw, { profile: PROFILE, outcome: "rejected", error_code: errorCode }, `parser-${errorCode}`);
const evaluatorText = readFileSync(join(root, "evaluator.mjs"), "utf8");
if (/node:(fs|net|http|https|child_process)|\bfetch\s*\(|\bprocess\./.test(evaluatorText)) throw new Error("static-no-io");
process.stdout.write(JSON.stringify({ suite: "fuzz-differential", generated_multisets: 400, permutations: 400, invalid_mutations: invalid.length, parser_controls: 3, passed: true }));
