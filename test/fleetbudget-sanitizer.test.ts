import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  FleetBudgetSanitizerError,
  sanitizeFleetBudgetReport,
  type FleetBudgetSanitizerErrorCode,
  type SanitizeFleetBudgetReportInput,
} from "../src/fleetbudget-sanitizer.js";
import { FLEETBUDGET_SNAPSHOT_VERSION } from "../src/fleetbudget-observations.js";

const COLLECTION_START = Date.parse("2026-07-29T12:00:00.000Z");
const COLLECTION_FINISH = COLLECTION_START + 2_000;
const NOW = COLLECTION_FINISH + 1_000;
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

function lane(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lane: "grok-build",
    measured: true,
    used: 1,
    total: 2,
    unit: "requests",
    utilization: 50,
    state: "OK",
    note: "bounded diagnostic prose",
    detail: "",
    ...overrides,
  };
}

function routes(): Record<string, string | null> {
  return Object.fromEntries(
    ROUTE_KEYS.map((key) => [key, key === "bulk" ? "grok-build" : null]),
  );
}

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generated: "2026-07-29T12:00:01.000000+00:00",
    lanes: [lane()],
    routes: routes(),
    ...overrides,
  };
}

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function input(
  reportBytes = bytes(report()),
  overrides: Partial<SanitizeFleetBudgetReportInput> = {},
): SanitizeFleetBudgetReportInput {
  return {
    report_bytes: reportBytes,
    collection_started_at_ms: COLLECTION_START,
    collection_finished_at_ms: COLLECTION_FINISH,
    now_ms: NOW,
    ...overrides,
  };
}

function captureError(
  invoke: () => unknown,
  code: FleetBudgetSanitizerErrorCode,
  path?: string,
): FleetBudgetSanitizerError {
  let caught: unknown;
  try {
    invoke();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof FleetBudgetSanitizerError);
  assert.equal(caught.code, code);
  assert.equal(caught.path, path);
  return caught;
}

test("exports the package subpath and maps the exact current report to sorted windowless lanes", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { exports: Record<string, string> };
  assert.equal(
    packageJson.exports["./fleetbudget-sanitizer"],
    "./dist/fleetbudget-sanitizer.js",
  );

  const raw = bytes(report({
    lanes: [
      lane({ lane: "zeta", used: 3, total: null, unit: "tokens", utilization: null }),
      lane({ lane: "alpha", measured: false, used: null, total: null, unit: "", utilization: null, state: "UNMEASURED" }),
    ],
  }));
  const before = raw.slice();

  assert.deepEqual(sanitizeFleetBudgetReport(input(raw)), {
    version: FLEETBUDGET_SNAPSHOT_VERSION,
    observed_at_ms: COLLECTION_START,
    expires_at_ms: COLLECTION_START + 300_000,
    lanes: [
      {
        lane_id: "alpha",
        measured: false,
        used: null,
        total: null,
        unit: null,
      },
      {
        lane_id: "zeta",
        measured: true,
        used: 3,
        total: null,
        unit: "tokens",
      },
    ],
  });
  assert.deepEqual(raw, before);
});

test("is deterministic across root, lane-member, route, and lane-order permutations", () => {
  const first = report({
    lanes: [
      lane({ lane: "zeta", note: "discarded one" }),
      lane({ lane: "alpha", used: 2, total: 4, utilization: 50, detail: "discarded two" }),
    ],
  });
  const second = {
    routes: Object.fromEntries(Object.entries(routes()).reverse()),
    lanes: [
      {
        detail: "discarded two",
        note: "discarded one",
        state: "WARN",
        utilization: 50,
        unit: "requests",
        total: 2,
        used: 1,
        measured: true,
        lane: "zeta",
      },
      {
        detail: "discarded one",
        note: "discarded two",
        state: "LOW",
        utilization: 50,
        unit: "requests",
        total: 4,
        used: 2,
        measured: true,
        lane: "alpha",
      },
    ],
    generated: "2026-07-29T12:00:01.000000+00:00",
  };
  assert.deepEqual(
    sanitizeFleetBudgetReport(input(bytes(first))),
    sanitizeFleetBudgetReport(input(bytes(second))),
  );

  const ordinal = sanitizeFleetBudgetReport(input(bytes(report({
    lanes: [lane({ lane: "a" }), lane({ lane: "Z" })],
  }))));
  assert.deepEqual(ordinal.lanes.map(({ lane_id }) => lane_id), ["Z", "a"]);
});

test("enforces the raw byte type and exact 1 MiB boundary before decoding", () => {
  captureError(
    () => sanitizeFleetBudgetReport(input(new Uint8Array(1_048_577))),
    "input_too_large",
    "input.report_bytes",
  );
  captureError(
    () => sanitizeFleetBudgetReport(input("not bytes" as never)),
    "invalid_input",
    "input.report_bytes",
  );

  const compact = JSON.stringify(report());
  const exact = new TextEncoder().encode(compact + " ".repeat(1_048_576 - compact.length));
  assert.equal(exact.byteLength, 1_048_576);
  assert.equal(sanitizeFleetBudgetReport(input(exact)).lanes.length, 1);
});

test("closes the API object with own fixed keys before reading report bytes", () => {
  captureError(
    () => sanitizeFleetBudgetReport({ ...input(), attacker_secret: true } as never),
    "invalid_input",
    "input.<unknown-member>",
  );
  const { now_ms: _now, ...missingNow } = input();
  captureError(
    () => sanitizeFleetBudgetReport(missingNow as never),
    "invalid_input",
    "input.now_ms",
  );
  captureError(
    () => sanitizeFleetBudgetReport({ ...input(), ttl_ms: undefined } as never),
    "invalid_input",
    "input.ttl_ms",
  );

  const inheritedNow = Object.assign(Object.create({ now_ms: NOW }) as object, {
    report_bytes: bytes(report()),
    collection_started_at_ms: COLLECTION_START,
    collection_finished_at_ms: COLLECTION_FINISH,
  });
  captureError(
    () => sanitizeFleetBudgetReport(inheritedNow as never),
    "invalid_input",
    "input.now_ms",
  );
});

test("rejects fatal UTF-8 and a UTF-8 BOM with one fixed value-free error", () => {
  for (const raw of [
    Uint8Array.from([0xc3, 0x28]),
    Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
  ]) {
    const error = captureError(
      () => sanitizeFleetBudgetReport(input(raw)),
      "invalid_utf8",
      "input.report_bytes",
    );
    assert.equal(error.message, "fleetbudget sanitizer rejected invalid_utf8 at input.report_bytes");
  }
});

test("rejects decoded-equivalent duplicate members without exposing the member", () => {
  const secret = "secret-route-command";
  const raw = new TextEncoder().encode(
    `{"generated":"2026-07-29T12:00:01.000000+00:00","g\\u0065nerated":"${secret}","lanes":[],"routes":{}}`,
  );
  const error = captureError(
    () => sanitizeFleetBudgetReport(input(raw)),
    "invalid_json",
  );
  assert.equal(error.message, "fleetbudget sanitizer rejected invalid_json");
  assert.doesNotMatch(error.message, /generated|secret|route|command/i);
});

test("rejects malformed JSON, depth above 64, and unpaired decoded surrogates", () => {
  const excessive = `{"x":${"[".repeat(64)}null${"]".repeat(64)}}`;
  for (const raw of [
    "{\"generated\":",
    excessive,
    "{\"x\":\"\\ud800\"}",
    "{\"\\udc00\":null}",
  ]) {
    captureError(
      () => sanitizeFleetBudgetReport(input(new TextEncoder().encode(raw))),
      "invalid_json",
    );
  }

  const boundary = `{"x":${"[".repeat(63)}null${"]".repeat(63)}}`;
  captureError(
    () => sanitizeFleetBudgetReport(input(new TextEncoder().encode(boundary))),
    "report_schema_drift",
    "report.<unknown-member>",
  );
});

test("uses the A2A exact numeric lexeme law before schema validation", () => {
  for (const token of [
    "0.5",
    "5e-1",
    "0.1",
    "0.10",
    "-0",
    "0",
    "1.0",
    "1e0",
    "9007199254740991",
    "9.007199254740991e15",
  ]) {
    captureError(
      () => sanitizeFleetBudgetReport(
        input(new TextEncoder().encode(`{"probe":${token}}`)),
      ),
      "report_schema_drift",
      "report.<unknown-member>",
    );
  }
  for (const token of [
    "1e309",
    "9007199254740992",
    "-9007199254740992",
    "9007199254740993",
    "9007199254740992.0",
    "9007199254740992e0",
    "9.007199254740992e15",
    "9007199254740991.1",
    "9007199254740990.9",
    "0.99999999999999999",
  ]) {
    captureError(
      () => sanitizeFleetBudgetReport(
        input(new TextEncoder().encode(`{"probe":${token}}`)),
      ),
      "invalid_json",
    );
  }
});

test("closes the report root before known missing members with fixed paths", () => {
  captureError(
    () => sanitizeFleetBudgetReport(input(bytes([]))),
    "invalid_report",
    "report",
  );
  captureError(
    () => sanitizeFleetBudgetReport(input(bytes({ ...report(), attacker: "secret" }))),
    "report_schema_drift",
    "report.<unknown-member>",
  );
  const { generated: _generated, ...missing } = report();
  captureError(
    () => sanitizeFleetBudgetReport(input(bytes(missing))),
    "report_schema_drift",
    "report.generated",
  );
});

test("closes each lane schema and keeps attacker-controlled names out of paths", () => {
  captureError(
    () => sanitizeFleetBudgetReport(input(bytes(report({ lanes: [{ ...lane(), attacker_secret: true }] })))),
    "report_schema_drift",
    "report.lanes[0].<unknown-member>",
  );
  const { measured: _measured, ...missingMeasured } = lane();
  captureError(
    () => sanitizeFleetBudgetReport(input(bytes(report({ lanes: [missingMeasured] })))),
    "report_schema_drift",
    "report.lanes[0].measured",
  );
  captureError(
    () => sanitizeFleetBudgetReport(input(bytes(report({ lanes: [null] })))),
    "invalid_report",
    "report.lanes[0]",
  );
});

test("pins scalar, metric, identifier, duplicate, and unit validation paths", () => {
  const emoji = "😀";
  const invalidLanes: Array<[Record<string, unknown>, string]> = [
    [lane({ lane: " " }), "report.lanes[0].lane"],
    [lane({ lane: emoji.repeat(65) }), "report.lanes[0].lane"],
    [lane({ measured: 1 }), "report.lanes[0].measured"],
    [lane({ used: -1 }), "report.lanes[0].used"],
    [lane({ total: 0 }), "report.lanes[0].total"],
    [lane({ unit: "Token Count" }), "report.lanes[0].unit"],
    [lane({ utilization: -1 }), "report.lanes[0].utilization"],
    [lane({ state: "GREEN" }), "report.lanes[0].state"],
    [lane({ note: "x".repeat(4_097) }), "report.lanes[0].note"],
    [lane({ detail: 1 }), "report.lanes[0].detail"],
  ];
  for (const [rawLane, path] of invalidLanes) {
    captureError(
      () => sanitizeFleetBudgetReport(input(bytes(report({ lanes: [rawLane] })))),
      "invalid_report",
      path,
    );
  }
  assert.equal(
    sanitizeFleetBudgetReport(input(bytes(report({
      lanes: [lane({ lane: emoji.repeat(64) })],
    })))).lanes[0]?.lane_id,
    emoji.repeat(64),
  );
  captureError(
    () => sanitizeFleetBudgetReport(input(bytes(report({
      lanes: [lane(), lane({ detail: "must never leak" })],
    })))),
    "invalid_report",
    "report.lanes[1].lane",
  );
});

test("pins the exact current ten route keys and dynamic value paths", () => {
  const emoji = "😀";
  for (const value of ["", "   "]) {
    assert.doesNotThrow(() => sanitizeFleetBudgetReport(input(bytes(report({
      routes: { ...routes(), bulk: value },
    })))));
  }
  const missing = routes();
  delete missing.verdict;
  captureError(
    () => sanitizeFleetBudgetReport(input(bytes(report({ routes: missing })))),
    "report_schema_drift",
    "report.routes[*].key",
  );
  captureError(
    () => sanitizeFleetBudgetReport(input(bytes(report({
      routes: { ...routes(), attacker_command: "do not leak" },
    })))),
    "report_schema_drift",
    "report.routes[*].key",
  );
  captureError(
    () => sanitizeFleetBudgetReport(input(bytes(report({
      routes: Object.fromEntries(
        Array.from({ length: 257 }, (_, index) => [`extra-${index}`, null]),
      ),
    })))),
    "report_schema_drift",
    "report.routes[*].key",
  );
  captureError(
    () => sanitizeFleetBudgetReport(input(bytes(report({
      routes: { ...routes(), bulk: 3 },
    })))),
    "invalid_report",
    "report.routes[*].value",
  );
  assert.doesNotThrow(() => sanitizeFleetBudgetReport(input(bytes(report({
    routes: { ...routes(), bulk: emoji.repeat(64) },
  })))));
  captureError(
    () => sanitizeFleetBudgetReport(input(bytes(report({
      routes: { ...routes(), bulk: emoji.repeat(65) },
    })))),
    "invalid_report",
    "report.routes[*].value",
  );
});

test("validates caller timing, duration, TTL, safe expiry, and half-open freshness", () => {
  assert.equal(
    sanitizeFleetBudgetReport(input()).expires_at_ms,
    COLLECTION_START + 300_000,
  );
  assert.equal(
    sanitizeFleetBudgetReport(input(bytes(report()), { ttl_ms: 60_000 })).expires_at_ms,
    COLLECTION_START + 60_000,
  );
  assert.equal(
    sanitizeFleetBudgetReport(input(bytes(report()), { ttl_ms: 600_000 })).expires_at_ms,
    COLLECTION_START + 600_000,
  );

  for (const [overrides, path] of [
    [{ collection_started_at_ms: -1 }, "input.collection_started_at_ms"],
    [{ collection_started_at_ms: 1.5 }, "input.collection_started_at_ms"],
    [{ collection_finished_at_ms: Number.MAX_SAFE_INTEGER + 1 }, "input.collection_finished_at_ms"],
    [{ now_ms: Number.NaN }, "input.now_ms"],
    [{ ttl_ms: null }, "input.ttl_ms"],
    [{ ttl_ms: -1 }, "input.ttl_ms"],
    [{ ttl_ms: 1.5 }, "input.ttl_ms"],
    [{ ttl_ms: 0 }, "input.ttl_ms"],
    [{ ttl_ms: 600_001 }, "input.ttl_ms"],
  ] as const) {
    captureError(
      () => sanitizeFleetBudgetReport(input(bytes(report()), overrides)),
      "invalid_input",
      path,
    );
  }

  captureError(
    () => sanitizeFleetBudgetReport(input(bytes(report()), {
      collection_started_at_ms: COLLECTION_FINISH + 1,
    })),
    "invalid_input",
    "input.collection_finished_at_ms",
  );
  captureError(
    () => sanitizeFleetBudgetReport(input(bytes(report()), {
      now_ms: COLLECTION_FINISH - 1,
    })),
    "invalid_input",
    "input.now_ms",
  );
  assert.doesNotThrow(() => sanitizeFleetBudgetReport(input(bytes(report()), {
    collection_finished_at_ms: COLLECTION_START + 180_000,
    now_ms: COLLECTION_START + 180_000,
  })));
  captureError(
    () => sanitizeFleetBudgetReport(input(bytes(report()), {
      collection_finished_at_ms: COLLECTION_START + 180_001,
      now_ms: COLLECTION_START + 180_001,
    })),
    "invalid_input",
    "input.collection_finished_at_ms",
  );
  captureError(
    () => sanitizeFleetBudgetReport(input(bytes(report()), {
      collection_started_at_ms: Number.MAX_SAFE_INTEGER - 10,
      collection_finished_at_ms: Number.MAX_SAFE_INTEGER - 10,
      now_ms: Number.MAX_SAFE_INTEGER - 10,
      ttl_ms: 11,
    })),
    "invalid_input",
    "input.ttl_ms",
  );

  assert.doesNotThrow(() => sanitizeFleetBudgetReport(input(bytes(report()), {
    ttl_ms: 3_001,
    now_ms: COLLECTION_START + 3_000,
  })));
  captureError(
    () => sanitizeFleetBudgetReport(input(bytes(report()), {
      ttl_ms: 3_000,
      now_ms: COLLECTION_START + 3_000,
    })),
    "stale_report",
  );
});

test("accepts only the producer UTC generated grammar with millisecond truncation and closed bounds", () => {
  const second = Date.parse("2026-07-29T12:00:01.000Z");
  for (const generated of [
    "2026-07-29T12:00:01+00:00",
    "2026-07-29T12:00:01.000000+00:00",
  ]) {
    assert.doesNotThrow(() => sanitizeFleetBudgetReport(input(bytes(report({ generated })), {
      collection_started_at_ms: second,
      collection_finished_at_ms: second,
      now_ms: second,
    })));
  }

  const truncated = Date.parse("2026-07-29T12:00:01.999Z");
  assert.doesNotThrow(() => sanitizeFleetBudgetReport(input(
    bytes(report({ generated: "2026-07-29T12:00:01.999999+00:00" })),
    {
      collection_started_at_ms: truncated,
      collection_finished_at_ms: truncated,
      now_ms: truncated,
    },
  )));

  for (const generated of [
    "2026-07-29T12:00:01.1+00:00",
    "2026-07-29T12:00:01.12+00:00",
    "2026-07-29T12:00:01.123+00:00",
    "2026-07-29T12:00:01.1234+00:00",
    "2026-07-29T12:00:01.12345+00:00",
    "2026-07-29T12:00:01.1234567+00:00",
    "2026-07-29T12:00:01Z",
    "2026-07-29T12:00:01-00:00",
    "2026-07-29T12:00:01+01:00",
    "2026-07-29 12:00:01+00:00",
    "2026-07-29T12:00:60+00:00",
    "0000-01-01T00:00:00+00:00",
    "1969-12-31T23:59:59+00:00",
    "2026-02-29T12:00:01+00:00",
    "2026-13-01T12:00:01+00:00",
  ]) {
    captureError(
      () => sanitizeFleetBudgetReport(input(bytes(report({ generated })))),
      "invalid_report",
      "report.generated",
    );
  }
  assert.doesNotThrow(() => sanitizeFleetBudgetReport(input(bytes(report({
    generated: "2024-02-29T12:00:01+00:00",
  })), {
    collection_started_at_ms: Date.parse("2024-02-29T12:00:00Z"),
    collection_finished_at_ms: Date.parse("2024-02-29T12:00:02Z"),
    now_ms: Date.parse("2024-02-29T12:00:02Z"),
  })));
});

test("classifies generated timestamps outside the closed collection interval", () => {
  captureError(
    () => sanitizeFleetBudgetReport(input(bytes(report({
      generated: "2026-07-29T11:59:59.999999+00:00",
    })))),
    "stale_report",
  );
  captureError(
    () => sanitizeFleetBudgetReport(input(bytes(report({
      generated: "2026-07-29T12:00:02.001000+00:00",
    })))),
    "future_report",
  );
  assert.doesNotThrow(() => sanitizeFleetBudgetReport(input(bytes(report({
    generated: "2026-07-29T12:00:00.000000+00:00",
  })))));
  assert.doesNotThrow(() => sanitizeFleetBudgetReport(input(bytes(report({
    generated: "2026-07-29T12:00:02.000000+00:00",
  })))));
});

test("maps measured, unmeasured, ceiling-less, unavailable, exhausted, and overage lanes exactly", () => {
  const fixtures: Array<{
    name: string;
    raw: Record<string, unknown>;
    expected: Record<string, unknown>;
  }> = [
    {
      name: "complete",
      raw: lane(),
      expected: { measured: true, used: 1, total: 2, unit: "requests" },
    },
    {
      name: "ceiling-less",
      raw: lane({ total: null, utilization: null }),
      expected: { measured: true, used: 1, total: null, unit: "requests" },
    },
    {
      name: "used unavailable",
      raw: lane({ used: null, utilization: null }),
      expected: { measured: true, used: null, total: 2, unit: "requests" },
    },
    {
      name: "all unavailable",
      raw: lane({ used: null, total: null, unit: "", utilization: null }),
      expected: { measured: true, used: null, total: null, unit: null },
    },
    {
      name: "unmeasured",
      raw: lane({
        measured: false,
        used: null,
        total: null,
        unit: "",
        utilization: null,
        state: "UNMEASURED",
      }),
      expected: { measured: false, used: null, total: null, unit: null },
    },
    {
      name: "exhausted",
      raw: lane({ used: 2, total: 2, utilization: 100, state: "EXHAUSTED" }),
      expected: { measured: true, used: 2, total: 2, unit: "requests" },
    },
    {
      name: "overage",
      raw: lane({ used: 3, total: 2, utilization: 150, state: "EXHAUSTED" }),
      expected: { measured: true, used: 3, total: 2, unit: "requests" },
    },
  ];
  for (const fixture of fixtures) {
    const snapshot = sanitizeFleetBudgetReport(input(bytes(report({
      lanes: [{ ...fixture.raw, lane: fixture.name }],
    }))));
    assert.deepEqual(snapshot.lanes, [{
      lane_id: fixture.name,
      ...fixture.expected,
    }], fixture.name);
    assert.equal("window" in snapshot.lanes[0]!, false, fixture.name);
  }
});

test("pins lane count, metric, unit, utilization, state, free-text, and contradiction bounds", () => {
  assert.deepEqual(
    sanitizeFleetBudgetReport(input(bytes(report({ lanes: [] })))).lanes,
    [],
  );
  const maximum = Array.from({ length: 256 }, (_, index) =>
    lane({ lane: `lane-${String(index).padStart(3, "0")}` })
  );
  assert.equal(
    sanitizeFleetBudgetReport(input(bytes(report({ lanes: maximum })))).lanes.length,
    256,
  );
  captureError(
    () => sanitizeFleetBudgetReport(input(bytes(report({
      lanes: [...maximum, lane({ lane: "lane-256" })],
    })))),
    "invalid_report",
    "report.lanes",
  );

  const invalid: Array<[string, Record<string, unknown>, string]> = [
    ["used type", lane({ used: "1" }), "report.lanes[0].used"],
    ["negative used", lane({ used: -0.1 }), "report.lanes[0].used"],
    ["total type", lane({ total: "2" }), "report.lanes[0].total"],
    ["zero total", lane({ total: 0 }), "report.lanes[0].total"],
    ["negative total", lane({ total: -1 }), "report.lanes[0].total"],
    ["unit type", lane({ unit: null }), "report.lanes[0].unit"],
    ["unit length", lane({ unit: "a".repeat(65) }), "report.lanes[0].unit"],
    ["unit grammar", lane({ unit: "request count" }), "report.lanes[0].unit"],
    ["missing utilization", lane({ utilization: null }), "report.lanes[0].utilization"],
    ["utilization without used", lane({ used: null, utilization: 0 }), "report.lanes[0].utilization"],
    ["utilization without total", lane({ total: null, utilization: 0 }), "report.lanes[0].utilization"],
    ["negative utilization", lane({ utilization: -0.1 }), "report.lanes[0].utilization"],
    ["state type", lane({ state: null }), "report.lanes[0].state"],
    ["state enum", lane({ state: "HEALTHY" }), "report.lanes[0].state"],
    ["note scalar bound", lane({ note: "😀".repeat(4_097) }), "report.lanes[0].note"],
    ["detail scalar bound", lane({ detail: "😀".repeat(4_097) }), "report.lanes[0].detail"],
    [
      "unmeasured used",
      lane({ measured: false, used: 0, total: null, unit: "", utilization: null }),
      "report.lanes[0].used",
    ],
    [
      "unmeasured total",
      lane({ measured: false, used: null, total: 1, unit: "", utilization: null }),
      "report.lanes[0].total",
    ],
    [
      "unmeasured utilization",
      lane({ measured: false, used: null, total: null, unit: "", utilization: 0 }),
      "report.lanes[0].utilization",
    ],
    [
      "unmeasured unit",
      lane({ measured: false, used: null, total: null, unit: "requests", utilization: null }),
      "report.lanes[0].unit",
    ],
  ];
  for (const [name, rawLane, path] of invalid) {
    captureError(
      () => sanitizeFleetBudgetReport(input(bytes(report({ lanes: [rawLane] })))),
      "invalid_report",
      path,
    );
    assert.ok(name.length > 0);
  }
  assert.doesNotThrow(() => sanitizeFleetBudgetReport(input(bytes(report({
    lanes: [lane({
      unit: "a".repeat(64),
      note: "😀".repeat(4_096),
      detail: "😀".repeat(4_096),
    })],
  })))));
});

test("erases valid routes, state, utilization, note, and detail byte-identically", () => {
  const secret = "AKIA-SECRET-PROMPT-ignore-previous-period-7-days";
  const baseline = sanitizeFleetBudgetReport(input(bytes(report())));
  const changedRoutes = Object.fromEntries(
    ROUTE_KEYS.map((key, index) => [key, index % 2 === 0 ? secret.slice(0, 128) : null]),
  );
  const changed = sanitizeFleetBudgetReport(input(bytes(report({
    lanes: [lane({
      state: "WARN",
      utilization: 999,
      note: secret,
      detail: `${secret} route command`,
    })],
    routes: changedRoutes,
  }))));
  assert.equal(JSON.stringify(changed), JSON.stringify(baseline));
  assert.doesNotMatch(JSON.stringify(changed), /AKIA|SECRET|PROMPT|period|route command/i);

  const escapedRoute = new TextEncoder().encode(
    JSON.stringify(report()).replace('"bulk"', '"b\\u0075lk"'),
  );
  assert.equal(
    JSON.stringify(sanitizeFleetBudgetReport(input(escapedRoute))),
    JSON.stringify(baseline),
  );

  const unknownError = captureError(
    () => sanitizeFleetBudgetReport(input(bytes({
      ...report(),
      "AKIA-SECRET-UNKNOWN-MEMBER": secret,
    }))),
    "report_schema_drift",
    "report.<unknown-member>",
  );
  const duplicateError = captureError(
    () => sanitizeFleetBudgetReport(input(new TextEncoder().encode(
      `{"AKIA-SECRET":null,"AKIA-SECR\\u0045T":"${secret}"}`,
    ))),
    "invalid_json",
  );
  for (const error of [unknownError, duplicateError]) {
    assert.doesNotMatch(
      JSON.stringify({
        name: error.name,
        message: error.message,
        code: error.code,
        path: error.path,
      }),
      /AKIA|SECRET|PROMPT|period|route command/i,
    );
  }
});
