import {
  assertRecommendRouteTask,
  type RecommendRouteCandidate,
  type RecommendRouteInput,
  type RecommendRouteTask,
  type RouteCoordination,
  type RouteLocality,
  type RoutePrivacy,
} from "./recommend-route.js";
import { assertRouteCandidates } from "./route-candidate-validation.js";

export const TASK_CAPABILITY_PROFILE_VERSION = "meshfleet.task-capability-profile.v0.1";

export type TaskCapabilityOperation =
  | "text.generate"
  | "image.generate"
  | "video.generate"
  | "speech.synthesize"
  | "music.generate"
  | "pixel_art.rotate_character"
  | "pixel_art.generate_tileset";

export type TaskCapabilityLifecycle = "inline" | "async_job";

export type TaskCapabilityArtifact =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "sprite_sheet"
  | "tileset";

export interface PrivateArtifactPolicy {
  source_material: "text_only" | "caller_attested_rights";
  review_scope: "private_review_only";
  human_release_required: true;
}

export interface TaskCapabilityTask {
  task_id: string;
  operation: TaskCapabilityOperation;
  lifecycle: TaskCapabilityLifecycle;
  artifact: TaskCapabilityArtifact;
  required_traits: string[];
  optional_traits?: string[];
  privacy: RoutePrivacy;
  locality: RouteLocality;
  coordination?: RouteCoordination;
  policy_tags?: string[];
  min_context_tokens?: number;
  artifact_policy: PrivateArtifactPolicy;
}

export interface TaskCapabilitySupportProfile {
  operation: TaskCapabilityOperation;
  lifecycle: TaskCapabilityLifecycle;
  artifact: TaskCapabilityArtifact;
  traits: string[];
}

export interface TaskCapabilitySurface {
  candidate_id: string;
  profiles: TaskCapabilitySupportProfile[];
  privacy: RoutePrivacy;
  locality: RouteLocality;
  coordination_modes?: RouteCoordination[];
  policy_tags?: string[];
  context_window?: number;
  observed_outcomes?: {
    successes: number;
    failures: number;
  };
  budget?: RecommendRouteCandidate["budget"];
  labels?: {
    brand?: string;
    provider?: string;
    model?: string;
  };
}

export interface CompileTaskCapabilityProfileInput {
  version: typeof TASK_CAPABILITY_PROFILE_VERSION;
  task: TaskCapabilityTask;
  surfaces: TaskCapabilitySurface[];
}

export interface CompileTaskCapabilityProfileResult {
  compiler_version: typeof TASK_CAPABILITY_PROFILE_VERSION;
  advisory: true;
  projection: true;
  status: "ready" | "no_compatible_surfaces";
  gate_order: [
    "private_artifact_policy",
    "capability_profile",
    "downstream_route_budget",
  ];
  task_profile: {
    task_id: string;
    operation: TaskCapabilityOperation;
    lifecycle: TaskCapabilityLifecycle;
    artifact: TaskCapabilityArtifact;
    required_traits: string[];
    optional_traits: string[];
    artifact_policy: PrivateArtifactPolicy;
  };
  route_input: {
    task: RecommendRouteTask;
    candidates: RecommendRouteCandidate[];
  } | null;
  excluded: Array<{
    candidate_id: string;
    reason_codes: Array<
      | "OPERATION_UNSUPPORTED"
      | "LIFECYCLE_UNSUPPORTED"
      | "REQUIRED_TRAIT_MISSING"
    >;
    missing_required_traits?: string[];
  }>;
  identity_labels: Array<{
    candidate_id: string;
    brand?: string;
    provider?: string;
    model?: string;
    evidence_only: true;
  }>;
  effects: {
    persisted: false;
    executed: false;
    authorized: false;
    woke_agents: false;
    contacted_providers: false;
    fetched: false;
    polled: false;
    read_credentials: false;
    inferred_provider: false;
    allocated: false;
    reserved: false;
    scheduled: false;
    spent_budget: false;
    sent: false;
    published: false;
    used_external_identity: false;
  };
}

type RecordValue = Record<string, unknown>;
type Invalid = (path: string, detail: string) => never;

const OPERATIONS: readonly TaskCapabilityOperation[] = [
  "text.generate",
  "image.generate",
  "video.generate",
  "speech.synthesize",
  "music.generate",
  "pixel_art.rotate_character",
  "pixel_art.generate_tileset",
];

const LIFECYCLES: readonly TaskCapabilityLifecycle[] = ["inline", "async_job"];
const ARTIFACTS: readonly TaskCapabilityArtifact[] = [
  "text",
  "image",
  "video",
  "audio",
  "sprite_sheet",
  "tileset",
];

const REQUIRED_ARTIFACT: Record<TaskCapabilityOperation, TaskCapabilityArtifact> = {
  "text.generate": "text",
  "image.generate": "image",
  "video.generate": "video",
  "speech.synthesize": "audio",
  "music.generate": "audio",
  "pixel_art.rotate_character": "sprite_sheet",
  "pixel_art.generate_tileset": "tileset",
};

const ASYNC_ONLY_OPERATIONS = new Set<TaskCapabilityOperation>([
  "video.generate",
  "pixel_art.rotate_character",
  "pixel_art.generate_tileset",
]);

const EFFECTS: CompileTaskCapabilityProfileResult["effects"] = {
  persisted: false,
  executed: false,
  authorized: false,
  woke_agents: false,
  contacted_providers: false,
  fetched: false,
  polled: false,
  read_credentials: false,
  inferred_provider: false,
  allocated: false,
  reserved: false,
  scheduled: false,
  spent_budget: false,
  sent: false,
  published: false,
  used_external_identity: false,
};

function invalid(path: string, detail: string): never {
  throw new Error(`compile_task_capability_profile: '${path}' ${detail}`);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function snapshotBoundedPlainJson(value: unknown): unknown {
  const active = new WeakSet<object>();
  let nodes = 0;

  function shapeFailure(): never {
    invalid("input", "must be bounded plain JSON data");
  }

  function visit(current: unknown, depth: number): unknown {
    nodes += 1;
    if (nodes > 32_768 || depth > 12) shapeFailure();
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) shapeFailure();
      return current;
    }
    if (typeof current === "string") {
      if (current.length > 512) shapeFailure();
      return current;
    }
    if (typeof current !== "object") shapeFailure();

    const object = current as object;
    if (active.has(object)) shapeFailure();
    active.add(object);

    let prototype: object | null;
    let keys: Array<string | symbol>;
    let descriptors: PropertyDescriptorMap;
    try {
      prototype = Object.getPrototypeOf(object);
      keys = Reflect.ownKeys(object);
      descriptors = Object.getOwnPropertyDescriptors(object);
    } catch {
      shapeFailure();
    }

    if (Array.isArray(object)) {
      const lengthDescriptor = descriptors.length;
      if (
        prototype !== Array.prototype ||
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > 256
      ) {
        shapeFailure();
      }
      const length = lengthDescriptor.value as number;
      if (keys.length !== length + 1 || !keys.includes("length")) shapeFailure();
      const snapshot: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const key = String(index);
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          shapeFailure();
        }
        snapshot.push(visit(descriptor.value, depth + 1));
      }
      for (const key of keys) {
        if (
          typeof key !== "string" ||
          (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))
        ) {
          shapeFailure();
        }
      }
      active.delete(object);
      return snapshot;
    }

    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length > 64 ||
      keys.some((key) => typeof key !== "string")
    ) {
      shapeFailure();
    }
    const snapshot = Object.create(null) as RecordValue;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        shapeFailure();
      }
      snapshot[key] = visit(descriptor.value, depth + 1);
    }
    active.delete(object);
    return snapshot;
  }

  return visit(value, 0);
}

function record(value: unknown, path: string, fail: Invalid = invalid): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as RecordValue;
}

function allowedKeys(
  value: RecordValue,
  path: string,
  allowed: readonly string[],
  fail: Invalid = invalid,
): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !accepted.has(key));
  if (unknown !== undefined) fail(path ? `${path}.${unknown}` : unknown, "is not allowed");
}

function string(
  value: unknown,
  path: string,
  maxLength = 128,
  fail: Invalid = invalid,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    fail(path, `must be a non-empty string no longer than ${maxLength} characters`);
  }
}

function token(
  value: unknown,
  path: string,
  maxLength = 64,
  fail: Invalid = invalid,
): asserts value is string {
  string(value, path, maxLength, fail);
  if (!/^[a-z0-9][a-z0-9._:-]*$/.test(value)) {
    fail(path, "must be a lowercase opaque identifier token, not free-form text");
  }
}

function integer(
  value: unknown,
  path: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
  fail: Invalid = invalid,
): asserts value is number {
  if (
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    fail(path, `must be a safe integer between ${minimum} and ${maximum}`);
  }
}

function enumValue<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  fail: Invalid = invalid,
): asserts value is T {
  if (!allowed.includes(value as T)) {
    fail(path, `must be one of ${allowed.join(", ")}`);
  }
}

function uniqueArray<T extends string>(
  value: unknown,
  path: string,
  options: {
    allowed?: readonly T[];
    minItems?: number;
    maxItems?: number;
    tokenValues?: boolean;
    tokenMaxLength?: number;
  } = {},
  fail: Invalid = invalid,
): asserts value is T[] {
  const minItems = options.minItems ?? 0;
  const maxItems = options.maxItems ?? 32;
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    fail(path, `must be an array with ${minItems}..${maxItems} items`);
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const itemPath = `${path}[${index}]`;
    if (options.allowed !== undefined) {
      enumValue(value[index], itemPath, options.allowed, fail);
    } else if (options.tokenValues) {
      token(value[index], itemPath, options.tokenMaxLength ?? 64, fail);
    } else {
      string(value[index], itemPath, 64, fail);
    }
    const item = value[index] as string;
    if (seen.has(item)) fail(path, `contains duplicate value '${item}'`);
    seen.add(item);
  }
}

function validateArtifactPolicy(value: unknown, path: string): asserts value is PrivateArtifactPolicy {
  const policy = record(value, path);
  allowedKeys(policy, path, [
    "source_material",
    "review_scope",
    "human_release_required",
  ]);
  if (!["text_only", "caller_attested_rights"].includes(policy.source_material as string)) {
    invalid(`${path}.source_material`, "must be text_only or caller_attested_rights");
  }
  if (policy.review_scope !== "private_review_only") {
    invalid(`${path}.review_scope`, "must equal private_review_only");
  }
  if (policy.human_release_required !== true) {
    invalid(`${path}.human_release_required`, "must equal true");
  }
}

function validateTask(value: unknown): asserts value is TaskCapabilityTask {
  const task = record(value, "task");
  allowedKeys(task, "task", [
    "task_id",
    "operation",
    "lifecycle",
    "artifact",
    "required_traits",
    "optional_traits",
    "privacy",
    "locality",
    "coordination",
    "policy_tags",
    "min_context_tokens",
    "artifact_policy",
  ]);
  token(task.task_id, "task.task_id", 128);
  enumValue(task.operation, "task.operation", OPERATIONS);
  enumValue(task.lifecycle, "task.lifecycle", LIFECYCLES);
  enumValue(task.artifact, "task.artifact", ARTIFACTS);
  if (task.artifact !== REQUIRED_ARTIFACT[task.operation]) {
    invalid(
      "task.artifact",
      `must equal ${REQUIRED_ARTIFACT[task.operation]} for ${task.operation}`,
    );
  }
  if (ASYNC_ONLY_OPERATIONS.has(task.operation) && task.lifecycle !== "async_job") {
    invalid("task.lifecycle", `must equal async_job for ${task.operation}`);
  }
  uniqueArray(task.required_traits, "task.required_traits", {
    tokenValues: true,
    tokenMaxLength: 58,
  });
  if (task.optional_traits !== undefined) {
    uniqueArray(task.optional_traits, "task.optional_traits", {
      tokenValues: true,
      tokenMaxLength: 58,
    });
    const required = new Set(task.required_traits);
    const repeated = task.optional_traits.find((trait) => required.has(trait));
    if (repeated !== undefined) {
      invalid("task.optional_traits", `must not repeat required trait '${repeated}'`);
    }
  }
  enumValue(task.privacy, "task.privacy", ["local_only", "network_ok", "unrestricted"]);
  enumValue(task.locality, "task.locality", ["same_host", "same_fleet", "any"]);
  if (task.coordination !== undefined) {
    enumValue(task.coordination, "task.coordination", ["solo", "pair_discussion"]);
  }
  if (task.policy_tags !== undefined) {
    uniqueArray(task.policy_tags, "task.policy_tags", { tokenValues: true });
  }
  if (task.min_context_tokens !== undefined) {
    integer(task.min_context_tokens, "task.min_context_tokens", 0);
  }
  validateArtifactPolicy(task.artifact_policy, "task.artifact_policy");
}

function validateBudget(value: unknown, path: string): void {
  const budget = record(value, path);
  allowedKeys(budget, path, ["measured", "used", "total", "window"]);
  if (typeof budget.measured !== "boolean") invalid(`${path}.measured`, "must be a boolean");
  if (!budget.measured) {
    if ("used" in budget || "total" in budget || "window" in budget) {
      invalid(path, "must omit used, total, and window when measured is false");
    }
    return;
  }
  if (!Number.isFinite(budget.used) || (budget.used as number) < 0) {
    invalid(`${path}.used`, "must be a finite number >= 0");
  }
  if (!Number.isFinite(budget.total) || (budget.total as number) <= 0) {
    invalid(`${path}.total`, "must be a finite number > 0");
  }
  if (budget.window !== undefined) {
    const window = record(budget.window, `${path}.window`);
    allowedKeys(window, `${path}.window`, ["starts_at_ms", "ends_at_ms"]);
    integer(window.starts_at_ms, `${path}.window.starts_at_ms`, Number.MIN_SAFE_INTEGER);
    integer(window.ends_at_ms, `${path}.window.ends_at_ms`, Number.MIN_SAFE_INTEGER);
    if ((window.ends_at_ms as number) <= (window.starts_at_ms as number)) {
      invalid(`${path}.window.ends_at_ms`, "must be greater than starts_at_ms");
    }
  }
}

function validateSupportProfile(
  value: unknown,
  path: string,
): asserts value is TaskCapabilitySupportProfile {
  const profile = record(value, path);
  allowedKeys(profile, path, ["operation", "lifecycle", "artifact", "traits"]);
  enumValue(profile.operation, `${path}.operation`, OPERATIONS);
  enumValue(profile.lifecycle, `${path}.lifecycle`, LIFECYCLES);
  enumValue(profile.artifact, `${path}.artifact`, ARTIFACTS);
  if (profile.artifact !== REQUIRED_ARTIFACT[profile.operation]) {
    invalid(
      `${path}.artifact`,
      `must equal ${REQUIRED_ARTIFACT[profile.operation]} for ${profile.operation}`,
    );
  }
  if (
    ASYNC_ONLY_OPERATIONS.has(profile.operation) &&
    profile.lifecycle !== "async_job"
  ) {
    invalid(`${path}.lifecycle`, `must equal async_job for ${profile.operation}`);
  }
  uniqueArray(profile.traits, `${path}.traits`, {
    tokenValues: true,
    tokenMaxLength: 58,
  });
}

function validateSurface(value: unknown, path: string): asserts value is TaskCapabilitySurface {
  const surface = record(value, path);
  allowedKeys(surface, path, [
    "candidate_id",
    "profiles",
    "privacy",
    "locality",
    "coordination_modes",
    "policy_tags",
    "context_window",
    "observed_outcomes",
    "budget",
    "labels",
  ]);
  token(surface.candidate_id, `${path}.candidate_id`, 128);
  if (
    !Array.isArray(surface.profiles) ||
    surface.profiles.length < 1 ||
    surface.profiles.length > 16
  ) {
    invalid(`${path}.profiles`, "must be an array with 1..16 items");
  }
  const profileSignatures = new Set<string>();
  for (let index = 0; index < surface.profiles.length; index++) {
    validateSupportProfile(surface.profiles[index], `${path}.profiles[${index}]`);
    const profile = surface.profiles[index] as TaskCapabilitySupportProfile;
    const signature = [
      profile.operation,
      profile.lifecycle,
      profile.artifact,
      [...profile.traits].sort(compareStrings).join(","),
    ].join("|");
    if (profileSignatures.has(signature)) {
      invalid(`${path}.profiles[${index}]`, "duplicates another support profile");
    }
    profileSignatures.add(signature);
  }
  enumValue(surface.privacy, `${path}.privacy`, ["local_only", "network_ok", "unrestricted"]);
  enumValue(surface.locality, `${path}.locality`, ["same_host", "same_fleet", "any"]);
  if (surface.coordination_modes !== undefined) {
    uniqueArray(surface.coordination_modes, `${path}.coordination_modes`, {
      allowed: ["solo", "pair_discussion"],
      minItems: 1,
      maxItems: 2,
    });
  }
  if (surface.policy_tags !== undefined) {
    uniqueArray(surface.policy_tags, `${path}.policy_tags`, { tokenValues: true });
  }
  if (surface.context_window !== undefined) {
    integer(surface.context_window, `${path}.context_window`, 0);
  }
  if (surface.observed_outcomes !== undefined) {
    const outcomes = record(surface.observed_outcomes, `${path}.observed_outcomes`);
    allowedKeys(outcomes, `${path}.observed_outcomes`, ["successes", "failures"]);
    integer(outcomes.successes, `${path}.observed_outcomes.successes`, 0, 1_000_000);
    integer(outcomes.failures, `${path}.observed_outcomes.failures`, 0, 1_000_000);
  }
  if (surface.budget !== undefined) validateBudget(surface.budget, `${path}.budget`);
  if (surface.labels !== undefined) {
    const labels = record(surface.labels, `${path}.labels`);
    allowedKeys(labels, `${path}.labels`, ["brand", "provider", "model"]);
    if (Object.keys(labels).length === 0) invalid(`${path}.labels`, "must name at least one label");
    for (const label of ["brand", "provider", "model"] as const) {
      if (labels[label] !== undefined) string(labels[label], `${path}.labels.${label}`, 128);
    }
  }
}

function validateInput(value: unknown): CompileTaskCapabilityProfileInput {
  const input = record(snapshotBoundedPlainJson(value), "input");
  allowedKeys(input, "", ["version", "task", "surfaces"]);
  if (input.version !== TASK_CAPABILITY_PROFILE_VERSION) {
    invalid("version", `must equal ${TASK_CAPABILITY_PROFILE_VERSION}`);
  }

  // Task policy is intentionally validated before any candidate budget evidence.
  validateTask(input.task);

  if (
    !Array.isArray(input.surfaces) ||
    input.surfaces.length < 1 ||
    input.surfaces.length > 128
  ) {
    invalid("surfaces", "must be an array with 1..128 items");
  }
  const candidateIds = new Set<string>();
  for (let index = 0; index < input.surfaces.length; index++) {
    validateSurface(input.surfaces[index], `surfaces[${index}]`);
    const candidateId = (input.surfaces[index] as TaskCapabilitySurface).candidate_id;
    if (candidateIds.has(candidateId)) {
      invalid(
        `surfaces[${index}].candidate_id`,
        `is a duplicate candidate_id '${candidateId}'`,
      );
    }
    candidateIds.add(candidateId);
  }
  return input as unknown as CompileTaskCapabilityProfileInput;
}

function capabilityTokens(profile: TaskCapabilitySupportProfile): string[] {
  return [
    `operation:${profile.operation}`,
    `lifecycle:${profile.lifecycle}`,
    `artifact:${profile.artifact}`,
    ...profile.traits.map((trait) => `trait:${trait}`),
  ].sort(compareStrings);
}

function taskRequiredCapabilities(task: TaskCapabilityTask): string[] {
  return [
    `operation:${task.operation}`,
    `lifecycle:${task.lifecycle}`,
    `artifact:${task.artifact}`,
    ...task.required_traits.map((trait) => `trait:${trait}`),
  ].sort(compareStrings);
}

function projectedTask(task: TaskCapabilityTask): RecommendRouteTask {
  return {
    required_capabilities: taskRequiredCapabilities(task),
    optional_capabilities: task.optional_traits
      ?.map((trait) => `trait:${trait}`)
      .sort(compareStrings) ?? [],
    privacy: task.privacy,
    locality: task.locality,
    ...(task.coordination === undefined ? {} : { coordination: task.coordination }),
    policy_tags: [...(task.policy_tags ?? [])].sort(compareStrings),
    ...(task.min_context_tokens === undefined
      ? {}
      : { min_context_tokens: task.min_context_tokens }),
  };
}

function projectedCandidate(
  surface: TaskCapabilitySurface,
  profile: TaskCapabilitySupportProfile,
): RecommendRouteCandidate {
  return {
    candidate_id: surface.candidate_id,
    capabilities: capabilityTokens(profile),
    privacy: surface.privacy,
    locality: surface.locality,
    ...(surface.coordination_modes === undefined
      ? {}
      : { coordination_modes: [...surface.coordination_modes].sort(compareStrings) }),
    policy_tags: [...(surface.policy_tags ?? [])].sort(compareStrings),
    ...(surface.context_window === undefined
      ? {}
      : { context_window: surface.context_window }),
    ...(surface.observed_outcomes === undefined
      ? {}
      : {
        observed_outcomes: {
          successes: surface.observed_outcomes.successes,
          failures: surface.observed_outcomes.failures,
        },
      }),
    ...(surface.budget === undefined
      ? {}
      : {
        budget: surface.budget.measured
          ? {
            measured: true,
            used: surface.budget.used,
            total: surface.budget.total,
            ...(surface.budget.window === undefined
              ? {}
              : {
                window: {
                  starts_at_ms: surface.budget.window.starts_at_ms,
                  ends_at_ms: surface.budget.window.ends_at_ms,
                },
              }),
          }
          : { measured: false },
      }),
  };
}

function profileSignature(profile: TaskCapabilitySupportProfile): string {
  return [
    profile.operation,
    profile.lifecycle,
    profile.artifact,
    [...profile.traits].sort(compareStrings).join(","),
  ].join("|");
}

function selectProfile(
  task: TaskCapabilityTask,
  surface: TaskCapabilitySurface,
):
  | { profile: TaskCapabilitySupportProfile; missing_required_traits: [] }
  | {
    reason_code:
      | "OPERATION_UNSUPPORTED"
      | "LIFECYCLE_UNSUPPORTED"
      | "REQUIRED_TRAIT_MISSING";
    missing_required_traits: string[];
  } {
  const operationProfiles = surface.profiles.filter(
    (profile) => profile.operation === task.operation,
  );
  if (operationProfiles.length === 0) {
    return { reason_code: "OPERATION_UNSUPPORTED", missing_required_traits: [] };
  }
  const lifecycleProfiles = operationProfiles.filter(
    (profile) =>
      profile.lifecycle === task.lifecycle &&
      profile.artifact === task.artifact,
  );
  if (lifecycleProfiles.length === 0) {
    return { reason_code: "LIFECYCLE_UNSUPPORTED", missing_required_traits: [] };
  }
  const evaluated = lifecycleProfiles
    .map((profile) => ({
      profile,
      missing: task.required_traits
        .filter((trait) => !profile.traits.includes(trait))
        .sort(compareStrings),
      optionalHits: (task.optional_traits ?? [])
        .filter((trait) => profile.traits.includes(trait))
        .length,
    }))
    .sort(
      (left, right) =>
        left.missing.length - right.missing.length ||
        compareStrings(left.missing.join(","), right.missing.join(",")) ||
        right.optionalHits - left.optionalHits ||
        compareStrings(profileSignature(left.profile), profileSignature(right.profile)),
    );
  const best = evaluated[0]!;
  if (best.missing.length > 0) {
    return {
      reason_code: "REQUIRED_TRAIT_MISSING",
      missing_required_traits: best.missing,
    };
  }
  return { profile: best.profile, missing_required_traits: [] };
}

export function compileTaskCapabilityProfile(
  input: CompileTaskCapabilityProfileInput,
): CompileTaskCapabilityProfileResult {
  const validatedInput = validateInput(input);
  const task = validatedInput.task;
  const surfaces = [...validatedInput.surfaces].sort((left, right) =>
    compareStrings(left.candidate_id, right.candidate_id)
  );
  const candidates: RecommendRouteCandidate[] = [];
  const excluded: CompileTaskCapabilityProfileResult["excluded"] = [];
  const identityLabels: CompileTaskCapabilityProfileResult["identity_labels"] = [];

  for (const surface of surfaces) {
    const selection = selectProfile(task, surface);
    if ("profile" in selection) {
      candidates.push(projectedCandidate(surface, selection.profile));
    } else {
      excluded.push({
        candidate_id: surface.candidate_id,
        reason_codes: [selection.reason_code],
        ...(selection.missing_required_traits.length === 0
          ? {}
          : { missing_required_traits: selection.missing_required_traits }),
      });
    }

    if (surface.labels !== undefined) {
      identityLabels.push({
        candidate_id: surface.candidate_id,
        ...(surface.labels.brand === undefined ? {} : { brand: surface.labels.brand }),
        ...(surface.labels.provider === undefined ? {} : { provider: surface.labels.provider }),
        ...(surface.labels.model === undefined ? {} : { model: surface.labels.model }),
        evidence_only: true,
      });
    }
  }

  const routeInput: RecommendRouteInput | null = candidates.length === 0
    ? null
    : {
      task: projectedTask(task),
      candidates,
    };
  if (routeInput !== null) {
    assertRecommendRouteTask(routeInput.task);
    assertRouteCandidates(routeInput.candidates, {
      errorPrefix: "compile_task_capability_profile",
      path: "route_input.candidates",
    });
  }

  return {
    compiler_version: TASK_CAPABILITY_PROFILE_VERSION,
    advisory: true,
    projection: true,
    status: routeInput === null ? "no_compatible_surfaces" : "ready",
    gate_order: [
      "private_artifact_policy",
      "capability_profile",
      "downstream_route_budget",
    ],
    task_profile: {
      task_id: task.task_id,
      operation: task.operation,
      lifecycle: task.lifecycle,
      artifact: task.artifact,
      required_traits: [...task.required_traits].sort(compareStrings),
      optional_traits: [...(task.optional_traits ?? [])].sort(compareStrings),
      artifact_policy: {
        source_material: task.artifact_policy.source_material,
        review_scope: "private_review_only",
        human_release_required: true,
      },
    },
    route_input: routeInput,
    excluded,
    identity_labels: identityLabels,
    effects: { ...EFFECTS },
  };
}
