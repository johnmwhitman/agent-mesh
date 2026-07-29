import { assertRouteCandidates } from "./route-candidate-validation.js";

export { assertRouteCandidates } from "./route-candidate-validation.js";
export type { RouteCandidateValidationOptions } from "./route-candidate-validation.js";

export type RoutePrivacy = "local_only" | "network_ok" | "unrestricted";
export type RouteLocality = "same_host" | "same_fleet" | "any";
export type RouteCoordination = "solo" | "pair_discussion";

export interface RecommendRouteTask {
  required_capabilities: string[];
  optional_capabilities?: string[];
  privacy: RoutePrivacy;
  locality: RouteLocality;
  coordination?: RouteCoordination;
  policy_tags?: string[];
  min_context_tokens?: number;
}

export interface RecommendRouteCandidate {
  candidate_id: string;
  capabilities: string[];
  privacy: RoutePrivacy;
  locality: RouteLocality;
  coordination_modes?: RouteCoordination[];
  policy_tags?: string[];
  context_window?: number;
  observed_outcomes?: {
    successes: number;
    failures: number;
  };
  budget?: {
    measured: boolean;
    used?: number;
    total?: number;
    window?: {
      starts_at_ms: number;
      ends_at_ms: number;
    };
  };
  requested_identity?: {
    runtime?: string;
    model?: string;
  };
  observed_identity?: {
    runtime?: string;
    model?: string;
    source: string;
  };
}

export interface RecommendRouteInput {
  task: RecommendRouteTask;
  candidates: RecommendRouteCandidate[];
  top_n?: number;
  preference?: {
    objective: "prefer_near_reset";
    now_ms: number;
  };
}

export interface RecommendRouteResult {
  advisory: true;
  effects: {
    persisted: false;
    executed: false;
    authorized: false;
    woke_agents: false;
    contacted_providers: false;
  };
  preference?: {
    objective: "prefer_near_reset";
    now_ms: number;
    horizon_ms: number;
    evidence_only: true;
  };
  ranked: Array<{
    candidate_id: string;
    rank: number;
    components: {
      declared_fit: number;
      observed_outcomes: number;
      budget_adjustment: number;
      final_score: number;
      reset_urgency?: number;
    };
    budget: {
      measured: boolean;
      status: "unmeasured" | "healthy" | "tapered" | "constrained" | "exhausted";
      utilization?: number;
    };
    identity: {
      requested?: RecommendRouteCandidate["requested_identity"];
      observed?: RecommendRouteCandidate["observed_identity"];
      evidence_only: true;
      status: "not_requested" | "unobserved" | "claim_match" | "claim_mismatch";
    };
    reason_codes: string[];
  }>;
  excluded: Array<{
    candidate_id: string;
    reason_codes: string[];
  }>;
}

const PRIVACY_ORDER: Record<RoutePrivacy, number> = {
  local_only: 0,
  network_ok: 1,
  unrestricted: 2,
};

const LOCALITY_ORDER: Record<RouteLocality, number> = {
  same_host: 0,
  same_fleet: 1,
  any: 2,
};

const RESET_URGENCY_HORIZON_MS = 604_800_000;

function invalid(path: string, detail: string): never {
  throw new Error(`recommend_route: '${path}' ${detail}`);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function requireAllowedKeys(
  value: Record<string, unknown>,
  path: string,
  allowed: ReadonlySet<string>,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    invalid(path ? `${path}.${unknown}` : unknown, "is not allowed");
  }
}

function requireString(
  value: unknown,
  path: string,
  maxLength = 128,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    invalid(path, `must be a non-empty string no longer than ${maxLength} characters`);
  }
}

function requireFiniteInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    invalid(path, `must be a finite integer between ${minimum} and ${maximum}`);
  }
}

function requireTokenArray(
  value: unknown,
  path: string,
  options: { minItems?: number; maxItems?: number } = {},
): asserts value is string[] {
  const minItems = options.minItems ?? 0;
  const maxItems = options.maxItems ?? 64;
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    invalid(path, `must be an array with ${minItems}..${maxItems} items`);
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    requireString(value[index], `${path}[${index}]`, 64);
    const token = value[index] as string;
    if (!/^[a-z0-9][a-z0-9._:-]*$/.test(token)) {
      invalid(
        `${path}[${index}]`,
        "must be a lowercase capability or policy token, not free-form text",
      );
    }
    if (seen.has(token)) invalid(path, `contains duplicate token '${token}'`);
    seen.add(token);
  }
}

export function assertRecommendRouteTask(value: unknown): asserts value is RecommendRouteTask {
  const task = requireRecord(value, "task");
  requireAllowedKeys(
    task,
    "task",
    new Set([
      "required_capabilities",
      "optional_capabilities",
      "privacy",
      "locality",
      "coordination",
      "policy_tags",
      "min_context_tokens",
    ]),
  );

  requireTokenArray(task.required_capabilities, "task.required_capabilities", {
    minItems: 1,
  });
  if (task.optional_capabilities !== undefined) {
    requireTokenArray(task.optional_capabilities, "task.optional_capabilities");
    const requiredCapabilities = new Set(task.required_capabilities);
    const repeated = task.optional_capabilities.find((capability) =>
      requiredCapabilities.has(capability),
    );
    if (repeated !== undefined) {
      invalid(
        "task.optional_capabilities",
        `must not repeat required_capabilities token '${repeated}'`,
      );
    }
  }
  if (!["local_only", "network_ok", "unrestricted"].includes(task.privacy as string)) {
    invalid("task.privacy", "must be local_only, network_ok, or unrestricted");
  }
  if (!["same_host", "same_fleet", "any"].includes(task.locality as string)) {
    invalid("task.locality", "must be same_host, same_fleet, or any");
  }
  if (
    task.coordination !== undefined &&
    !["solo", "pair_discussion"].includes(task.coordination as string)
  ) {
    invalid("task.coordination", "must be solo or pair_discussion");
  }
  if (task.policy_tags !== undefined) {
    requireTokenArray(task.policy_tags, "task.policy_tags");
  }
  if (task.min_context_tokens !== undefined) {
    requireFiniteInteger(task.min_context_tokens, "task.min_context_tokens", 0);
  }
}

function validateRecommendRouteInput(value: unknown): asserts value is RecommendRouteInput {
  const input = requireRecord(value, "input");
  requireAllowedKeys(input, "", new Set(["task", "candidates", "top_n", "preference"]));
  assertRecommendRouteTask(input.task);

  assertRouteCandidates(input.candidates, {
    errorPrefix: "recommend_route",
    path: "candidates",
  });
  if (input.top_n !== undefined) {
    requireFiniteInteger(input.top_n, "top_n", 1);
    if (input.top_n > input.candidates.length) {
      invalid("top_n", "cannot exceed candidates.length");
    }
  }
  if (input.preference !== undefined) {
    const preference = requireRecord(input.preference, "preference");
    requireAllowedKeys(
      preference,
      "preference",
      new Set(["objective", "now_ms"]),
    );
    if (preference.objective !== "prefer_near_reset") {
      invalid("preference.objective", "must equal prefer_near_reset");
    }
    requireFiniteInteger(
      preference.now_ms,
      "preference.now_ms",
      Number.MIN_SAFE_INTEGER,
    );
  }
}

interface ScoredCandidate {
  candidate: RecommendRouteCandidate;
  components: RecommendRouteResult["ranked"][number]["components"];
  budget: RecommendRouteResult["ranked"][number]["budget"];
  identity: RecommendRouteResult["ranked"][number]["identity"];
  reasonCodes: string[];
  resetUrgency?: number;
}

function scoreDeclaredFit(
  task: RecommendRouteTask,
  candidate: RecommendRouteCandidate,
): number {
  const optional = task.optional_capabilities ?? [];
  if (optional.length === 0) return 1;
  const capabilities = new Set(candidate.capabilities);
  const optionalHits = optional.filter((capability) => capabilities.has(capability)).length;
  return 0.85 + (optionalHits / optional.length) * 0.15;
}

function scoreObservedOutcomes(
  outcomes: RecommendRouteCandidate["observed_outcomes"],
): number {
  if (!outcomes) return 1;
  const total = outcomes.successes + outcomes.failures;
  if (total === 0) return 1;
  return 1 + ((outcomes.successes - outcomes.failures) / (total + 4)) * 0.5;
}

function scoreBudget(
  budget: RecommendRouteCandidate["budget"],
): {
  adjustment: number;
  view: RecommendRouteResult["ranked"][number]["budget"];
  reasonCodes: string[];
} {
  if (!budget?.measured) {
    return {
      adjustment: 1,
      view: { measured: false, status: "unmeasured" },
      reasonCodes: ["BUDGET_UNMEASURED"],
    };
  }

  const utilization = budget.used! / budget.total!;
  if (utilization >= 1) {
    return {
      adjustment: 0,
      view: { measured: true, status: "exhausted", utilization },
      reasonCodes: ["BUDGET_EXHAUSTED"],
    };
  }
  if (utilization <= 0.6) {
    return {
      adjustment: 1,
      view: { measured: true, status: "healthy", utilization },
      reasonCodes: [],
    };
  }
  if (utilization < 0.8) {
    const taper = (utilization - 0.6) / 0.2;
    return {
      adjustment: 1 - taper * 0.5,
      view: { measured: true, status: "tapered", utilization },
      reasonCodes: ["BUDGET_TAPERED"],
    };
  }
  return {
    adjustment: 0.5,
    view: { measured: true, status: "constrained", utilization },
    reasonCodes: ["BUDGET_CONSTRAINED"],
  };
}

function describeIdentity(
  candidate: RecommendRouteCandidate,
): RecommendRouteResult["ranked"][number]["identity"] {
  if (!candidate.requested_identity) {
    return {
      observed: candidate.observed_identity,
      evidence_only: true,
      status: "not_requested",
    };
  }
  if (!candidate.observed_identity) {
    return {
      requested: candidate.requested_identity,
      evidence_only: true,
      status: "unobserved",
    };
  }
  return {
    requested: candidate.requested_identity,
    observed: candidate.observed_identity,
    evidence_only: true,
    status:
      (candidate.requested_identity.runtime === undefined ||
        candidate.requested_identity.runtime === candidate.observed_identity.runtime) &&
      (candidate.requested_identity.model === undefined ||
        candidate.requested_identity.model === candidate.observed_identity.model)
        ? "claim_match"
        : "claim_mismatch",
  };
}

function scoreResetUrgency(
  budget: RecommendRouteCandidate["budget"],
  nowMs: number,
): { urgency: number; reasonCode: string } {
  if (!budget?.measured) {
    return { urgency: 0, reasonCode: "RESET_BUDGET_UNMEASURED" };
  }
  if (budget.window === undefined) {
    return { urgency: 0, reasonCode: "RESET_WINDOW_MISSING" };
  }
  if (
    nowMs < budget.window.starts_at_ms ||
    nowMs > budget.window.ends_at_ms
  ) {
    return { urgency: 0, reasonCode: "RESET_WINDOW_NOT_CURRENT" };
  }
  const remainingFraction = Math.max(
    0,
    Math.min(1, (budget.total! - budget.used!) / budget.total!),
  );
  const msLeft = budget.window.ends_at_ms - nowMs;
  const proximity = Math.max(
    0,
    Math.min(1, 1 - msLeft / RESET_URGENCY_HORIZON_MS),
  );
  return {
    urgency: remainingFraction * proximity,
    reasonCode: "RESET_WINDOW_CURRENT",
  };
}

export function recommendRoute(input: RecommendRouteInput): RecommendRouteResult {
  validateRecommendRouteInput(input);
  const eligible: ScoredCandidate[] = [];
  const excluded: RecommendRouteResult["excluded"] = [];

  for (const candidate of input.candidates) {
    const reasonCodes: string[] = [];
    if (PRIVACY_ORDER[candidate.privacy] > PRIVACY_ORDER[input.task.privacy]) {
      reasonCodes.push("PRIVACY_MISMATCH");
    }
    if (LOCALITY_ORDER[candidate.locality] > LOCALITY_ORDER[input.task.locality]) {
      reasonCodes.push("LOCALITY_MISMATCH");
    }
    const candidatePolicies = new Set(candidate.policy_tags ?? []);
    if ((input.task.policy_tags ?? []).some((tag) => !candidatePolicies.has(tag))) {
      reasonCodes.push("POLICY_MISMATCH");
    }
    const candidateCapabilities = new Set(candidate.capabilities);
    if (
      input.task.required_capabilities.some(
        (capability) => !candidateCapabilities.has(capability),
      )
    ) {
      reasonCodes.push("CAPABILITY_MISSING");
    }
    if (
      input.task.coordination !== undefined &&
      !(candidate.coordination_modes ?? ["solo"]).includes(
        input.task.coordination,
      )
    ) {
      reasonCodes.push("COORDINATION_MISMATCH");
    }
    if (
      input.task.min_context_tokens !== undefined &&
      (candidate.context_window === undefined ||
        candidate.context_window < input.task.min_context_tokens)
    ) {
      reasonCodes.push("CONTEXT_INSUFFICIENT");
    }
    if (reasonCodes.length > 0) {
      excluded.push({
        candidate_id: candidate.candidate_id,
        reason_codes: reasonCodes,
      });
      continue;
    }
    const declaredFit = scoreDeclaredFit(input.task, candidate);
    const observedOutcomes = scoreObservedOutcomes(candidate.observed_outcomes);
    const budget = scoreBudget(candidate.budget);
    if (budget.adjustment === 0) {
      excluded.push({
        candidate_id: candidate.candidate_id,
        reason_codes: ["BUDGET_EXHAUSTED"],
      });
      continue;
    }
    const resetUrgency = input.preference === undefined
      ? undefined
      : scoreResetUrgency(candidate.budget, input.preference.now_ms);
    eligible.push({
      candidate,
      components: {
        declared_fit: declaredFit,
        observed_outcomes: observedOutcomes,
        budget_adjustment: budget.adjustment,
        final_score: declaredFit * observedOutcomes * budget.adjustment,
        ...(resetUrgency === undefined
          ? {}
          : { reset_urgency: resetUrgency.urgency }),
      },
      budget: budget.view,
      identity: describeIdentity(candidate),
      reasonCodes: [
        ...(candidate.observed_outcomes ? [] : ["OUTCOMES_UNMEASURED"]),
        ...budget.reasonCodes,
        ...(resetUrgency === undefined ? [] : [resetUrgency.reasonCode]),
      ],
      ...(resetUrgency === undefined
        ? {}
        : { resetUrgency: resetUrgency.urgency }),
    });
  }

  eligible.sort((a, b) => {
    if (a.components.final_score !== b.components.final_score) {
      return b.components.final_score - a.components.final_score;
    }
    if (
      input.preference !== undefined &&
      a.resetUrgency !== b.resetUrgency
    ) {
      return (b.resetUrgency ?? 0) - (a.resetUrgency ?? 0);
    }
    if (a.components.declared_fit !== b.components.declared_fit) {
      return b.components.declared_fit - a.components.declared_fit;
    }
    return a.candidate.candidate_id < b.candidate.candidate_id
      ? -1
      : a.candidate.candidate_id > b.candidate.candidate_id
        ? 1
        : 0;
  });
  const topN = input.top_n ?? 1;

  return {
    advisory: true,
    effects: {
      persisted: false,
      executed: false,
      authorized: false,
      woke_agents: false,
      contacted_providers: false,
    },
    ...(input.preference === undefined
      ? {}
      : {
          preference: {
            objective: input.preference.objective,
            now_ms: input.preference.now_ms,
            horizon_ms: RESET_URGENCY_HORIZON_MS,
            evidence_only: true as const,
          },
        }),
    ranked: eligible.slice(0, topN).map((scored, index) => ({
      candidate_id: scored.candidate.candidate_id,
      rank: index + 1,
      components: scored.components,
      budget: scored.budget,
      identity: scored.identity,
      reason_codes: scored.reasonCodes,
    })),
    excluded,
  };
}
