import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileRouteCandidates,
  ROUTE_CANDIDATE_COMPILER_VERSION,
} from "../src/compile-route-candidates.js";
import {
  compileFleetBudgetObservations,
  FLEETBUDGET_SNAPSHOT_VERSION,
} from "../src/fleetbudget-observations.js";
import {
  recommendRoute,
  type RecommendRouteCandidate,
  type RecommendRouteInput,
} from "../src/recommend-route.js";

const WEEK_MS = 604_800_000;
const NOW_MS = 1_800_000_000_000;

function candidate(
  candidate_id: string,
  overrides: Partial<RecommendRouteCandidate> = {},
): RecommendRouteCandidate {
  return {
    candidate_id,
    capabilities: ["code"],
    privacy: "network_ok",
    locality: "any",
    budget: { measured: true, used: 10, total: 100 },
    ...overrides,
  };
}

function recommend(
  candidates: RecommendRouteCandidate[],
  overrides: Partial<RecommendRouteInput> = {},
) {
  return recommendRoute({
    task: {
      required_capabilities: ["code"],
      privacy: "network_ok",
      locality: "any",
    },
    candidates,
    top_n: candidates.length,
    ...overrides,
  });
}

test("near-reset preference is opt-in and the default remains byte- and rank-compatible", () => {
  const withoutWindows = [
    candidate("a-far"),
    candidate("z-near"),
  ];
  const withWindows = [
    candidate("a-far", {
      budget: {
        measured: true,
        used: 10,
        total: 100,
        window: {
          starts_at_ms: NOW_MS - WEEK_MS,
          ends_at_ms: NOW_MS + 6 * 24 * 60 * 60 * 1_000,
        },
      },
    }),
    candidate("z-near", {
      budget: {
        measured: true,
        used: 10,
        total: 100,
        window: {
          starts_at_ms: NOW_MS - WEEK_MS,
          ends_at_ms: NOW_MS + 24 * 60 * 60 * 1_000,
        },
      },
    }),
  ];

  const baseline = recommend(withoutWindows);
  const defaultWithWindows = recommend(withWindows);

  assert.equal(JSON.stringify(defaultWithWindows), JSON.stringify(baseline));
  assert.deepEqual(
    defaultWithWindows.ranked.map(({ candidate_id }) => candidate_id),
    ["a-far", "z-near"],
  );
  assert.equal("preference" in defaultWithWindows, false);
  for (const ranked of defaultWithWindows.ranked) {
    assert.equal("reset_urgency" in ranked.components, false);
  }
});

test("near-reset preference breaks equal-score ties without changing final_score or budget_adjustment", () => {
  const result = recommend(
    [
      candidate("a-far", {
        budget: {
          measured: true,
          used: 10,
          total: 100,
          window: {
            starts_at_ms: NOW_MS - WEEK_MS,
            ends_at_ms: NOW_MS + 6 * 24 * 60 * 60 * 1_000,
          },
        },
      }),
      candidate("z-near", {
        budget: {
          measured: true,
          used: 10,
          total: 100,
          window: {
            starts_at_ms: NOW_MS - WEEK_MS,
            ends_at_ms: NOW_MS + 24 * 60 * 60 * 1_000,
          },
        },
      }),
    ],
    {
      preference: { objective: "prefer_near_reset", now_ms: NOW_MS },
    } as Partial<RecommendRouteInput>,
  );

  assert.deepEqual(result.preference, {
    objective: "prefer_near_reset",
    now_ms: NOW_MS,
    horizon_ms: WEEK_MS,
    evidence_only: true,
  });
  assert.deepEqual(
    result.ranked.map(({ candidate_id }) => candidate_id),
    ["z-near", "a-far"],
  );
  assert.deepEqual(
    result.ranked.map(({ components }) => ({
      final_score: components.final_score,
      budget_adjustment: components.budget_adjustment,
    })),
    [
      { final_score: 1, budget_adjustment: 1 },
      { final_score: 1, budget_adjustment: 1 },
    ],
  );
  assert.ok(
    result.ranked[0]!.components.reset_urgency! >
      result.ranked[1]!.components.reset_urgency!,
  );
  assert.ok(result.ranked[0]!.reason_codes.includes("RESET_WINDOW_CURRENT"));
});

test("a higher existing final_score dominates reset urgency", () => {
  const result = recommend(
    [
      candidate("a-high-score-far", {
        observed_outcomes: { successes: 4, failures: 0 },
        budget: {
          measured: true,
          used: 10,
          total: 100,
          window: {
            starts_at_ms: NOW_MS - WEEK_MS,
            ends_at_ms: NOW_MS + WEEK_MS,
          },
        },
      }),
      candidate("z-lower-score-near", {
        budget: {
          measured: true,
          used: 10,
          total: 100,
          window: {
            starts_at_ms: NOW_MS - WEEK_MS,
            ends_at_ms: NOW_MS,
          },
        },
      }),
    ],
    {
      preference: { objective: "prefer_near_reset", now_ms: NOW_MS },
    } as Partial<RecommendRouteInput>,
  );

  assert.deepEqual(
    result.ranked.map(({ candidate_id }) => candidate_id),
    ["a-high-score-far", "z-lower-score-near"],
  );
  assert.equal(result.ranked[0]!.components.final_score, 1.25);
  assert.equal(result.ranked[1]!.components.final_score, 1);
});

test("privacy and measured exhaustion remain hard gates before urgency", () => {
  const result = recommend(
    [
      candidate("privacy-mismatch", {
        privacy: "unrestricted",
        budget: {
          measured: true,
          used: 0,
          total: 100,
          window: {
            starts_at_ms: NOW_MS - 1,
            ends_at_ms: NOW_MS,
          },
        },
      }),
      candidate("exhausted", {
        budget: {
          measured: true,
          used: 100,
          total: 100,
          window: {
            starts_at_ms: NOW_MS - 1,
            ends_at_ms: NOW_MS,
          },
        },
      }),
      candidate("eligible", { budget: { measured: false } }),
    ],
    {
      task: {
        required_capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
      },
      preference: { objective: "prefer_near_reset", now_ms: NOW_MS },
    } as Partial<RecommendRouteInput>,
  );

  assert.deepEqual(result.ranked.map(({ candidate_id }) => candidate_id), ["eligible"]);
  assert.deepEqual(result.excluded, [
    { candidate_id: "privacy-mismatch", reason_codes: ["PRIVACY_MISMATCH"] },
    { candidate_id: "exhausted", reason_codes: ["BUDGET_EXHAUSTED"] },
  ]);
});

test("every declared hard constraint remains ahead of the opt-in tie-break", () => {
  const currentWindow = {
    starts_at_ms: NOW_MS - 1,
    ends_at_ms: NOW_MS,
  };
  const highUrgencyBudget = {
    measured: true as const,
    used: 0,
    total: 100,
    window: currentWindow,
  };
  const result = recommendRoute({
    task: {
      required_capabilities: ["code"],
      privacy: "local_only",
      locality: "same_host",
      coordination: "pair_discussion",
      policy_tags: ["no_train"],
      min_context_tokens: 8_000,
    },
    candidates: [
      candidate("privacy", {
        privacy: "network_ok",
        locality: "same_host",
        coordination_modes: ["pair_discussion"],
        policy_tags: ["no_train"],
        context_window: 16_000,
        budget: highUrgencyBudget,
      }),
      candidate("locality", {
        privacy: "local_only",
        locality: "any",
        coordination_modes: ["pair_discussion"],
        policy_tags: ["no_train"],
        context_window: 16_000,
        budget: highUrgencyBudget,
      }),
      candidate("policy", {
        privacy: "local_only",
        locality: "same_host",
        coordination_modes: ["pair_discussion"],
        policy_tags: [],
        context_window: 16_000,
        budget: highUrgencyBudget,
      }),
      candidate("capability", {
        capabilities: ["review"],
        privacy: "local_only",
        locality: "same_host",
        coordination_modes: ["pair_discussion"],
        policy_tags: ["no_train"],
        context_window: 16_000,
        budget: highUrgencyBudget,
      }),
      candidate("coordination", {
        privacy: "local_only",
        locality: "same_host",
        coordination_modes: ["solo"],
        policy_tags: ["no_train"],
        context_window: 16_000,
        budget: highUrgencyBudget,
      }),
      candidate("context", {
        privacy: "local_only",
        locality: "same_host",
        coordination_modes: ["pair_discussion"],
        policy_tags: ["no_train"],
        context_window: 4_000,
        budget: highUrgencyBudget,
      }),
      candidate("eligible", {
        privacy: "local_only",
        locality: "same_host",
        coordination_modes: ["pair_discussion"],
        policy_tags: ["no_train"],
        context_window: 16_000,
        budget: { measured: false },
      }),
    ],
    top_n: 7,
    preference: { objective: "prefer_near_reset", now_ms: NOW_MS },
  });

  assert.deepEqual(result.ranked.map(({ candidate_id }) => candidate_id), ["eligible"]);
  assert.deepEqual(result.excluded, [
    { candidate_id: "privacy", reason_codes: ["PRIVACY_MISMATCH"] },
    { candidate_id: "locality", reason_codes: ["LOCALITY_MISMATCH"] },
    { candidate_id: "policy", reason_codes: ["POLICY_MISMATCH"] },
    { candidate_id: "capability", reason_codes: ["CAPABILITY_MISSING"] },
    { candidate_id: "coordination", reason_codes: ["COORDINATION_MISMATCH"] },
    { candidate_id: "context", reason_codes: ["CONTEXT_INSUFFICIENT"] },
  ]);
});

test("urgency is neutral for unmeasured, missing, and non-current evidence", () => {
  const result = recommend(
    [
      candidate("unmeasured", { budget: { measured: false } }),
      candidate("missing-window"),
      candidate("stale-window", {
        budget: {
          measured: true,
          used: 10,
          total: 100,
          window: {
            starts_at_ms: NOW_MS - 2,
            ends_at_ms: NOW_MS - 1,
          },
        },
      }),
      candidate("future-window", {
        budget: {
          measured: true,
          used: 10,
          total: 100,
          window: {
            starts_at_ms: NOW_MS + 1,
            ends_at_ms: NOW_MS + 2,
          },
        },
      }),
    ],
    {
      preference: { objective: "prefer_near_reset", now_ms: NOW_MS },
    } as Partial<RecommendRouteInput>,
  );

  assert.deepEqual(
    result.ranked.map(({ candidate_id, components }) => [
      candidate_id,
      components.reset_urgency,
    ]),
    [
      ["future-window", 0],
      ["missing-window", 0],
      ["stale-window", 0],
      ["unmeasured", 0],
    ],
  );
  const reasons = Object.fromEntries(
    result.ranked.map(({ candidate_id, reason_codes }) => [candidate_id, reason_codes]),
  );
  assert.ok(reasons["unmeasured"]!.includes("RESET_BUDGET_UNMEASURED"));
  assert.ok(reasons["missing-window"]!.includes("RESET_WINDOW_MISSING"));
  assert.ok(reasons["stale-window"]!.includes("RESET_WINDOW_NOT_CURRENT"));
  assert.ok(reasons["future-window"]!.includes("RESET_WINDOW_NOT_CURRENT"));
});

test("current-window and one-week horizon boundaries are closed and clamped", () => {
  const oneMsInsideHorizon = candidate("one-ms-inside", {
    budget: {
      measured: true,
      used: 25,
      total: 100,
      window: {
        starts_at_ms: NOW_MS,
        ends_at_ms: NOW_MS + WEEK_MS - 1,
      },
    },
  });
  const exactHorizon = candidate("exact-horizon", {
    budget: {
      measured: true,
      used: 25,
      total: 100,
      window: {
        starts_at_ms: NOW_MS,
        ends_at_ms: NOW_MS + WEEK_MS,
      },
    },
  });
  const atEnd = candidate("at-end", {
    budget: {
      measured: true,
      used: 25,
      total: 100,
      window: {
        starts_at_ms: NOW_MS - 1,
        ends_at_ms: NOW_MS,
      },
    },
  });

  const result = recommend(
    [exactHorizon, oneMsInsideHorizon, atEnd],
    {
      preference: { objective: "prefer_near_reset", now_ms: NOW_MS },
    } as Partial<RecommendRouteInput>,
  );
  const byId = Object.fromEntries(
    result.ranked.map(({ candidate_id, components }) => [
      candidate_id,
      components.reset_urgency,
    ]),
  );

  assert.equal(byId["at-end"], 0.75);
  assert.equal(byId["exact-horizon"], 0);
  assert.ok(byId["one-ms-inside"]! > 0);
  assert.ok(byId["one-ms-inside"]! < 1 / WEEK_MS);
});

test("preference and window ingress are closed, safe-integer, and measured-only", () => {
  const validCandidates = [candidate("candidate")];
  const cases: Array<{ name: string; input: unknown; expected: RegExp }> = [
    {
      name: "unknown preference key",
      input: {
        task: {
          required_capabilities: ["code"],
          privacy: "network_ok",
          locality: "any",
        },
        candidates: validCandidates,
        preference: {
          objective: "prefer_near_reset",
          now_ms: NOW_MS,
          provider: "forbidden",
        },
      },
      expected: /preference\.provider/,
    },
    {
      name: "unknown objective",
      input: {
        task: {
          required_capabilities: ["code"],
          privacy: "network_ok",
          locality: "any",
        },
        candidates: validCandidates,
        preference: { objective: "drain", now_ms: NOW_MS },
      },
      expected: /preference\.objective/,
    },
    {
      name: "unsafe now",
      input: {
        task: {
          required_capabilities: ["code"],
          privacy: "network_ok",
          locality: "any",
        },
        candidates: validCandidates,
        preference: {
          objective: "prefer_near_reset",
          now_ms: Number.MAX_SAFE_INTEGER + 1,
        },
      },
      expected: /preference\.now_ms/,
    },
    {
      name: "window on unmeasured budget",
      input: {
        task: {
          required_capabilities: ["code"],
          privacy: "network_ok",
          locality: "any",
        },
        candidates: [
          candidate("candidate", {
            budget: {
              measured: false,
              window: { starts_at_ms: 0, ends_at_ms: 1 },
            },
          }),
        ],
      },
      expected: /must omit used and total, and window/,
    },
    {
      name: "unknown window key",
      input: {
        task: {
          required_capabilities: ["code"],
          privacy: "network_ok",
          locality: "any",
        },
        candidates: [
          candidate("candidate", {
            budget: {
              measured: true,
              used: 1,
              total: 2,
              window: {
                starts_at_ms: 0,
                ends_at_ms: 1,
                id: "forbidden",
              },
            },
          }),
        ],
      },
      expected: /budget\.window\.id/,
    },
    {
      name: "window end before start",
      input: {
        task: {
          required_capabilities: ["code"],
          privacy: "network_ok",
          locality: "any",
        },
        candidates: [
          candidate("candidate", {
            budget: {
              measured: true,
              used: 1,
              total: 2,
              window: { starts_at_ms: 2, ends_at_ms: 1 },
            },
          }),
        ],
      },
      expected: /window\.ends_at_ms.*greater than starts_at_ms/,
    },
  ];

  for (const fixture of cases) {
    assert.throws(
      () => recommendRoute(fixture.input as RecommendRouteInput),
      fixture.expected,
      fixture.name,
    );
  }
});

test("opt-in recommendation remains deterministic, immutable, identity-independent, and effect-free", () => {
  const input = {
    task: {
      required_capabilities: ["code"],
      privacy: "network_ok" as const,
      locality: "any" as const,
    },
    candidates: [
      candidate("a", {
        requested_identity: { runtime: "opaque-a", model: "opaque-a" },
        observed_identity: {
          runtime: "opaque-a",
          model: "opaque-a",
          source: "caller-evidence-a",
        },
        budget: {
          measured: true,
          used: 10,
          total: 100,
          window: {
            starts_at_ms: NOW_MS - 1,
            ends_at_ms: NOW_MS + 1,
          },
        },
      }),
      candidate("b", {
        requested_identity: { runtime: "opaque-b", model: "opaque-b" },
        budget: {
          measured: true,
          used: 10,
          total: 100,
          window: {
            starts_at_ms: NOW_MS - 1,
            ends_at_ms: NOW_MS + 1,
          },
        },
      }),
    ],
    top_n: 2,
    preference: { objective: "prefer_near_reset" as const, now_ms: NOW_MS },
  };
  const changedIdentity = structuredClone(input);
  changedIdentity.candidates[0]!.requested_identity = {
    runtime: "totally-different",
    model: "totally-different",
  };
  changedIdentity.candidates[0]!.observed_identity = {
    runtime: "mismatch",
    model: "mismatch",
    source: "different-caller-evidence",
  };
  const before = structuredClone(input);

  const first = recommendRoute(input);
  const second = recommendRoute(input);
  const identityChanged = recommendRoute(changedIdentity);

  assert.deepEqual(input, before);
  assert.deepEqual(second, first);
  assert.deepEqual(
    identityChanged.ranked.map(({ candidate_id, rank, components, reason_codes }) => ({
      candidate_id,
      rank,
      components,
      reason_codes,
    })),
    first.ranked.map(({ candidate_id, rank, components, reason_codes }) => ({
      candidate_id,
      rank,
      components,
      reason_codes,
    })),
  );
  assert.deepEqual(first.effects, {
    persisted: false,
    executed: false,
    authorized: false,
    woke_agents: false,
    contacted_providers: false,
  });
});

test("validated FleetBudget windows copy unsplit through compiler budget evidence", () => {
  const sharedWindow = {
    id: "weekly-pool",
    starts_at_ms: NOW_MS - 1_000,
    ends_at_ms: NOW_MS + 1_000,
  };
  const observationInput = {
    snapshot: {
      version: FLEETBUDGET_SNAPSHOT_VERSION,
      observed_at_ms: NOW_MS - 100,
      expires_at_ms: NOW_MS + 100,
      lanes: [
        {
          lane_id: "shared-lane",
          measured: true,
          used: 20,
          total: 100,
          unit: "tokens",
          window: sharedWindow,
        },
      ],
    },
    bindings: [
      { candidate_id: "candidate-b", lane_id: "shared-lane" },
      { candidate_id: "candidate-a", lane_id: "shared-lane" },
    ],
    now_ms: NOW_MS,
  };
  const before = structuredClone(observationInput);
  const projected = compileFleetBudgetObservations(observationInput);

  assert.deepEqual(observationInput, before);
  assert.deepEqual(
    projected.observations.map(({ candidate_id, budget }) => ({
      candidate_id,
      budget,
    })),
    [
      {
        candidate_id: "candidate-a",
        budget: {
          used: 20,
          total: 100,
          window: {
            starts_at_ms: sharedWindow.starts_at_ms,
            ends_at_ms: sharedWindow.ends_at_ms,
          },
        },
      },
      {
        candidate_id: "candidate-b",
        budget: {
          used: 20,
          total: 100,
          window: {
            starts_at_ms: sharedWindow.starts_at_ms,
            ends_at_ms: sharedWindow.ends_at_ms,
          },
        },
      },
    ],
  );
  assert.equal(
    "id" in (projected.observations[0]!.budget!.window as unknown as Record<string, unknown>),
    false,
  );
  assert.notEqual(
    projected.observations[0]!.budget!.window,
    projected.observations[1]!.budget!.window,
    "FleetBudget projection must copy shared window evidence per candidate",
  );

  const compiled = compileRouteCandidates({
    manifest: {
      version: ROUTE_CANDIDATE_COMPILER_VERSION,
      candidates: [
        {
          candidate_id: "candidate-a",
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
      ],
    },
    observations: projected.observations,
  });

  assert.deepEqual(
    compiled.candidates.map(({ budget }) => budget),
    [
      {
        measured: true,
        used: 20,
        total: 100,
        window: {
          starts_at_ms: sharedWindow.starts_at_ms,
          ends_at_ms: sharedWindow.ends_at_ms,
        },
      },
      {
        measured: true,
        used: 20,
        total: 100,
        window: {
          starts_at_ms: sharedWindow.starts_at_ms,
          ends_at_ms: sharedWindow.ends_at_ms,
        },
      },
    ],
  );
  assert.notEqual(
    compiled.candidates[0]!.budget!.window,
    compiled.candidates[1]!.budget!.window,
    "shared-window evidence must be copied, never aliased or split",
  );
});
