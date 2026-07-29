import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileWrapperUsageStatus,
  WRAPPER_USAGE_STATUS_VERSION,
  WRAPPER_USAGE_SUMMARY_VERSION,
} from "../src/wrapper-usage-observations.js";

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

const producerEffects = {
  logging_activated: false,
  meshfleet_projected: false,
  provider_calls_made: false,
  provider_identity_inferred: false,
  quota_or_balance_inferred: false,
  routing_or_scheduling_changed: false,
  source_modified: false,
  unused_quota_rewarded: false,
} as const;

const meshfleetEffects = {
  persisted: false,
  executed: false,
  authorized: false,
  woke_agents: false,
  contacted_providers: false,
} as const;

const authority = {
  executes: false,
  schedules: false,
  changes_routing: false,
  persists: false,
  activates_logging: false,
  infers_provider_identity: false,
  infers_quota_or_balance: false,
  derives_meshfleet_health: false,
} as const;

function zeroCounts(keys: readonly string[]): Record<string, number> {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function group(overrides: Record<string, unknown> = {}) {
  return {
    accounting_lane: "minimax-text",
    duration_ms_observations: 1,
    duration_ms_total: 40,
    failure: 0,
    failure_class_counts: {
      ...zeroCounts(FAILURE_CLASSES),
      none: 1,
    },
    incomplete: 0,
    input_tokens_observations: 1,
    input_tokens_total: 10,
    model_tag: "default",
    output_tokens_observations: 1,
    output_tokens_total: 20,
    requested_service: "minimax-text",
    success: 1,
    transport: "direct",
    wrapper: "mmx",
    ...overrides,
  };
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    effect_flags: producerEffects,
    groups: [group()],
    rejections: zeroCounts(REJECTION_KEYS),
    schema_version: WRAPPER_USAGE_SUMMARY_VERSION,
    source: {
      bytes: 512,
      lines: 2,
      sha256: "a".repeat(64),
    },
    window: {
      end_ms: 200,
      start_ms: 100,
    },
    ...overrides,
  };
}

function expects(path: string, detail: string): RegExp {
  return new RegExp(
    `wrapper_usage_observations: '${path.replace(/[.[\]\\]/g, "\\$&")}' ${detail}`,
  );
}

test("exports a package-only status adapter with a distinct non-routing envelope", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { exports: Record<string, string> };

  assert.equal(
    packageJson.exports["./wrapper-usage-observations"],
    "./dist/wrapper-usage-observations.js",
  );
  assert.equal(WRAPPER_USAGE_SUMMARY_VERSION, "fleet.wrapper-usage-summary/v1");
  assert.equal(WRAPPER_USAGE_STATUS_VERSION, "meshfleet.wrapper-usage-status/v1");

  const result = compileWrapperUsageStatus(summary());
  assert.equal(result.schema_version, WRAPPER_USAGE_STATUS_VERSION);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.effects, meshfleetEffects);
  assert.deepEqual(result.authority, authority);
  assert.deepEqual(Object.keys(result).sort(), [
    "accepted",
    "authority",
    "effects",
    "groups",
    "rejections",
    "schema_version",
    "source",
  ]);
  for (const forbidden of [
    "projection",
    "observations",
    "status",
    "candidate_id",
    "budget",
    "health",
  ]) {
    assert.equal(forbidden in result, false);
  }
});

test("copies exact sanitized evidence without deriving provider, quota, health, rates, or averages", () => {
  const routed = group({
    accounting_lane: "routeplane-unattributed",
    duration_ms_observations: 0,
    duration_ms_total: 0,
    failure_class_counts: zeroCounts(FAILURE_CLASSES),
    input_tokens_observations: 0,
    input_tokens_total: 0,
    model_tag: "custom",
    output_tokens_observations: 0,
    output_tokens_total: 0,
    requested_service: "routeplane",
    success: 0,
    transport: "routeplane",
  });
  const input = summary({
    effect_flags: { ...producerEffects },
    groups: [routed],
    rejections: { ...zeroCounts(REJECTION_KEYS), invalid_json: 3 },
    source: {
      bytes: 512,
      lines: 10,
      sha256: "a".repeat(64),
    },
  });

  const result = compileWrapperUsageStatus(input);

  assert.deepEqual(result.source, {
    summary_schema_version: WRAPPER_USAGE_SUMMARY_VERSION,
    window: input.window,
    bytes: 512,
    lines: 10,
    sha256: "a".repeat(64),
    producer_effect_flags: producerEffects,
  });
  assert.deepEqual(result.rejections, input.rejections);
  assert.deepEqual(result.groups, [routed]);
  assert.equal(result.groups[0]?.accounting_lane, "routeplane-unattributed");
  const encoded = JSON.stringify(result);
  for (const forbidden of [
    "remaining_quota",
    "remaining_balance",
    "prompt",
    "attempt_id",
    "invocation_id",
  ]) {
    assert.equal(encoded.includes(forbidden), false);
  }
  assert.equal(encoded.includes("infers_provider_identity"), true);
  assert.equal(Object.keys(result.groups[0]!).some((key) =>
    ["provider", "quota", "balance", "average", "rate", "health"].includes(key)
  ), false);
});

test("rejects schema drift at every closed object boundary before copying groups", () => {
  const cases: Array<[unknown, string]> = [
    [{ ...summary(), prompt: "PROMPT_CANARY" }, "input.<unknown-member>"],
    [{ ...summary(), schema_version: "fleet.wrapper-usage-summary/v2" }, "input.schema_version"],
    [{ ...summary(), window: { ...summary().window, extra: true } }, "input.window.<unknown-member>"],
    [{ ...summary(), source: { ...summary().source, path: "/secret" } }, "input.source.<unknown-member>"],
    [{
      ...summary(),
      effect_flags: { ...producerEffects, provider_name: false },
    }, "input.effect_flags.<unknown-member>"],
    [{
      ...summary(),
      rejections: { ...zeroCounts(REJECTION_KEYS), other: 0 },
    }, "input.rejections.<unknown-member>"],
    [{
      ...summary(),
      groups: [{ ...group(), attempt_id: "raw-id" }],
    }, "input.groups[0].<unknown-member>"],
    [{
      ...summary(),
      groups: [{
        ...group(),
        failure_class_counts: {
          ...zeroCounts(FAILURE_CLASSES),
          provider_failure: 0,
        },
      }],
    }, "input.groups[0].failure_class_counts.<unknown-member>"],
  ];

  for (const [input, path] of cases) {
    assert.throws(
      () => compileWrapperUsageStatus(input),
      expects(path, path.endsWith("schema_version")
        ? `must equal ${WRAPPER_USAGE_SUMMARY_VERSION}`
        : "is not allowed"),
    );
  }
});

test("rejects prototype-backed, accessor, symbol, and non-enumerable members without leaking names", () => {
  const inheritedRoot = Object.create(summary()) as Record<string, unknown>;
  assert.throws(
    () => compileWrapperUsageStatus(inheritedRoot),
    expects("input", "must be a plain or null-prototype JSON object"),
  );

  const inheritedWindow = Object.create(summary().window) as Record<string, unknown>;
  assert.throws(
    () => compileWrapperUsageStatus(summary({ window: inheritedWindow })),
    expects("input.window", "must be a plain or null-prototype JSON object"),
  );

  const accessorCanary = "PROMPT_ACCESSOR_CANARY";
  const accessorRoot = summary() as Record<string, unknown>;
  Object.defineProperty(accessorRoot, accessorCanary, {
    enumerable: true,
    get: () => "must-not-run",
  });
  let accessorError = "";
  try {
    compileWrapperUsageStatus(accessorRoot);
    assert.fail("accessor input must fail closed");
  } catch (error) {
    accessorError = String(error);
  }
  assert.match(accessorError, /input\.<non-json-member>/);
  assert.doesNotMatch(accessorError, new RegExp(accessorCanary));

  const hiddenCanary = "RAW_EVENT_ID_CANARY";
  const hiddenRoot = summary() as Record<string, unknown>;
  Object.defineProperty(hiddenRoot, hiddenCanary, {
    enumerable: false,
    value: "must-not-copy",
  });
  const symbolRoot = summary() as Record<string | symbol, unknown>;
  const symbolCanary = Symbol("PROMPT_SYMBOL_CANARY");
  symbolRoot[symbolCanary] = "must-not-copy";
  for (const candidate of [hiddenRoot, symbolRoot]) {
    assert.throws(
      () => compileWrapperUsageStatus(candidate),
      expects("input.<non-json-member>", "is not allowed"),
    );
  }

  const decoratedGroups = [group()] as Array<unknown> & Record<string, unknown>;
  decoratedGroups[hiddenCanary] = "must-not-copy";
  const sparseGroups = new Array(1);
  for (const groups of [decoratedGroups, sparseGroups]) {
    assert.throws(
      () => compileWrapperUsageStatus(summary({ groups })),
      expects("input.groups.<non-json-member>", "is not allowed"),
    );
  }

  const unknownCanary = "PROMPT_UNKNOWN_KEY_CANARY";
  let unknownError = "";
  try {
    compileWrapperUsageStatus({ ...summary(), [unknownCanary]: true });
    assert.fail("unknown member must fail closed");
  } catch (error) {
    unknownError = String(error);
  }
  assert.match(unknownError, /input\.<unknown-member>/);
  assert.doesNotMatch(unknownError, new RegExp(unknownCanary));
});

test("rejects malformed windows, source provenance, flags, and counters", () => {
  for (const window of [
    { start_ms: -1, end_ms: 200 },
    { start_ms: 200, end_ms: 200 },
    { start_ms: 100.5, end_ms: 200 },
    { start_ms: 100, end_ms: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => compileWrapperUsageStatus(summary({ window })));
  }
  for (const source of [
    { bytes: 33_554_433, lines: 1, sha256: "a".repeat(64) },
    { bytes: 1, lines: 0, sha256: "a".repeat(64) },
    { bytes: 1, lines: 2, sha256: "a".repeat(64) },
    { bytes: 1, lines: 1, sha256: "A".repeat(64) },
    { bytes: 0, lines: 0, sha256: "0".repeat(64) },
  ]) {
    assert.throws(() => compileWrapperUsageStatus(summary({ source })));
  }
  assert.throws(
    () => compileWrapperUsageStatus(summary({
      effect_flags: { ...producerEffects, logging_activated: true },
    })),
    expects("input.effect_flags.logging_activated", "must be false"),
  );
  assert.throws(
    () => compileWrapperUsageStatus(summary({
      rejections: { ...zeroCounts(REJECTION_KEYS), invalid_json: 100_001 },
    })),
    expects("input.rejections.invalid_json", "must be an integer between 0 and 100000"),
  );
  assert.throws(
    () => compileWrapperUsageStatus(summary({
      rejections: { ...zeroCounts(REJECTION_KEYS), invalid_json: 1 },
    })),
    expects(
      "input",
      "group events and rejection counts cannot exceed source lines",
    ),
  );
});

test("rejects over-bound, duplicate, and non-canonical group order without truncating", () => {
  const direct = group();
  const routed = group({
    accounting_lane: "routeplane-unattributed",
    requested_service: "routeplane",
    transport: "routeplane",
  });

  assert.throws(
    () => compileWrapperUsageStatus(summary({ groups: [routed, direct] })),
    expects("input.groups[1]", "must be sorted by the exact five-field group key"),
  );
  assert.throws(
    () => compileWrapperUsageStatus(summary({ groups: [direct, direct] })),
    expects("input.groups[1]", "duplicates the preceding five-field group key"),
  );
  assert.throws(
    () => compileWrapperUsageStatus(summary({
      groups: Array.from({ length: 65 }, () => direct),
    })),
    expects("input.groups", "must be an array with 0..64 items"),
  );
});

test("rejects unknown wrapper dimensions and model tags instead of inferring attribution", () => {
  for (const mutation of [
    { wrapper: "provider-guess" },
    { accounting_lane: "grok-chat" },
    { requested_service: "secret-provider" },
    { transport: "subscription" },
    { model_tag: "raw-model-name" },
    { accounting_lane: "routeplane-attributed" },
  ]) {
    assert.throws(
      () => compileWrapperUsageStatus(summary({ groups: [group(mutation)] })),
      /must match one exact producer dimension tuple|must be one of/,
    );
  }
});

test("rejects contradictory outcomes, failure classes, and metric observations", () => {
  const badGroups = [
    group({
      failure: 1,
      failure_class_counts: {
        ...zeroCounts(FAILURE_CLASSES),
        none: 1,
      },
    }),
    group({
      success: 1,
      failure_class_counts: {
        ...zeroCounts(FAILURE_CLASSES),
        none: 0,
      },
    }),
    group({
      input_tokens_observations: 2,
    }),
    group({
      duration_ms_observations: 0,
      duration_ms_total: 1,
    }),
    group({
      success: Number.MAX_SAFE_INTEGER,
      failure_class_counts: {
        ...zeroCounts(FAILURE_CLASSES),
        none: Number.MAX_SAFE_INTEGER,
      },
    }),
  ];

  for (const badGroup of badGroups) {
    assert.throws(
      () => compileWrapperUsageStatus(summary({ groups: [badGroup] })),
    );
  }
});

test("accepts empty and full bounded summaries deterministically without a clock", () => {
  const empty = summary({
    groups: [],
    source: {
      bytes: 0,
      lines: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
  });
  const first = compileWrapperUsageStatus(empty);
  const second = compileWrapperUsageStatus(empty);
  assert.deepEqual(first, second);
  assert.deepEqual(first.groups, []);

  const wrappers = [
    ["grk", "grok-build", "grok-build", "subscription"],
    ["grk", "grok-chat", "grok-chat", "subscription"],
    ["klo", "kilo", "kilo", "direct"],
    ["klo", "routeplane-unattributed", "routeplane", "routeplane"],
    ["mmx", "minimax-text", "minimax-text", "direct"],
    ["mmx", "routeplane-unattributed", "routeplane", "routeplane"],
    ["ocg", "opencode-go", "opencode-go", "direct"],
    ["ocg", "routeplane-unattributed", "routeplane", "routeplane"],
    ["olc", "ollama-cloud", "ollama-cloud", "direct"],
    ["olc", "routeplane-unattributed", "routeplane", "routeplane"],
  ] as const;
  const groups = wrappers.flatMap(
    ([wrapper, accounting_lane, requested_service, transport]) =>
      (["allowlisted", "custom", "default"] as const).map((model_tag) =>
        group({
          wrapper,
          accounting_lane,
          requested_service,
          transport,
          model_tag,
        })),
  );
  const result = compileWrapperUsageStatus(summary({
    groups,
    source: { bytes: 100_000, lines: 100_000, sha256: "f".repeat(64) },
  }));
  assert.equal(result.groups.length, 30);
});

test("keeps the adapter isolated from routing, health, storage, MCP, and fleetbudget modules", () => {
  const source = readFileSync(
    new URL("../src/wrapper-usage-observations.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /from\s+["'][^"']*(?:compile-route|recommend-route|health|db|core|fleetbudget|drain)/,
  );
  assert.doesNotMatch(source, /\b(?:Date\.now|console\.|process\.|fetch\s*\()/);

  const indexSource = readFileSync(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(indexSource, /wrapper[_-]usage/i);
});
