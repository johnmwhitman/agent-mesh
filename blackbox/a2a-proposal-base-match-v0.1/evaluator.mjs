export const PROFILE = "meshfleet.a2a.proposal-base-match.v0.1";
export const LIMITS = Object.freeze({
  MAX_DOCUMENT_BYTES: 65536,
  MAX_JSON_DEPTH: 16,
  MAX_PROPOSALS: 32,
  MAX_TOKEN_UTF8_BYTES: 128,
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

function whitespace(ch) {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
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
    while (this.index < this.text.length && whitespace(this.text[this.index])) this.index += 1;
  }

  value(depth) {
    this.skip();
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
      const code = ch.charCodeAt(0);
      if (code < 0x20) fail("MALFORMED_JSON");
      if (ch !== "\\") {
        output += ch;
        continue;
      }
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
    return String.fromCodePoint(0x10000 + ((first - 0xd800) << 10) + second - 0xdc00);
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

function validateUnicode(value) {
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail("INVALID_UNICODE");
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        fail("INVALID_UNICODE");
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) validateUnicode(item);
  } else if (value && typeof value === "object" && !(value instanceof JsonNumber)) {
    for (const [key, item] of Object.entries(value)) {
      validateUnicode(key);
      validateUnicode(item);
    }
  }
}

function parseRawJson(raw) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength > LIMITS.MAX_DOCUMENT_BYTES) fail("DOCUMENT_TOO_LARGE");
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail("BOM_NOT_ALLOWED");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
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

function exactObject(value, fields, kind) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || value instanceof JsonNumber) fail(`${kind}_NOT_OBJECT`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) fail(`UNKNOWN_${kind}_FIELD`);
  for (const key of fields) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`MISSING_${kind}_FIELD`);
}

function text(value, code) {
  if (typeof value !== "string") fail(code);
  return value;
}

function token(value, lengthCode, grammarCode) {
  if (Buffer.byteLength(value, "utf8") > LIMITS.MAX_TOKEN_UTF8_BYTES) fail(lengthCode);
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) fail(grammarCode);
  return value;
}

function rejected(errorCode) {
  return { profile: PROFILE, outcome: "rejected", error_code: errorCode };
}

function sortedAscii(ids) {
  return [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function classified(classification, matching, nonmatching) {
  return {
    profile: PROFILE,
    outcome: "classified",
    classification,
    matching_proposal_ids: sortedAscii(matching),
    nonmatching_proposal_ids: sortedAscii(nonmatching),
  };
}

export function evaluateProposalBaseMatch(rawUtf8JsonBytes) {
  try {
    const root = parseRawJson(rawUtf8JsonBytes);
    exactObject(root, ["profile", "comparison_revision", "proposals"], "ROOT");
    const profile = text(root.profile, "INVALID_PROFILE_TYPE");
    const comparisonRevision = text(root.comparison_revision, "INVALID_COMPARISON_REVISION_TYPE");
    if (!Array.isArray(root.proposals)) fail("PROPOSALS_NOT_ARRAY");
    if (profile !== PROFILE) fail("UNSUPPORTED_PROFILE");
    token(comparisonRevision, "COMPARISON_REVISION_TOO_LONG", "INVALID_COMPARISON_REVISION");
    if (root.proposals.length > LIMITS.MAX_PROPOSALS) fail("PROPOSAL_COUNT_LIMIT");

    const proposals = [];
    for (const rawProposal of root.proposals) {
      exactObject(rawProposal, ["proposal_id", "base_revision"], "PROPOSAL");
      const proposalId = text(rawProposal.proposal_id, "INVALID_PROPOSAL_ID_TYPE");
      const baseRevision = text(rawProposal.base_revision, "INVALID_BASE_REVISION_TYPE");
      proposals.push({
        proposal_id: token(proposalId, "PROPOSAL_ID_TOO_LONG", "INVALID_PROPOSAL_ID"),
        base_revision: token(baseRevision, "BASE_REVISION_TOO_LONG", "INVALID_BASE_REVISION"),
      });
    }

    const seen = new Set();
    for (const proposal of proposals) {
      if (seen.has(proposal.proposal_id)) fail("DUPLICATE_PROPOSAL_ID");
      seen.add(proposal.proposal_id);
    }

    const matching = proposals.filter((proposal) => proposal.base_revision === comparisonRevision).map((proposal) => proposal.proposal_id);
    const nonmatching = proposals.filter((proposal) => proposal.base_revision !== comparisonRevision).map((proposal) => proposal.proposal_id);
    if (proposals.length === 0) return classified("empty", matching, nonmatching);
    if (matching.length === 1 && nonmatching.length === 0) return classified("single_match", matching, nonmatching);
    if (matching.length >= 2 && nonmatching.length === 0) return classified("multiple_match", matching, nonmatching);
    if (matching.length === 0) return classified("no_match", matching, nonmatching);
    return classified("mixed_match", matching, nonmatching);
  } catch (error) {
    if (error instanceof ProfileError) return rejected(error.code);
    throw error;
  }
}
