import {
  compileFleetBudgetObservations,
  type FleetBudgetObservationBinding,
  type FleetBudgetObservationResult,
  type FleetBudgetSnapshot,
} from "./fleetbudget-observations.js";
import {
  compileRoutePlaneCandidates,
  type RoutePlaneCandidateCompilation,
  type RoutePlaneCandidatePolicy,
  type RoutePlaneCatalogSnapshot,
} from "./routeplane-catalog.js";
import {
  planSpeculativeBacklog,
  type PlanSpeculativeBacklogResult,
  type SpeculativeBacklogCandidate,
  type SpeculativeBacklogTask,
} from "./speculative-backlog-planner.js";
import {
  compileWrapperUsageStatus,
  type WrapperUsageStatusResult,
} from "./wrapper-usage-observations.js";

export const WEEKLY_DRAIN_REVIEW_VERSION =
  "meshfleet.weekly-drain-review.v0.1" as const;

const MAX_QUALITY_ANNOTATIONS = 256;
const QUALITY_TAG = /^[a-z0-9][a-z0-9._:-]*$/;

type RecordValue = Record<string, unknown>;

export interface WeeklyDrainReviewQualityAnnotation {
  candidate_id: string;
  quality_tags: string[];
}

export interface CompileWeeklyDrainReviewInput {
  version: typeof WEEKLY_DRAIN_REVIEW_VERSION;
  now_ms: number;
  routeplane: {
    snapshot: RoutePlaneCatalogSnapshot;
    policies: RoutePlaneCandidatePolicy[];
  };
  fleetbudget: {
    snapshot: FleetBudgetSnapshot;
    bindings: FleetBudgetObservationBinding[];
  };
  quality_annotations: WeeklyDrainReviewQualityAnnotation[];
  backlog: {
    tasks: SpeculativeBacklogTask[];
    candidate_limit?: number;
    preference?: { objective: "prefer_near_reset" };
  };
  wrapper_usage: unknown;
}

export interface WeeklyDrainReviewResult {
  review_version: typeof WEEKLY_DRAIN_REVIEW_VERSION;
  advisory: true;
  status: "evaluated" | "no_compiled_candidates";
  sources: {
    routeplane: RoutePlaneCatalogSnapshot["source"];
    fleetbudget: FleetBudgetObservationResult["source"];
    wrapper_usage: WrapperUsageStatusResult["source"];
  };
  catalog_compilation: RoutePlaneCandidateCompilation;
  budget: Pick<FleetBudgetObservationResult, "observations" | "diagnostics">;
  wrapper_usage_context: Pick<WrapperUsageStatusResult, "accepted" | "authority" | "rejections" | "groups">;
  proposal: PlanSpeculativeBacklogResult | null;
  effects: {
    persisted: false;
    executed: false;
    authorized: false;
    woke_agents: false;
    contacted_providers: false;
    fetched_catalog: false;
    polled: false;
    read_credentials: false;
    inferred_provider: false;
    changed_routing: false;
    allocated_pool: false;
    reserved_capacity: false;
    scheduled: false;
    spent_budget: false;
    sent: false;
    published: false;
    used_external_identity: false;
    claimed_budget_freshness: false;
    claimed_provider_availability: false;
  };
}

const EFFECTS: WeeklyDrainReviewResult["effects"] = {
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
};

function invalid(path: string, detail: string): never {
  throw new Error(`compile_weekly_drain_review: '${path}' ${detail}`);
}

function record(value: unknown, path: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(path, "must be an object");
  }
  return value as RecordValue;
}

function exactKeys(value: RecordValue, path: string, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) invalid(`${path}.${unknown}`, "is not allowed");
  const missing = keys.find((key) => !(key in value));
  if (missing !== undefined) invalid(`${path}.${missing}`, "is required");
}

function allowedKeys(value: RecordValue, path: string, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) invalid(`${path}.${unknown}`, "is not allowed");
}

function integer(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value)) {
    invalid(path, "must be a finite safe integer");
  }
}

function validateQualityAnnotations(value: unknown): WeeklyDrainReviewQualityAnnotation[] {
  if (!Array.isArray(value) || value.length > MAX_QUALITY_ANNOTATIONS) {
    invalid("quality_annotations", `must be an array with 0..${MAX_QUALITY_ANNOTATIONS} items`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const path = `quality_annotations[${index}]`;
    const annotation = record(entry, path);
    exactKeys(annotation, path, ["candidate_id", "quality_tags"]);
    if (
      typeof annotation.candidate_id !== "string" ||
      annotation.candidate_id.length === 0 ||
      annotation.candidate_id.length > 128 ||
      !QUALITY_TAG.test(annotation.candidate_id)
    ) {
      invalid(`${path}.candidate_id`, "must be a lowercase opaque identifier token");
    }
    if (seen.has(annotation.candidate_id)) {
      invalid(`${path}.candidate_id`, `is a duplicate candidate_id '${annotation.candidate_id}'`);
    }
    seen.add(annotation.candidate_id);
    if (!Array.isArray(annotation.quality_tags) || annotation.quality_tags.length > 32) {
      invalid(`${path}.quality_tags`, "must be an array with 0..32 items");
    }
    const tags = new Set<string>();
    for (let tagIndex = 0; tagIndex < annotation.quality_tags.length; tagIndex += 1) {
      const tag = annotation.quality_tags[tagIndex];
      if (typeof tag !== "string" || tag.length === 0 || tag.length > 64 || !QUALITY_TAG.test(tag)) {
        invalid(`${path}.quality_tags[${tagIndex}]`, "must be a lowercase quality token");
      }
      if (tags.has(tag)) invalid(`${path}.quality_tags`, `contains duplicate token '${tag}'`);
      tags.add(tag);
    }
    return { candidate_id: annotation.candidate_id, quality_tags: [...tags].sort() };
  });
}

function validate(input: unknown): CompileWeeklyDrainReviewInput {
  const source = record(input, "input");
  exactKeys(source, "input", [
    "version", "now_ms", "routeplane", "fleetbudget", "quality_annotations", "backlog", "wrapper_usage",
  ]);
  if (source.version !== WEEKLY_DRAIN_REVIEW_VERSION) {
    invalid("input.version", `must equal ${WEEKLY_DRAIN_REVIEW_VERSION}`);
  }
  integer(source.now_ms, "input.now_ms");
  const routeplane = record(source.routeplane, "input.routeplane");
  exactKeys(routeplane, "input.routeplane", ["snapshot", "policies"]);
  const fleetbudget = record(source.fleetbudget, "input.fleetbudget");
  exactKeys(fleetbudget, "input.fleetbudget", ["snapshot", "bindings"]);
  const backlog = record(source.backlog, "input.backlog");
  allowedKeys(backlog, "input.backlog", ["tasks", "candidate_limit", "preference"]);
  if (!("tasks" in backlog)) invalid("input.backlog.tasks", "is required");
  if (!Array.isArray(backlog.tasks) || backlog.tasks.length < 1 || backlog.tasks.length > 64) {
    invalid("input.backlog.tasks", "must be an array with 1..64 items");
  }
  if (
    backlog.candidate_limit !== undefined &&
    (typeof backlog.candidate_limit !== "number" ||
      !Number.isSafeInteger(backlog.candidate_limit) ||
      backlog.candidate_limit < 1 ||
      backlog.candidate_limit > 8)
  ) {
    invalid("input.backlog.candidate_limit", "must be a finite integer between 1 and 8");
  }
  if (backlog.preference !== undefined) {
    const preference = record(backlog.preference, "input.backlog.preference");
    exactKeys(preference, "input.backlog.preference", ["objective"]);
    if (preference.objective !== "prefer_near_reset") {
      invalid("input.backlog.preference.objective", "must equal prefer_near_reset");
    }
  }
  return {
    version: WEEKLY_DRAIN_REVIEW_VERSION,
    now_ms: source.now_ms,
    routeplane: {
      snapshot: routeplane.snapshot as RoutePlaneCatalogSnapshot,
      policies: routeplane.policies as RoutePlaneCandidatePolicy[],
    },
    fleetbudget: {
      snapshot: fleetbudget.snapshot as FleetBudgetSnapshot,
      bindings: fleetbudget.bindings as FleetBudgetObservationBinding[],
    },
    quality_annotations: validateQualityAnnotations(source.quality_annotations),
    backlog: {
      tasks: backlog.tasks as SpeculativeBacklogTask[],
      ...(backlog.candidate_limit === undefined ? {} : { candidate_limit: backlog.candidate_limit as number }),
      ...(backlog.preference === undefined ? {} : { preference: { objective: "prefer_near_reset" as const } }),
    },
    wrapper_usage: source.wrapper_usage,
  };
}

function candidatesWithQuality(
  compilation: RoutePlaneCandidateCompilation,
  annotations: WeeklyDrainReviewQualityAnnotation[],
  policies: RoutePlaneCandidatePolicy[],
): SpeculativeBacklogCandidate[] {
  const annotationByCandidate = new Map(annotations.map((annotation) => [annotation.candidate_id, annotation]));
  const policyIds = new Set(policies.map((policy) => policy.candidate_id));
  for (const annotation of annotations) {
    if (!policyIds.has(annotation.candidate_id)) {
      invalid("quality_annotations", `contains candidate_id '${annotation.candidate_id}' that is not declared by a policy`);
    }
  }
  for (const candidateId of policyIds) {
    if (!annotationByCandidate.has(candidateId)) {
      invalid("quality_annotations", `is missing candidate_id '${candidateId}'`);
    }
  }
  return compilation.candidates.map((candidate) => {
    const annotation = annotationByCandidate.get(candidate.candidate_id);
    if (annotation === undefined) {
      invalid("quality_annotations", `is missing candidate_id '${candidate.candidate_id}'`);
    }
    return { ...candidate, quality_tags: [...annotation.quality_tags] };
  });
}

/**
 * Pure weekly advisory composition over caller-supplied snapshots. It fetches,
 * persists, schedules, allocates, and executes nothing.
 */
export function compileWeeklyDrainReview(input: unknown): WeeklyDrainReviewResult {
  const validated = validate(input);
  const budget = compileFleetBudgetObservations({
    snapshot: validated.fleetbudget.snapshot,
    bindings: validated.fleetbudget.bindings,
    now_ms: validated.now_ms,
  });
  const catalog = compileRoutePlaneCandidates({
    snapshot: validated.routeplane.snapshot,
    policies: validated.routeplane.policies,
    observations: budget.observations,
    now_ms: validated.now_ms,
  });
  const candidates = candidatesWithQuality(catalog, validated.quality_annotations, validated.routeplane.policies);
  const wrapperUsage = compileWrapperUsageStatus(validated.wrapper_usage);
  const proposal = candidates.length === 0
    ? null
    : planSpeculativeBacklog({
      version: "meshfleet.speculative-backlog.v0.1",
      candidates,
      tasks: validated.backlog.tasks,
      ...(validated.backlog.candidate_limit === undefined ? {} : { candidate_limit: validated.backlog.candidate_limit }),
      ...(validated.backlog.preference === undefined
        ? {}
        : { preference: { objective: "prefer_near_reset" as const, now_ms: validated.now_ms } }),
    });

  return {
    review_version: WEEKLY_DRAIN_REVIEW_VERSION,
    advisory: true,
    status: proposal === null ? "no_compiled_candidates" : "evaluated",
    sources: {
      routeplane: { ...catalog.source },
      fleetbudget: { ...budget.source },
      wrapper_usage: { ...wrapperUsage.source, window: { ...wrapperUsage.source.window }, producer_effect_flags: { ...wrapperUsage.source.producer_effect_flags } },
    },
    catalog_compilation: {
      ...catalog,
      source: { ...catalog.source },
      candidates: catalog.candidates.map((candidate) => ({ ...candidate })),
      diagnostics: catalog.diagnostics.map((diagnostic) => ({ ...diagnostic, reason_codes: [...diagnostic.reason_codes] })),
    },
    budget: {
      observations: budget.observations.map((observation) => ({ ...observation, ...(observation.budget === undefined ? {} : { budget: { ...observation.budget, ...(observation.budget.window === undefined ? {} : { window: { ...observation.budget.window } }) } }) })),
      diagnostics: budget.diagnostics.map((diagnostic) => ({ ...diagnostic, reason_codes: [...diagnostic.reason_codes] })),
    },
    wrapper_usage_context: {
      accepted: true,
      authority: { ...wrapperUsage.authority },
      rejections: { ...wrapperUsage.rejections },
      groups: wrapperUsage.groups.map((group) => ({ ...group, failure_class_counts: { ...group.failure_class_counts } })),
    },
    proposal,
    effects: { ...EFFECTS },
  };
}
