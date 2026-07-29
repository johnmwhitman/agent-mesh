import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileFleetBudgetObservations,
  FLEETBUDGET_SNAPSHOT_VERSION,
} from "../src/fleetbudget-observations.js";
import { sanitizeFleetBudgetReport } from "../src/fleetbudget-sanitizer.js";
import {
  compileRouteCandidates,
  ROUTE_CANDIDATE_COMPILER_VERSION,
} from "../src/compile-route-candidates.js";
import { recommendRoute } from "../src/recommend-route.js";

const effects = {
  persisted: false,
  executed: false,
  authorized: false,
  woke_agents: false,
  contacted_providers: false,
} as const;

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    version: FLEETBUDGET_SNAPSHOT_VERSION,
    observed_at_ms: 100,
    expires_at_ms: 1_000,
    lanes: [{
      lane_id: "grok-build",
      measured: true,
      used: 1,
      total: 2,
      unit: "tokens",
      window: { id: "july", starts_at_ms: 0, ends_at_ms: 2_000 },
    }],
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    snapshot: snapshot(),
    bindings: [{ candidate_id: "lane-a", lane_id: "grok-build" }],
    now_ms: 100,
    ...overrides,
  };
}

const RAW_COLLECTION_MS = Date.parse("2023-11-14T22:13:20.000Z");
const RAW_ROUTE_KEYS = [
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

function sanitizeRawBudgetLane(
  laneOverrides: Record<string, unknown> = {},
  reportOverrides: Record<string, unknown> = {},
) {
  const rawReport = {
    generated: "2023-11-14T22:13:20+00:00",
    lanes: [{
      lane: "grok-build",
      measured: true,
      used: 1,
      total: 2,
      unit: "requests",
      utilization: 50,
      state: "OK",
      note: "",
      detail: "",
      ...laneOverrides,
    }],
    routes: Object.fromEntries(
      RAW_ROUTE_KEYS.map((key) => [key, key === "bulk" ? "grok-build" : null]),
    ),
    ...reportOverrides,
  };
  return sanitizeFleetBudgetReport({
    report_bytes: new TextEncoder().encode(JSON.stringify(rawReport)),
    collection_started_at_ms: RAW_COLLECTION_MS,
    collection_finished_at_ms: RAW_COLLECTION_MS,
    now_ms: RAW_COLLECTION_MS,
  });
}

function expects(path: string, detail: string): RegExp {
  return new RegExp(`fleetbudget_observations: '${path.replace(/[.[\]\\]/g, "\\$&")}' ${detail}`);
}

test("exports the fleetbudget observation subpath and accepts a closed valid schema", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { exports: Record<string, string> };

  assert.equal(FLEETBUDGET_SNAPSHOT_VERSION, "meshfleet.fleetbudget-snapshot.v1");
  assert.equal(
    packageJson.exports["./fleetbudget-observations"],
    "./dist/fleetbudget-observations.js",
  );

  const result = compileFleetBudgetObservations(input());
  assert.equal(result.projection, true);
  assert.deepEqual(result.effects, effects);
  assert.equal(result.source.kind, "fleetbudget-sanitized-v1");
});
test("rejects closed fleetbudget observation ingress before deeper validation", () => {
  assert.throws(
    () => compileFleetBudgetObservations({ ...input(), extra: true } as never),
    expects("input.extra", "is not allowed"),
  );
  assert.throws(
    () => compileFleetBudgetObservations(input({ snapshot: { ...snapshot(), extra: true } }) as never),
    expects("input.snapshot.extra", "is not allowed"),
  );
  assert.throws(
    () => compileFleetBudgetObservations(input({ snapshot: snapshot({ lanes: [{ ...snapshot().lanes[0], extra: true }] }) }) as never),
    expects("input.snapshot.lanes[0].extra", "is not allowed"),
  );
  assert.throws(
    () => compileFleetBudgetObservations(input({ bindings: [{ candidate_id: "lane-a", lane_id: "grok-build", extra: true }] }) as never),
    expects("input.bindings[0].extra", "is not allowed"),
  );
  assert.throws(
    () => compileFleetBudgetObservations(input({ snapshot: snapshot({ lanes: [{ ...snapshot().lanes[0], window: { id: "july", starts_at_ms: 0, ends_at_ms: 2_000, extra: true } }] }) }) as never),
    expects("input.snapshot.lanes[0].window.extra", "is not allowed"),
  );
});

test("rejects missing required fields and invalid snapshot lifetime before projection", () => {
  assert.throws(
    () => compileFleetBudgetObservations({ snapshot: snapshot(), bindings: [] } as never),
    expects("input.now_ms", "is required"),
  );
  assert.throws(
    () => compileFleetBudgetObservations(input({ snapshot: snapshot({ version: "wrong" }) }) as never),
    expects("input.snapshot.version", `must equal ${FLEETBUDGET_SNAPSHOT_VERSION}`),
  );
  for (const expires_at_ms of [100, 99, 600_101]) {
    assert.throws(
      () => compileFleetBudgetObservations(input({ snapshot: snapshot({ expires_at_ms }) }) as never),
      expects("input.snapshot.expires_at_ms", "must make snapshot TTL a finite integer between 1 and 600000 ms"),
    );
  }
  for (const now_ms of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(
      () => compileFleetBudgetObservations(input({ now_ms }) as never),
      expects("input.now_ms", "must be a finite integer"),
    );
  }
  assert.throws(
    () => compileFleetBudgetObservations(input({ now_ms: 99 }) as never),
    expects("input.snapshot", "is future-dated"),
  );
  assert.throws(
    () => compileFleetBudgetObservations(input({ now_ms: 1_000 }) as never),
    expects("input.snapshot", "is expired"),
  );
});

test("validates now_ms before snapshot timing after accepting the snapshot version", () => {
  assert.throws(
    () => compileFleetBudgetObservations(input({
      now_ms: Number.NaN,
      snapshot: snapshot({ expires_at_ms: 600_101 }),
    }) as never),
    expects("input.now_ms", "must be a finite integer"),
  );
});

test("rejects fleetbudget array bounds, identifiers, and exact unit grammar", () => {
  assert.throws(
    () => compileFleetBudgetObservations(input({ snapshot: snapshot({ lanes: Array.from({ length: 257 }, (_, index) => ({ ...snapshot().lanes[0], lane_id: `lane-${index}` })) }) }) as never),
    expects("input.snapshot.lanes", "must be an array with 0..256 items"),
  );
  const maxShared = compileFleetBudgetObservations(input({
    bindings: Array.from({ length: 256 }, (_, index) => ({
      candidate_id: `candidate-${String(index).padStart(3, "0")}`,
      lane_id: "grok-build",
    })),
  }));
  assert.equal(maxShared.observations.length, 256);
  assert.equal(maxShared.diagnostics.length, 256);
  assert.equal(maxShared.observations[0]?.candidate_id, "candidate-000");
  assert.equal(maxShared.observations[255]?.candidate_id, "candidate-255");
  assert.throws(
    () => compileFleetBudgetObservations(input({
      bindings: Array.from({ length: 257 }, (_, index) => ({
        candidate_id: `candidate-${String(index).padStart(3, "0")}`,
        lane_id: "grok-build",
      })),
    }) as never),
    expects("input.bindings", "must be an array with 0..256 items"),
  );
  for (const [path, value] of [
    ["input.snapshot.lanes[0].lane_id", "l".repeat(129)],
    ["input.bindings[0].candidate_id", "c".repeat(129)],
    ["input.bindings[0].lane_id", "l".repeat(129)],
  ] as const) {
    const candidate = path.includes("candidate_id")
      ? input({ bindings: [{ candidate_id: value, lane_id: "grok-build" }] })
      : path.includes("bindings")
        ? input({ bindings: [{ candidate_id: "lane-a", lane_id: value }] })
        : input({ snapshot: snapshot({ lanes: [{ ...snapshot().lanes[0], lane_id: value }] }) });
    assert.throws(
      () => compileFleetBudgetObservations(candidate as never),
      expects(path, "must be a non-empty string no longer than 128 characters"),
    );
  }
  for (const unit of ["token count", "TOKENS", "", "u".repeat(65)]) {
    assert.throws(
      () => compileFleetBudgetObservations(input({ snapshot: snapshot({ lanes: [{ ...snapshot().lanes[0], unit }] }) }) as never),
      expects("input.snapshot.lanes[0].unit", "must be null or a lowercase unit token no longer than 64 characters"),
    );
  }
  assert.doesNotThrow(() =>
    compileFleetBudgetObservations(input({ snapshot: snapshot({ lanes: [{ ...snapshot().lanes[0], unit: "tokens" }] }) })),
  );
});

test("rejects duplicate snapshot lanes, duplicate candidates, and contradictory lane claims", () => {
  assert.throws(
    () => compileFleetBudgetObservations(input({ snapshot: snapshot({ lanes: [{ ...snapshot().lanes[0] }, { ...snapshot().lanes[0] }] }) }) as never),
    expects("input.snapshot.lanes[1].lane_id", "is a duplicate lane_id 'grok-build'"),
  );
  assert.throws(
    () => compileFleetBudgetObservations(input({ bindings: [{ candidate_id: "lane-a", lane_id: "grok-build" }, { candidate_id: "lane-a", lane_id: "other" }] }) as never),
    expects("input.bindings[1].candidate_id", "is a duplicate candidate_id 'lane-a'"),
  );
  assert.throws(
    () => compileFleetBudgetObservations(input({ snapshot: snapshot({ lanes: [{ ...snapshot().lanes[0], measured: false, used: 0 }] }) }) as never),
    expects("input.snapshot.lanes[0].used", "must be null when measured is false"),
  );
  assert.throws(
    () => compileFleetBudgetObservations(input({ snapshot: snapshot({ lanes: [{ ...snapshot().lanes[0], window: { id: "july", starts_at_ms: 100, ends_at_ms: 100 } }] }) }) as never),
    expects("input.snapshot.lanes[0].window.ends_at_ms", "must be greater than starts_at_ms"),
  );
  assert.throws(
    () => compileFleetBudgetObservations(input({ snapshot: snapshot({ lanes: [{ ...snapshot().lanes[0], window: { id: "july", starts_at_ms: 101, ends_at_ms: 2_000 } }] }) }) as never),
    expects("input.snapshot.lanes[0].window", "must contain snapshot.observed_at_ms"),
  );
  assert.throws(
    () => compileFleetBudgetObservations(input({
      snapshot: snapshot({
        lanes: [{
          ...snapshot().lanes[0],
          window: {
            id: "july",
            starts_at_ms: Number.MIN_SAFE_INTEGER - 1,
            ends_at_ms: 2_000,
          },
        }],
      }),
    }) as never),
    expects(
      "input.snapshot.lanes[0].window.starts_at_ms",
      "must be a finite safe integer",
    ),
  );
});

test("projects one shared green lane to two candidates without splitting or mutating evidence", () => {
  const sharedInput = {
    snapshot: snapshot(),
    bindings: [
      { candidate_id: "candidate-z", lane_id: "grok-build" },
      { candidate_id: "candidate-a", lane_id: "grok-build" },
    ],
    now_ms: 100,
  };
  const permutedInput = {
    now_ms: 100,
    bindings: [
      { lane_id: "grok-build", candidate_id: "candidate-a" },
      { lane_id: "grok-build", candidate_id: "candidate-z" },
    ],
    snapshot: {
      lanes: [{
        window: { ends_at_ms: 2_000, starts_at_ms: 0, id: "july" },
        unit: "tokens",
        total: 2,
        used: 1,
        measured: true,
        lane_id: "grok-build",
      }],
      expires_at_ms: 1_000,
      observed_at_ms: 100,
      version: FLEETBUDGET_SNAPSHOT_VERSION,
    },
  };
  const sharedBefore = structuredClone(sharedInput);
  const permutedBefore = structuredClone(permutedInput);

  const projected = compileFleetBudgetObservations(sharedInput);
  const permuted = compileFleetBudgetObservations(permutedInput);

  assert.deepEqual(sharedInput, sharedBefore);
  assert.deepEqual(permutedInput, permutedBefore);
  assert.deepEqual(permuted, projected);
  assert.deepEqual(projected.effects, effects);
  assert.deepEqual(projected.observations, [
    {
      candidate_id: "candidate-a",
      status: "green",
      confidence: "measured",
      budget: {
        used: 1,
        total: 2,
        window: { starts_at_ms: 0, ends_at_ms: 2_000 },
      },
    },
    {
      candidate_id: "candidate-z",
      status: "green",
      confidence: "measured",
      budget: {
        used: 1,
        total: 2,
        window: { starts_at_ms: 0, ends_at_ms: 2_000 },
      },
    },
  ]);
  assert.deepEqual(projected.diagnostics, [
    { candidate_id: "candidate-a", lane_id: "grok-build", reason_codes: [] },
    { candidate_id: "candidate-z", lane_id: "grok-build", reason_codes: [] },
  ]);
  assert.deepEqual(projected.source, {
    kind: "fleetbudget-sanitized-v1",
    observed_at_ms: 100,
    expires_at_ms: 1_000,
    snapshot_sha256: "a8948c6050c1abc4b2a75001bb143c3222647744c6aa899d1756a5db651108b6",
    bindings_sha256: "9dea6237e47669138ab909b5c6e082a5a809d04affefe743aa1a8e902b076eb4",
  });
});

test("fans shared exhausted and unusable evidence out with exact sorted diagnostics", () => {
  const bindings = [
    { candidate_id: "candidate-z", lane_id: "grok-build" },
    { candidate_id: "candidate-a", lane_id: "grok-build" },
  ];
  const cases = [
    {
      name: "exhausted",
      snapshot: snapshot({ lanes: [{ ...snapshot().lanes[0], used: 2, total: 2 }] }),
      now_ms: 100,
      reason_codes: [],
      observations: [
        {
          candidate_id: "candidate-a",
          status: "exhausted",
          confidence: "measured",
          budget: {
            used: 2,
            total: 2,
            window: { starts_at_ms: 0, ends_at_ms: 2_000 },
          },
        },
        {
          candidate_id: "candidate-z",
          status: "exhausted",
          confidence: "measured",
          budget: {
            used: 2,
            total: 2,
            window: { starts_at_ms: 0, ends_at_ms: 2_000 },
          },
        },
      ],
    },
    {
      name: "unmeasured",
      snapshot: snapshot({
        lanes: [{ lane_id: "grok-build", measured: false, used: null, total: null, unit: null }],
      }),
      now_ms: 100,
      reason_codes: ["LANE_UNMEASURED"],
      observations: [],
    },
    {
      name: "incomplete",
      snapshot: snapshot({
        lanes: [{ lane_id: "grok-build", measured: true, used: null, total: null, unit: null }],
      }),
      now_ms: 100,
      reason_codes: [
        "BUDGET_USED_UNAVAILABLE",
        "BUDGET_TOTAL_UNAVAILABLE",
        "BUDGET_UNIT_UNAVAILABLE",
        "WINDOW_MISSING",
      ],
      observations: [],
    },
    {
      name: "missing",
      snapshot: snapshot({ lanes: [] }),
      now_ms: 100,
      reason_codes: ["LANE_NOT_REPORTED"],
      observations: [],
    },
    {
      name: "non-current",
      snapshot: snapshot({
        lanes: [{
          ...snapshot().lanes[0],
          window: { id: "july", starts_at_ms: 0, ends_at_ms: 150 },
        }],
      }),
      now_ms: 200,
      reason_codes: ["WINDOW_NOT_CURRENT"],
      observations: [],
    },
  ];

  for (const fixture of cases) {
    const projected = compileFleetBudgetObservations({
      snapshot: fixture.snapshot,
      bindings,
      now_ms: fixture.now_ms,
    });

    assert.deepEqual(projected.observations, fixture.observations, fixture.name);
    assert.deepEqual(projected.diagnostics, [
      {
        candidate_id: "candidate-a",
        lane_id: "grok-build",
        reason_codes: fixture.reason_codes,
      },
      {
        candidate_id: "candidate-z",
        lane_id: "grok-build",
        reason_codes: fixture.reason_codes,
      },
    ], fixture.name);
    assert.deepEqual(projected.effects, effects, fixture.name);
  }
});

test("projects measured green evidence with its empty resolution ledger", () => {
  const result = compileFleetBudgetObservations(input());

  assert.deepEqual(result.effects, effects);
  assert.deepEqual(result.observations, [{
    candidate_id: "lane-a",
    status: "green",
    confidence: "measured",
    budget: {
      used: 1,
      total: 2,
      window: { starts_at_ms: 0, ends_at_ms: 2_000 },
    },
  }]);
  assert.deepEqual(result.diagnostics, [{
    candidate_id: "lane-a",
    lane_id: "grok-build",
    reason_codes: [],
  }]);
  assert.deepEqual(result.source, {
    kind: "fleetbudget-sanitized-v1",
    observed_at_ms: 100,
    expires_at_ms: 1_000,
    snapshot_sha256: "a8948c6050c1abc4b2a75001bb143c3222647744c6aa899d1756a5db651108b6",
    bindings_sha256: "7119e8fbd4105f36ea4912ed1796385d17f3f8ae50ebff378566f353f53da1b4",
  });
});

test("projects exact exhaustion without clamping overage", () => {
  const result = compileFleetBudgetObservations(input({
    snapshot: snapshot({ lanes: [{ ...snapshot().lanes[0], used: 12, total: 10 }] }),
  }));

  assert.deepEqual(result.observations, [{
    candidate_id: "lane-a",
    status: "exhausted",
    confidence: "measured",
    budget: {
      used: 12,
      total: 10,
      window: { starts_at_ms: 0, ends_at_ms: 2_000 },
    },
  }]);
  assert.deepEqual(result.diagnostics, [{ candidate_id: "lane-a", lane_id: "grok-build", reason_codes: [] }]);
});

test("diagnoses missing, unmeasured, incomplete, and stale telemetry without assumptions", () => {
  const missing = compileFleetBudgetObservations(input({
    bindings: [{ candidate_id: "lane-a", lane_id: "missing" }],
  }));
  assert.deepEqual(missing.observations, []);
  assert.deepEqual(missing.diagnostics, [{
    candidate_id: "lane-a", lane_id: "missing", reason_codes: ["LANE_NOT_REPORTED"],
  }]);

  const unmeasured = compileFleetBudgetObservations(input({
    snapshot: snapshot({
      lanes: [{ lane_id: "grok-build", measured: false, used: null, total: null, unit: null }],
    }),
  }));
  assert.deepEqual(unmeasured.observations, []);
  assert.deepEqual(unmeasured.diagnostics, [{
    candidate_id: "lane-a", lane_id: "grok-build", reason_codes: ["LANE_UNMEASURED"],
  }]);

  const allNull = compileFleetBudgetObservations(input({
    snapshot: snapshot({
      lanes: [{ lane_id: "grok-build", measured: true, used: null, total: null, unit: null }],
    }),
  }));
  assert.deepEqual(allNull.observations, []);
  assert.deepEqual(allNull.diagnostics, [{
    candidate_id: "lane-a",
    lane_id: "grok-build",
    reason_codes: [
      "BUDGET_USED_UNAVAILABLE",
      "BUDGET_TOTAL_UNAVAILABLE",
      "BUDGET_UNIT_UNAVAILABLE",
      "WINDOW_MISSING",
    ],
  }]);

  const missingUnit = compileFleetBudgetObservations(input({
    snapshot: snapshot({ lanes: [{ ...snapshot().lanes[0], unit: null }] }),
  }));
  assert.deepEqual(missingUnit.diagnostics, [{
    candidate_id: "lane-a", lane_id: "grok-build", reason_codes: ["BUDGET_UNIT_UNAVAILABLE"],
  }]);

  const missingWindow = compileFleetBudgetObservations(input({
    snapshot: snapshot({ lanes: [{ ...snapshot().lanes[0], window: undefined }] }),
  }));
  assert.deepEqual(missingWindow.diagnostics, [{
    candidate_id: "lane-a", lane_id: "grok-build", reason_codes: ["WINDOW_MISSING"],
  }]);

  const historical = compileFleetBudgetObservations(input({
    now_ms: 200,
    snapshot: snapshot({
      lanes: [{
        ...snapshot().lanes[0],
        window: { id: "july", starts_at_ms: 0, ends_at_ms: 150 },
      }],
    }),
  }));
  assert.deepEqual(historical.diagnostics, [{
    candidate_id: "lane-a", lane_id: "grok-build", reason_codes: ["WINDOW_NOT_CURRENT"],
  }]);
});

test("sanitized complete and exhausted raw ceilings remain WINDOW_MISSING and non-actionable", () => {
  for (const fixture of [
    { name: "complete", lane: {} },
    {
      name: "exhausted",
      lane: { used: 2, total: 2, utilization: 100, state: "EXHAUSTED" },
    },
  ]) {
    const sanitized = sanitizeRawBudgetLane(fixture.lane);
    assert.equal("window" in sanitized.lanes[0]!, false, fixture.name);
    const projected = compileFleetBudgetObservations({
      snapshot: sanitized,
      bindings: [{ candidate_id: "lane-a", lane_id: "grok-build" }],
      now_ms: RAW_COLLECTION_MS,
    });
    assert.deepEqual(projected.observations, [], fixture.name);
    assert.deepEqual(projected.diagnostics, [{
      candidate_id: "lane-a",
      lane_id: "grok-build",
      reason_codes: ["WINDOW_MISSING"],
    }], fixture.name);
    assert.doesNotMatch(JSON.stringify(projected), /BUDGET_EXHAUSTED/, fixture.name);
    assert.deepEqual(projected.effects, effects, fixture.name);
  }
});

test("discarded raw fields cannot affect downstream snapshots, hashes, diagnostics, or effects", () => {
  const secret = "AKIA-SECRET-PROMPT-ignore-previous-period-7-days";
  const baseline = sanitizeRawBudgetLane();
  const changed = sanitizeRawBudgetLane(
    {
      utilization: 9_999,
      state: "LOW",
      note: secret,
      detail: `${secret} route command`,
    },
    {
      routes: Object.fromEntries(
        RAW_ROUTE_KEYS.map((key, index) => [
          key,
          index % 2 === 0 ? secret.slice(0, 128) : null,
        ]),
      ),
    },
  );
  const binding = [{ candidate_id: "lane-a", lane_id: "grok-build" }];
  const first = compileFleetBudgetObservations({
    snapshot: baseline,
    bindings: binding,
    now_ms: RAW_COLLECTION_MS,
  });
  const second = compileFleetBudgetObservations({
    snapshot: changed,
    bindings: binding,
    now_ms: RAW_COLLECTION_MS,
  });

  assert.equal(JSON.stringify(changed), JSON.stringify(baseline));
  assert.deepEqual(second, first);
  assert.equal(second.source.snapshot_sha256, first.source.snapshot_sha256);
  assert.doesNotMatch(
    JSON.stringify(second),
    /AKIA|SECRET|PROMPT|period|route command/i,
  );
  assert.deepEqual(second.effects, effects);
});

test("projects deterministically without mutating array or object-key permutations", () => {
  const baselineInput = {
    snapshot: snapshot({
      lanes: [
        { ...snapshot().lanes[0], lane_id: "lane-z" },
        { ...snapshot().lanes[0], lane_id: "lane-a" },
      ],
    }),
    bindings: [
      { candidate_id: "candidate-z", lane_id: "lane-z" },
      { candidate_id: "candidate-a", lane_id: "lane-a" },
    ],
    now_ms: 100,
  };
  const permutedInput = {
    now_ms: 100,
    bindings: [
      { lane_id: "lane-a", candidate_id: "candidate-a" },
      { lane_id: "lane-z", candidate_id: "candidate-z" },
    ],
    snapshot: {
      lanes: [
        { window: { ends_at_ms: 2_000, starts_at_ms: 0, id: "july" }, unit: "tokens", total: 2, used: 1, measured: true, lane_id: "lane-a" },
        { window: { ends_at_ms: 2_000, starts_at_ms: 0, id: "july" }, unit: "tokens", total: 2, used: 1, measured: true, lane_id: "lane-z" },
      ],
      expires_at_ms: 1_000,
      observed_at_ms: 100,
      version: FLEETBUDGET_SNAPSHOT_VERSION,
    },
  };
  const baselineBefore = structuredClone(baselineInput);
  const permutedBefore = structuredClone(permutedInput);

  const baseline = compileFleetBudgetObservations(baselineInput);
  const permuted = compileFleetBudgetObservations(permutedInput);

  assert.deepEqual(baselineInput, baselineBefore);
  assert.deepEqual(permutedInput, permutedBefore);
  assert.deepEqual(permuted, baseline);
  assert.deepEqual(baseline.observations.map(({ candidate_id }) => candidate_id), ["candidate-a", "candidate-z"]);
  assert.deepEqual(baseline.diagnostics.map(({ candidate_id }) => candidate_id), ["candidate-a", "candidate-z"]);
});

test("hashes an absent quota window as literal null in the fixed-key snapshot preimage", () => {
  const result = compileFleetBudgetObservations(input({
    snapshot: snapshot({ lanes: [{ ...snapshot().lanes[0], window: undefined }] }),
  }));
  const preimage = JSON.stringify({
    version: FLEETBUDGET_SNAPSHOT_VERSION,
    observed_at_ms: 100,
    expires_at_ms: 1_000,
    lanes: [{
      lane_id: "grok-build",
      measured: true,
      used: 1,
      total: 2,
      unit: "tokens",
      window: null,
    }],
  });

  assert.match(preimage, /"window":null/);
  assert.equal(
    result.source.snapshot_sha256,
    createHash("sha256").update(preimage).digest("hex"),
  );
});

test("adding or removing a shared candidate changes only the binding provenance hash", () => {
  const oneCandidate = compileFleetBudgetObservations(input({
    bindings: [{ candidate_id: "candidate-a", lane_id: "grok-build" }],
  }));
  const addedCandidate = compileFleetBudgetObservations(input({
    bindings: [
      { candidate_id: "candidate-z", lane_id: "grok-build" },
      { candidate_id: "candidate-a", lane_id: "grok-build" },
    ],
  }));
  const removedCandidate = compileFleetBudgetObservations(input({
    bindings: [{ candidate_id: "candidate-a", lane_id: "grok-build" }],
  }));

  assert.equal(addedCandidate.source.snapshot_sha256, oneCandidate.source.snapshot_sha256);
  assert.notEqual(addedCandidate.source.bindings_sha256, oneCandidate.source.bindings_sha256);
  assert.deepEqual(removedCandidate, oneCandidate);
});

function manifest(...candidates: Record<string, unknown>[]) {
  return {
    version: ROUTE_CANDIDATE_COMPILER_VERSION,
    candidates,
  };
}

const routeTask = {
  required_capabilities: ["code"],
  privacy: "network_ok" as const,
  locality: "any" as const,
};

test("projected shared exhausted evidence excludes both candidates", () => {
  const projected = compileFleetBudgetObservations(input({
    snapshot: snapshot({ lanes: [{ ...snapshot().lanes[0], used: 10, total: 10 }] }),
    bindings: [
      { candidate_id: "candidate-z", lane_id: "grok-build" },
      { candidate_id: "candidate-a", lane_id: "grok-build" },
    ],
  }));
  const compiled = compileRouteCandidates({
    manifest: manifest(
      {
        candidate_id: "candidate-z",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
      },
      {
        candidate_id: "candidate-a",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
      },
    ),
    observations: projected.observations,
  });
  const recommendation = recommendRoute({ task: routeTask, candidates: compiled.candidates });

  assert.deepEqual(recommendation.ranked, []);
  assert.deepEqual(recommendation.excluded, [
    { candidate_id: "candidate-a", reason_codes: ["BUDGET_EXHAUSTED"] },
    { candidate_id: "candidate-z", reason_codes: ["BUDGET_EXHAUSTED"] },
  ]);
});

test("ceiling-less and unmeasured fleetbudget lanes remain neutral", () => {
  const cases = [
    {
      name: "ceiling-less",
      projected: compileFleetBudgetObservations(input({
        snapshot: snapshot({
          lanes: [{ lane_id: "grok-build", measured: true, used: null, total: null, unit: null }],
        }),
      })),
    },
    {
      name: "unmeasured",
      projected: compileFleetBudgetObservations(input({
        snapshot: snapshot({
          lanes: [{ lane_id: "grok-build", measured: false, used: null, total: null, unit: null }],
        }),
      })),
    },
  ];

  for (const { name, projected } of cases) {
    const compiled = compileRouteCandidates({
      manifest: manifest({
        candidate_id: "lane-a",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
      }),
      observations: projected.observations,
    });
    const recommendation = recommendRoute({ task: routeTask, candidates: compiled.candidates });

    assert.deepEqual(recommendation.excluded, [], name);
    assert.deepEqual(recommendation.ranked.map(({ budget, reason_codes }) => ({ budget, reason_codes })), [{
      budget: { measured: false, status: "unmeasured" },
      reason_codes: ["OUTCOMES_UNMEASURED", "BUDGET_UNMEASURED"],
    }], name);
  }
});

test("shared incomplete evidence keeps both compiled candidates neutral", () => {
  const projected = compileFleetBudgetObservations(input({
    snapshot: snapshot({
      lanes: [{ lane_id: "grok-build", measured: true, used: null, total: null, unit: null }],
    }),
    bindings: [
      { candidate_id: "candidate-z", lane_id: "grok-build" },
      { candidate_id: "candidate-a", lane_id: "grok-build" },
    ],
  }));
  const compiled = compileRouteCandidates({
    manifest: manifest(
      {
        candidate_id: "candidate-z",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
      },
      {
        candidate_id: "candidate-a",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
      },
    ),
    observations: projected.observations,
  });
  const recommendation = recommendRoute({
    task: routeTask,
    candidates: compiled.candidates,
    top_n: 2,
  });

  assert.deepEqual(projected.observations, []);
  assert.deepEqual(compiled.diagnostics, [
    {
      candidate_id: "candidate-a",
      reason_codes: ["OBSERVATION_MISSING", "BUDGET_UNMEASURED"],
    },
    {
      candidate_id: "candidate-z",
      reason_codes: ["OBSERVATION_MISSING", "BUDGET_UNMEASURED"],
    },
  ]);
  assert.deepEqual(recommendation.ranked.map(({ candidate_id, budget, reason_codes }) => ({
    candidate_id,
    budget,
    reason_codes,
  })), [
    {
      candidate_id: "candidate-a",
      budget: { measured: false, status: "unmeasured" },
      reason_codes: ["OUTCOMES_UNMEASURED", "BUDGET_UNMEASURED"],
    },
    {
      candidate_id: "candidate-z",
      budget: { measured: false, status: "unmeasured" },
      reason_codes: ["OUTCOMES_UNMEASURED", "BUDGET_UNMEASURED"],
    },
  ]);
  assert.deepEqual(recommendation.excluded, []);
  assert.deepEqual(recommendation.effects, effects);
});

test("mixed shared-green and private-exhausted lanes preserve independent evidence", () => {
  const projected = compileFleetBudgetObservations(input({
    snapshot: snapshot({
      lanes: [
        { ...snapshot().lanes[0], lane_id: "shared-pool", used: 1, total: 2 },
        { ...snapshot().lanes[0], lane_id: "private-pool", used: 3, total: 3 },
      ],
    }),
    bindings: [
      { candidate_id: "candidate-z", lane_id: "private-pool" },
      { candidate_id: "candidate-b", lane_id: "shared-pool" },
      { candidate_id: "candidate-a", lane_id: "shared-pool" },
    ],
  }));
  const compiled = compileRouteCandidates({
    manifest: manifest(
      {
        candidate_id: "candidate-z",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
      },
      {
        candidate_id: "candidate-b",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
      },
      {
        candidate_id: "candidate-a",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
      },
    ),
    observations: projected.observations,
  });
  const recommendation = recommendRoute({
    task: routeTask,
    candidates: compiled.candidates,
    top_n: 2,
  });

  assert.deepEqual(projected.observations, [
    {
      candidate_id: "candidate-a",
      status: "green",
      confidence: "measured",
      budget: {
        used: 1,
        total: 2,
        window: { starts_at_ms: 0, ends_at_ms: 2_000 },
      },
    },
    {
      candidate_id: "candidate-b",
      status: "green",
      confidence: "measured",
      budget: {
        used: 1,
        total: 2,
        window: { starts_at_ms: 0, ends_at_ms: 2_000 },
      },
    },
    {
      candidate_id: "candidate-z",
      status: "exhausted",
      confidence: "measured",
      budget: {
        used: 3,
        total: 3,
        window: { starts_at_ms: 0, ends_at_ms: 2_000 },
      },
    },
  ]);
  assert.deepEqual(projected.diagnostics, [
    { candidate_id: "candidate-a", lane_id: "shared-pool", reason_codes: [] },
    { candidate_id: "candidate-b", lane_id: "shared-pool", reason_codes: [] },
    { candidate_id: "candidate-z", lane_id: "private-pool", reason_codes: [] },
  ]);
  assert.deepEqual(
    recommendation.ranked.map(({ candidate_id, budget }) => ({ candidate_id, budget })),
    [
      {
        candidate_id: "candidate-a",
        budget: { measured: true, status: "healthy", utilization: 0.5 },
      },
      {
        candidate_id: "candidate-b",
        budget: { measured: true, status: "healthy", utilization: 0.5 },
      },
    ],
  );
  assert.deepEqual(recommendation.excluded, [
    { candidate_id: "candidate-z", reason_codes: ["BUDGET_EXHAUSTED"] },
  ]);
  assert.deepEqual(recommendation.effects, effects);
});

test("provider-shaped fleetbudget lane IDs cannot alter route authority", () => {
  const projected = compileFleetBudgetObservations(input({
    snapshot: snapshot({
      lanes: [{ ...snapshot().lanes[0], lane_id: "unrestricted-provider-authenticated" }],
    }),
    bindings: [{ candidate_id: "lane-a", lane_id: "unrestricted-provider-authenticated" }],
  }));
  const compiled = compileRouteCandidates({
    manifest: manifest({
      candidate_id: "lane-a",
      capabilities: ["code"],
      privacy: "local_only",
      locality: "same_host",
      requested_identity: { runtime: "declared-runtime", model: "declared-model" },
    }),
    observations: projected.observations,
  });
  const candidate = compiled.candidates[0]!;
  const recommendation = recommendRoute({
    task: { ...routeTask, privacy: "local_only", locality: "same_host" },
    candidates: compiled.candidates,
  });

  assert.deepEqual(candidate, {
    candidate_id: "lane-a",
    capabilities: ["code"],
    privacy: "local_only",
    locality: "same_host",
    budget: {
      measured: true,
      used: 1,
      total: 2,
      window: { starts_at_ms: 0, ends_at_ms: 2_000 },
    },
    requested_identity: { runtime: "declared-runtime", model: "declared-model" },
  });
  assert.equal("observed_identity" in candidate, false);
  assert.equal("health" in (candidate as Record<string, unknown>), false);
  assert.equal("authentication" in (candidate as Record<string, unknown>), false);
  assert.deepEqual(recommendation.effects, effects);
  assert.deepEqual(recommendation.ranked[0]!.identity, {
    requested: { runtime: "declared-runtime", model: "declared-model" },
    evidence_only: true,
    status: "unobserved",
  });
});
