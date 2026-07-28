import { createHash } from "node:crypto";

export const PROFILE = "meshfleet.a2a.artifact-bundle-integrity.v0.1";
export const LIMITS = Object.freeze({
  MAX_DOCUMENT_BYTES: 12 * 1024 * 1024,
  MAX_JSON_DEPTH: 16,
  MAX_ARTIFACTS: 128,
  MAX_ARTIFACT_ID_BYTES: 64,
  MAX_LOGICAL_NAME_BYTES: 255,
  MAX_ENCODED_BYTES_PER_ARTIFACT: 1_398_104,
  MAX_DECODED_BYTES_PER_ARTIFACT: 1_048_576,
  MAX_TOTAL_DECODED_BYTES: 8 * 1024 * 1024,
  MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
});

class ProfileError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

class JsonNumber {
  constructor(value, lexeme) {
    this.value = value;
    this.lexeme = lexeme;
  }
}

function fail(code) {
  throw new ProfileError(code);
}

function isWhitespace(ch) {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
}

class StrictJsonParser {
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  parse() {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) fail("MALFORMED_JSON");
    return value;
  }

  skipWhitespace() {
    while (this.index < this.text.length && isWhitespace(this.text[this.index])) this.index += 1;
  }

  parseValue(depth) {
    this.skipWhitespace();
    const ch = this.text[this.index];
    if (ch === "{") return this.parseObject(depth + 1);
    if (ch === "[") return this.parseArray(depth + 1);
    if (ch === '"') return this.parseString();
    if (ch === "t" && this.consumeLiteral("true")) return true;
    if (ch === "f" && this.consumeLiteral("false")) return false;
    if (ch === "n" && this.consumeLiteral("null")) return null;
    if (ch === "-" || (ch >= "0" && ch <= "9")) return this.parseNumber();
    fail("MALFORMED_JSON");
  }

  consumeLiteral(literal) {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) return false;
    this.index += literal.length;
    return true;
  }

  parseObject(depth) {
    if (depth > LIMITS.MAX_JSON_DEPTH) fail("JSON_DEPTH_LIMIT");
    this.index += 1;
    this.skipWhitespace();
    const object = Object.create(null);
    if (this.text[this.index] === "}") {
      this.index += 1;
      return object;
    }
    for (;;) {
      if (this.text[this.index] !== '"') fail("MALFORMED_JSON");
      const key = this.parseString();
      if (Object.prototype.hasOwnProperty.call(object, key)) fail("DUPLICATE_JSON_KEY");
      this.skipWhitespace();
      if (this.text[this.index] !== ":") fail("MALFORMED_JSON");
      this.index += 1;
      object[key] = this.parseValue(depth);
      this.skipWhitespace();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return object;
      }
      if (this.text[this.index] !== ",") fail("MALFORMED_JSON");
      this.index += 1;
      this.skipWhitespace();
    }
  }

  parseArray(depth) {
    if (depth > LIMITS.MAX_JSON_DEPTH) fail("JSON_DEPTH_LIMIT");
    this.index += 1;
    this.skipWhitespace();
    const array = [];
    if (this.text[this.index] === "]") {
      this.index += 1;
      return array;
    }
    for (;;) {
      array.push(this.parseValue(depth));
      this.skipWhitespace();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return array;
      }
      if (this.text[this.index] !== ",") fail("MALFORMED_JSON");
      this.index += 1;
      this.skipWhitespace();
    }
  }

  parseString() {
    this.index += 1;
    let output = "";
    while (this.index < this.text.length) {
      const ch = this.text[this.index++];
      if (ch === '"') return output;
      const code = ch.charCodeAt(0);
      if (code < 0x20) fail("MALFORMED_JSON");
      if (ch !== "\\") {
        if (code >= 0xd800 && code <= 0xdfff) fail("INVALID_UNICODE");
        output += ch;
        continue;
      }
      const escape = this.text[this.index++];
      if (escape === '"' || escape === "\\" || escape === "/") output += escape;
      else if (escape === "b") output += "\b";
      else if (escape === "f") output += "\f";
      else if (escape === "n") output += "\n";
      else if (escape === "r") output += "\r";
      else if (escape === "t") output += "\t";
      else if (escape === "u") output += this.parseUnicodeEscape();
      else fail("MALFORMED_JSON");
    }
    fail("MALFORMED_JSON");
  }

  parseUnicodeEscape() {
    const first = this.readHexCodeUnit();
    if (first >= 0xdc00 && first <= 0xdfff) fail("INVALID_UNICODE");
    if (first < 0xd800 || first > 0xdbff) return String.fromCharCode(first);
    if (this.text.slice(this.index, this.index + 2) !== "\\u") fail("INVALID_UNICODE");
    this.index += 2;
    const second = this.readHexCodeUnit();
    if (second < 0xdc00 || second > 0xdfff) fail("INVALID_UNICODE");
    return String.fromCodePoint(0x10000 + ((first - 0xd800) << 10) + second - 0xdc00);
  }

  readHexCodeUnit() {
    const token = this.text.slice(this.index, this.index + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(token)) fail("MALFORMED_JSON");
    this.index += 4;
    return Number.parseInt(token, 16);
  }

  parseNumber() {
    const start = this.index;
    if (this.text[this.index] === "-") this.index += 1;
    if (this.text[this.index] === "0") this.index += 1;
    else {
      if (!(this.text[this.index] >= "1" && this.text[this.index] <= "9")) fail("MALFORMED_JSON");
      while (this.text[this.index] >= "0" && this.text[this.index] <= "9") this.index += 1;
    }
    if (this.text[this.index] === "." || this.text[this.index] === "e" || this.text[this.index] === "E") fail("NON_CANONICAL_INTEGER");
    const lexeme = this.text.slice(start, this.index);
    if (lexeme === "-0") fail("NON_CANONICAL_INTEGER");
    let integer;
    try {
      integer = BigInt(lexeme);
    } catch {
      fail("MALFORMED_JSON");
    }
    if (integer > BigInt(LIMITS.MAX_SAFE_INTEGER) || integer < -BigInt(LIMITS.MAX_SAFE_INTEGER)) fail("UNSAFE_INTEGER");
    return new JsonNumber(Number(integer), lexeme);
  }
}

function parseRawJson(rawBytes) {
  const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
  if (bytes.byteLength > LIMITS.MAX_DOCUMENT_BYTES) fail("DOCUMENT_TOO_LARGE");
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail("BOM_NOT_ALLOWED");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail("INVALID_UTF8");
  }
  return new StrictJsonParser(text).parse();
}

function ownKeys(value) {
  return Object.keys(value);
}

function assertExactObject(value, expected, objectCode) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || value instanceof JsonNumber) fail(`${objectCode}_NOT_OBJECT`);
  for (const key of ownKeys(value)) if (!expected.includes(key)) fail(`UNKNOWN_${objectCode}_FIELD`);
  for (const key of expected) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`MISSING_${objectCode}_FIELD`);
}

function assertString(value, field) {
  if (typeof value !== "string") fail(`INVALID_${field}_TYPE`);
  return value;
}

function assertByteLength(value, max, code) {
  if (Buffer.byteLength(value, "utf8") > max) fail(code);
}

function decodeCanonicalBase64(value) {
  if (value.length > LIMITS.MAX_ENCODED_BYTES_PER_ARTIFACT) fail("BASE64_TOO_LONG");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) fail("INVALID_BASE64");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const nonPaddingLength = value.length - padding;
  if ((padding === 1 && nonPaddingLength % 4 !== 3) || (padding === 2 && nonPaddingLength % 4 !== 2)) fail("INVALID_BASE64");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) fail("NON_CANONICAL_BASE64");
  if (decoded.byteLength > LIMITS.MAX_DECODED_BYTES_PER_ARTIFACT) fail("DECODED_BYTE_LENGTH_LIMIT");
  return decoded;
}

function validateArtifact(value) {
  assertExactObject(value, ["artifact_id", "logical_name", "content_base64", "decoded_byte_length", "sha256"], "ARTIFACT");
  const artifactId = assertString(value.artifact_id, "ARTIFACT_ID");
  const logicalName = assertString(value.logical_name, "LOGICAL_NAME");
  const contentBase64 = assertString(value.content_base64, "CONTENT_BASE64");
  if (!(value.decoded_byte_length instanceof JsonNumber)) fail("INVALID_DECODED_BYTE_LENGTH_TYPE");
  const sha256 = assertString(value.sha256, "SHA256");

  assertByteLength(artifactId, LIMITS.MAX_ARTIFACT_ID_BYTES, "ARTIFACT_ID_TOO_LONG");
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(artifactId)) fail("INVALID_ARTIFACT_ID");
  assertByteLength(logicalName, LIMITS.MAX_LOGICAL_NAME_BYTES, "LOGICAL_NAME_TOO_LONG");
  if (!/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(logicalName)) fail("INVALID_LOGICAL_NAME");
  if (logicalName.split("/").some((segment) => segment === "." || segment === "..")) fail("INVALID_LOGICAL_NAME");
  const decoded = decodeCanonicalBase64(contentBase64);
  if (!/^(?:0|[1-9][0-9]*)$/.test(value.decoded_byte_length.lexeme) || value.decoded_byte_length.value > LIMITS.MAX_DECODED_BYTES_PER_ARTIFACT) fail("INVALID_DECODED_BYTE_LENGTH");
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail("INVALID_SHA256");
  return { artifact_id: artifactId, logical_name: logicalName, content_base64: contentBase64, declared: value.decoded_byte_length.value, sha256, decoded };
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function rejected(code) {
  return { profile: PROFILE, outcome: "rejected", error_code: code };
}

function verified(entries, total) {
  const artifacts = entries
    .map((entry) => ({ artifact_id: entry.artifact_id, logical_name: entry.logical_name, decoded_byte_length: entry.decoded.byteLength, sha256: entry.sha256 }))
    .sort((left, right) => (left.logical_name < right.logical_name ? -1 : left.logical_name > right.logical_name ? 1 : left.artifact_id < right.artifact_id ? -1 : left.artifact_id > right.artifact_id ? 1 : 0));
  return { profile: PROFILE, outcome: "verified", artifact_count: artifacts.length, total_decoded_bytes: total, artifacts };
}

export function evaluateArtifactBundleIntegrity(rawBytes) {
  try {
    const root = parseRawJson(rawBytes);
    assertExactObject(root, ["profile", "artifacts"], "ROOT");
    if (root.profile !== PROFILE) fail("UNSUPPORTED_PROFILE");
    if (!Array.isArray(root.artifacts)) fail("ARTIFACTS_NOT_ARRAY");
    if (root.artifacts.length > LIMITS.MAX_ARTIFACTS) fail("ARTIFACT_COUNT_LIMIT");
    const entries = root.artifacts.map(validateArtifact);
    const ids = new Set();
    for (const entry of entries) {
      if (ids.has(entry.artifact_id)) fail("DUPLICATE_ARTIFACT_ID");
      ids.add(entry.artifact_id);
    }
    const names = new Set();
    for (const entry of entries) {
      if (names.has(entry.logical_name)) fail("DUPLICATE_LOGICAL_NAME");
      names.add(entry.logical_name);
    }
    const declaredTotal = entries.reduce((sum, entry) => sum + entry.declared, 0);
    if (declaredTotal > LIMITS.MAX_TOTAL_DECODED_BYTES) fail("TOTAL_DECODED_BYTES_LIMIT");
    for (const entry of entries) if (entry.decoded.byteLength !== entry.declared) fail("DECODED_BYTE_LENGTH_MISMATCH");
    for (const entry of entries) if (createHash("sha256").update(entry.decoded).digest("hex") !== entry.sha256) fail("SHA256_MISMATCH");
    return canonicalJson(verified(entries, declaredTotal));
  } catch (error) {
    return canonicalJson(rejected(error instanceof ProfileError ? error.code : "MALFORMED_JSON"));
  }
}

export function canonicalOutput(value) {
  return canonicalJson(value);
}
