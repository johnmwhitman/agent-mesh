import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchAndRecommendRoutePlaneCatalog,
  normalizeRoutePlaneCatalog,
  recommendRoutePlaneCatalog,
} from "../src/routeplane-catalog.js";
import { recommendRoute, type RecommendRouteInput } from "../src/recommend-route.js";

const now = 1_700_000_000_000;
const hour = 3_600_000;
const payload = {
  object: "list",
  data: ["a-later", "z-sooner"].map((id) => ({ id, object: "model", providers: ["provider"] })),
};
const effects = {
  persisted: false, executed: false, authorized: false, woke_agents: false, contacted_providers: false,
};

function fixture(soonerUsed = 70) {
  return {
    snapshot: normalizeRoutePlaneCatalog(payload, now, 60_000),
    policies: payload.data.map(({ id }) => ({
      candidate_id: id, model: id, capabilities: ["code"],
      privacy: "network_ok" as const, locality: "any" as const,
    })),
    task: { required_capabilities: ["code"], privacy: "network_ok" as const, locality: "any" as const },
    observations: payload.data.map(({ id }) => ({
      candidate_id: id,
      status: id === "z-sooner" && soonerUsed >= 100 ? "exhausted" as const : "green" as const,
      confidence: "measured" as const,
      budget: {
        used: id === "z-sooner" ? soonerUsed : 10,
        total: 100,
        window: { starts_at_ms: now - hour, ends_at_ms: now + (id === "z-sooner" ? hour : 144 * hour) },
      },
    })),
    now_ms: now,
    top_n: 2,
  };
}

function preferred(soonerUsed = 70, objective: NonNullable<RecommendRouteInput["preference"]>["objective"] = "exhaust_before_reset") {
  return { ...fixture(soonerUsed), preference: { objective, now_ms: now } };
}

test("catalog preference changes ranking only according to the explicit reset objective", () => {
  const input = preferred();
  const before = structuredClone(input);
  assert.equal(recommendRoutePlaneCatalog(fixture()).ranked[0]!.candidate_id, "a-later");
  const exhaustion = recommendRoutePlaneCatalog(input);
  assert.equal(exhaustion.ranked[0]!.candidate_id, "z-sooner");
  assert.equal(recommendRoutePlaneCatalog(preferred(70, "prefer_near_reset")).ranked[0]!.candidate_id, "a-later");
  assert.equal(recommendRoutePlaneCatalog(preferred(10, "prefer_near_reset")).ranked[0]!.candidate_id, "z-sooner");
  assert.deepEqual(exhaustion.preference, recommendRoute({
    task: input.task, candidates: input.policies.map(({candidate_id, capabilities, privacy, locality}) => ({candidate_id, capabilities, privacy, locality})), preference: input.preference,
  }).preference, "receipt preserves the evaluator objective, clock and horizon");
  assert.equal("preference" in recommendRoutePlaneCatalog(fixture()), false);
  assert.deepEqual(exhaustion.effects, effects);
  assert.deepEqual(input, before);
});

test("catalog reset preference cannot promote expired or unmeasured budgets", () => {
  const expired = preferred(10);
  expired.observations[1]!.budget.window.ends_at_ms = now - 1;
  const result = recommendRoutePlaneCatalog(expired);
  assert.equal(result.ranked[0]!.candidate_id, "a-later");
  assert.ok(result.ranked[1]!.reason_codes.includes("RESET_WINDOW_NOT_CURRENT"));
  const unmeasured = preferred(10);
  unmeasured.observations = unmeasured.observations.slice(0, 1);
  const unknown = recommendRoutePlaneCatalog(unmeasured);
  assert.equal(unknown.ranked[0]!.candidate_id, "a-later");
  assert.ok(unknown.ranked[1]!.reason_codes.includes("RESET_BUDGET_UNMEASURED"));
});

test("catalog reset preference preserves exhaustion and capability exclusions", () => {
  const exhausted = recommendRoutePlaneCatalog(preferred(100));
  assert.deepEqual(exhausted.ranked.map(({ candidate_id }) => candidate_id), ["a-later"]);
  assert.deepEqual(exhausted.excluded, [{ candidate_id: "z-sooner", reason_codes: ["BUDGET_EXHAUSTED"] }]);
  const incapable = preferred(10);
  incapable.policies[1]!.capabilities = ["text"];
  const result = recommendRoutePlaneCatalog(incapable);
  assert.deepEqual(result.ranked.map(({ candidate_id }) => candidate_id), ["a-later"]);
  assert.deepEqual(result.excluded, [{ candidate_id: "z-sooner", reason_codes: ["CAPABILITY_MISSING"] }]);
});

test("catalog preference is validated even when no candidates compile", () => {
  const empty = { ...fixture(), policies: [], observations: [] };
  const invalidPreferences: Array<{ value: unknown; path: string }> = [
    { value: null, path: "preference" },
    { value: [], path: "preference" },
    { value: {}, path: "preference.objective" },
    { value: { objective: "automatic", now_ms: now }, path: "preference.objective" },
    { value: { objective: "prefer_near_reset" }, path: "preference.now_ms" },
    ...[NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, "now"].map((now_ms) => ({
      value: { objective: "prefer_near_reset", now_ms }, path: "preference.now_ms",
    })),
    { value: { objective: "prefer_near_reset", now_ms: now, execute: true }, path: "preference.execute" },
  ];
  for (const base of [fixture(), empty]) {
    for (const { value, path } of invalidPreferences) {
      assert.throws(
        () => recommendRoutePlaneCatalog({ ...base, preference: value } as never),
        (error: unknown) => error instanceof Error && error.message.includes(`recommend_route: '${path}'`),
      );
    }
  }
  for (const objective of ["prefer_near_reset", "exhaust_before_reset"] as const) {
    const result = recommendRoutePlaneCatalog({ ...empty, preference: { objective, now_ms: now } });
    assert.equal(result.status, "no_compiled_candidates");
    assert.equal("preference" in result, false, "no evaluator ran for an empty compilation");
    assert.deepEqual(result.ranked, []);
    assert.deepEqual(result.effects, effects);
  }
});

test("explicit loopback catalog refresh passes through reset preference", async () => {
  const { snapshot: _snapshot, ...input } = preferred();
  let calls = 0;
  const result = await fetchAndRecommendRoutePlaneCatalog({
    ...input,
    // The fetch uses wall time; the explicit recommendation clock must match its snapshot.
    now_ms: undefined,
    fetch_options: { fetch_impl: async (url, options) => {
      calls += 1;
      assert.equal(url, "http://127.0.0.1:4356/v1/models");
      assert.equal(options?.redirect, "error");
      return Response.json(payload);
    } },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.preference, recommendRoute({
    task: input.task, candidates: input.policies.map(({candidate_id, capabilities, privacy, locality}) => ({candidate_id, capabilities, privacy, locality})), preference: input.preference,
  }).preference);
  assert.equal(result.ranked[0]!.candidate_id, "z-sooner");
  assert.deepEqual(result.effects, effects);
});
