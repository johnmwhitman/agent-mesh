import { createHash } from "node:crypto";

export const PROFILE = "meshfleet.a2a.shared-work-object.v0.1";
export const LIMITS = Object.freeze({
  maxBytes: 131072,
  maxDepth: 64,
  maxEntries: 128,
  maxLabelBytes: 256,
  maxSafeInteger: 9007199254740991,
  maxVersionComponent: 999999,
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
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
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
    const output = Object.create(null);
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
    let nonInteger = false;
    if (this.text[this.index] === ".") {
      nonInteger = true;
      this.index += 1;
      if (!/[0-9]/.test(this.text[this.index] ?? "")) reject("MALFORMED_JSON", "fraction requires a digit");
      while (/[0-9]/.test(this.text[this.index] ?? "")) this.index += 1;
    }
    if (this.text[this.index] === "e" || this.text[this.index] === "E") {
      nonInteger = true;
      this.index += 1;
      if (this.text[this.index] === "+" || this.text[this.index] === "-") this.index += 1;
      if (!/[0-9]/.test(this.text[this.index] ?? "")) reject("MALFORMED_JSON", "exponent requires a digit");
      while (/[0-9]/.test(this.text[this.index] ?? "")) this.index += 1;
    }
    const suffix = this.text[this.index];
    if (suffix !== undefined && !",]} \n\r\t".includes(suffix)) reject("MALFORMED_JSON", "invalid number suffix");
    if (nonInteger) reject("NON_CANONICAL_INTEGER", "non-integer JSON number");
    const token = this.text.slice(start, this.index);
    if (token === "-0") reject("NON_CANONICAL_INTEGER", "negative zero is not canonical");
    const value = Number(token);
    if (!Number.isSafeInteger(value)) reject("UNSAFE_INTEGER", "integer exceeds safe range");
    return value;
  }
}

export function parseStrictJson(raw) {
  if (typeof raw === "string" && !validScalarString(raw)) {
    reject("INVALID_UNICODE", "input string contains invalid Unicode");
  }
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

const MAX_OPERATIONS = 256;
const MAX_BODY_BYTES = 4096;

function object(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    reject("INVALID_FIELD", `${context} must be an object`);
  }
}

function exactFields(value, required, context) {
  object(value, context);
  const allowed = new Set(required);
  for (const field of required) {
    if (!Object.hasOwn(value, field)) reject("MISSING_FIELD", `${context}.${field} is required`);
  }
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) reject("UNKNOWN_FIELD", `${context}.${field} is unknown`);
  }
}

function label(value, context, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || !validScalarString(value)) {
    reject("INVALID_FIELD", `${context} must be a scalar string`);
  }
  if (Buffer.byteLength(value, "utf8") > LIMITS.maxLabelBytes) {
    reject("LIMIT_EXCEEDED", `${context} is too long`);
  }
}

function body(value, context) {
  if (typeof value !== "string" || !validScalarString(value)) {
    reject("INVALID_FIELD", `${context} must be a scalar string`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_BODY_BYTES) {
    reject("LIMIT_EXCEEDED", `${context} is too long`);
  }
}

function safeInteger(value, context) {
  if (!Number.isSafeInteger(value) || value < 0) {
    reject("INVALID_FIELD", `${context} must be a non-negative safe integer`);
  }
}

function jsonValue(value, context, depth = 1) {
  if (depth > LIMITS.maxDepth) reject("DEPTH_LIMIT", `${context} is too deep`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) reject("UNSAFE_INTEGER", `${context} must contain safe integers`);
    return;
  }
  if (typeof value === "string") {
    if (!validScalarString(value)) reject("INVALID_UNICODE", `${context} contains invalid Unicode`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > LIMITS.maxEntries) reject("LIMIT_EXCEEDED", `${context} has too many entries`);
    value.forEach((item, index) => jsonValue(item, `${context}[${index}]`, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > LIMITS.maxEntries) reject("LIMIT_EXCEEDED", `${context} has too many members`);
    for (const key of keys) {
      label(key, `${context} key`, true);
      jsonValue(value[key], `${context}.${key}`, depth + 1);
    }
    return;
  }
  reject("INVALID_SCENARIO", `${context} contains an unsupported value`);
}

function validateFields(value, context) {
  object(value, context);
  const keys = Object.keys(value);
  if (keys.length > LIMITS.maxEntries) reject("LIMIT_EXCEEDED", `${context} has too many fields`);
  for (const key of keys) {
    label(key, `${context} key`);
    jsonValue(value[key], `${context}.${key}`);
  }
}

function validateNotes(value, context) {
  if (!Array.isArray(value)) reject("INVALID_FIELD", `${context} must be an array`);
  if (value.length > LIMITS.maxEntries) reject("LIMIT_EXCEEDED", `${context} has too many notes`);
  const seen = new Set();
  value.forEach((note, index) => {
    const itemContext = `${context}[${index}]`;
    exactFields(note, ["note_id", "actor_label", "body"], itemContext);
    label(note.note_id, `${itemContext}.note_id`);
    label(note.actor_label, `${itemContext}.actor_label`);
    body(note.body, `${itemContext}.body`);
    if (seen.has(note.note_id)) reject("DUPLICATE_ENTRY", `${context} contains duplicate note IDs`);
    seen.add(note.note_id);
  });
}

const OPERATION_FIELDS = Object.freeze({
  set_field: ["operation_id", "actor_label", "expected_revision", "kind", "field", "value"],
  remove_field: ["operation_id", "actor_label", "expected_revision", "kind", "field"],
  append_note: ["operation_id", "actor_label", "expected_revision", "kind", "note_id", "body"],
  finalize: ["operation_id", "actor_label", "expected_revision", "kind"],
});

function validateOperation(operation, context) {
  object(operation, context);
  const kind = operation.kind;
  if (!Object.hasOwn(OPERATION_FIELDS, kind)) reject("INVALID_OPERATION", `${context}.kind is unsupported`);
  exactFields(operation, OPERATION_FIELDS[kind], context);
  label(operation.operation_id, `${context}.operation_id`);
  label(operation.actor_label, `${context}.actor_label`);
  safeInteger(operation.expected_revision, `${context}.expected_revision`);
  if (kind === "set_field") {
    label(operation.field, `${context}.field`);
    jsonValue(operation.value, `${context}.value`);
  } else if (kind === "remove_field") {
    label(operation.field, `${context}.field`);
  } else if (kind === "append_note") {
    label(operation.note_id, `${context}.note_id`);
    body(operation.body, `${context}.body`);
  }
}

export function validateScenario(scenario) {
  exactFields(scenario, ["profile", "case_id", "initial", "operations"], "scenario");
  if (scenario.profile !== PROFILE) reject("PROFILE_REJECT", "unsupported profile");
  label(scenario.case_id, "scenario.case_id");
  exactFields(scenario.initial, ["object_id", "revision", "status", "fields", "notes"], "scenario.initial");
  label(scenario.initial.object_id, "scenario.initial.object_id");
  safeInteger(scenario.initial.revision, "scenario.initial.revision");
  if (!["draft", "final"].includes(scenario.initial.status)) {
    reject("INVALID_FIELD", "scenario.initial.status is invalid");
  }
  validateFields(scenario.initial.fields, "scenario.initial.fields");
  validateNotes(scenario.initial.notes, "scenario.initial.notes");
  if (!Array.isArray(scenario.operations)) reject("INVALID_FIELD", "scenario.operations must be an array");
  if (scenario.operations.length > MAX_OPERATIONS) reject("LIMIT_EXCEEDED", "scenario.operations is too large");
  scenario.operations.forEach((operation, index) => validateOperation(operation, `scenario.operations[${index}]`));
  return scenario;
}

function clone(value) {
  return parseStrictJson(canonical(value));
}

function operationOutcome(operation, disposition, code, before, after, replayedDisposition = null, replayedCode = null) {
  return {
    operation_id: operation.operation_id,
    actor_label: operation.actor_label,
    kind: operation.kind,
    disposition,
    code,
    revision_before: before,
    revision_after: after,
    replayed_disposition: replayedDisposition,
    replayed_code: replayedCode,
  };
}

export function evaluateScenario(input) {
  const scenario = validateScenario(input);
  const inputSha256 = digest(scenario);
  const state = clone(scenario.initial);
  const noteIds = new Set(state.notes.map((note) => note.note_id));
  const seenOperations = new Map();
  const outcomes = [];

  for (const operation of scenario.operations) {
    const before = state.revision;
    const operationCanonical = canonical(operation);
    const seen = seenOperations.get(operation.operation_id);
    if (seen) {
      if (seen.operation_canonical === operationCanonical) {
        outcomes.push(operationOutcome(
          operation,
          "idempotent",
          "EXACT_REPLAY",
          before,
          before,
          seen.outcome.disposition,
          seen.outcome.code,
        ));
      } else {
        outcomes.push(operationOutcome(operation, "rejected", "OPERATION_ID_CONFLICT", before, before));
      }
      continue;
    }

    let outcome;
    if (state.status === "final") {
      outcome = operationOutcome(operation, "rejected", "OBJECT_FINAL", before, before);
    } else if (operation.expected_revision !== state.revision) {
      outcome = operationOutcome(operation, "rejected", "STALE_REVISION", before, before);
    } else if (operation.kind === "set_field") {
      if (Object.hasOwn(state.fields, operation.field)
          && canonical(state.fields[operation.field]) === canonical(operation.value)) {
        outcome = operationOutcome(operation, "rejected", "NO_CHANGE", before, before);
      } else {
        state.fields[operation.field] = clone(operation.value);
        state.revision += 1;
        outcome = operationOutcome(operation, "applied", null, before, state.revision);
      }
    } else if (operation.kind === "remove_field") {
      if (!Object.hasOwn(state.fields, operation.field)) {
        outcome = operationOutcome(operation, "rejected", "FIELD_ABSENT", before, before);
      } else {
        delete state.fields[operation.field];
        state.revision += 1;
        outcome = operationOutcome(operation, "applied", null, before, state.revision);
      }
    } else if (operation.kind === "append_note") {
      if (noteIds.has(operation.note_id)) {
        outcome = operationOutcome(operation, "rejected", "NOTE_ID_CONFLICT", before, before);
      } else {
        state.notes.push({
          note_id: operation.note_id,
          actor_label: operation.actor_label,
          body: operation.body,
        });
        noteIds.add(operation.note_id);
        state.revision += 1;
        outcome = operationOutcome(operation, "applied", null, before, state.revision);
      }
    } else {
      state.status = "final";
      state.revision += 1;
      outcome = operationOutcome(operation, "applied", null, before, state.revision);
    }
    outcomes.push(outcome);
    seenOperations.set(operation.operation_id, { operation_canonical: operationCanonical, outcome });
  }

  const summary = {
    applied: outcomes.filter((outcome) => outcome.disposition === "applied").length,
    idempotent: outcomes.filter((outcome) => outcome.disposition === "idempotent").length,
    rejected: outcomes.filter((outcome) => outcome.disposition === "rejected").length,
  };
  return {
    profile: PROFILE,
    case_id: scenario.case_id,
    input_sha256: inputSha256,
    state,
    outcomes,
    summary,
  };
}

export function evaluateBytes(raw) {
  return evaluateScenario(parseStrictJson(raw));
}

export function projection(result) {
  return {
    case_id: result.case_id,
    revision: result.state.revision,
    status: result.state.status,
    fields: result.state.fields,
    notes: result.state.notes.map((note) => [note.note_id, note.actor_label, note.body]),
    outcomes: result.outcomes.map((outcome) => [
      outcome.operation_id,
      outcome.disposition,
      outcome.code,
      outcome.revision_before,
      outcome.revision_after,
      outcome.replayed_disposition,
      outcome.replayed_code,
    ]),
    summary: result.summary,
  };
}
