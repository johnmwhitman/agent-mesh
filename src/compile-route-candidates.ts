import { assertRouteCandidates } from "./route-candidate-validation.js";
import type {
  RecommendRouteCandidate,
  RouteCoordination,
  RouteLocality,
  RoutePrivacy,
} from "./recommend-route.js";

export const ROUTE_CANDIDATE_COMPILER_VERSION =
  "meshfleet.route-candidates.v0.1" as const;

export interface CompileRouteCandidateObservation {
  candidate_id: string;
  status: "green" | "degraded" | "exhausted" | "unconfigured";
  confidence: "measured" | "assumed";
  budget?: {
    used: number;
    total: number;
    window?: {
      starts_at_ms: number;
      ends_at_ms: number;
    };
  };
  observed_outcomes?: {
    successes: number;
    failures: number;
  };
  observed_identity?: {
    runtime?: string;
    model?: string;
    source: string;
  };
}

export interface CompileRouteCandidatesInput {
  manifest: {
    version: typeof ROUTE_CANDIDATE_COMPILER_VERSION;
    candidates: Array<{
      candidate_id: string;
      capabilities: string[];
      privacy: RoutePrivacy;
      locality: RouteLocality;
      coordination_modes?: RouteCoordination[];
      policy_tags?: string[];
      context_window?: number;
      requested_identity?: {
        runtime?: string;
        model?: string;
      };
    }>;
  };
  observations?: CompileRouteCandidateObservation[];
}

export interface CompileRouteCandidatesResult {
  compiler_version: typeof ROUTE_CANDIDATE_COMPILER_VERSION;
  projection: true;
  effects: {
    persisted: false;
    executed: false;
    authorized: false;
    woke_agents: false;
    contacted_providers: false;
  };
  candidates: RecommendRouteCandidate[];
  diagnostics: Array<{
    candidate_id: string;
    reason_codes: string[];
  }>;
}

const MAX_OBSERVATIONS = 256;
const MAX_OUTCOME_COUNT = 1_000_000;

type RecordValue = Record<string, unknown>;
type Observation = CompileRouteCandidateObservation;

function invalid(path: string, detail: string): never {
  throw new Error(`compile_route_candidates: '${path}' ${detail}`);
}

function requireRecord(value: unknown, path: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(path, "must be an object");
  }
  return value as RecordValue;
}

function requireAllowedKeys(
  value: RecordValue,
  path: string,
  allowed: ReadonlySet<string>,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    const sortedAllowed = Array.from(allowed).sort();
    invalid(
      path ? `${path}.${unknown}` : unknown,
      `is not allowed; allowed keys are: ${sortedAllowed.join(", ")}`,
    );
  }
}

function requireString(value: unknown, path: string, maxLength = 128): asserts value is string {
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

function validateManifest(value: unknown): CompileRouteCandidatesInput["manifest"] {
  const manifest = requireRecord(value, "manifest");
  requireAllowedKeys(manifest, "manifest", new Set(["version", "candidates"]));
  if (manifest.version !== ROUTE_CANDIDATE_COMPILER_VERSION) {
    invalid("manifest.version", `must equal ${ROUTE_CANDIDATE_COMPILER_VERSION}`);
  }
  if (
    !Array.isArray(manifest.candidates) ||
    manifest.candidates.length < 1 ||
    manifest.candidates.length > 256
  ) {
    invalid("manifest.candidates", "must be an array with 1..256 items");
  }

  const staticSnapshots: unknown[] = [];
  for (let index = 0; index < manifest.candidates.length; index++) {
    const path = `manifest.candidates[${index}]`;
    const candidate = requireRecord(manifest.candidates[index], path);
    requireAllowedKeys(
      candidate,
      path,
      new Set([
        "candidate_id",
        "capabilities",
        "privacy",
        "locality",
        "coordination_modes",
        "policy_tags",
        "context_window",
        "requested_identity",
      ]),
    );
    staticSnapshots.push({ ...candidate, budget: { measured: false } });
    assertRouteCandidates(staticSnapshots, {
      errorPrefix: "compile_route_candidates",
      path: "manifest.candidates",
    });
  }
  return manifest as unknown as CompileRouteCandidatesInput["manifest"];
}

function validateIdentity(value: unknown, path: string): void {
  const identity = requireRecord(value, path);
  requireAllowedKeys(identity, path, new Set(["runtime", "model", "source"]));
  if (identity.runtime === undefined && identity.model === undefined) {
    invalid(path, "must name at least one of runtime or model");
  }
  if (identity.runtime !== undefined) requireString(identity.runtime, `${path}.runtime`, 256);
  if (identity.model !== undefined) requireString(identity.model, `${path}.model`, 256);
  requireString(identity.source, `${path}.source`, 256);
}

function validateObservations(
  value: unknown,
  manifestCandidateIds: ReadonlySet<string>,
): Observation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_OBSERVATIONS) {
    invalid("observations", `must be an array with 0..${MAX_OBSERVATIONS} items`);
  }

  const observations = value as unknown[];
  const seen = new Set<string>();
  const validated: Observation[] = [];
  for (let index = 0; index < observations.length; index++) {
    const path = `observations[${index}]`;
    const observation = requireRecord(observations[index], path);
    requireAllowedKeys(
      observation,
      path,
      new Set([
        "candidate_id",
        "status",
        "confidence",
        "budget",
        "observed_outcomes",
        "observed_identity",
      ]),
    );
    requireString(observation.candidate_id, `${path}.candidate_id`);
    const candidateId = observation.candidate_id as string;
    if (seen.has(candidateId)) {
      invalid(`${path}.candidate_id`, `is a duplicate candidate_id '${candidateId}'`);
    }
    seen.add(candidateId);
    if (!manifestCandidateIds.has(candidateId)) {
      invalid(`${path}.candidate_id`, "is not present in manifest.candidates");
    }
    if (!(["green", "degraded", "exhausted", "unconfigured"] as const).includes(
      observation.status as "green" | "degraded" | "exhausted" | "unconfigured",
    )) {
      invalid(`${path}.status`, "must be green, degraded, exhausted, or unconfigured");
    }
    if (!(["measured", "assumed"] as const).includes(
      observation.confidence as "measured" | "assumed",
    )) {
      invalid(`${path}.confidence`, "must be measured or assumed");
    }
    if (observation.budget !== undefined) {
      const budget = requireRecord(observation.budget, `${path}.budget`);
      requireAllowedKeys(budget, `${path}.budget`, new Set(["used", "total", "window"]));
      if (budget.window !== undefined) {
        const window = requireRecord(budget.window, `${path}.budget.window`);
        requireAllowedKeys(
          window,
          `${path}.budget.window`,
          new Set(["starts_at_ms", "ends_at_ms"]),
        );
      }
    }
    if (observation.observed_outcomes !== undefined) {
      const outcomes = requireRecord(observation.observed_outcomes, `${path}.observed_outcomes`);
      requireAllowedKeys(outcomes, `${path}.observed_outcomes`, new Set(["successes", "failures"]));
      requireFiniteInteger(outcomes.successes, `${path}.observed_outcomes.successes`, 0, MAX_OUTCOME_COUNT);
      requireFiniteInteger(outcomes.failures, `${path}.observed_outcomes.failures`, 0, MAX_OUTCOME_COUNT);
    }
    if (observation.observed_identity !== undefined) {
      validateIdentity(observation.observed_identity, `${path}.observed_identity`);
    }
    validated.push(observation as unknown as Observation);
  }

  for (let index = 0; index < validated.length; index++) {
    const observation = validated[index]!;
    const path = `observations[${index}]`;
    if (observation.status === "unconfigured") {
      invalid(`${path}.status`, "must not be unconfigured for a manifest candidate");
    }
    if (observation.confidence === "assumed") {
      if (
        observation.budget !== undefined ||
        observation.observed_outcomes !== undefined ||
        observation.observed_identity !== undefined
      ) {
        invalid(
          path,
          "must omit budget, observed_outcomes, and observed_identity when confidence is assumed",
        );
      }
      if (observation.status === "exhausted") {
        invalid(`${path}.status`, "must not be exhausted when confidence is assumed");
      }
      continue;
    }

    if (observation.budget !== undefined) {
      if (!Number.isFinite(observation.budget.used) || observation.budget.used < 0) {
        invalid(`${path}.budget.used`, "must be a finite number >= 0");
      }
      if (!Number.isFinite(observation.budget.total) || observation.budget.total <= 0) {
        invalid(`${path}.budget.total`, "must be a finite number > 0");
      }
      if (observation.budget.window !== undefined) {
        requireFiniteInteger(
          observation.budget.window.starts_at_ms,
          `${path}.budget.window.starts_at_ms`,
          Number.MIN_SAFE_INTEGER,
        );
        requireFiniteInteger(
          observation.budget.window.ends_at_ms,
          `${path}.budget.window.ends_at_ms`,
          Number.MIN_SAFE_INTEGER,
        );
        if (
          observation.budget.window.ends_at_ms <=
          observation.budget.window.starts_at_ms
        ) {
          invalid(
            `${path}.budget.window.ends_at_ms`,
            "must be greater than starts_at_ms",
          );
        }
      }
    }
    const exhaustedEvidence =
      observation.budget !== undefined && observation.budget.used >= observation.budget.total;
    if (observation.status === "exhausted" && !exhaustedEvidence) {
      invalid(`${path}.status`, "requires measured budget used >= total");
    }
    if (
      (observation.status === "green" || observation.status === "degraded") &&
      exhaustedEvidence
    ) {
      invalid(`${path}.status`, "must be exhausted when measured budget used >= total");
    }
  }
  return validated;
}

function copyCandidate(
  candidate: CompileRouteCandidatesInput["manifest"]["candidates"][number],
  observation: Observation | undefined,
): RecommendRouteCandidate {
  const output: RecommendRouteCandidate = {
    candidate_id: candidate.candidate_id,
    capabilities: [...candidate.capabilities],
    privacy: candidate.privacy,
    locality: candidate.locality,
    budget:
      observation?.confidence === "measured" && observation.budget !== undefined
        ? {
            measured: true,
            used: observation.budget.used,
            total: observation.budget.total,
            ...(observation.budget.window === undefined
              ? {}
              : {
                  window: {
                    starts_at_ms: observation.budget.window.starts_at_ms,
                    ends_at_ms: observation.budget.window.ends_at_ms,
                  },
                }),
          }
        : { measured: false },
  };
  if (candidate.coordination_modes !== undefined) {
    output.coordination_modes = [...candidate.coordination_modes];
  }
  if (candidate.policy_tags !== undefined) output.policy_tags = [...candidate.policy_tags];
  if (candidate.context_window !== undefined) output.context_window = candidate.context_window;
  if (candidate.requested_identity !== undefined) {
    output.requested_identity = { ...candidate.requested_identity };
  }
  if (observation?.confidence === "measured" && observation.observed_outcomes !== undefined) {
    output.observed_outcomes = { ...observation.observed_outcomes };
  }
  if (observation?.confidence === "measured" && observation.observed_identity !== undefined) {
    output.observed_identity = { ...observation.observed_identity };
  }
  return output;
}

export function compileRouteCandidates(
  input: CompileRouteCandidatesInput,
): CompileRouteCandidatesResult {
  const record = requireRecord(input, "input");
  requireAllowedKeys(record, "input", new Set(["manifest", "observations"]));
  const manifest = validateManifest(record.manifest);
  const manifestCandidateIds = new Set(manifest.candidates.map(({ candidate_id }) => candidate_id));
  const observations = validateObservations(record.observations, manifestCandidateIds);
  const byCandidateId = new Map(
    observations.map((observation) => [observation.candidate_id, observation]),
  );
  const orderedManifest = [...manifest.candidates].sort((left, right) =>
    left.candidate_id < right.candidate_id
      ? -1
      : left.candidate_id > right.candidate_id
        ? 1
        : 0,
  );
  const candidates = orderedManifest.map((candidate) =>
    copyCandidate(candidate, byCandidateId.get(candidate.candidate_id)),
  );
  assertRouteCandidates(candidates, {
    errorPrefix: "compile_route_candidates",
    path: "candidates",
  });

  const diagnostics = orderedManifest.map(({ candidate_id }) => {
    const observation = byCandidateId.get(candidate_id);
    const reason_codes: string[] = [];
    if (observation === undefined) {
      reason_codes.push("OBSERVATION_MISSING", "BUDGET_UNMEASURED");
    } else if (observation.confidence === "assumed") {
      reason_codes.push("OBSERVATION_ASSUMED", "BUDGET_UNMEASURED");
    } else if (observation.budget === undefined) {
      reason_codes.push("BUDGET_UNMEASURED");
    } else if (observation.budget.used >= observation.budget.total) {
      reason_codes.push("BUDGET_EXHAUSTED_EVIDENCE");
    }
    return { candidate_id, reason_codes };
  });

  return {
    compiler_version: ROUTE_CANDIDATE_COMPILER_VERSION,
    projection: true,
    effects: {
      persisted: false,
      executed: false,
      authorized: false,
      woke_agents: false,
      contacted_providers: false,
    },
    candidates,
    diagnostics,
  };
}
