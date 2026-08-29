/**
 * Budget enforcement — thin HTTP wrapper.
 *
 * Mirrors the in-process `getBudgetEnforcement` from `./budget-enforcement.js`
 * for callers that do not share MeshFleet's Node process (e.g. RoutePlane's
 * Rust daemon). Mounted at `POST /v1/budget/enforce` on the SSE server when
 * the operator opts in via the `budgetEnforcement` field on
 * `SseServerOptions`. See `README.md` §"Budget enforcement HTTP wrapper" for
 * the wire contract.
 *
 * Design choices:
 *   - The handler is a single small module, not a route-table library, so
 *     it can be mounted on the existing SSE server with the same shape as
 *     `createA2AHttpHandler` (consume req + res, return void). No new
 *     server lifecycle, no new port to manage.
 *   - Body parsing reuses the existing 128 KiB default cap and JSON-only
 *     content-type check; the wire shape is a strict subset of the
 *     in-process BudgetEnforcementInput, so a caller cannot smuggle
 *     fields through the wire that the in-process function would reject.
 *   - The handler is SAFE by default: it does NOT mutate any MeshFleet
 *     state beyond `appendEvent` (one receipt row per call). It does not
 *     dispatch agents, contact providers, or persist decisions.
 *   - Every response includes `decision_id` (echoed from the receipt) so
 *     callers can correlate with MeshFleet's event log and any external
 *     audit (RoutePlane /metrics, hermes-cli kanban receipts).
 *
 * Mounting is opt-in via `SseServerOptions.budgetEnforcement: true`. The
 * HTTP path is `/v1/budget/enforce` and accepts both POST (decision
 * queries) and GET (liveness — returns 200 with the handler version).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  getBudgetEnforcement,
  MODEL_COST_CATALOG_VERSION,
  type BudgetEnforcementInput,
} from "./budget-enforcement.js";

/**
 * Hard upper bound on request body size. The wire schema is tiny (≤4
 * fields, all scalar) so 16 KiB is generous; anything beyond is rejected
 * with a 413 before parsing.
 */
const MAX_BODY_BYTES = 16 * 1024;

/** Reject any content-type other than `application/json`. */
function isJsonRequest(req: IncomingMessage): boolean {
  const raw = req.headers["content-type"];
  if (typeof raw !== "string") return false;
  return raw.split(";", 1)[0]!.trim().toLowerCase() === "application/json";
}

/** Read up to `limit` bytes from the request body or reject with 413. */
async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  limit: number,
): Promise<unknown | null> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    res.writeHead(413, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "request body too large" }));
    return null;
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buf.length;
    if (received > limit) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "request body too large" }));
      return null;
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf-8");
  try {
    return JSON.parse(text);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return null;
  }
}

/** Strict-shape validator for the wire body. Mirrors `BudgetEnforcementInput` but rejects any extra keys. */
function parseWireBody(value: unknown): { ok: true; input: BudgetEnforcementInput } | { ok: false; error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const obj = value as Record<string, unknown>;
  const allowedKeys = new Set(["profileId", "requestedModel", "estimatedCost", "fallbackCost"]);
  const extraKeys: string[] = [];
  for (const k of Object.keys(obj)) {
    if (!allowedKeys.has(k)) extraKeys.push(k);
  }
  if (extraKeys.length > 0) {
    return { ok: false, error: `unknown fields: ${extraKeys.join(", ")}` };
  }
  if (typeof obj.profileId !== "string" || obj.profileId.length === 0) {
    return { ok: false, error: "profileId must be a non-empty string" };
  }
  if (typeof obj.requestedModel !== "string" || obj.requestedModel.length === 0) {
    return { ok: false, error: "requestedModel must be a non-empty string" };
  }
  const input: BudgetEnforcementInput = {
    profileId: obj.profileId,
    requestedModel: obj.requestedModel,
  };
  if (obj.estimatedCost !== undefined) {
    if (typeof obj.estimatedCost !== "number" || !Number.isFinite(obj.estimatedCost) || obj.estimatedCost < 0) {
      return { ok: false, error: "estimatedCost must be a non-negative finite number" };
    }
    (input as { estimatedCost: number }).estimatedCost = obj.estimatedCost;
  }
  if (obj.fallbackCost !== undefined) {
    if (typeof obj.fallbackCost !== "number" || !Number.isFinite(obj.fallbackCost) || obj.fallbackCost < 0) {
      return { ok: false, error: "fallbackCost must be a non-negative finite number" };
    }
    (input as { fallbackCost: number }).fallbackCost = obj.fallbackCost;
  }
  return { ok: true, input };
}

/**
 * Build a request handler bound to a base URL. The handler is consumed by
 * `startSseServer`'s `options.budgetEnforcement` mount point.
 */
export function createBudgetEnforcementHttpHandler(): (req: IncomingMessage, res: ServerResponse) => void {
  return async (req, res) => {
    // CORS preflight — permissive for local dev; matches the SSE server's posture.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    // GET /v1/budget/enforce — liveness + handler version. Cheap way for an
    // operator to confirm the mount exists without posting a body.
    if (req.method === "GET" && (url.pathname === "/v1/budget/enforce" || url.pathname === "/v1/budget/enforce/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          handler: "budget_enforcement",
          catalog_version: MODEL_COST_CATALOG_VERSION,
          schema_version: "budget-enforcement.v1",
        }),
      );
      return;
    }

    if (req.method !== "POST" || (url.pathname !== "/v1/budget/enforce" && url.pathname !== "/v1/budget/enforce/")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    if (!isJsonRequest(req)) {
      res.writeHead(415, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Content-Type must be application/json" }));
      return;
    }

    const body = await readJsonBody(req, res, MAX_BODY_BYTES);
    if (body === null) return; // readJsonBody already wrote the error response.

    const parsed = parseWireBody(body);
    if (!parsed.ok) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: parsed.error }));
      return;
    }

    let result;
    try {
      result = getBudgetEnforcement(parsed.input);
    } catch (err) {
      // getBudgetEnforcement throws only on programmer errors (missing
      // fields, non-finite costs). Surface them as 400 so the operator
      // sees a clear signal.
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
      return;
    }

    // The HTTP response always carries the receipt envelope — callers
    // receive the same shape as in-process callers, so logging and audit
    // pipelines can be unified.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        allowed: result.allowed,
        downgradedModel: result.downgradedModel ?? null,
        reason: result.reason,
        receiptEnvelope: result.receiptEnvelope,
      }),
    );
  };
}
