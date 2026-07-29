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
