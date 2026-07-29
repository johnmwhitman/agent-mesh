import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileFleetBudgetObservations,
  FLEETBUDGET_SNAPSHOT_VERSION,
} from "../src/fleetbudget-observations.js";

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
  assert.deepEqual(result.observations, []);
  assert.deepEqual(result.diagnostics, []);
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

test("rejects fleetbudget array bounds, identifiers, and exact unit grammar", () => {
  assert.throws(
    () => compileFleetBudgetObservations(input({ snapshot: snapshot({ lanes: Array.from({ length: 257 }, (_, index) => ({ ...snapshot().lanes[0], lane_id: `lane-${index}` })) }) }) as never),
    expects("input.snapshot.lanes", "must be an array with 0..256 items"),
  );
  assert.throws(
    () => compileFleetBudgetObservations(input({ bindings: Array.from({ length: 257 }, (_, index) => ({ candidate_id: `candidate-${index}`, lane_id: `lane-${index}` })) }) as never),
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

test("rejects duplicate bindings and contradictory lane claims", () => {
  assert.throws(
    () => compileFleetBudgetObservations(input({ snapshot: snapshot({ lanes: [{ ...snapshot().lanes[0] }, { ...snapshot().lanes[0] }] }) }) as never),
    expects("input.snapshot.lanes[1].lane_id", "is a duplicate lane_id 'grok-build'"),
  );
  assert.throws(
    () => compileFleetBudgetObservations(input({ bindings: [{ candidate_id: "lane-a", lane_id: "grok-build" }, { candidate_id: "lane-a", lane_id: "other" }] }) as never),
    expects("input.bindings[1].candidate_id", "is a duplicate candidate_id 'lane-a'"),
  );
  assert.throws(
    () => compileFleetBudgetObservations(input({ bindings: [{ candidate_id: "lane-a", lane_id: "grok-build" }, { candidate_id: "lane-b", lane_id: "grok-build" }] }) as never),
    expects("input.bindings[1].lane_id", "is already bound to candidate_id 'lane-a'"),
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
});
