import {
  FLEETBUDGET_SNAPSHOT_VERSION,
  type FleetBudgetLane,
  type FleetBudgetSnapshot,
} from "./fleetbudget-observations.js";

const MAX_REPORT_BYTES = 1_048_576;
const MAX_JSON_DEPTH = 64;
const MAX_ITEMS = 256;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_UNIT_LENGTH = 64;
const MAX_FREE_TEXT_LENGTH = 4_096;
const DEFAULT_TTL_MS = 300_000;
const MAX_TTL_MS = 600_000;
const UNIT_TOKEN = /^[a-z0-9][a-z0-9._:-]*$/;

const INPUT_KEYS = [
  "report_bytes",
  "collection_started_at_ms",
  "collection_finished_at_ms",
  "now_ms",
  "ttl_ms",
] as const;
const REQUIRED_INPUT_KEYS = [
  "report_bytes",
  "collection_started_at_ms",
  "collection_finished_at_ms",
  "now_ms",
] as const;
const REPORT_KEYS = ["generated", "lanes", "routes"] as const;
const LANE_KEYS = [
  "lane",
  "measured",
  "used",
  "total",
  "unit",
  "utilization",
  "state",
  "note",
  "detail",
] as const;
const ROUTE_KEYS = [
  "agentic-build",
  "breadth",
  "bulk",
  "design",
  "judgment",
  "media-audio",
  "media-image",
  "media-video",
  "research",
  "verdict",
] as const;
const STATES = new Set(["OK", "WARN", "LOW", "EXHAUSTED", "UNMEASURED"]);

type JsonRecord = Record<string, unknown>;

export interface SanitizeFleetBudgetReportInput {
  report_bytes: Uint8Array;
  collection_started_at_ms: number;
  collection_finished_at_ms: number;
  now_ms: number;
  ttl_ms?: number;
}

export type FleetBudgetSanitizerErrorCode =
  | "input_too_large"
  | "invalid_utf8"
  | "invalid_json"
  | "input_read_failed"
  | "invalid_input"
  | "report_schema_drift"
  | "invalid_report"
  | "future_report"
  | "stale_report";

export class FleetBudgetSanitizerError extends Error {
  readonly code: FleetBudgetSanitizerErrorCode;
  readonly path?: string;

  constructor(code: FleetBudgetSanitizerErrorCode, path?: string) {
    super(
      path === undefined
        ? `fleetbudget sanitizer rejected ${code}`
        : `fleetbudget sanitizer rejected ${code} at ${path}`,
    );
    this.name = "FleetBudgetSanitizerError";
    this.code = code;
    this.path = path;
  }
}

function reject(code: FleetBudgetSanitizerErrorCode, path?: string): never {
  throw new FleetBudgetSanitizerError(code, path);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function scalarLength(value: string): number {
  let length = 0;
  for (const _scalar of value) length += 1;
  return length;
}

function validateRawNumberLexeme(token: string): void {
  const parsed = Number(token);
  if (!Number.isFinite(parsed)) reject("invalid_json");

  const unsigned = token.startsWith("-") ? token.slice(1) : token;
  const exponentIndex = unsigned.search(/[eE]/);
  const mantissa = exponentIndex === -1 ? unsigned : unsigned.slice(0, exponentIndex);
  const exponent = exponentIndex === -1 ? 0 : Number(unsigned.slice(exponentIndex + 1));
  const dotIndex = mantissa.indexOf(".");
  const fractionLength = dotIndex === -1 ? 0 : mantissa.length - dotIndex - 1;
  const coefficient = mantissa.replace(".", "").replace(/^0+/, "");
  if (coefficient.length === 0) return;

  const scale = exponent - fractionLength;
  let exactIntegerDigits: string | undefined;
  if (scale >= 0) {
    if (!Number.isSafeInteger(scale) || coefficient.length + scale > 16) {
      reject("invalid_json");
    }
    exactIntegerDigits = coefficient + "0".repeat(scale);
  } else {
    const requiredTrailingZeros = -scale;
    let trailingZeros = 0;
    while (
      trailingZeros < coefficient.length
      && coefficient[coefficient.length - trailingZeros - 1] === "0"
    ) {
      trailingZeros += 1;
    }
    if (
      Number.isSafeInteger(requiredTrailingZeros)
      && requiredTrailingZeros <= trailingZeros
    ) {
      exactIntegerDigits =
        coefficient.slice(0, coefficient.length - requiredTrailingZeros) || "0";
    }
  }

  if (exactIntegerDigits !== undefined) {
    const normalized = exactIntegerDigits.replace(/^0+/, "") || "0";
    if (
      normalized.length > 16
      || (normalized.length === 16 && BigInt(normalized) > 9_007_199_254_740_991n)
    ) {
      reject("invalid_json");
    }
  } else if (Number.isInteger(parsed)) {
    reject("invalid_json");
  }
}

class StrictJsonScanner {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): void {
    this.skipWhitespace();
    this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) this.invalid();
  }

  private invalid(): never {
    reject("invalid_json");
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
      this.index += 1;
    }
  }

  private parseValue(depth: number): void {
    const character = this.source[this.index];
    if (character === "{") {
      if (depth >= MAX_JSON_DEPTH) this.invalid();
      this.parseObject(depth + 1);
      return;
    }
    if (character === "[") {
      if (depth >= MAX_JSON_DEPTH) this.invalid();
      this.parseArray(depth + 1);
      return;
    }
    if (character === "\"") {
      this.parseString();
      return;
    }
    if (character === "t") {
      this.literal("true");
      return;
    }
    if (character === "f") {
      this.literal("false");
      return;
    }
    if (character === "n") {
      this.literal("null");
      return;
    }
    if (
      character === "-"
      || (character !== undefined && character >= "0" && character <= "9")
    ) {
      this.parseNumber();
      return;
    }
    this.invalid();
  }

  private parseObject(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    const keys = new Set<string>();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return;
    }
    while (true) {
      if (this.source[this.index] !== "\"") this.invalid();
      const key = this.parseString();
      if (keys.has(key)) this.invalid();
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.index] !== ":") this.invalid();
      this.index += 1;
      this.skipWhitespace();
      this.parseValue(depth);
      this.skipWhitespace();
      if (this.source[this.index] === "}") {
        this.index += 1;
        return;
      }
      if (this.source[this.index] !== ",") this.invalid();
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return;
    }
    while (true) {
      this.parseValue(depth);
      this.skipWhitespace();
      if (this.source[this.index] === "]") {
        this.index += 1;
        return;
      }
      if (this.source[this.index] !== ",") this.invalid();
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    this.index += 1;
    let decoded = "";
    let chunkStart = this.index;
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code === 0x22) {
        decoded += this.source.slice(chunkStart, this.index);
        this.index += 1;
        if (hasUnpairedSurrogate(decoded)) this.invalid();
        return decoded;
      }
      if (code < 0x20) this.invalid();
      if (code === 0x5c) {
        decoded += this.source.slice(chunkStart, this.index);
        this.index += 1;
        const escape = this.source[this.index];
        if (escape === "u") {
          let codeUnit = 0;
          for (let offset = 1; offset <= 4; offset += 1) {
            const hex = this.source.charCodeAt(this.index + offset);
            const valid =
              (hex >= 0x30 && hex <= 0x39)
              || (hex >= 0x41 && hex <= 0x46)
              || (hex >= 0x61 && hex <= 0x66);
            if (!valid) this.invalid();
            codeUnit = (codeUnit * 16) + (
              hex <= 0x39 ? hex - 0x30 : (hex & 0x20) === 0 ? hex - 0x37 : hex - 0x57
            );
          }
          decoded += String.fromCharCode(codeUnit);
          this.index += 5;
          chunkStart = this.index;
          continue;
        }
        if (escape === undefined || !"\"\\/bfnrt".includes(escape)) this.invalid();
        decoded += escape === "b"
          ? "\b"
          : escape === "f"
            ? "\f"
            : escape === "n"
              ? "\n"
              : escape === "r"
                ? "\r"
                : escape === "t"
                  ? "\t"
                  : escape;
        this.index += 1;
        chunkStart = this.index;
        continue;
      }
      this.index += 1;
    }
    this.invalid();
  }

  private literal(expected: string): void {
    if (
      this.source.slice(this.index, this.index + expected.length) !== expected
    ) {
      this.invalid();
    }
    this.index += expected.length;
  }

  private parseNumber(): void {
    const start = this.index;
    if (this.source[this.index] === "-") this.index += 1;
    if (this.source[this.index] === "0") {
      this.index += 1;
    } else {
      const integerStart = this.index;
      while (
        this.source[this.index] >= "0"
        && this.source[this.index] <= "9"
      ) {
        this.index += 1;
      }
      if (this.index === integerStart) this.invalid();
    }
    if (this.source[this.index] === ".") {
      this.index += 1;
      const fractionStart = this.index;
      while (
        this.source[this.index] >= "0"
        && this.source[this.index] <= "9"
      ) {
        this.index += 1;
      }
      if (this.index === fractionStart) this.invalid();
    }
    if (
      this.source[this.index] === "e"
      || this.source[this.index] === "E"
    ) {
      this.index += 1;
      if (
        this.source[this.index] === "+"
        || this.source[this.index] === "-"
      ) {
        this.index += 1;
      }
      const exponentStart = this.index;
      while (
        this.source[this.index] >= "0"
        && this.source[this.index] <= "9"
      ) {
        this.index += 1;
      }
      if (this.index === exponentStart) this.invalid();
    }
    validateRawNumberLexeme(this.source.slice(start, this.index));
  }
}

function validateScalarTree(value: unknown, depth = 0): void {
  if (typeof value === "string") {
    if (hasUnpairedSurrogate(value)) reject("invalid_json");
    return;
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value)
      || (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      reject("invalid_json");
    }
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (!isRecord(value) && !Array.isArray(value)) reject("invalid_json");
  if (depth >= MAX_JSON_DEPTH) reject("invalid_json");
  if (Array.isArray(value)) {
    for (const item of value) validateScalarTree(item, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (hasUnpairedSurrogate(key)) reject("invalid_json");
    validateScalarTree(item, depth + 1);
  }
}

function strictParseJson(source: string): unknown {
  new StrictJsonScanner(source).parse();
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    reject("invalid_json");
  }
  validateScalarTree(parsed);
  return parsed;
}

function decodeReport(reportBytes: Uint8Array): unknown {
  if (reportBytes.byteLength > MAX_REPORT_BYTES) {
    reject("input_too_large", "input.report_bytes");
  }
  if (
    reportBytes.byteLength >= 3
    && reportBytes[0] === 0xef
    && reportBytes[1] === 0xbb
    && reportBytes[2] === 0xbf
  ) {
    reject("invalid_utf8", "input.report_bytes");
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(reportBytes);
  } catch {
    reject("invalid_utf8", "input.report_bytes");
  }
  return strictParseJson(source);
}

function requireExactKeys(
  value: JsonRecord,
  allowed: readonly string[],
  required: readonly string[],
  unknownPath: string,
  knownPath: (member: string) => string,
  code: FleetBudgetSanitizerErrorCode,
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    reject(code, unknownPath);
  }
  const missing = required.find(
    (key) => !Object.prototype.hasOwnProperty.call(value, key),
  );
  if (missing !== undefined) reject(code, knownPath(missing));
}

function requireSafeNonNegativeInteger(value: unknown, path: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    reject("invalid_input", path);
  }
  return value;
}

function validateCallerTiming(input: JsonRecord): {
  collectionStartedAtMs: number;
  expiresAtMs: number;
} {
  const collectionStartedAtMs = requireSafeNonNegativeInteger(
    input.collection_started_at_ms,
    "input.collection_started_at_ms",
  );
  requireSafeNonNegativeInteger(
    input.collection_finished_at_ms,
    "input.collection_finished_at_ms",
  );
  requireSafeNonNegativeInteger(input.now_ms, "input.now_ms");
  const ttlMs = Object.prototype.hasOwnProperty.call(input, "ttl_ms")
    ? requireSafeNonNegativeInteger(input.ttl_ms, "input.ttl_ms")
    : DEFAULT_TTL_MS;
  if (ttlMs < 1 || ttlMs > MAX_TTL_MS) reject("invalid_input", "input.ttl_ms");
  const expiresAtMs = collectionStartedAtMs + ttlMs;
  if (!Number.isSafeInteger(expiresAtMs)) reject("invalid_input", "input.ttl_ms");
  return {
    collectionStartedAtMs,
    expiresAtMs,
  };
}

function requireIdentifier(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > MAX_IDENTIFIER_LENGTH
  ) {
    reject("invalid_report", path);
  }
  return value;
}

function requireMetric(
  value: unknown,
  path: string,
  exclusiveMinimum: boolean,
): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || (exclusiveMinimum ? value <= 0 : value < 0)
  ) {
    reject("invalid_report", path);
  }
  return value;
}

function requireFreeText(value: unknown, path: string): void {
  if (
    typeof value !== "string"
    || scalarLength(value) > MAX_FREE_TEXT_LENGTH
  ) {
    reject("invalid_report", path);
  }
}

function validateLanes(value: unknown): FleetBudgetLane[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    reject("invalid_report", "report.lanes");
  }
  const seen = new Set<string>();
  const lanes: FleetBudgetLane[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const path = `report.lanes[${index}]`;
    const rawLane = value[index];
    if (!isRecord(rawLane)) reject("invalid_report", path);
    requireExactKeys(
      rawLane,
      LANE_KEYS,
      LANE_KEYS,
      `${path}.<unknown-member>`,
      (member) => `${path}.${member}`,
      "report_schema_drift",
    );
    const laneId = requireIdentifier(rawLane.lane, `${path}.lane`);
    if (seen.has(laneId)) reject("invalid_report", `${path}.lane`);
    seen.add(laneId);
    if (typeof rawLane.measured !== "boolean") {
      reject("invalid_report", `${path}.measured`);
    }
    const measured = rawLane.measured;
    const used = requireMetric(rawLane.used, `${path}.used`, false);
    const total = requireMetric(rawLane.total, `${path}.total`, true);
    if (typeof rawLane.unit !== "string") reject("invalid_report", `${path}.unit`);
    const rawUnit = rawLane.unit;
    if (
      rawUnit.length > 0
      && (
        scalarLength(rawUnit) > MAX_UNIT_LENGTH
        || !UNIT_TOKEN.test(rawUnit)
      )
    ) {
      reject("invalid_report", `${path}.unit`);
    }
    if (used !== null && total !== null) {
      if (
        typeof rawLane.utilization !== "number"
        || !Number.isFinite(rawLane.utilization)
        || rawLane.utilization < 0
      ) {
        reject("invalid_report", `${path}.utilization`);
      }
    } else if (rawLane.utilization !== null) {
      reject("invalid_report", `${path}.utilization`);
    }
    if (typeof rawLane.state !== "string" || !STATES.has(rawLane.state)) {
      reject("invalid_report", `${path}.state`);
    }
    requireFreeText(rawLane.note, `${path}.note`);
    requireFreeText(rawLane.detail, `${path}.detail`);
    if (!measured) {
      if (used !== null) reject("invalid_report", `${path}.used`);
      if (total !== null) reject("invalid_report", `${path}.total`);
      if (rawLane.utilization !== null) {
        reject("invalid_report", `${path}.utilization`);
      }
      if (rawUnit !== "") reject("invalid_report", `${path}.unit`);
    }
    lanes.push({
      lane_id: laneId,
      measured,
      used: measured ? used : null,
      total: measured ? total : null,
      unit: measured && rawUnit !== "" ? rawUnit : null,
    });
  }
  return lanes.sort((left, right) =>
    left.lane_id < right.lane_id ? -1 : left.lane_id > right.lane_id ? 1 : 0
  );
}

function validateRoutes(value: unknown): void {
  if (!isRecord(value) || Object.keys(value).length > MAX_ITEMS) {
    reject("invalid_report", "report.routes");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== ROUTE_KEYS.length
    || keys.some((key) => !ROUTE_KEYS.includes(key as typeof ROUTE_KEYS[number]))
  ) {
    reject("report_schema_drift", "report.routes[*].key");
  }
  for (const key of ROUTE_KEYS) {
    const route = value[key];
    if (route === null) continue;
    if (
      typeof route !== "string"
      || route.length > MAX_IDENTIFIER_LENGTH
    ) {
      reject("invalid_report", "report.routes[*].value");
    }
  }
}

export function sanitizeFleetBudgetReport(
  input: SanitizeFleetBudgetReportInput,
): FleetBudgetSnapshot {
  if (!isRecord(input)) reject("invalid_input", "input");
  requireExactKeys(
    input,
    INPUT_KEYS,
    REQUIRED_INPUT_KEYS,
    "input.<unknown-member>",
    (member) => `input.${member}`,
    "invalid_input",
  );
  if (!(input.report_bytes instanceof Uint8Array)) {
    reject("invalid_input", "input.report_bytes");
  }
  const parsed = decodeReport(input.report_bytes);
  if (!isRecord(parsed)) reject("invalid_report", "report");
  requireExactKeys(
    parsed,
    REPORT_KEYS,
    REPORT_KEYS,
    "report.<unknown-member>",
    (member) => `report.${member}`,
    "report_schema_drift",
  );

  const timing = validateCallerTiming(input);
  if (typeof parsed.generated !== "string") {
    reject("invalid_report", "report.generated");
  }

  const lanes = validateLanes(parsed.lanes);
  validateRoutes(parsed.routes);
  return {
    version: FLEETBUDGET_SNAPSHOT_VERSION,
    observed_at_ms: timing.collectionStartedAtMs,
    expires_at_ms: timing.expiresAtMs,
    lanes,
  };
}
