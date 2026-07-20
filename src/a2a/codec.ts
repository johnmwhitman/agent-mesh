import {
  A2A_KIND,
  A2A_MESSAGE_TYPES,
  A2A_PROTOCOL,
  A2A_VERSION,
  type A2AEnvelopeV01,
  type AgentRef,
  type EnvelopeIdentityResult,
} from "./types.js";

export const MAX_A2A_BODY_BYTES = 64 * 1024;
const MAX_MEDIA_TYPE_BYTES = 1024;

export interface ValidationOptions {
  /** Validate expiration against this clock. Omit to validate envelope shape only. */
  nowMs?: number;
  /** Reject envelopes whose expiry is at or before `nowMs`. */
  forAcceptance?: boolean;
}

function fail(message: string): never {
  throw new Error(`Invalid meshfleet.a2a envelope: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
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

function scalarString(value: string, field: string): string {
  if (hasUnpairedSurrogate(value)) fail(`${field} must contain only Unicode scalar values`);
  return value;
}

function validateScalarTree(value: unknown, field: string, seen = new Set<object>()): void {
  if (typeof value === "string") {
    scalarString(value, field);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) fail(`${field} must be an acyclic JSON tree`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((nested, index) => validateScalarTree(nested, `${field}[${index}]`, seen));
  } else {
    for (const key of Object.keys(value)) {
      scalarString(key, `${field} key`);
      validateScalarTree((value as Record<string, unknown>)[key], `${field}.${key}`, seen);
    }
  }
  seen.delete(value);
}

// Language-neutral v0.1 media grammar. All input is ASCII and at most 1024 bytes:
// token "/" token *( OWS ";" OWS token OWS "=" OWS (token / quoted) ).
// token is the RFC token character set; OWS is SP or HTAB only. Quoted content
// is ASCII HTAB, SP, or visible characters, with backslash escaping one such byte.
function isTokenCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || "!#$%&'*+-.^_`|~".includes(String.fromCharCode(code));
}

function consumeToken(value: string, start: number): number {
  let index = start;
  while (index < value.length && isTokenCode(value.charCodeAt(index))) index += 1;
  return index;
}

function consumeOws(value: string, start: number): number {
  let index = start;
  while (index < value.length && (value.charCodeAt(index) === 0x20 || value.charCodeAt(index) === 0x09)) index += 1;
  return index;
}

function validMediaType(value: string): boolean {
  if (value.length === 0 || value.length > MAX_MEDIA_TYPE_BYTES) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  let index = consumeToken(value, 0);
  if (index === 0 || value[index] !== "/") return false;
  index += 1;
  const subtypeStart = index;
  index = consumeToken(value, index);
  if (index === subtypeStart) return false;
  while (true) {
    index = consumeOws(value, index);
    if (index === value.length) return true;
    if (value[index] !== ";") return false;
    index = consumeOws(value, index + 1);
    const nameStart = index;
    index = consumeToken(value, index);
    if (index === nameStart) return false;
    index = consumeOws(value, index);
    if (value[index] !== "=") return false;
    index = consumeOws(value, index + 1);
    if (value[index] === "\"") {
      index += 1;
      let closed = false;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code === 0x22) {
          index += 1;
          closed = true;
          break;
        }
        if (code === 0x5c) {
          index += 1;
          if (index >= value.length) return false;
          const escaped = value.charCodeAt(index);
          if (!(escaped === 0x09 || (escaped >= 0x20 && escaped <= 0x7e))) return false;
          index += 1;
          continue;
        }
        if (!(code === 0x09 || code === 0x20 || code === 0x21 || (code >= 0x23 && code <= 0x5b) || (code >= 0x5d && code <= 0x7e))) return false;
        index += 1;
      }
      if (!closed) return false;
    } else {
      const valueStart = index;
      index = consumeToken(value, index);
      if (index === valueStart) return false;
    }
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${field} must be a non-empty string`);
  return scalarString(value, field);
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    fail(`${field} must be a finite non-negative integer`);
  }
  return value;
}

function agentRef(value: unknown, field: string): AgentRef {
  if (!isRecord(value)) fail(`${field} must be an agent reference`);
  const namespace = nonEmptyString(value.namespace, `${field}.namespace`);
  const agentId = nonEmptyString(value.agent_id, `${field}.agent_id`);
  if (namespace === "*" || agentId === "*") fail(`${field} must not contain a wildcard`);
  return { namespace, agent_id: agentId };
}

function refKey(ref: AgentRef): string {
  return `${ref.namespace}\u0000${ref.agent_id}`;
}

function validatePayload(value: unknown): A2AEnvelopeV01["payload"] {
  if (!isRecord(value)) fail("payload must be an object");
  const mediaType = nonEmptyString(value.media_type, "payload.media_type");
  if (typeof value.body !== "string") fail("payload.body must be a string");
  const body = scalarString(value.body, "payload.body");
  if (Buffer.byteLength(body, "utf-8") > MAX_A2A_BODY_BYTES) {
    fail(`payload.body exceeds ${MAX_A2A_BODY_BYTES} UTF-8 bytes`);
  }
  if (!validMediaType(mediaType)) {
    fail("payload.media_type must be a valid media type");
  }
  const baseMediaType = mediaType.split(";", 1)[0]!.trimEnd().toLowerCase();
  if (baseMediaType === "application/json" || baseMediaType.endsWith("+json")) {
    try {
      const parsed = JSON.parse(body) as unknown;
      validateScalarTree(parsed, "payload JSON");
    } catch {
      fail("payload.body must be valid JSON for a JSON media type");
    }
  }
  return { media_type: mediaType, body };
}

function optionalOpaqueString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(value, field);
}

/** Validate and normalize a v0.1 envelope without importing transports or runtimes. */
export function validateEnvelope(input: unknown, options: ValidationOptions = {}): A2AEnvelopeV01 {
  if (!isRecord(input)) fail("envelope must be an object");
  validateScalarTree(input, "envelope");
  if (input.protocol !== A2A_PROTOCOL) fail(`protocol must equal ${A2A_PROTOCOL}`);
  const version = nonEmptyString(input.version, "version");
  if (version !== A2A_VERSION) fail(`unsupported version ${version}`);
  if (input.kind !== A2A_KIND) fail(`kind must equal ${A2A_KIND}`);

  const sender = agentRef(input.sender, "sender");
  if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
    fail("recipients must be a non-empty array");
  }
  const recipients = input.recipients.map((recipient, index) => agentRef(recipient, `recipients[${index}]`));
  const recipientKeys = new Set<string>();
  for (const recipient of recipients) {
    const key = refKey(recipient);
    if (recipientKeys.has(key)) fail("recipients must be unique");
    if (key === refKey(sender)) fail("sender must not be a recipient");
    recipientKeys.add(key);
  }

  const type = nonEmptyString(input.type, "type");
  if (!(A2A_MESSAGE_TYPES as readonly string[]).includes(type)) fail(`unsupported message type ${type}`);
  const issuedAt = timestamp(input.issued_at_ms, "issued_at_ms");
  const expiresAt = input.expires_at_ms === undefined ? undefined : timestamp(input.expires_at_ms, "expires_at_ms");
  if (expiresAt !== undefined && expiresAt <= issuedAt) fail("expires_at_ms must be greater than issued_at_ms");
  if (options.forAcceptance && expiresAt !== undefined && expiresAt <= (options.nowMs ?? Date.now())) {
    fail("envelope is expired");
  }

  let extensions: Record<string, unknown> | undefined;
  if (input.extensions !== undefined) {
    if (!isRecord(input.extensions)) fail("extensions must be an object");
    extensions = input.extensions;
  }
  let scope: { fleet_id: string } | undefined;
  if (input.scope !== undefined) {
    if (!isRecord(input.scope)) fail("scope must be an object");
    scope = { fleet_id: nonEmptyString(input.scope.fleet_id, "scope.fleet_id") };
  }

  return {
    protocol: A2A_PROTOCOL,
    version: A2A_VERSION,
    kind: A2A_KIND,
    message_id: nonEmptyString(input.message_id, "message_id"),
    sender,
    recipients,
    type: type as A2AEnvelopeV01["type"],
    issued_at_ms: issuedAt,
    ...(expiresAt === undefined ? {} : { expires_at_ms: expiresAt }),
    ...(input.audience === undefined ? {} : { audience: optionalOpaqueString(input.audience, "audience")! }),
    ...(input.correlation_id === undefined ? {} : { correlation_id: optionalOpaqueString(input.correlation_id, "correlation_id")! }),
    ...(input.dedupe_key === undefined ? {} : { dedupe_key: optionalOpaqueString(input.dedupe_key, "dedupe_key")! }),
    payload: validatePayload(input.payload),
    ...(extensions === undefined ? {} : { extensions }),
    ...(scope === undefined ? {} : { scope }),
  };
}

export function decodeEnvelope(serialized: string, options?: ValidationOptions): A2AEnvelopeV01 {
  try {
    return validateEnvelope(JSON.parse(serialized), options);
  } catch (error) {
    if (error instanceof SyntaxError) fail("serialized input must be valid JSON");
    throw error;
  }
}

export function encodeEnvelope(input: unknown): string {
  return JSON.stringify(validateEnvelope(input));
}

/**
 * JSON.stringify preserves insertion order for object keys. Identity must instead
 * compare the canonical JSON value, so extension-object key ordering is inert.
 */
function stableJson(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, nested: unknown) => {
    if (!isRecord(nested)) return nested;
    return Object.fromEntries(Object.keys(nested).sort().map((key) => [key, nested[key]]));
  });
  if (serialized === undefined) throw new Error("Envelope fingerprint must be JSON serializable");
  return serialized;
}

/** In-memory identity semantics for transports; persistence is deliberately out of this slice. */
export class EnvelopeIdentityRegistry {
  private readonly fingerprints = new Map<string, string>();

  accept(input: unknown): EnvelopeIdentityResult {
    const envelope = validateEnvelope(input);
    const key = envelope.dedupe_key ?? envelope.message_id;
    const fingerprint = stableJson(envelope);
    const previous = this.fingerprints.get(key);
    if (previous === undefined) {
      this.fingerprints.set(key, fingerprint);
      return "accepted";
    }
    return previous === fingerprint ? "duplicate" : "conflict";
  }
}
