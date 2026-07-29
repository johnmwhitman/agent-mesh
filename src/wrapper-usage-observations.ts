/**
 * Pure, object-only adapter for a sanitized fleet wrapper usage summary.
 *
 * This module deliberately has no imports. It does not parse raw JSON bytes,
 * read a ledger, inspect the clock, persist state, emit MCP tools, or produce
 * route-candidate observations. The caller owns JSON decoding and the producer
 * owns the source digest carried here as provenance.
 */

export const WRAPPER_USAGE_SUMMARY_VERSION =
  "fleet.wrapper-usage-summary/v1" as const;
export const WRAPPER_USAGE_STATUS_VERSION =
  "meshfleet.wrapper-usage-status/v1" as const;

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_LINES = 100_000;
const MAX_GROUPS = 64;
const SHA256 = /^[0-9a-f]{64}$/;
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const PRODUCER_EFFECT_KEYS = [
  "logging_activated",
  "meshfleet_projected",
  "provider_calls_made",
  "provider_identity_inferred",
  "quota_or_balance_inferred",
  "routing_or_scheduling_changed",
  "source_modified",
  "unused_quota_rewarded",
] as const;

const REJECTION_KEYS = [
  "duplicate_begin",
  "duplicate_finish",
  "invalid_event_invariant",
  "invalid_field_set",
  "invalid_field_type",
  "invalid_field_value",
  "invalid_json",
  "invalid_schema_version",
  "non_canonical_json",
  "non_object_json",
  "orphan_finish",
  "pair_mismatch",
] as const;

const FAILURE_CLASSES = [
  "auth",
  "empty",
  "interrupted",
  "invalid_request",
  "none",
  "protocol",
  "quota",
  "rate_limit",
  "route_unavailable",
  "timeout",
  "transport",
  "unknown",
] as const;

const GROUP_KEYS = [
  "accounting_lane",
  "duration_ms_observations",
  "duration_ms_total",
  "failure",
  "failure_class_counts",
  "incomplete",
  "input_tokens_observations",
  "input_tokens_total",
  "model_tag",
  "output_tokens_observations",
  "output_tokens_total",
  "requested_service",
  "success",
  "transport",
  "wrapper",
] as const;

const MODEL_TAGS = new Set(["default", "allowlisted", "custom"]);
const DIMENSION_TUPLES = new Set([
  "grk\u0000grok-build\u0000grok-build\u0000subscription",
  "grk\u0000grok-chat\u0000grok-chat\u0000subscription",
  "klo\u0000kilo\u0000kilo\u0000direct",
  "klo\u0000routeplane-unattributed\u0000routeplane\u0000routeplane",
  "mmx\u0000minimax-text\u0000minimax-text\u0000direct",
  "mmx\u0000routeplane-unattributed\u0000routeplane\u0000routeplane",
  "ocg\u0000opencode-go\u0000opencode-go\u0000direct",
  "ocg\u0000routeplane-unattributed\u0000routeplane\u0000routeplane",
  "olc\u0000ollama-cloud\u0000ollama-cloud\u0000direct",
  "olc\u0000routeplane-unattributed\u0000routeplane\u0000routeplane",
]);

type RecordValue = Record<string, unknown>;
type ProducerEffectKey = typeof PRODUCER_EFFECT_KEYS[number];
type RejectionKey = typeof REJECTION_KEYS[number];
type FailureClass = typeof FAILURE_CLASSES[number];

export type WrapperUsageProducerEffectFlags = {
  [Key in ProducerEffectKey]: false;
};

export type WrapperUsageRejections = {
  [Key in RejectionKey]: number;
};

export type WrapperUsageFailureClassCounts = {
  [Key in FailureClass]: number;
};

export interface WrapperUsageGroup {
  wrapper: "grk" | "klo" | "mmx" | "ocg" | "olc";
  accounting_lane:
    | "grok-build"
    | "grok-chat"
    | "kilo"
    | "minimax-text"
    | "ollama-cloud"
    | "opencode-go"
    | "routeplane-unattributed";
  requested_service:
    | "grok-build"
    | "grok-chat"
    | "kilo"
    | "minimax-text"
    | "ollama-cloud"
    | "opencode-go"
    | "routeplane";
  transport: "direct" | "routeplane" | "subscription";
  model_tag: "allowlisted" | "custom" | "default";
  success: number;
  failure: number;
  incomplete: number;
  failure_class_counts: WrapperUsageFailureClassCounts;
  input_tokens_total: number;
  input_tokens_observations: number;
  output_tokens_total: number;
  output_tokens_observations: number;
  duration_ms_total: number;
  duration_ms_observations: number;
}

export interface WrapperUsageStatusResult {
  schema_version: typeof WRAPPER_USAGE_STATUS_VERSION;
  accepted: true;
  effects: {
    persisted: false;
    executed: false;
    authorized: false;
    woke_agents: false;
    contacted_providers: false;
  };
  authority: {
    executes: false;
    schedules: false;
    changes_routing: false;
    persists: false;
    activates_logging: false;
    infers_provider_identity: false;
    infers_quota_or_balance: false;
    derives_meshfleet_health: false;
  };
  source: {
    summary_schema_version: typeof WRAPPER_USAGE_SUMMARY_VERSION;
    window: {
      start_ms: number;
      end_ms: number;
    };
    bytes: number;
    lines: number;
    sha256: string;
    producer_effect_flags: WrapperUsageProducerEffectFlags;
  };
  rejections: WrapperUsageRejections;
  groups: WrapperUsageGroup[];
}

function invalid(path: string, detail: string): never {
  throw new Error(`wrapper_usage_observations: '${path}' ${detail}`);
}

function requireRecord(value: unknown, path: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(path, "must be an object");
  }
  let prototype: object | null;
  let ownKeys: Array<string | symbol>;
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    invalid(path, "must be a plain or null-prototype JSON object");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(path, "must be a plain or null-prototype JSON object");
  }
  for (const key of ownKeys!) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      invalid(`${path}.<non-json-member>`, "is not allowed");
    }
    if (
      typeof key !== "string" ||
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      invalid(`${path}.<non-json-member>`, "is not allowed");
    }
  }
  return value as RecordValue;
}

function requireExactKeys(
  value: RecordValue,
  path: string,
  expected: readonly string[],
): void {
  const unknown = Object.keys(value).find((key) => !expected.includes(key));
  if (unknown !== undefined) invalid(`${path}.<unknown-member>`, "is not allowed");
  const missing = expected.find((key) =>
    !Object.prototype.hasOwnProperty.call(value, key)
  );
  if (missing !== undefined) invalid(`${path}.${missing}`, "is required");
}

function requireJsonArray(
  value: unknown,
  path: string,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    invalid(path, `must be an array with 0..${maximum} items`);
  }
  let prototype: object | null;
  let ownKeys: Array<string | symbol>;
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    invalid(path, "must be a plain JSON array");
  }
  if (prototype !== Array.prototype) {
    invalid(path, "must be a plain JSON array");
  }
  const indexPattern = /^(0|[1-9][0-9]*)$/;
  for (const key of ownKeys!) {
    if (key === "length") continue;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      invalid(`${path}.<non-json-member>`, "is not allowed");
    }
    if (
      typeof key !== "string" ||
      !indexPattern.test(key) ||
      Number(key) >= value.length ||
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      invalid(`${path}.<non-json-member>`, "is not allowed");
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      invalid(`${path}.<non-json-member>`, "is not allowed");
    }
  }
  return value;
}

function requireInteger(
  value: unknown,
  path: string,
  maximum = MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    invalid(path, `must be an integer between 0 and ${maximum}`);
  }
  return value;
}

function checkedAdd(left: number, right: number, path: string): number {
  if (left > MAX_SAFE_INTEGER - right) {
    invalid(path, "must not overflow the JavaScript safe-integer range");
  }
  return left + right;
}

function validateProducerEffects(value: unknown): WrapperUsageProducerEffectFlags {
  const record = requireRecord(value, "input.effect_flags");
  requireExactKeys(record, "input.effect_flags", PRODUCER_EFFECT_KEYS);
  for (const key of PRODUCER_EFFECT_KEYS) {
    if (record[key] !== false) {
      invalid(`input.effect_flags.${key}`, "must be false");
    }
  }
  return Object.fromEntries(
    PRODUCER_EFFECT_KEYS.map((key) => [key, false]),
  ) as WrapperUsageProducerEffectFlags;
}

function validateRejections(value: unknown): WrapperUsageRejections {
  const record = requireRecord(value, "input.rejections");
  requireExactKeys(record, "input.rejections", REJECTION_KEYS);
  return Object.fromEntries(
    REJECTION_KEYS.map((key) => [
      key,
      requireInteger(record[key], `input.rejections.${key}`, MAX_SOURCE_LINES),
    ]),
  ) as WrapperUsageRejections;
}

function validateWindow(value: unknown): { start_ms: number; end_ms: number } {
  const record = requireRecord(value, "input.window");
  requireExactKeys(record, "input.window", ["end_ms", "start_ms"]);
  const startMs = requireInteger(record.start_ms, "input.window.start_ms");
  const endMs = requireInteger(record.end_ms, "input.window.end_ms");
  if (startMs >= endMs) {
    invalid("input.window", "must be a non-empty half-open interval");
  }
  return { start_ms: startMs, end_ms: endMs };
}

function validateSource(value: unknown): {
  bytes: number;
  lines: number;
  sha256: string;
} {
  const record = requireRecord(value, "input.source");
  requireExactKeys(record, "input.source", ["bytes", "lines", "sha256"]);
  const bytes = requireInteger(
    record.bytes,
    "input.source.bytes",
    MAX_SOURCE_BYTES,
  );
  const lines = requireInteger(
    record.lines,
    "input.source.lines",
    MAX_SOURCE_LINES,
  );
  if ((bytes === 0) !== (lines === 0) || lines > bytes) {
    invalid(
      "input.source",
      "must describe zero bytes and zero lines together, with lines no greater than bytes",
    );
  }
  if (typeof record.sha256 !== "string" || !SHA256.test(record.sha256)) {
    invalid("input.source.sha256", "must be a lowercase hexadecimal SHA-256");
  }
  if (bytes === 0 && record.sha256 !== EMPTY_SHA256) {
    invalid(
      "input.source.sha256",
      "must be the SHA-256 of the empty source when bytes is zero",
    );
  }
  return { bytes, lines, sha256: record.sha256 };
}

function compareKey(
  left: readonly string[],
  right: readonly string[],
): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return 0;
}

function validateGroup(
  value: unknown,
  index: number,
): { group: WrapperUsageGroup; key: readonly string[]; attempts: number } {
  const path = `input.groups[${index}]`;
  const record = requireRecord(value, path);
  requireExactKeys(record, path, GROUP_KEYS);

  const dimensionNames = [
    "wrapper",
    "accounting_lane",
    "requested_service",
    "transport",
    "model_tag",
  ] as const;
  for (const name of dimensionNames) {
    if (typeof record[name] !== "string") {
      invalid(`${path}.${name}`, "must be a string");
    }
  }
  const tuple = [
    record.wrapper,
    record.accounting_lane,
    record.requested_service,
    record.transport,
  ].join("\u0000");
  if (!DIMENSION_TUPLES.has(tuple)) {
    invalid(
      path,
      "must match one exact producer dimension tuple without attribution inference",
    );
  }
  if (!MODEL_TAGS.has(record.model_tag as string)) {
    invalid(`${path}.model_tag`, "must be one of allowlisted, custom, or default");
  }

  const success = requireInteger(record.success, `${path}.success`);
  const failure = requireInteger(record.failure, `${path}.failure`);
  const incomplete = requireInteger(record.incomplete, `${path}.incomplete`);
  const complete = checkedAdd(success, failure, path);
  const attempts = checkedAdd(complete, incomplete, path);

  const failureRecord = requireRecord(
    record.failure_class_counts,
    `${path}.failure_class_counts`,
  );
  requireExactKeys(
    failureRecord,
    `${path}.failure_class_counts`,
    FAILURE_CLASSES,
  );
  const failureClassCounts = Object.fromEntries(
    FAILURE_CLASSES.map((key) => [
      key,
      requireInteger(
        failureRecord[key],
        `${path}.failure_class_counts.${key}`,
      ),
    ]),
  ) as WrapperUsageFailureClassCounts;
  if (failureClassCounts.none !== success) {
    invalid(
      `${path}.failure_class_counts.none`,
      "must equal success",
    );
  }
  let classifiedFailures = 0;
  for (const key of FAILURE_CLASSES) {
    if (key === "none") continue;
    classifiedFailures = checkedAdd(
      classifiedFailures,
      failureClassCounts[key],
      `${path}.failure_class_counts`,
    );
  }
  if (classifiedFailures !== failure) {
    invalid(
      `${path}.failure_class_counts`,
      "non-none counts must sum to failure",
    );
  }

  const validateMetric = (
    totalName: "input_tokens_total" | "output_tokens_total" | "duration_ms_total",
    observationsName:
      | "input_tokens_observations"
      | "output_tokens_observations"
      | "duration_ms_observations",
  ): [number, number] => {
    const total = requireInteger(record[totalName], `${path}.${totalName}`);
    const observations = requireInteger(
      record[observationsName],
      `${path}.${observationsName}`,
    );
    if (observations > complete) {
      invalid(`${path}.${observationsName}`, "must not exceed complete attempts");
    }
    if (observations === 0 && total !== 0) {
      invalid(`${path}.${totalName}`, `must be zero when ${observationsName} is zero`);
    }
    return [total, observations];
  };
  const [inputTokensTotal, inputTokensObservations] = validateMetric(
    "input_tokens_total",
    "input_tokens_observations",
  );
  const [outputTokensTotal, outputTokensObservations] = validateMetric(
    "output_tokens_total",
    "output_tokens_observations",
  );
  const [durationMsTotal, durationMsObservations] = validateMetric(
    "duration_ms_total",
    "duration_ms_observations",
  );

  const group: WrapperUsageGroup = {
    accounting_lane: record.accounting_lane as WrapperUsageGroup["accounting_lane"],
    duration_ms_observations: durationMsObservations,
    duration_ms_total: durationMsTotal,
    failure,
    failure_class_counts: failureClassCounts,
    incomplete,
    input_tokens_observations: inputTokensObservations,
    input_tokens_total: inputTokensTotal,
    model_tag: record.model_tag as WrapperUsageGroup["model_tag"],
    output_tokens_observations: outputTokensObservations,
    output_tokens_total: outputTokensTotal,
    requested_service: record.requested_service as WrapperUsageGroup["requested_service"],
    success,
    transport: record.transport as WrapperUsageGroup["transport"],
    wrapper: record.wrapper as WrapperUsageGroup["wrapper"],
  };
  return {
    group,
    key: [
      group.wrapper,
      group.accounting_lane,
      group.requested_service,
      group.transport,
      group.model_tag,
    ],
    attempts,
  };
}

function validateGroups(
  value: unknown,
  sourceLines: number,
): { groups: WrapperUsageGroup[]; minimumSourceLines: number } {
  const values = requireJsonArray(value, "input.groups", MAX_GROUPS);
  const groups: WrapperUsageGroup[] = [];
  let precedingKey: readonly string[] | undefined;
  let attempts = 0;
  let minimumSourceLines = 0;
  for (let index = 0; index < values.length; index += 1) {
    const validated = validateGroup(values[index], index);
    if (precedingKey !== undefined) {
      const order = compareKey(precedingKey, validated.key);
      if (order === 0) {
        invalid(
          `input.groups[${index}]`,
          "duplicates the preceding five-field group key",
        );
      }
      if (order > 0) {
        invalid(
          `input.groups[${index}]`,
          "must be sorted by the exact five-field group key",
        );
      }
    }
    attempts = checkedAdd(attempts, validated.attempts, "input.groups");
    const complete = checkedAdd(
      validated.group.success,
      validated.group.failure,
      `input.groups[${index}]`,
    );
    const completeEventLines = checkedAdd(
      complete,
      complete,
      `input.groups[${index}]`,
    );
    const groupMinimumLines = checkedAdd(
      completeEventLines,
      validated.group.incomplete,
      `input.groups[${index}]`,
    );
    minimumSourceLines = checkedAdd(
      minimumSourceLines,
      groupMinimumLines,
      "input.groups",
    );
    precedingKey = validated.key;
    groups.push(validated.group);
  }
  if (attempts > sourceLines) {
    invalid("input.groups", "cannot contain more attempts than source lines");
  }
  return { groups, minimumSourceLines };
}

/**
 * Validate and copy one already-decoded wrapper usage summary into a
 * non-authoritative MeshFleet status observation.
 *
 * Throws before returning any result when the closed v1 object is malformed,
 * drifted, contradictory, unsorted, duplicated, or over-bound.
 */
export function compileWrapperUsageStatus(
  input: unknown,
): WrapperUsageStatusResult {
  const record = requireRecord(input, "input");
  requireExactKeys(
    record,
    "input",
    ["effect_flags", "groups", "rejections", "schema_version", "source", "window"],
  );
  if (record.schema_version !== WRAPPER_USAGE_SUMMARY_VERSION) {
    invalid(
      "input.schema_version",
      `must equal ${WRAPPER_USAGE_SUMMARY_VERSION}`,
    );
  }
  const window = validateWindow(record.window);
  const source = validateSource(record.source);
  const producerEffectFlags = validateProducerEffects(record.effect_flags);
  const rejections = validateRejections(record.rejections);
  const validatedGroups = validateGroups(record.groups, source.lines);

  let rejectionTotal = 0;
  for (const key of REJECTION_KEYS) {
    rejectionTotal = checkedAdd(
      rejectionTotal,
      rejections[key],
      "input.rejections",
    );
  }
  const minimumAccountedLines = checkedAdd(
    validatedGroups.minimumSourceLines,
    rejectionTotal,
    "input",
  );
  if (minimumAccountedLines > source.lines) {
    invalid(
      "input",
      "group events and rejection counts cannot exceed source lines",
    );
  }

  return {
    schema_version: WRAPPER_USAGE_STATUS_VERSION,
    accepted: true,
    effects: {
      persisted: false,
      executed: false,
      authorized: false,
      woke_agents: false,
      contacted_providers: false,
    },
    authority: {
      executes: false,
      schedules: false,
      changes_routing: false,
      persists: false,
      activates_logging: false,
      infers_provider_identity: false,
      infers_quota_or_balance: false,
      derives_meshfleet_health: false,
    },
    source: {
      summary_schema_version: WRAPPER_USAGE_SUMMARY_VERSION,
      window,
      ...source,
      producer_effect_flags: producerEffectFlags,
    },
    rejections,
    groups: validatedGroups.groups,
  };
}
