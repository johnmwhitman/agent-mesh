import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileRouteCandidates,
  ROUTE_CANDIDATE_COMPILER_VERSION,
} from "../src/compile-route-candidates.js";
import type {
  CompileRouteCandidateObservation,
  CompileRouteCandidatesInput,
} from "../src/compile-route-candidates.js";
import { recommendRoute } from "../src/recommend-route.js";

type Corpus = {
  corpus_version: string;
  claims: Record<string, false>;
  manifest: { version: string; candidates: unknown[] };
  cases: Array<{
    id: string;
    input: { observations?: unknown[] };
    expected_candidates: unknown[];
    expected_diagnostics: unknown[];
  }>;
};

const corpus: Corpus = JSON.parse(
  readFileSync("test/fixtures/routing/route-candidate-snapshots/v0.1/corpus.json", "utf8"),
);

const effects = {
  persisted: false,
  executed: false,
  authorized: false,
  woke_agents: false,
  contacted_providers: false,
} as const;

test("exports the route candidate observation contract", () => {
  const observation: CompileRouteCandidateObservation = {
    candidate_id: "lane-a",
    status: "green",
    confidence: "measured",
    budget: { used: 1, total: 2 },
  };

  assert.equal(observation.candidate_id, "lane-a");
});

// `Corpus` describes the on-disk JSON loosely on purpose — the mutation test below
// rewrites candidate and observation rows through `Record<string, unknown>`. The
// compiler's parameter type is exact, so the crossing point is asserted once, here,
// rather than at every call. No value the tests feed changes.
function corpusInput(fixture: Corpus["cases"][number]): CompileRouteCandidatesInput {
  return { manifest: corpus.manifest, ...fixture.input } as unknown as CompileRouteCandidatesInput;
}

test("route-candidate snapshot corpus deterministically projects neutral and measured evidence", () => {
  assert.equal(corpus.corpus_version, ROUTE_CANDIDATE_COMPILER_VERSION);
  assert.deepEqual(corpus.claims, {
    provider_availability: false,
    authenticated_identity: false,
    budget_freshness: false,
    persisted: false,
    executed: false,
    authorized: false,
    woke_agents: false,
    contacted_providers: false,
  });

  for (const fixture of corpus.cases) {
    const input = corpusInput(fixture);
    const before = structuredClone(input);
    const first = compileRouteCandidates(input);
    const second = compileRouteCandidates(structuredClone(input));

    assert.deepEqual(first, second, fixture.id);
    assert.deepEqual(input, before, fixture.id);
    assert.equal(first.compiler_version, ROUTE_CANDIDATE_COMPILER_VERSION, fixture.id);
    assert.equal(first.projection, true, fixture.id);
    assert.deepEqual(first.effects, effects, fixture.id);
    assert.deepEqual(first.candidates, fixture.expected_candidates, fixture.id);
    assert.deepEqual(first.diagnostics, fixture.expected_diagnostics, fixture.id);
    assert.deepEqual(
      first.candidates.map(({ candidate_id }) => candidate_id),
      ["lane-a", "lane-b", "lane-c"],
      fixture.id,
    );
  }
});

test("exact measured exhaustion reaches the evaluator rather than becoming a compiler exclusion", () => {
  const fixture = corpus.cases.find(({ id }) => id === "exact-exhaustion-is-evidence")!;
  const compiled = compileRouteCandidates(corpusInput(fixture));
  const result = recommendRoute({
    task: {
      required_capabilities: ["code"],
      privacy: "network_ok",
      locality: "any",
    },
    candidates: compiled.candidates,
    top_n: compiled.candidates.length,
  });

  assert.deepEqual(result.excluded, [
    { candidate_id: "lane-c", reason_codes: ["BUDGET_EXHAUSTED"] },
  ]);
  assert.deepEqual(
    compiled.diagnostics.find(({ candidate_id }) => candidate_id === "lane-c"),
    { candidate_id: "lane-c", reason_codes: ["BUDGET_EXHAUSTED_EVIDENCE"] },
  );
});

test("identity observations are evidence-only and cannot replace manifest traits", () => {
  const fixture = corpus.cases.find(({ id }) => id === "measured-evidence-copies-exactly")!;
  const originalInput = corpusInput(fixture);
  const identityReplaced = structuredClone(originalInput);
  identityReplaced.manifest.candidates[0] = {
    ...identityReplaced.manifest.candidates[0]!,
    requested_identity: { runtime: "redacted-requested", model: "redacted-requested-model" },
  };
  identityReplaced.observations![0] = {
    ...identityReplaced.observations![0]!,
    observed_identity: {
      runtime: "redacted-observed",
      model: "redacted-observed-model",
      source: "redacted-source",
    },
  };

  const original = compileRouteCandidates(originalInput);
  const replaced = compileRouteCandidates(identityReplaced);
  assert.deepEqual(
    replaced.candidates.map(({ requested_identity, observed_identity, ...candidate }) => candidate),
    original.candidates.map(({ requested_identity, observed_identity, ...candidate }) => candidate),
  );

  const task = { required_capabilities: ["code"], privacy: "network_ok" as const, locality: "any" as const };
  const originalRoute = recommendRoute({ task, candidates: original.candidates, top_n: 3 });
  const replacedRoute = recommendRoute({ task, candidates: replaced.candidates, top_n: 3 });
  assert.deepEqual(
    replacedRoute.ranked.map(({ candidate_id, rank, components }) => ({ candidate_id, rank, components })),
    originalRoute.ranked.map(({ candidate_id, rank, components }) => ({ candidate_id, rank, components })),
  );
});

test("compiler rejects closed ingress and contradictory observations with deterministic first paths", () => {
  const valid = {
    manifest: {
      version: ROUTE_CANDIDATE_COMPILER_VERSION,
      candidates: [{ candidate_id: "lane-a", capabilities: ["code"], privacy: "network_ok", locality: "any" }],
    },
  };
  const cases: Array<{ name: string; input: unknown; expected: RegExp }> = [
    { name: "unknown input", input: { ...valid, provider: "x" }, expected: /compile_route_candidates: 'input\.provider' is not allowed/ },
    { name: "unknown manifest", input: { manifest: { ...valid.manifest, endpoint: "x" } }, expected: /'manifest\.endpoint' is not allowed/ },
    { name: "unknown candidate", input: { manifest: { ...valid.manifest, candidates: [{ ...valid.manifest.candidates[0], provider: "x" }] } }, expected: /'manifest\.candidates\[0\]\.provider' is not allowed/ },
    { name: "unknown requested identity", input: { manifest: { ...valid.manifest, candidates: [{ ...valid.manifest.candidates[0], requested_identity: { runtime: "x", authorization: "x" } }] } }, expected: /'manifest\.candidates\[0\]\.requested_identity\.authorization' is not allowed/ },
    { name: "empty unknown requested identity key", input: { manifest: { ...valid.manifest, candidates: [{ ...valid.manifest.candidates[0], requested_identity: { runtime: "x", "": "x" } }] } }, expected: /'manifest\.candidates\[0\]\.requested_identity\.' is not allowed/ },
    { name: "wrong version", input: { manifest: { ...valid.manifest, version: "v0" } }, expected: /'manifest\.version' must equal meshfleet\.route-candidates\.v0\.1/ },
    { name: "empty manifest", input: { manifest: { ...valid.manifest, candidates: [] } }, expected: /'manifest\.candidates' must be an array with 1\.\.256 items/ },
    { name: "oversized manifest", input: { manifest: { ...valid.manifest, candidates: Array.from({ length: 257 }, (_, index) => ({ ...valid.manifest.candidates[0], candidate_id: `lane-${index}` })) } }, expected: /'manifest\.candidates' must be an array with 1\.\.256 items/ },
    { name: "malformed candidate id", input: { manifest: { ...valid.manifest, candidates: [{ ...valid.manifest.candidates[0], candidate_id: "" }] } }, expected: /'manifest\.candidates\[0\]\.candidate_id' must be a non-empty string no longer than 128 characters/ },
    { name: "duplicate candidate id", input: { manifest: { ...valid.manifest, candidates: [valid.manifest.candidates[0], valid.manifest.candidates[0]] } }, expected: /'manifest\.candidates\[1\]\.candidate_id' is a duplicate candidate_id 'lane-a'/ },
    { name: "earlier static trait failure precedes a later candidate unknown field", input: { manifest: { ...valid.manifest, candidates: [{ ...valid.manifest.candidates[0], capabilities: [] }, { ...valid.manifest.candidates[0], candidate_id: "lane-b", provider: "x" }] } }, expected: /'manifest\.candidates\[0\]\.capabilities' must be an array with 1\.\.64 items/ },
    { name: "malformed observation candidate id", input: { ...valid, observations: [{ candidate_id: "", status: "green", confidence: "assumed" }] }, expected: /'observations\[0\]\.candidate_id' must be a non-empty string no longer than 128 characters/ },
    { name: "malformed observation status", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "unknown", confidence: "assumed" }] }, expected: /'observations\[0\]\.status' must be green, degraded, exhausted, or unconfigured/ },
    { name: "malformed observation confidence", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "claimed" }] }, expected: /'observations\[0\]\.confidence' must be measured or assumed/ },
    { name: "too many observations", input: { ...valid, observations: Array.from({ length: 257 }, () => ({ candidate_id: "lane-a", status: "green", confidence: "assumed" })) }, expected: /'observations' must be an array with 0\.\.256 items/ },
    { name: "unknown observation", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", provider: "x" }] }, expected: /'observations\[0\]\.provider' is not allowed/ },
    { name: "unknown budget", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", budget: { used: 1, total: 2, quota: 3 } }] }, expected: /'observations\[0\]\.budget\.quota' is not allowed/ },
    { name: "empty unknown budget key", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", budget: { used: 1, total: 2, "": 3 } }] }, expected: /'observations\[0\]\.budget\.' is not allowed/ },
    { name: "unknown budget window", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", budget: { used: 1, total: 2, window: { starts_at_ms: 0, ends_at_ms: 1, id: "forbidden" } } }] }, expected: /'observations\[0\]\.budget\.window\.id' is not allowed/ },
    { name: "unsafe budget window start", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", budget: { used: 1, total: 2, window: { starts_at_ms: Number.MAX_SAFE_INTEGER + 1, ends_at_ms: Number.MAX_SAFE_INTEGER } } }] }, expected: /'observations\[0\]\.budget\.window\.starts_at_ms' must be a finite integer/ },
    { name: "reversed budget window", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", budget: { used: 1, total: 2, window: { starts_at_ms: 2, ends_at_ms: 1 } } }] }, expected: /'observations\[0\]\.budget\.window\.ends_at_ms' must be greater than starts_at_ms/ },
    { name: "unknown outcomes", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", observed_outcomes: { successes: 1, failures: 0, executions: 1 } }] }, expected: /'observations\[0\]\.observed_outcomes\.executions' is not allowed/ },
    { name: "empty unknown outcomes key", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", observed_outcomes: { successes: 1, failures: 0, "": 1 } }] }, expected: /'observations\[0\]\.observed_outcomes\.' is not allowed/ },
    { name: "non-integral outcomes", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", observed_outcomes: { successes: 1.5, failures: 0 } }] }, expected: /'observations\[0\]\.observed_outcomes\.successes' must be a finite integer between 0 and 1000000/ },
    { name: "outcomes above bound", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", observed_outcomes: { successes: 1000001, failures: 0 } }] }, expected: /'observations\[0\]\.observed_outcomes\.successes' must be a finite integer between 0 and 1000000/ },
    { name: "non-finite outcomes", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", observed_outcomes: { successes: Number.NaN, failures: 0 } }] }, expected: /'observations\[0\]\.observed_outcomes\.successes' must be a finite integer between 0 and 1000000/ },
    { name: "unknown observed identity", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", observed_identity: { runtime: "x", source: "x", availability: "x" } }] }, expected: /'observations\[0\]\.observed_identity\.availability' is not allowed/ },
    { name: "empty unknown observed identity key", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", observed_identity: { runtime: "x", source: "x", "": "x" } }] }, expected: /'observations\[0\]\.observed_identity\.' is not allowed/ },
    { name: "duplicate observation", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "assumed" }, { candidate_id: "lane-a", status: "green", confidence: "assumed" }] }, expected: /'observations\[1\]\.candidate_id' is a duplicate candidate_id 'lane-a'/ },
    { name: "unknown observation candidate", input: { ...valid, observations: [{ candidate_id: "lane-z", status: "green", confidence: "assumed" }] }, expected: /'observations\[0\]\.candidate_id' is not present in manifest\.candidates/ },
    { name: "unconfigured", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "unconfigured", confidence: "assumed" }] }, expected: /'observations\[0\]\.status' must not be unconfigured for a manifest candidate/ },
    { name: "assumed budget", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "assumed", budget: { used: 1, total: 2 } }] }, expected: /'observations\[0\]' must omit budget, observed_outcomes, and observed_identity when confidence is assumed/ },
    { name: "assumed exhaustion", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "exhausted", confidence: "assumed" }] }, expected: /'observations\[0\]\.status' must not be exhausted when confidence is assumed/ },
    { name: "negative budget", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", budget: { used: -1, total: 1 } }] }, expected: /'observations\[0\]\.budget\.used' must be a finite number >= 0/ },
    { name: "non-finite budget used", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", budget: { used: Number.NaN, total: 1 } }] }, expected: /'observations\[0\]\.budget\.used' must be a finite number >= 0/ },
    { name: "infinite budget used", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", budget: { used: Number.POSITIVE_INFINITY, total: 1 } }] }, expected: /'observations\[0\]\.budget\.used' must be a finite number >= 0/ },
    { name: "non-positive total", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", budget: { used: 0, total: 0 } }] }, expected: /'observations\[0\]\.budget\.total' must be a finite number > 0/ },
    { name: "non-finite total", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", budget: { used: 0, total: Number.NaN } }] }, expected: /'observations\[0\]\.budget\.total' must be a finite number > 0/ },
    { name: "infinite total", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", budget: { used: 0, total: Number.POSITIVE_INFINITY } }] }, expected: /'observations\[0\]\.budget\.total' must be a finite number > 0/ },
    { name: "missing measured budget total", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", budget: { used: 0 } }] }, expected: /'observations\[0\]\.budget\.total' must be a finite number > 0/ },
    { name: "measured exhaustion without budget", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "exhausted", confidence: "measured" }] }, expected: /'observations\[0\]\.status' requires measured budget used >= total/ },
    { name: "unproven measured exhaustion", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "exhausted", confidence: "measured", budget: { used: 1, total: 2 } }] }, expected: /'observations\[0\]\.status' requires measured budget used >= total/ },
    { name: "contradictory green exhaustion", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "green", confidence: "measured", budget: { used: 2, total: 2 } }] }, expected: /'observations\[0\]\.status' must be exhausted when measured budget used >= total/ },
    { name: "contradictory degraded exhaustion", input: { ...valid, observations: [{ candidate_id: "lane-a", status: "degraded", confidence: "measured", budget: { used: 2, total: 2 } }] }, expected: /'observations\[0\]\.status' must be exhausted when measured budget used >= total/ },
  ];

  for (const { name, input, expected } of cases) {
    assert.throws(() => compileRouteCandidates(input as never), expected, name);
  }
});
