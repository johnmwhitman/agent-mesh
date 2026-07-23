import { canonicalEnvelopeDigest, decodeEnvelope } from "./codec.js";
import { A2A_MESSAGE_TYPES, type A2AEnvelopeV01, type AgentRef } from "./types.js";

const PROFILE_VERSION = "meshfleet.a2a.local-admission.v0.1";
const BINDING_VERSION = "meshfleet.a2a.binding-snapshot.v0.1";
const AUTHORIZATION_VERSION = "meshfleet.a2a.authorization-snapshot.v0.1";
const FIXTURE_PROVENANCE = "caller_supplied_fixture";
const TRUSTED_LOCAL_ADAPTER = "trusted_local_adapter";
const ACTION = "a2a.message.admit";
const MAX_REQUEST_BYTES = 262144;
const MAX_REQUEST_DEPTH = 8;
const MAX_EVIDENCE_LIFETIME_MS = 300000;
const MAX_SAFE = 9007199254740991;
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const ADAPTER_ID = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

type RejectCode =
  | "REQUEST_TOO_LARGE" | "INVALID_UTF8" | "MALFORMED_JSON" | "DUPLICATE_JSON_KEY"
  | "MAX_DEPTH_EXCEEDED" | "INVALID_REQUEST" | "MISSING_REQUIRED_FIELD" | "UNKNOWN_CORE_FIELD"
  | "UNSUPPORTED_PROFILE_VERSION" | "INVALID_EVALUATION_TIME" | "INVALID_REQUEST_ID"
  | "MALFORMED_ENVELOPE" | "INVALID_AUTHENTICATION_EVIDENCE" | "INVALID_BINDING_SNAPSHOT"
  | "INVALID_AUTHORIZATION_SNAPSHOT" | "AUTHORIZATION_DENIED" | "REPLAY_PROTECTION_UNAVAILABLE";

type ReplayVerdict = "unseen" | "replayed_request" | "request_id_reuse" | "duplicate" | "message_id_conflict" | "unavailable";
type AdmissionResult =
  | { kind: "rejected"; code: RejectCode; field_path: string }
  | { kind: "not_admitted"; disposition: "replayed_request" | "request_id_reuse" | "duplicate" | "message_id_conflict" | "expired_at_acceptance" }
  | {
    kind: "admission_plan";
    version: typeof PROFILE_VERSION;
    request_identity: { principal_ref: string; request_id: string };
    semantic_identity: { sender: AgentRef; message_id: string };
    action: typeof ACTION;
    audience: string;
    message_type: string;
    recipients: AgentRef[];
    envelope_digest: string;
    evaluation_time_ms: number;
    policy_basis: {
      binding_snapshot: { snapshot_version: string; snapshot_id: string; effective_from_ms: number; effective_until_ms: number };
      authorization_snapshot: { snapshot_version: string; snapshot_id: string; effective_from_ms: number; effective_until_ms: number };
    };
  };

type ReplayArgument = {
  principal_ref: string;
  request_id: string;
  sender: AgentRef;
  message_id: string;
  envelope_digest: string;
};

type ReplayOracle = (argument: ReplayArgument) => ReplayVerdict;

type LocalEvidence = {
  adapter_id: string;
  principal_ref: string;
  audience: string;
  session_ref: string;
  issued_at_ms: number;
  expires_at_ms: number;
  provenance: string;
};

type BindingRule = {
  adapter_id: string;
  principal_ref: string;
  audience: string;
  session_ref: string;
  sender: AgentRef;
};

type AuthorizationRule = BindingRule & {
  action: string;
  message_types: string[];
  recipients: AgentRef[];
};

type Snapshot<T> = {
  snapshot_version: string;
  snapshot_id: string;
  fixture_provenance: string;
  effective_from_ms: number;
  effective_until_ms: number;
  rules: T[];
};

class RawProblem extends Error {
  constructor(readonly code: "MALFORMED_JSON" | "DUPLICATE_JSON_KEY" | "MAX_DEPTH_EXCEEDED", readonly fieldPath: string) {
    super(code);
  }
}

const requestShape: Record<string, unknown> = {
  version: null,
  evaluation_time_ms: null,
  request_id: null,
  action: null,
  authentication_evidence: {
    adapter_id: null, principal_ref: null, audience: null, session_ref: null,
    issued_at_ms: null, expires_at_ms: null, provenance: null,
  },
  binding_snapshot: {
    snapshot_version: null, snapshot_id: null, fixture_provenance: null,
    effective_from_ms: null, effective_until_ms: null, rules: [],
  },
  authorization_snapshot: {
    snapshot_version: null, snapshot_id: null, fixture_provenance: null,
    effective_from_ms: null, effective_until_ms: null, rules: [],
  },
};

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

class RequestScanner {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.whitespace();
    this.value(1, requestShape, "$");
    this.whitespace();
    if (this.index !== this.source.length) this.problem("MALFORMED_JSON", "$");
    try {
      return JSON.parse(this.source) as unknown;
    } catch {
      this.problem("MALFORMED_JSON", "$");
    }
  }

  private problem(code: RawProblem["code"], path: string): never {
    throw new RawProblem(code, path);
  }

  private whitespace(): void {
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return;
      this.index += 1;
    }
  }

  private value(depth: number, known: unknown, knownPath: string): void {
    if (depth > MAX_REQUEST_DEPTH) this.problem("MAX_DEPTH_EXCEEDED", knownPath);
    const character = this.source[this.index];
    if (character === "{") return this.object(depth, known, knownPath);
    if (character === "[") return this.array(depth, known, knownPath);
    if (character === "\"") {
      this.string(knownPath);
      return;
    }
    if (character === "t") return this.literal("true", knownPath);
    if (character === "f") return this.literal("false", knownPath);
    if (character === "n") return this.literal("null", knownPath);
    if (character === "-" || (character !== undefined && character >= "0" && character <= "9")) {
      return this.number(knownPath);
    }
    this.problem("MALFORMED_JSON", knownPath);
  }

  private object(depth: number, known: unknown, knownPath: string): void {
    this.index += 1;
    this.whitespace();
    const keys = new Set<string>();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return;
    }
    while (true) {
      if (this.source[this.index] !== "\"") this.problem("MALFORMED_JSON", knownPath);
      const key = this.string(knownPath);
      if (keys.has(key)) this.problem("DUPLICATE_JSON_KEY", knownPath);
      keys.add(key);
      this.whitespace();
      if (this.source[this.index] !== ":") this.problem("MALFORMED_JSON", knownPath);
      this.index += 1;
      this.whitespace();
      const child = isRecord(known) && Object.hasOwn(known, key) ? known[key] : undefined;
      const childPath = child === undefined ? knownPath : pathMember(knownPath, key);
      this.value(depth + 1, child, childPath);
      this.whitespace();
      if (this.source[this.index] === "}") {
        this.index += 1;
        return;
      }
      if (this.source[this.index] !== ",") this.problem("MALFORMED_JSON", knownPath);
      this.index += 1;
      this.whitespace();
    }
  }

  private array(depth: number, known: unknown, knownPath: string): void {
    this.index += 1;
    this.whitespace();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return;
    }
    let position = 0;
    while (true) {
      const memberKnown = Array.isArray(known) ? known[0] : undefined;
      this.value(depth + 1, memberKnown, memberKnown === undefined ? knownPath : `${knownPath}[${position}]`);
      this.whitespace();
      if (this.source[this.index] === "]") {
        this.index += 1;
        return;
      }
      if (this.source[this.index] !== ",") this.problem("MALFORMED_JSON", knownPath);
      this.index += 1;
      this.whitespace();
      position += 1;
    }
  }

  private string(path: string): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        try {
          const decoded = JSON.parse(this.source.slice(start, this.index)) as string;
          if (hasUnpairedSurrogate(decoded)) this.problem("MALFORMED_JSON", path);
          return decoded;
        } catch (error) {
          if (error instanceof RawProblem) throw error;
          this.problem("MALFORMED_JSON", path);
        }
      }
      if (code < 0x20) this.problem("MALFORMED_JSON", path);
      if (code === 0x5c) {
        this.index += 1;
        const escape = this.source[this.index];
        if (escape === "u") {
          for (let offset = 1; offset <= 4; offset += 1) {
            const hex = this.source.charCodeAt(this.index + offset);
            if (!((hex >= 0x30 && hex <= 0x39) || (hex >= 0x41 && hex <= 0x46) || (hex >= 0x61 && hex <= 0x66))) {
              this.problem("MALFORMED_JSON", path);
            }
          }
          this.index += 5;
          continue;
        }
        if (escape === undefined || !"\"\\/bfnrt".includes(escape)) this.problem("MALFORMED_JSON", path);
      }
      this.index += 1;
    }
    this.problem("MALFORMED_JSON", path);
  }

  private literal(value: string, path: string): void {
    if (this.source.slice(this.index, this.index + value.length) !== value) this.problem("MALFORMED_JSON", path);
    this.index += value.length;
  }

  private number(path: string): void {
    const start = this.index;
    if (this.source[this.index] === "-") this.index += 1;
    if (this.source[this.index] === "0") {
      this.index += 1;
    } else {
      const digitStart = this.index;
      while (this.source[this.index] >= "0" && this.source[this.index] <= "9") this.index += 1;
      if (digitStart === this.index) this.problem("MALFORMED_JSON", path);
    }
    if (this.source[this.index] === ".") {
      this.index += 1;
      const fraction = this.index;
      while (this.source[this.index] >= "0" && this.source[this.index] <= "9") this.index += 1;
      if (fraction === this.index) this.problem("MALFORMED_JSON", path);
    }
    if (this.source[this.index] === "e" || this.source[this.index] === "E") {
      this.index += 1;
      if (this.source[this.index] === "+" || this.source[this.index] === "-") this.index += 1;
      const exponent = this.index;
      while (this.source[this.index] >= "0" && this.source[this.index] <= "9") this.index += 1;
      if (exponent === this.index) this.problem("MALFORMED_JSON", path);
    }
    const raw = this.source.slice(start, this.index);
    if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) this.problem("MALFORMED_JSON", path);
    const numeric = Number(raw);
    if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > MAX_SAFE) this.problem("MALFORMED_JSON", path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathMember(path: string, member: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(member) ? `${path}.${member}` : path;
}

function rejected(code: RejectCode, fieldPath: string): AdmissionResult {
  return { kind: "rejected", code, field_path: fieldPath };
}

function firstMissing(value: Record<string, unknown>, members: readonly string[]): string | undefined {
  return members.find((member) => !Object.hasOwn(value, member));
}

function unknownMember(value: Record<string, unknown>, members: readonly string[]): boolean {
  return Object.keys(value).some((member) => !members.includes(member));
}

function validOpaque(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_REF.test(value) && !hasUnpairedSurrogate(value);
}

function validAdapter(value: unknown): value is string {
  return typeof value === "string" && ADAPTER_ID.test(value) && !hasUnpairedSurrogate(value);
}

function localTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function localRef(value: unknown): value is AgentRef {
  return isRecord(value)
    && Object.keys(value).length === 2
    && Object.hasOwn(value, "namespace")
    && Object.hasOwn(value, "agent_id")
    && typeof value.namespace === "string"
    && typeof value.agent_id === "string"
    && value.namespace.length > 0
    && value.agent_id.length > 0
    && value.namespace !== "*"
    && value.agent_id !== "*"
    && !hasUnpairedSurrogate(value.namespace)
    && !hasUnpairedSurrogate(value.agent_id);
}

function sameRef(left: AgentRef, right: AgentRef): boolean {
  return left.namespace === right.namespace && left.agent_id === right.agent_id;
}

function refKey(value: AgentRef): string {
  return `${value.namespace}\u0000${value.agent_id}`;
}

function evidence(value: unknown): LocalEvidence | AdmissionResult {
  const path = "$.authentication_evidence";
  const members = ["adapter_id", "principal_ref", "audience", "session_ref", "issued_at_ms", "expires_at_ms", "provenance"] as const;
  if (!isRecord(value)) return rejected("INVALID_AUTHENTICATION_EVIDENCE", path);
  const missing = firstMissing(value, members);
  if (missing !== undefined) return rejected("INVALID_AUTHENTICATION_EVIDENCE", pathMember(path, missing));
  if (unknownMember(value, members)) return rejected("INVALID_AUTHENTICATION_EVIDENCE", path);
  if (!validAdapter(value.adapter_id)) return rejected("INVALID_AUTHENTICATION_EVIDENCE", `${path}.adapter_id`);
  if (!validOpaque(value.principal_ref)) return rejected("INVALID_AUTHENTICATION_EVIDENCE", `${path}.principal_ref`);
  if (!validOpaque(value.audience)) return rejected("INVALID_AUTHENTICATION_EVIDENCE", `${path}.audience`);
  if (!validOpaque(value.session_ref)) return rejected("INVALID_AUTHENTICATION_EVIDENCE", `${path}.session_ref`);
  if (!localTime(value.issued_at_ms)) return rejected("INVALID_AUTHENTICATION_EVIDENCE", `${path}.issued_at_ms`);
  if (!localTime(value.expires_at_ms)) return rejected("INVALID_AUTHENTICATION_EVIDENCE", `${path}.expires_at_ms`);
  if (value.provenance !== TRUSTED_LOCAL_ADAPTER) return rejected("INVALID_AUTHENTICATION_EVIDENCE", `${path}.provenance`);
  return value as LocalEvidence;
}

function snapshot<T extends BindingRule | AuthorizationRule>(
  value: unknown,
  kind: "binding" | "authorization",
): Snapshot<T> | AdmissionResult {
  const path = kind === "binding" ? "$.binding_snapshot" : "$.authorization_snapshot";
  const code: RejectCode = kind === "binding" ? "INVALID_BINDING_SNAPSHOT" : "INVALID_AUTHORIZATION_SNAPSHOT";
  const members = ["snapshot_version", "snapshot_id", "fixture_provenance", "effective_from_ms", "effective_until_ms", "rules"] as const;
  if (!isRecord(value)) return rejected(code, path);
  const missing = firstMissing(value, members);
  if (missing !== undefined) return rejected(code, pathMember(path, missing));
  if (unknownMember(value, members)) return rejected(code, path);
  if (value.snapshot_version !== (kind === "binding" ? BINDING_VERSION : AUTHORIZATION_VERSION)) return rejected(code, `${path}.snapshot_version`);
  if (!validOpaque(value.snapshot_id)) return rejected(code, `${path}.snapshot_id`);
  if (value.fixture_provenance !== FIXTURE_PROVENANCE) return rejected(code, `${path}.fixture_provenance`);
  if (!localTime(value.effective_from_ms)) return rejected(code, `${path}.effective_from_ms`);
  if (!localTime(value.effective_until_ms)) return rejected(code, `${path}.effective_until_ms`);
  if (!Array.isArray(value.rules) || value.rules.length > (kind === "binding" ? 256 : 2048)) return rejected(code, `${path}.rules`);

  const output: T[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.rules.length; index += 1) {
    const rule = value.rules[index];
    const rulePath = `${path}.rules[${index}]`;
    const common = ["adapter_id", "principal_ref", "audience", "session_ref", "sender"] as const;
    const ruleMembers = kind === "binding"
      ? common
      : [...common, "action", "message_types", "recipients"] as const;
    if (!isRecord(rule)) return rejected(code, rulePath);
    const ruleMissing = firstMissing(rule, ruleMembers);
    if (ruleMissing !== undefined) return rejected(code, pathMember(rulePath, ruleMissing));
    if (unknownMember(rule, ruleMembers)) return rejected(code, rulePath);
    if (!validAdapter(rule.adapter_id)) return rejected(code, `${rulePath}.adapter_id`);
    if (!validOpaque(rule.principal_ref)) return rejected(code, `${rulePath}.principal_ref`);
    if (!validOpaque(rule.audience)) return rejected(code, `${rulePath}.audience`);
    if (!validOpaque(rule.session_ref)) return rejected(code, `${rulePath}.session_ref`);
    if (!localRef(rule.sender)) return rejected(code, `${rulePath}.sender`);

    const base: BindingRule = {
      adapter_id: rule.adapter_id, principal_ref: rule.principal_ref, audience: rule.audience,
      session_ref: rule.session_ref, sender: rule.sender,
    };
    if (kind === "binding") {
      const key = [base.adapter_id, base.principal_ref, base.audience, base.session_ref].join("\u0000");
      if (seen.has(key)) return rejected(code, rulePath);
      seen.add(key);
      output.push(base as T);
      continue;
    }

    if (rule.action !== ACTION) return rejected(code, `${rulePath}.action`);
    if (!Array.isArray(rule.message_types) || rule.message_types.length < 1 || rule.message_types.length > 5) {
      return rejected(code, `${rulePath}.message_types`);
    }
    const types = new Set<string>();
    for (let typeIndex = 0; typeIndex < rule.message_types.length; typeIndex += 1) {
      const messageType = rule.message_types[typeIndex];
      if (typeof messageType !== "string" || !(A2A_MESSAGE_TYPES as readonly string[]).includes(messageType) || types.has(messageType)) {
        return rejected(code, `${rulePath}.message_types[${typeIndex}]`);
      }
      types.add(messageType);
    }
    if (!Array.isArray(rule.recipients) || rule.recipients.length < 1 || rule.recipients.length > 128) {
      return rejected(code, `${rulePath}.recipients`);
    }
    const recipients: AgentRef[] = [];
    const recipientKeys = new Set<string>();
    for (let recipientIndex = 0; recipientIndex < rule.recipients.length; recipientIndex += 1) {
      const recipient = rule.recipients[recipientIndex];
      if (!localRef(recipient)) return rejected(code, `${rulePath}.recipients[${recipientIndex}]`);
      const recipientKey = refKey(recipient);
      if (recipientKeys.has(recipientKey)) return rejected(code, `${rulePath}.recipients[${recipientIndex}]`);
      recipientKeys.add(recipientKey);
      recipients.push(recipient);
    }
    const authorization = {
      ...base,
      action: ACTION,
      message_types: [...types],
      recipients,
    } as AuthorizationRule;
    const key = [base.adapter_id, base.principal_ref, base.audience, base.session_ref, refKey(base.sender), ACTION].join("\u0000");
    if (seen.has(key)) return rejected(code, rulePath);
    seen.add(key);
    output.push(authorization as T);
  }

  return {
    snapshot_version: value.snapshot_version as string,
    snapshot_id: value.snapshot_id as string,
    fixture_provenance: value.fixture_provenance as string,
    effective_from_ms: value.effective_from_ms as number,
    effective_until_ms: value.effective_until_ms as number,
    rules: output,
  };
}

function projectedEnvelopePath(error: unknown): string {
  const detail = error instanceof Error ? error.message : "";
  if (detail.includes("recipient")) return "$.envelope.recipients";
  const field = detail.match(/\b(sender|recipients\[\d+\]|payload(?:\.[a-z_]+)?|scope(?:\.fleet_id)?|protocol|version|kind|message_id|type|issued_at_ms|expires_at_ms|audience|correlation_id|dedupe_key)\b/)?.[1];
  return field === undefined ? "$.envelope" : `$.envelope.${field}`;
}

function parseRequest(value: string): { value: Record<string, unknown> } | AdmissionResult {
  if (typeof value !== "string" || hasUnpairedSurrogate(value) || value.charCodeAt(0) === 0xfeff) {
    return rejected("INVALID_UTF8", "$");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_REQUEST_BYTES) return rejected("REQUEST_TOO_LARGE", "$");
  try {
    const parsed = new RequestScanner(value).parse();
    if (!isRecord(parsed)) return rejected("INVALID_REQUEST", "$");
    return { value: parsed };
  } catch (error) {
    if (error instanceof RawProblem) return rejected(error.code, error.fieldPath);
    return rejected("MALFORMED_JSON", "$");
  }
}

function isRejected(value: unknown): value is AdmissionResult {
  return isRecord(value) && (value.kind === "rejected" || value.kind === "not_admitted");
}

/**
 * Offline reference-only local admission evaluator. Its sole success is an
 * ephemeral plan; it performs no persistence, delivery, execution, or I/O.
 */
export function evaluateLocalAdmission(requestJson: string, envelopeJson: string, replayOracle: ReplayOracle): AdmissionResult {
  const parsed = parseRequest(requestJson);
  if (isRejected(parsed)) return parsed;
  const request = parsed.value;
  const topMembers = ["version", "evaluation_time_ms", "request_id", "action", "authentication_evidence", "binding_snapshot", "authorization_snapshot"] as const;
  const topMissing = firstMissing(request, topMembers);
  if (topMissing !== undefined) return rejected("MISSING_REQUIRED_FIELD", pathMember("$", topMissing));
  if (unknownMember(request, topMembers)) return rejected("UNKNOWN_CORE_FIELD", "$");
  if (request.version !== PROFILE_VERSION) return rejected("UNSUPPORTED_PROFILE_VERSION", "$.version");
  if (!localTime(request.evaluation_time_ms)) return rejected("INVALID_EVALUATION_TIME", "$.evaluation_time_ms");
  if (!validOpaque(request.request_id)) return rejected("INVALID_REQUEST_ID", "$.request_id");
  if (request.action !== ACTION) return rejected("INVALID_REQUEST", "$.action");

  let envelope: A2AEnvelopeV01;
  let envelopeDigest: string;
  try {
    envelope = decodeEnvelope(envelopeJson);
    envelopeDigest = canonicalEnvelopeDigest(envelope);
  } catch (error) {
    return rejected("MALFORMED_ENVELOPE", projectedEnvelopePath(error));
  }

  const localEvidence = evidence(request.authentication_evidence);
  if (isRejected(localEvidence)) return localEvidence;
  const binding = snapshot<BindingRule>(request.binding_snapshot, "binding");
  if (isRejected(binding)) return binding;
  const authorization = snapshot<AuthorizationRule>(request.authorization_snapshot, "authorization");
  if (isRejected(authorization)) return authorization;

  const evaluationTime = request.evaluation_time_ms;
  if (
    localEvidence.issued_at_ms > evaluationTime
    || evaluationTime >= localEvidence.expires_at_ms
    || localEvidence.expires_at_ms - localEvidence.issued_at_ms > MAX_EVIDENCE_LIFETIME_MS
    || binding.effective_from_ms >= binding.effective_until_ms
    || authorization.effective_from_ms >= authorization.effective_until_ms
    || evaluationTime < binding.effective_from_ms
    || evaluationTime >= binding.effective_until_ms
    || evaluationTime < authorization.effective_from_ms
    || evaluationTime >= authorization.effective_until_ms
  ) {
    return rejected("AUTHORIZATION_DENIED", "$");
  }

  const contextMatches = (rule: BindingRule): boolean =>
    rule.adapter_id === localEvidence.adapter_id
    && rule.principal_ref === localEvidence.principal_ref
    && rule.audience === localEvidence.audience
    && rule.session_ref === localEvidence.session_ref;
  const bindingRule = binding.rules.find(contextMatches);
  if (
    bindingRule === undefined
    || !sameRef(bindingRule.sender, envelope.sender)
    || envelope.audience === undefined
    || envelope.audience !== localEvidence.audience
  ) {
    return rejected("AUTHORIZATION_DENIED", "$");
  }

  const authorizationRule = authorization.rules.find((rule) =>
    contextMatches(rule)
    && sameRef(rule.sender, envelope.sender)
    && rule.action === ACTION,
  );
  if (
    authorizationRule === undefined
    || !authorizationRule.message_types.includes(envelope.type)
    || !envelope.recipients.every((recipient) => authorizationRule.recipients.some((allowed) => sameRef(allowed, recipient)))
  ) {
    return rejected("AUTHORIZATION_DENIED", "$");
  }

  const oracleArgument: ReplayArgument = {
    principal_ref: localEvidence.principal_ref,
    request_id: request.request_id,
    sender: { namespace: envelope.sender.namespace, agent_id: envelope.sender.agent_id },
    message_id: envelope.message_id,
    envelope_digest: envelopeDigest,
  };
  let replay: unknown;
  try {
    replay = replayOracle(oracleArgument);
  } catch {
    return rejected("REPLAY_PROTECTION_UNAVAILABLE", "$");
  }
  if (replay === "replayed_request" || replay === "request_id_reuse" || replay === "duplicate" || replay === "message_id_conflict") {
    return { kind: "not_admitted", disposition: replay };
  }
  if (replay !== "unseen") return rejected("REPLAY_PROTECTION_UNAVAILABLE", "$");
  if (envelope.expires_at_ms !== undefined && envelope.expires_at_ms <= evaluationTime) {
    return { kind: "not_admitted", disposition: "expired_at_acceptance" };
  }

  return {
    kind: "admission_plan",
    version: PROFILE_VERSION,
    request_identity: { principal_ref: localEvidence.principal_ref, request_id: request.request_id },
    semantic_identity: {
      sender: { namespace: envelope.sender.namespace, agent_id: envelope.sender.agent_id },
      message_id: envelope.message_id,
    },
    action: ACTION,
    audience: localEvidence.audience,
    message_type: envelope.type,
    recipients: envelope.recipients.map((recipient) => ({ namespace: recipient.namespace, agent_id: recipient.agent_id })),
    envelope_digest: envelopeDigest,
    evaluation_time_ms: evaluationTime,
    policy_basis: {
      binding_snapshot: {
        snapshot_version: binding.snapshot_version,
        snapshot_id: binding.snapshot_id,
        effective_from_ms: binding.effective_from_ms,
        effective_until_ms: binding.effective_until_ms,
      },
      authorization_snapshot: {
        snapshot_version: authorization.snapshot_version,
        snapshot_id: authorization.snapshot_id,
        effective_from_ms: authorization.effective_from_ms,
        effective_until_ms: authorization.effective_until_ms,
      },
    },
  };
}
