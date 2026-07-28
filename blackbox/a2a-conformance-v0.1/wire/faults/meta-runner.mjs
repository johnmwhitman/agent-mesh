import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

const FAULTS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WIRE_RUNNER = join(FAULTS_DIRECTORY, "..", "runner.mjs");
const REQUIRED_FIXTURES = ["stdout-pollution", "malformed-utf8", "wrong-id", "duplicate-id", "trailing-partial-frame", "oversized-line", "timeout-hang", "early-exit-epipe", "malformed-response", "stderr-noise-control", "honest-baseline", "concurrent-requests"];
const REQUIRED_CONTROL_ROLES = ["stderr-noise-control", "honest-baseline"];
const META_NONCLAIMS = ["On Windows, normal-completion descendant evidence is limited to byte-pinned fixtures that contain no process-spawning or detaching APIs; timeout termination remains taskkill tree-aware."];

function pause(milliseconds) {
  return new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
}

function bounded(value, cap) {
  return Buffer.from(value).subarray(0, cap).toString("utf8");
}

function appendBounded(current, chunk, cap, state) {
  const bytes = Buffer.from(chunk);
  if (current.byteLength + bytes.byteLength > cap) state.overflow = true;
  const remaining = Math.max(0, cap - current.byteLength);
  return remaining === 0 ? current : Buffer.concat([current, bytes.subarray(0, remaining)]);
}

async function waitForClose(state, timeoutMs) {
  if (state.closed) return state.value;
  return Promise.race([state.promise, pause(timeoutMs).then(() => null)]);
}

async function taskkill(pid, timeoutMs) {
  await new Promise((resolveTaskkill, rejectTaskkill) => {
    const child = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      rejectTaskkill(new Error("taskkill timed out"));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); rejectTaskkill(error); });
    child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolveTaskkill() : rejectTaskkill(new Error(`taskkill failed: code=${code}`)); });
  });
}

async function terminateAndAwait(child, state, graceMs) {
  if (state.closed || !child?.pid) return { closed: state.closed, action: "already-exited" };
  if (process.platform === "win32") {
    try {
      await taskkill(child.pid, graceMs);
    } catch (error) {
      if (!await waitForClose(state, graceMs)) return { closed: false, action: `taskkill-error:${error.message}` };
      return { closed: true, action: "already-exited" };
    }
    return { closed: Boolean(await waitForClose(state, graceMs)), action: "taskkill" };
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (!await waitForClose(state, graceMs)) return { closed: false, action: error?.code === "ESRCH" ? "term-esrch-with-open-root" : `term-error:${error.message}` };
    return { closed: true, action: "already-exited" };
  }
  if (await waitForClose(state, graceMs)) return { closed: true, action: "term" };
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!await waitForClose(state, graceMs)) return { closed: false, action: error?.code === "ESRCH" ? "kill-esrch-with-open-root" : `kill-error:${error.message}` };
    return { closed: true, action: "already-exited" };
  }
  return { closed: Boolean(await waitForClose(state, graceMs)), action: "kill" };
}

function isInside(parent, candidate) {
  const value = relative(parent, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

async function posixGroupAudit(pgid) {
  const actions = [];
  const alive = async () => {
    try { process.kill(-pgid, 0); return true; } catch (error) { if (error?.code === "ESRCH") return false; throw error; }
  };
  const waitGone = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (await alive()) {
      if (Date.now() >= deadline) return false;
      await pause(50);
    }
    return true;
  };
  if (!await alive()) return { cleanup_class: null, cleanup_message: null, actions: ["pgid-absent"] };
  actions.push("pgid-present-after-root-close", "pgid-term");
  try { process.kill(-pgid, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  if (await waitGone(2000)) return { cleanup_class: "META_GROUP_MEMBER_AFTER_ROOT_EXIT", cleanup_message: "wire-runner process group contained members after root close", actions };
  actions.push("pgid-kill");
  try { process.kill(-pgid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  if (await waitGone(2000)) return { cleanup_class: "META_GROUP_MEMBER_AFTER_ROOT_EXIT", cleanup_message: "wire-runner process group contained members after root close", actions };
  return { cleanup_class: "META_GROUP_CLEANUP_FAILED", cleanup_message: "wire-runner process group remained after TERM and KILL", actions };
}

async function bindFixtures(config) {
  const fixturesDirectory = await realpath(join(FAULTS_DIRECTORY, "fixtures"));
  const expected = [...REQUIRED_FIXTURES].sort();
  const files = (await readdir(fixturesDirectory)).sort();
  const expectedFiles = expected.map((name) => `${name}.mjs`);
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) throw new Error("fixture directory entries mismatched the exact expected fixture filenames");
  for (const definition of config.cases) {
    const fixturePath = join(fixturesDirectory, `${definition.fixture}.mjs`);
    const fixtureLinkStat = await lstat(fixturePath);
    if (!fixtureLinkStat.isFile() || fixtureLinkStat.isSymbolicLink()) throw new Error(`fixture ${definition.fixture} must be a non-symlink regular file`);
    const entrypoint = await realpath(fixturePath);
    const entrypointStat = await stat(entrypoint);
    if (!entrypointStat.isFile() || !isInside(fixturesDirectory, entrypoint)) throw new Error(`fixture ${definition.fixture} escaped the fixture directory`);
    const source = await readFile(entrypoint);
    const digest = createHash("sha256").update(source).digest("hex");
    if (digest !== definition.fixture_sha256) throw new Error(`fixture ${definition.fixture} SHA-256 mismatched`);
    const text = source.toString("utf8");
    if (/\b(?:node:)?(?:child_process|cluster|worker_threads)\b|\bdetached\s*:|\bprocess\.(?:detach|setsid)\b|\.unref\s*\(/.test(text)) throw new Error(`fixture ${definition.fixture} contains a prohibited process-spawning or detaching API`);
  }
}

function validateConfig(config) {
  if (config?.schema_version !== "0.2" || !Array.isArray(config.cases)) throw new Error("invalid fault case manifest schema");
  for (const key of ["request_timeout_ms", "teardown_wait_ms", "teardown_wait_count", "outer_timeout_slack_ms", "outer_timeout_ms", "output_cap_bytes"]) if (!Number.isInteger(config[key]) || config[key] <= 0) throw new Error(`fault manifest ${key} must be positive`);
  if (config.teardown_wait_count !== 3 || config.outer_timeout_slack_ms < 2000) throw new Error("fault manifest must model all three teardown waits and at least two seconds slack");
  if (config.outer_timeout_ms <= config.request_timeout_ms + (config.teardown_wait_ms * config.teardown_wait_count) + config.outer_timeout_slack_ms) throw new Error("outer timeout must strictly exceed request plus all teardown waits and slack");
  const ids = new Set();
  const fixtures = new Set();
  const classes = new Set();
  const roles = new Map();
  for (const definition of config.cases) {
    if (!/^[a-z0-9-]+$/.test(definition?.id ?? "") || ids.has(definition.id)) throw new Error("fault case ids must be unique lowercase tokens");
    if (!/^[a-z0-9-]+$/.test(definition.fixture ?? "") || fixtures.has(definition.fixture)) throw new Error("fault fixture names must be unique lowercase tokens");
    ids.add(definition.id);
    fixtures.add(definition.fixture);
    if (!Number.isInteger(definition.timeout_ms) || definition.timeout_ms <= 0) throw new Error(`fault case ${definition.id} timeout must be positive`);
    if (definition.role === "fault") {
      if (typeof definition.primary_class !== "string" || classes.has(definition.primary_class) || typeof definition.primary_message !== "string" || definition.primary_message.length === 0) throw new Error(`fault case ${definition.id} requires a unique class and exact message`);
      classes.add(definition.primary_class);
    } else {
      roles.set(definition.role, (roles.get(definition.role) ?? 0) + 1);
      if (definition.primary_class !== null || definition.primary_message !== null) throw new Error(`control case ${definition.id} must not declare a primary failure`);
    }
    if (!Array.isArray(definition.expected_trace) || !/^[a-f0-9]{64}$/.test(definition.fixture_sha256 ?? "")) throw new Error(`fault case ${definition.id} requires an exact trace and fixture SHA-256`);
  }
  if (JSON.stringify([...fixtures].sort()) !== JSON.stringify([...REQUIRED_FIXTURES].sort())) throw new Error("fault manifest fixture set mismatched required fixtures");
  for (const role of REQUIRED_CONTROL_ROLES) if (roles.get(role) !== 1) throw new Error(`fault manifest requires exactly one ${role} control`);
  if (roles.size !== REQUIRED_CONTROL_ROLES.length) throw new Error("fault manifest has an unknown control role");
}

async function execute(definition, config) {
  const args = [WIRE_RUNNER, "--self-test-fault", definition.fixture, "--self-test-timeout-ms", String(definition.timeout_ms)];
  const child = spawn(process.execPath, args, { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", USERPROFILE: process.env.USERPROFILE ?? "", SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "" } });
  const state = { closed: false, value: null, overflow: false, promise: null };
  let resolveClose;
  state.promise = new Promise((resolve) => { resolveClose = resolve; });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk, config.output_cap_bytes, state); });
  child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk, config.output_cap_bytes, state); });
  child.once("error", (error) => {
    state.closed = true;
    state.value = { spawn_error: error.message };
    resolveClose(state.value);
  });
  child.once("close", (code, signal) => {
    state.closed = true;
    state.value = { code, signal };
    resolveClose(state.value);
  });
  const completed = await Promise.race([state.promise, pause(config.outer_timeout_ms).then(() => null)]);
  if (!completed) {
    const termination = await terminateAndAwait(child, state, config.teardown_wait_ms * config.teardown_wait_count);
    const group = process.platform === "win32" ? { cleanup_class: null, cleanup_message: null, actions: ["windows-timeout-taskkill-tree-aware"] } : await posixGroupAudit(child.pid);
    if (group.cleanup_class) return { id: definition.id, status: "fail", cleanup_class: group.cleanup_class, cleanup_actions: group.actions.slice(0, 8), detail: group.cleanup_message };
    return { id: definition.id, status: "fail", detail: `meta-runner timeout; termination=${termination.action}; root_closed=${termination.closed}; group_actions=${group.actions.slice(0, 8).join(",")}` };
  }
  const group = process.platform === "win32" ? { cleanup_class: null, cleanup_message: null, actions: ["windows-normal-completion-fixture-bound"] } : await posixGroupAudit(child.pid);
  if (group.cleanup_class) return { id: definition.id, status: "fail", cleanup_class: group.cleanup_class, cleanup_actions: group.actions.slice(0, 8), detail: group.cleanup_message };
  if (state.value.spawn_error) return { id: definition.id, status: "fail", detail: `spawn failed: ${state.value.spawn_error}` };
  if (state.overflow) return { id: definition.id, status: "fail", detail: "meta-runner output cap exceeded" };
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(stdout); } catch { return { id: definition.id, status: "fail", detail: "wire runner emitted malformed UTF-8" }; }
  if (!text.endsWith("\n") || text.trimEnd().split("\n").length !== 1) return { id: definition.id, status: "fail", detail: "wire runner did not emit one atomic JSON result" };
  let result;
  try { result = JSON.parse(text); } catch { return { id: definition.id, status: "fail", detail: "wire runner result was not JSON" }; }
  if (!Array.isArray(result?.checks) || result.checks.length !== 1) return { id: definition.id, status: "fail", detail: "wire runner emitted unexpected fault checks" };
  const check = result.checks[0];
  if (check?.id !== `fault:${definition.fixture}`) return { id: definition.id, status: "fail", detail: "wire runner emitted the wrong fault check id" };
  if (definition.role === "fault") {
    if (state.value.code === 0 || state.value.signal !== null || result.passed !== false || check.status !== "fail") return { id: definition.id, status: "fail", detail: `fault outer condition mismatched: code=${state.value.code} signal=${state.value.signal} passed=${result.passed} status=${check.status}` };
    if (check.detail?.primary_class !== definition.primary_class || check.detail?.primary_failure !== definition.primary_message) return { id: definition.id, status: "fail", detail: `primary classification mismatch: ${bounded(JSON.stringify(check.detail), 1024)}` };
  } else {
    if (state.value.code !== 0 || state.value.signal !== null || result.passed !== true || check.status !== "pass") return { id: definition.id, status: "fail", detail: `control outer condition mismatched: code=${state.value.code} signal=${state.value.signal} passed=${result.passed} status=${check.status}` };
    if (check.detail?.primary_class !== null || check.detail?.primary_failure !== null) return { id: definition.id, status: "fail", detail: "control recorded a primary failure" };
  }
  if (check.detail?.cleanup_class !== null || check.detail?.cleanup_failure !== null) return { id: definition.id, status: "fail", detail: `wire runner cleanup failure: ${bounded(JSON.stringify(check.detail), 1024)}` };
  if (check.detail?.observations?.supervision_mode !== "fault-direct") return { id: definition.id, status: "fail", detail: "fault probe supervision mode mismatched" };
  if (JSON.stringify(check.detail?.observations?.correlation_trace) !== JSON.stringify(definition.expected_trace)) return { id: definition.id, status: "fail", detail: "correlation trace mismatched" };
  const events = check.detail?.observations?.fault_events;
  if (definition.role === "fault") {
    if (!Array.isArray(events) || events.length !== 1 || events[0].class !== definition.primary_class || events[0].message !== definition.primary_message) return { id: definition.id, status: "fail", detail: "fault event mismatched primary classification" };
  } else if (!Array.isArray(events) || events.length !== 0) return { id: definition.id, status: "fail", detail: "control recorded fault events" };
  if (definition.role === "stderr-noise-control" && (!check.detail?.observations?.stderr_bytes || JSON.stringify(check.detail.observations.response_ids) !== JSON.stringify(["fault-probe"]))) return { id: definition.id, status: "fail", detail: "stderr-noise control did not preserve exactly one protocol response" };
  if (definition.role === "honest-baseline" && (check.detail?.observations?.stderr_bytes !== 0 || JSON.stringify(check.detail.observations.response_ids) !== JSON.stringify(["fault-probe"]))) return { id: definition.id, status: "fail", detail: "honest baseline did not preserve exactly one clean protocol response" };
  return { id: definition.id, status: "pass", detail: definition.primary_class ?? definition.role };
}

async function main() {
  const config = JSON.parse(await readFile(join(FAULTS_DIRECTORY, "cases.json"), "utf8"));
  validateConfig(config);
  await bindFixtures(config);
  const checks = [];
  for (const definition of config.cases) checks.push(await execute(definition, config));
  return { preamble: "Meshfleet raw stdio wire fault meta-runner v0.2", nonclaims: META_NONCLAIMS, passed: checks.every((check) => check.status === "pass"), checks };
}

const result = await main().catch((error) => ({ preamble: "Meshfleet raw stdio wire fault meta-runner v0.2", nonclaims: META_NONCLAIMS, passed: false, checks: [{ id: "meta-runner", status: "fail", detail: error instanceof Error ? error.message : String(error) }] }));
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.passed) process.exitCode = 1;
