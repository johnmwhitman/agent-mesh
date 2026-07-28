import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BarrierError, canonicalJson, evaluateBytes } from "./evaluator.mjs";
const here = dirname(fileURLToPath(import.meta.url)); let seed = 0x4a4f494e;
const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
const pick = (a) => a[next() % a.length];
function shuffle(values) { const out = [...values]; for (let i = out.length - 1; i > 0; i -= 1) { const j = next() % (i + 1); [out[i], out[j]] = [out[j], out[i]]; } return out; }
function python(raw) { const p = spawnSync("python3", ["python/runner.py", "--stdin", "--receipt"], { cwd: here, input: raw, encoding: "buffer" }); if (p.error && p.error.code === "ENOENT") throw new Error("PYTHON_UNAVAILABLE"); if (p.status !== 0) throw new Error(`PYTHON_RUNNER_FAILED: ${p.stderr}`); return p.stdout.toString(); }
function jsReceipt(raw) { try { return canonicalJson({ output: evaluateBytes(raw) }); } catch (error) { if (error instanceof BarrierError) return canonicalJson({ error: error.code }); throw error; } }
const hashes = [];
function check(id, raw, expectedError = null) { const js = jsReceipt(raw), py = python(raw); if (js !== py) throw new Error(`JS_PYTHON_MISMATCH_${id}`); if (expectedError && js !== canonicalJson({ error: expectedError })) throw new Error(`UNEXPECTED_ERROR_${id}`); hashes.push(`${id}:${js}`); return js; }
const profile = "meshfleet.a2a.dependency-join-barrier.v0.1";
for (let i = 0; i < 128; i += 1) { const n = 1 + next() % 6, members = Array.from({ length: n }, (_, j) => `member-${j}`), states = members.map(member => ({ member, state: pick(["open", "success", "failure", "cancelled"]) })), mode = pick(["all_success", "any_success", "k_of_n_success", "all_terminal"]), scenario = { profile, members: shuffle(members), child_states: shuffle(states), mode }; if (mode === "k_of_n_success") scenario.k = 1 + next() % n; const raw = Buffer.from(JSON.stringify(scenario)), permuted = Buffer.from(JSON.stringify({ ...scenario, members: [...scenario.members].reverse(), child_states: [...scenario.child_states].reverse() })), original = check(`valid-${i}`, raw), reversed = check(`permuted-${i}`, permuted); if (original !== reversed) throw new Error(`PERMUTATION_MISMATCH_${i}`); }
const unicode = { profile, members: ["\u{10000}", "\ue000", "\u{1f600}"], child_states: [{ member: "\ue000", state: "open" }, { member: "\u{1f600}", state: "success" }, { member: "\u{10000}", state: "failure" }], mode: "all_terminal" };
check("unicode-scalar", Buffer.from(JSON.stringify(unicode)));
for (const [id, raw, error] of [["invalid-utf8", Buffer.from([0xff]), "INVALID_UTF8"], ["bom", Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "MALFORMED_JSON"], ["malformed", Buffer.from('{"a":'), "MALFORMED_JSON"], ["duplicate-key", Buffer.from('{"a":1,"a":2}'), "DUPLICATE_MEMBER"], ["float", Buffer.from('{"a":1.5}'), "NON_CANONICAL_INTEGER"], ["negative-zero", Buffer.from('{"a":-0}'), "NON_CANONICAL_INTEGER"], ["unsafe", Buffer.from('{"a":9007199254740992}'), "UNSAFE_INTEGER"], ["unpaired", Buffer.from('{"a":"\\ud800"}'), "INVALID_UNICODE"], ["depth", Buffer.from(`${"[".repeat(65)}0${"]".repeat(65)}`), "DEPTH_LIMIT"]]) check(id, raw, error);
check("unknown-before-domain", Buffer.from(JSON.stringify({ profile, members: ["a", "a"], child_states: [], mode: "bad", extra: true })), "UNKNOWN_FIELD");
check("missing-before-mode", Buffer.from(JSON.stringify({ profile, members: ["a"], child_states: [], mode: "bad" })), "MISSING_MEMBER");
const boundary = (count, label = "a") => ({ profile, members: Array.from({ length: count }, (_, i) => `${label}${i}`), child_states: Array.from({ length: count }, (_, i) => ({ member: `${label}${i}`, state: "success" })), mode: "all_success" });
check("members-128", Buffer.from(JSON.stringify(boundary(128)))); check("members-129", Buffer.from(JSON.stringify(boundary(129))), "LIMIT_EXCEEDED");
const label256 = "x".repeat(256), label257 = "x".repeat(257); check("label-256", Buffer.from(JSON.stringify({ profile, members: [label256], child_states: [{ member: label256, state: "success" }], mode: "all_success" }))); check("label-257", Buffer.from(JSON.stringify({ profile, members: [label257], child_states: [{ member: label257, state: "success" }], mode: "all_success" })), "LIMIT_EXCEEDED");
const sized = (n) => Buffer.from(`{"a":"${"x".repeat(n - 8)}"}`); check("size-131072", sized(131072), "MISSING_FIELD"); check("size-131073", sized(131073), "SIZE_LIMIT");
process.stdout.write(JSON.stringify({ generated: 128, profile, seed: "0x4a4f494e", sha256: createHash("sha256").update(hashes.join("\n")).digest("hex"), transcript_cases: hashes.length, witness: "js_python_parser_validation_unicode_and_permutation_byte_identical" }) + "\n");
