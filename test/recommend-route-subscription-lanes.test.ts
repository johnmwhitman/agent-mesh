import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  recommendRoute,
  type RecommendRouteCandidate,
  type RecommendRouteTask,
} from "../src/recommend-route.js";

interface SubscriptionLaneCorpus {
  corpus_version: "v0.1";
  claims: {
    provider_availability: false;
    authenticated_identity: false;
    budget_freshness: false;
    persisted: false;
    executed: false;
    authorized: false;
    woke_agents: false;
    contacted_providers: false;
  };
  candidate_templates: RecommendRouteCandidate[];
  cases: Array<{
    id: string;
    task: RecommendRouteTask;
    expected_ranked: string[];
  }>;
}

const corpus: SubscriptionLaneCorpus = JSON.parse(
  readFileSync("test/fixtures/routing/subscription-lanes/v0.1/corpus.json", "utf8"),
);

const effectFlags = {
  persisted: false,
  executed: false,
  authorized: false,
  woke_agents: false,
  contacted_providers: false,
} as const;

function routeCase(fixture: SubscriptionLaneCorpus["cases"][number], candidates = corpus.candidate_templates) {
  return recommendRoute({
    task: fixture.task,
    candidates,
    top_n: candidates.length,
  });
}

test("subscription-lane corpus ranks opaque candidates by requested task-fit tokens", () => {
  for (const fixture of corpus.cases) {
    const result = recommendRoute({
      task: fixture.task,
      candidates: corpus.candidate_templates,
      top_n: corpus.candidate_templates.length,
    });
    assert.deepEqual(
      result.ranked.map(({ candidate_id }) => candidate_id),
      fixture.expected_ranked,
      fixture.id,
    );
  }
});

test("subscription-lane requested identity strings do not affect rank or score components", () => {
  const identityReplaced = structuredClone(corpus);
  for (const candidate of identityReplaced.candidate_templates) {
    candidate.requested_identity = {
      runtime: "redacted-runtime",
      model: "redacted-model",
    };
  }

  for (const fixture of corpus.cases) {
    const original = routeCase(fixture);
    const redacted = routeCase(fixture, identityReplaced.candidate_templates);
    assert.deepEqual(
      redacted.ranked.map(({ components, candidate_id, rank }) => ({
        components,
        candidate_id,
        rank,
      })),
      original.ranked.map(({ components, candidate_id, rank }) => ({
        components,
        candidate_id,
        rank,
      })),
      fixture.id,
    );
  }
});

test("subscription-lane corpus makes only explicit false non-effect claims", () => {
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
    assert.deepEqual(routeCase(fixture).effects, effectFlags, fixture.id);
  }
});

test("subscription-lane corpus inputs are immutable and repeated results are deterministic", () => {
  const input = {
    task: corpus.cases[1]!.task,
    candidates: corpus.candidate_templates,
    top_n: corpus.candidate_templates.length,
  };
  const before = structuredClone(input);
  const first = recommendRoute(input);
  const second = recommendRoute(input);

  assert.deepEqual(input, before);
  assert.deepEqual(second, first);
});

test("subscription-lane measured healthy budget remains neutral before candidate id tie-break", () => {
  const result = recommendRoute({
    task: {
      required_capabilities: ["code"],
      privacy: "network_ok",
      locality: "any",
    },
    candidates: [
      {
        candidate_id: "z-unmeasured",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
        budget: { measured: false },
      },
      {
        candidate_id: "a-measured-healthy",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
        budget: { measured: true, used: 1, total: 100 },
      },
    ],
    top_n: 2,
  });

  assert.deepEqual(
    result.ranked.map(({ candidate_id }) => candidate_id),
    ["a-measured-healthy", "z-unmeasured"],
  );
  assert.deepEqual(
    result.ranked[0]!.components,
    result.ranked[1]!.components,
  );
});
