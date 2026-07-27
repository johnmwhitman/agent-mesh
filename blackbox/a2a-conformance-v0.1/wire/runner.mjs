import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

const WIRE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIRECTORY = dirname(WIRE_DIRECTORY);
const REPOSITORY_DIRECTORY = resolve(WIRE_DIRECTORY, "../../..");
const MANIFEST_PATH = join(HARNESS_DIRECTORY, "manifest.json");
const TRANSCRIPT_PATH = join(WIRE_DIRECTORY, "fixtures", "transcript-v0.1.json");
const MUTATIONS_PATH = join(WIRE_DIRECTORY, "fixtures", "mutations-v0.1.json");
const FAULT_FIXTURES_DIRECTORY = join(WIRE_DIRECTORY, "faults", "fixtures");
const OUTPUT_CAP_BYTES = 1024 * 1024;
const STDERR_CAP_BYTES = 64 * 1024;
const LINE_CAP_BYTES = 256 * 1024;
const STARTUP_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 2_000;
const PROTOCOL_VERSION = "2025-11-25";
const REQUIRED_OPERATIONS = ["initialize", "notifications/initialized", "ping", "tools/list", "tools/call:get_health", "tools/call:unknown"];
const DIGEST_DOMAIN = {
  object_keys: "ASCII keys sorted by code unit",
  top_level_tools: "unique ASCII names sorted by code unit",
  arrays: "preserved in source order",
  numbers: "finite safe integers only, excluding negative zero, base-10",
  strings: "no lone surrogates; quote, backslash, and U+0000-U+001F explicitly escaped; other Unicode preserved as UTF-8"
};
const PREAMBLE = "Meshfleet raw stdio wire conformance v0.1";
const NONCLAIMS = [
  "This is a raw stdio transport witness, not full MCP or A2A conformance.",
  "It invokes only protocol initialize, initialized, ping, tools/list, get_health, and an unknown-tool canary.",
  "It imports no MCP SDK and invokes no provider-capable tool.",
  "Temporary child environment isolation is process-local and does not claim OS-level network blocking.",
  "On Windows, normal-witness descendants cannot be proven absent after a spontaneous root exit; fault-mode fixtures remain supervised by the enclosing meta-runner tree.",
  "The catalog digest is a pinned domain-specific byte contract for the fixture-declared ASCII-key, unique-tool-name, integer, and Unicode-string domain, not general JSON canonicalization."
];
const FaultClass = Object.freeze({
  ASSERTION_FAILED: "ASSERTION_FAILED",
  CHILD_EXIT: "CHILD_EXIT",
  CLEANUP_FAILED: "CLEANUP_FAILED",
  DUPLICATE_SETTLED_ID: "DUPLICATE_SETTLED_ID",
  INVALID_JSON: "INVALID_JSON",
  INVALID_NOTIFICATION: "INVALID_NOTIFICATION",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  INVALID_UTF8: "INVALID_UTF8",
  OUTPUT_CAP: "OUTPUT_CAP",
  OVERSIZED_LINE: "OVERSIZED_LINE",
  REQUEST_TIMEOUT: "REQUEST_TIMEOUT",
  STDIN_WRITE: "STDIN_WRITE",
  TRAILING_FRAME: "TRAILING_FRAME",
  WRONG_RESPONSE_ID: "WRONG_RESPONSE_ID"
});
const FAULT_CLASS_VALUES = new Set(Object.values(FaultClass));

function faultError(faultClass, message) {
  if (!FAULT_CLASS_VALUES.has(faultClass)) throw new Error(`unknown fault class ${String(faultClass)}`);
  const error = new Error(message);
  error.faultClass = faultClass;
  return error;
}

function faultClassOf(error) {
  return FAULT_CLASS_VALUES.has(error?.faultClass) ? error.faultClass : FaultClass.ASSERTION_FAILED;
}

function detail(error) {
  return error instanceof Error ? error.message : String(error);
}

function bounded(value, cap = 512) {
  return String(value ?? "").slice(0, cap);
}

function check(checks, id, status, detailValue) {
  checks.push({ id, status, detail: detailValue });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isAscii(value) {
  return typeof value === "string" && /^[\x00-\x7f]*$/.test(value);
}

function isInside(parent, candidate) {
  const value = relative(parent, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function assertNoLoneSurrogates(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) throw new Error("catalog string contains a lone high surrogate");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("catalog string contains a lone low surrogate");
    }
  }
}

function serializeString(value) {
  assertNoLoneSurrogates(value);
  let output = String.fromCharCode(0x22);
  for (const codePoint of value) {
    const code = codePoint.charCodeAt(0);
    if (code === 0x22) output += String.fromCharCode(0x5c, 0x22);
    else if (code === 0x5c) output += String.fromCharCode(0x5c, 0x5c);
    else if (code <= 0x1f) output += String.fromCharCode(0x5c, 0x75) + code.toString(16).padStart(4, "0");
    else output += codePoint;
  }
  return output + String.fromCharCode(0x22);
}

function canonicalBytes(value, path = "catalog") {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return serializeString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error(`${path} number is outside the digest domain`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item, index) => canonicalBytes(item, `${path}[${index}]`)).join(",")}]`;
  if (!value || typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error(`${path} scalar is outside the digest domain`);
  const keys = Object.keys(value);
  for (const key of keys) if (!isAscii(key)) throw new Error(`${path} has a non-ASCII object key`);
  return `{${keys.sort().map((key) => `${serializeString(key)}:${canonicalBytes(value[key], `${path}.${key}`)}`).join(",")}}`;
}

function sortedTools(tools) {
  if (!Array.isArray(tools)) throw new Error("catalog tools must be an array");
  const names = new Set();
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || !isAscii(tool.name) || tool.name.length === 0) throw new Error("catalog tools must have non-empty ASCII names");
    if (names.has(tool.name)) throw new Error(`catalog has duplicate tool name ${tool.name}`);
    names.add(tool.name);
    canonicalBytes(tool, `tool:${tool.name}`);
  }
  return [...tools].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

function catalogDigest(tools) {
  return createHash("sha256").update(canonicalBytes({ tools: sortedTools(tools) }), "utf8").digest("hex");
}

function directArrayCatalogDigest(tools) {
  return createHash("sha256").update(canonicalBytes(sortedTools(tools)), "utf8").digest("hex");
}

class StrictFrameParser {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
    this.buffer = "";
    this.finished = false;
  }

  push(bytes) {
    if (this.finished) throw new Error("stdout parser received bytes after finish");
    try {
      this.consume(this.decoder.decode(bytes, { stream: true }));
    } catch (error) {
      if (error instanceof TypeError) throw faultError(FaultClass.INVALID_UTF8, "stdout emitted malformed UTF-8");
      throw error;
    }
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    try {
      this.consume(this.decoder.decode());
    } catch (error) {
      if (error instanceof TypeError) throw faultError(FaultClass.INVALID_UTF8, "stdout emitted malformed UTF-8");
      throw error;
    }
    if (this.buffer.length > 0) throw faultError(FaultClass.TRAILING_FRAME, "stdout ended with trailing non-newline protocol bytes");
  }

  consume(text) {
    this.buffer += text;
    for (;;) {
      const boundary = this.buffer.indexOf("\n");
      if (boundary === -1) break;
      const line = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 1);
      if (line.length === 0 || line.endsWith("\r")) throw faultError(FaultClass.INVALID_JSON, "stdout emitted a blank or CRLF-delimited protocol line");
      if (Buffer.byteLength(line) > LINE_CAP_BYTES) throw faultError(FaultClass.OVERSIZED_LINE, "stdout line exceeded protocol line cap");
      let message;
      try { message = JSON.parse(line); } catch { throw faultError(FaultClass.INVALID_JSON, "stdout emitted invalid JSON protocol line"); }
      if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") throw faultError(FaultClass.INVALID_RESPONSE, "stdout emitted a non-object JSON-RPC 2.0 value");
      this.onMessage(message);
    }
    if (Buffer.byteLength(this.buffer) > LINE_CAP_BYTES) throw faultError(FaultClass.OVERSIZED_LINE, "stdout unfinished line exceeded protocol line cap");
  }
}

function inboundKeys(value, allowed, label, faultClass) {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (keys.some((key) => !expected.includes(key))) throw faultError(faultClass, `${label} contained a disallowed top-level key`);
}

function validateInboundMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") throw faultError(FaultClass.INVALID_RESPONSE, "stdout emitted a non-object JSON-RPC 2.0 value");
  const hasMethod = Object.hasOwn(message, "method");
  const hasId = Object.hasOwn(message, "id");
  const hasResult = Object.hasOwn(message, "result");
  const hasError = Object.hasOwn(message, "error");
  if (hasMethod) {
    if (hasId || hasResult || hasError) throw faultError(FaultClass.INVALID_RESPONSE, "stdout response must not contain method");
    inboundKeys(message, ["jsonrpc", "method", "params"], "stdout notification", FaultClass.INVALID_NOTIFICATION);
    if (typeof message.method !== "string" || message.method.length === 0) throw faultError(FaultClass.INVALID_NOTIFICATION, "stdout notification method must be a non-empty string");
    return "notification";
  }
  inboundKeys(message, ["jsonrpc", "id", "result", "error"], "stdout response", FaultClass.INVALID_RESPONSE);
  if (!hasId || message.id === null || !["string", "number"].includes(typeof message.id)) throw faultError(FaultClass.INVALID_RESPONSE, "stdout response id must be a non-null string or number");
  if (hasResult === hasError) throw faultError(FaultClass.INVALID_RESPONSE, "stdout response must contain exactly one of result or error");
  if (hasError) {
    const error = message.error;
    if (!error || typeof error !== "object" || Array.isArray(error)) throw faultError(FaultClass.INVALID_RESPONSE, "stdout response error must be a non-null object");
    inboundKeys(error, ["code", "message", "data"], "stdout response error", FaultClass.INVALID_RESPONSE);
    if (!Number.isInteger(error.code) || typeof error.message !== "string") throw faultError(FaultClass.INVALID_RESPONSE, "stdout response error requires integer code and string message");
  }
  return "response";
}

class ResponseCorrelator {
  constructor() {
    this.pending = new Map();
    this.settled = new Map();
    this.trace = [];
  }

  record(kind, id) {
    if (this.trace.length < 16) this.trace.push({ kind, id: String(id) });
  }

  key(id) {
    return `${typeof id}:${String(id)}`;
  }

  arm(id, timeoutMs = REQUEST_TIMEOUT_MS) {
    const key = this.key(id);
    if (this.pending.has(key)) throw new Error(`duplicate pending response id ${String(id)}`);
    let rejectPromise;
    const promise = new Promise((resolveResponse, rejectResponse) => {
      rejectPromise = rejectResponse;
      const timer = setTimeout(() => {
        this.pending.delete(key);
        rejectResponse(faultError(FaultClass.REQUEST_TIMEOUT, `timed out waiting for response id ${String(id)}`));
      }, timeoutMs);
      this.pending.set(key, {
        id,
        resolve: (message) => { clearTimeout(timer); resolveResponse(message); },
        reject: (error) => { clearTimeout(timer); rejectResponse(error); }
      });
    });
    promise.catch(() => undefined);
    return { promise, cancel: (error) => {
      const pending = this.pending.get(key);
      if (pending) {
        this.pending.delete(key);
        pending.reject(error ?? new Error(`response id ${String(id)} cancelled`));
      } else if (rejectPromise) {
        rejectPromise(error ?? new Error(`response id ${String(id)} cancelled`));
      }
    } };
  }

  accept(message) {
    const kind = validateInboundMessage(message);
    if (kind === "notification") throw faultError(FaultClass.INVALID_NOTIFICATION, "stdout emitted an unsolicited JSON-RPC notification");
    const key = this.key(message.id);
    if (this.settled.has(key)) {
      this.record("duplicate", message.id);
      throw faultError(FaultClass.DUPLICATE_SETTLED_ID, `duplicate settled response id ${String(message.id)}`);
    }
    const pending = this.pending.get(key);
    if (!pending || pending.id !== message.id) {
      this.record("wrong", message.id);
      throw faultError(FaultClass.WRONG_RESPONSE_ID, `unsolicited response id ${String(message.id)}`);
    }
    this.pending.delete(key);
    this.settled.set(key, pending.id);
    this.record("matched", message.id);
    pending.resolve(message);
  }

  fail(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function validateOutboundEnvelope(value, kind) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string" || value.method.length === 0) throw new Error(`${kind} envelope must be a JSON-RPC 2.0 object with a method`);
  if (Object.hasOwn(value, "result") || Object.hasOwn(value, "error")) throw new Error(`${kind} envelope must not contain result or error`);
  if (kind === "notification") {
    if (Object.hasOwn(value, "id")) throw new Error("notification envelope must not contain id");
    return value;
  }
  if (kind === "request") {
    if (!Object.hasOwn(value, "id") || value.id === null) throw new Error("request envelope must contain a non-null id");
    return value;
  }
  throw new Error(`unknown outbound envelope kind ${String(kind)}`);
}

function liveParserProblem(chunks, expectedId = null) {
  const correlator = new ResponseCorrelator();
  const armed = expectedId === null ? null : correlator.arm(expectedId, 1_000);
  const parser = new StrictFrameParser((message) => correlator.accept(message));
  try {
    for (const chunk of chunks) parser.push(chunk);
    parser.finish();
    if (expectedId !== null) armed.cancel(new Error("mutation emitted no rejection"));
    return null;
  } catch (error) {
    if (armed) armed.cancel(error);
    return detail(error);
  }
}

function setFixtureValue(target, path, value) {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) cursor = cursor[parts[index]];
  cursor[parts.at(-1)] = value;
}

function fixtureProblem(transcript) {
  if (transcript?.schema_version !== "0.1") return "unexpected transcript schema version";
  if (transcript.protocol_version !== PROTOCOL_VERSION) return "unexpected transcript protocol version";
  if (!Array.isArray(transcript.profiles) || transcript.profiles.length !== 2) return "exactly two synthetic profiles are required";
  const names = new Set();
  if (new Set(transcript.profiles.map((profile) => profile?.name)).size !== transcript.profiles.length) return "duplicate synthetic profile name";
  const combinations = [];
  for (const profile of transcript.profiles) {
    if (typeof profile?.name !== "string" || !profile.name.startsWith("synthetic-wire-profile-")) return "invalid synthetic profile name";
    if (names.has(profile.name)) return "duplicate synthetic profile name";
    names.add(profile.name);
    if (!["fragmented", "coalesced"].includes(profile.initialize_write) || !["fragmented", "coalesced"].includes(profile.post_initialize_write)) return "invalid transcript write mode";
    combinations.push(`${profile.initialize_write}:${profile.post_initialize_write}`);
  }
  if (JSON.stringify(combinations.sort()) !== JSON.stringify(["coalesced:fragmented", "fragmented:coalesced"])) return "profiles must use exactly the complementary write combinations";
  if (!Array.isArray(transcript.operations)) return "transcript operations must be an array";
  const operations = new Set();
  for (const operation of transcript.operations) {
    if (!REQUIRED_OPERATIONS.includes(operation)) return `unknown transcript operation ${String(operation)}`;
    if (operations.has(operation)) return `duplicate transcript operation ${operation}`;
    operations.add(operation);
  }
  if (operations.size !== REQUIRED_OPERATIONS.length || REQUIRED_OPERATIONS.some((operation) => !operations.has(operation))) return "transcript operations are missing a required operation";
  if (typeof transcript.unknown_tool_expected_message !== "string" || transcript.unknown_tool_expected_message.length === 0) return "transcript must pin an exact unknown-tool message";
  if (JSON.stringify(transcript.catalog_digest_domain) !== JSON.stringify(DIGEST_DOMAIN)) return "transcript catalog digest domain metadata mismatched the runner contract";
  return null;
}

function mutationProblem(transcript, mutation) {
  if (mutation.target === "parser.stdout") return liveParserProblem([Buffer.from(mutation.mutated_value, "utf8")]);
  if (mutation.target === "parser.bytes") return liveParserProblem([Buffer.from(mutation.mutated_value)]);
  if (mutation.target === "parser.line_bytes") return liveParserProblem([Buffer.from(`${"x".repeat(mutation.mutated_value)}\n`, "utf8")]);
  if (mutation.target === "parser.trailing") return liveParserProblem([Buffer.from(mutation.mutated_value, "utf8")]);
  if (mutation.target === "parser.blank_line" || mutation.target === "parser.crlf_line") return liveParserProblem([Buffer.from(mutation.mutated_value, "utf8")]);
  if (mutation.target === "correlation.response_id") return liveParserProblem([Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: mutation.mutated_value, result: {} }) + "\n", "utf8")], "expected-id");
  if (mutation.target === "correlation.duplicate_id") {
    const line = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: mutation.mutated_value, result: {} }) + "\n", "utf8");
    return liveParserProblem([line, line], mutation.mutated_value);
  }
  if (mutation.target === "correlation.orphan_id") return liveParserProblem([Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: mutation.mutated_value, result: {} }) + "\n", "utf8")]);
  if (mutation.target === "ping.result") {
    try { assertEmptyPing(mutation.mutated_value); return null; } catch (error) { return detail(error); }
  }
  if (mutation.target === "catalog.tools.order") {
    const tools = [{ name: "beta", inputSchema: { type: "object", required: ["z", "a"] } }, { name: "alpha", inputSchema: { type: "object", properties: { probe: { type: "string" } } } }];
    return catalogDigest(tools) === catalogDigest([...tools].reverse()) ? "top-level tool-order mutation preserved the digest as required" : null;
  }
  if (mutation.target === "catalog.tools[0].inputSchema.properties.probe.type") {
    const tools = [{ name: "alpha", inputSchema: { type: "object", properties: { probe: { type: "string" } } } }];
    const changed = clone(tools);
    changed[0].inputSchema.properties.probe.type = mutation.mutated_value;
    return catalogDigest(tools) !== catalogDigest(changed) ? "tool schema mutation changed the digest as required" : null;
  }
  if (mutation.target === "catalog.digest_envelope") {
    const tools = [{ name: "alpha", inputSchema: { type: "object", properties: { probe: { type: "string" } } } }];
    return catalogDigest(tools) !== directArrayCatalogDigest(tools) ? "catalog envelope differs from a direct-array digest as required" : null;
  }
  if (mutation.target === "catalog.tools.duplicate_name") {
    try { catalogDigest([{ name: "alpha" }, { name: mutation.mutated_value }]); return null; } catch (error) { return detail(error); }
  }
  if (mutation.target === "catalog.tools.non_ascii_key") {
    try { catalogDigest([{ name: "alpha", inputSchema: { [mutation.mutated_value]: true } }]); return null; } catch (error) { return detail(error); }
  }
  if (mutation.target === "catalog.scalar.nan") {
    try { canonicalBytes(Number.NaN); return null; } catch (error) { return detail(error); }
  }
  if (mutation.target === "catalog.scalar.negative_zero") {
    try { canonicalBytes(-0); return null; } catch (error) { return detail(error); }
  }
  if (mutation.target === "catalog.scalar.unsafe_integer") {
    try { canonicalBytes(mutation.mutated_value); return null; } catch (error) { return detail(error); }
  }
  if (mutation.target === "catalog.scalar.lone_surrogate") {
    try { canonicalBytes(String.fromCharCode(0xd800)); return null; } catch (error) { return detail(error); }
  }
  if (mutation.target === "catalog.scalar.parsed_one_equivalence") {
    const [left, right] = mutation.mutated_value.map((token) => canonicalBytes(JSON.parse(token)));
    return left === right && left === "1" ? "parsed 1 and 1.0 serialize identically as required" : null;
  }
  if (mutation.target === "notifications/initialized.id") {
    const value = notification("notifications/initialized", {});
    value.id = mutation.mutated_value;
    try { validateOutboundEnvelope(value, "notification"); return null; } catch (error) { return detail(error); }
  }
  const mutated = clone(transcript);
  setFixtureValue(mutated, mutation.target.replace(/^transcript\./, ""), mutation.mutated_value);
  return fixtureProblem(mutated);
}

function taskkill(pid, force) {
  return new Promise((resolveTaskkill, rejectTaskkill) => {
    const child = spawn("taskkill.exe", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      rejectTaskkill(new Error("taskkill timed out"));
    }, KILL_GRACE_MS);
    child.once("error", (error) => { clearTimeout(timer); rejectTaskkill(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) rejectTaskkill(new Error(`taskkill failed: code=${code} signal=${signal}`));
      else resolveTaskkill();
    });
  });
}

async function terminateTree(child, signal) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) throw new Error("cannot target a child process tree without a valid pid");
  if (process.platform === "win32") {
    await taskkill(child.pid, signal === "SIGKILL");
    return;
  }
  try { process.kill(-child.pid, signal); } catch (error) { if (error?.code !== "ESRCH") throw error; }
}

function terminateDirect(child, signal) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) throw new Error("cannot target a direct child without a valid pid");
  try { process.kill(child.pid, signal); } catch (error) { if (error?.code !== "ESRCH") throw error; }
}

function pause(milliseconds) {
  return new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
}

async function posixGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForPosixGroupExit(pgid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (await posixGroupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await pause(50);
  }
  return true;
}

async function reapExitedPosixGroup(pgid, actions) {
  if (!await posixGroupAlive(pgid)) {
    actions.push("pgid-absent");
    return;
  }
  actions.push("pgid-probe:alive", "pgid-term");
  try { process.kill(-pgid, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  if (await waitForPosixGroupExit(pgid, KILL_GRACE_MS)) {
    actions.push("pgid-reaped-after-term");
    return;
  }
  actions.push("pgid-kill");
  try { process.kill(-pgid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  if (await waitForPosixGroupExit(pgid, KILL_GRACE_MS)) {
    actions.push("pgid-reaped-after-kill");
    return;
  }
  throw faultError(FaultClass.CLEANUP_FAILED, "POSIX process group remained after TERM and KILL");
}

function selectedEnvironment(root) {
  const home = join(root, "home");
  const temp = join(root, "tmp");
  const environment = { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp, XDG_CACHE_HOME: join(root, "cache"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), MESHFLEET_EVENT_LOG_FILE: join(root, "events.jsonl"), NO_COLOR: "1" };
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (systemRoot) environment.SystemRoot = systemRoot;
  for (const key of ["ComSpec", "PATHEXT"]) if (process.env[key]) environment[key] = process.env[key];
  return environment;
}

class RawStdioClient {
  constructor(entrypoint, root, supervisionMode = "owned-detached") {
    this.entrypoint = entrypoint;
    this.root = root;
    this.supervisionMode = supervisionMode;
    this.child = null;
    this.protocolError = null;
    this.protocolFailureError = null;
    this.resolveProtocolFailure = null;
    this.protocolFailure = new Promise((resolveFailure) => { this.resolveProtocolFailure = resolveFailure; });
    this.faultEvents = [];
    this.poisoned = false;
    this.stdinError = null;
    this.stderr = "";
    this.stderrBytes = 0;
    this.stdoutBytes = 0;
    this.closed = null;
    this.exitState = null;
    this.closing = false;
    this.cleanupActions = [];
    this.correlator = new ResponseCorrelator();
    this.parser = new StrictFrameParser((message) => this.correlator.accept(message));
  }

  failProtocol(error) {
    if (this.protocolError) return;
    const classified = FAULT_CLASS_VALUES.has(error?.faultClass) ? error : faultError(FaultClass.ASSERTION_FAILED, detail(error));
    this.poisoned = true;
    this.protocolFailureError = classified;
    this.protocolError = detail(classified);
    this.faultEvents.push({ class: faultClassOf(classified), message: bounded(this.protocolError, 512) });
    this.resolveProtocolFailure(classified);
    this.correlator.fail(classified);
  }

  async start() {
    const working = join(this.root, "working");
    await Promise.all(["home", "tmp", "cache", "config", "data", "working"].map((name) => mkdir(join(this.root, name), { recursive: true })));
    this.child = spawn(process.execPath, [this.entrypoint], { cwd: working, env: selectedEnvironment(this.root), detached: this.supervisionMode === "owned-detached" && process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.closed = new Promise((resolveClose) => {
      this.child.once("close", (code, signal) => {
        this.exitState = { code, signal };
        try { this.parser.finish(); } catch (error) { this.failProtocol(error); }
        if (!this.closing && !this.protocolError) this.failProtocol(faultError(FaultClass.CHILD_EXIT, `server exited before response: code=${code} signal=${signal}`));
        resolveClose(this.exitState);
      });
      this.child.once("error", (error) => this.failProtocol(new Error(`server spawn failure: ${detail(error)}`)));
    });
    this.child.stdin.on("error", (error) => {
      this.stdinError = faultError(FaultClass.STDIN_WRITE, "stdin write failed");
      this.failProtocol(this.stdinError);
    });
    this.child.stdout.on("data", (chunk) => {
      this.stdoutBytes += chunk.byteLength;
      if (this.stdoutBytes > OUTPUT_CAP_BYTES) return this.failProtocol(faultError(FaultClass.OUTPUT_CAP, "stdout exceeded protocol output cap"));
      try { this.parser.push(chunk); } catch (error) { this.failProtocol(error); }
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderrBytes += chunk.byteLength;
      if (Buffer.byteLength(this.stderr) < STDERR_CAP_BYTES) this.stderr += Buffer.from(chunk).subarray(0, STDERR_CAP_BYTES - Buffer.byteLength(this.stderr)).toString("utf8");
    });
    await new Promise((resolveStart, rejectStart) => {
      const timer = setTimeout(() => rejectStart(new Error("server did not remain available for initialization")), STARTUP_TIMEOUT_MS);
      this.child.once("spawn", () => { clearTimeout(timer); resolveStart(); });
      this.child.once("error", (error) => { clearTimeout(timer); rejectStart(error); });
    });
  }

  async writeBuffer(buffer) {
    if (this.poisoned || this.protocolError) throw this.protocolFailureError ?? faultError(FaultClass.ASSERTION_FAILED, this.protocolError ?? "session is poisoned");
    if (this.stdinError) throw this.stdinError;
    await new Promise((resolveWrite, rejectWrite) => this.child.stdin.write(buffer, (error) => error ? rejectWrite(faultError(FaultClass.STDIN_WRITE, "stdin write failed")) : resolveWrite()));
    if (this.stdinError) throw this.stdinError;
  }

  async writeJson(value, mode, kind) {
    validateOutboundEnvelope(value, kind);
    const text = JSON.stringify(value);
    if (text.includes("\n") || text.includes("\r")) throw new Error("outbound JSON object contains an embedded newline");
    const bytes = Buffer.from(`${text}\n`, "utf8");
    if (mode === "fragmented") {
      const first = Math.max(1, Math.floor(bytes.byteLength / 3));
      const second = Math.max(first + 1, Math.floor((bytes.byteLength * 2) / 3));
      await this.writeBuffer(bytes.subarray(0, first));
      await this.writeBuffer(bytes.subarray(first, second));
      await this.writeBuffer(bytes.subarray(second));
      return;
    }
    if (mode !== "coalesced") throw new Error(`unknown write mode ${String(mode)}`);
    await this.writeBuffer(bytes);
  }

  async writeCoalesced(envelopes) {
    const texts = envelopes.map(({ value, kind }) => JSON.stringify(validateOutboundEnvelope(value, kind)));
    if (texts.some((text) => text.includes("\n") || text.includes("\r"))) throw new Error("outbound JSON object contains an embedded newline");
    await this.writeBuffer(Buffer.from(`${texts.join("\n")}\n`, "utf8"));
  }

  async request(request, mode, coalescedNotification = null) {
    if (!Object.hasOwn(request, "id")) throw new Error("request must carry an id");
    const armed = this.correlator.arm(request.id);
    try {
      if (coalescedNotification) await this.writeCoalesced([{ value: coalescedNotification, kind: "notification" }, { value: request, kind: "request" }]);
      else await this.writeJson(request, mode, "request");
      return await armed.promise;
    } catch (error) {
      armed.cancel(error);
      this.failProtocol(error);
      throw error;
    }
  }

  async waitForExit(timeoutMs) {
    let timer;
    const state = await Promise.race([this.closed, new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(null), timeoutMs); })]);
    if (timer) clearTimeout(timer);
    return state;
  }

  async waitForProtocolFailure(timeoutMs) {
    let timer;
    const failure = await Promise.race([this.protocolFailure, new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(null), timeoutMs); })]);
    if (timer) clearTimeout(timer);
    return failure;
  }

  async close() {
    if (!this.child) return;
    const spontaneousRootExit = Boolean(this.exitState) && !this.closing;
    this.closing = true;
    try { this.child.stdin.end(); } catch { /* the async stdin listener records failures */ }
    let state = await this.waitForExit(KILL_GRACE_MS);
    if (!state) {
      if (this.supervisionMode === "fault-direct") terminateDirect(this.child, "SIGTERM");
      else await terminateTree(this.child, "SIGTERM");
      this.cleanupActions.push("root-term");
      state = await this.waitForExit(KILL_GRACE_MS);
    }
    if (!state) {
      if (this.supervisionMode === "fault-direct") terminateDirect(this.child, "SIGKILL");
      else await terminateTree(this.child, "SIGKILL");
      this.cleanupActions.push("root-kill");
      state = await this.waitForExit(KILL_GRACE_MS);
    }
    if (!state) throw faultError(FaultClass.CLEANUP_FAILED, "server process tree was not reaped after TERM and KILL");
    if (this.supervisionMode === "fault-direct") {
      this.cleanupActions.push("fault-direct-child-only");
    } else if (process.platform === "win32") {
      if (spontaneousRootExit) this.cleanupActions.push("windows-descendants-unverified-after-spontaneous-root-exit");
    } else {
      await reapExitedPosixGroup(this.child.pid, this.cleanupActions);
    }
    try { this.parser.finish(); } catch (error) { this.failProtocol(error); }
    if (this.stdinError) throw this.stdinError;
    if (this.protocolError) throw this.protocolFailureError ?? faultError(FaultClass.ASSERTION_FAILED, this.protocolError);
  }
}

function request(id, method, params) {
  return { jsonrpc: "2.0", id, method, params };
}

function notification(method, params) {
  return { jsonrpc: "2.0", method, params };
}

function requireSuccess(response, operation) {
  if (response?.error) throw new Error(`${operation} returned JSON-RPC error ${JSON.stringify(response.error)}`);
  if (!Object.hasOwn(response ?? {}, "result")) throw new Error(`${operation} response omitted result`);
  return response.result;
}

function requireObject(value, operation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${operation} result must be an object`);
  return value;
}

function assertInitialize(result) {
  const value = requireObject(result, "initialize");
  if (value.protocolVersion !== PROTOCOL_VERSION) throw new Error(`initialize returned protocolVersion ${JSON.stringify(value.protocolVersion)}, expected ${PROTOCOL_VERSION}`);
  requireObject(value.capabilities, "initialize capabilities");
  const serverInfo = requireObject(value.serverInfo, "initialize serverInfo");
  if (typeof serverInfo.name !== "string" || serverInfo.name.length === 0 || typeof serverInfo.version !== "string" || serverInfo.version.length === 0) throw new Error("initialize serverInfo requires non-empty name and version strings");
}

function assertEmptyPing(result) {
  const value = requireObject(result, "ping");
  if (Object.keys(value).length !== 0) throw new Error("ping result must be exactly an empty object");
}

function toolText(result, operation) {
  if (result?.isError === true) throw new Error(`${operation} returned an MCP tool error result`);
  const text = result?.content?.find((item) => item?.type === "text")?.text;
  if (typeof text !== "string") throw new Error(`${operation} did not return text content`);
  try { return JSON.parse(text); } catch (error) { throw new Error(`${operation} text content was not JSON: ${detail(error)}`); }
}

function assertHealth(value) {
  const expected = { status: "ok", fleets: 0, agents: 0, messages: 0, capabilities: 0, events: 0 };
  for (const [key, expectedValue] of Object.entries(expected)) if (value?.[key] !== expectedValue) throw new Error(`get_health expected ${key}=${JSON.stringify(expectedValue)} but received ${JSON.stringify(value?.[key])}`);
}

function assertExactKeys(value, allowed, label) {
  const keys = Object.keys(requireObject(value, label)).sort();
  const expected = [...allowed].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error(`${label} had disallowed keys: ${JSON.stringify(keys)}`);
}

function assertUnknown(response, expectedId, expectation) {
  const observedMessage = bounded(response?.error?.message, 512);
  try {
    if (Object.hasOwn(response ?? {}, "result") && Object.hasOwn(response ?? {}, "error")) throw new Error("unknown-tool response contained both result and error");
    assertExactKeys(response, ["jsonrpc", "id", "error"], "unknown-tool response");
    if (response.jsonrpc !== "2.0" || response.id !== expectedId) throw new Error("unknown-tool response JSON-RPC version or id mismatched");
    assertExactKeys(response.error, ["code", "message"], "unknown-tool error");
    if (response.error.code !== expectation.code || response.error.message !== expectation.message) throw new Error("unknown-tool error code or message mismatched");
  } catch (error) {
    throw new Error(`${detail(error)}; observed_message=${JSON.stringify(observedMessage)}`);
  }
}

async function executeOperations(client, transcript, manifest, profile, observations) {
  const state = { initializedNotification: null };
  const id = (suffix) => `${profile.name}:${suffix}`;
  const dispatch = {
    "initialize": async () => {
      const response = await client.request(request(id("initialize"), "initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: profile.name, version: "0.1" } }), profile.initialize_write);
      assertInitialize(requireSuccess(response, "initialize"));
      observations.response_ids.push(response.id);
    },
    "notifications/initialized": async () => {
      const value = notification("notifications/initialized", {});
      if (profile.post_initialize_write === "coalesced") state.initializedNotification = value;
      else await client.writeJson(value, "fragmented", "notification");
    },
    "ping": async () => {
      const response = await client.request(request(id("ping"), "ping", {}), profile.post_initialize_write, state.initializedNotification);
      state.initializedNotification = null;
      assertEmptyPing(requireSuccess(response, "ping"));
      observations.response_ids.push(response.id);
    },
    "tools/list": async () => {
      const response = await client.request(request(id("tools-list"), "tools/list", {}), "fragmented");
      const tools = requireSuccess(response, "tools/list")?.tools;
      if (!Array.isArray(tools)) throw new Error("tools/list result omitted tools array");
      const observed = catalogDigest(tools);
      if (observed !== manifest.expected_catalog_sha256) throw new Error(`catalog digest mismatch: expected ${manifest.expected_catalog_sha256} observed ${observed}`);
      observations.response_ids.push(response.id);
      observations.catalog_digest = observed;
    },
    "tools/call:get_health": async () => {
      const response = await client.request(request(id("get-health"), "tools/call", { name: "get_health", arguments: {} }), "coalesced");
      assertHealth(toolText(requireSuccess(response, "get_health"), "get_health"));
      observations.response_ids.push(response.id);
    },
    "tools/call:unknown": async () => {
      const responseId = id("unknown");
      const response = await client.request(request(responseId, "tools/call", { name: manifest.unknown_tool_expectation.name, arguments: {} }), "fragmented");
      assertUnknown(response, responseId, { code: manifest.unknown_tool_expectation.expected_exception_code, message: transcript.unknown_tool_expected_message });
      observations.response_ids.push(response.id);
    }
  };
  for (const operation of transcript.operations) {
    const action = dispatch[operation];
    if (!action) throw new Error(`no dispatch action for transcript operation ${operation}`);
    await action();
  }
  if (state.initializedNotification) throw new Error("initialized notification was not transmitted by the transcript dispatch");
  if (new Set(observations.response_ids).size !== observations.response_ids.length) throw new Error("response ids were not one-to-one with requests");
}

async function runProfile(profile, transcript, manifest) {
  const root = await mkdtemp(join(tmpdir(), `meshfleet-wire-${profile.name.replace(/[^a-zA-Z0-9_-]/g, "_")}-`));
  const resolvedRepository = await realpath(REPOSITORY_DIRECTORY);
  const entrypoint = await realpath(resolve(resolvedRepository, manifest.server_entrypoint));
  const entrypointStat = await stat(entrypoint);
  if (!isAbsolute(resolvedRepository) || !isAbsolute(entrypoint) || !isInside(resolvedRepository, entrypoint) || !entrypointStat.isFile()) throw new Error("manifest server entrypoint must resolve to a regular file inside the real repository root");
  const client = new RawStdioClient(entrypoint, root);
  const observations = { profile: profile.name, response_ids: [], stdout_bytes: 0, stderr_bytes: 0 };
  let operationFailure = null;
  try {
    await client.start();
    await executeOperations(client, transcript, manifest, profile, observations);
    observations.stdout_bytes = client.stdoutBytes;
    observations.stderr_bytes = client.stderrBytes;
  } catch (error) {
    operationFailure = error;
  }
  let cleanupFailure = null;
  try {
    await client.close();
  } catch (error) {
    const recordedProtocolFailure = client.stdinError ? detail(client.stdinError) : client.protocolError;
    if (recordedProtocolFailure && detail(error) === recordedProtocolFailure) {
      operationFailure ??= error;
    } else {
      cleanupFailure = error;
    }
  }
  try { await rm(root, { recursive: true, force: true }); } catch (error) { cleanupFailure ??= error; }
  if (operationFailure && cleanupFailure) throw new AggregateError([operationFailure, cleanupFailure], "profile execution and cleanup both failed");
  if (operationFailure) throw operationFailure;
  if (cleanupFailure) throw cleanupFailure;
  return observations;
}

function parseFaultCli() {
  const args = process.argv.slice(2);
  if (args.length === 0) return null;
  if (args[0] !== "--self-test-fault" || !/^[a-z0-9-]+$/.test(args[1] ?? "")) throw new Error("fault entrypoints require --self-test-fault <fixture-name>");
  let timeoutMs = 500;
  if (args.length === 4 && args[2] === "--self-test-timeout-ms" && /^[1-9][0-9]{0,4}$/.test(args[3])) timeoutMs = Number(args[3]);
  else if (args.length !== 2) throw new Error("fault mode accepts only --self-test-fault <fixture-name> [--self-test-timeout-ms <1..99999>]");
  return { fixtureName: args[1], timeoutMs };
}

async function faultEntrypoint(fixtureName) {
  const fixtures = await realpath(FAULT_FIXTURES_DIRECTORY);
  const entrypoint = await realpath(join(fixtures, `${fixtureName}.mjs`));
  const entrypointStat = await stat(entrypoint);
  if (!isInside(fixtures, entrypoint) || !entrypointStat.isFile()) throw new Error("fault entrypoint must resolve to a regular file inside wire/faults/fixtures");
  return entrypoint;
}

async function runFaultProbe(entrypoint, timeoutMs, requireSettledDuplicate = false) {
  const root = await mkdtemp(join(tmpdir(), "meshfleet-wire-fault-"));
  const client = new RawStdioClient(entrypoint, root, "fault-direct");
  const observations = { response_ids: [], stdout_bytes: 0, stderr_bytes: 0, supervision_mode: "fault-direct" };
  let operationFailure = null;
  try {
    await client.start();
    const originalArm = client.correlator.arm.bind(client.correlator);
    client.correlator.arm = (id) => originalArm(id, timeoutMs);
    const response = await client.request(request("fault-probe", "initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "synthetic-wire-fault-probe", version: "0.1" } }), "coalesced");
    assertInitialize(requireSuccess(response, "fault initialize"));
    observations.response_ids.push(response.id);
    if (requireSettledDuplicate) {
      const duplicateFailure = await client.waitForProtocolFailure(timeoutMs);
      if (!duplicateFailure) throw faultError(FaultClass.REQUEST_TIMEOUT, "timed out waiting for duplicate settled response id fault-probe");
      throw duplicateFailure;
    }
  } catch (error) {
    operationFailure = error;
  }
  let cleanupFailure = null;
  try {
    await client.close();
  } catch (error) {
    const recordedProtocolFailure = client.stdinError ? detail(client.stdinError) : client.protocolError;
    if (recordedProtocolFailure && detail(error) === recordedProtocolFailure) operationFailure ??= error;
    else cleanupFailure = error;
  }
  observations.stdout_bytes = client.stdoutBytes;
  observations.stderr_bytes = client.stderrBytes;
  observations.cleanup_actions = [...client.cleanupActions];
  observations.correlation_trace = [...client.correlator.trace];
  observations.fault_events = [...client.faultEvents];
  try { await rm(root, { recursive: true, force: true }); } catch (error) { cleanupFailure ??= error; }
  return {
    observations,
    primary_failure: operationFailure ? bounded(detail(operationFailure), 2048) : null,
    primary_class: operationFailure ? faultClassOf(operationFailure) : null,
    cleanup_failure: cleanupFailure ? bounded(detail(cleanupFailure), 1024) : null,
    cleanup_class: cleanupFailure ? faultClassOf(cleanupFailure) : null
  };
}

async function runFaultMode(options) {
  const checks = [];
  try {
    const entrypoint = await faultEntrypoint(options.fixtureName);
    const outcome = await runFaultProbe(entrypoint, options.timeoutMs, options.fixtureName === "duplicate-id");
    if (options.fixtureName === "stderr-noise-control" || options.fixtureName === "honest-baseline") {
      if (outcome.primary_failure) throw new Error(`${options.fixtureName} primary failure: ${outcome.primary_failure}`);
      if (outcome.cleanup_failure) throw new Error(`${options.fixtureName} cleanup failure: ${outcome.cleanup_failure}`);
      if (JSON.stringify(outcome.observations.response_ids) !== JSON.stringify(["fault-probe"])) throw new Error(`${options.fixtureName} created an unexpected protocol response`);
      if (options.fixtureName === "stderr-noise-control" && outcome.observations.stderr_bytes === 0) throw new Error("stderr-noise control emitted no stderr bytes");
      check(checks, `fault:${options.fixtureName}`, "pass", outcome);
    } else {
      if (!outcome.primary_failure) throw new Error("fault fixture unexpectedly completed the real wire probe");
      check(checks, `fault:${options.fixtureName}`, "fail", outcome);
    }
  } catch (error) {
    check(checks, `fault:${options.fixtureName}`, "fail", { observations: null, primary_failure: bounded(detail(error), 2048), primary_class: faultClassOf(error), cleanup_failure: null, cleanup_class: null });
  }
  return { preamble: `${PREAMBLE} fault self-test`, nonclaims: NONCLAIMS, expected_catalog_sha256: null, passed: checks.every((entry) => entry.status === "pass"), checks };
}

async function main() {
  const faultOptions = parseFaultCli();
  if (faultOptions) return runFaultMode(faultOptions);
  const checks = [];
  let manifest;
  try {
    const [transcript, mutations, loadedManifest] = await Promise.all([readFile(TRANSCRIPT_PATH, "utf8").then(JSON.parse), readFile(MUTATIONS_PATH, "utf8").then(JSON.parse), readFile(MANIFEST_PATH, "utf8").then(JSON.parse)]);
    manifest = loadedManifest;
    const fixtureIssue = fixtureProblem(transcript);
    if (fixtureIssue) throw new Error(`fixture validation failed: ${fixtureIssue}`);
    if (!Array.isArray(mutations?.cases) || mutations.cases.length === 0) throw new Error("mutation fixture has no cases");
    for (const mutation of mutations.cases) if (!mutationProblem(transcript, mutation)) throw new Error(`mutation self-check did not fail closed: ${mutation?.name ?? "unnamed"}`);
    check(checks, "fixtures-and-mutations", "pass", `validated transcript and ${mutations.cases.length} local fail-closed mutation cases`);
    if (typeof manifest.expected_catalog_sha256 !== "string" || manifest.expected_catalog_sha256.length !== 64) throw new Error("manifest lacks a SHA-256 catalog pin");
    if (manifest?.unknown_tool_expectation?.expected_exception_code !== -32603) throw new Error("manifest unknown-tool code is not the pinned -32603 oracle");
    for (const profile of transcript.profiles) check(checks, `wire:${profile.name}`, "pass", await runProfile(profile, transcript, manifest));
  } catch (error) {
    check(checks, "runner", "fail", bounded(detail(error), 2048));
  }
  const passed = checks.length > 0 && checks.every((entry) => entry.status === "pass");
  return { preamble: PREAMBLE, nonclaims: NONCLAIMS, expected_catalog_sha256: manifest?.expected_catalog_sha256 ?? null, passed, checks };
}

const result = await main().catch((error) => ({ preamble: PREAMBLE, nonclaims: NONCLAIMS, expected_catalog_sha256: null, passed: false, checks: [{ id: "runner.unhandled", status: "fail", detail: bounded(detail(error), 2048) }] }));
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.passed) process.exitCode = 1;
