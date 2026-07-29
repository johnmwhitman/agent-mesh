import { createHash } from "node:crypto";

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

function requireFiniteInteger(value: number, path: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    fail(path, "must be a finite integer");
  }
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

async function readBoundedBody(response: Response): Promise<string> {
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
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
    throw new RoutePlaneCatalogError("body_read_failed", "Unable to read RoutePlane catalog response");
  } finally {
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

    const body = await readBoundedBody(response);
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
