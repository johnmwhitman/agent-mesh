export const PROFILE = "meshfleet.a2a.discussion-derivation.v0.1";

export const LIMITS = Object.freeze({
  MAX_DOCUMENT_BYTES: 12 * 1024 * 1024,
  MAX_JSON_DEPTH: 32,
  MAX_MESSAGES: 4096,
  MAX_RECEIPTS: 16384,
  MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
});

const BROADCAST = "*";
const DISCUSSION_MAX_PAYLOAD_BYTES = 64 * 1024;
const MIN_MAX_TURNS = 2;
const MAX_MAX_TURNS = 32;
const MIN_TURN_TIMEOUT_MS = 1_000;
const MAX_TURN_TIMEOUT_MS = 5 * 60_000;
const WAKE_STATES = ["reserved", "started", "completed", "failed", "deadman"];
const TERMINAL_STATES = ["completed", "failed", "deadman"];
const EMPTY_POLICY = {
  participants: ["", ""],
  max_turns: 0,
  conversation_deadline: 0,
  turn_timeout_ms: 0,
};

class ProfileError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new ProfileError(code);
}

function bytesOf(raw) {
  if (raw instanceof Uint8Array) return raw;
  if (typeof ArrayBuffer !== "undefined" && raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (raw && typeof raw === "object" && raw.buffer instanceof ArrayBuffer) {
    return new Uint8Array(raw.buffer, raw.byteOffset ?? 0, raw.byteLength ?? raw.length);
  }
  fail("INVALID_INPUT");
}

function utf8ByteLength(text) {
  return new TextEncoder().encode(text).length;
}

function isWhitespace(ch) {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function validateUnicode(value) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (!validScalarString(current)) fail("INVALID_UNICODE");
    } else if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
    } else if (current && typeof current === "object") {
      for (const [key, item] of Object.entries(current)) {
        if (!validScalarString(key)) fail("INVALID_UNICODE");
        pending.push(item);
      }
    }
  }
}

class StrictJsonParser {
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  parse() {
    this.skip();
    const value = this.value(0);
    this.skip();
    if (this.index !== this.text.length) fail("MALFORMED_JSON");
    return value;
  }

  skip() {
    while (this.index < this.text.length && isWhitespace(this.text[this.index])) this.index += 1;
  }

  value(depth) {
    this.skip();
    if (this.index >= this.text.length) fail("MALFORMED_JSON");
    const ch = this.text[this.index];
    if (ch === "{") return this.object(depth + 1);
    if (ch === "[") return this.array(depth + 1);
    if (ch === '"') return this.string();
    if (ch === "t" && this.literal("true")) return true;
    if (ch === "f" && this.literal("false")) return false;
    if (ch === "n" && this.literal("null")) return null;
    if (ch === "-" || (ch >= "0" && ch <= "9")) return this.number();
    fail("MALFORMED_JSON");
  }

  literal(token) {
    if (this.text.slice(this.index, this.index + token.length) !== token) return false;
    this.index += token.length;
    return true;
  }

  object(depth) {
    if (depth > LIMITS.MAX_JSON_DEPTH) fail("JSON_DEPTH_LIMIT");
    this.index += 1;
    this.skip();
    const value = Object.create(null);
    if (this.text[this.index] === "}") {
      this.index += 1;
      return value;
    }
    for (;;) {
      if (this.text[this.index] !== '"') fail("MALFORMED_JSON");
      const key = this.string();
      this.skip();
      if (this.text[this.index] !== ":") fail("MALFORMED_JSON");
      this.index += 1;
      const item = this.value(depth);
      if (Object.prototype.hasOwnProperty.call(value, key)) fail("DUPLICATE_JSON_KEY");
      value[key] = item;
      this.skip();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return value;
      }
      if (this.text[this.index] !== ",") fail("MALFORMED_JSON");
      this.index += 1;
      this.skip();
    }
  }

  array(depth) {
    if (depth > LIMITS.MAX_JSON_DEPTH) fail("JSON_DEPTH_LIMIT");
    this.index += 1;
    this.skip();
    const value = [];
    if (this.text[this.index] === "]") {
      this.index += 1;
      return value;
    }
    for (;;) {
      value.push(this.value(depth));
      this.skip();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return value;
      }
      if (this.text[this.index] !== ",") fail("MALFORMED_JSON");
      this.index += 1;
      this.skip();
    }
  }

  string() {
    this.index += 1;
    let output = "";
    while (this.index < this.text.length) {
      const ch = this.text[this.index++];
      if (ch === '"') return output;
      if (ch.charCodeAt(0) < 0x20) fail("MALFORMED_JSON");
      if (ch !== "\\") {
        output += ch;
        continue;
      }
      if (this.index >= this.text.length) fail("MALFORMED_JSON");
      const escaped = this.text[this.index++];
      if (escaped === '"' || escaped === "\\" || escaped === "/") output += escaped;
      else if (escaped === "b") output += "\b";
      else if (escaped === "f") output += "\f";
      else if (escaped === "n") output += "\n";
      else if (escaped === "r") output += "\r";
      else if (escaped === "t") output += "\t";
      else if (escaped === "u") output += this.unicodeEscape();
      else fail("MALFORMED_JSON");
    }
    fail("MALFORMED_JSON");
  }

  unicodeEscape() {
    const first = this.hexCodeUnit();
    if (first < 0xd800 || first > 0xdbff || this.text.slice(this.index, this.index + 2) !== "\\u") {
      return String.fromCharCode(first);
    }
    const saved = this.index;
    this.index += 2;
    const second = this.hexCodeUnit();
    if (second < 0xdc00 || second > 0xdfff) {
      this.index = saved;
      return String.fromCharCode(first);
    }
    return String.fromCodePoint(0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00));
  }

  hexCodeUnit() {
    const token = this.text.slice(this.index, this.index + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(token)) fail("MALFORMED_JSON");
    this.index += 4;
    return Number.parseInt(token, 16);
  }

  number() {
    const start = this.index;
    if (this.text[this.index] === "-") this.index += 1;
    if (this.text[this.index] === "0") {
      this.index += 1;
      if (this.text[this.index] >= "0" && this.text[this.index] <= "9") fail("MALFORMED_JSON");
    } else {
      if (!(this.text[this.index] >= "1" && this.text[this.index] <= "9")) fail("MALFORMED_JSON");
      while (this.text[this.index] >= "0" && this.text[this.index] <= "9") this.index += 1;
    }
    if (this.text[this.index] === "." || this.text[this.index] === "e" || this.text[this.index] === "E") {
      fail("NON_CANONICAL_INTEGER");
    }
    const lexeme = this.text.slice(start, this.index);
    if (lexeme === "-0") fail("NON_CANONICAL_INTEGER");
    let integer;
    try {
      integer = BigInt(lexeme);
    } catch {
      fail("MALFORMED_JSON");
    }
    if (integer > BigInt(LIMITS.MAX_SAFE_INTEGER) || integer < -BigInt(LIMITS.MAX_SAFE_INTEGER)) {
      fail("UNSAFE_INTEGER");
    }
    return Number(integer);
  }
}

function parseStrictDocument(raw) {
  const bytes = bytesOf(raw);
  if (bytes.byteLength > LIMITS.MAX_DOCUMENT_BYTES) fail("DOCUMENT_TOO_LARGE");
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail("BOM_NOT_ALLOWED");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("INVALID_UTF8");
  }
  let value;
  try {
    value = new StrictJsonParser(text).parse();
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    fail("MALFORMED_JSON");
  }
  validateUnicode(value);
  return value;
}

class WireJsonParser {
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  parse() {
    this.skip();
    if (this.index >= this.text.length) throw new Error("empty");
    const value = this.value(0);
    this.skip();
    if (this.index !== this.text.length) throw new Error("trailing");
    return value;
  }

  skip() {
    while (this.index < this.text.length && isWhitespace(this.text[this.index])) this.index += 1;
  }

  value(depth) {
    if (depth > 512) throw new Error("depth");
    this.skip();
    if (this.index >= this.text.length) throw new Error("eof");
    const ch = this.text[this.index];
    if (ch === "{") return this.object(depth + 1);
    if (ch === "[") return this.array(depth + 1);
    if (ch === '"') return this.string();
    if (ch === "t" && this.tryLiteral("true")) return true;
    if (ch === "f" && this.tryLiteral("false")) return false;
    if (ch === "n" && this.tryLiteral("null")) return null;
    if (ch === "-" || (ch >= "0" && ch <= "9")) return this.number();
    throw new Error("value");
  }

  tryLiteral(token) {
    if (this.text.slice(this.index, this.index + token.length) !== token) return false;
    this.index += token.length;
    return true;
  }

  object(depth) {
    this.index += 1;
    this.skip();
    const value = Object.create(null);
    if (this.text[this.index] === "}") {
      this.index += 1;
      return value;
    }
    for (;;) {
      this.skip();
      if (this.text[this.index] !== '"') throw new Error("key");
      const key = this.string();
      this.skip();
      if (this.text[this.index] !== ":") throw new Error("colon");
      this.index += 1;
      value[key] = this.value(depth);
      this.skip();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return value;
      }
      if (this.text[this.index] !== ",") throw new Error("comma");
      this.index += 1;
    }
  }

  array(depth) {
    this.index += 1;
    this.skip();
    const value = [];
    if (this.text[this.index] === "]") {
      this.index += 1;
      return value;
    }
    for (;;) {
      value.push(this.value(depth));
      this.skip();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return value;
      }
      if (this.text[this.index] !== ",") throw new Error("comma");
      this.index += 1;
    }
  }

  string() {
    this.index += 1;
    let output = "";
    while (this.index < this.text.length) {
      const ch = this.text[this.index++];
      if (ch === '"') return output;
      if (ch.charCodeAt(0) < 0x20) throw new Error("control");
      if (ch !== "\\") {
        output += ch;
        continue;
      }
      if (this.index >= this.text.length) throw new Error("escape");
      const escaped = this.text[this.index++];
      if (escaped === '"' || escaped === "\\" || escaped === "/") output += escaped;
      else if (escaped === "b") output += "\b";
      else if (escaped === "f") output += "\f";
      else if (escaped === "n") output += "\n";
      else if (escaped === "r") output += "\r";
      else if (escaped === "t") output += "\t";
      else if (escaped === "u") {
        const hex = this.text.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("u");
        this.index += 4;
        output += String.fromCharCode(Number.parseInt(hex, 16));
      } else throw new Error("escape");
    }
    throw new Error("string");
  }

  number() {
    const start = this.index;
    if (this.text[this.index] === "-") this.index += 1;
    if (this.text[this.index] === "0") {
      this.index += 1;
    } else {
      if (!(this.text[this.index] >= "1" && this.text[this.index] <= "9")) throw new Error("num");
      while (this.text[this.index] >= "0" && this.text[this.index] <= "9") this.index += 1;
    }
    if (this.text[this.index] === ".") {
      this.index += 1;
      if (!(this.text[this.index] >= "0" && this.text[this.index] <= "9")) throw new Error("frac");
      while (this.text[this.index] >= "0" && this.text[this.index] <= "9") this.index += 1;
    }
    if (this.text[this.index] === "e" || this.text[this.index] === "E") {
      this.index += 1;
      if (this.text[this.index] === "+" || this.text[this.index] === "-") this.index += 1;
      if (!(this.text[this.index] >= "0" && this.text[this.index] <= "9")) throw new Error("exp");
      while (this.text[this.index] >= "0" && this.text[this.index] <= "9") this.index += 1;
    }
    const n = Number(this.text.slice(start, this.index));
    if (!Number.isFinite(n)) throw new Error("num");
    return n;
  }
}

function wireParseJson(text) {
  try {
    return new WireJsonParser(text).parse();
  } catch {
    return undefined;
  }
}

function requireExactKeys(obj, keys, unknownCode, missingCode) {
  if (!isPlainObject(obj)) fail("ROOT_NOT_OBJECT");
  const allowed = new Set(keys);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) fail(unknownCode);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) fail(missingCode);
  }
}

function requireNonEmptyString(value, code) {
  if (typeof value !== "string" || value.length === 0) fail(code);
  return value;
}

function requireSafeInteger(value, code) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(code);
  return value;
}

function validateMessage(raw) {
  if (!isPlainObject(raw)) fail("INVALID_MESSAGE");
  const allowed = new Set([
    "id",
    "from_agent_id",
    "to_agent_id",
    "fleet_id",
    "type",
    "payload",
    "correlation_id",
    "timestamp",
    "acknowledged",
    "recipients",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) fail("UNKNOWN_MESSAGE_FIELD");
  }
  for (const key of ["id", "from_agent_id", "to_agent_id", "fleet_id", "type", "payload", "timestamp"]) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) fail("MISSING_MESSAGE_FIELD");
  }
  const msg = {
    id: requireNonEmptyString(raw.id, "INVALID_MESSAGE_ID"),
    from_agent_id: requireNonEmptyString(raw.from_agent_id, "INVALID_FROM_AGENT"),
    to_agent_id: requireNonEmptyString(raw.to_agent_id, "INVALID_TO_AGENT"),
    fleet_id: requireNonEmptyString(raw.fleet_id, "INVALID_FLEET_ID"),
    type: requireNonEmptyString(raw.type, "INVALID_MESSAGE_TYPE"),
    payload: typeof raw.payload === "string" ? raw.payload : fail("INVALID_PAYLOAD"),
    timestamp: requireSafeInteger(raw.timestamp, "INVALID_TIMESTAMP"),
  };
  if (Object.prototype.hasOwnProperty.call(raw, "correlation_id") && raw.correlation_id != null) {
    if (typeof raw.correlation_id !== "string") fail("INVALID_CORRELATION_ID");
    msg.correlation_id = raw.correlation_id;
  }
  if (Object.prototype.hasOwnProperty.call(raw, "acknowledged")) {
    if (typeof raw.acknowledged !== "boolean") fail("INVALID_ACKNOWLEDGED");
    msg.acknowledged = raw.acknowledged;
  }
  if (Object.prototype.hasOwnProperty.call(raw, "recipients") && raw.recipients !== undefined) {
    if (!Array.isArray(raw.recipients)) fail("INVALID_RECIPIENTS");
    for (const r of raw.recipients) {
      if (typeof r !== "string" || r.length === 0) fail("INVALID_RECIPIENTS");
    }
    msg.recipients = raw.recipients.slice();
  }
  return msg;
}

function validateReceipt(raw) {
  if (!isPlainObject(raw)) fail("INVALID_RECEIPT");
  const allowed = new Set(["id", "message_id", "agent_id", "action", "timestamp", "note"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) fail("UNKNOWN_RECEIPT_FIELD");
  }
  for (const key of ["message_id", "agent_id", "action", "timestamp"]) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) fail("MISSING_RECEIPT_FIELD");
  }
  const receipt = {
    message_id: requireNonEmptyString(raw.message_id, "INVALID_RECEIPT_MESSAGE_ID"),
    agent_id: requireNonEmptyString(raw.agent_id, "INVALID_RECEIPT_AGENT"),
    action: requireNonEmptyString(raw.action, "INVALID_RECEIPT_ACTION"),
    timestamp: requireSafeInteger(raw.timestamp, "INVALID_RECEIPT_TIMESTAMP"),
  };
  if (Object.prototype.hasOwnProperty.call(raw, "note") && raw.note !== undefined) {
    if (typeof raw.note !== "string") fail("INVALID_RECEIPT_NOTE");
    receipt.note = raw.note;
  }
  return receipt;
}

function validateScenario(root) {
  requireExactKeys(
    root,
    ["profile", "discussion_id", "messages", "receipts", "now"],
    "UNKNOWN_ROOT_FIELD",
    "MISSING_ROOT_FIELD"
  );
  if (typeof root.profile !== "string") fail("INVALID_PROFILE_TYPE");
  if (root.profile !== PROFILE) fail("UNSUPPORTED_PROFILE");
  const discussionId = requireNonEmptyString(root.discussion_id, "INVALID_DISCUSSION_ID");
  if (!Array.isArray(root.messages)) fail("MESSAGES_NOT_ARRAY");
  if (!Array.isArray(root.receipts)) fail("RECEIPTS_NOT_ARRAY");
  if (root.messages.length > LIMITS.MAX_MESSAGES) fail("MESSAGE_COUNT_LIMIT");
  if (root.receipts.length > LIMITS.MAX_RECEIPTS) fail("RECEIPT_COUNT_LIMIT");
  const now = requireSafeInteger(root.now, "INVALID_NOW");
  return {
    discussionId,
    messages: root.messages.map(validateMessage),
    receipts: root.receipts.map(validateReceipt),
    now,
  };
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function validatePayloadSize(payload) {
  return utf8ByteLength(payload) <= DISCUSSION_MAX_PAYLOAD_BYTES;
}

function isPolicyShape(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const p = v;
  if (!Array.isArray(p.participants) || p.participants.length !== 2) return false;
  const [a, b] = p.participants;
  if (!isNonEmptyString(a) || !isNonEmptyString(b) || a === b) return false;
  if (!Number.isInteger(p.max_turns)) return false;
  if (p.max_turns < MIN_MAX_TURNS || p.max_turns > MAX_MAX_TURNS) return false;
  if (!isFiniteNumber(p.conversation_deadline)) return false;
  if (!Number.isInteger(p.turn_timeout_ms)) return false;
  if (p.turn_timeout_ms < MIN_TURN_TIMEOUT_MS || p.turn_timeout_ms > MAX_TURN_TIMEOUT_MS) return false;
  return true;
}

function parseEnvelope(payload) {
  const parsed = wireParseJson(payload);
  if (parsed === undefined) return null;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const e = parsed;
  if (!isNonEmptyString(e.$meshfleet)) return null;
  if (!isNonEmptyString(e.discussion_id)) return null;
  if (!Number.isInteger(e.turn) || e.turn < 1) return null;
  if (!isNonEmptyString(e.attempt_id)) return null;
  if (!("reply_to" in e) || (e.reply_to !== null && !isNonEmptyString(e.reply_to))) return null;
  if (e.kind !== "question" && e.kind !== "result") return null;
  if (typeof e.body !== "string") return null;
  if (typeof e.close !== "boolean") return null;
  if (e.policy !== undefined && !isPolicyShape(e.policy)) return null;
  return {
    $meshfleet: e.$meshfleet,
    discussion_id: e.discussion_id,
    turn: e.turn,
    attempt_id: e.attempt_id,
    reply_to: e.reply_to ?? null,
    kind: e.kind,
    body: e.body,
    close: e.close,
    policy: e.policy,
  };
}

function isBroadcastMessage(message) {
  return message.to_agent_id === BROADCAST || message.recipients !== undefined;
}

function validateEnvelope(envelope, message) {
  if (!envelope) return { valid: false, reason: "invalid_envelope" };
  if (!validatePayloadSize(message.payload)) return { valid: false, reason: "payload_too_large" };
  if (envelope.$meshfleet !== "discussion/v1") return { valid: false, reason: "invalid_version" };
  if (isBroadcastMessage(message)) return { valid: false, reason: "broadcast_forbidden" };
  if (message.correlation_id !== envelope.discussion_id) {
    return { valid: false, reason: "correlation_mismatch" };
  }
  if (envelope.kind !== "question" && envelope.kind !== "result") {
    return { valid: false, reason: "invalid_kind" };
  }
  return { valid: true };
}

function looksLikeDiscussionAction(action) {
  return action.startsWith("discussion.");
}

function parseReceiptAction(action) {
  const colonParts = action.split(":");
  if (colonParts.length !== 3) return null;
  const [name, turnStr, attemptId] = colonParts;
  if (!/^\d+$/.test(turnStr)) return null;
  const turn = Number(turnStr);
  if (!Number.isSafeInteger(turn) || turn < 1) return null;
  if (!isNonEmptyString(attemptId)) return null;
  const nameParts = name.split(".");
  if (nameParts.length !== 4) return null;
  const [namespace, event, state, version] = nameParts;
  if (namespace !== "discussion") return null;
  if (version !== "v1") return null;
  if (event === "wake" && WAKE_STATES.includes(state)) {
    return { kind: "wake", state, turn, attempt_id: attemptId };
  }
  if (event === "turn" && state === "sent") {
    return { kind: "turn_sent", turn, attempt_id: attemptId };
  }
  return null;
}

function validateWakeReceiptNote(receipt, parsed, discussionId) {
  if (!receipt.note) return { ok: false, reason: "missing_note" };
  const raw = wireParseJson(receipt.note);
  if (raw === undefined) return { ok: false, reason: "note_not_json" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "note_not_object" };
  }
  const n = raw;
  if (n.discussion_id !== discussionId) return { ok: false, reason: "note_discussion_mismatch" };
  if (n.head_message_id !== receipt.message_id) return { ok: false, reason: "note_head_mismatch" };
  if (!isFiniteNumber(n.deadline)) return { ok: false, reason: "note_deadline_invalid" };
  if (parsed.state === "completed" && !isNonEmptyString(n.reply_message_id)) {
    return { ok: false, reason: "note_missing_reply" };
  }
  if (n.reply_message_id !== undefined && !isNonEmptyString(n.reply_message_id)) {
    return { ok: false, reason: "note_reply_invalid" };
  }
  return {
    ok: true,
    note: {
      discussion_id: n.discussion_id,
      head_message_id: n.head_message_id,
      deadline: n.deadline,
      reply_message_id: n.reply_message_id,
    },
  };
}

function recomputeStatus(input) {
  const { invalid, transcript, rootMessageId, attempts, policy, now, turnsUsed } = input;
  const liveAttempts = attempts.filter((a) => a.state === "reserved" || a.state === "started");
  if (invalid || liveAttempts.length > 1) return "invalid";
  for (const entry of transcript) {
    if (entry.message.id === rootMessageId) continue;
    const envelope = parseEnvelope(entry.message.payload);
    if (envelope?.close === true) return "closed";
  }
  const soleLive = liveAttempts[0];
  if (attempts.some((a) => a.state === "deadman") || (soleLive && soleLive.deadline <= now)) return "deadman";
  if (now > policy.conversation_deadline) return "expired";
  if (turnsUsed >= policy.max_turns) return "exhausted";
  if (soleLive && soleLive.deadline > now) return "active";
  return "open";
}

function invalidResult(discussionId, findings) {
  return {
    discussion_id: discussionId,
    root_message_id: "",
    fleet_id: "",
    participants: ["", ""],
    policy: EMPTY_POLICY,
    status: "invalid",
    head_message_id: "",
    turns_used: 0,
    turns_remaining: 0,
    transcript: [],
    attempts: [],
    integrity_findings: findings,
  };
}

function deriveDiscussion(discussionId, messages, receipts, now) {
  const findings = [];
  let discussionInvalid = false;
  const explained = new Set();
  function note(finding) {
    findings.push(finding);
    if (finding.message_id) explained.add(finding.message_id);
  }

  const correlated = messages.filter((m) => m.correlation_id === discussionId);
  const correlatedIds = new Set(correlated.map((m) => m.id));

  const valid = new Map();
  for (const msg of correlated) {
    const envelope = parseEnvelope(msg.payload);
    const validation = validateEnvelope(envelope, msg);
    if (!validation.valid || !envelope) {
      note({
        code: validation.reason ?? "invalid_envelope",
        message_id: msg.id,
        detail: `Envelope validation failed: ${validation.reason ?? "invalid_envelope"}`,
      });
      continue;
    }
    if (envelope.turn !== 1 && envelope.policy !== undefined) {
      discussionInvalid = true;
      note({
        code: "child_policy_forbidden",
        message_id: msg.id,
        detail: "Only the root envelope may carry a policy block",
      });
      continue;
    }
    valid.set(msg.id, { envelope, message: msg });
  }

  const rootCandidates = [];
  for (const candidate of valid.values()) {
    const { envelope, message } = candidate;
    if (envelope.turn !== 1 || envelope.reply_to !== null) continue;
    if (message.type !== "question" || envelope.kind !== "question") {
      note({
        code: "root_not_question",
        message_id: message.id,
        detail: `Root must be message.type='question' and envelope.kind='question'; got type='${message.type}', kind='${envelope.kind}'`,
      });
      continue;
    }
    if (!envelope.policy) {
      note({
        code: "root_missing_policy",
        message_id: message.id,
        detail: "Root envelope is missing the immutable policy block",
      });
      continue;
    }
    const [p1, p2] = envelope.policy.participants;
    if (message.from_agent_id !== p1 || message.to_agent_id !== p2) {
      note({
        code: "root_participant_mismatch",
        message_id: message.id,
        detail: `Root participants ${p1},${p2} do not match message ${message.from_agent_id},${message.to_agent_id}`,
      });
      continue;
    }
    rootCandidates.push(candidate);
  }

  if (rootCandidates.length === 0) {
    findings.push({
      code: "no_valid_root",
      detail: "No valid discussion/v1 root found for this discussion id",
    });
    return invalidResult(discussionId, findings);
  }
  if (rootCandidates.length > 1) {
    for (const extra of rootCandidates.slice(1)) {
      note({
        code: "duplicate_root",
        message_id: extra.message.id,
        detail: "A second valid root was found for this discussion id",
      });
    }
    return invalidResult(discussionId, findings);
  }

  const root = rootCandidates[0];
  const policy = root.envelope.policy;
  explained.add(root.message.id);

  if (root.envelope.close === true) {
    note({
      code: "root_close_forbidden",
      message_id: root.message.id,
      detail: "The root envelope must not set close=true; closing only takes effect via an authorized reply",
    });
  }

  const participantSet = new Set(policy.participants);
  const globallyValid = new Set();
  for (const [msgId, candidate] of valid) {
    if (msgId === root.message.id) continue;
    const { envelope, message } = candidate;
    const isRootShaped = envelope.turn === 1 && envelope.reply_to === null;
    let ok = true;
    if (message.fleet_id !== root.message.fleet_id) {
      discussionInvalid = true;
      note({
        code: "wrong_fleet",
        message_id: msgId,
        detail: `Fleet mismatch: message fleet '${message.fleet_id}' != root fleet '${root.message.fleet_id}'`,
      });
      ok = false;
    }
    if (
      !participantSet.has(message.from_agent_id) ||
      !participantSet.has(message.to_agent_id) ||
      message.from_agent_id === message.to_agent_id
    ) {
      discussionInvalid = true;
      note({
        code: "participant_violation",
        message_id: msgId,
        detail: `Sender/recipient ${message.from_agent_id}->${message.to_agent_id} are not the discussion's two participants`,
      });
      ok = false;
    }
    if (!isRootShaped && message.type !== envelope.kind) {
      discussionInvalid = true;
      note({
        code: "kind_type_mismatch",
        message_id: msgId,
        detail: `Envelope kind '${envelope.kind}' does not match message type '${message.type}'`,
      });
      ok = false;
    }
    if (ok && !isRootShaped) globallyValid.add(msgId);
  }

  const wakeReceiptsByAttempt = new Map();
  for (const receipt of receipts) {
    if (!correlatedIds.has(receipt.message_id)) continue;
    if (!looksLikeDiscussionAction(receipt.action)) continue;
    const parsed = parseReceiptAction(receipt.action);
    if (!parsed) {
      note({
        code: "unmatched_receipt",
        message_id: receipt.message_id,
        detail: `Receipt action '${receipt.action}' does not match a known discussion lifecycle format`,
      });
      continue;
    }
    if (parsed.kind === "turn_sent") {
      const rootAttemptId = root.envelope.attempt_id;
      if (parsed.turn !== 1 || parsed.attempt_id !== rootAttemptId) {
        note({
          code: "unmatched_receipt",
          message_id: receipt.message_id,
          detail: "discussion.turn.sent receipt does not match the root attempt",
        });
      }
      continue;
    }
    const validated = validateWakeReceiptNote(receipt, parsed, discussionId);
    if (!validated.ok) {
      note({
        code: "malformed_receipt_note",
        message_id: receipt.message_id,
        detail: `Wake receipt note failed validation: ${validated.reason}`,
      });
      continue;
    }
    const list = wakeReceiptsByAttempt.get(parsed.attempt_id) ?? [];
    list.push({ receipt, parsed, note: validated.note });
    wakeReceiptsByAttempt.set(parsed.attempt_id, list);
  }

  const validAttempts = new Map();
  const rank = { reserved: 0, started: 1, completed: 2, failed: 2, deadman: 2 };
  for (const [attemptId, group] of wakeReceiptsByAttempt) {
    if (!group.some((g) => g.parsed.state === "reserved")) {
      note({
        code: "attempt_missing_reservation",
        message_id: group[0].receipt.message_id,
        detail: `Attempt '${attemptId}' has no 'reserved' receipt in its lifecycle and cannot be validated`,
      });
      continue;
    }
    const first = group[0];
    const headId = first.note.head_message_id;
    const turn = first.parsed.turn;
    const agentId = first.receipt.agent_id;
    const deadline = first.note.deadline;
    let consistent = true;
    const completedReplyIds = new Set();
    for (const entry of group) {
      if (
        entry.note.head_message_id !== headId ||
        entry.parsed.turn !== turn ||
        entry.receipt.agent_id !== agentId ||
        entry.note.deadline !== deadline
      ) {
        consistent = false;
      }
      if (entry.parsed.state === "completed" && entry.note.reply_message_id) {
        completedReplyIds.add(entry.note.reply_message_id);
      }
    }
    if (completedReplyIds.size > 1) consistent = false;
    const terminalsSeen = new Set(
      group.filter((g) => TERMINAL_STATES.includes(g.parsed.state)).map((g) => g.parsed.state)
    );
    if (terminalsSeen.size > 1) consistent = false;
    if (!consistent) {
      discussionInvalid = true;
      note({
        code: "attempt_identity_conflict",
        message_id: headId,
        detail: `Attempt '${attemptId}' has internally inconsistent receipts (head/turn/agent/deadline must all agree, and at most one completed reply id / terminal state is permitted)`,
      });
      continue;
    }
    const headMsg =
      headId === root.message.id
        ? root.message
        : globallyValid.has(headId)
          ? valid.get(headId)?.message
          : undefined;
    if (!headMsg) {
      note({
        code: "receipt_on_invalid_head",
        message_id: headId,
        detail: `Attempt '${attemptId}' is bound to a head that is not a validated, participant/fleet-valid discussion candidate`,
      });
      continue;
    }
    const expectedAgent = headMsg.to_agent_id;
    if (agentId !== expectedAgent) {
      note({
        code: "unauthorized_attempt_agent",
        message_id: headId,
        detail: `Attempt '${attemptId}' acted as '${agentId}', expected '${expectedAgent}'`,
      });
      continue;
    }
    const candidates = group.filter((entry) => {
      if (entry.parsed.state !== "completed") return true;
      const onTime =
        entry.receipt.timestamp <= deadline && entry.receipt.timestamp <= policy.conversation_deadline;
      if (!onTime) {
        note({
          code: "late_completion",
          message_id: headId,
          detail: `Attempt '${attemptId}' completed at ${entry.receipt.timestamp}, after its deadline (${deadline}) or the conversation deadline (${policy.conversation_deadline})`,
        });
      }
      return onTime;
    });
    let best = candidates[0];
    for (const entry of candidates) {
      if (rank[entry.parsed.state] >= rank[best.parsed.state]) best = entry;
    }
    validAttempts.set(attemptId, {
      attempt_id: attemptId,
      turn,
      agent_id: agentId,
      head_message_id: headId,
      state: best.parsed.state,
      deadline,
      reply_message_id: best.parsed.state === "completed" ? best.note.reply_message_id : undefined,
    });
  }

  const completedByHead = new Map();
  for (const attempt of validAttempts.values()) {
    if (attempt.state !== "completed") continue;
    const list = completedByHead.get(attempt.head_message_id) ?? [];
    list.push(attempt);
    completedByHead.set(attempt.head_message_id, list);
  }

  const canonicalAttemptIds = new Set();
  const attemptsExplained = new Set();
  function isBeyondBudget(turn) {
    return turn > policy.max_turns;
  }
  for (const [attemptId, attempt] of validAttempts) {
    if (isBeyondBudget(attempt.turn)) {
      attemptsExplained.add(attemptId);
      note({
        code: "attempt_beyond_budget",
        message_id: attempt.head_message_id,
        detail: `Attempt '${attemptId}' claims turn ${attempt.turn}, beyond the immutable max_turns budget of ${policy.max_turns}`,
      });
    }
  }

  const byReplyTo = new Map();
  for (const candidate of valid.values()) {
    if (candidate.message.id === root.message.id) continue;
    const key = candidate.envelope.reply_to;
    if (key === null) continue;
    const list = byReplyTo.get(key) ?? [];
    list.push(candidate);
    byReplyTo.set(key, list);
  }

  const canonicalChain = [{ candidate: root, turn: 1 }];
  let currentHead = root.message.id;
  let currentTurn = 1;
  const visitedHeads = new Set([root.message.id]);

  function registerContiguousTail(headId, fromTurn) {
    const attemptsAtHead = Array.from(validAttempts.values()).filter((a) => a.head_message_id === headId);
    for (let t = fromTurn; ; t++) {
      const atTurn = attemptsAtHead.find((a) => a.turn === t);
      if (!atTurn) break;
      if (isBeyondBudget(atTurn.turn)) {
        if (atTurn.state === "failed" || atTurn.state === "deadman") continue;
        break;
      }
      canonicalAttemptIds.add(atTurn.attempt_id);
      attemptsExplained.add(atTurn.attempt_id);
      if (atTurn.state === "deadman") break;
      if (atTurn.state !== "failed") break;
    }
  }

  for (;;) {
    const bucket = (byReplyTo.get(currentHead) ?? []).filter((c) => globallyValid.has(c.message.id));
    if (bucket.length === 0) {
      registerContiguousTail(currentHead, currentTurn + 1);
      break;
    }
    const prev = canonicalChain[canonicalChain.length - 1].candidate.message;
    const expectedFrom = prev.to_agent_id;
    const expectedTo = prev.from_agent_id;
    const alternationValid = [];
    for (const candidate of bucket) {
      if (candidate.message.from_agent_id !== expectedFrom || candidate.message.to_agent_id !== expectedTo) {
        discussionInvalid = true;
        note({
          code: "invalid_sender",
          message_id: candidate.message.id,
          detail: `Sender/recipient do not alternate: expected ${expectedFrom}->${expectedTo}, got ${candidate.message.from_agent_id}->${candidate.message.to_agent_id}`,
        });
        continue;
      }
      alternationValid.push(candidate);
    }
    const authorized = [];
    const candidateAttempts = completedByHead.get(currentHead) ?? [];
    for (const candidate of alternationValid) {
      const attempt = candidateAttempts.find(
        (a) =>
          a.reply_message_id === candidate.message.id &&
          a.turn === candidate.envelope.turn &&
          a.attempt_id === candidate.envelope.attempt_id
      );
      if (attempt) {
        authorized.push({ candidate, attempt });
        explained.add(candidate.message.id);
      } else {
        note({
          code: "unauthorized_reply",
          message_id: candidate.message.id,
          detail: `No validated, agent-authorized completed wake attempt (matching reply id, turn, AND attempt id) admits this reply at head '${currentHead}'`,
        });
      }
    }
    if (authorized.length === 0) {
      registerContiguousTail(currentHead, currentTurn + 1);
      break;
    }
    if (authorized.length > 1) {
      discussionInvalid = true;
      for (const contender of authorized) {
        note({
          code: "fork",
          message_id: contender.candidate.message.id,
          detail: `Two or more authorized replies target head '${currentHead}'`,
        });
      }
      break;
    }
    const { candidate: winner, attempt } = authorized[0];
    if (isBeyondBudget(attempt.turn)) break;
    const attemptsAtThisHead = Array.from(validAttempts.values()).filter(
      (a) => a.head_message_id === currentHead
    );
    let gapOk = attempt.turn > currentTurn;
    let deadmanEncountered = null;
    const fillers = [];
    for (let t = currentTurn + 1; gapOk && t < attempt.turn; t++) {
      const filler = attemptsAtThisHead.find((a) => a.turn === t);
      if (filler && !isBeyondBudget(filler.turn) && filler.state === "deadman") {
        deadmanEncountered = filler;
        gapOk = false;
        break;
      }
      if (!filler || filler.state !== "failed" || isBeyondBudget(filler.turn)) {
        gapOk = false;
        break;
      }
      fillers.push(filler);
    }
    if (deadmanEncountered) {
      for (const filler of fillers) {
        canonicalAttemptIds.add(filler.attempt_id);
        attemptsExplained.add(filler.attempt_id);
      }
      canonicalAttemptIds.add(deadmanEncountered.attempt_id);
      attemptsExplained.add(deadmanEncountered.attempt_id);
      break;
    }
    if (!gapOk) {
      discussionInvalid = true;
      attemptsExplained.add(attempt.attempt_id);
      note({
        code: "ordinal_discontinuity",
        message_id: currentHead,
        detail: `Attempt '${attempt.attempt_id}' claims turn ${attempt.turn} directly from turn ${currentTurn} at head '${currentHead}' without a validated failed reservation for every intervening turn`,
      });
      break;
    }
    for (const filler of fillers) {
      canonicalAttemptIds.add(filler.attempt_id);
      attemptsExplained.add(filler.attempt_id);
    }
    canonicalAttemptIds.add(attempt.attempt_id);
    attemptsExplained.add(attempt.attempt_id);
    canonicalChain.push({ candidate: winner, turn: attempt.turn });
    currentHead = winner.message.id;
    currentTurn = attempt.turn;
    visitedHeads.add(currentHead);
    if (winner.envelope.close === true) break;
  }

  const transcript = canonicalChain.map(({ candidate, turn }) => ({
    turn,
    message: candidate.message,
    receipts: receipts.filter((r) => r.message_id === candidate.message.id),
  }));

  for (const [msgId] of valid) {
    if (explained.has(msgId)) continue;
    findings.push({
      code: "unreachable_envelope",
      message_id: msgId,
      detail: "Valid discussion/v1 envelope never connects to the canonical chain from the root",
    });
  }

  const canonicalAttempts = new Map();
  for (const [attemptId, attempt] of validAttempts) {
    if (canonicalAttemptIds.has(attemptId)) {
      canonicalAttempts.set(attemptId, attempt);
    } else if (!attemptsExplained.has(attemptId)) {
      note({
        code: "receipt_on_invalid_head",
        message_id: attempt.head_message_id,
        detail: visitedHeads.has(attempt.head_message_id)
          ? `Attempt '${attemptId}' is bound to a reached head but is not part of the continuous canonical reservation sequence`
          : `Attempt '${attemptId}' is bound to a head the canonical walk never reached from the root`,
      });
    }
  }

  const turnToAttemptIds = new Map();
  for (const attempt of validAttempts.values()) {
    if (!visitedHeads.has(attempt.head_message_id)) continue;
    if (isBeyondBudget(attempt.turn)) continue;
    const list = turnToAttemptIds.get(attempt.turn) ?? [];
    list.push(attempt.attempt_id);
    turnToAttemptIds.set(attempt.turn, list);
  }
  for (const [turn, attemptIds] of turnToAttemptIds) {
    if (attemptIds.length > 1) {
      discussionInvalid = true;
      for (const attemptId of attemptIds) {
        const attempt = validAttempts.get(attemptId);
        note({
          code: "duplicate_turn",
          message_id: attempt.head_message_id,
          detail: `Turn ${turn} is claimed by more than one validated reservation (attempt '${attemptId}')`,
        });
      }
    }
  }
  const distinctTurnsSorted = Array.from(turnToAttemptIds.keys()).sort((a, b) => a - b);
  for (let i = 0; i < distinctTurnsSorted.length; i++) {
    const expected = 2 + i;
    if (distinctTurnsSorted[i] !== expected) {
      discussionInvalid = true;
      findings.push({
        code: "ordinal_discontinuity",
        detail: `Validated reservations jump to turn ${distinctTurnsSorted[i]} without a turn ${expected} ever being reserved`,
      });
      break;
    }
  }

  const turnsUsed = 1 + canonicalAttempts.size;
  const turnsRemaining = Math.max(0, policy.max_turns - turnsUsed);
  const attempts = Array.from(canonicalAttempts.values()).map((a) => ({
    attempt_id: a.attempt_id,
    turn: a.turn,
    agent_id: a.agent_id,
    state: a.state,
    deadline: a.deadline,
    reply_message_id: a.reply_message_id,
  }));
  const status = recomputeStatus({
    invalid: discussionInvalid,
    transcript,
    rootMessageId: root.message.id,
    attempts,
    policy,
    now,
    turnsUsed,
  });

  return {
    discussion_id: discussionId,
    root_message_id: root.message.id,
    fleet_id: root.message.fleet_id,
    participants: policy.participants,
    policy,
    status,
    head_message_id: currentHead,
    turns_used: turnsUsed,
    turns_remaining: turnsRemaining,
    transcript,
    attempts,
    integrity_findings: findings,
  };
}

function rejected(errorCode) {
  return { profile: PROFILE, outcome: "rejected", error_code: errorCode };
}

function derived(discussion) {
  return {
    profile: PROFILE,
    outcome: "derived",
    discussion: {
      status: discussion.status,
      turns_used: discussion.turns_used,
      turns_remaining: discussion.turns_remaining,
      transcript_length: discussion.transcript.length,
      integrity_findings: discussion.integrity_findings.map((f) => {
        const out = { code: f.code, detail: f.detail };
        if (f.message_id !== undefined) out.message_id = f.message_id;
        return out;
      }),
    },
  };
}

export function evaluateBytes(raw) {
  try {
    const root = parseStrictDocument(raw);
    const scenario = validateScenario(root);
    const discussion = deriveDiscussion(
      scenario.discussionId,
      scenario.messages,
      scenario.receipts,
      scenario.now
    );
    return derived(discussion);
  } catch (error) {
    if (error instanceof ProfileError) return rejected(error.code);
    throw error;
  }
}
