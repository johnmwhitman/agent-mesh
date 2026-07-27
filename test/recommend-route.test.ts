import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recommendRoute,
  type RecommendRouteCandidate,
  type RecommendRouteTask,
} from "../src/recommend-route.js";

const baseTask: RecommendRouteTask = {
  required_capabilities: ["code"],
  privacy: "network_ok",
  locality: "same_fleet",
  policy_tags: ["no_train"],
  min_context_tokens: 8_000,
};

const baseCandidate: RecommendRouteCandidate = {
  candidate_id: "candidate",
  capabilities: ["code"],
  privacy: "local_only",
  locality: "same_host",
  policy_tags: ["no_train"],
  context_window: 16_000,
  budget: { measured: false },
};

test("recommendRoute excludes every hard-constraint mismatch before ranking", () => {
  const cases: Array<{
    name: string;
    candidate: RecommendRouteCandidate;
    expected: string;
  }> = [
    {
      name: "privacy",
      candidate: { ...baseCandidate, privacy: "unrestricted" },
      expected: "PRIVACY_MISMATCH",
    },
    {
      name: "locality",
      candidate: { ...baseCandidate, locality: "any" },
      expected: "LOCALITY_MISMATCH",
    },
    {
      name: "policy",
      candidate: { ...baseCandidate, policy_tags: [] },
      expected: "POLICY_MISMATCH",
    },
    {
      name: "capability",
      candidate: { ...baseCandidate, capabilities: ["review"] },
      expected: "CAPABILITY_MISSING",
    },
    {
      name: "context",
      candidate: { ...baseCandidate, context_window: 4_000 },
      expected: "CONTEXT_INSUFFICIENT",
    },
  ];

  for (const fixture of cases) {
    const result = recommendRoute({
      task: baseTask,
      candidates: [fixture.candidate],
    });
    assert.deepEqual(result.ranked, [], `${fixture.name} mismatch must not rank`);
    assert.deepEqual(result.excluded, [
      {
        candidate_id: "candidate",
        reason_codes: [fixture.expected],
      },
    ]);
  }
});

test("recommendRoute keeps unknown budget neutral and never rewards spare budget", () => {
  const result = recommendRoute({
    task: {
      required_capabilities: ["code"],
      optional_capabilities: ["review"],
      privacy: "network_ok",
      locality: "any",
    },
    candidates: [
      {
        candidate_id: "better-fit-unmeasured",
        capabilities: ["code", "review"],
        privacy: "network_ok",
        locality: "any",
        budget: { measured: false },
      },
      {
        candidate_id: "lower-fit-idle",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
        budget: { measured: true, used: 0, total: 100 },
      },
    ],
    top_n: 2,
  });

  assert.deepEqual(
    result.ranked.map((candidate) => candidate.candidate_id),
    ["better-fit-unmeasured", "lower-fit-idle"],
  );
  assert.deepEqual(
    result.ranked.map((candidate) => ({
      budget_adjustment: (
        candidate as unknown as {
          components?: { budget_adjustment?: number };
        }
      ).components?.budget_adjustment,
      budget_status: (
        candidate as unknown as {
          budget?: { status?: string };
        }
      ).budget?.status,
    })),
    [
      { budget_adjustment: 1, budget_status: "unmeasured" },
      { budget_adjustment: 1, budget_status: "healthy" },
    ],
  );
});

test("recommendRoute explicitly excludes an exhausted measured budget", () => {
  const result = recommendRoute({
    task: {
      required_capabilities: ["code"],
      privacy: "network_ok",
      locality: "any",
    },
    candidates: [
      {
        candidate_id: "exhausted",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
        observed_outcomes: { successes: 100, failures: 0 },
        budget: { measured: true, used: 100, total: 100 },
      },
      {
        candidate_id: "available",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
        budget: { measured: false },
      },
    ],
    top_n: 2,
  });

  assert.deepEqual(
    result.ranked.map((candidate) => candidate.candidate_id),
    ["available"],
  );
  assert.deepEqual(result.excluded, [
    {
      candidate_id: "exhausted",
      reason_codes: ["BUDGET_EXHAUSTED"],
    },
  ]);
});

test("recommendRoute budget evidence only demotes, and over-budget lanes stay excluded", () => {
  const result = recommendRoute({
    task: {
      required_capabilities: ["code"],
      privacy: "network_ok",
      locality: "any",
    },
    candidates: [
      {
        candidate_id: "a-unmeasured",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
        budget: { measured: false },
      },
      {
        candidate_id: "b-healthy",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
        budget: { measured: true, used: 1, total: 100 },
      },
      {
        candidate_id: "c-tapered",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
        budget: { measured: true, used: 70, total: 100 },
      },
      {
        candidate_id: "d-constrained",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
        budget: { measured: true, used: 80, total: 100 },
      },
      {
        candidate_id: "e-over-budget",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
        budget: { measured: true, used: 101, total: 100 },
      },
    ],
    top_n: 5,
  });

  assert.deepEqual(
    result.ranked.map((candidate) => [
      candidate.candidate_id,
      candidate.components.budget_adjustment,
    ]),
    [
      ["a-unmeasured", 1],
      ["b-healthy", 1],
      ["c-tapered", 0.75],
      ["d-constrained", 0.5],
    ],
  );
  assert.deepEqual(result.excluded, [
    {
      candidate_id: "e-over-budget",
      reason_codes: ["BUDGET_EXHAUSTED"],
    },
  ]);
});

test("recommendRoute outcome evidence is bounded, neutral when balanced, and monotonic", () => {
  const result = recommendRoute({
    task: {
      required_capabilities: ["code"],
      privacy: "network_ok",
      locality: "any",
    },
    candidates: [
      {
        candidate_id: "balanced",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
        observed_outcomes: { successes: 4, failures: 4 },
      },
      {
        candidate_id: "all-failure",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
        observed_outcomes: { successes: 0, failures: 4 },
      },
      {
        candidate_id: "all-success",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
        observed_outcomes: { successes: 4, failures: 0 },
      },
    ],
    top_n: 3,
  });

  assert.deepEqual(
    result.ranked.map((candidate) => [
      candidate.candidate_id,
      candidate.components.observed_outcomes,
    ]),
    [
      ["all-success", 1.25],
      ["balanced", 1],
      ["all-failure", 0.75],
    ],
  );
});

test("recommendRoute is deterministic and does not mutate its caller snapshot", () => {
  const input = {
    task: {
      required_capabilities: ["code"],
      privacy: "network_ok" as const,
      locality: "any" as const,
    },
    candidates: [
      {
        candidate_id: "z-lane",
        capabilities: ["code"],
        privacy: "network_ok" as const,
        locality: "any" as const,
      },
      {
        candidate_id: "a-lane",
        capabilities: ["code"],
        privacy: "network_ok" as const,
        locality: "any" as const,
      },
    ],
    top_n: 1,
  };
  const before = structuredClone(input);

  const first = recommendRoute(input);
  const second = recommendRoute(input);

  assert.deepEqual(input, before);
  assert.deepEqual(second, first);
  assert.deepEqual(
    first.ranked.map((candidate) => [candidate.rank, candidate.candidate_id]),
    [[1, "a-lane"]],
  );
});

test("recommendRoute rejects ambiguous or non-finite snapshots", () => {
  const valid = {
    task: {
      required_capabilities: ["code"],
      privacy: "network_ok" as const,
      locality: "any" as const,
    },
    candidates: [
      {
        candidate_id: "candidate",
        capabilities: ["code"],
        privacy: "network_ok" as const,
        locality: "any" as const,
        budget: { measured: false },
      },
    ],
  };

  const cases: Array<{ name: string; input: unknown; expected: RegExp }> = [
    {
      name: "zero top_n",
      input: { ...valid, top_n: 0 },
      expected: /top_n/,
    },
    {
      name: "required capability repeated as optional",
      input: {
        ...valid,
        task: {
          ...valid.task,
          optional_capabilities: ["code"],
        },
      },
      expected: /optional_capabilities.*required_capabilities/,
    },
    {
      name: "incomplete measured budget",
      input: {
        ...valid,
        candidates: [{ ...valid.candidates[0], budget: { measured: true, used: 1 } }],
      },
      expected: /total/,
    },
    {
      name: "unmeasured budget carrying fabricated totals",
      input: {
        ...valid,
        candidates: [
          {
            ...valid.candidates[0],
            budget: { measured: false, used: 0, total: 100 },
          },
        ],
      },
      expected: /omit used and total/,
    },
    {
      name: "non-finite outcome evidence",
      input: {
        ...valid,
        candidates: [
          {
            ...valid.candidates[0],
            observed_outcomes: { successes: Number.NaN, failures: 0 },
          },
        ],
      },
      expected: /successes/,
    },
    {
      name: "unbounded outcome evidence",
      input: {
        ...valid,
        candidates: [
          {
            ...valid.candidates[0],
            observed_outcomes: { successes: 1_000_001, failures: 0 },
          },
        ],
      },
      expected: /successes.*1000000/,
    },
    {
      name: "duplicate candidate id",
      input: {
        ...valid,
        candidates: [valid.candidates[0], { ...valid.candidates[0] }],
      },
      expected: /duplicate.*candidate_id/i,
    },
  ];

  for (const fixture of cases) {
    assert.throws(
      () => recommendRoute(fixture.input as Parameters<typeof recommendRoute>[0]),
      fixture.expected,
      fixture.name,
    );
  }
});

test("recommendRoute reports requested and observed execution identity without scoring it", () => {
  const result = recommendRoute({
    task: {
      required_capabilities: ["code"],
      privacy: "network_ok",
      locality: "any",
    },
    candidates: [
      {
        candidate_id: "z-mismatch",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
        budget: { measured: false },
        requested_identity: { runtime: "opencode", model: "kimi-k3" },
        observed_identity: {
          runtime: "opencode",
          model: "fallback-model",
          source: "runtime-receipt",
        },
      },
      {
        candidate_id: "a-match",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
        budget: { measured: false },
        requested_identity: { runtime: "opencode", model: "kimi-k3" },
        observed_identity: {
          runtime: "opencode",
          model: "kimi-k3",
          source: "runtime-receipt",
        },
      },
    ],
    top_n: 2,
  } as unknown as Parameters<typeof recommendRoute>[0]);

  assert.deepEqual(
    result.ranked.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      final_score: candidate.components.final_score,
      identity_evidence_only: candidate.identity.evidence_only,
      identity_status: candidate.identity.status,
    })),
    [
      {
        candidate_id: "a-match",
        final_score: 1,
        identity_evidence_only: true,
        identity_status: "claim_match",
      },
      {
        candidate_id: "z-mismatch",
        final_score: 1,
        identity_evidence_only: true,
        identity_status: "claim_mismatch",
      },
    ],
  );
});

test("recommendRoute treats pair discussion as an explicit capability without waking", () => {
  const result = recommendRoute({
    task: {
      required_capabilities: ["review"],
      privacy: "network_ok",
      locality: "same_fleet",
      coordination: "pair_discussion",
    },
    candidates: [
      {
        candidate_id: "solo-only",
        capabilities: ["review"],
        privacy: "network_ok",
        locality: "same_fleet",
        coordination_modes: ["solo"],
        budget: { measured: false },
      },
      {
        candidate_id: "pair-capable",
        capabilities: ["review"],
        privacy: "network_ok",
        locality: "same_fleet",
        coordination_modes: ["solo", "pair_discussion"],
        budget: { measured: false },
      },
    ],
    top_n: 2,
  } as unknown as Parameters<typeof recommendRoute>[0]);

  assert.deepEqual(
    result.ranked.map((candidate) => candidate.candidate_id),
    ["pair-capable"],
  );
  assert.deepEqual(result.excluded, [
    {
      candidate_id: "solo-only",
      reason_codes: ["COORDINATION_MISMATCH"],
    },
  ]);
});
