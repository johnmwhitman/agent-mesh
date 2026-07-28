import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRouteCandidates } from "../src/route-candidate-validation.js";

const valid = {
  candidate_id: "lane-a",
  capabilities: ["code"],
  privacy: "network_ok",
  locality: "any",
  budget: { measured: false },
};

test("assertRouteCandidates accepts a closed candidate and custom error context", () => {
  assert.doesNotThrow(() =>
    assertRouteCandidates([valid], {
      errorPrefix: "compile_route_candidates",
      path: "manifest.candidates",
    }),
  );

  assert.throws(
    () =>
      assertRouteCandidates([{ ...valid, provider: "forbidden" }], {
        errorPrefix: "compile_route_candidates",
        path: "manifest.candidates",
      }),
    /compile_route_candidates: 'manifest\.candidates\[0\]\.provider' is not allowed/,
  );
});

test("assertRouteCandidates rejects invalid closed candidate snapshots", () => {
  const cases: Array<{
    name: string;
    value: unknown;
    expected: RegExp;
  }> = [
    {
      name: "empty arrays",
      value: [],
      expected: /'manifest\.candidates' must be an array with 1\.\.256 items/,
    },
    {
      name: "arrays longer than 256 items",
      value: Array.from({ length: 257 }, (_, index) => ({
        ...valid,
        candidate_id: `lane-${index}`,
      })),
      expected: /'manifest\.candidates' must be an array with 1\.\.256 items/,
    },
    {
      name: "duplicate candidate ids",
      value: [valid, { ...valid }],
      expected:
        /'manifest\.candidates\[1\]\.candidate_id' is a duplicate candidate_id 'lane-a'/,
    },
    {
      name: "invalid capability tokens",
      value: [{ ...valid, capabilities: ["Code"] }],
      expected:
        /'manifest\.candidates\[0\]\.capabilities\[0\]' must be a lowercase capability or policy token/,
    },
    {
      name: "invalid privacy",
      value: [{ ...valid, privacy: "public" }],
      expected:
        /'manifest\.candidates\[0\]\.privacy' must be local_only, network_ok, or unrestricted/,
    },
    {
      name: "invalid locality",
      value: [{ ...valid, locality: "remote" }],
      expected:
        /'manifest\.candidates\[0\]\.locality' must be same_host, same_fleet, or any/,
    },
    {
      name: "invalid coordination modes",
      value: [{ ...valid, coordination_modes: ["group"] }],
      expected:
        /'manifest\.candidates\[0\]\.coordination_modes\[0\]' must be solo or pair_discussion/,
    },
    {
      name: "non-finite context windows",
      value: [{ ...valid, context_window: Number.POSITIVE_INFINITY }],
      expected:
        /'manifest\.candidates\[0\]\.context_window' must be a finite integer between 0 and /,
    },
    {
      name: "malformed outcomes",
      value: [{ ...valid, observed_outcomes: { successes: 1 } }],
      expected:
        /'manifest\.candidates\[0\]\.observed_outcomes\.failures' must be a finite integer between 0 and 1000000/,
    },
    {
      name: "measured budgets without usage",
      value: [{ ...valid, budget: { measured: true, total: 10 } }],
      expected:
        /'manifest\.candidates\[0\]\.budget\.used' must be a finite number >= 0/,
    },
    {
      name: "unmeasured budgets with usage",
      value: [{ ...valid, budget: { measured: false, used: 0 } }],
      expected:
        /'manifest\.candidates\[0\]\.budget' must omit used and total when measured is false/,
    },
    {
      name: "empty requested identities",
      value: [{ ...valid, requested_identity: {} }],
      expected:
        /'manifest\.candidates\[0\]\.requested_identity' must name at least one of runtime or model/,
    },
    {
      name: "requested identities with empty unknown keys",
      value: [
        {
          ...valid,
          requested_identity: { runtime: "x", "": "smuggled" },
        },
      ],
      expected:
        /'manifest\.candidates\[0\]\.requested_identity\.' is not allowed/,
    },
    {
      name: "observed identities without a source",
      value: [{ ...valid, observed_identity: { runtime: "opencode" } }],
      expected:
        /'manifest\.candidates\[0\]\.observed_identity\.source' must be a non-empty string no longer than 256 characters/,
    },
    {
      name: "observed identities with empty unknown keys",
      value: [
        {
          ...valid,
          observed_identity: { runtime: "x", source: "receipt", "": "smuggled" },
        },
      ],
      expected:
        /'manifest\.candidates\[0\]\.observed_identity\.' is not allowed/,
    },
  ];

  for (const { name, value, expected } of cases) {
    assert.throws(
      () =>
        assertRouteCandidates(value, {
          errorPrefix: "compile_route_candidates",
          path: "manifest.candidates",
        }),
      expected,
      name,
    );
  }
});
