/**
 * Offline capability-profile reference semantics for Slice 4C-0.
 *
 * This module deliberately has no integration imports. It neither discovers a
 * provider nor selects, launches, authorizes, persists, sends, or executes one.
 */
import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;
type ErrorRecord = { code: string; field_path: string };
type ProfileState = { profile: JsonRecord; claims: Array<{ value: JsonRecord; sourceIndex: number }>; errors: ErrorRecord[] };

const SAFE = Number.MAX_SAFE_INTEGER;
const PROFILE_VERSION = "meshfleet.a2a.capability-profile/v0.1";
const VALIDATION_VERSION = "meshfleet.a2a.capability-validation/v0.1";
const COMPARISON_VERSION = "meshfleet.a2a.capability-comparison/v0.1";
const TRANSLATION_VERSION = "meshfleet.a2a.translation/v0.1";
const TRANSLATION_RESULT_VERSION = "meshfleet.a2a.translation-result/v0.1";
const TRANSLATION_RESULT_VALIDATION_VERSION = "meshfleet.a2a.translation-result-validation/v0.1";
const REGISTRY_VERSION = "meshfleet.a2a.conformance-registry/v0.1";
const TARGETS = ["codex", "claude-code", "opencode", "generic-mcp", "generic-cli-stdio", "antigravity-gemini", "grok", "unknown-future-harness"] as const;
const DEFERRED_TARGETS = new Set<string>(["antigravity-gemini", "grok", "unknown-future-harness"]);
const CWD_POLICIES = new Set(["target-default-unknown", "host-selected", "explicit-reviewed", "not-represented"]);
const FEATURE_STATES = new Set(["supported", "unsupported", "unknown", "not-represented"]);
const CLAIM_KINDS = new Set(["capability", "transport", "protocol", "runtime", "provider", "model"]);
const CLAIM_STATES = new Set(["supported", "unsupported", "unknown"]);
const PROVENANCE_LEVELS = new Set(["advertised", "reported", "observed", "attested"]);
const PRIVACY_FIELDS = new Set([
  "principal_id", "request_id", "message_id", "recipient", "recipients", "credential", "credentials", "token", "api_key", "secret", "password", "private_key", "pem", "prompt", "payload", "output", "diagnostic", "diagnostics", "path", "cwd", "argv", "args", "argument", "arguments", "url", "uri", "endpoint", "environment", "env", "env_values", "hostname", "pid", "process_id", "account_id", "hardware_id", "receipt", "receipt_id", "artifact",
]);
const COMPUTED_FIELDS = new Set(["verification_status", "verification_report", "verified_at_ms", "verifier_ref", "failure_reason", "profile_fingerprint", "claim_fingerprint", "proof_results", "conformance_status"]);
const LOSS_REASONS = new Set(["field_not_represented", "target_schema_unknown", "cwd_not_represented", "capability_not_proven", "runtime_identity_not_attested", "semantic_gap", "unsupported_transport", "contradictory_provenance", "static_template_unavailable", "unsupported_feature", "requires_human_gate"]);
const LOSS_DISPOSITIONS = new Set(["preserved_unknown", "rejected", "omitted_by_contract", "requires_human_gate"]);

/** The v0.1 registry is intentionally empty. It is evidence syntax, never authority. */
export const CAPABILITY_PROFILE_V01_EXTENSION_REGISTRY: Readonly<Record<string, never>> = Object.freeze({});

function record(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function ascii(value: string): string { return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase()); }
function pathJoin(base: string, member: string): string { return `${base}.${member}`; }
function compareAscii(left: string, right: string): number { return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")); }
function sortErrors(errors: ErrorRecord[]): ErrorRecord[] { return errors.sort((a, b) => compareAscii(a.code, b.code) || compareAscii(a.field_path, b.field_path)); }
function minPath<T extends { path: string }>(items: T[]): T | undefined { return items.sort((a, b) => compareAscii(a.path, b.path))[0]; }
function safeInteger(value: unknown, nonnegative = false): value is number { return typeof value === "number" && Number.isSafeInteger(value) && (!nonnegative || value >= 0); }
function string(value: unknown): value is string { return typeof value === "string"; }
function opaque(value: unknown): value is string { return string(value) && /^ref_[A-Za-z0-9_-]{20,84}$/.test(value); }
function profileId(value: unknown): value is string { return string(value) && /^cp_[A-Za-z0-9_-]{20,84}$/.test(value); }
function claimId(value: unknown): value is string { return string(value) && /^clm_[A-Za-z0-9_-]{20,84}$/.test(value); }
function nonce(value: unknown): value is string { return string(value) && /^nonce_[A-Za-z0-9_-]{20,84}$/.test(value); }
function canonicalId(value: unknown): value is string { return string(value) && Buffer.byteLength(value, "utf8") <= 96 && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value); }
function exactVersion(value: unknown): value is string { return string(value) && Buffer.byteLength(value, "utf8") <= 32 && /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))?$/.test(value); }
function protocolRef(value: unknown): value is string { if (!string(value) || Buffer.byteLength(value, "utf8") > 129) return false; const cut = value.lastIndexOf("/"); return cut > 0 && canonicalId(value.slice(0, cut)) && exactVersion(value.slice(cut + 1)); }
function label(value: unknown): value is string { return string(value) && /^[A-Za-z0-9][A-Za-z0-9._+@-]{0,95}$/.test(value); }
function digest(value: unknown): value is string { return string(value) && /^sha256:[0-9a-f]{64}$/.test(value); }
function fieldPath(value: unknown): value is string { return string(value) && Buffer.byteLength(value, "utf8") <= 256 && (/^\$evaluation_time_ms$/.test(value) || /^\$(?:\.[a-z][a-z0-9_]*|\[[0-9]+\])*$/.test(value)); }
function validTime(value: unknown): value is number { return safeInteger(value, true); }
function evaluationError(): JsonRecord { return { ok: false, error: { code: "INVALID_EVALUATION_TIME", field_path: "$evaluation_time_ms" } }; }
const INVALID_RAW_JSON = Symbol("invalid-raw-json");
type ParsedInput = unknown | typeof INVALID_RAW_JSON;

function validUnicodeScalarString(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

class StrictJsonParser {
  private index = 0;
  constructor(private readonly source: string) {}

  parse(): unknown {
    this.space();
    const value = this.value(1);
    this.space();
    if (this.index !== this.source.length) throw new Error("trailing input");
    return value;
  }

  private space(): void { while (/\s/.test(this.source[this.index] ?? "")) this.index += 1; }
  private value(depth: number): unknown {
    this.space();
    const token = this.source[this.index];
    if (token === "{") return this.object(depth);
    if (token === "[") return this.array(depth);
    if (token === '"') return this.quoted();
    if (token === "t" && this.take("true")) return true;
    if (token === "f" && this.take("false")) return false;
    if (token === "n" && this.take("null")) return null;
    return this.number();
  }
  private object(depth: number): JsonRecord {
    if (depth > 64) throw new Error("depth");
    this.index += 1; this.space();
    const output: JsonRecord = {}; const names = new Set<string>();
    if (this.source[this.index] === "}") { this.index += 1; return output; }
    while (true) {
      if (this.source[this.index] !== '"') throw new Error("object key");
      const key = this.quoted();
      if (names.has(key)) throw new Error("duplicate decoded key");
      names.add(key); this.space();
      if (this.source[this.index] !== ":") throw new Error("colon");
      this.index += 1; output[key] = this.value(depth + 1); this.space();
      if (this.source[this.index] === "}") { this.index += 1; return output; }
      if (this.source[this.index] !== ",") throw new Error("object delimiter");
      this.index += 1; this.space();
    }
  }
  private array(depth: number): unknown[] {
    if (depth > 64) throw new Error("depth");
    this.index += 1; this.space();
    const output: unknown[] = [];
    if (this.source[this.index] === "]") { this.index += 1; return output; }
    while (true) {
      output.push(this.value(depth + 1)); this.space();
      if (this.source[this.index] === "]") { this.index += 1; return output; }
      if (this.source[this.index] !== ",") throw new Error("array delimiter");
      this.index += 1; this.space();
    }
  }
  private quoted(): string {
    const start = this.index; this.index += 1;
    while (this.index < this.source.length) {
      const token = this.source[this.index]!;
      if (token === '"') {
        this.index += 1;
        const decoded = JSON.parse(this.source.slice(start, this.index)) as string;
        if (!validUnicodeScalarString(decoded)) throw new Error("unicode scalar");
        return decoded;
      }
      if (token === "\\") {
        this.index += 1;
        const escape = this.source[this.index];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(this.source.slice(this.index + 1, this.index + 5))) throw new Error("unicode escape");
          this.index += 5; continue;
        }
        if (!'"\\/bfnrt'.includes(escape ?? "")) throw new Error("escape");
        this.index += 1; continue;
      }
      if (token.charCodeAt(0) < 0x20) throw new Error("control");
      this.index += 1;
    }
    throw new Error("unterminated string");
  }
  private number(): number {
    const rest = this.source.slice(this.index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (!match) throw new Error("number");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error("number domain");
    return Object.is(value, -0) ? 0 : value;
  }
  private take(literal: string): boolean {
    if (this.source.slice(this.index, this.index + literal.length) !== literal) return false;
    this.index += literal.length; return true;
  }
}

function validateDirectJson(value: unknown, depth = 1, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return validUnicodeScalarString(value);
  if (typeof value === "number") return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (typeof value !== "object" || depth > 64 || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) return false;
    return value.every((item) => validateDirectJson(item, depth + 1, seen));
  }
  if (!record(value)) return false;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!validUnicodeScalarString(key) || descriptor.get || descriptor.set || !("value" in descriptor) || !validateDirectJson(descriptor.value, depth + 1, seen)) return false;
  }
  return true;
}

function parse(value: unknown): ParsedInput {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 131072) return INVALID_RAW_JSON;
    try { return new StrictJsonParser(value).parse(); } catch { return INVALID_RAW_JSON; }
  }
  if (!validateDirectJson(value)) return INVALID_RAW_JSON;
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= 131072 ? value : INVALID_RAW_JSON; } catch { return INVALID_RAW_JSON; }
}
function unknownFields(input: JsonRecord, allowed: readonly string[], path: string, errors: ErrorRecord[], computed = false): void {
  for (const key of Object.keys(input)) {
    if (allowed.includes(key)) continue;
    errors.push({ code: computed && COMPUTED_FIELDS.has(key) ? "FORBIDDEN_COMPUTED_FIELD" : "UNKNOWN_CORE_FIELD", field_path: computed && COMPUTED_FIELDS.has(key) ? pathJoin(path, key) : path });
  }
}
function required(input: JsonRecord, keys: readonly string[], path: string, errors: ErrorRecord[], code: string): void {
  for (const key of keys) if (!(key in input)) errors.push({ code, field_path: pathJoin(path, key) });
}
function bytes64(value: bigint | number): Buffer { const buffer = Buffer.allocUnsafe(8); buffer.writeBigUInt64BE(BigInt(value)); return buffer; }
function canonicalTree(value: unknown): Buffer {
  if (value === null) return Buffer.from([0]);
  if (value === false) return Buffer.from([1]);
  if (value === true) return Buffer.from([2]);
  if (typeof value === "number") { if (!Number.isFinite(value) || !Number.isSafeInteger(value) && !Number.isFinite(value)) throw new Error("non-json number"); const out = Buffer.allocUnsafe(9); out[0] = 3; out.writeDoubleBE(Object.is(value, -0) ? 0 : value, 1); return out; }
  if (typeof value === "string") { const data = Buffer.from(value, "utf8"); return Buffer.concat([Buffer.from([4]), bytes64(data.length), data]); }
  if (Array.isArray(value)) return Buffer.concat([Buffer.from([5]), bytes64(value.length), ...value.map(canonicalTree)]);
  if (record(value)) {
    const entries = Object.keys(value).sort(compareAscii).flatMap((key) => {
      const encoded = Buffer.from(key, "utf8");
      return [Buffer.from([4]), bytes64(encoded.length), encoded, canonicalTree(value[key])];
    });
    return Buffer.concat([Buffer.from([6]), bytes64(Object.keys(value).length), ...entries]);
  }
  throw new Error("non-json value");
}
function fingerprint(domain: string, value: unknown, labelValue: string): string {
  const bytes = Buffer.concat([Buffer.from(domain, "utf8"), Buffer.from([0]), canonicalTree(value)]);
  return `${labelValue}:sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function extensionErrors(input: JsonRecord, path: string, errors: ErrorRecord[]): void {
  const extensions = input.extensions;
  const critical = input.critical_extensions;
  if (!record(extensions)) errors.push({ code: "INVALID_EXTENSION_CONTAINER", field_path: pathJoin(path, "extensions") });
  if (!Array.isArray(critical)) errors.push({ code: "INVALID_EXTENSION_CONTAINER", field_path: pathJoin(path, "critical_extensions") });
  if (record(extensions) && Object.keys(extensions).length > 0) errors.push({ code: "UNSUPPORTED_EXTENSION", field_path: pathJoin(path, "extensions") });
  if (Array.isArray(critical) && critical.length > 0) errors.push({ code: "UNSUPPORTED_EXTENSION", field_path: pathJoin(path, "critical_extensions") });
}
function normalizeSet(values: unknown, limit: number, grammar: (value: unknown) => boolean, path: string, errors: ErrorRecord[]): string[] {
  if (!Array.isArray(values) || values.length > limit) { errors.push({ code: "INVALID_APPLICABILITY", field_path: path }); return []; }
  const seen = new Set<string>(); const normalized: string[] = [];
  values.forEach((value, index) => {
    if (!grammar(value)) errors.push({ code: "INVALID_APPLICABILITY", field_path: `${path}[${index}]` });
    else if (seen.has(value)) errors.push({ code: "DUPLICATE_SET_MEMBER", field_path: `${path}[${index}]` });
    else { seen.add(value); normalized.push(value); }
  });
  return normalized.sort(compareAscii);
}
function normalizeApplicability(value: unknown, path: string, errors: ErrorRecord[]): JsonRecord {
  if (!record(value)) { errors.push({ code: "INVALID_APPLICABILITY", field_path: path }); return { protocol_versions: [], transport_families: [], operations: [] }; }
  required(value, ["protocol_versions", "transport_families", "operations"], path, errors, "INVALID_APPLICABILITY");
  unknownFields(value, ["protocol_versions", "transport_families", "operations"], path, errors);
  return {
    protocol_versions: normalizeSet(value.protocol_versions, 16, protocolRef, pathJoin(path, "protocol_versions"), errors),
    transport_families: normalizeSet(value.transport_families, 16, canonicalId, pathJoin(path, "transport_families"), errors),
    operations: normalizeSet(value.operations, 32, canonicalId, pathJoin(path, "operations"), errors),
  };
}
function normalizeProvenance(value: unknown, claim: JsonRecord, path: string, errors: ErrorRecord[]): JsonRecord {
  if (!record(value)) { errors.push({ code: "INVALID_PROVENANCE", field_path: path }); return { level: "advertised" }; }
  const level = value.level;
  if (!string(level) || !PROVENANCE_LEVELS.has(level)) { errors.push({ code: "INVALID_PROVENANCE", field_path: pathJoin(path, "level") }); return { level: "advertised" }; }
  const requiredByLevel: Record<string, string[]> = { advertised: ["level"], reported: ["level", "issuer_ref"], observed: ["level", "issuer_ref", "observed_at_ms", "probe_ref"], attested: ["level", "issuer_ref"] };
  required(value, requiredByLevel[level]!, path, errors, "INVALID_PROVENANCE");
  unknownFields(value, requiredByLevel[level]!, path, errors);
  if ((level === "reported" || level === "observed" || level === "attested") && !opaque(value.issuer_ref)) errors.push({ code: "INVALID_PROVENANCE", field_path: pathJoin(path, "issuer_ref") });
  if (level === "observed") {
    if (!validTime(value.observed_at_ms) || !validTime(claim.issued_at_ms) || !validTime(claim.expires_at_ms) || value.observed_at_ms < claim.issued_at_ms || value.observed_at_ms >= claim.expires_at_ms) errors.push({ code: "INVALID_PROVENANCE", field_path: pathJoin(path, "observed_at_ms") });
    if (!opaque(value.probe_ref)) errors.push({ code: "INVALID_PROVENANCE", field_path: pathJoin(path, "probe_ref") });
  }
  const normalized: JsonRecord = { level };
  for (const key of ["issuer_ref", "observed_at_ms", "probe_ref"]) if (key in value) normalized[key] = value[key];
  return normalized;
}
function normalizeProof(value: unknown, claim: JsonRecord, provenance: JsonRecord, path: string, errors: ErrorRecord[]): JsonRecord | undefined {
  if (value === undefined) { if (provenance.level === "attested") errors.push({ code: "INVALID_PROOF_CARRIER", field_path: path }); return undefined; }
  if (!record(value)) { errors.push({ code: "INVALID_PROOF_CARRIER", field_path: path }); return undefined; }
  const keys = ["issuer_ref", "audience_ref", "issued_at_ms", "not_before_ms", "expires_at_ms", "challenge", "proof_format", "verification_method_ref"];
  required(value, keys, path, errors, "INVALID_PROOF_CARRIER");
  const hasDigest = "proof_digest" in value; const hasRef = "proof_ref" in value;
  if (hasDigest === hasRef) errors.push({ code: "INVALID_PROOF_CARRIER", field_path: path });
  unknownFields(value, [...keys, "proof_digest", "proof_ref"], path, errors, true);
  for (const key of ["issuer_ref", "audience_ref", "verification_method_ref"]) if (!opaque(value[key])) errors.push({ code: "INVALID_PROOF_CARRIER", field_path: pathJoin(path, key) });
  if (!nonce(value.challenge)) errors.push({ code: "INVALID_PROOF_CARRIER", field_path: pathJoin(path, "challenge") });
  if (!label(value.proof_format)) errors.push({ code: "INVALID_PROOF_CARRIER", field_path: pathJoin(path, "proof_format") });
  if (hasDigest && !digest(value.proof_digest)) errors.push({ code: "INVALID_PROOF_CARRIER", field_path: pathJoin(path, "proof_digest") });
  if (hasRef && !opaque(value.proof_ref)) errors.push({ code: "INVALID_PROOF_CARRIER", field_path: pathJoin(path, "proof_ref") });
  if (provenance.issuer_ref !== undefined && value.issuer_ref !== provenance.issuer_ref) errors.push({ code: "INVALID_PROOF_CARRIER", field_path: pathJoin(path, "issuer_ref") });
  if (!validTime(value.issued_at_ms) || !validTime(value.not_before_ms) || !validTime(value.expires_at_ms) || !validTime(claim.issued_at_ms) || !validTime(claim.expires_at_ms) || value.issued_at_ms < claim.issued_at_ms || value.issued_at_ms > value.not_before_ms || value.not_before_ms >= value.expires_at_ms || value.expires_at_ms > claim.expires_at_ms) errors.push({ code: "INVALID_PROOF_CARRIER", field_path: pathJoin(path, "expires_at_ms") });
  return { ...value };
}
function normalizeClaim(value: unknown, path: string, errors: ErrorRecord[], deferExtensions: boolean): JsonRecord | undefined {
  if (!record(value)) { errors.push({ code: "INVALID_CLAIM_SCHEMA", field_path: path }); return undefined; }
  const common = ["claim_id", "kind", "applicability", "provenance", "issued_at_ms", "expires_at_ms", "extensions", "critical_extensions"];
  required(value, deferExtensions ? common.filter((key) => key !== "extensions" && key !== "critical_extensions") : common, path, errors, "INVALID_CLAIM_SCHEMA");
  if (!claimId(value.claim_id)) errors.push({ code: "INVALID_CLAIM_SCHEMA", field_path: pathJoin(path, "claim_id") });
  if (!string(value.kind) || !CLAIM_KINDS.has(value.kind)) errors.push({ code: "INVALID_CLAIM_KIND", field_path: pathJoin(path, "kind") });
  const kind = CLAIM_KINDS.has(value.kind as string) ? value.kind as string : "capability";
  const kindFields: Record<string, string[]> = { capability: ["capability_id", "state"], transport: ["transport_id", "state"], protocol: ["protocol_id", "protocol_version", "state"], runtime: ["runtime_label"], provider: ["provider_label"], model: ["model_label"] };
  unknownFields(value, [...common, "proof", ...kindFields[kind]!], path, errors, true);
  if (!validTime(value.issued_at_ms) || !validTime(value.expires_at_ms) || value.issued_at_ms >= value.expires_at_ms) errors.push({ code: "INVALID_TIME_WINDOW", field_path: pathJoin(path, "expires_at_ms") });
  const applicability = normalizeApplicability(value.applicability, pathJoin(path, "applicability"), errors);
  const claim: JsonRecord = { claim_id: value.claim_id, kind, applicability, provenance: {}, issued_at_ms: value.issued_at_ms, expires_at_ms: value.expires_at_ms, extensions: value.extensions, critical_extensions: value.critical_extensions };
  const provenance = normalizeProvenance(value.provenance, claim, pathJoin(path, "provenance"), errors); claim.provenance = provenance;
  const proof = normalizeProof(value.proof, claim, provenance, pathJoin(path, "proof"), errors); if (proof !== undefined) claim.proof = proof;
  if (!deferExtensions) extensionErrors(value, path, errors);
  if (kind === "capability" && !canonicalId(value.capability_id)) errors.push({ code: "INVALID_CANONICAL_ID", field_path: pathJoin(path, "capability_id") });
  if (kind === "transport" && !canonicalId(value.transport_id)) errors.push({ code: "INVALID_CANONICAL_ID", field_path: pathJoin(path, "transport_id") });
  if (kind === "protocol") { if (!canonicalId(value.protocol_id)) errors.push({ code: "INVALID_CANONICAL_ID", field_path: pathJoin(path, "protocol_id") }); if (!exactVersion(value.protocol_version)) errors.push({ code: "INVALID_PROTOCOL_VERSION", field_path: pathJoin(path, "protocol_version") }); }
  if (["capability", "transport", "protocol"].includes(kind) && (!string(value.state) || !CLAIM_STATES.has(value.state))) errors.push({ code: "INVALID_CLAIM_SCHEMA", field_path: pathJoin(path, "state") });
  if (kind === "runtime" && !label(value.runtime_label)) errors.push({ code: "INVALID_ASCII_LABEL", field_path: pathJoin(path, "runtime_label") });
  if (kind === "provider" && !label(value.provider_label)) errors.push({ code: "INVALID_ASCII_LABEL", field_path: pathJoin(path, "provider_label") });
  if (kind === "model" && !label(value.model_label)) errors.push({ code: "INVALID_ASCII_LABEL", field_path: pathJoin(path, "model_label") });
  for (const key of kindFields[kind]!) claim[key] = value[key];
  return claim;
}
function profileStructural(raw: unknown, base = "$", deferExtensions = false): ProfileState {
  const errors: ErrorRecord[] = []; const parsed = parse(raw);
  if (!record(parsed)) return { profile: {}, claims: [], errors: [{ code: "MALFORMED_CAPABILITY_PROFILE", field_path: base }] };
  const keys = ["profile_version", "profile_id", "revision", "issuer", "subject", "issued_at_ms", "expires_at_ms", "claims", "extensions", "critical_extensions"];
  required(parsed, deferExtensions ? keys.filter((key) => key !== "extensions" && key !== "critical_extensions") : keys, base, errors, "MALFORMED_CAPABILITY_PROFILE"); unknownFields(parsed, keys, base, errors, true);
  if (parsed.profile_version !== PROFILE_VERSION) errors.push({ code: "UNSUPPORTED_PROFILE_VERSION", field_path: pathJoin(base, "profile_version") });
  if (!profileId(parsed.profile_id)) errors.push({ code: "MALFORMED_CAPABILITY_PROFILE", field_path: pathJoin(base, "profile_id") });
  if (!safeInteger(parsed.revision) || (parsed.revision as number) <= 0) errors.push({ code: "INVALID_PROFILE_REVISION", field_path: pathJoin(base, "revision") });
  for (const [name, kinds] of [["issuer", ["agent", "adapter", "runtime", "authority"]], ["subject", ["agent", "adapter", "runtime", "transport"]]] as const) {
    const item = parsed[name]; const itemPath = pathJoin(base, name);
    if (!record(item)) { errors.push({ code: "MALFORMED_CAPABILITY_PROFILE", field_path: itemPath }); continue; }
    required(item, ["kind", "ref"], itemPath, errors, "MALFORMED_CAPABILITY_PROFILE"); unknownFields(item, ["kind", "ref"], itemPath, errors);
    if (!string(item.kind) || !kinds.includes(item.kind as never)) errors.push({ code: "MALFORMED_CAPABILITY_PROFILE", field_path: pathJoin(itemPath, "kind") });
    if (!opaque(item.ref)) errors.push({ code: "INVALID_OPAQUE_REFERENCE", field_path: pathJoin(itemPath, "ref") });
  }
  if (!validTime(parsed.issued_at_ms) || !validTime(parsed.expires_at_ms) || (validTime(parsed.issued_at_ms) && validTime(parsed.expires_at_ms) && parsed.issued_at_ms >= parsed.expires_at_ms)) errors.push({ code: "INVALID_TIME_WINDOW", field_path: pathJoin(base, "expires_at_ms") });
  if (!Array.isArray(parsed.claims) || parsed.claims.length > 128) errors.push({ code: "MALFORMED_CAPABILITY_PROFILE", field_path: pathJoin(base, "claims") });
  const claims: Array<{ value: JsonRecord; sourceIndex: number }> = [];
  if (Array.isArray(parsed.claims) && parsed.claims.length <= 128) parsed.claims.forEach((claim, index) => { const normalized = normalizeClaim(claim, `${base}.claims[${index}]`, errors, deferExtensions); if (normalized !== undefined) claims.push({ value: normalized, sourceIndex: index }); });
  const ids = new Set<string>(); for (const claim of claims) { const id = claim.value.claim_id; if (string(id)) { if (ids.has(id)) errors.push({ code: "DUPLICATE_SET_MEMBER", field_path: `${base}.claims[${claim.sourceIndex}].claim_id` }); ids.add(id); } }
  if (!deferExtensions) extensionErrors(parsed, base, errors);
  // Canonical ordering is deliberately unavailable until the entire structural
  // phase succeeds. In particular, an absent extension container must retain
  // its source-index diagnostic rather than being accidentally fingerprinted.
  const normalizedClaims = !deferExtensions && errors.length === 0 ? claims.slice().sort((a, b) => Buffer.compare(canonicalTree(a.value), canonicalTree(b.value))) : claims;
  const profile: JsonRecord = { profile_version: parsed.profile_version, profile_id: parsed.profile_id, revision: parsed.revision, issuer: parsed.issuer, subject: parsed.subject, issued_at_ms: parsed.issued_at_ms, expires_at_ms: parsed.expires_at_ms, claims: normalizedClaims.map(({ value }) => value), extensions: parsed.extensions, critical_extensions: parsed.critical_extensions };
  return { profile, claims, errors: sortErrors(errors) };
}
function contradictionErrors(state: ProfileState, base = "$"): ErrorRecord[] {
  const errors: ErrorRecord[] = []; const profile = state.profile;
  const map = new Map<string, Set<string>>();
  state.claims.forEach(({ value }) => {
    if (["capability", "transport", "protocol"].includes(value.kind as string) && string(value.state)) {
      const key = JSON.stringify([(profile.subject as JsonRecord).ref, value.kind, value.capability_id ?? value.transport_id ?? value.protocol_id, value.protocol_version ?? "", value.applicability]);
      const states = map.get(key) ?? new Set<string>(); states.add(value.state); map.set(key, states);
    }
  });
  for (const states of map.values()) if (states.has("supported") && states.has("unsupported")) errors.push({ code: "CONTRADICTORY_CLAIMS", field_path: pathJoin(base, "claims") });
  return errors;
}

function semanticErrors(state: ProfileState, evaluationTime: number, base = "$"): ErrorRecord[] {
  const errors: ErrorRecord[] = contradictionErrors(state, base); const profile = state.profile;
  if (evaluationTime < (profile.issued_at_ms as number)) errors.push({ code: "NOT_YET_VALID_PROFILE", field_path: pathJoin(base, "issued_at_ms") });
  if (evaluationTime >= (profile.expires_at_ms as number)) errors.push({ code: "EXPIRED_PROFILE", field_path: pathJoin(base, "expires_at_ms") });
  state.claims.forEach(({ value, sourceIndex }) => {
    const claimPath = `${base}.claims[${sourceIndex}]`;
    if (evaluationTime < (value.issued_at_ms as number)) errors.push({ code: "NOT_YET_VALID_CLAIM", field_path: pathJoin(claimPath, "issued_at_ms") });
    if (evaluationTime >= (value.expires_at_ms as number)) errors.push({ code: "EXPIRED_CLAIM", field_path: pathJoin(claimPath, "expires_at_ms") });
    const proof = value.proof; if (record(proof)) { if (evaluationTime < (proof.issued_at_ms as number) || evaluationTime < (proof.not_before_ms as number)) errors.push({ code: "NOT_YET_VALID_PROOF", field_path: pathJoin(claimPath, "proof.not_before_ms") }); if (evaluationTime >= (proof.expires_at_ms as number)) errors.push({ code: "EXPIRED_PROOF", field_path: pathJoin(claimPath, "proof.expires_at_ms") }); }
  });
  return sortErrors(errors);
}
function claimFingerprint(profile: JsonRecord, claim: JsonRecord): string { return fingerprint("meshfleet.a2a.capability-claim.v1", [(profile.issuer as JsonRecord).ref, (profile.subject as JsonRecord).ref, profile.profile_id, claim.claim_id, profile.revision, claim], "meshfleet.a2a.capability-claim.v1"); }

/** Validate profile evidence only. This does not authenticate or authorize anything. */
export function validateProfile(rawProfile: unknown, evaluationTime?: unknown): JsonRecord {
  if (!validTime(evaluationTime)) return evaluationError();
  const state = profileStructural(rawProfile); if (state.errors.length) return { ok: true, value: { validation_version: VALIDATION_VERSION, evaluation_time_ms: evaluationTime, valid: false, proof_results: [], errors: state.errors } };
  const errors = semanticErrors(state, evaluationTime); const profileFingerprint = fingerprint("meshfleet.a2a.capability-profile.v1", state.profile, "meshfleet.a2a.capability-profile.v1");
  const proofResults = state.claims.map(({ value }) => ({ claim_id: value.claim_id, claim_fingerprint: claimFingerprint(state.profile, value), verification_status: value.proof === undefined ? "absent" : "unsupported" })).sort((a, b) => compareAscii(a.claim_id as string, b.claim_id as string) || compareAscii(JSON.stringify(a), JSON.stringify(b)));
  return { ok: true, value: { validation_version: VALIDATION_VERSION, evaluation_time_ms: evaluationTime, valid: errors.length === 0, profile_fingerprint: profileFingerprint, proof_results: proofResults, errors } };
}
function compareIdentityObjects(left: JsonRecord, right: JsonRecord): number {
  for (const key of ["issuer_ref", "subject_ref", "profile_id", "claim_id"] as const) {
    const order = compareAscii(left[key] as string, right[key] as string); if (order) return order;
  }
  return Number(left.revision) - Number(right.revision);
}
export function compareProfiles(rawProfiles: unknown, evaluationTime?: unknown): JsonRecord {
  if (!validTime(evaluationTime)) return evaluationError();
  const source = parse(rawProfiles); const profiles = Array.isArray(source) ? source : [];
  const profileResults: JsonRecord[] = []; const allStates: ProfileState[] = []; const errors: JsonRecord[] = [];
  if (!Array.isArray(source)) return { ok: true, value: { comparison_version: COMPARISON_VERSION, evaluation_time_ms: evaluationTime, valid: false, profile_results: [], identity_contradictions: [], semantic_contradictions: [], exact_duplicates: [], errors: [{ profile_index: 0, code: "MALFORMED_CAPABILITY_PROFILE", field_path: "$" }] } };
  profiles.forEach((raw, profileIndex) => { const state = profileStructural(raw); allStates.push(state); if (state.errors.length) { profileResults.push({ profile_index: profileIndex, structurally_valid: false, valid: false, validation_error_codes: [...new Set(state.errors.map((item) => item.code))].sort(compareAscii) }); state.errors.forEach((item) => errors.push({ profile_index: profileIndex, ...item })); } else { const semantic = semanticErrors(state, evaluationTime); profileResults.push({ profile_index: profileIndex, structurally_valid: true, profile_id: state.profile.profile_id, profile_fingerprint: fingerprint("meshfleet.a2a.capability-profile.v1", state.profile, "meshfleet.a2a.capability-profile.v1"), valid: semantic.length === 0, validation_error_codes: [...new Set(semantic.map((item) => item.code))].sort(compareAscii) }); } });
  if (errors.length) return { ok: true, value: { comparison_version: COMPARISON_VERSION, evaluation_time_ms: evaluationTime, valid: false, profile_results: profileResults, identity_contradictions: [], semantic_contradictions: [], exact_duplicates: [], errors: errors.sort((a, b) => Number(a.profile_index) - Number(b.profile_index) || compareAscii(a.code as string, b.code as string) || compareAscii(a.field_path as string, b.field_path as string)) } };
  const identity = new Map<string, Map<string, Set<number>>>(); const semantic = new Map<string, { kind: string; supported: JsonRecord[]; unsupported: JsonRecord[] }>();
  allStates.forEach((state, profileIndex) => state.claims.forEach(({ value, sourceIndex }) => { const p = state.profile; const keyParts = [(p.issuer as JsonRecord).ref, (p.subject as JsonRecord).ref, p.profile_id, value.claim_id, p.revision]; const key = JSON.stringify(keyParts); const fp = claimFingerprint(p, value); const bucket = identity.get(key) ?? new Map<string, Set<number>>(); const indexes = bucket.get(fp) ?? new Set<number>(); indexes.add(profileIndex); bucket.set(fp, indexes); identity.set(key, bucket); if (["capability", "transport", "protocol"].includes(value.kind as string) && string(value.state)) { const semanticKey = JSON.stringify([(p.subject as JsonRecord).ref, value.kind, value.capability_id ?? value.transport_id ?? value.protocol_id, value.protocol_version ?? "", value.applicability]); const group = semantic.get(semanticKey) ?? { kind: value.kind as string, supported: [], unsupported: [] }; if (value.state === "supported") group.supported.push({ profile_index: profileIndex, claim_index: sourceIndex, claim_fingerprint: fp }); if (value.state === "unsupported") group.unsupported.push({ profile_index: profileIndex, claim_index: sourceIndex, claim_fingerprint: fp }); semantic.set(semanticKey, group); } }));
  const identityContradictions: JsonRecord[] = []; const exactDuplicates: JsonRecord[] = [];
  for (const [key, buckets] of identity) { const [issuer_ref, subject_ref, profile_id, claim_id, revision] = JSON.parse(key) as unknown[]; const identityKey = { issuer_ref, subject_ref, profile_id, claim_id, revision }; if (buckets.size > 1) identityContradictions.push({ identity_key: identityKey, fingerprints: [...buckets.entries()].map(([claim_fingerprint, indexes]) => ({ claim_fingerprint, profile_indexes: [...indexes].sort((a, b) => a - b) })).sort((a, b) => compareAscii(a.claim_fingerprint, b.claim_fingerprint)) }); for (const [claim_fingerprint, indexes] of buckets) if (indexes.size > 1) exactDuplicates.push({ identity_key: identityKey, claim_fingerprint, profile_indexes: [...indexes].sort((a, b) => a - b) }); }
  const semanticContradictions = [...semantic.values()].filter((group) => group.supported.length && group.unsupported.length).map((group) => ({ kind: group.kind, supported_occurrences: group.supported.sort((a, b) => Number(a.profile_index) - Number(b.profile_index) || Number(a.claim_index) - Number(b.claim_index)), unsupported_occurrences: group.unsupported.sort((a, b) => Number(a.profile_index) - Number(b.profile_index) || Number(a.claim_index) - Number(b.claim_index)) })).sort((a, b) => Buffer.compare(canonicalTree(a), canonicalTree(b)));
  return { ok: true, value: { comparison_version: COMPARISON_VERSION, evaluation_time_ms: evaluationTime, valid: profileResults.every((item) => item.valid === true), profile_results: profileResults, identity_contradictions: identityContradictions.sort((a, b) => compareIdentityObjects(a.identity_key as JsonRecord, b.identity_key as JsonRecord)), semantic_contradictions: semanticContradictions, exact_duplicates: exactDuplicates.sort((a, b) => compareIdentityObjects(a.identity_key as JsonRecord, b.identity_key as JsonRecord) || compareAscii(a.claim_fingerprint as string, b.claim_fingerprint as string)), errors: [] } };
}
function privacyScan(value: unknown, path: string, out: Array<{ path: string }>): void { if (!record(value) && !Array.isArray(value)) return; if (Array.isArray(value)) { value.forEach((entry, index) => privacyScan(entry, `${path}[${index}]`, out)); return; } for (const [key, entry] of Object.entries(value)) { if (key === "extensions") continue; const normalized = ascii(key); const next = pathJoin(path, normalized); if (PRIVACY_FIELDS.has(normalized)) out.push({ path: next }); privacyScan(entry, next, out); } }

type ClosedSchema = "translation" | "result" | "profile" | "identity" | "claim" | "applicability" | "provenance" | "proof" | "template" | "feature" | "loss";
type ClosedFieldScan = { computed: string[]; unknown: string[] };
function scanClosedFields(value: unknown, schema: ClosedSchema, base: string, scan: ClosedFieldScan): void {
  if (!record(value)) return;
  const allowed: Record<ClosedSchema, readonly string[]> = {
    translation: ["translation_version", "target", "source_profile", "launch_template", "cwd_policy", "features", "provenance_refs", "extensions", "critical_extensions"],
    result: ["translation_version", "target", "launch_template", "cwd_policy", "features", "provenance_refs", "profile", "losses", "extensions", "critical_extensions"],
    profile: ["profile_version", "profile_id", "revision", "issuer", "subject", "issued_at_ms", "expires_at_ms", "claims", "extensions", "critical_extensions"],
    identity: ["kind", "ref"],
    claim: ["claim_id", "kind", "applicability", "provenance", "issued_at_ms", "expires_at_ms", "extensions", "critical_extensions", "proof", "capability_id", "transport_id", "protocol_id", "protocol_version", "state", "runtime_label", "provider_label", "model_label"],
    applicability: ["protocol_versions", "transport_families", "operations"],
    provenance: ["level", "issuer_ref", "observed_at_ms", "probe_ref"],
    proof: ["issuer_ref", "audience_ref", "issued_at_ms", "not_before_ms", "expires_at_ms", "challenge", "proof_format", "verification_method_ref", "proof_digest", "proof_ref"],
    template: ["template_id", "command", "argv_template"],
    feature: ["feature_id", "state", "provenance_ref"],
    loss: ["field_path", "target", "reason_code", "disposition"],
  };
  const claimSpecific: Record<string, readonly string[]> = { capability: ["capability_id", "state"], transport: ["transport_id", "state"], protocol: ["protocol_id", "protocol_version", "state"], runtime: ["runtime_label"], provider: ["provider_label"], model: ["model_label"] };
  const schemaAllowed = schema === "claim" && string(value.kind) && claimSpecific[value.kind]
    ? ["claim_id", "kind", "applicability", "provenance", "issued_at_ms", "expires_at_ms", "extensions", "critical_extensions", "proof", ...claimSpecific[value.kind]!]
    : allowed[schema];
  for (const key of Object.keys(value)) {
    if (schemaAllowed.includes(key)) continue;
    if (COMPUTED_FIELDS.has(key)) scan.computed.push(pathJoin(base, key));
    else if (schema !== "loss") scan.unknown.push(base);
  }
  if (schema === "translation") {
    scanClosedFields(value.source_profile, "profile", "$.source_profile", scan);
    scanClosedFields(value.launch_template, "template", "$.launch_template", scan);
    if (Array.isArray(value.features)) value.features.forEach((item, index) => scanClosedFields(item, "feature", `$.features[${index}]`, scan));
  } else if (schema === "result") {
    scanClosedFields(value.profile, "profile", "$.profile", scan);
    scanClosedFields(value.launch_template, "template", "$.launch_template", scan);
    if (Array.isArray(value.features)) value.features.forEach((item, index) => scanClosedFields(item, "feature", `$.features[${index}]`, scan));
    if (Array.isArray(value.losses)) value.losses.forEach((item, index) => scanClosedFields(item, "loss", `$.losses[${index}]`, scan));
  } else if (schema === "profile") {
    scanClosedFields(value.issuer, "identity", pathJoin(base, "issuer"), scan);
    scanClosedFields(value.subject, "identity", pathJoin(base, "subject"), scan);
    if (Array.isArray(value.claims)) value.claims.forEach((item, index) => scanClosedFields(item, "claim", `${base}.claims[${index}]`, scan));
  } else if (schema === "claim") {
    scanClosedFields(value.applicability, "applicability", pathJoin(base, "applicability"), scan);
    scanClosedFields(value.provenance, "provenance", pathJoin(base, "provenance"), scan);
    scanClosedFields(value.proof, "proof", pathJoin(base, "proof"), scan);
  }
}
function firstClosedFieldError(value: JsonRecord, schema: "translation" | "result"): ErrorRecord | undefined {
  const scan: ClosedFieldScan = { computed: [], unknown: [] }; scanClosedFields(value, schema, "$", scan);
  if (scan.computed.length) return { code: "FORBIDDEN_COMPUTED_FIELD", field_path: scan.computed.sort(compareAscii)[0]! };
  if (scan.unknown.length) return { code: "UNKNOWN_CORE_FIELD", field_path: [...new Set(scan.unknown)].sort(compareAscii)[0]! };
  return undefined;
}
function translationExtensionErrors(input: JsonRecord): ErrorRecord[] { const errors: ErrorRecord[] = []; extensionErrors(input, "$", errors); if (record(input.source_profile)) { extensionErrors(input.source_profile, "$.source_profile", errors); if (Array.isArray(input.source_profile.claims)) input.source_profile.claims.forEach((claim, index) => { if (record(claim)) extensionErrors(claim, `$.source_profile.claims[${index}]`, errors); }); } return errors; }
function translationTemplate(value: unknown): boolean { return record(value) && ((value.template_id === "none" && value.command === "none" && Array.isArray(value.argv_template) && value.argv_template.length === 0 && Object.keys(value).length === 3) || (value.template_id === "meshfleet.mcp-stdio/v1" && value.command === "npx" && Array.isArray(value.argv_template) && JSON.stringify(value.argv_template) === JSON.stringify(["-y", "meshfleet"]) && Object.keys(value).length === 3)); }
type NormalizedFeature = { value: JsonRecord; sourceIndex: number };
function normalizeFeatures(value: unknown, base: string): { features: JsonRecord[]; source: NormalizedFeature[]; error?: ErrorRecord } {
  if (!Array.isArray(value) || value.length > 64) return { features: [], source: [], error: { code: "INVALID_TRANSLATION_INPUT", field_path: base } };
  const source: NormalizedFeature[] = []; const structural: ErrorRecord[] = [];
  value.forEach((item, index) => {
    const itemPath = `${base}[${index}]`;
    if (!record(item)) { structural.push({ code: "INVALID_TRANSLATION_INPUT", field_path: itemPath }); return; }
    const memberErrors: string[] = [];
    if (!canonicalId(item.feature_id)) memberErrors.push(pathJoin(itemPath, "feature_id"));
    if (!opaque(item.provenance_ref)) memberErrors.push(pathJoin(itemPath, "provenance_ref"));
    if (!string(item.state) || !FEATURE_STATES.has(item.state)) memberErrors.push(pathJoin(itemPath, "state"));
    if (memberErrors.length) { structural.push({ code: "INVALID_TRANSLATION_INPUT", field_path: memberErrors.sort(compareAscii)[0]! }); return; }
    source.push({ value: { feature_id: item.feature_id, state: item.state, provenance_ref: item.provenance_ref }, sourceIndex: index });
  });
  if (structural.length) return { features: [], source, error: structural.sort((a, b) => compareAscii(a.field_path, b.field_path))[0] };
  const seen = new Set<string>();
  for (const feature of source) {
    const id = feature.value.feature_id as string;
    if (seen.has(id)) return { features: [], source, error: { code: "INVALID_TRANSLATION_INPUT", field_path: `${base}[${feature.sourceIndex}].feature_id` } };
    seen.add(id);
  }
  return { features: source.map(({ value: feature }) => feature).sort((a, b) => Buffer.compare(canonicalTree(a), canonicalTree(b))), source };
}
function normalizeProvenanceRefs(value: unknown, base: string, features: NormalizedFeature[]): { refs: string[]; error?: ErrorRecord } {
  if (!Array.isArray(value) || value.length > 64) return { refs: [], error: { code: "INVALID_TRANSLATION_INPUT", field_path: base } };
  const refs: string[] = []; const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    if (!opaque(item)) return { refs: [], error: { code: "INVALID_TRANSLATION_INPUT", field_path: `${base}[${index}]` } };
    if (seen.has(item)) return { refs: [], error: { code: "DUPLICATE_SET_MEMBER", field_path: `${base}[${index}]` } };
    seen.add(item); refs.push(item);
  }
  const missing = features.filter(({ value: feature }) => !seen.has(feature.provenance_ref as string)).sort((a, b) => a.sourceIndex - b.sourceIndex)[0];
  if (missing) return { refs: [], error: { code: "INVALID_TRANSLATION_INPUT", field_path: `$.features[${missing.sourceIndex}].provenance_ref` } };
  return { refs: refs.sort(compareAscii) };
}
function translationError(code: string, field_path: string, target_ref: string): JsonRecord { return { code, field_path, target_ref }; }
/** Translate static evidence shape only. It cannot select or launch a runtime. */
export function translateProfile(input: unknown, evaluationTime?: unknown): JsonRecord {
  if (!validTime(evaluationTime)) return translationError("INVALID_EVALUATION_TIME", "$evaluation_time_ms", "invalid"); const raw = parse(input); if (!record(raw)) return translationError("INVALID_TRANSLATION_INPUT", "$", "invalid");
  if (!string(raw.target) || !(TARGETS as readonly string[]).includes(raw.target)) return translationError("INVALID_TARGET", "$.target", "invalid"); const target = raw.target;
  const privacy: Array<{ path: string }> = []; privacyScan(raw, "$", privacy); const firstPrivacy = minPath(privacy); if (firstPrivacy) return translationError("FORBIDDEN_PRIVACY_FIELD", firstPrivacy.path, target);
  const closedField = firstClosedFieldError(raw, "translation"); if (closedField) return translationError(closedField.code, closedField.field_path, target);
  if (raw.translation_version !== TRANSLATION_VERSION) return translationError("INVALID_TRANSLATION_INPUT", "$.translation_version", target);
  let state = profileStructural(raw.source_profile, "$.source_profile", true); if (state.errors.length) { const first = state.errors[0]!; return translationError(first.code, first.field_path, target); }
  const semantic = semanticErrors(state, evaluationTime, "$.source_profile"); if (semantic.length) { const first = semantic[0]!; return translationError(first.code, first.field_path, target); }
  const extension = translationExtensionErrors(raw); if (extension.length) { const containers = extension.filter((item) => item.code === "INVALID_EXTENSION_CONTAINER"); const first = minPath(containers.length ? containers.map((item) => ({ ...item, path: item.field_path })) : extension.map((item) => ({ ...item, path: item.field_path })))!; return translationError(first.code, first.field_path, target); }
  state = profileStructural(raw.source_profile, "$.source_profile", false);
  if (!translationTemplate(raw.launch_template)) return translationError("INVALID_TRANSLATION_INPUT", "$.launch_template", target); if (!string(raw.cwd_policy) || !CWD_POLICIES.has(raw.cwd_policy)) return translationError("INVALID_TRANSLATION_INPUT", "$.cwd_policy", target);
  const feature = normalizeFeatures(raw.features, "$.features"); if (feature.error) return translationError(feature.error.code, feature.error.field_path, target); const refs = normalizeProvenanceRefs(raw.provenance_refs, "$.provenance_refs", feature.source); if (refs.error) return translationError(refs.error.code, refs.error.field_path, target);
  if (DEFERRED_TARGETS.has(target) && (raw.launch_template as JsonRecord).template_id !== "none") return translationError("UNSUPPORTED_STATIC_TEMPLATE", "$.launch_template", target);
  if (DEFERRED_TARGETS.has(target)) { const candidates: Array<{ path: string }> = []; feature.features.forEach((item, index) => { if (item.state === "supported") candidates.push({ path: `$.features[${index}].state` }); }); (state.profile.claims as JsonRecord[]).forEach((item, index) => { if (["capability", "transport", "protocol"].includes(item.kind as string) && item.state === "supported") candidates.push({ path: `$.source_profile.claims[${index}].state` }); }); const denied = minPath(candidates); if (denied) return translationError("UNSUPPORTED_TARGET_CLAIM", denied.path, target); }
  const deferred = DEFERRED_TARGETS.has(target); const copiedProfile = structuredClone(state.profile) as JsonRecord; if (deferred) copiedProfile.claims = [];
  const losses: JsonRecord[] = deferred ? [{ field_path: "$.launch_template", target, reason_code: "static_template_unavailable", disposition: "preserved_unknown" }] : !["generic-cli-stdio"].includes(target) && raw.cwd_policy !== "not-represented" ? [{ field_path: "$.cwd_policy", target, reason_code: "cwd_not_represented", disposition: "omitted_by_contract" }] : [];
  return { translation_version: TRANSLATION_RESULT_VERSION, target, launch_template: deferred ? { template_id: "none", command: "none", argv_template: [] } : raw.launch_template, cwd_policy: deferred ? "not-represented" : target === "generic-cli-stdio" ? raw.cwd_policy : "not-represented", features: deferred ? [] : feature.features, provenance_refs: deferred ? [] : refs.refs, profile: copiedProfile, losses, extensions: {}, critical_extensions: [] };
}
function resultExtensionErrors(input: JsonRecord): ErrorRecord[] { const errors: ErrorRecord[] = []; extensionErrors(input, "$", errors); if (record(input.profile)) { extensionErrors(input.profile, "$.profile", errors); if (Array.isArray(input.profile.claims)) input.profile.claims.forEach((claim, index) => { if (record(claim)) extensionErrors(claim, `$.profile.claims[${index}]`, errors); }); } return errors; }
function normalizeLosses(value: unknown): { losses: JsonRecord[]; error?: ErrorRecord } {
  if (!Array.isArray(value)) return { losses: [], error: { code: "INVALID_TRANSLATION_RESULT", field_path: "$.losses" } };
  const losses: JsonRecord[] = []; const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const item = value[index]; const itemPath = `$.losses[${index}]`;
    if (!record(item)) return { losses: [], error: { code: "INVALID_LOSS_RECORD", field_path: itemPath } };
    const allowed = ["field_path", "target", "reason_code", "disposition"];
    if (Object.keys(item).some((key) => !allowed.includes(key))) return { losses: [], error: { code: "INVALID_LOSS_RECORD", field_path: itemPath } };
    const candidates: string[] = [];
    if (!fieldPath(item.field_path)) candidates.push(pathJoin(itemPath, "field_path"));
    if (!string(item.target) || !(TARGETS as readonly string[]).includes(item.target)) candidates.push(pathJoin(itemPath, "target"));
    if (!string(item.reason_code) || !LOSS_REASONS.has(item.reason_code)) candidates.push(pathJoin(itemPath, "reason_code"));
    if (!string(item.disposition) || !LOSS_DISPOSITIONS.has(item.disposition)) candidates.push(pathJoin(itemPath, "disposition"));
    if (candidates.length) return { losses: [], error: { code: "INVALID_LOSS_RECORD", field_path: candidates.sort(compareAscii)[0]! } };
    const normalized = { field_path: item.field_path, target: item.target, reason_code: item.reason_code, disposition: item.disposition };
    const key = canonicalTree(normalized).toString("hex");
    if (seen.has(key)) return { losses: [], error: { code: "INVALID_TRANSLATION_RESULT", field_path: itemPath } };
    seen.add(key); losses.push(normalized);
  }
  return { losses: losses.sort((a, b) => compareAscii(a.field_path as string, b.field_path as string) || compareAscii(a.target as string, b.target as string) || compareAscii(a.reason_code as string, b.reason_code as string) || compareAscii(a.disposition as string, b.disposition as string)) };
}
/** Validate serialized translation evidence without consulting time or live state. */
export function validateTranslationResult(result: unknown): JsonRecord {
  const raw = parse(result); if (!record(raw)) return { ok: false, error: { code: "INVALID_TRANSLATION_RESULT", field_path: "$" } };
  const privacy: Array<{ path: string }> = []; privacyScan(raw, "$", privacy); const firstPrivacy = minPath(privacy); if (firstPrivacy) return { ok: false, error: { code: "FORBIDDEN_PRIVACY_FIELD", field_path: firstPrivacy.path } };
  const closedField = firstClosedFieldError(raw, "result"); if (closedField) return { ok: false, error: closedField };
  if (raw.translation_version !== TRANSLATION_RESULT_VERSION) return { ok: false, error: { code: "INVALID_TRANSLATION_RESULT", field_path: "$.translation_version" } };
  if (!string(raw.target) || !(TARGETS as readonly string[]).includes(raw.target)) return { ok: false, error: { code: "INVALID_TRANSLATION_RESULT", field_path: "$.target" } };
  if (!record(raw.profile)) return { ok: false, error: { code: "INVALID_TRANSLATION_RESULT", field_path: "$.profile" } };
  const profile = profileStructural(raw.profile, "$.profile", true); const profileErrors = sortErrors([...profile.errors, ...contradictionErrors(profile, "$.profile")]); if (profileErrors.length) return { ok: false, error: profileErrors[0]! };
  if (!translationTemplate(raw.launch_template)) return { ok: false, error: { code: "INVALID_TRANSLATION_RESULT", field_path: "$.launch_template" } }; if (!string(raw.cwd_policy) || !CWD_POLICIES.has(raw.cwd_policy)) return { ok: false, error: { code: "INVALID_TRANSLATION_RESULT", field_path: "$.cwd_policy" } };
  const features = normalizeFeatures(raw.features, "$.features"); if (features.error) return { ok: false, error: { code: "INVALID_TRANSLATION_RESULT", field_path: features.error.field_path } }; const refs = normalizeProvenanceRefs(raw.provenance_refs, "$.provenance_refs", features.source); if (refs.error) return { ok: false, error: { code: refs.error.code === "DUPLICATE_SET_MEMBER" ? refs.error.code : "INVALID_TRANSLATION_RESULT", field_path: refs.error.field_path } };
  const losses = normalizeLosses(raw.losses); if (losses.error) return { ok: false, error: losses.error };
  const extensions = resultExtensionErrors(raw); if (extensions.length) { const containers = extensions.filter((item) => item.code === "INVALID_EXTENSION_CONTAINER"); const first = minPath((containers.length ? containers : extensions).map((item) => ({ ...item, path: item.field_path })))!; return { ok: false, error: { code: first.code, field_path: first.field_path } }; }
  const normalizedProfile = profileStructural(raw.profile, "$.profile", false).profile;
  const normalized: JsonRecord = { translation_version: TRANSLATION_RESULT_VERSION, target: raw.target, launch_template: raw.launch_template, cwd_policy: raw.cwd_policy, features: features.features, provenance_refs: refs.refs, profile: normalizedProfile, losses: losses.losses, extensions: {}, critical_extensions: [] };
  return { ok: true, value: { validation_version: TRANSLATION_RESULT_VALIDATION_VERSION, normalized_result: normalized } };
}
/** Render only an already supplied, offline conformance record. No registry is read. */
export function renderConformance(result: unknown, registryRecord: unknown): JsonRecord {
  const raw = parse(result); const target = record(raw) && string(raw.target) && (TARGETS as readonly string[]).includes(raw.target) ? raw.target : undefined; if (!target) return translationError("INVALID_TARGET", "$.result.target", "invalid"); const registry = parse(registryRecord); if (!record(registry) || Object.keys(registry).length !== 5 || registry.registry_version !== REGISTRY_VERSION || !opaque(registry.record_id) || registry.scope !== "offline-translation") return translationError("INVALID_REGISTRY_RECORD", "$.registry_record", target); if (!string(registry.target) || !(TARGETS as readonly string[]).includes(registry.target)) return translationError("INVALID_TARGET", "$.registry_record.target", "invalid"); if (registry.target !== target) return translationError("INVALID_TARGET", "$.registry_record.target", registry.target); if (!string(registry.status) || !new Set(["documented", "static-profiled", "static-config-verified", "static-translation-verified"]).has(registry.status)) return translationError("INVALID_SCOPE_STATUS", "$.registry_record.status", target); return { ok: true, value: { record_id: registry.record_id, target, scope: "offline-translation", status: registry.status } };
}
