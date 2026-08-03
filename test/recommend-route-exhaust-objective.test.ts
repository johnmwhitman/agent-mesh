/**
 * `exhaust_before_reset` — the operator's pool problem, as an opt-in advisory objective.
 *
 * Flat-rate pools reset on fixed windows; capacity left unspent at reset is paid for and lost.
 * `prefer_near_reset` already computes the right signal (remaining fraction x reset proximity)
 * but applies it only as a TIE-BREAK after final score, so a full pool minutes from reset still
 * loses to any candidate with a marginally better score. This objective makes the same
 * measured, current-window urgency the PRIMARY sort key.
 *
 * The honesty rules under test, in order of importance:
 *   - Opt-in only: with no preference, ranking is unchanged.
 *   - Only MEASURED, CURRENT-window evidence produces urgency. Unmeasured candidates carry
 *     urgency 0 — among themselves their order stays exactly the default order, so absence of
 *     evidence never reorders anything it cannot speak to.
 *   - A measured-exhausted candidate stays EXCLUDED; urgency never resurrects it.
 *   - `prefer_near_reset` semantics are untouched: still a tie-break, never a promotion.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  recommendRoute,
  type RecommendRouteCandidate,
  type RecommendRouteInput,
} from "../src/recommend-route.js";

const NOW_MS = 1_800_000_000_000;
const HOUR_MS = 3_600_000;

function candidate(
  candidate_id: string,
  overrides: Partial<RecommendRouteCandidate> = {},
): RecommendRouteCandidate {
  return {
    candidate_id,
    capabilities: ["code"],
    privacy: "network_ok",
    locality: "any",
    ...overrides,
  };
}

function measuredBudget(used: number, total: number, endsInMs: number) {
  return {
    measured: true,
    used,
    total,
    window: { starts_at_ms: NOW_MS - HOUR_MS, ends_at_ms: NOW_MS + endsInMs },
  };
}

function recommend(
  candidates: RecommendRouteCandidate[],
  overrides: Partial<RecommendRouteInput> = {},
) {
  return recommendRoute({
    task: { required_capabilities: ["code"], privacy: "network_ok", locality: "any" },
    candidates,
    top_n: candidates.length,
    ...overrides,
  });
}

function order(result: ReturnType<typeof recommendRoute>): string[] {
  return result.ranked.map((entry) => entry.candidate_id);
}

test("a full pool near reset outranks a better-scored unmeasured candidate — but only under the objective", () => {
  const candidates = [
    // Better default score: measured outcomes lift it above the plain candidates.
    candidate("favored-unmeasured", {
      observed_outcomes: { successes: 9, failures: 0 },
    }),
    // 90% remaining, window ends within the horizon: the pool that would waste its capacity.
    candidate("full-pool-near-reset", {
      budget: measuredBudget(10, 100, 2 * HOUR_MS),
    }),
  ];

  const byDefault = recommend(candidates);
  assert.deepEqual(
    order(byDefault),
    ["favored-unmeasured", "full-pool-near-reset"],
    "control: without the objective the better-scored candidate must stay first",
  );

  const byObjective = recommend(candidates, {
    preference: { objective: "exhaust_before_reset", now_ms: NOW_MS },
  });
  assert.deepEqual(
    order(byObjective),
    ["full-pool-near-reset", "favored-unmeasured"],
    "under exhaust_before_reset, measured remaining capacity near reset must lead",
  );
  assert.equal(byObjective.preference?.objective, "exhaust_before_reset");
  assert.equal(byObjective.preference?.evidence_only, true);
});

test("among measured candidates, more remaining capacity closer to reset ranks first", () => {
  const result = recommend(
    [
      candidate("nearly-spent", { budget: measuredBudget(90, 100, 2 * HOUR_MS) }),
      candidate("untouched", { budget: measuredBudget(0, 100, 2 * HOUR_MS) }),
      candidate("half-spent", { budget: measuredBudget(50, 100, 2 * HOUR_MS) }),
    ],
    { preference: { objective: "exhaust_before_reset", now_ms: NOW_MS } },
  );
  assert.deepEqual(order(result), ["untouched", "half-spent", "nearly-spent"]);
});

test("unmeasured candidates keep their default relative order and never gain urgency", () => {
  const unmeasuredPair = [
    candidate("plain-b"),
    candidate("plain-a", { observed_outcomes: { successes: 5, failures: 0 } }),
  ];
  const control = recommend(unmeasuredPair);
  const underObjective = recommend(unmeasuredPair, {
    preference: { objective: "exhaust_before_reset", now_ms: NOW_MS },
  });
  assert.deepEqual(
    order(underObjective),
    order(control),
    "with no measured window anywhere, the objective must change nothing",
  );
  for (const entry of underObjective.ranked) {
    assert.equal(entry.components.reset_urgency, 0, `${entry.candidate_id} must carry zero urgency`);
  }
});

test("a stale window is not current evidence and earns no promotion", () => {
  const result = recommend(
    [
      candidate("better-fit", { observed_outcomes: { successes: 9, failures: 0 } }),
      candidate("stale-window", {
        budget: {
          measured: true,
          used: 0,
          total: 100,
          // Ended before now: last rotation's measurement, however full it looked.
          window: { starts_at_ms: NOW_MS - 10 * HOUR_MS, ends_at_ms: NOW_MS - HOUR_MS },
        },
      }),
    ],
    { preference: { objective: "exhaust_before_reset", now_ms: NOW_MS } },
  );
  assert.deepEqual(order(result), ["better-fit", "stale-window"]);
  const stale = result.ranked.find((entry) => entry.candidate_id === "stale-window");
  assert.ok(stale?.reason_codes.includes("RESET_WINDOW_NOT_CURRENT"));
});

test("measured exhaustion still excludes; the objective never resurrects an empty pool", () => {
  const result = recommend(
    [
      candidate("empty-pool", { budget: measuredBudget(100, 100, 2 * HOUR_MS) }),
      candidate("plain"),
    ],
    { preference: { objective: "exhaust_before_reset", now_ms: NOW_MS } },
  );
  assert.deepEqual(order(result), ["plain"]);
  assert.deepEqual(result.excluded, [
    { candidate_id: "empty-pool", reason_codes: ["BUDGET_EXHAUSTED"] },
  ]);
});

test("prefer_near_reset stays a tie-break: a better final score still wins outright", () => {
  const result = recommend(
    [
      candidate("better-score-unmeasured", {
        observed_outcomes: { successes: 9, failures: 0 },
      }),
      candidate("urgent-pool", { budget: measuredBudget(10, 100, 2 * HOUR_MS) }),
    ],
    { preference: { objective: "prefer_near_reset", now_ms: NOW_MS } },
  );
  assert.deepEqual(
    order(result),
    ["better-score-unmeasured", "urgent-pool"],
    "the pre-existing objective must keep its post-score tie-break semantics exactly",
  );
});
