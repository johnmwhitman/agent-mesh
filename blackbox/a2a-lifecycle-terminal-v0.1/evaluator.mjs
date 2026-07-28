import { createHash } from "node:crypto";

export const PROFILE = "meshfleet.a2a.lifecycle-terminal.v0.1";
const OPS = new Set(["create", "acquire", "renew", "expire", "settle", "settle_with_retry", "cancel"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

function scalarString(value) {
  if (typeof value !== "string") return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function assertData(value) {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (!scalarString(value)) throw new Error("lone surrogate");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error("non-canonical number");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertData(item);
    return;
  }
  if (typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    for (const [key, item] of Object.entries(value)) {
      if (!scalarString(key)) throw new Error("lone surrogate key");
      assertData(item);
    }
    return;
  }
  throw new Error("unsupported JSON value");
}

function compareCodePoints(left, right) {
  const a = Array.from(left, (char) => char.codePointAt(0));
  const b = Array.from(right, (char) => char.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function encodeCanonical(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encodeCanonical).join(",")}]`;
  const keys = Object.keys(value).sort(compareCodePoints);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${encodeCanonical(value[key])}`).join(",")}}`;
}

export function canonical(value) {
  assertData(value);
  return encodeCanonical(value);
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value), "utf8").digest("hex");
}

class StrictParser {
  constructor(text) {
    this.text = text;
    this.i = 0;
  }
  ws() {
    while ([" ", "\t", "\r", "\n"].includes(this.text[this.i])) this.i += 1;
  }
  value() {
    this.ws();
    const c = this.text[this.i];
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === "\"") return this.string();
    for (const [token, value] of [["true", true], ["false", false], ["null", null]]) {
      if (this.text.startsWith(token, this.i)) {
        this.i += token.length;
        return value;
      }
    }
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(this.text.slice(this.i));
    if (!match) throw new Error(`invalid JSON at ${this.i}`);
    this.i += match[0].length;
    const number = Number(match[0]);
    if (!Number.isSafeInteger(number) || Object.is(number, -0)) throw new Error("non-canonical number");
    return number;
  }
  string() {
    const start = this.i++;
    while (this.i < this.text.length) {
      const c = this.text[this.i++];
      if (c === "\"") {
        const value = JSON.parse(this.text.slice(start, this.i));
        if (!scalarString(value)) throw new Error("lone surrogate");
        return value;
      }
      if (c === "\\") {
        const escaped = this.text[this.i++];
        if (escaped === "u") this.i += 4;
      } else if (c.charCodeAt(0) < 0x20) {
        throw new Error("control character in string");
      }
    }
    throw new Error("unterminated string");
  }
  object() {
    const out = Object.create(null);
    const keys = new Set();
    this.i += 1;
    this.ws();
    if (this.text[this.i] === "}") {
      this.i += 1;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.text[this.i] !== "\"") throw new Error("object key required");
      const key = this.string();
      if (keys.has(key)) throw new Error(`duplicate member: ${key}`);
      keys.add(key);
      this.ws();
      if (this.text[this.i++] !== ":") throw new Error("colon required");
      out[key] = this.value();
      this.ws();
      const c = this.text[this.i++];
      if (c === "}") return out;
      if (c !== ",") throw new Error("comma required");
    }
  }
  array() {
    const out = [];
    this.i += 1;
    this.ws();
    if (this.text[this.i] === "]") {
      this.i += 1;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.ws();
      const c = this.text[this.i++];
      if (c === "]") return out;
      if (c !== ",") throw new Error("comma required");
    }
  }
}

export function parseStrictJson(text) {
  if (typeof text !== "string") throw new Error("text required");
  const parser = new StrictParser(text);
  const value = parser.value();
  parser.ws();
  if (parser.i !== text.length) throw new Error(`trailing JSON at ${parser.i}`);
  assertData(value);
  return value;
}

function exactFields(command, required) {
  const keys = Object.keys(command);
  return keys.length === required.length && required.every((key) => Object.hasOwn(command, key));
}

function nonempty(value) {
  return typeof value === "string" && value.length > 0 && scalarString(value);
}

function safeNonnegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safePositive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validData(value) {
  try {
    assertData(value);
    return true;
  } catch {
    return false;
  }
}

function commandShapeCode(command) {
  switch (command.op) {
    case "create":
      if (!exactFields(command, ["op", "at", "work_id", "max_attempts", "retry_base_ms", "retry_jitter"]) || !nonempty(command.work_id)) return "MALFORMED_COMMAND";
      if (!safePositive(command.max_attempts) || !safePositive(command.retry_base_ms) || command.retry_jitter !== false) return "INVALID_RETRY_POLICY";
      return null;
    case "acquire":
      return exactFields(command, ["op", "at", "owner_id", "lease_ms"]) && nonempty(command.owner_id) && safePositive(command.lease_ms) && Number.isSafeInteger(command.at + command.lease_ms)
        ? null : "MALFORMED_COMMAND";
    case "renew":
      return exactFields(command, ["op", "at", "owner_id", "owner_epoch", "lease_ms"]) && nonempty(command.owner_id) && safeNonnegative(command.owner_epoch) && safePositive(command.lease_ms) && Number.isSafeInteger(command.at + command.lease_ms)
        ? null : "MALFORMED_COMMAND";
    case "expire":
      return exactFields(command, ["op", "at"]) ? null : "MALFORMED_COMMAND";
    case "settle":
      return exactFields(command, ["op", "at", "owner_id", "owner_epoch", "outcome", "result", "error"])
        && nonempty(command.owner_id)
        && safeNonnegative(command.owner_epoch)
        && ["success", "failure"].includes(command.outcome)
        && validData(command.result)
        && (command.error === null || scalarString(command.error))
        ? null : "MALFORMED_COMMAND";
    case "settle_with_retry":
      return exactFields(command, ["op", "at", "owner_id", "owner_epoch", "outcome", "error"])
        && nonempty(command.owner_id)
        && safeNonnegative(command.owner_epoch)
        && command.outcome === "failure"
        && (command.error === null || scalarString(command.error))
        ? null : "MALFORMED_COMMAND";
    case "cancel":
      return exactFields(command, ["op", "at", "reason"]) && (command.reason === null || scalarString(command.reason))
        ? null : "MALFORMED_COMMAND";
    default:
      throw new Error("shape requested for unknown operation");
  }
}

function copy(value) {
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

function attempt(work, number, epoch, eligibleAt) {
  return {
    id: `${work.id}:attempt:${number}`,
    number,
    status: "pending",
    owner_id: null,
    owner_epoch: epoch,
    eligible_at: eligibleAt,
    lease_until: null,
    result: null,
    error: null
  };
}

function current(state) {
  return state.attempts.find((item) => item.id === state.work.current_attempt_id) ?? null;
}

function emit(state, kind, item, at) {
  state.events.push({
    id: `${state.work.id}:event:${state.events.length + 1}`,
    seq: state.events.length + 1,
    kind,
    attempt_id: item.id,
    owner_epoch: item.owner_epoch,
    occurred_at: at
  });
}

function retryEligibleAt(state, old, at) {
  const delay = state.work.retry_base_ms * (2 ** (old.number - 1));
  return Number.isSafeInteger(delay) && Number.isSafeInteger(at + delay) ? at + delay : null;
}

function makeRetry(state, old, at, eligibleAt) {
  const next = attempt(state.work, old.number + 1, state.work.owner_epoch + 1, eligibleAt);
  state.attempts.push(next);
  state.work.status = "pending";
  state.work.current_attempt_id = next.id;
  state.work.owner_epoch = next.owner_epoch;
  state.work.result = null;
  state.work.error = null;
  emit(state, "attempt_retried", next, at);
}

function validateState(state) {
  if (state === null) return;
  const active = current(state);
  if (!active) throw new Error("missing current attempt");
  if (state.attempts.length > state.work.max_attempts) throw new Error("attempt cap exceeded");
  state.attempts.forEach((item, index) => {
    if (item.number !== index + 1) throw new Error("non-contiguous attempt number");
  });
  if (state.attempts.filter((item) => item.status === "running").length > 1) throw new Error("multiple running attempts");
  if (state.work.status === "running" && active.status !== "running") throw new Error("running work mismatch");
  if (state.work.status === "pending" && active.status !== "pending") throw new Error("pending work mismatch");
  if (TERMINAL.has(state.work.status) && !TERMINAL.has(active.status)) throw new Error("terminal work mismatch");
  if (state.work.owner_epoch !== active.owner_epoch) throw new Error("current epoch mismatch");
  const epochs = state.attempts.map((item) => item.owner_epoch);
  for (let i = 1; i < epochs.length; i += 1) {
    if (epochs[i] <= epochs[i - 1]) throw new Error("retry epoch not increasing");
  }
  state.events.forEach((event, index) => {
    if (event.seq !== index + 1) throw new Error("event sequence gap");
  });
}

function accepted() {
  return { accepted: true, code: "OK" };
}

function rejected(code) {
  return { accepted: false, code };
}

function apply(state, command) {
  if (!command || typeof command !== "object" || Array.isArray(command) || !nonempty(command.op) || !safeNonnegative(command.at)) {
    return { state, result: rejected("MALFORMED_COMMAND") };
  }
  if (!OPS.has(command.op)) return { state, result: rejected("UNKNOWN_OP") };
  const shapeCode = commandShapeCode(command);
  if (shapeCode !== null) return { state, result: rejected(shapeCode) };

  if (command.op === "create") {
    if (state !== null) return { state, result: rejected("WORK_ALREADY_EXISTS") };
    const work = {
      id: command.work_id,
      status: "pending",
      current_attempt_id: `${command.work_id}:attempt:1`,
      owner_epoch: 0,
      max_attempts: command.max_attempts,
      retry_base_ms: command.retry_base_ms,
      retry_jitter: false,
      result: null,
      error: null
    };
    state = { work, attempts: [attempt(work, 1, 0, command.at)], events: [] };
    emit(state, "attempt_created", state.attempts[0], command.at);
    return { state, result: accepted() };
  }

  if (state === null || TERMINAL.has(state.work.status)) return { state, result: rejected("WORK_TERMINAL_OR_UNKNOWN") };
  const active = current(state);
  if (!active) return { state, result: rejected("WORK_HAS_NO_CURRENT_ATTEMPT") };

  if (command.op === "acquire") {
    if (!exactFields(command, ["op", "at", "owner_id", "lease_ms"]) || !nonempty(command.owner_id) || !safePositive(command.lease_ms) || !Number.isSafeInteger(command.at + command.lease_ms)) {
      return { state, result: rejected("MALFORMED_COMMAND") };
    }
    if (state.work.status !== "pending" || active.status !== "pending" || command.at < active.eligible_at) {
      return { state, result: rejected("WORK_NOT_LEASEABLE") };
    }
    const epoch = Math.max(state.work.owner_epoch, active.owner_epoch) + 1;
    state.work.status = "running";
    state.work.owner_epoch = epoch;
    active.status = "running";
    active.owner_id = command.owner_id;
    active.owner_epoch = epoch;
    active.lease_until = command.at + command.lease_ms;
    emit(state, "lease_acquired", active, command.at);
    return { state, result: accepted() };
  }

  if (command.op === "cancel") {
    if (!exactFields(command, ["op", "at", "reason"]) || !(command.reason === null || typeof command.reason === "string")) {
      return { state, result: rejected("MALFORMED_COMMAND") };
    }
    state.work.status = "cancelled";
    state.work.result = null;
    state.work.error = command.reason;
    active.status = "cancelled";
    active.result = null;
    active.error = command.reason;
    emit(state, "attempt_cancelled", active, command.at);
    return { state, result: accepted() };
  }

  if (command.op === "expire") {
    if (!exactFields(command, ["op", "at"])) return { state, result: rejected("MALFORMED_COMMAND") };
    if (state.work.status !== "running" || active.status !== "running" || active.lease_until === null || command.at < active.lease_until) {
      return { state, result: rejected("ATTEMPT_NOT_EXPIRED") };
    }
    const eligibleAt = active.number < state.work.max_attempts ? retryEligibleAt(state, active, command.at) : null;
    if (active.number < state.work.max_attempts && eligibleAt === null) {
      return { state, result: rejected("RETRY_TIME_OVERFLOW") };
    }
    active.status = "expired";
    emit(state, "lease_expired", active, command.at);
    if (active.number >= state.work.max_attempts) {
      const message = "lease expired after final allowed attempt";
      active.status = "failed";
      active.error = message;
      state.work.status = "failed";
      state.work.error = message;
      emit(state, "attempt_failed", active, command.at);
    } else {
      makeRetry(state, active, command.at, eligibleAt);
    }
    return { state, result: accepted() };
  }

  if (command.op === "renew") {
    if (!exactFields(command, ["op", "at", "owner_id", "owner_epoch", "lease_ms"]) || !nonempty(command.owner_id) || !safeNonnegative(command.owner_epoch) || !safePositive(command.lease_ms) || !Number.isSafeInteger(command.at + command.lease_ms)) {
      return { state, result: rejected("MALFORMED_COMMAND") };
    }
    if (state.work.status !== "running" || active.status !== "running" || active.owner_id !== command.owner_id || active.owner_epoch !== command.owner_epoch || active.lease_until === null || command.at >= active.lease_until) {
      return { state, result: rejected("STALE_OR_TERMINAL_LEASE") };
    }
    active.lease_until = command.at + command.lease_ms;
    emit(state, "lease_acquired", active, command.at);
    return { state, result: accepted() };
  }

  const commonFields = command.op === "settle"
    ? ["op", "at", "owner_id", "owner_epoch", "outcome", "result", "error"]
    : ["op", "at", "owner_id", "owner_epoch", "outcome", "error"];
  if (!exactFields(command, commonFields) || !nonempty(command.owner_id) || !safeNonnegative(command.owner_epoch)) {
    return { state, result: rejected("MALFORMED_COMMAND") };
  }
  if (command.op === "settle" && !["success", "failure"].includes(command.outcome)) {
    return { state, result: rejected("MALFORMED_COMMAND") };
  }
  if (command.op === "settle_with_retry" && command.outcome !== "failure") {
    return { state, result: rejected("MALFORMED_COMMAND") };
  }
  if (!(command.error === null || typeof command.error === "string")) {
    return { state, result: rejected("MALFORMED_COMMAND") };
  }
  if (state.work.status !== "running" || active.status !== "running" || active.owner_id !== command.owner_id || active.owner_epoch !== command.owner_epoch || active.lease_until === null || command.at >= active.lease_until) {
    return { state, result: rejected("STALE_OR_TERMINAL_LEASE") };
  }
  const eligibleAt = command.op === "settle_with_retry" && active.number < state.work.max_attempts
    ? retryEligibleAt(state, active, command.at)
    : null;
  if (command.op === "settle_with_retry" && active.number < state.work.max_attempts && eligibleAt === null) {
    return { state, result: rejected("RETRY_TIME_OVERFLOW") };
  }
  if (command.op === "settle" && command.outcome === "success") {
    active.status = "succeeded";
    active.result = copy(command.result);
    active.error = null;
    state.work.status = "succeeded";
    state.work.result = copy(command.result);
    state.work.error = null;
    emit(state, "attempt_succeeded", active, command.at);
    return { state, result: accepted() };
  }
  active.status = "failed";
  active.result = null;
  active.error = command.error;
  emit(state, "attempt_failed", active, command.at);
  if (command.op === "settle_with_retry" && active.number < state.work.max_attempts) {
    makeRetry(state, active, command.at, eligibleAt);
  } else {
    state.work.status = "failed";
    state.work.result = null;
    state.work.error = command.error;
  }
  return { state, result: accepted() };
}

function finish(body) {
  return { ...body, receipt_sha256: sha256(body) };
}

export function evaluateLifecycleTrace(trace) {
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
  let state = null;
  let lastAt = -1;
  const steps = [];
  for (let index = 0; index < trace.commands.length; index += 1) {
    const command = trace.commands[index];
    const before = sha256(state);
    let applied;
    if (command && typeof command === "object" && !Array.isArray(command) && safeNonnegative(command.at) && command.at < lastAt) {
      applied = { state, result: rejected("MALFORMED_COMMAND") };
    } else {
      if (command && typeof command === "object" && safeNonnegative(command.at)) lastAt = command.at;
      applied = apply(state, command);
    }
    state = applied.state;
    validateState(state);
    const after = sha256(state);
    if (!applied.result.accepted && before !== after) throw new Error("rejected command mutated state");
    steps.push({
      index,
      op: command && typeof command.op === "string" ? command.op : null,
      accepted: applied.result.accepted,
      code: applied.result.code,
      state_sha256: after
    });
  }
  return finish({ profile: PROFILE, case_id: caseId, top_code: "OK", steps, final: copy(state) });
}

export function projectReceipt(receipt) {
  const state = receipt.final;
  return {
    top_code: receipt.top_code,
    step_codes: receipt.steps.map((step) => step.code),
    work: state === null ? null : {
      status: state.work.status,
      current_attempt_number: current(state).number,
      owner_epoch: state.work.owner_epoch,
      result: state.work.result,
      error: state.work.error
    },
    attempts: state === null ? [] : state.attempts.map((item) => ({
      number: item.number,
      status: item.status,
      owner_id: item.owner_id,
      owner_epoch: item.owner_epoch,
      eligible_at: item.eligible_at,
      lease_until: item.lease_until,
      result: item.result,
      error: item.error
    })),
    event_kinds: state === null ? [] : state.events.map((event) => event.kind)
  };
}
