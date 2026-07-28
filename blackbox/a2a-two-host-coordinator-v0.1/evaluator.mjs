import { createHash } from "node:crypto";

export const PROFILE = "meshfleet.a2a.two-host-coordinator.v0.1";
export const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const MAX_BYTES = 131072;
const MAX_DEPTH = 64;
const MAX_COMMANDS = 128;
const HOSTS = ["host-a", "host-b"];
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const TOKEN_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class ProfileError extends Error {
  constructor(code, path = "$") {
    super(`${code} at ${path}`);
    this.name = "ProfileError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, path = "$") {
  throw new ProfileError(code, path);
}

function scalarString(value) {
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

function scanStrictJson(raw) {
  let i = 0;
  const malformed = () => fail("MALFORMED_JSON");
  const whitespace = () => {
    while (i < raw.length && (raw[i] === " " || raw[i] === "\t" || raw[i] === "\n" || raw[i] === "\r")) i += 1;
  };
  const stringToken = () => {
    const start = i;
    if (raw[i] !== "\"") malformed();
    i += 1;
    while (i < raw.length) {
      const code = raw.charCodeAt(i);
      if (raw[i] === "\"") {
        i += 1;
        let decoded;
        try {
          decoded = JSON.parse(raw.slice(start, i));
        } catch {
          malformed();
        }
        return decoded;
      }
      if (code < 0x20) malformed();
      if (raw[i] === "\\") {
        i += 1;
        if (i >= raw.length) malformed();
        if (raw[i] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(raw.slice(i + 1, i + 5))) malformed();
          i += 5;
          continue;
        }
        if (!"\"\\/bfnrt".includes(raw[i])) malformed();
      }
      i += 1;
    }
    malformed();
  };
  const numberToken = () => {
    const match = raw.slice(i).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!match) malformed();
    const token = match[0];
    i += token.length;
    if (token.includes(".") || token.includes("e") || token.includes("E") || token === "-0") {
      fail("NON_CANONICAL_INTEGER");
    }
    const value = Number(token);
    if (!Number.isSafeInteger(value)) fail("UNSAFE_INTEGER");
  };
  const value = (depth) => {
    whitespace();
    if (raw[i] === "\"") {
      stringToken();
      return;
    }
    if (raw[i] === "{") {
      i += 1;
      whitespace();
      const keys = [];
      const rejectDuplicateKeys = () => {
        const seen = new Set();
        for (const key of keys) {
          if (seen.has(key)) fail("DUPLICATE_MEMBER");
          seen.add(key);
        }
      };
      if (raw[i] === "}") {
        i += 1;
        return;
      }
      while (true) {
        const key = stringToken();
        keys.push(key);
        whitespace();
        if (raw[i] !== ":") malformed();
        i += 1;
        value(depth + 1);
        whitespace();
        if (raw[i] === "}") {
          i += 1;
          rejectDuplicateKeys();
          return;
        }
        if (raw[i] !== ",") malformed();
        i += 1;
        whitespace();
      }
    }
    if (raw[i] === "[") {
      i += 1;
      whitespace();
      if (raw[i] === "]") {
        i += 1;
        return;
      }
      while (true) {
        value(depth + 1);
        whitespace();
        if (raw[i] === "]") {
          i += 1;
          return;
        }
        if (raw[i] !== ",") malformed();
        i += 1;
      }
    }
    if (raw.startsWith("true", i)) {
      i += 4;
      return;
    }
    if (raw.startsWith("false", i)) {
      i += 5;
      return;
    }
    if (raw.startsWith("null", i)) {
      i += 4;
      return;
    }
    numberToken();
  };
  whitespace();
  if (i === raw.length) malformed();
  value(1);
  whitespace();
  if (i !== raw.length) malformed();
}

function validateParsedJson(value, depth = 1) {
  if (depth > MAX_DEPTH) fail("DEPTH_LIMIT");
  if (typeof value === "string") {
    if (!scalarString(value)) fail("MALFORMED_JSON");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateParsedJson(item, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (!scalarString(key)) fail("MALFORMED_JSON");
      validateParsedJson(item, depth + 1);
    }
  }
}

function strictParseText(raw) {
  scanStrictJson(raw);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("MALFORMED_JSON");
  }
  validateParsedJson(parsed);
  return parsed;
}

export function strictParseBytes(rawBytes) {
  if (!(rawBytes instanceof Uint8Array)) fail("INVALID_SCENARIO");
  if (rawBytes.byteLength > MAX_BYTES) fail("INVALID_SCENARIO");
  let raw;
  try {
    raw = UTF8_DECODER.decode(rawBytes);
  } catch {
    fail("INVALID_UTF8");
  }
  return strictParseText(raw);
}

export function strictParse(raw) {
  if (typeof raw !== "string") fail("INVALID_SCENARIO");
  if (!scalarString(raw)) fail("INVALID_UTF8");
  return strictParseBytes(Buffer.from(raw, "utf8"));
}

function codePointCompare(a, b) {
  const aa = Array.from(a, (character) => character.codePointAt(0));
  const bb = Array.from(b, (character) => character.codePointAt(0));
  const length = Math.min(aa.length, bb.length);
  for (let i = 0; i < length; i += 1) {
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  }
  return aa.length - bb.length;
}

export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail("UNSAFE_INTEGER");
    return String(value);
  }
  if (typeof value === "string") {
    if (!scalarString(value)) fail("INVALID_SCENARIO");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort(codePointCompare).map((key) => `${canonicalJson(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("INVALID_SCENARIO");
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value), "utf8").digest("hex");
}

function exactKeys(object, required, path) {
  if (!object || typeof object !== "object" || Array.isArray(object) || Object.getPrototypeOf(object) !== Object.prototype) {
    fail("INVALID_FIELD", path);
  }
  const requiredSet = new Set(required);
  for (const key of Object.keys(object)) {
    if (!requiredSet.has(key)) fail("UNKNOWN_FIELD", `${path}.${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) fail("MISSING_FIELD", `${path}.${key}`);
  }
}

function token(value, path) {
  if (typeof value !== "string" || !TOKEN_RE.test(value)) fail("INVALID_FIELD", path);
}

function nonnegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail("INVALID_FIELD", path);
}

function positiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value <= 0) fail("INVALID_FIELD", path);
}

function validateScenario(input) {
  exactKeys(input, ["profile", "scenario_id", "work_id", "commands"], "$");
  if (input.profile !== PROFILE) fail("INVALID_SCENARIO", "$.profile");
  token(input.scenario_id, "$.scenario_id");
  token(input.work_id, "$.work_id");
  if (!Array.isArray(input.commands) || input.commands.length < 1 || input.commands.length > MAX_COMMANDS) {
    fail("INVALID_FIELD", "$.commands");
  }
  let previousAt = -1;
  const schemas = {
    create_work: ["op", "at", "max_attempts", "retry_base_ms"],
    acquire_lease: ["op", "at", "host", "lease_ms"],
    renew_lease: ["op", "at", "host", "lease_ms"],
    settle: ["op", "at", "host", "outcome"],
    cancel: ["op", "at", "host"],
    recover_expired: ["op", "at", "host"],
    partition: ["op", "at", "host"],
    heal: ["op", "at", "host"],
    replay_check: ["op", "at"]
  };
  input.commands.forEach((command, index) => {
    const path = `$.commands[${index}]`;
    if (!command || typeof command !== "object" || Array.isArray(command)) fail("INVALID_FIELD", path);
    if (typeof command.op !== "string" || !Object.hasOwn(schemas, command.op)) fail("UNKNOWN_OP", `${path}.op`);
    exactKeys(command, schemas[command.op], path);
    nonnegativeInteger(command.at, `${path}.at`);
    if (command.at < previousAt) fail("NON_MONOTONIC_TIME", `${path}.at`);
    previousAt = command.at;
    if (Object.hasOwn(command, "host") && !HOSTS.includes(command.host)) fail("UNKNOWN_HOST", `${path}.host`);
    if (Object.hasOwn(command, "lease_ms")) positiveInteger(command.lease_ms, `${path}.lease_ms`);
    if (command.op === "create_work") {
      if (!Number.isSafeInteger(command.max_attempts) || command.max_attempts < 1 || command.max_attempts > 32) {
        fail("INVALID_FIELD", `${path}.max_attempts`);
      }
      nonnegativeInteger(command.retry_base_ms, `${path}.retry_base_ms`);
    }
    if (command.op === "settle" && command.outcome !== "success" && command.outcome !== "failure") {
      fail("INVALID_FIELD", `${path}.outcome`);
    }
  });
  return input;
}

function initialHosts() {
  return HOSTS.map((host_id) => ({ host_id, reachable: true, token: null }));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stateView(authority, hosts, events) {
  return { authority, events, hosts };
}

function retryEligibleAt(at, retryBaseMs, failedAttemptNumber) {
  let delay = retryBaseMs;
  for (let i = 1; i < failedAttemptNumber; i += 1) {
    if (delay > Math.floor(SAFE_MAX / 2)) return null;
    delay *= 2;
  }
  if (!Number.isSafeInteger(delay) || at > SAFE_MAX - delay) return null;
  return at + delay;
}

function findAttempt(authority, attemptId) {
  return authority.attempts.find((attempt) => attempt.attempt_id === attemptId);
}

function replayAuthority(events) {
  let authority = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.seq !== index + 1 || event.event_id !== `event-${index + 1}`) return null;
    const data = event.data;
    if (event.kind === "attempt_created") {
      if (authority !== null) return null;
      authority = {
        work: {
          work_id: event.work_id,
          status: "pending",
          current_attempt_id: event.attempt_id,
          owner_epoch: 0,
          max_attempts: data.max_attempts,
          retry_base_ms: data.retry_base_ms,
          terminal_at: null
        },
        attempts: [clone(data.attempt)]
      };
      continue;
    }
    if (authority === null) return null;
    const attempt = findAttempt(authority, event.attempt_id);
    if (event.kind === "lease_acquired") {
      if (!attempt) return null;
      authority.work.status = "running";
      authority.work.current_attempt_id = event.attempt_id;
      authority.work.owner_epoch = event.owner_epoch;
      attempt.status = "running";
      attempt.owner_id = data.owner_id;
      attempt.owner_epoch = event.owner_epoch;
      attempt.lease_until = data.lease_until;
    } else if (event.kind === "attempt_succeeded") {
      if (!attempt) return null;
      attempt.status = "succeeded";
      attempt.terminal_at = event.at;
      authority.work.status = "succeeded";
      authority.work.terminal_at = event.at;
    } else if (event.kind === "attempt_failed") {
      if (!attempt) return null;
      attempt.status = "failed";
      attempt.terminal_at = event.at;
      if (data.work_terminal) {
        authority.work.status = "failed";
        authority.work.terminal_at = event.at;
      }
    } else if (event.kind === "lease_expired") {
      if (!attempt) return null;
      attempt.status = "expired";
      attempt.terminal_at = event.at;
      if (data.work_terminal) {
        authority.work.status = "failed";
        authority.work.terminal_at = event.at;
      }
    } else if (event.kind === "attempt_retried") {
      authority.work.status = "pending";
      authority.work.current_attempt_id = data.attempt.attempt_id;
      authority.work.owner_epoch = event.owner_epoch;
      authority.attempts.push(clone(data.attempt));
    } else if (event.kind === "attempt_cancelled") {
      if (!attempt) return null;
      attempt.status = "cancelled";
      attempt.terminal_at = event.at;
      authority.work.status = "cancelled";
      authority.work.terminal_at = event.at;
    } else {
      return null;
    }
  }
  return authority;
}

function evaluateParsedScenario(input) {
  let authority = null;
  const hosts = initialHosts();
  const events = [];
  const commandResults = [];
  let replayMatch = null;

  const host = (id) => hosts.find((entry) => entry.host_id === id);
  const emit = (kind, command, attemptId, ownerEpoch, data = {}) => {
    const seq = events.length + 1;
    events.push({
      at: command.at,
      data,
      event_id: `event-${seq}`,
      kind,
      owner_epoch: ownerEpoch,
      seq,
      work_id: input.work_id,
      attempt_id: attemptId
    });
  };
  const record = (index, command, accepted, error = null) => {
    commandResults.push({
      accepted,
      at: command.at,
      error,
      index,
      op: command.op,
      state_sha256: sha256(stateView(authority, hosts, events))
    });
  };
  const reject = (index, command, error) => record(index, command, false, error);
  const connected = (index, command) => {
    if (!host(command.host).reachable) {
      reject(index, command, "HOST_PARTITIONED");
      return false;
    }
    return true;
  };
  const existing = (index, command) => {
    if (authority === null) {
      reject(index, command, "WORK_NOT_FOUND");
      return false;
    }
    return true;
  };
  const nonterminal = (index, command) => {
    if (TERMINAL.has(authority.work.status)) {
      reject(index, command, "WORK_TERMINAL");
      return false;
    }
    return true;
  };
  const fencedAttempt = (index, command) => {
    const cached = host(command.host).token;
    if (cached === null) {
      reject(index, command, "NO_LOCAL_TOKEN");
      return null;
    }
    const attempt = findAttempt(authority, authority.work.current_attempt_id);
    if (
      !attempt ||
      authority.work.status !== "running" ||
      attempt.status !== "running" ||
      cached.attempt_id !== attempt.attempt_id ||
      cached.host_id !== attempt.owner_id ||
      cached.owner_epoch !== attempt.owner_epoch ||
      cached.owner_epoch !== authority.work.owner_epoch ||
      command.host !== attempt.owner_id
    ) {
      reject(index, command, "STALE_FENCE");
      return null;
    }
    if (command.at >= attempt.lease_until) {
      reject(index, command, "LEASE_EXPIRED");
      return null;
    }
    return attempt;
  };
  const createRetry = (command, failedAttempt, eligibleAt) => {
    authority.work.owner_epoch += 1;
    const attemptNumber = failedAttempt.attempt_number + 1;
    const attempt = {
      attempt_id: `attempt-${attemptNumber}`,
      attempt_number: attemptNumber,
      status: "pending",
      owner_id: null,
      owner_epoch: authority.work.owner_epoch,
      lease_until: null,
      eligible_at: eligibleAt,
      terminal_at: null
    };
    authority.work.status = "pending";
    authority.work.current_attempt_id = attempt.attempt_id;
    authority.attempts.push(attempt);
    emit("attempt_retried", command, attempt.attempt_id, authority.work.owner_epoch, { attempt: clone(attempt) });
  };

  input.commands.forEach((command, index) => {
    if (command.op === "partition" || command.op === "heal") {
      host(command.host).reachable = command.op === "heal";
      record(index, command, true);
      return;
    }
    if (command.op === "replay_check") {
      replayMatch = canonicalJson(replayAuthority(events)) === canonicalJson(authority);
      record(index, command, true);
      return;
    }
    if (command.op === "create_work") {
      if (authority !== null) {
        reject(index, command, "WORK_ALREADY_EXISTS");
        return;
      }
      const attempt = {
        attempt_id: "attempt-1",
        attempt_number: 1,
        status: "pending",
        owner_id: null,
        owner_epoch: 0,
        lease_until: null,
        eligible_at: command.at,
        terminal_at: null
      };
      authority = {
        work: {
          work_id: input.work_id,
          status: "pending",
          current_attempt_id: attempt.attempt_id,
          owner_epoch: 0,
          max_attempts: command.max_attempts,
          retry_base_ms: command.retry_base_ms,
          terminal_at: null
        },
        attempts: [attempt]
      };
      emit("attempt_created", command, attempt.attempt_id, 0, {
        attempt: clone(attempt),
        max_attempts: command.max_attempts,
        retry_base_ms: command.retry_base_ms
      });
      record(index, command, true);
      return;
    }
    if (!connected(index, command) || !existing(index, command) || !nonterminal(index, command)) return;

    if (command.op === "acquire_lease") {
      const attempt = findAttempt(authority, authority.work.current_attempt_id);
      if (authority.work.status !== "pending" || !attempt || attempt.status !== "pending") {
        reject(index, command, "NOT_LEASEABLE");
        return;
      }
      if (command.at < attempt.eligible_at) {
        reject(index, command, "NOT_ELIGIBLE");
        return;
      }
      if (command.at > SAFE_MAX - command.lease_ms) {
        reject(index, command, "TIME_OVERFLOW");
        return;
      }
      authority.work.owner_epoch += 1;
      authority.work.status = "running";
      attempt.status = "running";
      attempt.owner_id = command.host;
      attempt.owner_epoch = authority.work.owner_epoch;
      attempt.lease_until = command.at + command.lease_ms;
      const cached = {
        attempt_id: attempt.attempt_id,
        host_id: command.host,
        lease_until: attempt.lease_until,
        owner_epoch: attempt.owner_epoch
      };
      host(command.host).token = cached;
      emit("lease_acquired", command, attempt.attempt_id, attempt.owner_epoch, {
        lease_until: attempt.lease_until,
        owner_id: command.host,
        renewal: false
      });
      record(index, command, true);
      return;
    }

    if (command.op === "cancel") {
      const attempt = findAttempt(authority, authority.work.current_attempt_id);
      attempt.status = "cancelled";
      attempt.terminal_at = command.at;
      authority.work.status = "cancelled";
      authority.work.terminal_at = command.at;
      emit("attempt_cancelled", command, attempt.attempt_id, authority.work.owner_epoch);
      record(index, command, true);
      return;
    }

    if (command.op === "recover_expired") {
      const attempt = findAttempt(authority, authority.work.current_attempt_id);
      if (authority.work.status !== "running" || !attempt || attempt.status !== "running") {
        reject(index, command, "NOT_RUNNING");
        return;
      }
      if (command.at < attempt.lease_until) {
        reject(index, command, "NOT_EXPIRED");
        return;
      }
      let eligibleAt = null;
      if (attempt.attempt_number < authority.work.max_attempts) {
        eligibleAt = retryEligibleAt(command.at, authority.work.retry_base_ms, attempt.attempt_number);
        if (eligibleAt === null) {
          reject(index, command, "RETRY_TIME_OVERFLOW");
          return;
        }
      }
      attempt.status = "expired";
      attempt.terminal_at = command.at;
      const terminal = attempt.attempt_number >= authority.work.max_attempts;
      if (terminal) {
        authority.work.status = "failed";
        authority.work.terminal_at = command.at;
      }
      emit("lease_expired", command, attempt.attempt_id, attempt.owner_epoch, { work_terminal: terminal });
      if (!terminal) createRetry(command, attempt, eligibleAt);
      record(index, command, true);
      return;
    }

    const attempt = fencedAttempt(index, command);
    if (!attempt) return;

    if (command.op === "renew_lease") {
      if (command.at > SAFE_MAX - command.lease_ms) {
        reject(index, command, "TIME_OVERFLOW");
        return;
      }
      attempt.lease_until = command.at + command.lease_ms;
      host(command.host).token.lease_until = attempt.lease_until;
      emit("lease_acquired", command, attempt.attempt_id, attempt.owner_epoch, {
        lease_until: attempt.lease_until,
        owner_id: command.host,
        renewal: true
      });
      record(index, command, true);
      return;
    }

    if (command.outcome === "success") {
      attempt.status = "succeeded";
      attempt.terminal_at = command.at;
      authority.work.status = "succeeded";
      authority.work.terminal_at = command.at;
      emit("attempt_succeeded", command, attempt.attempt_id, attempt.owner_epoch);
      record(index, command, true);
      return;
    }

    let eligibleAt = null;
    if (attempt.attempt_number < authority.work.max_attempts) {
      eligibleAt = retryEligibleAt(command.at, authority.work.retry_base_ms, attempt.attempt_number);
      if (eligibleAt === null) {
        reject(index, command, "RETRY_TIME_OVERFLOW");
        return;
      }
    }
    attempt.status = "failed";
    attempt.terminal_at = command.at;
    const terminal = attempt.attempt_number >= authority.work.max_attempts;
    if (terminal) {
      authority.work.status = "failed";
      authority.work.terminal_at = command.at;
    }
    emit("attempt_failed", command, attempt.attempt_id, attempt.owner_epoch, { work_terminal: terminal });
    if (!terminal) createRetry(command, attempt, eligibleAt);
    record(index, command, true);
  });

  return {
    profile: PROFILE,
    scenario_id: input.scenario_id,
    work_id: input.work_id,
    authority,
    hosts,
    events,
    command_results: commandResults,
    replay_match: replayMatch
  };
}

export function evaluateTwoHostScenario(raw) {
  return evaluateParsedScenario(validateScenario(strictParse(raw)));
}

export function evaluateTwoHostScenarioBytes(rawBytes) {
  return evaluateParsedScenario(validateScenario(strictParseBytes(rawBytes)));
}

export function projectResult(result) {
  const attempts = result.authority?.attempts ?? [];
  return {
    work_status: result.authority?.work.status ?? null,
    current_attempt_id: result.authority?.work.current_attempt_id ?? null,
    owner_epoch: result.authority?.work.owner_epoch ?? null,
    attempt_statuses: attempts.map((attempt) => attempt.status),
    attempt_epochs: attempts.map((attempt) => attempt.owner_epoch),
    attempt_lease_until: attempts.map((attempt) => attempt.lease_until),
    attempt_eligible_at: attempts.map((attempt) => attempt.eligible_at),
    host_token_epochs: result.hosts.map((host) => host.token?.owner_epoch ?? null),
    event_kinds: result.events.map((event) => event.kind),
    command_errors: result.command_results.map((entry) => entry.error),
    replay_match: result.replay_match
  };
}
