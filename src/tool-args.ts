/**
 * Boundary validation for MCP tool arguments.
 *
 * The MCP SDK enforces neither `required` nor `type` from a tool's published
 * `inputSchema`, and for most of this server's history the handlers did not
 * either. Three defects of that family have already shipped and been fixed:
 *
 *   - `register_capability` mapped a snake_case wire payload onto a camelCase
 *     signature, so ids arrived `undefined`, every registration collapsed onto
 *     one row keyed "undefined", and the tool returned `{ok: true}`.
 *   - `cast_vote` read a required boolean for truthiness: omitting `approve`
 *     recorded a binding DECLINE, and `approve: "false"` recorded an APPROVAL.
 *   - `receipt` accepted a missing `action`, corrupting the
 *     `message_id:agent_id:action` idempotency key.
 *
 * A 27-tool audit then found the same exposure in a dozen more handlers. The
 * lesson is that per-handler ad-hoc checks are how the inconsistency happened in
 * the first place, so validation lives here, once, and every handler uses it.
 *
 * Each check returns an error STRING or null, so a handler can collect several
 * and report the first — no exceptions to catch, and the message always names
 * the field and what was actually received.
 */

/** Returns the first non-null error, or null when every check passed. */
export function firstError(...errors: (string | null)[]): string | null {
  for (const e of errors) if (e !== null) return e;
  return null;
}

const got = (v: unknown): string => `${JSON.stringify(v)} (${v === null ? "null" : typeof v})`;

/** A required, non-blank string. Blank-safe: "   " names nothing. */
export function requireString(tool: string, field: string, v: unknown): string | null {
  if (typeof v !== "string" || v.trim().length === 0) {
    return `${tool}: '${field}' is required and must be a non-empty string, got ${got(v)}`;
  }
  return null;
}

/** A required string whose empty value is meaningful (for example a payload body). */
export function requirePresentString(tool: string, field: string, v: unknown): string | null {
  if (typeof v !== "string") {
    return `${tool}: '${field}' is required and must be a string, got ${got(v)}`;
  }
  return null;
}

/**
 * An optional, non-blank string. Absence is valid; null is an explicitly
 * supplied non-string value and must not silently become absence.
 */
export function optionalNonBlankString(tool: string, field: string, v: unknown): string | null {
  if (v === undefined) return null;
  if (typeof v !== "string" || v.trim().length === 0) {
    return `${tool}: '${field}' must be a non-empty string when provided, got ${got(v)}`;
  }
  return null;
}

/**
 * A required real boolean. Never accept truthiness here: a string "false" is
 * truthy and a missing value is falsy, so a truthiness read silently inverts or
 * invents the caller's intent. That is exactly how `cast_vote` recorded
 * approvals as declines.
 */
export function requireBoolean(tool: string, field: string, v: unknown): string | null {
  if (typeof v !== "boolean") {
    return (
      `${tool}: '${field}' is required and must be a boolean, got ${got(v)}. ` +
      `Refusing to infer intent — a truthiness reading would treat "false" as true ` +
      `and an omitted value as false.`
    );
  }
  return null;
}

/** A required finite number, optionally bounded. */
export function requireNumber(
  tool: string,
  field: string,
  v: unknown,
  opts: { min?: number; integer?: boolean } = {}
): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return `${tool}: '${field}' is required and must be a finite number, got ${got(v)}`;
  }
  if (opts.integer && !Number.isInteger(v)) {
    return `${tool}: '${field}' must be an integer, got ${v}`;
  }
  if (opts.min !== undefined && v < opts.min) {
    return `${tool}: '${field}' must be >= ${opts.min}, got ${v}`;
  }
  return null;
}

/**
 * An optional real boolean — absent is fine, truthiness never is.
 *
 * The optional case is the more dangerous one, because the natural reading is
 * `params.flag ?? false` and that treats the string `"false"` as `true`. On
 * `reply_discussion.close` that silently makes a conversation terminal.
 */
export function optionalBoolean(tool: string, field: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "boolean") {
    return (
      `${tool}: '${field}' must be a boolean when provided, got ${got(v)}. ` +
      `Refusing to infer intent — the string "false" is truthy.`
    );
  }
  return null;
}

/** An optional finite number — absent is fine, but a non-number is not. */
export function optionalNumber(tool: string, field: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return (
      `${tool}: '${field}' must be a finite number when provided, got ${got(v)}. ` +
      `A non-numeric value compares as NaN and would silently match nothing.`
    );
  }
  return null;
}

/**
 * Optional public model selector (`provider/model`).
 *
 * `undefined` alone means omitted. When present the value must be a string of
 * JS length ≤ 256, contain no whitespace, and contain non-empty provider and
 * model segments separated by the first `/`. Additional slashes after the
 * first are valid. Does not trim, normalize, or catalog-check.
 */
export function optionalModelSelector(tool: string, field: string, v: unknown): string | null {
  if (v === undefined) return null;
  if (
    typeof v === "string"
    && v.length <= 256
    && !/\s/u.test(v)
    && v.indexOf("/") > 0
    && v.indexOf("/") < v.length - 1
  ) {
    return null;
  }
  return (
    `${tool}: '${field}' must be a provider/model selector string (length ≤ 256, ` +
    `no whitespace, non-empty provider and model) when provided, got ${got(v)}`
  );
}

/**
 * A string array. A bare string is REJECTED rather than coerced: `voters:
 * "alice"` spread into five single-character voters and locked every real voter
 * out of the council.
 */
export function requireStringArray(
  tool: string,
  field: string,
  v: unknown,
  opts: { optional?: boolean } = {}
): string | null {
  if (v === undefined || v === null) {
    return opts.optional ? null : `${tool}: '${field}' is required and must be an array of strings`;
  }
  if (typeof v === "string") {
    return (
      `${tool}: '${field}' must be an ARRAY of strings, got the bare string ${JSON.stringify(v)}. ` +
      `A string would be iterated character by character.`
    );
  }
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string" && s.trim().length > 0)) {
    return `${tool}: '${field}' must be an array of non-empty strings, got ${got(v)}`;
  }
  return null;
}

/** One of a closed set. Case-sensitive: the schema declares exact values. */
export function requireEnum(
  tool: string,
  field: string,
  v: unknown,
  allowed: readonly string[],
  opts: { optional?: boolean } = {}
): string | null {
  if (v === undefined || v === null) {
    return opts.optional ? null : `${tool}: '${field}' is required and must be one of ${allowed.join(" | ")}`;
  }
  if (typeof v !== "string" || !allowed.includes(v)) {
    return (
      `${tool}: '${field}' must be exactly one of ${allowed.join(" | ")}, got ${got(v)}. ` +
      `An unrecognized value would silently fall through to a default.`
    );
  }
  return null;
}
