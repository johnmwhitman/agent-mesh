const MAX_BYTES = 131072, MAX_DEPTH = 64, MAX_MEMBERS = 128, MAX_LABEL = 256;
export const PROFILE = "meshfleet.a2a.dependency-join-barrier.v0.1";
export class BarrierError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new BarrierError(code); };
export function compareUnicode(a, b) {
  const aa = Array.from(a), bb = Array.from(b), n = Math.min(aa.length, bb.length);
  for (let i = 0; i < n; i += 1) { const x = aa[i].codePointAt(0), y = bb[i].codePointAt(0); if (x !== y) return x < y ? -1 : 1; }
  return aa.length - bb.length;
}
function scalar(s) { for (let i = 0; i < s.length; i += 1) { const c = s.charCodeAt(i); if (c >= 0xd800 && c <= 0xdbff) { const low = s.charCodeAt(i + 1); if (low < 0xdc00 || low > 0xdfff) fail("INVALID_UNICODE"); i += 1; } else if (c >= 0xdc00 && c <= 0xdfff) fail("INVALID_UNICODE"); } return s; }
class Parser {
  constructor(s) { this.s = s; this.i = 0; }
  ws() { while (this.i < this.s.length && /[ \t\r\n]/.test(this.s[this.i])) this.i += 1; }
  value(depth = 0) {
    this.ws(); if (this.i >= this.s.length) fail("MALFORMED_JSON"); const c = this.s[this.i];
    if (c === '"') return this.string(); if (c === "{") return this.object(depth); if (c === "[") return this.array(depth);
    if (this.s.startsWith("true", this.i)) { this.i += 4; return true; } if (this.s.startsWith("false", this.i)) { this.i += 5; return false; }
    if (this.s.startsWith("null", this.i)) { this.i += 4; return null; } if (c === "-" || /[0-9]/.test(c)) return this.number(); fail("MALFORMED_JSON");
  }
  string() {
    this.i += 1; let out = "";
    while (this.i < this.s.length) { const c = this.s[this.i++]; if (c === '"') return scalar(out); if (c < " ") fail("MALFORMED_JSON");
      if (c !== "\\") { out += c; continue; } if (this.i >= this.s.length) fail("MALFORMED_JSON"); const e = this.s[this.i++];
      if ('"\\/'.includes(e)) { out += e; continue; } if (e === "b") { out += "\b"; continue; } if (e === "f") { out += "\f"; continue; } if (e === "n") { out += "\n"; continue; } if (e === "r") { out += "\r"; continue; } if (e === "t") { out += "\t"; continue; }
      if (e !== "u") fail("MALFORMED_JSON"); const h = this.s.slice(this.i, this.i + 4); if (!/^[0-9a-fA-F]{4}$/.test(h)) fail("MALFORMED_JSON"); this.i += 4; let cp = parseInt(h, 16);
      if (cp >= 0xdc00 && cp <= 0xdfff) fail("INVALID_UNICODE"); if (cp >= 0xd800 && cp <= 0xdbff) { if (this.s.slice(this.i, this.i + 2) !== "\\u") fail("INVALID_UNICODE"); const l = this.s.slice(this.i + 2, this.i + 6); if (!/^[0-9a-fA-F]{4}$/.test(l)) fail("MALFORMED_JSON"); const low = parseInt(l, 16); if (low < 0xdc00 || low > 0xdfff) fail("INVALID_UNICODE"); this.i += 6; cp = 0x10000 + (cp - 0xd800) * 0x400 + low - 0xdc00; }
      out += String.fromCodePoint(cp);
    } fail("MALFORMED_JSON");
  }
  number() { const m = this.s.slice(this.i).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/); if (!m) fail("MALFORMED_JSON"); const t = m[0]; this.i += t.length; if (/[.eE]/.test(t) || t === "-0") fail("NON_CANONICAL_INTEGER"); const n = Number(t); if (!Number.isSafeInteger(n)) fail("UNSAFE_INTEGER"); return n; }
  object(depth) { if (depth >= MAX_DEPTH) fail("DEPTH_LIMIT"); this.i += 1; this.ws(); const o = Object.create(null), seen = new Set(); if (this.s[this.i] === "}") { this.i += 1; return o; }
    while (true) { this.ws(); if (this.s[this.i] !== '"') fail("MALFORMED_JSON"); const k = this.string(); if (seen.has(k)) fail("DUPLICATE_MEMBER"); seen.add(k); this.ws(); if (this.s[this.i++] !== ":") fail("MALFORMED_JSON"); o[k] = this.value(depth + 1); this.ws(); const c = this.s[this.i++]; if (c === "}") return o; if (c !== ",") fail("MALFORMED_JSON"); }
  }
  array(depth) { if (depth >= MAX_DEPTH) fail("DEPTH_LIMIT"); this.i += 1; this.ws(); const a = []; if (this.s[this.i] === "]") { this.i += 1; return a; } while (true) { a.push(this.value(depth + 1)); this.ws(); const c = this.s[this.i++]; if (c === "]") return a; if (c !== ",") fail("MALFORMED_JSON"); }
  }
}
export function parseStrict(bytes) { if (bytes.length > MAX_BYTES) fail("SIZE_LIMIT"); let s; try { s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail("INVALID_UTF8"); } if (s.startsWith("\ufeff")) fail("MALFORMED_JSON"); const p = new Parser(s); const v = p.value(); p.ws(); if (p.i !== s.length) fail("MALFORMED_JSON"); return v; }
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function keysExact(v, allowed) { for (const k of Object.keys(v)) if (!allowed.includes(k)) fail("UNKNOWN_FIELD"); }
function label(v) { if (typeof v !== "string" || !v.length) fail("INVALID_FIELD"); if (Buffer.byteLength(v, "utf8") > MAX_LABEL) fail("LIMIT_EXCEEDED"); return v; }
function requireField(v, k) { if (!Object.hasOwn(v, k)) fail("MISSING_FIELD"); return v[k]; }
export function evaluateScenario(s) {
  if (!isObject(s)) fail("INVALID_FIELD"); const profile = requireField(s, "profile"); if (typeof profile !== "string") fail("INVALID_FIELD"); if (profile !== PROFILE) fail("PROFILE_REJECT"); requireField(s, "members"); requireField(s, "child_states"); requireField(s, "mode"); keysExact(s, ["profile", "members", "child_states", "mode", "k"]);
  const members = s.members, childStates = s.child_states, mode = s.mode; if (!Array.isArray(members) || !Array.isArray(childStates)) fail("INVALID_FIELD"); if (!members.length) fail("INVALID_FIELD"); if (members.length > MAX_MEMBERS || childStates.length > MAX_MEMBERS) fail("LIMIT_EXCEEDED");
  const memberSet = new Set(); for (const m of members) { label(m); if (memberSet.has(m)) fail("DUPLICATE_MEMBER"); memberSet.add(m); }
  const states = new Map(); for (const entry of childStates) { if (!isObject(entry)) fail("INVALID_FIELD"); keysExact(entry, ["member", "state"]); const m = label(requireField(entry, "member")), state = requireField(entry, "state"); if (typeof state !== "string" || !["open", "success", "failure", "cancelled"].includes(state)) fail("INVALID_FIELD"); if (states.has(m)) fail("DUPLICATE_MEMBER"); states.set(m, state); }
  for (const m of states.keys()) if (!memberSet.has(m)) fail("UNKNOWN_MEMBER"); for (const m of memberSet) if (!states.has(m)) fail("MISSING_MEMBER");
  if (typeof mode !== "string" || !["all_success", "any_success", "k_of_n_success", "all_terminal"].includes(mode)) fail("INVALID_FIELD"); let k = null;
  if (mode === "k_of_n_success") { k = requireField(s, "k"); if (!Number.isSafeInteger(k) || k < 1 || k > members.length) fail("K_OUT_OF_RANGE"); } else if (Object.hasOwn(s, "k")) fail("K_FORBIDDEN");
  const ordered = [...memberSet].sort(compareUnicode), counts = { cancelled: 0, failure: 0, open: 0, success: 0 }, evidence = [];
  for (const m of ordered) { const state = states.get(m); counts[state] += 1; evidence.push({ code: `${state.toUpperCase()}_MEMBER`, member: m }); }
  evidence.sort((a, b) => compareUnicode(a.code, b.code) || compareUnicode(a.member, b.member)); let outcome;
  if (mode === "all_success") outcome = counts.success === ordered.length ? "satisfied" : counts.failure || counts.cancelled ? "unsatisfiable" : "waiting";
  else if (mode === "any_success") outcome = counts.success ? "satisfied" : counts.open ? "waiting" : "unsatisfiable";
  else if (mode === "k_of_n_success") outcome = counts.success >= k ? "satisfied" : counts.success + counts.open < k ? "unsatisfiable" : "waiting";
  else outcome = counts.open === 0 ? "satisfied" : "waiting";
  return { admitted: outcome === "satisfied", counts, evidence, members: ordered, mode, outcome, required_successes: k };
}
export function evaluateBytes(bytes) { return evaluateScenario(parseStrict(bytes)); }
export function canonicalJson(v) { if (v === null) return "null"; if (typeof v === "boolean") return v ? "true" : "false"; if (typeof v === "number") { if (!Number.isSafeInteger(v) || Object.is(v, -0)) fail("NON_CANONICAL_INTEGER"); return String(v); } if (typeof v === "string") return JSON.stringify(scalar(v)); if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`; if (isObject(v)) return `{${Object.keys(v).sort(compareUnicode).map(k => `${canonicalJson(k)}:${canonicalJson(v[k])}`).join(",")}}`; fail("INVALID_FIELD"); }
