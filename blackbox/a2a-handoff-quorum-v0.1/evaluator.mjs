import { createHash } from "node:crypto";

export const PROFILE = "meshfleet.a2a.handoff-quorum.v0.1";
const MAX_BYTES = 131072;
const MAX_DEPTH = 64;
const MAX_ACTIONS = 128;
const MAX_VOTERS = 128;
const MAX_WEIGHT = 1000000;
const MAX_TOTAL_WEIGHT = 10000000;

export class ConformanceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new ConformanceError(code, message);
}

function validScalarString(value) {
  if (typeof value !== "string") return false;
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function compareCodePoints(a, b) {
  const aa = Array.from(a, (c) => c.codePointAt(0));
  const bb = Array.from(b, (c) => c.codePointAt(0));
  for (let i = 0; i < Math.min(aa.length, bb.length); i += 1) {
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  }
  return aa.length - bb.length;
}

export function canonical(value) {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("UNSAFE_INTEGER");
    if (Object.is(value, -0)) fail("NON_CANONICAL_INTEGER");
    return String(value);
  }
  if (typeof value === "string") {
    if (!validScalarString(value)) fail("INVALID_UNICODE");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort(compareCodePoints);
    return `{${keys.map((key) => `${canonical(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  fail("INVALID_SCENARIO");
}

export function digest(value) {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

class Parser {
  constructor(text) {
    this.text = text;
    this.i = 0;
  }

  ws() {
    while (this.i < this.text.length && /[\t\n\r ]/.test(this.text[this.i])) this.i += 1;
  }

  value(depth = 0) {
    if (depth > MAX_DEPTH) fail("DEPTH_LIMIT");
    this.ws();
    const c = this.text[this.i];
    if (c === "{") return this.object(depth + 1);
    if (c === "[") return this.array(depth + 1);
    if (c === '"') return this.string();
    if (c === "t" && this.text.slice(this.i, this.i + 4) === "true") {
      this.i += 4;
      return true;
    }
    if (c === "f" && this.text.slice(this.i, this.i + 5) === "false") {
      this.i += 5;
      return false;
    }
    if (c === "n" && this.text.slice(this.i, this.i + 4) === "null") {
      this.i += 4;
      return null;
    }
    if (c === "-" || (c >= "0" && c <= "9")) return this.number();
    fail("MALFORMED_JSON");
  }

  string() {
    const start = this.i;
    this.i += 1;
    let escaped = false;
    while (this.i < this.text.length) {
      const c = this.text[this.i];
      if (!escaped && c === '"') {
        this.i += 1;
        let value;
        try {
          value = JSON.parse(this.text.slice(start, this.i));
        } catch {
          fail("MALFORMED_JSON");
        }
        if (!validScalarString(value)) fail("INVALID_UNICODE");
        return value;
      }
      if (!escaped && c.charCodeAt(0) < 0x20) fail("MALFORMED_JSON");
      if (!escaped && c === "\\") escaped = true;
      else escaped = false;
      this.i += 1;
    }
    fail("MALFORMED_JSON");
  }

  number() {
    const rest = this.text.slice(this.i);
    const match = /^-?(?:0|[1-9]\d*)/.exec(rest);
    if (!match) fail("MALFORMED_JSON");
    const token = match[0];
    this.i += token.length;
    if (token === "-0") fail("NON_CANONICAL_INTEGER");
    const suffix = this.text.slice(this.i);
    if (/^\.\d/.test(suffix) || /^[eE][+-]?\d/.test(suffix)) fail("NON_CANONICAL_INTEGER");
    if (/^[0-9.eE+-]/.test(suffix)) fail("MALFORMED_JSON");
    const value = Number(token);
    if (!Number.isSafeInteger(value)) fail("UNSAFE_INTEGER");
    return value;
  }

  array(depth) {
    this.i += 1;
    const result = [];
    this.ws();
    if (this.text[this.i] === "]") {
      this.i += 1;
      return result;
    }
    while (true) {
      result.push(this.value(depth));
      this.ws();
      if (this.text[this.i] === "]") {
        this.i += 1;
        return result;
      }
      if (this.text[this.i] !== ",") fail("MALFORMED_JSON");
      this.i += 1;
    }
  }

  object(depth) {
    this.i += 1;
    const result = {};
    const seen = new Set();
    this.ws();
    if (this.text[this.i] === "}") {
      this.i += 1;
      return result;
    }
    while (true) {
      this.ws();
      if (this.text[this.i] !== '"') fail("MALFORMED_JSON");
      const key = this.string();
      if (seen.has(key)) fail("DUPLICATE_MEMBER");
      seen.add(key);
      this.ws();
      if (this.text[this.i] !== ":") fail("MALFORMED_JSON");
      this.i += 1;
      result[key] = this.value(depth);
      this.ws();
      if (this.text[this.i] === "}") {
        this.i += 1;
        return result;
      }
      if (this.text[this.i] !== ",") fail("MALFORMED_JSON");
      this.i += 1;
    }
  }
}

export function parseStrictJson(input) {
  let bytes;
  if (typeof input === "string") bytes = Buffer.from(input, "utf8");
  else if (Buffer.isBuffer(input) || input instanceof Uint8Array) bytes = Buffer.from(input);
  else fail("INVALID_SCENARIO");
  if (bytes.length > MAX_BYTES) fail("SIZE_LIMIT");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("INVALID_UTF8");
  }
  const parser = new Parser(text);
  const value = parser.value();
  parser.ws();
  if (parser.i !== text.length) fail("MALFORMED_JSON");
  return value;
}

function object(value, code = "INVALID_SCENARIO") {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function exact(value, required, code = "INVALID_SCENARIO") {
  const keys = Object.keys(value);
  for (const key of required) if (!Object.hasOwn(value, key)) fail("MISSING_FIELD", key);
  for (const key of keys) if (!required.includes(key)) fail("UNKNOWN_FIELD", key);
}

function id(value) {
  return typeof value === "string" && value.length > 0 && validScalarString(value);
}

function integer(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateScenario(raw) {
  const scenario = object(raw);
  exact(scenario, ["profile", "case_id", "proposal", "actions"]);
  if (scenario.profile !== PROFILE) fail("PROFILE_REJECT");
  if (!id(scenario.case_id)) fail("INVALID_FIELD");
  const proposal = object(scenario.proposal);
  exact(proposal, [
    "proposal_id", "voters", "required_signoffs", "quorum", "weights", "deadline", "silence_policy",
  ]);
  if (!id(proposal.proposal_id)) fail("INVALID_FIELD");
  if (!Array.isArray(proposal.voters) || proposal.voters.length < 1 || proposal.voters.length > MAX_VOTERS) {
    fail("INVALID_FIELD");
  }
  if (!proposal.voters.every(id)) fail("INVALID_FIELD");
  if (new Set(proposal.voters).size !== proposal.voters.length) fail("DUPLICATE_VOTER");
  if (!Array.isArray(proposal.required_signoffs) || !proposal.required_signoffs.every(id)) {
    fail("INVALID_FIELD");
  }
  if (new Set(proposal.required_signoffs).size !== proposal.required_signoffs.length) fail("INVALID_SIGNOFF");
  if (proposal.required_signoffs.some((v) => !proposal.voters.includes(v))) fail("INVALID_SIGNOFF");
  const weights = object(proposal.weights);
  for (const [voter, weight] of Object.entries(weights)) {
    if (!proposal.voters.includes(voter)) fail("INVALID_WEIGHT");
    if (!Number.isSafeInteger(weight) || weight < 1 || weight > MAX_WEIGHT) fail("INVALID_WEIGHT");
  }
  const weightOf = (voter) => Object.hasOwn(weights, voter) ? weights[voter] : 1;
  const totalWeight = proposal.voters.reduce((sum, voter) => sum + weightOf(voter), 0);
  if (totalWeight > MAX_TOTAL_WEIGHT) fail("INVALID_WEIGHT");
  if (!Number.isSafeInteger(proposal.quorum) || proposal.quorum < 1 || proposal.quorum > totalWeight) {
    fail("INVALID_QUORUM");
  }
  if (proposal.deadline !== null && !integer(proposal.deadline)) fail("INVALID_FIELD");
  if (!["abstain", "approve"].includes(proposal.silence_policy)) fail("INVALID_FIELD");
  if (!Array.isArray(scenario.actions) || scenario.actions.length > MAX_ACTIONS) fail("INVALID_FIELD");
  let previousAt = -1;
  for (const action of scenario.actions) {
    object(action);
    if (action.op === "vote") {
      exact(action, ["op", "at", "receipt_id", "voter_id", "seq", "decision"]);
      if (!integer(action.at) || !integer(action.seq) || !id(action.receipt_id) || !id(action.voter_id)) {
        fail("INVALID_FIELD");
      }
      if (!["approve", "decline"].includes(action.decision)) fail("INVALID_FIELD");
    } else if (action.op === "resolve") {
      exact(action, ["op", "at"]);
      if (!integer(action.at)) fail("INVALID_FIELD");
    } else {
      fail("INVALID_FIELD");
    }
    if (action.at < previousAt) fail("NON_MONOTONIC_TIME");
    previousAt = action.at;
  }
  return scenario;
}

function publicState(state) {
  return {
    proposal: state.proposal,
    status: state.status,
    resolved_at: state.resolved_at,
    votes: state.votes,
    events: state.events,
  };
}

function tally(state, now) {
  const voters = state.proposal.voters;
  const approvals = voters.filter((v) => state.effective.get(v)?.decision === "approve");
  const declines = voters.filter((v) => state.effective.get(v)?.decision === "decline");
  const pending = voters.filter((v) => !state.effective.has(v));
  const weightOf = (v) => Object.hasOwn(state.proposal.weights, v) ? state.proposal.weights[v] : 1;
  const sum = (values) => values.reduce((total, voter) => total + weightOf(voter), 0);
  const approvalWeight = sum(approvals);
  const declineWeight = sum(declines);
  const pendingWeight = sum(pending);
  const signoffsMet = state.proposal.required_signoffs.every(
    (v) => state.effective.get(v)?.decision === "approve",
  );
  const signoffRejected = state.proposal.required_signoffs.some(
    (v) => state.effective.get(v)?.decision === "decline",
  );
  const deadlinePassed = state.proposal.deadline !== null && now >= state.proposal.deadline;
  const effectiveApprovalWeight =
    deadlinePassed && state.proposal.silence_policy === "approve"
      ? approvalWeight + pendingWeight
      : approvalWeight;
  const reachable = approvalWeight + pendingWeight >= state.proposal.quorum && !signoffRejected;
  let status = state.status;
  if (status === "open") {
    if (signoffRejected || !reachable) status = "rejected";
    else if (effectiveApprovalWeight >= state.proposal.quorum && signoffsMet) status = "ratified";
    else if (deadlinePassed) status = "expired";
  }
  return {
    status,
    approvals,
    declines,
    pending,
    required_signoffs: state.proposal.required_signoffs,
    signoffs_met: signoffsMet,
    reachable,
    approval_weight: approvalWeight,
    decline_weight: declineWeight,
    pending_weight: pendingWeight,
    total_weight: approvalWeight + declineWeight + pendingWeight,
  };
}

function event(state, kind, at, detail) {
  state.events.push({ seq: state.events.length, kind, at, ...detail });
}

export function evaluateScenario(raw) {
  const scenario = validateScenario(raw);
  const state = {
    proposal: structuredClone(scenario.proposal),
    status: "open",
    resolved_at: null,
    votes: [],
    events: [],
    effective: new Map(),
    receiptContent: new Map(),
  };
  const commandResults = [];
  for (let index = 0; index < scenario.actions.length; index += 1) {
    const action = scenario.actions[index];
    const pre = digest(publicState(state));
    let accepted = true;
    let outcome = null;
    let error = null;
    if (action.op === "vote") {
      const fingerprint = canonical(action);
      const prior = state.receiptContent.get(action.receipt_id);
      if (prior !== undefined) {
        if (prior === fingerprint) outcome = "idempotent_replay";
        else {
          accepted = false;
          error = "RECEIPT_REPLAY_CONFLICT";
        }
      } else if (state.status !== "open") {
        accepted = false;
        error = "RATIFICATION_TERMINAL";
      } else if (!state.proposal.voters.includes(action.voter_id)) {
        accepted = false;
        error = "UNKNOWN_VOTER";
      } else {
        const current = state.effective.get(action.voter_id);
        const expectedSeq = current ? current.seq + 1 : 0;
        if (action.seq !== expectedSeq) {
          accepted = false;
          error = "VOTE_SEQUENCE";
        } else if (current?.decision === action.decision) {
          accepted = false;
          error = "VOTE_NO_CHANGE";
        } else {
          const vote = {
            receipt_id: action.receipt_id,
            voter_id: action.voter_id,
            seq: action.seq,
            decision: action.decision,
            at: action.at,
          };
          state.votes.push(vote);
          state.effective.set(action.voter_id, vote);
          state.receiptContent.set(action.receipt_id, fingerprint);
          event(state, "vote_recorded", action.at, {
            receipt_id: action.receipt_id,
            voter_id: action.voter_id,
            vote_seq: action.seq,
            decision: action.decision,
          });
          outcome = "vote_recorded";
        }
      }
    } else {
      if (state.status !== "open") {
        outcome = state.status;
      } else {
        const current = tally(state, action.at);
        if (current.status !== "open") {
          state.status = current.status;
          state.resolved_at = action.at;
          event(state, "ratification_resolved", action.at, { status: current.status });
        }
        outcome = current.status;
      }
    }
    const post = digest(publicState(state));
    commandResults.push({
      index,
      op: action.op,
      accepted,
      outcome,
      error,
      pre_state_sha256: pre,
      post_state_sha256: post,
    });
  }
  const now = scenario.actions.length ? scenario.actions.at(-1).at : 0;
  return {
    profile: PROFILE,
    case_id: scenario.case_id,
    status: state.status,
    resolved_at: state.resolved_at,
    tally: tally(state, now),
    votes: state.votes,
    events: state.events,
    command_results: commandResults,
    state_sha256: digest(publicState(state)),
  };
}

export function evaluateBytes(bytes) {
  return evaluateScenario(parseStrictJson(bytes));
}

export function projection(result) {
  return {
    case_id: result.case_id,
    stored_status: result.status,
    tally_status: result.tally.status,
    approvals: result.tally.approvals,
    declines: result.tally.declines,
    pending: result.tally.pending,
    signoffs_met: result.tally.signoffs_met,
    reachable: result.tally.reachable,
    approval_weight: result.tally.approval_weight,
    decline_weight: result.tally.decline_weight,
    pending_weight: result.tally.pending_weight,
    total_weight: result.tally.total_weight,
    accepted_actions: result.command_results.filter((r) => r.accepted).length,
    rejected_actions: result.command_results.filter((r) => !r.accepted).length,
    error_codes: result.command_results.filter((r) => r.error).map((r) => r.error),
    event_kinds: result.events.map((e) => e.kind),
  };
}
