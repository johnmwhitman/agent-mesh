import { createHash } from "node:crypto";
import {
  compileRouteCandidates,
  ROUTE_CANDIDATE_COMPILER_VERSION,
} from "./compile-route-candidates.js";
import { assertRecommendRouteTask, recommendRoute } from "./recommend-route.js";
import type {
  CompileRouteCandidateObservation,
  CompileRouteCandidatesInput,
  CompileRouteCandidatesResult,
} from "./compile-route-candidates.js";
import type {
  RecommendRouteResult,
  RecommendRouteTask,
  RouteCoordination,
  RouteLocality,
  RoutePrivacy,
} from "./recommend-route.js";

export const ROUTEPLANE_CATALOG_SNAPSHOT_VERSION =
  "meshfleet.routeplane-model-snapshot.v1" as const;

const ROUTEPLANE_MODELS_ENDPOINT = "http://127.0.0.1:4356/v1/models" as const;
const MAX_CATALOG_MODELS = 1_024;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_PROVIDERS_PER_MODEL = 64;
const MAX_PROVIDER_LABEL_LENGTH = 128;
const MAX_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_TTL_MS = 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 5 * 1_000;
const MAX_RESPONSE_BYTES = 1_024 * 1_024;
const MAX_RECOMMENDATION_TOP_N = 256;

export interface RoutePlaneCatalogSnapshot {
  version: typeof ROUTEPLANE_CATALOG_SNAPSHOT_VERSION;
  source: {
    kind: "routeplane-v1-models";
    endpoint: typeof ROUTEPLANE_MODELS_ENDPOINT;
    fetched_at_ms: number;
    expires_at_ms: number;
    payload_sha256: string;
  };
  models: Array<{ id: string; providers: string[] }>;
}

export interface RoutePlaneFetchOptions {
  ttl_ms?: number;
  timeout_ms?: number;
  /** Test-only seam; production always uses the global loopback fetch. */
  fetch_impl?: typeof fetch;
}

export interface RoutePlaneCandidatePolicy {
  candidate_id: string;
  model: string;
  capabilities: string[];
  privacy: RoutePrivacy;
  locality: RouteLocality;
  coordination_modes?: RouteCoordination[];
  policy_tags?: string[];
  context_window?: number;
}

export interface RoutePlaneCandidateCompilation
  extends Omit<CompileRouteCandidatesResult, "diagnostics"> {
  source: RoutePlaneCatalogSnapshot["source"];
  diagnostics: Array<{
    candidate_id: string;
    reason_codes: string[];
  }>;
}

export interface RoutePlaneCatalogRecommendationInput {
  snapshot: RoutePlaneCatalogSnapshot;
  policies: RoutePlaneCandidatePolicy[];
  task: RecommendRouteTask;
  observations?: CompileRouteCandidateObservation[];
  now_ms?: number;
  top_n?: number;
}

/**
 * One explicit loopback refresh followed by the existing pure advisory projection.
 * This does not cache, schedule, execute, authorize, or contact a provider.
 */
export interface FetchRoutePlaneCatalogRecommendationInput
  extends Omit<RoutePlaneCatalogRecommendationInput, "snapshot"> {
  fetch_options?: RoutePlaneFetchOptions;
}

export interface RoutePlaneCatalogRecommendation {
  status: "no_compiled_candidates" | "evaluated";
  advisory: true;
  effects: RecommendRouteResult["effects"];
  source: RoutePlaneCatalogSnapshot["source"];
  compilation: {
    compiler_version: RoutePlaneCandidateCompilation["compiler_version"];
    projection: true;
    diagnostics: RoutePlaneCandidateCompilation["diagnostics"];
  };
  ranked: RecommendRouteResult["ranked"];
  excluded: RecommendRouteResult["excluded"];
}

export type RoutePlaneCatalogErrorCode =
  | "timeout"
  | "redirect"
  | "fetch_failed"
  | "http_status"
  | "body_too_large"
  | "body_read_failed"
  | "invalid_json"
  | "invalid_catalog";

export class RoutePlaneCatalogError extends Error {
  readonly code: RoutePlaneCatalogErrorCode;
  readonly status?: number;

  constructor(code: RoutePlaneCatalogErrorCode, message: string, status?: number) {
    super(message);
    this.name = "RoutePlaneCatalogError";
    this.code = code;
    this.status = status;
  }
}

type RecordValue = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new Error(`RoutePlane catalog: '${path}' ${message}`);
}

function requireRecord(value: unknown, path: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as RecordValue;
}

function requireExactKeys(value: RecordValue, path: string, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) {
    fail(`${path}.${unknown}`, "is not allowed");
  }
  const missing = allowed.find((key) => !(key in value));
  if (missing !== undefined) {
    fail(`${path}.${missing}`, "is required");
  }
}

function requireBoundedString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    fail(path, `must be a non-empty string no longer than ${maxLength} characters`);
  }
  return value;
}

function requireFiniteInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    fail(path, "must be a finite integer");
  }
}

function compilationFail(path: string, message: string): never {
  throw new Error(`compile_routeplane_candidates: '${path}' ${message}`);
}

function requireCompilationRecord(value: unknown, path: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    compilationFail(path, "must be an object");
  }
  return value as RecordValue;
}

function requireCompilationKeys(
  value: RecordValue,
  path: string,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) compilationFail(`${path}.${unknown}`, "is not allowed");
}

function requireCompilationString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    compilationFail(path, "must be a non-empty string no longer than 256 characters");
  }
}

function validateSnapshot(value: unknown): RoutePlaneCatalogSnapshot {
  const snapshot = requireCompilationRecord(value, "snapshot");
  requireCompilationKeys(snapshot, "snapshot", ["version", "source", "models"]);
  if (snapshot.version !== ROUTEPLANE_CATALOG_SNAPSHOT_VERSION) {
    compilationFail(
      "snapshot.version",
      `must equal ${ROUTEPLANE_CATALOG_SNAPSHOT_VERSION}`,
    );
  }
  const source = requireCompilationRecord(snapshot.source, "snapshot.source");
  requireCompilationKeys(snapshot.source as RecordValue, "snapshot.source", [
    "kind",
    "endpoint",
    "fetched_at_ms",
    "expires_at_ms",
    "payload_sha256",
  ]);
  if (source.kind !== "routeplane-v1-models") {
    compilationFail("snapshot.source.kind", 'must equal "routeplane-v1-models"');
  }
  if (source.endpoint !== ROUTEPLANE_MODELS_ENDPOINT) {
    compilationFail("snapshot.source.endpoint", `must equal ${ROUTEPLANE_MODELS_ENDPOINT}`);
  }
  requireFiniteInteger(source.fetched_at_ms, "snapshot.source.fetched_at_ms");
  requireFiniteInteger(source.expires_at_ms, "snapshot.source.expires_at_ms");
  requireCompilationString(source.payload_sha256, "snapshot.source.payload_sha256");
  if (!Array.isArray(snapshot.models)) {
    compilationFail("snapshot.models", "must be an array");
  }

  const payload = {
    object: "list",
    data: snapshot.models.map((modelValue, index) => {
      const path = `snapshot.models[${index}]`;
      const model = requireCompilationRecord(modelValue, path);
      requireCompilationKeys(model, path, ["id", "providers"]);
      requireCompilationString(model.id, `${path}.id`);
      if (!Array.isArray(model.providers)) {
        compilationFail(`${path}.providers`, "must be an array");
      }
      for (let providerIndex = 0; providerIndex < model.providers.length; providerIndex++) {
        requireCompilationString(
          model.providers[providerIndex],
          `${path}.providers[${providerIndex}]`,
        );
      }
      return { id: model.id, object: "model", providers: model.providers };
    }),
  };
  const canonical = normalizeRoutePlaneCatalog(
    payload,
    source.fetched_at_ms as number,
    (source.expires_at_ms as number) - (source.fetched_at_ms as number),
  );
  if (
    canonical.source.payload_sha256 !== source.payload_sha256 ||
    canonical.source.expires_at_ms !== source.expires_at_ms ||
    JSON.stringify(canonical.models) !== JSON.stringify(snapshot.models)
  ) {
    compilationFail("snapshot", "is invalid or not canonical");
  }
  return canonical;
}

function validatePolicies(value: unknown): RoutePlaneCandidatePolicy[] {
  if (!Array.isArray(value) || value.length > 256) {
    compilationFail("policies", "must be an array with 0..256 items");
  }
  const candidateIds = new Set<string>();
  return value.map((policyValue, index) => {
    const policy = requireCompilationRecord(policyValue, `policies[${index}]`);
    requireCompilationString(policy.candidate_id, `policies[${index}].candidate_id`);
    if (candidateIds.has(policy.candidate_id)) {
      compilationFail(
        `policies[${index}].candidate_id`,
        `is a duplicate candidate_id '${policy.candidate_id}'`,
      );
    }
    candidateIds.add(policy.candidate_id);
    requireCompilationString(policy.model, `policies[${index}].model`);
    return policy as unknown as RoutePlaneCandidatePolicy;
  });
}

function validateRecommendationInput(value: unknown): RoutePlaneCatalogRecommendationInput {
  const input = requireCompilationRecord(value, "input");
  requireCompilationKeys(input, "input", [
    "snapshot",
    "policies",
    "task",
    "observations",
    "now_ms",
    "top_n",
  ]);
  for (const required of ["snapshot", "policies", "task"] as const) {
    if (!(required in input)) {
      compilationFail(`input.${required}`, "is required");
    }
  }
  if (
    input.top_n !== undefined &&
    (typeof input.top_n !== "number" ||
      !Number.isFinite(input.top_n) ||
      !Number.isInteger(input.top_n) ||
      input.top_n <= 0 ||
      input.top_n > MAX_RECOMMENDATION_TOP_N)
  ) {
    compilationFail(
      "top_n",
      `must be a finite integer between 1 and ${MAX_RECOMMENDATION_TOP_N}`,
    );
  }
  return input as unknown as RoutePlaneCatalogRecommendationInput;
}

export function compileRoutePlaneCandidates(input: {
  snapshot: RoutePlaneCatalogSnapshot;
  policies: RoutePlaneCandidatePolicy[];
  observations?: CompileRouteCandidateObservation[];
  now_ms?: number;
}): RoutePlaneCandidateCompilation {
  const record = requireCompilationRecord(input, "input");
  requireCompilationKeys(record, "input", ["snapshot", "policies", "observations", "now_ms"]);
  const snapshot = validateSnapshot(record.snapshot);
  const nowMs = record.now_ms ?? Date.now();
  requireFiniteInteger(nowMs, "now_ms");
  if (nowMs < snapshot.source.fetched_at_ms) {
    compilationFail("snapshot", "is future-dated");
  }
  if (nowMs >= snapshot.source.expires_at_ms) {
    compilationFail("snapshot", "is expired");
  }

  const policies = validatePolicies(record.policies);
  const advertisedModels = new Set(snapshot.models.map(({ id }) => id));
  const eligible = policies.filter(({ model }) => advertisedModels.has(model));
  const excluded = policies
    .filter(({ model }) => !advertisedModels.has(model))
    .map(({ candidate_id }) => ({ candidate_id, reason_codes: ["MODEL_NOT_ADVERTISED"] }));
  const excludedCandidateIds = new Set(excluded.map(({ candidate_id }) => candidate_id));

  if (eligible.length === 0) {
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
      source: { ...snapshot.source },
      candidates: [],
      diagnostics: excluded.sort((left, right) =>
        compareStrings(left.candidate_id, right.candidate_id),
      ),
    };
  }

  const inputObservations = record.observations as CompileRouteCandidatesInput["observations"];
  const compilerObservations = inputObservations?.filter((observation) => {
    if (typeof observation !== "object" || observation === null || Array.isArray(observation)) {
      return true;
    }
    return !excludedCandidateIds.has((observation as unknown as RecordValue).candidate_id as string);
  });
  const compiled = compileRouteCandidates({
    manifest: {
      version: ROUTE_CANDIDATE_COMPILER_VERSION,
      candidates: eligible.map(({ model, ...policy }) => ({
        ...policy,
        requested_identity: { runtime: "routeplane", model },
      })),
    },
    ...(compilerObservations === undefined
      ? {}
      : { observations: compilerObservations as CompileRouteCandidatesInput["observations"] }),
  });
  return {
    ...compiled,
    source: { ...snapshot.source },
    diagnostics: [...compiled.diagnostics, ...excluded].sort((left, right) =>
      compareStrings(left.candidate_id, right.candidate_id),
    ),
  };
}

export function recommendRoutePlaneCatalog(
  input: RoutePlaneCatalogRecommendationInput,
): RoutePlaneCatalogRecommendation {
  const validated = validateRecommendationInput(input);
  assertRecommendRouteTask(validated.task);
  const compilation = compileRoutePlaneCandidates({
    snapshot: validated.snapshot,
    policies: validated.policies,
    observations: validated.observations,
    now_ms: validated.now_ms,
  });
  const compilationResult = {
    compiler_version: compilation.compiler_version,
    projection: compilation.projection,
    diagnostics: compilation.diagnostics,
  };

  if (compilation.candidates.length === 0) {
    return {
      status: "no_compiled_candidates",
      advisory: true,
      effects: { ...compilation.effects },
      source: { ...compilation.source },
      compilation: compilationResult,
      ranked: [],
      excluded: [],
    };
  }

  const recommendation = recommendRoute({
    task: validated.task,
    candidates: compilation.candidates,
    ...(validated.top_n === undefined ? {} : { top_n: validated.top_n }),
  });
  return {
    status: "evaluated",
    advisory: recommendation.advisory,
    effects: { ...recommendation.effects },
    source: { ...compilation.source },
    compilation: compilationResult,
    ranked: recommendation.ranked,
    excluded: recommendation.excluded,
  };
}

/**
 * Fetch RoutePlane's current fixed-loopback catalog, then make one advisory
 * recommendation from that exact, expiring snapshot.
 */
export async function fetchAndRecommendRoutePlaneCatalog(
  input: FetchRoutePlaneCatalogRecommendationInput,
): Promise<RoutePlaneCatalogRecommendation> {
  const { fetch_options, ...recommendationInput } = input;
  const snapshot = await fetchRoutePlaneCatalog(fetch_options);
  return recommendRoutePlaneCatalog({ ...recommendationInput, snapshot });
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeRoutePlaneCatalog(
  payload: unknown,
  fetchedAtMs: number,
  ttlMs: number,
): RoutePlaneCatalogSnapshot {
  requireFiniteInteger(fetchedAtMs, "fetched_at_ms");
  if (!Number.isFinite(ttlMs) || !Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
    fail("ttl_ms", `must be a positive finite integer no greater than ${MAX_TTL_MS}`);
  }

  const root = requireRecord(payload, "payload");
  requireExactKeys(root, "payload", ["object", "data"]);
  if (root.object !== "list") {
    fail("payload.object", 'must equal "list"');
  }
  if (!Array.isArray(root.data) || root.data.length > MAX_CATALOG_MODELS) {
    fail("payload.data", `must be an array with 0..${MAX_CATALOG_MODELS} items`);
  }

  const modelIds = new Set<string>();
  const models = root.data.map((modelValue, index) => {
    const path = `payload.data[${index}]`;
    const model = requireRecord(modelValue, path);
    requireExactKeys(model, path, ["id", "object", "providers"]);
    const id = requireBoundedString(model.id, `${path}.id`, MAX_MODEL_ID_LENGTH);
    if (modelIds.has(id)) {
      fail(`${path}.id`, `is a duplicate model id '${id}'`);
    }
    modelIds.add(id);
    if (model.object !== "model") {
      fail(`${path}.object`, 'must equal "model"');
    }
    if (
      !Array.isArray(model.providers) ||
      model.providers.length < 1 ||
      model.providers.length > MAX_PROVIDERS_PER_MODEL
    ) {
      fail(`${path}.providers`, `must be an array with 1..${MAX_PROVIDERS_PER_MODEL} items`);
    }

    const providerLabels = new Set<string>();
    const providers = model.providers.map((provider, providerIndex) => {
      const label = requireBoundedString(
        provider,
        `${path}.providers[${providerIndex}]`,
        MAX_PROVIDER_LABEL_LENGTH,
      );
      if (providerLabels.has(label)) {
        fail(`${path}.providers[${providerIndex}]`, `is a duplicate provider label '${label}'`);
      }
      providerLabels.add(label);
      return label;
    });

    return { id, providers: providers.sort(compareStrings) };
  });

  models.sort((left, right) => compareStrings(left.id, right.id));
  const payloadSha256 = createHash("sha256").update(JSON.stringify(models)).digest("hex");

  return {
    version: ROUTEPLANE_CATALOG_SNAPSHOT_VERSION,
    source: {
      kind: "routeplane-v1-models",
      endpoint: ROUTEPLANE_MODELS_ENDPOINT,
      fetched_at_ms: fetchedAtMs,
      expires_at_ms: fetchedAtMs + ttlMs,
      payload_sha256: payloadSha256,
    },
    models,
  };
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abortBodyRead = () => {
    rejectAbort?.(new Error("RoutePlane catalog request timed out"));
    void reader.cancel().catch(() => {});
  };
  if (signal.aborted) {
    abortBodyRead();
  } else {
    signal.addEventListener("abort", abortBodyRead, { once: true });
  }
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), abortPromise]);
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size violation remains authoritative even if stream cancellation fails.
        }
        throw new RoutePlaneCatalogError("body_too_large", "RoutePlane catalog response exceeds 1 MiB");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RoutePlaneCatalogError) {
      throw error;
    }
    if (signal.aborted) {
      throw new RoutePlaneCatalogError("timeout", "RoutePlane catalog request timed out");
    }
    throw new RoutePlaneCatalogError("body_read_failed", "Unable to read RoutePlane catalog response");
  } finally {
    signal.removeEventListener("abort", abortBodyRead);
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function isRedirectFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/redirect/i.test(error.message) ||
      (error.cause instanceof Error && /redirect/i.test(error.cause.message)))
  );
}

export async function fetchRoutePlaneCatalog(
  options: RoutePlaneFetchOptions = {},
): Promise<RoutePlaneCatalogSnapshot> {
  const ttlMs = options.ttl_ms ?? DEFAULT_TTL_MS;
  const timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isFinite(timeoutMs) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TTL_MS
  ) {
    fail("timeout_ms", `must be a positive finite integer no greater than ${MAX_TTL_MS}`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await (options.fetch_impl ?? fetch)(ROUTEPLANE_MODELS_ENDPOINT, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new RoutePlaneCatalogError("timeout", "RoutePlane catalog request timed out");
      }
      if (isRedirectFailure(error)) {
        throw new RoutePlaneCatalogError("redirect", "RoutePlane catalog redirect was refused");
      }
      throw new RoutePlaneCatalogError("fetch_failed", "Unable to fetch RoutePlane catalog");
    }

    if (!response.ok) {
      throw new RoutePlaneCatalogError(
        "http_status",
        `RoutePlane catalog request returned HTTP ${response.status}`,
        response.status,
      );
    }

    const body = await readBoundedBody(response, controller.signal);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new RoutePlaneCatalogError("invalid_json", "RoutePlane catalog response is not valid JSON");
    }

    try {
      return normalizeRoutePlaneCatalog(payload, Date.now(), ttlMs);
    } catch {
      throw new RoutePlaneCatalogError("invalid_catalog", "RoutePlane catalog response is invalid");
    }
  } finally {
    clearTimeout(timeout);
  }
}
