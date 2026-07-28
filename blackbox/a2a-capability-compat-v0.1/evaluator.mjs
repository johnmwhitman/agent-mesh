import { createHash } from "node:crypto";

export const PROFILE = "meshfleet.a2a.capability-compat.v0.1";
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

function label(value, context) {
  if (typeof value !== "string" || value.length === 0 || !validScalarString(value)) reject("INVALID_FIELD", `${context} must be a non-empty scalar string`);
  if (Buffer.byteLength(value, "utf8") > LIMITS.maxLabelBytes) reject("LIMIT_EXCEEDED", `${context} is too long`);
}

function labelList(value, context) {
  if (!Array.isArray(value)) reject("INVALID_FIELD", `${context} must be an array`);
  if (value.length > LIMITS.maxEntries) reject("LIMIT_EXCEEDED", `${context} is too large`);
  const seen = new Set();
  value.forEach((item, index) => {
    label(item, `${context}[${index}]`);
    if (seen.has(item)) reject("DUPLICATE_ENTRY", `${context} contains duplicate labels`);
    seen.add(item);
  });
}

export function parseVersion(value, context = "version") {
  if (typeof value !== "string") reject("INVALID_VERSION", `${context} must be a string`);
  const match = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.exec(value);
  if (!match) reject("INVALID_VERSION", `${context} is outside the frozen grammar`);
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > LIMITS.maxVersionComponent)) reject("INVALID_VERSION", `${context} component exceeds limit`);
  return parts;
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function validateRange(value, context) {
  exactFields(value, ["min_inclusive", "max_exclusive"], context);
  const minimum = parseVersion(value.min_inclusive, `${context}.min_inclusive`);
  if (value.max_exclusive !== null) {
    const maximum = parseVersion(value.max_exclusive, `${context}.max_exclusive`);
    if (compareVersion(minimum, maximum) >= 0) reject("INVALID_VERSION_RANGE", `${context} must be non-empty`);
  }
}

function inRange(version, range) {
  const candidate = parseVersion(version);
  const minimum = parseVersion(range.min_inclusive);
  if (compareVersion(candidate, minimum) < 0) return false;
  if (range.max_exclusive === null) return true;
  return compareVersion(candidate, parseVersion(range.max_exclusive)) < 0;
}

function rangeText(range) {
  return range.max_exclusive === null
    ? `>=${range.min_inclusive}`
    : `>=${range.min_inclusive} <${range.max_exclusive}`;
}

function capabilityEntries(value, context, requirement) {
  if (!Array.isArray(value)) reject("INVALID_FIELD", `${context} must be an array`);
  if (value.length > LIMITS.maxEntries) reject("LIMIT_EXCEEDED", `${context} is too large`);
  const seen = new Set();
  value.forEach((entry, index) => {
    const itemContext = `${context}[${index}]`;
    exactFields(entry, ["id", requirement ? "version_range" : "version"], itemContext);
    label(entry.id, `${itemContext}.id`);
    if (seen.has(entry.id)) reject("DUPLICATE_ENTRY", `${context} contains duplicate id ${entry.id}`);
    seen.add(entry.id);
    if (requirement) validateRange(entry.version_range, `${itemContext}.version_range`);
    else parseVersion(entry.version, `${itemContext}.version`);
  });
}

function toolEntries(value, context, requirement) {
  if (!Array.isArray(value)) reject("INVALID_FIELD", `${context} must be an array`);
  if (value.length > LIMITS.maxEntries) reject("LIMIT_EXCEEDED", `${context} is too large`);
  const seen = new Set();
  value.forEach((entry, index) => {
    const itemContext = `${context}[${index}]`;
    exactFields(entry, ["id", requirement ? "version_range" : "version", "input_schema_id", "output_schema_id"], itemContext);
    for (const field of ["id", "input_schema_id", "output_schema_id"]) label(entry[field], `${itemContext}.${field}`);
    if (seen.has(entry.id)) reject("DUPLICATE_ENTRY", `${context} contains duplicate id ${entry.id}`);
    seen.add(entry.id);
    if (requirement) validateRange(entry.version_range, `${itemContext}.version_range`);
    else parseVersion(entry.version, `${itemContext}.version`);
  });
}

export function validateScenario(scenario) {
  exactFields(scenario, ["profile", "case_id", "requirement", "advertisement"], "scenario");
  if (scenario.profile !== PROFILE) reject("PROFILE_REJECT", "unsupported profile");
  label(scenario.case_id, "scenario.case_id");
  const requirement = scenario.requirement;
  exactFields(requirement, ["requester_label", "protocol", "capabilities", "interaction_modes_any", "content_types_any", "tools", "extensions"], "requirement");
  label(requirement.requester_label, "requirement.requester_label");
  exactFields(requirement.protocol, ["id", "version_range"], "requirement.protocol");
  label(requirement.protocol.id, "requirement.protocol.id");
  validateRange(requirement.protocol.version_range, "requirement.protocol.version_range");
  capabilityEntries(requirement.capabilities, "requirement.capabilities", true);
  labelList(requirement.interaction_modes_any, "requirement.interaction_modes_any");
  labelList(requirement.content_types_any, "requirement.content_types_any");
  toolEntries(requirement.tools, "requirement.tools", true);
  object(requirement.extensions, "requirement.extensions");

  const advertisement = scenario.advertisement;
  exactFields(advertisement, ["advertiser_label", "completeness", "protocol", "capabilities", "interaction_modes", "content_types", "tools", "extensions"], "advertisement");
  label(advertisement.advertiser_label, "advertisement.advertiser_label");
  if (!["complete", "partial"].includes(advertisement.completeness)) reject("INVALID_FIELD", "advertisement.completeness is invalid");
  exactFields(advertisement.protocol, ["id", "version"], "advertisement.protocol");
  label(advertisement.protocol.id, "advertisement.protocol.id");
  parseVersion(advertisement.protocol.version, "advertisement.protocol.version");
  capabilityEntries(advertisement.capabilities, "advertisement.capabilities", false);
  labelList(advertisement.interaction_modes, "advertisement.interaction_modes");
  labelList(advertisement.content_types, "advertisement.content_types");
  toolEntries(advertisement.tools, "advertisement.tools", false);
  object(advertisement.extensions, "advertisement.extensions");
  return scenario;
}

function fact(code, path, expected, actual, certainty) {
  return { code, path, expected, actual, certainty };
}

function factCompare(left, right) {
  for (const field of ["code", "path", "expected", "actual", "certainty"]) {
    const a = left[field] ?? "";
    const b = right[field] ?? "";
    const comparison = scalarCompare(a, b);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function sortedIntersection(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item)).sort(scalarCompare);
}

export function evaluateScenario(input) {
  const scenario = validateScenario(input);
  const requirement = scenario.requirement;
  const advertisement = scenario.advertisement;
  const partial = advertisement.completeness === "partial";
  const mismatches = [];
  const matchedCapabilities = [];
  const matchedTools = [];

  if (requirement.protocol.id !== advertisement.protocol.id) {
    mismatches.push(fact("PROTOCOL_ID_MISMATCH", "advertisement.protocol.id", requirement.protocol.id, advertisement.protocol.id, "definite"));
  }
  if (!inRange(advertisement.protocol.version, requirement.protocol.version_range)) {
    mismatches.push(fact("PROTOCOL_VERSION_MISMATCH", "advertisement.protocol.version", rangeText(requirement.protocol.version_range), advertisement.protocol.version, "definite"));
  }

  const advertisedCapabilities = new Map(advertisement.capabilities.map((entry) => [entry.id, entry]));
  for (const required of requirement.capabilities) {
    const advertised = advertisedCapabilities.get(required.id);
    if (!advertised) {
      mismatches.push(fact(
        partial ? "CAPABILITY_UNDECLARED" : "CAPABILITY_MISSING",
        "advertisement.capabilities",
        required.id,
        null,
        partial ? "unknown" : "definite",
      ));
    } else if (!inRange(advertised.version, required.version_range)) {
      mismatches.push(fact("CAPABILITY_VERSION_MISMATCH", `advertisement.capabilities[${required.id}].version`, rangeText(required.version_range), advertised.version, "definite"));
    } else {
      matchedCapabilities.push(required.id);
    }
  }

  const matchedModes = sortedIntersection(requirement.interaction_modes_any, advertisement.interaction_modes);
  if (requirement.interaction_modes_any.length > 0 && matchedModes.length === 0) {
    mismatches.push(fact(
      partial ? "INTERACTION_MODE_UNDECLARED" : "INTERACTION_MODE_MISSING",
      "advertisement.interaction_modes",
      [...requirement.interaction_modes_any].sort(scalarCompare).join(","),
      [...advertisement.interaction_modes].sort(scalarCompare).join(","),
      partial ? "unknown" : "definite",
    ));
  }

  const matchedContentTypes = sortedIntersection(requirement.content_types_any, advertisement.content_types);
  if (requirement.content_types_any.length > 0 && matchedContentTypes.length === 0) {
    mismatches.push(fact(
      partial ? "CONTENT_TYPE_UNDECLARED" : "CONTENT_TYPE_MISSING",
      "advertisement.content_types",
      [...requirement.content_types_any].sort(scalarCompare).join(","),
      [...advertisement.content_types].sort(scalarCompare).join(","),
      partial ? "unknown" : "definite",
    ));
  }

  const advertisedTools = new Map(advertisement.tools.map((entry) => [entry.id, entry]));
  for (const required of requirement.tools) {
    const advertised = advertisedTools.get(required.id);
    if (!advertised) {
      mismatches.push(fact(
        partial ? "TOOL_UNDECLARED" : "TOOL_MISSING",
        "advertisement.tools",
        required.id,
        null,
        partial ? "unknown" : "definite",
      ));
      continue;
    }
    let matched = true;
    if (!inRange(advertised.version, required.version_range)) {
      mismatches.push(fact("TOOL_VERSION_MISMATCH", `advertisement.tools[${required.id}].version`, rangeText(required.version_range), advertised.version, "definite"));
      matched = false;
    }
    if (advertised.input_schema_id !== required.input_schema_id) {
      mismatches.push(fact("TOOL_INPUT_SCHEMA_MISMATCH", `advertisement.tools[${required.id}].input_schema_id`, required.input_schema_id, advertised.input_schema_id, "definite"));
      matched = false;
    }
    if (advertised.output_schema_id !== required.output_schema_id) {
      mismatches.push(fact("TOOL_OUTPUT_SCHEMA_MISMATCH", `advertisement.tools[${required.id}].output_schema_id`, required.output_schema_id, advertised.output_schema_id, "definite"));
      matched = false;
    }
    if (matched) matchedTools.push(required.id);
  }

  mismatches.sort(factCompare);
  const reasons = [...new Set(mismatches.map((item) => item.code))].sort(scalarCompare);
  const result = mismatches.some((item) => item.certainty === "definite")
    ? "incompatible"
    : mismatches.length > 0 ? "indeterminate" : "compatible";
  return {
    profile: PROFILE,
    case_id: scenario.case_id,
    result,
    reasons,
    mismatches,
    normalized: {
      requester_label: requirement.requester_label,
      advertiser_label: advertisement.advertiser_label,
      matched_capability_ids: matchedCapabilities.sort(scalarCompare),
      matched_interaction_modes: matchedModes,
      matched_content_types: matchedContentTypes,
      matched_tool_ids: matchedTools.sort(scalarCompare),
    },
    input_sha256: digest(scenario),
  };
}

export function evaluateBytes(raw) {
  return evaluateScenario(parseStrictJson(raw));
}

export function projection(result) {
  return {
    case_id: result.case_id,
    result: result.result,
    reasons: result.reasons,
    mismatch_facts: result.mismatches.map((item) =>
      [item.code, item.path, item.expected ?? "", item.actual ?? "", item.certainty].join("|")),
    requester_label: result.normalized.requester_label,
    advertiser_label: result.normalized.advertiser_label,
    matched_capability_ids: result.normalized.matched_capability_ids,
    matched_interaction_modes: result.normalized.matched_interaction_modes,
    matched_content_types: result.normalized.matched_content_types,
    matched_tool_ids: result.normalized.matched_tool_ids,
  };
}
