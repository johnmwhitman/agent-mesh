/**
 * MeshFleet → RoutePlane provider endpoint (intelligent-router shim)
 *
 * Profiles set `model: routeplane/intelligent-router` and the MeshFleet
 * SSE server routes that name to this handler, which exposes a single
 * OpenAI-style chat completions surface that:
 *
 *   1. Forwards the request body to the running RoutePlane daemon
 *      (default loopback `http://127.0.0.1:4356/v1/chat/completions`).
 *   2. Surfaces the routing receipt in the response `metadata` block AND
 *      in an `x-meshfleet-router-receipt` header so profiles can audit
 *      which pool served them.
 *   3. Degrades gracefully to a clearly-marked static chain with a
 *      visible receipt when the RoutePlane daemon is unreachable — the
 *      receipt is the audit signal that the fallthrough ran.
 *
 * Auth boundaries:
 *   - MeshFleet reads its own auth token (MESHFLEET_SSE_TOKEN or
 *     MESHFLEET_AUTH_TOKEN) for inbound calls — never reads RoutePlane
 *     secrets.
 *   - The router is invoked via loopback only; credentials for upstream
 *     providers live in RoutePlane's own daemon and are not passed
 *     through MeshFleet.
 *
 * The endpoint deliberately does NOT:
 *   - Persist any state.
 *   - Wake agents or dispatch fleets.
 *   - Resolve upstream provider secrets.
 *   - Cache chat-completion responses.
 *   - Read profile config.yaml (the seam is between the SSE server and
 *     the profile, not this module).
 *
 * Source-of-truth seams:
 *   - src/routeplane-catalog.ts:23  — RoutePlane `/v1/models` endpoint
 *   - src/sse-server.ts            — HTTP listener that mounts this handler
 *
 * DESIGN-DOC EVIDENCE
 *   - /Users/johnwhitman/AI/docs/architecture/smart-router-design-2026-08-29.md §1-§5
 *     (scoring formula, fallthrough contract, provider contract)
 *   - /Users/johnwhitman/AI/docs/architecture/hermes-routeplane-meshfleet-integration-2026-08-29.md
 *     §5 (proposed smart-router surface)
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Schema version emitted by this endpoint. Profiles that target
 * `routeplane/intelligent-router` can pin against this id and refuse
 * upgrades if their harness has not been updated.
 */
export const ROUTEPLANE_PROVIDER_ENDPOINT_VERSION =
  "meshfleet.routeplane-provider-endpoint.v1" as const;

/**
 * Schema id the response receipt carries. Stable so audit tooling can
 * rely on the field set.
 */
export const ROUTEPLANE_PROVIDER_RECEIPT_VERSION =
  "meshfleet.routeplane-provider-receipt.v1" as const;

/** Default upstream RoutePlane chat completions endpoint (loopback). */
export const DEFAULT_ROUTEPLANE_CHAT_COMPLETIONS_URL =
  "http://127.0.0.1:4356/v1/chat/completions" as const;

/** Default liveness probe endpoint (RoutePlane `/v1/models`). */
export const DEFAULT_ROUTEPLANE_LIVENESS_URL =
  "http://127.0.0.1:4356/v1/models" as const;

/** Hard upper bound on the request body the endpoint will accept. */
export const MAX_REQUEST_BYTES = 256 * 1024;

/** Hard upper bound on the response body the endpoint will accept. */
export const MAX_UPSTREAM_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Default upstream call timeout. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

/** Hard upper bound on the upstream call timeout. */
export const MAX_UPSTREAM_TIMEOUT_MS = 5 * 60 * 1_000;

/** Static fallback chain used when the router is unreachable. */
export const DEFAULT_FALLBACK_CHAIN: ReadonlyArray<string> = [
  "openai-codex",
  "anthropic",
  "opencode-go",
];

export type ProviderDegradationReason =
  | "router_unreachable"
  | "router_timeout"
  | "router_redirect_refused"
  | "router_http_status"
  | "router_invalid_response"
  | "router_body_too_large";

export type ProviderReceiptOutcome =
  | "routed"
  | "fallthrough_static"
  | "refused_malformed"
  | "refused_unauthorized";

export interface ProviderRoutingReceipt {
  schema_version: typeof ROUTEPLANE_PROVIDER_RECEIPT_VERSION;
  receipt_id: string;
  decision_id: string;
  profile_id: string | null;
  outcome: ProviderReceiptOutcome;
  /** Resolved provider / model chain (routed or fallback). */
  chain: ReadonlyArray<string>;
  /** Upstream URL the request was forwarded to (or attempted). */
  upstream_url: string;
  /** Time spent in this endpoint (ms). */
  duration_ms: number;
  /** Captured at endpoint entry. */
  received_at_ms: number;
  /** Set when outcome is `routed` or `fallthrough_static`. */
  chosen_model?: string;
  /** Set when outcome is `fallthrough_static`. */
  degradation_reason?: ProviderDegradationReason;
  /** Hex digest of the response body the caller received (when applicable). */
  response_sha256?: string;
  /** Diagnostic details — keys are sanitized to avoid leaking caller content. */
  diagnostics?: {
    upstream_status?: number;
    upstream_bytes?: number;
    static_chain_source?: "configured" | "default";
    auth_token_present?: boolean;
  };
}

export interface ProviderEndpointOptions {
  /** Upstream RoutePlane chat completions URL. Test-only seam. */
  upstream_url?: string;
  /** Upstream RoutePlane liveness URL. Test-only seam. */
  liveness_url?: string;
  /** Static fallback chain — used when router is unreachable. */
  fallback_chain?: ReadonlyArray<string>;
  /** Upstream call timeout in ms. */
  timeout_ms?: number;
  /** Auth check for inbound calls. Test-only seam; production wires SSE token. */
  authorize?: (req: IncomingMessage) => boolean;
  /** Optional clock seam. Test-only. */
  now_ms?: () => number;
  /** Optional fetch seam. Test-only. */
  fetch_impl?: typeof fetch;
}

/**
 * Resolve a profile id from inbound headers (X-MeshFleet-Profile) or
 * `model` field. Returns null when no profile id is identifiable.
 */
export function readProfileId(req: IncomingMessage, body: Record<string, unknown>): string | null {
  const header = req.headers["x-meshfleet-profile"];
  if (typeof header === "string" && header.trim().length > 0 && header.length <= 256) {
    return header;
  }
  if (Array.isArray(header)) {
    const first = header.find((v) => typeof v === "string" && v.trim().length > 0);
    if (typeof first === "string") return first;
  }
  const bodyProfile = body.profile_id;
  if (typeof bodyProfile === "string" && bodyProfile.trim().length > 0 && bodyProfile.length <= 256) {
    return bodyProfile;
  }
  return null;
}

/** Validate the OpenAI-style chat completions body to the minimum schema. */
export function validateChatCompletionsBody(
  body: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: "body must be a JSON object" };
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.messages) || record.messages.length === 0) {
    return { ok: false, reason: "messages must be a non-empty array" };
  }
  for (let index = 0; index < record.messages.length; index++) {
    const message = record.messages[index];
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return { ok: false, reason: `messages[${index}] must be an object` };
    }
    const m = message as Record<string, unknown>;
    if (typeof m.role !== "string" || m.role.length === 0) {
      return { ok: false, reason: `messages[${index}].role must be a non-empty string` };
    }
    if (typeof m.content !== "string" && !Array.isArray(m.content)) {
      return { ok: false, reason: `messages[${index}].content must be a string or array` };
    }
  }
  if (record.model !== undefined && typeof record.model !== "string") {
    return { ok: false, reason: "model, when supplied, must be a string" };
  }
  return { ok: true, value: record };
}

/** Bounded body reader. */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: string }> {
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve({ ok: false, reason: `request body exceeded ${maxBytes} bytes` });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve({ ok: true, bytes: Buffer.concat(chunks) }));
    req.on("error", (error) => resolve({ ok: false, reason: `body read failed: ${error.message}` }));
  });
}

/** Send a JSON response with a deterministic status. */
function sendJson(res: ServerResponse, status: number, payload: unknown, receipt?: ProviderRoutingReceipt): void {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    "Cache-Control": "no-store",
  };
  if (receipt) {
    headers["X-MeshFleet-Router-Receipt"] = JSON.stringify(receipt);
  }
  res.writeHead(status, headers);
  res.end(body);
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Construct a default bearer-token check that compares against the
 * `MESHFLEET_SSE_TOKEN` env var (the same token the SSE server uses for
 * the inbox + A2A endpoints — keeping auth boundaries aligned).
 *
 * Returned function is async-friendly but synchronous: it answers before
 * the request body is consumed so a missing token short-circuits
 * cheaply.
 */
export function authorizeFromEnv(env: NodeJS.ProcessEnv = process.env): (req: IncomingMessage) => boolean {
  const expected = env.MESHFLEET_SSE_TOKEN?.trim() || env.MESHFLEET_AUTH_TOKEN?.trim() || "";
  if (!expected) {
    return () => true;
  }
  return (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    if (typeof header !== "string") return false;
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    return timingSafeEqualStrings(match[1], expected);
  };
}

/**
 * Forward the chat completions body to the upstream RoutePlane daemon.
 * Returns either a routed response or a fallthrough signal. This function
 * is pure relative to `fetch_impl` and the clock seam; it does not own
 * the HTTP socket.
 */
export async function invokeUpstreamRouter(
  body: string,
  options: ProviderEndpointOptions & { upstream_url: string; timeout_ms: number; fetch_impl: typeof fetch },
): Promise<
  | { kind: "routed"; upstream_status: number; response_bytes: Buffer }
  | { kind: "fallthrough"; reason: ProviderDegradationReason; upstream_status?: number }
> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), options.timeout_ms);
  try {
    let response: Response;
    try {
      response = await options.fetch_impl(options.upstream_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return { kind: "fallthrough", reason: "router_timeout" };
      }
      const message = String((error as Error)?.message ?? "");
      if (/redirect/i.test(message)) {
        return { kind: "fallthrough", reason: "router_redirect_refused" };
      }
      return { kind: "fallthrough", reason: "router_unreachable" };
    } finally {
      clearTimeout(timeoutHandle);
    }
    if (!response.ok) {
      return {
        kind: "fallthrough",
        reason: "router_http_status",
        upstream_status: response.status,
      };
    }
    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    if (bytes.length > MAX_UPSTREAM_RESPONSE_BYTES) {
      return {
        kind: "fallthrough",
        reason: "router_body_too_large",
        upstream_status: response.status,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      return {
        kind: "fallthrough",
        reason: "router_invalid_response",
        upstream_status: response.status,
      };
    }
    return { kind: "routed", upstream_status: response.status, response_bytes: bytes };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Synthesize a fallback chat completions response from the static chain.
 * The response is the canonical OpenAI shape with `metadata.routing_receipt`
 * populated and a `choices` entry that points at the fallback head so the
 * caller gets a real (if static) answer instead of an empty payload.
 */
export function buildFallbackChatCompletionsResponse(
  body: Record<string, unknown>,
  chain: ReadonlyArray<string>,
  fallbackModel: string,
): Record<string, unknown> {
  const id = `fallthrough-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  return {
    id,
    object: "chat.completion",
    created,
    model: fallbackModel,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content:
            "[meshfleet-routeplane-fallthrough] RoutePlane router was unreachable; static chain fallback served. " +
            "Inspect response.metadata.routing_receipt for the audit trail.",
        },
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    metadata: {
      routeplane_static_fallback: true,
      static_chain: chain,
      original_model_hint: typeof body.model === "string" ? body.model : null,
    },
  };
}

export interface InvokeProviderEndpointInput extends ProviderEndpointOptions {
  req: IncomingMessage;
  res: ServerResponse;
  baseUrl: string;
  /** Caller-provided clock (test seam). */
  now_ms?: () => number;
}

/**
 * Single entry point for the SSE server to mount `/v1/chat/completions`.
 * Wires auth, request validation, router forwarding, fallback, and the
 * always-emitted receipt.
 */
export async function handleProviderChatCompletions(
  input: InvokeProviderEndpointInput,
): Promise<void> {
  const startedAt = (input.now_ms ?? Date.now)();
  const upstreamUrl = input.upstream_url ?? DEFAULT_ROUTEPLANE_CHAT_COMPLETIONS_URL;
  const fallbackChain = input.fallback_chain ?? DEFAULT_FALLBACK_CHAIN;
  const timeoutMs = Math.min(
    Math.max(input.timeout_ms ?? DEFAULT_UPSTREAM_TIMEOUT_MS, 1),
    MAX_UPSTREAM_TIMEOUT_MS,
  );
  const authorize = input.authorize ?? authorizeFromEnv();
  const fetchImpl = input.fetch_impl ?? fetch;

  const receiptId = randomUUID();
  const decisionId = randomUUID();

  if (!authorize(input.req)) {
    const now = (input.now_ms ?? Date.now)();
    const receipt: ProviderRoutingReceipt = {
      schema_version: ROUTEPLANE_PROVIDER_RECEIPT_VERSION,
      receipt_id: receiptId,
      decision_id: decisionId,
      profile_id: null,
      outcome: "refused_unauthorized",
      chain: [],
      upstream_url: upstreamUrl,
      duration_ms: now - startedAt,
      received_at_ms: startedAt,
      diagnostics: { auth_token_present: false },
    };
    sendJson(input.res, 401, { error: "unauthorized", routing_receipt: receipt }, receipt);
    return;
  }

  if (input.req.method !== "POST") {
    const now = (input.now_ms ?? Date.now)();
    const receipt: ProviderRoutingReceipt = {
      schema_version: ROUTEPLANE_PROVIDER_RECEIPT_VERSION,
      receipt_id: receiptId,
      decision_id: decisionId,
      profile_id: null,
      outcome: "refused_malformed",
      chain: [],
      upstream_url: upstreamUrl,
      duration_ms: now - startedAt,
      received_at_ms: startedAt,
    };
    sendJson(input.res, 405, { error: "method not allowed; use POST", routing_receipt: receipt }, receipt);
    return;
  }

  // Cheap content-length check up front. Returning 400 cleanly is friendlier
  // to callers than destroying the socket mid-stream — the a2a handler in
  // src/a2a/http.ts uses the same pattern.
  const declaredLength = Number(input.req.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    const now = (input.now_ms ?? Date.now)();
    const receipt: ProviderRoutingReceipt = {
      schema_version: ROUTEPLANE_PROVIDER_RECEIPT_VERSION,
      receipt_id: receiptId,
      decision_id: decisionId,
      profile_id: null,
      outcome: "refused_malformed",
      chain: [],
      upstream_url: upstreamUrl,
      duration_ms: now - startedAt,
      received_at_ms: startedAt,
    };
    sendJson(input.res, 400, { error: `request body exceeds ${MAX_REQUEST_BYTES} bytes`, routing_receipt: receipt }, receipt);
    input.req.resume();
    return;
  }

  const bodyResult = await readBody(input.req, MAX_REQUEST_BYTES);
  const nowAfterBody = (input.now_ms ?? Date.now)();
  if (!bodyResult.ok) {
    const receipt: ProviderRoutingReceipt = {
      schema_version: ROUTEPLANE_PROVIDER_RECEIPT_VERSION,
      receipt_id: receiptId,
      decision_id: decisionId,
      profile_id: null,
      outcome: "refused_malformed",
      chain: [],
      upstream_url: upstreamUrl,
      duration_ms: nowAfterBody - startedAt,
      received_at_ms: startedAt,
    };
    sendJson(input.res, 400, { error: bodyResult.reason, routing_receipt: receipt }, receipt);
    return;
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(bodyResult.bytes.toString("utf8"));
  } catch {
    const receipt: ProviderRoutingReceipt = {
      schema_version: ROUTEPLANE_PROVIDER_RECEIPT_VERSION,
      receipt_id: receiptId,
      decision_id: decisionId,
      profile_id: null,
      outcome: "refused_malformed",
      chain: [],
      upstream_url: upstreamUrl,
      duration_ms: nowAfterBody - startedAt,
      received_at_ms: startedAt,
    };
    sendJson(input.res, 400, { error: "request body is not valid JSON", routing_receipt: receipt }, receipt);
    return;
  }

  const validation = validateChatCompletionsBody(parsedBody);
  if (!validation.ok) {
    const receipt: ProviderRoutingReceipt = {
      schema_version: ROUTEPLANE_PROVIDER_RECEIPT_VERSION,
      receipt_id: receiptId,
      decision_id: decisionId,
      profile_id: null,
      outcome: "refused_malformed",
      chain: [],
      upstream_url: upstreamUrl,
      duration_ms: nowAfterBody - startedAt,
      received_at_ms: startedAt,
    };
    sendJson(input.res, 400, { error: validation.reason, routing_receipt: receipt }, receipt);
    return;
  }

  const body = validation.value;
  const profileId = readProfileId(input.req, body);

  const upstreamBody = JSON.stringify({
    ...body,
    profile_id: profileId ?? body.profile_id ?? null,
  });
  const upstreamResult = await invokeUpstreamRouter(upstreamBody, {
    upstream_url: upstreamUrl,
    timeout_ms: timeoutMs,
    fetch_impl: fetchImpl,
  });

  const finishedAt = (input.now_ms ?? Date.now)();
  if (upstreamResult.kind === "routed") {
    let parsedResponse: unknown;
    try {
      parsedResponse = JSON.parse(upstreamResult.response_bytes.toString("utf8"));
    } catch {
      const receipt: ProviderRoutingReceipt = {
        schema_version: ROUTEPLANE_PROVIDER_RECEIPT_VERSION,
        receipt_id: receiptId,
        decision_id: decisionId,
        profile_id: profileId,
        outcome: "routed",
        chain: [],
        upstream_url: upstreamUrl,
        duration_ms: finishedAt - startedAt,
        received_at_ms: startedAt,
        degradation_reason: "router_invalid_response",
        diagnostics: { upstream_status: upstreamResult.upstream_status, upstream_bytes: upstreamResult.response_bytes.length },
      };
      sendJson(
        input.res,
        502,
        { error: "upstream returned an unparseable body", routing_receipt: receipt },
        receipt,
      );
      return;
    }
    const responseObject = (typeof parsedResponse === "object" && parsedResponse !== null && !Array.isArray(parsedResponse))
      ? parsedResponse as Record<string, unknown>
      : {};
    const chosenModel = typeof responseObject.model === "string" ? responseObject.model : null;
    const receipt: ProviderRoutingReceipt = {
      schema_version: ROUTEPLANE_PROVIDER_RECEIPT_VERSION,
      receipt_id: receiptId,
      decision_id: decisionId,
      profile_id: profileId,
      outcome: "routed",
      chain: chosenModel ? [chosenModel] : [],
      upstream_url: upstreamUrl,
      duration_ms: finishedAt - startedAt,
      received_at_ms: startedAt,
      chosen_model: chosenModel ?? undefined,
      response_sha256: sha256Hex(upstreamResult.response_bytes),
      diagnostics: {
        upstream_status: upstreamResult.upstream_status,
        upstream_bytes: upstreamResult.response_bytes.length,
        auth_token_present: true,
      },
    };
    // Preserve the upstream payload and surface the receipt on it.
    const merged: Record<string, unknown> = { ...responseObject, routing_receipt: receipt };
    // If the response has a `metadata` field, mirror the receipt there too
    // (some callers rely on metadata to avoid mutating top-level shape).
    const existingMeta = responseObject.metadata;
    if (existingMeta && typeof existingMeta === "object" && !Array.isArray(existingMeta)) {
      merged.metadata = { ...(existingMeta as Record<string, unknown>), routing_receipt: receipt };
    } else {
      merged.metadata = { routing_receipt: receipt };
    }
    sendJson(input.res, upstreamResult.upstream_status, merged, receipt);
    return;
  }

  // fallthrough — build a clearly-marked static response
  const fallbackHead = fallbackChain[0] ?? "openai-codex";
  const fallback = buildFallbackChatCompletionsResponse(body, fallbackChain, fallbackHead);
  const receipt: ProviderRoutingReceipt = {
    schema_version: ROUTEPLANE_PROVIDER_RECEIPT_VERSION,
    receipt_id: receiptId,
    decision_id: decisionId,
    profile_id: profileId,
    outcome: "fallthrough_static",
    chain: fallbackChain,
    upstream_url: upstreamUrl,
    duration_ms: finishedAt - startedAt,
    received_at_ms: startedAt,
    chosen_model: fallbackHead,
    degradation_reason: upstreamResult.reason,
    diagnostics: {
      upstream_status: upstreamResult.upstream_status,
      static_chain_source: input.fallback_chain ? "configured" : "default",
      auth_token_present: true,
    },
  };
  const merged = { ...fallback, routing_receipt: receipt };
  sendJson(input.res, 200, merged, receipt);
}

export interface RoutePlaneProviderEndpointMountOptions {
  authorize?: (req: IncomingMessage) => boolean;
  upstream_url?: string;
  liveness_url?: string;
  fallback_chain?: ReadonlyArray<string>;
  timeout_ms?: number;
  fetch_impl?: typeof fetch;
  now_ms?: () => number;
}

/**
 * Returns an `(req, res) => void` that the SSE server's request
 * dispatcher can route `/v1/chat/completions` requests to. Test seam:
 * accepts an `authorize` override that bypasses env lookup.
 */
export function createRoutePlaneProviderHandler(
  options: RoutePlaneProviderEndpointMountOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    await handleProviderChatCompletions({
      req,
      res,
      baseUrl: "",
      authorize: options.authorize,
      upstream_url: options.upstream_url,
      fallback_chain: options.fallback_chain,
      timeout_ms: options.timeout_ms,
      fetch_impl: options.fetch_impl,
      now_ms: options.now_ms,
    });
  };
}

/**
 * Lower-level variant: returns an `(req, res) => void` whose baseUrl is
 * bound at construction. Useful when the caller wants the base URL
 * surfaced in the receipt (currently unused but kept for the SSE-server
 * seam parity with `createA2AHttpHandler`).
 */
export function createRoutePlaneProviderHandlerWithBase(
  baseUrl: string,
  options: RoutePlaneProviderEndpointMountOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    await handleProviderChatCompletions({
      req,
      res,
      baseUrl,
      authorize: options.authorize,
      upstream_url: options.upstream_url,
      fallback_chain: options.fallback_chain,
      timeout_ms: options.timeout_ms,
      fetch_impl: options.fetch_impl,
      now_ms: options.now_ms,
    });
  };
}

/**
 * Liveness check the SSE server can mount on `/v1/router/health`. Returns
 * 200 when RoutePlane's `/v1/models` responds within the timeout, 503
 * otherwise — with the receipt body so a profile can audit which path
 * served it.
 */
export function createRoutePlaneProviderHealthHandler(
  options: RoutePlaneProviderEndpointMountOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const fetchImpl = options.fetch_impl ?? fetch;
  const upstreamUrl = options.liveness_url ?? DEFAULT_ROUTEPLANE_LIVENESS_URL;
  const timeoutMs = Math.min(
    Math.max(options.timeout_ms ?? DEFAULT_UPSTREAM_TIMEOUT_MS, 1),
    MAX_UPSTREAM_TIMEOUT_MS,
  );
  return async (req, res) => {
    const startedAt = (options.now_ms ?? Date.now)();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      try {
        const response = await fetchImpl(upstreamUrl, {
          method: "GET",
          signal: controller.signal,
          redirect: "error",
        });
        const finishedAt = (options.now_ms ?? Date.now)();
        const ok = response.ok;
        const receipt: ProviderRoutingReceipt = {
          schema_version: ROUTEPLANE_PROVIDER_RECEIPT_VERSION,
          receipt_id: randomUUID(),
          decision_id: randomUUID(),
          profile_id: null,
          outcome: ok ? "routed" : "fallthrough_static",
          chain: [],
          upstream_url: upstreamUrl,
          duration_ms: finishedAt - startedAt,
          received_at_ms: startedAt,
          diagnostics: { upstream_status: response.status },
        };
        sendJson(
          res,
          ok ? 200 : 503,
          {
            status: ok ? "router_reachable" : "router_unreachable",
            upstream_status: response.status,
            routing_receipt: receipt,
          },
          receipt,
        );
      } catch (error) {
        const finishedAt = (options.now_ms ?? Date.now)();
        const aborted = controller.signal.aborted;
        const receipt: ProviderRoutingReceipt = {
          schema_version: ROUTEPLANE_PROVIDER_RECEIPT_VERSION,
          receipt_id: randomUUID(),
          decision_id: randomUUID(),
          profile_id: null,
          outcome: "fallthrough_static",
          chain: [],
          upstream_url: upstreamUrl,
          duration_ms: finishedAt - startedAt,
          received_at_ms: startedAt,
          degradation_reason: aborted ? "router_timeout" : "router_unreachable",
          diagnostics: { auth_token_present: false },
        };
        sendJson(
          res,
          503,
          {
            status: "router_unreachable",
            error: error instanceof Error ? error.message : String(error),
            routing_receipt: receipt,
          },
          receipt,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  };
}