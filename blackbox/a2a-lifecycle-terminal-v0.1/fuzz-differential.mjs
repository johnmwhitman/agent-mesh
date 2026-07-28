import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { evaluateLifecycleTrace, PROFILE, sha256 } from "./evaluator.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const OPS = new Set(["create", "acquire", "renew", "expire", "settle", "settle_with_retry", "cancel"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

let state = 0x4d1ce11f;
function next() { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; }
function pick(values) { return values[next() % values.length]; }
function encode(value) { if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value); if (typeof value === "string") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encode(value[key])}`).join(",")}}`; }
function evaluateBytes(raw) { return evaluateLifecycleTrace(JSON.parse(Buffer.from(raw).toString("utf8"))); }
function python(raw) {
  const script = [
    "import base64,json,sys",
    "sys.path.insert(0,sys.argv[1])",
    "from evaluator import evaluate_lifecycle_trace, parse_strict_json",
    "token=sys.argv[2]; pad='='*((4-len(token)%4)%4)",
    "raw=base64.urlsafe_b64decode(token+pad)",
    "trace=parse_strict_json(raw.decode('utf-8'))",
    "print(json.dumps(evaluate_lifecycle_trace(trace),separators=(',',':'),ensure_ascii=True))",
  ].join("\n");
  const result = spawnSync("python3", ["-c", script, join(root, "python"), Buffer.from(raw).toString("base64url")], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
function assertOutput(raw, wanted, label) {
  const javascript = evaluateBytes(raw);
  const other = python(raw);
  if (encode(javascript) !== encode(wanted) || encode(other) !== encode(wanted) || encode(javascript) !== encode(other)) {
    throw new Error(`${label}: js=${encode(javascript)} wanted=${encode(wanted)} py=${encode(other)}`);
  }
}

function scalarString(value) {
  if (typeof value !== "string") return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const nextCode = value.charCodeAt(i + 1);
      if (!(nextCode >= 0xdc00 && nextCode <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function assertData(value) {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { if (!scalarString(value)) throw new Error("lone surrogate"); return; }
  if (typeof value === "number") { if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error("non-canonical number"); return; }
  if (Array.isArray(value)) { for (const item of value) assertData(item); return; }
  if (typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    for (const [key, item] of Object.entries(value)) { if (!scalarString(key)) throw new Error("lone surrogate key"); assertData(item); }
    return;
  }
  throw new Error("unsupported JSON value");
}
function exactFields(command, required) {
  const keys = Object.keys(command);
  return keys.length === required.length && required.every((key) => Object.hasOwn(command, key));
}
function nonempty(value) { return typeof value === "string" && value.length > 0 && scalarString(value); }
function safeNonnegative(value) { return Number.isSafeInteger(value) && value >= 0; }
function safePositive(value) { return Number.isSafeInteger(value) && value > 0; }
function validData(value) { try { assertData(value); return true; } catch { return false; } }
function copy(value) { return value === null ? null : JSON.parse(JSON.stringify(value)); }

function commandShapeCode(command) {
  switch (command.op) {
    case "create":
      if (!exactFields(command, ["op", "at", "work_id", "max_attempts", "retry_base_ms", "retry_jitter"]) || !nonempty(command.work_id)) return "MALFORMED_COMMAND";
      if (!safePositive(command.max_attempts) || !safePositive(command.retry_base_ms) || command.retry_jitter !== false) return "INVALID_RETRY_POLICY";
      return null;
    case "acquire":
      return exactFields(command, ["op", "at", "owner_id", "lease_ms"]) && nonempty(command.owner_id) && safePositive(command.lease_ms) && Number.isSafeInteger(command.at + command.lease_ms) ? null : "MALFORMED_COMMAND";
    case "renew":
      return exactFields(command, ["op", "at", "owner_id", "owner_epoch", "lease_ms"]) && nonempty(command.owner_id) && safeNonnegative(command.owner_epoch) && safePositive(command.lease_ms) && Number.isSafeInteger(command.at + command.lease_ms) ? null : "MALFORMED_COMMAND";
    case "expire":
      return exactFields(command, ["op", "at"]) ? null : "MALFORMED_COMMAND";
    case "settle":
      return exactFields(command, ["op", "at", "owner_id", "owner_epoch", "outcome", "result", "error"]) && nonempty(command.owner_id) && safeNonnegative(command.owner_epoch) && ["success", "failure"].includes(command.outcome) && validData(command.result) && (command.error === null || scalarString(command.error)) ? null : "MALFORMED_COMMAND";
    case "settle_with_retry":
      return exactFields(command, ["op", "at", "owner_id", "owner_epoch", "outcome", "error"]) && nonempty(command.owner_id) && safeNonnegative(command.owner_epoch) && command.outcome === "failure" && (command.error === null || scalarString(command.error)) ? null : "MALFORMED_COMMAND";
    case "cancel":
      return exactFields(command, ["op", "at", "reason"]) && (command.reason === null || scalarString(command.reason)) ? null : "MALFORMED_COMMAND";
    default:
      throw new Error("shape requested for unknown operation");
  }
}

function attempt(work, number, epoch, eligibleAt) {
  return { id: `${work.id}:attempt:${number}`, number, status: "pending", owner_id: null, owner_epoch: epoch, eligible_at: eligibleAt, lease_until: null, result: null, error: null };
}
function current(machine) { return machine.attempts.find((item) => item.id === machine.work.current_attempt_id) ?? null; }
function emit(machine, kind, item, at) {
  machine.events.push({ id: `${machine.work.id}:event:${machine.events.length + 1}`, seq: machine.events.length + 1, kind, attempt_id: item.id, owner_epoch: item.owner_epoch, occurred_at: at });
}
function retryEligibleAt(machine, old, at) {
  const delay = machine.work.retry_base_ms * (2 ** (old.number - 1));
  return Number.isSafeInteger(delay) && Number.isSafeInteger(at + delay) ? at + delay : null;
}
function makeRetry(machine, old, at, eligibleAt) {
  const nextAttempt = attempt(machine.work, old.number + 1, machine.work.owner_epoch + 1, eligibleAt);
  machine.attempts.push(nextAttempt);
  machine.work.status = "pending";
  machine.work.current_attempt_id = nextAttempt.id;
  machine.work.owner_epoch = nextAttempt.owner_epoch;
  machine.work.result = null;
  machine.work.error = null;
  emit(machine, "attempt_retried", nextAttempt, at);
}
function accepted() { return { accepted: true, code: "OK" }; }
function rejected(code) { return { accepted: false, code }; }

function apply(machine, command) {
  if (!command || typeof command !== "object" || Array.isArray(command) || !nonempty(command.op) || !safeNonnegative(command.at)) {
    return { state: machine, result: rejected("MALFORMED_COMMAND") };
  }
  if (!OPS.has(command.op)) return { state: machine, result: rejected("UNKNOWN_OP") };
  const shapeCode = commandShapeCode(command);
  if (shapeCode !== null) return { state: machine, result: rejected(shapeCode) };

  if (command.op === "create") {
    if (machine !== null) return { state: machine, result: rejected("WORK_ALREADY_EXISTS") };
    const work = {
      id: command.work_id,
      status: "pending",
      current_attempt_id: `${command.work_id}:attempt:1`,
      owner_epoch: 0,
      max_attempts: command.max_attempts,
      retry_base_ms: command.retry_base_ms,
      retry_jitter: false,
      result: null,
      error: null,
    };
    machine = { work, attempts: [attempt(work, 1, 0, command.at)], events: [] };
    emit(machine, "attempt_created", machine.attempts[0], command.at);
    return { state: machine, result: accepted() };
  }

  if (machine === null || TERMINAL.has(machine.work.status)) return { state: machine, result: rejected("WORK_TERMINAL_OR_UNKNOWN") };
  const active = current(machine);
  if (!active) return { state: machine, result: rejected("WORK_HAS_NO_CURRENT_ATTEMPT") };

  if (command.op === "acquire") {
    if (machine.work.status !== "pending" || active.status !== "pending" || command.at < active.eligible_at) {
      return { state: machine, result: rejected("WORK_NOT_LEASEABLE") };
    }
    const epoch = Math.max(machine.work.owner_epoch, active.owner_epoch) + 1;
    machine.work.status = "running";
    machine.work.owner_epoch = epoch;
    active.status = "running";
    active.owner_id = command.owner_id;
    active.owner_epoch = epoch;
    active.lease_until = command.at + command.lease_ms;
    emit(machine, "lease_acquired", active, command.at);
    return { state: machine, result: accepted() };
  }

  if (command.op === "cancel") {
    machine.work.status = "cancelled";
    machine.work.result = null;
    machine.work.error = command.reason;
    active.status = "cancelled";
    active.result = null;
    active.error = command.reason;
    emit(machine, "attempt_cancelled", active, command.at);
    return { state: machine, result: accepted() };
  }

  if (command.op === "expire") {
    if (machine.work.status !== "running" || active.status !== "running" || active.lease_until === null || command.at < active.lease_until) {
      return { state: machine, result: rejected("ATTEMPT_NOT_EXPIRED") };
    }
    const eligibleAt = active.number < machine.work.max_attempts ? retryEligibleAt(machine, active, command.at) : null;
    if (active.number < machine.work.max_attempts && eligibleAt === null) return { state: machine, result: rejected("RETRY_TIME_OVERFLOW") };
    active.status = "expired";
    emit(machine, "lease_expired", active, command.at);
    if (active.number >= machine.work.max_attempts) {
      const message = "lease expired after final allowed attempt";
      active.status = "failed";
      active.error = message;
      machine.work.status = "failed";
      machine.work.error = message;
      emit(machine, "attempt_failed", active, command.at);
    } else {
      makeRetry(machine, active, command.at, eligibleAt);
    }
    return { state: machine, result: accepted() };
  }

  if (command.op === "renew") {
    if (machine.work.status !== "running" || active.status !== "running" || active.owner_id !== command.owner_id || active.owner_epoch !== command.owner_epoch || active.lease_until === null || command.at >= active.lease_until) {
      return { state: machine, result: rejected("STALE_OR_TERMINAL_LEASE") };
    }
    active.lease_until = command.at + command.lease_ms;
    emit(machine, "lease_acquired", active, command.at);
    return { state: machine, result: accepted() };
  }

  if (machine.work.status !== "running" || active.status !== "running" || active.owner_id !== command.owner_id || active.owner_epoch !== command.owner_epoch || active.lease_until === null || command.at >= active.lease_until) {
    return { state: machine, result: rejected("STALE_OR_TERMINAL_LEASE") };
  }
  const eligibleAt = command.op === "settle_with_retry" && active.number < machine.work.max_attempts ? retryEligibleAt(machine, active, command.at) : null;
  if (command.op === "settle_with_retry" && active.number < machine.work.max_attempts && eligibleAt === null) {
    return { state: machine, result: rejected("RETRY_TIME_OVERFLOW") };
  }
  if (command.op === "settle" && command.outcome === "success") {
    active.status = "succeeded";
    active.result = copy(command.result);
    active.error = null;
    machine.work.status = "succeeded";
    machine.work.result = copy(command.result);
    machine.work.error = null;
    emit(machine, "attempt_succeeded", active, command.at);
    return { state: machine, result: accepted() };
  }
  active.status = "failed";
  active.result = null;
  active.error = command.error;
  emit(machine, "attempt_failed", active, command.at);
  if (command.op === "settle_with_retry" && active.number < machine.work.max_attempts) {
    makeRetry(machine, active, command.at, eligibleAt);
  } else {
    machine.work.status = "failed";
    machine.work.result = null;
    machine.work.error = command.error;
  }
  return { state: machine, result: accepted() };
}

function finish(body) { return { ...body, receipt_sha256: sha256(body) }; }

function expected(trace) {
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) {
    return finish({ profile: PROFILE, case_id: null, top_code: "MALFORMED_TRACE", steps: [], final: null });
  }
  const caseId = nonempty(trace.case_id) ? trace.case_id : null;
  if (!exactFields(trace, ["profile", "case_id", "commands"]) || caseId === null || !Array.isArray(trace.commands)) {
    return finish({ profile: PROFILE, case_id: caseId, top_code: "MALFORMED_TRACE", steps: [], final: null });
  }
  if (trace.profile !== PROFILE) {
    return finish({ profile: PROFILE, case_id: caseId, top_code: "PROFILE_REJECT", steps: [], final: null });
  }
  let machine = null;
  let lastAt = -1;
  const steps = [];
  for (let index = 0; index < trace.commands.length; index += 1) {
    const command = trace.commands[index];
    const before = sha256(machine);
    let applied;
    if (command && typeof command === "object" && !Array.isArray(command) && safeNonnegative(command.at) && command.at < lastAt) {
      applied = { state: machine, result: rejected("MALFORMED_COMMAND") };
    } else {
      if (command && typeof command === "object" && safeNonnegative(command.at)) lastAt = command.at;
      applied = apply(machine, command);
    }
    machine = applied.state;
    const after = sha256(machine);
    if (!applied.result.accepted && before !== after) throw new Error("rejected command mutated state");
    steps.push({
      index,
      op: command && typeof command.op === "string" ? command.op : null,
      accepted: applied.result.accepted,
      code: applied.result.code,
      state_sha256: after,
    });
  }
  return finish({ profile: PROFILE, case_id: caseId, top_code: "OK", steps, final: copy(machine) });
}

function randomCommand(at, context) {
  const kind = next() % 12;
  if (kind === 0 || context.forceCreate) {
    return { op: "create", at, work_id: `w${next() % 8}`, max_attempts: 1 + (next() % 4), retry_base_ms: 1 + (next() % 20), retry_jitter: false };
  }
  if (kind === 1) {
    return { op: "acquire", at, owner_id: pick(["owner-a", "owner-b", "owner-c"]), lease_ms: 1 + (next() % 30) };
  }
  if (kind === 2) {
    return { op: "renew", at, owner_id: pick(["owner-a", "owner-b", "owner-c"]), owner_epoch: next() % 6, lease_ms: 1 + (next() % 30) };
  }
  if (kind === 3) return { op: "expire", at };
  if (kind === 4) {
    return { op: "settle", at, owner_id: pick(["owner-a", "owner-b", "owner-c"]), owner_epoch: next() % 6, outcome: pick(["success", "failure"]), result: pick([null, "ok", { v: next() % 3 }, true, 0]), error: pick([null, "err", "boom"]) };
  }
  if (kind === 5) {
    return { op: "settle_with_retry", at, owner_id: pick(["owner-a", "owner-b", "owner-c"]), owner_epoch: next() % 6, outcome: "failure", error: pick([null, "retry-me"]) };
  }
  if (kind === 6) return { op: "cancel", at, reason: pick([null, "stop", "halt"]) };
  if (kind === 7) return { op: "not_a_real_op", at };
  if (kind === 8) return { op: "create", at, work_id: "w-bad", max_attempts: 0, retry_base_ms: 10, retry_jitter: false };
  if (kind === 9) return { op: "acquire", at, owner_id: "", lease_ms: 5 };
  if (kind === 10) return { op: "settle", at, owner_id: "owner-a", owner_epoch: 1, outcome: "success", result: "x" };
  return { op: "cancel", at, reason: 12 };
}

function generateTrace(scenario) {
  const commands = [];
  let at = 0;
  const size = next() % 24;
  for (let index = 0; index < size; index += 1) {
    if (next() % 5 === 0 && at > 0) at = Math.max(0, at - (next() % 3));
    else at += next() % 8;
    commands.push(randomCommand(at, { forceCreate: index === 0 && next() % 4 !== 0 }));
  }
  if (next() % 7 === 0 && commands.length > 1) {
    const source = commands[next() % commands.length];
    commands.splice(next() % (commands.length + 1), 0, { ...source });
  }
  return { profile: PROFILE, case_id: `fuzz-${scenario}`, commands };
}

for (let scenario = 0; scenario < 256; scenario += 1) {
  const trace = generateTrace(scenario);
  const wanted = expected(trace);
  assertOutput(Buffer.from(JSON.stringify(trace)), wanted, `generated-${scenario}`);
}

const edgeTraces = [
  { profile: PROFILE, case_id: "empty-commands", commands: [] },
  { profile: PROFILE, case_id: "empty-then-noise", commands: [{ op: "expire", at: 0 }, { op: "cancel", at: 1, reason: null }] },
  {
    profile: PROFILE,
    case_id: "duplicate-create",
    commands: [
      { op: "create", at: 0, work_id: "w-dup", max_attempts: 2, retry_base_ms: 10, retry_jitter: false },
      { op: "create", at: 1, work_id: "w-dup", max_attempts: 2, retry_base_ms: 10, retry_jitter: false },
    ],
  },
  {
    profile: PROFILE,
    case_id: "duplicate-acquire",
    commands: [
      { op: "create", at: 0, work_id: "w-acq", max_attempts: 3, retry_base_ms: 5, retry_jitter: false },
      { op: "acquire", at: 0, owner_id: "owner-a", lease_ms: 10 },
      { op: "acquire", at: 1, owner_id: "owner-a", lease_ms: 10 },
    ],
  },
  {
    profile: PROFILE,
    case_id: "out-of-order-timestamps",
    commands: [
      { op: "create", at: 10, work_id: "w-oo", max_attempts: 2, retry_base_ms: 5, retry_jitter: false },
      { op: "acquire", at: 5, owner_id: "owner-a", lease_ms: 10 },
    ],
  },
  {
    profile: PROFILE,
    case_id: "decreasing-after-progress",
    commands: [
      { op: "create", at: 0, work_id: "w-dec", max_attempts: 2, retry_base_ms: 5, retry_jitter: false },
      { op: "acquire", at: 2, owner_id: "owner-a", lease_ms: 10 },
      { op: "renew", at: 1, owner_id: "owner-a", owner_epoch: 1, lease_ms: 10 },
    ],
  },
  {
    profile: PROFILE,
    case_id: "invalid-event-type",
    commands: [
      { op: "create", at: 0, work_id: "w-unk", max_attempts: 2, retry_base_ms: 5, retry_jitter: false },
      { op: "not_a_real_op", at: 1 },
      { op: "acquire", at: 2, owner_id: "owner-a", lease_ms: 10 },
    ],
  },
  {
    profile: PROFILE,
    case_id: "happy-path-success",
    commands: [
      { op: "create", at: 0, work_id: "w-ok", max_attempts: 3, retry_base_ms: 10, retry_jitter: false },
      { op: "acquire", at: 0, owner_id: "owner-a", lease_ms: 20 },
      { op: "renew", at: 5, owner_id: "owner-a", owner_epoch: 1, lease_ms: 20 },
      { op: "settle", at: 10, owner_id: "owner-a", owner_epoch: 1, outcome: "success", result: "done", error: null },
    ],
  },
  {
    profile: PROFILE,
    case_id: "expire-retry-cancel",
    commands: [
      { op: "create", at: 0, work_id: "w-ex", max_attempts: 2, retry_base_ms: 10, retry_jitter: false },
      { op: "acquire", at: 0, owner_id: "owner-a", lease_ms: 10 },
      { op: "expire", at: 10 },
      { op: "acquire", at: 20, owner_id: "owner-b", lease_ms: 10 },
      { op: "cancel", at: 21, reason: "stop" },
    ],
  },
  {
    profile: PROFILE,
    case_id: "settle-with-retry-cap",
    commands: [
      { op: "create", at: 0, work_id: "w-sr", max_attempts: 1, retry_base_ms: 10, retry_jitter: false },
      { op: "acquire", at: 0, owner_id: "owner-a", lease_ms: 10 },
      { op: "settle_with_retry", at: 1, owner_id: "owner-a", owner_epoch: 1, outcome: "failure", error: "x" },
    ],
  },
  { profile: "meshfleet.a2a.lifecycle-terminal.v9", case_id: "bad-profile", commands: [] },
  { profile: PROFILE, case_id: null, commands: [] },
  { profile: PROFILE, case_id: "missing-commands-field" },
  { profile: PROFILE, case_id: "commands-not-array", commands: {} },
];

for (let index = 0; index < edgeTraces.length; index += 1) {
  const trace = edgeTraces[index];
  const wanted = expected(trace);
  assertOutput(Buffer.from(JSON.stringify(trace)), wanted, `edge-${index}-${trace.case_id ?? "null-case"}`);
}

const evaluatorText = readFileSync(join(root, "evaluator.mjs"), "utf8");
if (/node:(fs|net|http|https|child_process)|\bfetch\s*\(|\bprocess\./.test(evaluatorText)) throw new Error("static-no-io");
process.stdout.write(JSON.stringify({
  suite: "fuzz-differential",
  generated_traces: 256,
  edge_cases: edgeTraces.length,
  passed: true,
}));
