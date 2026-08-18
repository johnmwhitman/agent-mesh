import type { RecommendRouteCandidate } from "./recommend-route.js";

export interface RouteCandidateValidationOptions {
  errorPrefix: string;
  path: string;
}

const MAX_CANDIDATES = 256;
const MAX_TOKENS = 64;
const MAX_OUTCOME_COUNT = 1_000_000;

type ValidationFailure = (path: string, detail: string) => never;

function invalid(
  options: RouteCandidateValidationOptions,
  path: string,
  detail: string,
): never {
  throw new Error(`${options.errorPrefix}: '${path}' ${detail}`);
}

function requireRecord(
  value: unknown,
  path: string,
  fail: ValidationFailure,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function requireAllowedKeys(
  value: Record<string, unknown>,
  path: string,
  allowed: ReadonlySet<string>,
  fail: ValidationFailure,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    const sortedAllowed = Array.from(allowed).sort();
    fail(
      path ? `${path}.${unknown}` : unknown,
      `is not allowed; allowed keys are: ${sortedAllowed.join(", ")}`,
    );
  }
}

function requireString(
  value: unknown,
  path: string,
  fail: ValidationFailure,
  maxLength = 128,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    fail(path, `must be a non-empty string no longer than ${maxLength} characters`);
  }
}

function requireFiniteInteger(
  value: unknown,
  path: string,
  minimum: number,
  fail: ValidationFailure,
  maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    fail(path, `must be a finite integer between ${minimum} and ${maximum}`);
  }
}

function requireTokenArray(
  value: unknown,
  path: string,
  fail: ValidationFailure,
  options: { minItems?: number; maxItems?: number } = {},
): asserts value is string[] {
  const minItems = options.minItems ?? 0;
  const maxItems = options.maxItems ?? MAX_TOKENS;
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    fail(path, `must be an array with ${minItems}..${maxItems} items`);
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    requireString(value[index], `${path}[${index}]`, fail, MAX_TOKENS);
    const token = value[index] as string;
    if (!/^[a-z0-9][a-z0-9._:-]*$/.test(token)) {
      fail(
        `${path}[${index}]`,
        "must be a lowercase capability or policy token, not free-form text",
      );
    }
    if (seen.has(token)) fail(path, `contains duplicate token '${token}'`);
    seen.add(token);
  }
}

export function assertRouteCandidates(
  value: unknown,
  options: RouteCandidateValidationOptions,
  fail?: ValidationFailure,
): asserts value is RecommendRouteCandidate[] {
  const failValidation = fail ?? ((path, detail) => invalid(options, path, detail));
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CANDIDATES) {
    failValidation(options.path, `must be an array with 1..${MAX_CANDIDATES} items`);
  }

  const candidates = value as unknown[];
  const candidateIds = new Set<string>();
  for (let index = 0; index < candidates.length; index++) {
    const path = `${options.path}[${index}]`;
    const candidate = requireRecord(candidates[index], path, failValidation);
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
        "observed_outcomes",
        "budget",
        "requested_identity",
        "observed_identity",
      ]),
      failValidation,
    );
    requireString(candidate.candidate_id, `${path}.candidate_id`, failValidation);
    const candidateId = candidate.candidate_id as string;
    if (candidateIds.has(candidateId)) {
      failValidation(`${path}.candidate_id`, `is a duplicate candidate_id '${candidateId}'`);
    }
    candidateIds.add(candidateId);
    requireTokenArray(candidate.capabilities, `${path}.capabilities`, failValidation, {
      minItems: 1,
    });
    if (!["local_only", "network_ok", "unrestricted"].includes(candidate.privacy as string)) {
      failValidation(`${path}.privacy`, "must be local_only, network_ok, or unrestricted");
    }
    if (!["same_host", "same_fleet", "any"].includes(candidate.locality as string)) {
      failValidation(`${path}.locality`, "must be same_host, same_fleet, or any");
    }
    const coordinationModes = candidate.coordination_modes;
    if (coordinationModes !== undefined) {
      if (
        !Array.isArray(coordinationModes) ||
        coordinationModes.length < 1 ||
        coordinationModes.length > 2
      ) {
        failValidation(`${path}.coordination_modes`, "must be an array with 1..2 items");
      }
      const modesInput = coordinationModes as unknown[];
      const modes = new Set<unknown>();
      for (let modeIndex = 0; modeIndex < modesInput.length; modeIndex++) {
        const mode = modesInput[modeIndex];
        if (!["solo", "pair_discussion"].includes(mode as string)) {
          failValidation(
            `${path}.coordination_modes[${modeIndex}]`,
            "must be solo or pair_discussion",
          );
        }
        if (modes.has(mode)) {
          failValidation(`${path}.coordination_modes`, `contains duplicate mode '${String(mode)}'`);
        }
        modes.add(mode);
      }
    }
    if (candidate.policy_tags !== undefined) {
      requireTokenArray(candidate.policy_tags, `${path}.policy_tags`, failValidation);
    }
    if (candidate.context_window !== undefined) {
      requireFiniteInteger(candidate.context_window, `${path}.context_window`, 0, failValidation);
    }
    if (candidate.observed_outcomes !== undefined) {
      const outcomes = requireRecord(
        candidate.observed_outcomes,
        `${path}.observed_outcomes`,
        failValidation,
      );
      requireAllowedKeys(
        outcomes,
        `${path}.observed_outcomes`,
        new Set(["successes", "failures"]),
        failValidation,
      );
      requireFiniteInteger(
        outcomes.successes,
        `${path}.observed_outcomes.successes`,
        0,
        failValidation,
        MAX_OUTCOME_COUNT,
      );
      requireFiniteInteger(
        outcomes.failures,
        `${path}.observed_outcomes.failures`,
        0,
        failValidation,
        MAX_OUTCOME_COUNT,
      );
    }
    if (candidate.budget !== undefined) {
      const budget = requireRecord(candidate.budget, `${path}.budget`, failValidation);
      requireAllowedKeys(
        budget,
        `${path}.budget`,
        new Set(["measured", "used", "total", "window"]),
        failValidation,
      );
      if (typeof budget.measured !== "boolean") {
        failValidation(`${path}.budget.measured`, "must be a boolean");
      }
      if (budget.measured) {
        if (!Number.isFinite(budget.used) || (budget.used as number) < 0) {
          failValidation(`${path}.budget.used`, "must be a finite number >= 0");
        }
        if (!Number.isFinite(budget.total) || (budget.total as number) <= 0) {
          failValidation(`${path}.budget.total`, "must be a finite number > 0");
        }
        if (budget.window !== undefined) {
          const window = requireRecord(
            budget.window,
            `${path}.budget.window`,
            failValidation,
          );
          requireAllowedKeys(
            window,
            `${path}.budget.window`,
            new Set(["starts_at_ms", "ends_at_ms"]),
            failValidation,
          );
          requireFiniteInteger(
            window.starts_at_ms,
            `${path}.budget.window.starts_at_ms`,
            Number.MIN_SAFE_INTEGER,
            failValidation,
          );
          requireFiniteInteger(
            window.ends_at_ms,
            `${path}.budget.window.ends_at_ms`,
            Number.MIN_SAFE_INTEGER,
            failValidation,
          );
          if ((window.ends_at_ms as number) <= (window.starts_at_ms as number)) {
            failValidation(
              `${path}.budget.window.ends_at_ms`,
              "must be greater than starts_at_ms",
            );
          }
        }
      } else if (
        budget.used !== undefined ||
        budget.total !== undefined ||
        budget.window !== undefined
      ) {
        failValidation(
          `${path}.budget`,
          "must omit used and total, and window when measured is false",
        );
      }
    }
    if (candidate.requested_identity !== undefined) {
      const requested = requireRecord(
        candidate.requested_identity,
        `${path}.requested_identity`,
        failValidation,
      );
      const unknown = Object.keys(requested).find(
        (key) => key !== "runtime" && key !== "model",
      );
      if (unknown !== undefined) {
        failValidation(
          `${path}.requested_identity.${unknown}`,
          "is not allowed; allowed keys are: model, runtime",
        );
      }
      if (requested.runtime === undefined && requested.model === undefined) {
        failValidation(`${path}.requested_identity`, "must name at least one of runtime or model");
      }
      if (requested.runtime !== undefined) {
        requireString(requested.runtime, `${path}.requested_identity.runtime`, failValidation, 256);
      }
      if (requested.model !== undefined) {
        requireString(requested.model, `${path}.requested_identity.model`, failValidation, 256);
      }
    }
    if (candidate.observed_identity !== undefined) {
      const observed = requireRecord(
        candidate.observed_identity,
        `${path}.observed_identity`,
        failValidation,
      );
      const unknown = Object.keys(observed).find(
        (key) => key !== "runtime" && key !== "model" && key !== "source",
      );
      if (unknown !== undefined) {
        failValidation(
          `${path}.observed_identity.${unknown}`,
          "is not allowed; allowed keys are: model, runtime, source",
        );
      }
      if (observed.runtime === undefined && observed.model === undefined) {
        failValidation(`${path}.observed_identity`, "must name at least one of runtime or model");
      }
      if (observed.runtime !== undefined) {
        requireString(observed.runtime, `${path}.observed_identity.runtime`, failValidation, 256);
      }
      if (observed.model !== undefined) {
        requireString(observed.model, `${path}.observed_identity.model`, failValidation, 256);
      }
      requireString(observed.source, `${path}.observed_identity.source`, failValidation, 256);
    }
  }
}
