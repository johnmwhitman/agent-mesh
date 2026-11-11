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
        /'manifest\.candidates\[0\]\.budget' must omit used and total, and window when measured is false/,
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

test("assertRouteCandidates rejects candidates with missing required fields", () => {
  const missingCases: Array<{
    name: string;
    candidate: unknown;
    expected: RegExp;
  }> = [
    {
      name: "missing candidate_id key",
      candidate: {
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
      },
      expected:
        /compile_route_candidates: 'manifest\.candidates\[0\]\.candidate_id' must be a non-empty string no longer than 128 characters/,
    },
    {
      name: "empty string candidate_id",
      candidate: {
        candidate_id: "",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
      },
      expected:
        /compile_route_candidates: 'manifest\.candidates\[0\]\.candidate_id' must be a non-empty string no longer than 128 characters/,
    },
    {
      name: "whitespace-only candidate_id",
      candidate: {
        candidate_id: "   ",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
      },
      expected:
        /compile_route_candidates: 'manifest\.candidates\[0\]\.candidate_id' must be a non-empty string no longer than 128 characters/,
    },
    {
      name: "non-string candidate_id",
      candidate: {
        candidate_id: 123,
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
      },
      expected:
        /compile_route_candidates: 'manifest\.candidates\[0\]\.candidate_id' must be a non-empty string no longer than 128 characters/,
    },
    {
      name: "missing capabilities key",
      candidate: {
        candidate_id: "lane-a",
        privacy: "network_ok",
        locality: "any",
      },
      expected:
        /compile_route_candidates: 'manifest\.candidates\[0\]\.capabilities' must be an array with 1\.\.64 items/,
    },
    {
      name: "empty capabilities array",
      candidate: {
        candidate_id: "lane-a",
        capabilities: [],
        privacy: "network_ok",
        locality: "any",
      },
      expected:
        /compile_route_candidates: 'manifest\.candidates\[0\]\.capabilities' must be an array with 1\.\.64 items/,
    },
    {
      name: "non-array capabilities",
      candidate: {
        candidate_id: "lane-a",
        capabilities: "code",
        privacy: "network_ok",
        locality: "any",
      },
      expected:
        /compile_route_candidates: 'manifest\.candidates\[0\]\.capabilities' must be an array with 1\.\.64 items/,
    },
    {
      name: "missing privacy key",
      candidate: {
        candidate_id: "lane-a",
        capabilities: ["code"],
        locality: "any",
      },
      expected:
        /compile_route_candidates: 'manifest\.candidates\[0\]\.privacy' must be local_only, network_ok, or unrestricted/,
    },
    {
      name: "null privacy value",
      candidate: {
        candidate_id: "lane-a",
        capabilities: ["code"],
        privacy: null,
        locality: "any",
      },
      expected:
        /compile_route_candidates: 'manifest\.candidates\[0\]\.privacy' must be local_only, network_ok, or unrestricted/,
    },
    {
      name: "missing locality key",
      candidate: {
        candidate_id: "lane-a",
        capabilities: ["code"],
        privacy: "network_ok",
      },
      expected:
        /compile_route_candidates: 'manifest\.candidates\[0\]\.locality' must be same_host, same_fleet, or any/,
    },
    {
      name: "null locality value",
      candidate: {
        candidate_id: "lane-a",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: null,
      },
      expected:
        /compile_route_candidates: 'manifest\.candidates\[0\]\.locality' must be same_host, same_fleet, or any/,
    },
    {
      name: "non-object candidate (null)",
      candidate: null,
      expected:
        /compile_route_candidates: 'manifest\.candidates\[0\]' must be an object/,
    },
    {
      name: "non-object candidate (primitive string)",
      candidate: "invalid-candidate",
      expected:
        /compile_route_candidates: 'manifest\.candidates\[0\]' must be an object/,
    },
  ];

  for (const { name, candidate, expected } of missingCases) {
    assert.throws(
      () =>
        assertRouteCandidates([candidate], {
          errorPrefix: "compile_route_candidates",
          path: "manifest.candidates",
        }),
      expected,
      name,
    );
  }

  // Missing fields on non-first candidate reports correct path index
  assert.throws(
    () =>
      assertRouteCandidates(
        [
          valid,
          {
            candidate_id: "lane-b",
            capabilities: ["code"],
            privacy: "network_ok",
          },
        ],
        {
          errorPrefix: "compile_route_candidates",
          path: "manifest.candidates",
        },
      ),
    /compile_route_candidates: 'manifest\.candidates\[1\]\.locality' must be same_host, same_fleet, or any/,
  );
});

test("assertRouteCandidates rejects empty candidate list edge cases", () => {
  // Empty array
  assert.throws(
    () =>
      assertRouteCandidates([], {
        errorPrefix: "custom_prefix",
        path: "candidates",
      }),
    /custom_prefix: 'candidates' must be an array with 1\.\.256 items/,
  );

  // Non-array empty or null inputs
  assert.throws(
    () =>
      assertRouteCandidates(null, {
        errorPrefix: "custom_prefix",
        path: "candidates",
      }),
    /custom_prefix: 'candidates' must be an array with 1\.\.256 items/,
  );

  assert.throws(
    () =>
      assertRouteCandidates(undefined, {
        errorPrefix: "custom_prefix",
        path: "candidates",
      }),
    /custom_prefix: 'candidates' must be an array with 1\.\.256 items/,
  );

  assert.throws(
    () =>
      assertRouteCandidates({}, {
        errorPrefix: "custom_prefix",
        path: "candidates",
      }),
    /custom_prefix: 'candidates' must be an array with 1\.\.256 items/,
  );
});

test("assertRouteCandidates rejects duplicate candidate ids across various positions", () => {
  // Adjacent duplicates
  assert.throws(
    () =>
      assertRouteCandidates([valid, { ...valid }], {
        errorPrefix: "route_test",
        path: "payload.candidates",
      }),
    /route_test: 'payload\.candidates\[1\]\.candidate_id' is a duplicate candidate_id 'lane-a'/,
  );

  // Non-adjacent duplicate with other valid candidates in between
  const candidateB = { ...valid, candidate_id: "lane-b" };
  const candidateC = { ...valid, candidate_id: "lane-c" };
  const candidateADup = { ...valid, candidate_id: "lane-a" };

  assert.throws(
    () =>
      assertRouteCandidates([valid, candidateB, candidateC, candidateADup], {
        errorPrefix: "route_test",
        path: "payload.candidates",
      }),
    /route_test: 'payload\.candidates\[3\]\.candidate_id' is a duplicate candidate_id 'lane-a'/,
  );

  // Multiple duplicates reports the first duplicate encountered in iteration order
  const candidateBDup = { ...valid, candidate_id: "lane-b" };
  assert.throws(
    () =>
      assertRouteCandidates([valid, candidateB, candidateBDup, candidateADup], {
        errorPrefix: "route_test",
        path: "payload.candidates",
      }),
    /route_test: 'payload\.candidates\[2\]\.candidate_id' is a duplicate candidate_id 'lane-b'/,
  );
});
