import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  compileWeeklyDrainReview,
  WEEKLY_DRAIN_REVIEW_VERSION,
} from "../src/weekly-drain-review.js";
import { normalizeRoutePlaneCatalog } from "../src/routeplane-catalog.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  exports: Record<string, string>;
};

test("exports the weekly drain review as a package library subpath", () => {
  assert.equal(
    packageJson.exports["./weekly-drain-review"],
    "./dist/weekly-drain-review.js",
  );
});

const NOW_MS = 1_800_000_000_000;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function wrapperUsage(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "fleet.wrapper-usage-summary/v1",
    window: { start_ms: NOW_MS - 60_000, end_ms: NOW_MS },
    source: { bytes: 0, lines: 0, sha256: EMPTY_SHA256 },
    effect_flags: {
      logging_activated: false,
      meshfleet_projected: false,
      provider_calls_made: false,
      provider_identity_inferred: false,
      quota_or_balance_inferred: false,
      routing_or_scheduling_changed: false,
      source_modified: false,
      unused_quota_rewarded: false,
    },
    rejections: {
      duplicate_begin: 0,
      duplicate_finish: 0,
      invalid_event_invariant: 0,
      invalid_field_set: 0,
      invalid_field_type: 0,
      invalid_field_value: 0,
      invalid_json: 0,
      invalid_schema_version: 0,
      non_canonical_json: 0,
      non_object_json: 0,
      orphan_finish: 0,
      pair_mismatch: 0,
    },
    groups: [],
    ...overrides,
  };
}

function weeklyInput(overrides: Record<string, unknown> = {}) {
  return {
    version: WEEKLY_DRAIN_REVIEW_VERSION,
    now_ms: NOW_MS,
    routeplane: {
      snapshot: normalizeRoutePlaneCatalog({
        object: "list",
        data: [{ id: "model-a", object: "model", providers: ["provider-a"] }],
      }, NOW_MS - 1_000, 2_000),
      policies: [{
        candidate_id: "candidate-a",
        model: "model-a",
        capabilities: ["code"],
        privacy: "network_ok",
        locality: "any",
      }],
    },
    fleetbudget: {
      snapshot: {
        version: "meshfleet.fleetbudget-snapshot.v1",
        observed_at_ms: NOW_MS - 1_000,
        expires_at_ms: NOW_MS + 1_000,
        lanes: [{
          lane_id: "shared-lane",
          measured: true,
          used: 10,
          total: 100,
          unit: "requests",
          window: { id: "weekly", starts_at_ms: NOW_MS - 10_000, ends_at_ms: NOW_MS + 10_000 },
        }],
      },
      bindings: [{ candidate_id: "candidate-a", lane_id: "shared-lane" }],
    },
    quality_annotations: [{ candidate_id: "candidate-a", quality_tags: ["reviewed"] }],
    backlog: {
      tasks: [{
        task_id: "task-a",
        kind: "code_review",
        priority: 50,
        speculative_approval: { state: "approved", approval_ref: "john-approval-1" },
        route: { required_capabilities: ["code"], privacy: "network_ok", locality: "any" },
        required_quality_tags: ["reviewed"],
      }],
    },
    wrapper_usage: wrapperUsage(),
    ...overrides,
  };
}

test("preserves annotations for catalog-excluded policies and returns no compiled candidates", () => {
  const source = weeklyInput({
    routeplane: {
      ...weeklyInput().routeplane,
      snapshot: normalizeRoutePlaneCatalog({
        object: "list",
        data: [{ id: "model-b", object: "model", providers: ["provider-b"] }],
      }, NOW_MS - 1_000, 2_000),
    },
  });

  const result = compileWeeklyDrainReview(source);

  assert.equal(result.status, "no_compiled_candidates");
  assert.equal(result.proposal, null);
  assert.deepEqual(result.catalog_compilation.diagnostics, [{
    candidate_id: "candidate-a",
    reason_codes: ["MODEL_NOT_ADVERTISED"],
  }]);
});

test("catalog-empty reviews still validate every backlog task through the planner's closed artifact gates", () => {
  const base = weeklyInput();
  const emptyRouteplane = {
    ...base.routeplane,
    snapshot: normalizeRoutePlaneCatalog({
      object: "list",
      data: [{ id: "model-b", object: "model", providers: ["provider-b"] }],
    }, NOW_MS - 1_000, 2_000),
  };
  const validTask = base.backlog.tasks[0]!;

  assert.throws(() => compileWeeklyDrainReview(weeklyInput({
    routeplane: emptyRouteplane,
    backlog: {
      tasks: [validTask, { ...validTask, task_id: "video-missing-policy", kind: "video_candidate" }],
    },
  })), /tasks\[1\]\.artifact.*required/);

  assert.throws(() => compileWeeklyDrainReview(weeklyInput({
    routeplane: emptyRouteplane,
    backlog: {
      tasks: [validTask, {
        ...validTask,
        task_id: "video-forbidden-material",
        kind: "video_candidate",
        artifact: {
          source_material: "text_only",
          review_scope: "private_review_only",
          human_release_required: true,
          prompt: "forbidden prompt material",
        },
      }],
    },
  })), /tasks\[1\]\.artifact\.prompt/);
});

test("composes supplied catalog, sanitized budget, quality evidence, and approved backlog without effects", () => {
  const source = weeklyInput();
  const before = structuredClone(source);
  const result = compileWeeklyDrainReview(source);

  assert.equal(result.review_version, WEEKLY_DRAIN_REVIEW_VERSION);
  assert.equal(result.status, "evaluated");
  assert.deepEqual(result.proposal?.proposed.map(({ task_id, candidate_ids, reason_codes }) => ({ task_id, candidate_ids, reason_codes })), [{
    task_id: "task-a",
    candidate_ids: ["candidate-a"],
    reason_codes: ["CAPACITY_UNMODELED"],
  }]);
  assert.deepEqual(result.budget.observations, [{
    candidate_id: "candidate-a",
    status: "green",
    confidence: "measured",
    budget: {
      used: 10,
      total: 100,
      window: { starts_at_ms: NOW_MS - 10_000, ends_at_ms: NOW_MS + 10_000 },
    },
  }]);
  assert.deepEqual(result.effects, {
    persisted: false,
    executed: false,
    authorized: false,
    woke_agents: false,
    contacted_providers: false,
    fetched_catalog: false,
    polled: false,
    read_credentials: false,
    inferred_provider: false,
    changed_routing: false,
    allocated_pool: false,
    reserved_capacity: false,
    scheduled: false,
    spent_budget: false,
    sent: false,
    published: false,
    used_external_identity: false,
    claimed_budget_freshness: false,
    claimed_provider_availability: false,
  });
  assert.deepEqual(source, before, "weekly review must not mutate caller input");
});

test("fails closed on stale evidence and on raw-report-shaped input", () => {
  assert.throws(() => compileWeeklyDrainReview(weeklyInput({
    fleetbudget: {
      ...weeklyInput().fleetbudget,
      snapshot: { ...weeklyInput().fleetbudget.snapshot, expires_at_ms: NOW_MS },
    },
  })), /expired/);
  assert.throws(() => compileWeeklyDrainReview(weeklyInput({ report_bytes: "never accepted" })), /report_bytes/);
  assert.throws(() => compileWeeklyDrainReview(weeklyInput({ provider: "never accepted" })), /provider/);
});

test("quality annotation coverage is exact for policy candidates", () => {
  assert.throws(() => compileWeeklyDrainReview(weeklyInput({ quality_annotations: [] })), /missing candidate_id 'candidate-a'/);
  assert.throws(() => compileWeeklyDrainReview(weeklyInput({
    quality_annotations: [
      { candidate_id: "candidate-a", quality_tags: ["reviewed"] },
      { candidate_id: "candidate-a", quality_tags: ["reviewed"] },
    ],
  })), /duplicate candidate_id/);
  assert.throws(() => compileWeeklyDrainReview(weeklyInput({
    quality_annotations: [{ candidate_id: "unknown", quality_tags: ["reviewed"] }],
  })), /not declared by a policy/);
});

test("joins an otherwise valid opaque candidate ID without imposing quality-token grammar", () => {
  const candidateId = "Candidate A";
  const source = weeklyInput({
    routeplane: {
      ...weeklyInput().routeplane,
      policies: [{
        ...weeklyInput().routeplane.policies[0],
        candidate_id: candidateId,
      }],
    },
    fleetbudget: {
      ...weeklyInput().fleetbudget,
      bindings: [{ candidate_id: candidateId, lane_id: "shared-lane" }],
    },
    quality_annotations: [{ candidate_id: candidateId, quality_tags: ["reviewed"] }],
  });

  const result = compileWeeklyDrainReview(source);

  assert.deepEqual(result.proposal?.proposed[0]?.candidate_ids, [candidateId]);
});

test("rejects inherited and accessor-shaped weekly inputs before reading their values", () => {
  const inherited = weeklyInput();
  const inheritedWrapperUsage = inherited.wrapper_usage;
  delete (inherited as { wrapper_usage?: unknown }).wrapper_usage;
  Object.setPrototypeOf(inherited, { wrapper_usage: inheritedWrapperUsage });
  assert.throws(() => compileWeeklyDrainReview(inherited), /input.*plain or null-prototype JSON object/);

  const accessor = weeklyInput();
  let reads = 0;
  Object.defineProperty(accessor, "now_ms", {
    enumerable: true,
    get() {
      reads += 1;
      return NOW_MS;
    },
  });
  assert.throws(() => compileWeeklyDrainReview(accessor), /input\.<non-json-member>/);
  assert.equal(reads, 0);
});

test("preflights nested accessors across every composed source without invoking getters", () => {
  const cases: Array<{
    name: string;
    target: (source: ReturnType<typeof weeklyInput>) => object;
    key: PropertyKey;
  }> = [
    { name: "routeplane snapshot", target: (source) => source.routeplane.snapshot, key: "version" },
    { name: "routeplane policy", target: (source) => source.routeplane.policies[0]!, key: "candidate_id" },
    { name: "fleetbudget snapshot", target: (source) => source.fleetbudget.snapshot, key: "version" },
    { name: "fleetbudget binding", target: (source) => source.fleetbudget.bindings[0]!, key: "candidate_id" },
    { name: "backlog task", target: (source) => source.backlog.tasks[0]!, key: "task_id" },
    { name: "quality annotation", target: (source) => source.quality_annotations[0]!, key: "candidate_id" },
    { name: "quality tag array", target: (source) => source.quality_annotations[0]!.quality_tags, key: "0" },
    { name: "wrapper usage", target: (source) => (source.wrapper_usage as ReturnType<typeof wrapperUsage>).source, key: "bytes" },
  ];

  for (const item of cases) {
    const source = weeklyInput();
    let reads = 0;
    Object.defineProperty(item.target(source), item.key, {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return "poison";
      },
    });
    assert.throws(
      () => compileWeeklyDrainReview(source),
      /<non-json-member>/,
      item.name,
    );
    assert.equal(reads, 0, `${item.name} getter must not run`);
  }
});

test("rejects nested prototype-backed objects and sparse, decorated, or exotic arrays", () => {
  const inherited = weeklyInput();
  let inheritedReads = 0;
  const annotationPrototype = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(annotationPrototype, "candidate_id", {
    enumerable: true,
    get() {
      inheritedReads += 1;
      return "candidate-a";
    },
  });
  const inheritedAnnotation = Object.create(annotationPrototype) as Record<string, unknown>;
  inheritedAnnotation.quality_tags = ["reviewed"];
  inherited.quality_annotations = [inheritedAnnotation as never];
  assert.throws(() => compileWeeklyDrainReview(inherited), /plain or null-prototype JSON object/);
  assert.equal(inheritedReads, 0);

  const sparse = weeklyInput();
  const sparseTasks: unknown[] = [];
  sparseTasks.length = 1;
  sparse.backlog.tasks = sparseTasks as never;
  assert.throws(() => compileWeeklyDrainReview(sparse), /sparse/);

  const decorated = weeklyInput();
  Object.defineProperty(decorated.routeplane.policies, "metadata", {
    enumerable: true,
    value: "not-json-array-shape",
  });
  assert.throws(() => compileWeeklyDrainReview(decorated), /array member/);

  const exotic = weeklyInput();
  Object.setPrototypeOf(exotic.fleetbudget.bindings, null);
  assert.throws(() => compileWeeklyDrainReview(exotic), /ordinary array/);
});

test("validates backlog bounds before a catalog-empty review can suppress planning", () => {
  assert.throws(() => compileWeeklyDrainReview(weeklyInput({
    backlog: { tasks: [], candidate_limit: 9 },
  })), /backlog\.tasks/);
  assert.throws(() => compileWeeklyDrainReview(weeklyInput({
    backlog: { ...weeklyInput().backlog, candidate_limit: 9 },
  })), /backlog\.candidate_limit/);
});

test("wrapper usage stays context-only even when measured durations and outcomes change", () => {
  const baseline = compileWeeklyDrainReview(weeklyInput());
  const contextual = compileWeeklyDrainReview(weeklyInput({
    wrapper_usage: wrapperUsage({
      source: { bytes: 2, lines: 2, sha256: "b".repeat(64) },
      groups: [{
        wrapper: "mmx",
        accounting_lane: "minimax-text",
        requested_service: "minimax-text",
        transport: "direct",
        model_tag: "default",
        success: 1,
        failure: 0,
        incomplete: 0,
        failure_class_counts: {
          auth: 0, empty: 0, interrupted: 0, invalid_request: 0, none: 1,
          protocol: 0, quota: 0, rate_limit: 0, route_unavailable: 0,
          timeout: 0, transport: 0, unknown: 0,
        },
        input_tokens_total: 99,
        input_tokens_observations: 1,
        output_tokens_total: 77,
        output_tokens_observations: 1,
        duration_ms_total: 55,
        duration_ms_observations: 1,
      }],
    }),
  }));

  assert.deepEqual(contextual.proposal, baseline.proposal);
  assert.equal(contextual.wrapper_usage_context.groups[0]?.duration_ms_total, 55);
  assert.equal(contextual.wrapper_usage_context.authority.changes_routing, false);
});

test("shared lane evidence is copied to every bound candidate without allocation", () => {
  const source = weeklyInput({
    routeplane: {
      snapshot: normalizeRoutePlaneCatalog({ object: "list", data: [
        { id: "model-a", object: "model", providers: ["provider-a"] },
        { id: "model-b", object: "model", providers: ["provider-b"] },
      ] }, NOW_MS - 1_000, 2_000),
      policies: [
        ...weeklyInput().routeplane.policies,
        { candidate_id: "candidate-b", model: "model-b", capabilities: ["code"], privacy: "network_ok", locality: "any" },
      ],
    },
    fleetbudget: {
      ...weeklyInput().fleetbudget,
      bindings: [
        { candidate_id: "candidate-a", lane_id: "shared-lane" },
        { candidate_id: "candidate-b", lane_id: "shared-lane" },
      ],
    },
    quality_annotations: [
      { candidate_id: "candidate-a", quality_tags: ["reviewed"] },
      { candidate_id: "candidate-b", quality_tags: ["reviewed"] },
    ],
    backlog: { ...weeklyInput().backlog, candidate_limit: 2 },
  });
  const result = compileWeeklyDrainReview(source);

  assert.deepEqual(result.budget.observations.map(({ candidate_id, budget }) => ({ candidate_id, budget })), [
    { candidate_id: "candidate-a", budget: { used: 10, total: 100, window: { starts_at_ms: NOW_MS - 10_000, ends_at_ms: NOW_MS + 10_000 } } },
    { candidate_id: "candidate-b", budget: { used: 10, total: 100, window: { starts_at_ms: NOW_MS - 10_000, ends_at_ms: NOW_MS + 10_000 } } },
  ]);
  assert.deepEqual(result.proposal?.capacity, { mode: "unmodeled", status: "unknown" });
  assert.equal(result.effects.allocated_pool, false);
});

test("is a pure package module without fetch, process, provider, or persistence imports", () => {
  const source = readFileSync(join(repoRoot, "src", "weekly-drain-review.ts"), "utf8");
  assert.doesNotMatch(source, /from\s+["']node:(?:child_process|fs|http|https|net|sqlite)["']/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bprocess\./);
  assert.doesNotMatch(source, /provider[_-]?(?:api|key|token|client)/i);
});
