import { createHash } from "node:crypto";

export const PROFILE = "meshfleet.a2a.policy-replay.v0.1";
export const LIMITS = Object.freeze({
  maxBytes: 131072,
  maxDepth: 64,
  maxActions: 128,
  maxRules: 128,
  maxCapabilities: 64,
  maxLabelBytes: 256,
  maxSafeInteger: 9007199254740991,
});

export class ConformanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConformanceError";
    this.code = code;
  }
}

function reject(code, message) {
  throw new ConformanceError(code, message);
}

export function scalarCompare(left, right) {
  const a = Array.from(left, (character) => character.codePointAt(0));
  const b = Array.from(right, (character) => character.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length - b.length;
}

function validScalarString(value) {
  if (typeof value !== "string") return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalValue(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) reject("UNSAFE_INTEGER", "canonical value contains unsafe integer");
    return String(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "string") {
    if (!validScalarString(value)) reject("INVALID_UNICODE", "canonical value contains invalid Unicode");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort(scalarCompare);
    return `{${keys.map((key) => `${canonicalValue(key)}:${canonicalValue(value[key])}`).join(",")}}`;
  }
  reject("INVALID_SCENARIO", "unsupported canonical value");
}

export function canonical(value) {
  return canonicalValue(value);
}

export function digest(value) {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

class StrictParser {
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  whitespace() {
    while (true) {
      const character = this.text[this.index];
      if (character !== " " && character !== "\n" && character !== "\r" && character !== "\t") return;
      this.index += 1;
    }
  }

  value(depth) {
    if (depth > LIMITS.maxDepth) reject("DEPTH_LIMIT", "JSON nesting is too deep");
    this.whitespace();
    const character = this.text[this.index];
    if (character === "{") return this.object(depth);
    if (character === "[") return this.array(depth);
    if (character === '"') return this.string();
    if (character === "-" || (character >= "0" && character <= "9")) return this.number();
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
      if (this.text.startsWith(literal, this.index)) {
        this.index += literal.length;
        return value;
      }
    }
    reject("MALFORMED_JSON", `unexpected token at ${this.index}`);
  }

  object(depth) {
    const output = {};
    const seen = new Set();
    this.index += 1;
    this.whitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return output;
    }
    while (true) {
      this.whitespace();
      if (this.text[this.index] !== '"') reject("MALFORMED_JSON", "object key must be a string");
      const key = this.string();
      if (seen.has(key)) reject("DUPLICATE_MEMBER", `duplicate object member ${key}`);
      seen.add(key);
      this.whitespace();
      if (this.text[this.index] !== ":") reject("MALFORMED_JSON", "missing object colon");
      this.index += 1;
      output[key] = this.value(depth + 1);
      this.whitespace();
      const separator = this.text[this.index];
      if (separator === "}") {
        this.index += 1;
        return output;
      }
      if (separator !== ",") reject("MALFORMED_JSON", "missing object separator");
      this.index += 1;
    }
  }

  array(depth) {
    const output = [];
    this.index += 1;
    this.whitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return output;
    }
    while (true) {
      output.push(this.value(depth + 1));
      this.whitespace();
      const separator = this.text[this.index];
      if (separator === "]") {
        this.index += 1;
        return output;
      }
      if (separator !== ",") reject("MALFORMED_JSON", "missing array separator");
      this.index += 1;
    }
  }

  string() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        let value;
        try {
          value = JSON.parse(this.text.slice(start, this.index));
        } catch {
          reject("MALFORMED_JSON", "invalid JSON string");
        }
        if (!validScalarString(value)) reject("INVALID_UNICODE", "string contains lone surrogate");
        return value;
      }
      if (code < 0x20) reject("MALFORMED_JSON", "unescaped control character");
      if (code === 0x5c) {
        this.index += 1;
        const escape = this.text[this.index];
        if (!'"\\/bfnrtu'.includes(escape ?? "")) reject("MALFORMED_JSON", "invalid string escape");
        if (escape === "u") {
          const digits = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) reject("MALFORMED_JSON", "invalid Unicode escape");
          this.index += 4;
        }
      }
      this.index += 1;
    }
    reject("MALFORMED_JSON", "unterminated string");
  }

  number() {
    const start = this.index;
    if (this.text[this.index] === "-") this.index += 1;
    if (this.text[this.index] === "0") {
      this.index += 1;
    } else {
      if (!/[1-9]/.test(this.text[this.index] ?? "")) reject("MALFORMED_JSON", "invalid number");
      while (/[0-9]/.test(this.text[this.index] ?? "")) this.index += 1;
    }
    const marker = this.text[this.index];
    if (marker === "." || marker === "e" || marker === "E") reject("NON_CANONICAL_INTEGER", "non-integer JSON number");
    const suffix = this.text[this.index];
    if (suffix !== undefined && !",]} \n\r\t".includes(suffix)) reject("MALFORMED_JSON", "invalid number suffix");
    const token = this.text.slice(start, this.index);
    if (token === "-0") reject("NON_CANONICAL_INTEGER", "negative zero is not canonical");
    const value = Number(token);
    if (!Number.isSafeInteger(value)) reject("UNSAFE_INTEGER", "integer exceeds safe range");
    return value;
  }
}

export function parseStrictJson(raw) {
  const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
  if (bytes.length > LIMITS.maxBytes) reject("SIZE_LIMIT", "input exceeds byte limit");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    reject("INVALID_UTF8", "input is not valid UTF-8");
  }
  const parser = new StrictParser(text);
  const output = parser.value(1);
  parser.whitespace();
  if (parser.index !== text.length) reject("MALFORMED_JSON", "trailing content");
  return output;
}

function object(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("INVALID_FIELD", `${context} must be an object`);
}

function exactFields(value, required, optional, context) {
  object(value, context);
  const allowed = new Set([...required, ...optional]);
  for (const field of required) {
    if (!Object.hasOwn(value, field)) reject("MISSING_FIELD", `${context}.${field} is required`);
  }
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) reject("UNKNOWN_FIELD", `${context}.${field} is unknown`);
  }
}

function label(value, context, { wildcard = false } = {}) {
  if (typeof value !== "string" || value.length === 0 || !validScalarString(value)) reject("INVALID_FIELD", `${context} must be a non-empty scalar string`);
  if (Buffer.byteLength(value, "utf8") > LIMITS.maxLabelBytes) reject("LIMIT_EXCEEDED", `${context} is too long`);
  if (!wildcard && value === "*") reject("INVALID_FIELD", `${context} cannot be wildcard`);
}

function safeNonnegative(value, context) {
  if (!Number.isSafeInteger(value)) reject("INVALID_FIELD", `${context} must be a safe integer`);
  if (value < 0) reject("INVALID_FIELD", `${context} must be nonnegative`);
}

function capabilities(value, context) {
  if (!Array.isArray(value)) reject("INVALID_FIELD", `${context} must be an array`);
  if (value.length > LIMITS.maxCapabilities) reject("LIMIT_EXCEEDED", `${context} is too large`);
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    label(value[index], `${context}[${index}]`);
    if (seen.has(value[index])) reject("DUPLICATE_CAPABILITY", `${context} contains duplicate labels`);
    seen.add(value[index]);
  }
}

export function validateScenario(scenario) {
  exactFields(scenario, ["profile", "case_id", "policy", "actions"], [], "scenario");
  if (scenario.profile !== PROFILE) reject("PROFILE_REJECT", "unsupported profile");
  label(scenario.case_id, "scenario.case_id");
  exactFields(scenario.policy, ["namespace", "snapshot_id", "revocation_epoch", "rules"], [], "policy");
  label(scenario.policy.namespace, "policy.namespace");
  label(scenario.policy.snapshot_id, "policy.snapshot_id");
  safeNonnegative(scenario.policy.revocation_epoch, "policy.revocation_epoch");
  if (!Array.isArray(scenario.policy.rules)) reject("INVALID_FIELD", "policy.rules must be an array");
  if (scenario.policy.rules.length > LIMITS.maxRules) reject("LIMIT_EXCEEDED", "too many policy rules");
  const ruleIds = new Set();
  scenario.policy.rules.forEach((rule, index) => {
    const context = `policy.rules[${index}]`;
    exactFields(rule, ["rule_id", "effect", "principal", "resource", "action", "required_capabilities", "not_before", "expires_at"], [], context);
    label(rule.rule_id, `${context}.rule_id`);
    if (ruleIds.has(rule.rule_id)) reject("DUPLICATE_RULE", `duplicate rule ${rule.rule_id}`);
    ruleIds.add(rule.rule_id);
    if (!["allow", "deny"].includes(rule.effect)) reject("INVALID_FIELD", `${context}.effect is invalid`);
    label(rule.principal, `${context}.principal`, { wildcard: true });
    label(rule.resource, `${context}.resource`, { wildcard: true });
    label(rule.action, `${context}.action`, { wildcard: true });
    capabilities(rule.required_capabilities, `${context}.required_capabilities`);
    for (const field of ["not_before", "expires_at"]) {
      if (rule[field] !== null) safeNonnegative(rule[field], `${context}.${field}`);
    }
    if (rule.not_before !== null && rule.expires_at !== null && rule.expires_at <= rule.not_before) {
      reject("INVALID_FIELD", `${context} has an empty or inverted time window`);
    }
  });
  if (!Array.isArray(scenario.actions)) reject("INVALID_FIELD", "scenario.actions must be an array");
  if (scenario.actions.length > LIMITS.maxActions) reject("LIMIT_EXCEEDED", "too many actions");
  scenario.actions.forEach((action, index) => {
    const context = `actions[${index}]`;
    exactFields(action, ["request_id", "nonce", "namespace", "principal", "resource", "action", "capabilities", "policy_epoch", "at"], [], context);
    for (const field of ["request_id", "nonce", "namespace", "principal", "resource", "action"]) label(action[field], `${context}.${field}`);
    capabilities(action.capabilities, `${context}.capabilities`);
    safeNonnegative(action.policy_epoch, `${context}.policy_epoch`);
    safeNonnegative(action.at, `${context}.at`);
  });
  return scenario;
}

function selectorMatches(selector, value) {
  return selector === "*" || selector === value;
}

function includesAll(actual, required) {
  const available = new Set(actual);
  return required.every((item) => available.has(item));
}

function lowestRule(rules) {
  if (rules.length === 0) return null;
  return [...rules].sort((left, right) => scalarCompare(left.rule_id, right.rule_id))[0].rule_id;
}

function decide(policy, action) {
  if (action.policy_epoch < policy.revocation_epoch) {
    return { decision: "deny", reason: "REVOCATION_EPOCH_STALE", matched_rule_id: null };
  }
  if (action.namespace !== policy.namespace) {
    return { decision: "deny", reason: "NAMESPACE_MISMATCH", matched_rule_id: null };
  }
  const scoped = policy.rules.filter((rule) =>
    selectorMatches(rule.principal, action.principal)
    && selectorMatches(rule.resource, action.resource)
    && selectorMatches(rule.action, action.action));
  const capabilityMatched = scoped.filter((rule) => includesAll(action.capabilities, rule.required_capabilities));
  const active = capabilityMatched.filter((rule) =>
    (rule.not_before === null || action.at >= rule.not_before)
    && (rule.expires_at === null || action.at < rule.expires_at));
  const denies = active.filter((rule) => rule.effect === "deny");
  if (denies.length > 0) return { decision: "deny", reason: "DENY_RULE", matched_rule_id: lowestRule(denies) };
  const allows = active.filter((rule) => rule.effect === "allow");
  if (allows.length > 0) return { decision: "allow", reason: "ALLOW_RULE", matched_rule_id: lowestRule(allows) };
  if (scoped.some((rule) => !includesAll(action.capabilities, rule.required_capabilities))) {
    return { decision: "deny", reason: "CAPABILITY_MISSING", matched_rule_id: null };
  }
  if (capabilityMatched.some((rule) => rule.not_before !== null && action.at < rule.not_before)) {
    return { decision: "deny", reason: "NOT_YET_VALID", matched_rule_id: null };
  }
  if (capabilityMatched.some((rule) => rule.expires_at !== null && action.at >= rule.expires_at)) {
    return { decision: "deny", reason: "EXPIRED", matched_rule_id: null };
  }
  return { decision: "deny", reason: "NO_MATCH", matched_rule_id: null };
}

function fingerprintInput(policy, action) {
  return {
    action: action.action,
    at: action.at,
    capabilities: [...action.capabilities].sort(scalarCompare),
    namespace: action.namespace,
    nonce: action.nonce,
    policy_epoch: action.policy_epoch,
    principal: action.principal,
    request_id: action.request_id,
    resource: action.resource,
    snapshot_id: policy.snapshot_id,
  };
}

function publicState(state) {
  return { receipts: state.receipts, events: state.events };
}

export function evaluateScenario(input) {
  const scenario = validateScenario(input);
  const policy = scenario.policy;
  const state = { receipts: [], events: [], byNonce: new Map() };
  const commandResults = [];
  for (let index = 0; index < scenario.actions.length; index += 1) {
    const action = scenario.actions[index];
    const pre = digest(publicState(state));
    const fingerprint = fingerprintInput(policy, action);
    const fingerprintCanonical = canonical(fingerprint);
    const fingerprintSha256 = digest(fingerprint);
    const existing = state.byNonce.get(action.nonce);
    let result;
    if (existing) {
      if (existing.fingerprint_canonical === fingerprintCanonical) {
        result = {
          index,
          accepted: true,
          outcome: "replayed",
          decision: existing.decision,
          reason: existing.reason,
          error: null,
          matched_rule_id: existing.matched_rule_id,
          request_fingerprint_sha256: fingerprintSha256,
          state_mutated: false,
        };
      } else {
        result = {
          index,
          accepted: false,
          outcome: "rejected",
          decision: null,
          reason: null,
          error: "NONCE_REPLAY_CONFLICT",
          matched_rule_id: null,
          request_fingerprint_sha256: fingerprintSha256,
          state_mutated: false,
        };
      }
    } else if (action.policy_epoch > policy.revocation_epoch) {
      result = {
        index,
        accepted: false,
        outcome: "rejected",
        decision: null,
        reason: null,
        error: "POLICY_EPOCH_AHEAD",
        matched_rule_id: null,
        request_fingerprint_sha256: fingerprintSha256,
        state_mutated: false,
      };
    } else {
      const decision = decide(policy, action);
      const receipt = {
        seq: state.receipts.length,
        nonce: action.nonce,
        request_id: action.request_id,
        request_fingerprint_sha256: fingerprintSha256,
        decision: decision.decision,
        reason: decision.reason,
        matched_rule_id: decision.matched_rule_id,
        first_action_index: index,
      };
      state.receipts.push(receipt);
      state.events.push({
        seq: state.events.length,
        kind: "decision_recorded",
        nonce: action.nonce,
        decision: decision.decision,
        reason: decision.reason,
      });
      state.byNonce.set(action.nonce, { ...receipt, fingerprint_canonical: fingerprintCanonical });
      result = {
        index,
        accepted: true,
        outcome: "decided",
        decision: decision.decision,
        reason: decision.reason,
        error: null,
        matched_rule_id: decision.matched_rule_id,
        request_fingerprint_sha256: fingerprintSha256,
        state_mutated: true,
      };
    }
    const post = digest(publicState(state));
    commandResults.push({ ...result, pre_state_sha256: pre, post_state_sha256: post });
  }
  return {
    profile: PROFILE,
    case_id: scenario.case_id,
    policy_snapshot_id: policy.snapshot_id,
    receipts: state.receipts,
    events: state.events,
    command_results: commandResults,
    state_sha256: digest(publicState(state)),
  };
}

export function evaluateBytes(raw) {
  return evaluateScenario(parseStrictJson(raw));
}

export function projection(result) {
  return {
    case_id: result.case_id,
    decisions: result.command_results.map((item) => ({
      accepted: item.accepted,
      outcome: item.outcome,
      decision: item.decision,
      reason: item.reason,
      error: item.error,
      matched_rule_id: item.matched_rule_id,
      state_mutated: item.state_mutated,
    })),
    receipt_count: result.receipts.length,
    event_kinds: result.events.map((event) => event.kind),
  };
}
