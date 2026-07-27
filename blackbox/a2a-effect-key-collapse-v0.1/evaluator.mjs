export const PROFILE = "meshfleet.a2a.effect-key-collapse.v0.1";
export const LIMITS = Object.freeze({
  maxBytes: 65536,
  maxDepth: 16,
  maxDeclarations: 64,
  maxSafeInteger: 9007199254740991,
});

export class ConformanceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new ConformanceError(code);
}

function isDelimiter(character) {
  return character === undefined || ",]} \n\r\t".includes(character);
}

class StrictParser {
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  whitespace() {
    while (this.index < this.text.length && " \n\r\t".includes(this.text[this.index])) this.index += 1;
  }

  parse() {
    this.whitespace();
    const value = this.value(1);
    this.whitespace();
    if (this.index !== this.text.length) fail("MALFORMED_JSON");
    return value;
  }

  value(depth) {
    this.whitespace();
    const character = this.text[this.index];
    if (character === "{") return this.object(depth);
    if (character === "[") return this.array(depth);
    if (character === '"') return this.string();
    if (character === "-" || (character >= "0" && character <= "9")) return this.number();
    if (this.text.startsWith("true", this.index)) {
      this.index += 4;
      return true;
    }
    if (this.text.startsWith("false", this.index)) {
      this.index += 5;
      return false;
    }
    if (this.text.startsWith("null", this.index)) {
      this.index += 4;
      return null;
    }
    fail("MALFORMED_JSON");
  }

  object(depth) {
    if (depth > LIMITS.maxDepth) fail("JSON_DEPTH_LIMIT");
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
      if (this.text[this.index] !== '"') fail("MALFORMED_JSON");
      const key = this.string();
      this.whitespace();
      if (this.text[this.index] !== ":") fail("MALFORMED_JSON");
      this.index += 1;
      const value = this.value(depth + 1);
      if (seen.has(key)) fail("DUPLICATE_JSON_KEY");
      seen.add(key);
      output[key] = value;
      this.whitespace();
      const separator = this.text[this.index];
      if (separator === "}") {
        this.index += 1;
        return output;
      }
      if (separator !== ",") fail("MALFORMED_JSON");
      this.index += 1;
    }
  }

  array(depth) {
    if (depth > LIMITS.maxDepth) fail("JSON_DEPTH_LIMIT");
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
      if (separator !== ",") fail("MALFORMED_JSON");
      this.index += 1;
    }
  }

  string() {
    if (this.text[this.index] !== '"') fail("MALFORMED_JSON");
    this.index += 1;
    let output = "";
    while (this.index < this.text.length) {
      const character = this.text[this.index++];
      if (character === '"') return output;
      if (character === "\\") {
        const escape = this.text[this.index++];
        if (escape === '"' || escape === "\\" || escape === "/") output += escape;
        else if (escape === "b") output += "\b";
        else if (escape === "f") output += "\f";
        else if (escape === "n") output += "\n";
        else if (escape === "r") output += "\r";
        else if (escape === "t") output += "\t";
        else if (escape === "u") {
          const digits = this.text.slice(this.index, this.index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) fail("MALFORMED_JSON");
          output += String.fromCharCode(Number.parseInt(digits, 16));
          this.index += 4;
        } else fail("MALFORMED_JSON");
      } else {
        if (character.charCodeAt(0) < 0x20) fail("MALFORMED_JSON");
        output += character;
      }
    }
    fail("MALFORMED_JSON");
  }

  number() {
    const start = this.index;
    if (this.text[this.index] === "-") this.index += 1;
    if (this.text[this.index] === "0") {
      this.index += 1;
      if (/[0-9]/.test(this.text[this.index] ?? "")) fail("MALFORMED_JSON");
    } else {
      if (!/[1-9]/.test(this.text[this.index] ?? "")) fail("MALFORMED_JSON");
      while (/[0-9]/.test(this.text[this.index] ?? "")) this.index += 1;
    }
    if (this.text[this.index] === "." || this.text[this.index] === "e" || this.text[this.index] === "E") {
      fail("NON_CANONICAL_INTEGER");
    }
    if (!isDelimiter(this.text[this.index])) fail("MALFORMED_JSON");
    const token = this.text.slice(start, this.index);
    if (token === "-0") fail("NON_CANONICAL_INTEGER");
    const value = Number(token);
    if (!Number.isSafeInteger(value) || Math.abs(value) > LIMITS.maxSafeInteger) fail("UNSAFE_INTEGER");
    return value;
  }
}

function bytesOf(raw) {
  if (typeof raw === "string") return new TextEncoder().encode(raw);
  if (raw instanceof Uint8Array) return raw;
  return new Uint8Array(raw);
}

function validScalarString(value) {
  if (typeof value !== "string") return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
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

function parseStrictJson(raw) {
  const bytes = bytesOf(raw);
  if (bytes.length > LIMITS.maxBytes) fail("DOCUMENT_TOO_LARGE");
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail("BOM_NOT_ALLOWED");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("INVALID_UTF8");
  }
  const parsed = new StrictParser(text).parse();
  validateUnicode(parsed);
  return parsed;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactFields(value, required, objectCode, unknownCode, missingCode) {
  if (!isPlainObject(value)) fail(objectCode);
  const allowed = new Set(required);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(unknownCode);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(missingCode);
}

function asciiCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateAndClassify(input) {
  exactFields(input, ["profile", "declarations"], "ROOT_NOT_OBJECT", "UNKNOWN_ROOT_FIELD", "MISSING_ROOT_FIELD");
  if (typeof input.profile !== "string") fail("INVALID_PROFILE_TYPE");
  if (!Array.isArray(input.declarations)) fail("DECLARATIONS_NOT_ARRAY");
  if (input.profile !== PROFILE) fail("UNSUPPORTED_PROFILE");
  if (input.declarations.length > LIMITS.maxDeclarations) fail("DECLARATION_COUNT_LIMIT");
  const grouped = new Map();
  for (const declaration of input.declarations) {
    exactFields(declaration, ["effect_key", "effect_digest"], "DECLARATION_NOT_OBJECT", "UNKNOWN_DECLARATION_FIELD", "MISSING_DECLARATION_FIELD");
    if (typeof declaration.effect_key !== "string") fail("INVALID_EFFECT_KEY_TYPE");
    if (typeof declaration.effect_digest !== "string") fail("INVALID_EFFECT_DIGEST_TYPE");
    if (new TextEncoder().encode(declaration.effect_key).length > 128) fail("EFFECT_KEY_TOO_LONG");
    if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(declaration.effect_key)) fail("INVALID_EFFECT_KEY");
    if (!/^[0-9a-f]{64}$/.test(declaration.effect_digest)) fail("INVALID_EFFECT_DIGEST");
    let digests = grouped.get(declaration.effect_key);
    if (!digests) {
      digests = new Map();
      grouped.set(declaration.effect_key, digests);
    }
    digests.set(declaration.effect_digest, (digests.get(declaration.effect_digest) ?? 0) + 1);
  }
  const groups = [...grouped.entries()].sort(([left], [right]) => asciiCompare(left, right)).map(([effectKey, digests]) => ({
    effect_key: effectKey,
    classification: digests.size === 1 ? "single_digest" : "digest_conflict",
    digests: [...digests.entries()].sort(([left], [right]) => asciiCompare(left, right)).map(([effectDigest, declarationCount]) => ({
      effect_digest: effectDigest,
      declaration_count: declarationCount,
    })),
  }));
  return { profile: PROFILE, outcome: "classified", groups };
}

export function classifyEffectKeyDeclarations(rawUtf8JsonBytes) {
  try {
    return validateAndClassify(parseStrictJson(rawUtf8JsonBytes));
  } catch (error) {
    if (error instanceof ConformanceError) return { profile: PROFILE, outcome: "rejected", error_code: error.code };
    throw error;
  }
}

export const evaluateBytes = classifyEffectKeyDeclarations;
