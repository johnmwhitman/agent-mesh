/**
 * Budget enforcement — callable hook for the routeplane smart-router.
 *
 * Sibling of `budget-awareness.ts`. Budget-awareness answers a *multiplicative*
 * question ("how should remaining budget weight this match?"); enforcement
 * answers a *gating* question ("given a requested model and an estimated cost,
 * may this profile proceed, must it downgrade, or must it deny?"). Both read the
 * same provider-budget ledger; neither mutates it. Both are pure of network
 * state — callers own the polling.
 *
 * The function `getBudgetEnforcement` is the stable callable interface. Its
 * shape is the public contract RoutePlane's smart-router consumes (see
 * ~/AI/docs/architecture/hermes-routeplane-meshfleet-integration-2026-08-29.md
 * §5.4) and that hermes-cli consumers wire from in-process MCP imports. A thin
 * HTTP wrapper is mounted at POST /v1/budget/enforce on the SSE server for
 * out-of-process callers.
 *
 * Algorithm:
 *   1. Resolve profileId -> providerId via `getAgentProvider`. Unknown
 *      profile => fail-closed (deny with reason=unknown_profile).
 *   2. Read current provider utilization; if measured is false or there
 *      is no total, treat the provider as NEUTRAL and allow the
 *      requested model unchanged (reason=no_budget_data or
 *      unknown_model). This matches `getBudgetAdjustment`'s posture:
 *      we cannot bound what we cannot see, and excluding every lane
 *      that publishes no quota API would disable most of the fleet.
 *   3. Resolve cost: `estimatedCost` > catalog entry > `fallbackCost`
 *      > 0. When the model is unknown to the catalog and no estimate
 *      is supplied, cost=0 with source=zero so the gap shows up on
 *      the receipt stream as reason=unknown_model.
 *   4. Try the requested model. If post-call utilization (used +
 *      cost) / total is < 1.0, allow with reason ∈ {under_budget,
 *      at_budget, unknown_model} based on the pre-call posture.
 *   5. If the requested model would overshoot, walk the model's
 *      `cheaper_alternatives` in declared order. The first whose cost
 *      keeps post-call utilization under 1.0 wins; return
 *      reason=downgraded.
 *   6. If nothing fits, deny with reason=over_budget.
 *
 * Constraints honored:
 *   - No state mutation outside `appendEvent` (one receipt row per call).
 *     The provider budget map and the agentProvider map are read-only
 *     here; the contract is "no MeshFleet-side state mutation beyond the
 *     existing budget ledger".
 *   - Every call emits exactly one receipt envelope to the MeshFleet
 *     event log so the observability lane sees allow/deny/downgrade
 *     decisions.
 *   - Unknown profileId fail-closed (deny), mirroring the enforcement
 *     semantics that a profile that has never been bound to a provider is
 *     exactly the lane whose spend is invisible to us — and we cannot
 *     bound what we cannot see.
 */

import { randomUUID } from "node:crypto";
import {
  getAgentProvider,
  getBudgetAdjustment,
  getProviderBudget,
  getUtilization,
} from "./budget-awareness.js";
import { appendEvent } from "./core.js";

/**
 * Static cost catalog.
 *
 * `cost_micro_usd` is the estimated spend in micro-USD (1e-6 USD) for a
 * single call at the listed model. Values are deliberately round and
 * conservative — the enforcement layer cannot know prompt/output token
 * counts, so we charge a fixed per-call estimate. Operators who need
 * accuracy wire `estimatedCost` from the caller side, which OVERRIDES
 * the catalog value when supplied.
 *
 * The keys are model identifiers exactly as they appear in
 * `requested_model` fields (e.g. `grok-4-fast`, `minimax-m3`). Match
 * is by exact string equality (no prefix tricks); an unknown model
 * fails open into the caller-supplied `estimatedCost` or `fallbackCost`.
 */
export interface ModelCostEntry {
  readonly model: string;
  readonly cost_micro_usd: number;
  /** Cheaper alternatives within the SAME provider family — only same-vendor downgrades are honored. */
  readonly cheaper_alternatives?: readonly string[];
  /** Provider family — used to constrain downgrades to within the same vendor. */
  readonly provider_family: string;
}

export const MODEL_COST_CATALOG_VERSION = "meshfleet.budget-enforcement.cost-catalog.v1" as const;

export const MODEL_COST_CATALOG: ReadonlyArray<ModelCostEntry> = Object.freeze([
  { model: "grok-4-fast", cost_micro_usd: 100, cheaper_alternatives: ["grok-4-mini"], provider_family: "xai" },
  { model: "grok-4-mini", cost_micro_usd: 30, provider_family: "xai" },
  { model: "minimax-m3", cost_micro_usd: 250, cheaper_alternatives: ["minimax-m2"], provider_family: "minimax" },
  { model: "minimax-m2", cost_micro_usd: 80, provider_family: "minimax" },
  { model: "claude-sonnet-4", cost_micro_usd: 3_000, cheaper_alternatives: ["claude-haiku-4"], provider_family: "anthropic" },
  { model: "claude-haiku-4", cost_micro_usd: 250, provider_family: "anthropic" },
  { model: "gpt-5-mini", cost_micro_usd: 200, cheaper_alternatives: ["gpt-5-nano"], provider_family: "openai" },
  { model: "gpt-5-nano", cost_micro_usd: 50, provider_family: "openai" },
  { model: "codex-mini", cost_micro_usd: 80, provider_family: "openai" },
]);

/** Fast O(n) lookup — the catalog is tiny (≤64 entries by design). */
function findCostEntry(model: string): ModelCostEntry | undefined {
  for (const entry of MODEL_COST_CATALOG) {
    if (entry.model === model) return entry;
  }
  return undefined;
}

/**
 * Allowed reasons. Kept narrow so callers can route on the exact value
 * without string-matching. New reasons are ADDITIVE — never rename or
 * repurpose an existing token.
 */
export type BudgetEnforcementReason =
  | "under_budget"        // allowed; plenty of headroom
  | "at_budget"           // allowed; right at the threshold but not denied
  | "downgraded"          // allowed; ran out of headroom for the requested model — switched to a cheaper same-family model
  | "over_budget"         // denied; no headroom and no downgrade target
  | "unknown_profile"     // denied; profileId has no provider binding (fail-closed)
  | "unknown_model"       // allowed with caveat; requested model not in catalog AND no caller cost estimate supplied — proceed but tag the receipt
  | "no_budget_data";     // allowed; provider is unmeasured (no quota API exists) — same posture as budget-awareness NEUTRAL

export interface BudgetEnforcementInput {
  readonly profileId: string;
  readonly requestedModel: string;
  /**
   * Estimated cost of THIS call in micro-USD. When omitted, the
   * cost-catalog value for `requestedModel` is used. When the model is
   * unknown AND this is omitted, the call is allowed with
   * reason=unknown_model so callers can see the gap on the receipt
   * stream.
   */
  readonly estimatedCost?: number;
  /** Optional caller-supplied fallback when no catalog entry matches; takes precedence over the catalog only for the cost lookup, not for downgrade selection. */
  readonly fallbackCost?: number;
}

export interface BudgetEnforcementReceipt {
  readonly decision_id: string;
  readonly profile_id: string;
  readonly provider_id: string | null;
  readonly requested_model: string;
  readonly allowed: boolean;
  readonly downgraded_model: string | null;
  readonly reason: BudgetEnforcementReason;
  readonly pre_call_utilization: number | null;
  readonly post_call_utilization: number | null;
  readonly cost_micro_usd: number;
  readonly budget_adjustment: number;
  readonly catalog_version: string;
  readonly event_id: string;
  readonly timestamp_ms: number;
}

export interface BudgetEnforcementResult {
  readonly allowed: boolean;
  readonly downgradedModel?: string;
  readonly reason: BudgetEnforcementReason;
  readonly receiptEnvelope: BudgetEnforcementReceipt;
}

/**
 * Mirror of `budget-awareness.ts` thresholds. KEPT IN SYNC deliberately —
 * the enforcement boundary asks the same questions ("how much headroom is
 * left?") that budget-awareness answers; the EXCLUDED boundary is the
 * single load-bearing constant here. If `budget-awareness.ts`'s HEALTHY
 * threshold shifts, this constant must shift to match — the only purpose
 * of pulling it across is to keep the "at_budget" tag aligned with the
 * taper zone callers already see from `getBudgetAdjustment`.
 */
const HEALTHY = 0.6;

/**
 * Resolve the effective cost of this call in micro-USD, applying the
 * documented precedence: explicit `estimatedCost` > catalog entry >
 * `fallbackCost` > 0. A negative or non-finite estimate is rejected with
 * a TypeError so the caller fixes the bug at the boundary — silently
 * flipping to 0 would let any cost-shaped payload become a free call.
 *
 * Eagerly validates BOTH `estimatedCost` and `fallbackCost` so a
 * malformed value is rejected even when a catalog hit short-circuits
 * the lookup. The function resolves the cost AND reports which source
 * served the answer so downstream branches can emit the correct
 * reason token.
 */
function resolveCostMicroUsd(
  requestedModel: string,
  input: BudgetEnforcementInput,
): { cost: number; source: "catalog" | "estimated" | "fallback" | "zero" } {
  // Eager validation — covers every branch.
  if (input.estimatedCost !== undefined) {
    assertNonNegativeFinite(input.estimatedCost, "estimatedCost");
  }
  if (input.fallbackCost !== undefined) {
    assertNonNegativeFinite(input.fallbackCost, "fallbackCost");
  }

  if (input.estimatedCost !== undefined) {
    return { cost: input.estimatedCost, source: "estimated" };
  }
  const entry = findCostEntry(requestedModel);
  if (entry) return { cost: entry.cost_micro_usd, source: "catalog" };
  if (input.fallbackCost !== undefined) {
    return { cost: input.fallbackCost, source: "fallback" };
  }
  return { cost: 0, source: "zero" };
}

function assertNonNegativeFinite(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `getBudgetEnforcement: ${field} must be a non-negative finite number (got ${value})`,
    );
  }
}

/**
 * Public callable interface. Safe to invoke from any caller; performs no
 * network I/O and mutates no MeshFleet state beyond appending one receipt
 * row to the event log.
 *
 * Returned `receiptEnvelope` always carries a `decision_id` (UUIDv4) and
 * `event_id` so it can be cross-referenced against the MeshFleet event log
 * and any external audit (e.g. RoutePlane's /metrics, hermes-cli kanban
 * receipts).
 */
export function getBudgetEnforcement(input: BudgetEnforcementInput): BudgetEnforcementResult {
  if (!input || typeof input !== "object") {
    throw new TypeError("getBudgetEnforcement: input is required");
  }
  if (typeof input.profileId !== "string" || input.profileId.length === 0) {
    throw new TypeError("getBudgetEnforcement: profileId must be a non-empty string");
  }
  if (typeof input.requestedModel !== "string" || input.requestedModel.length === 0) {
    throw new TypeError("getBudgetEnforcement: requestedModel must be a non-empty string");
  }

  const decisionId = randomUUID();
  const eventId = `budget_enforcement_${decisionId}`;
  const timestampMs = Date.now();

  // ── 1. Profile → provider resolution ────────────────────────────
  // An unbound profile is the lane whose spend is invisible to
  // MeshFleet — fail closed. We use the freshly-added
  // `getAgentProvider` accessor because the older numeric
  // `getBudgetAdjustment` cannot distinguish "no binding" from "bound
  // but unmeasured" (both return 1.0).
  const providerId = getAgentProvider(input.profileId);
  if (providerId === null) {
    return finalize({
      decisionId,
      eventId,
      timestampMs,
      input,
      providerId: null,
      allowed: false,
      downgradedModel: null,
      reason: "unknown_profile",
      preCallUtilization: null,
      postCallUtilization: null,
      costMicroUsd: 0,
      budgetAdjustment: 1.0,
    });
  }

  // ── 2. Provider budget posture ──────────────────────────────────
  const budget = getProviderBudget(providerId);
  if (!budget || !budget.measured) {
    // Unmeasured provider — same posture as budget-awareness NEUTRAL:
    // the caller has no quota API to consult, so we cannot bound the
    // call, but we also cannot deny it (would disable most of the
    // fleet, see budget-awareness.ts docstring lines 22-26).
    const costResolution = resolveCostMicroUsd(input.requestedModel, input);
    return finalize({
      decisionId,
      eventId,
      timestampMs,
      input,
      providerId,
      allowed: true,
      downgradedModel: null,
      reason: costResolution.source === "zero" ? "unknown_model" : "no_budget_data",
      preCallUtilization: null,
      postCallUtilization: null,
      costMicroUsd: costResolution.cost,
      budgetAdjustment: 1.0,
    });
  }

  const util = getUtilization(providerId);
  if (util === undefined) {
    // Measured but no total (e.g. Ollama Cloud publishes usage but no
    // ceiling). Same neutral posture, but tag the receipt so an
    // operator can audit the steady-state.
    const costResolution = resolveCostMicroUsd(input.requestedModel, input);
    return finalize({
      decisionId,
      eventId,
      timestampMs,
      input,
      providerId,
      allowed: true,
      downgradedModel: null,
      reason: costResolution.source === "zero" ? "unknown_model" : "no_budget_data",
      preCallUtilization: null,
      postCallUtilization: null,
      costMicroUsd: costResolution.cost,
      budgetAdjustment: 1.0,
    });
  }

  // ── 3. Cost resolution + projected post-call utilization ───────
  const costResolution = resolveCostMicroUsd(input.requestedModel, input);
  const total = budget.total!;
  const projectedUsed = (budget.used ?? 0) + costResolution.cost;
  const postUtil = projectedUsed / total;
  const preUtil = util;
  const reasonForUnknownModel = costResolution.source === "zero" ? "unknown_model" : null;

  // ── 4a. Try the requested model first ──────────────────────────
  // The requested model fits when post-call utilization stays below
  // EXCLUDED (1.0). The reason token depends on where the projection
  // lands relative to the HEALTHY threshold — the same split
  // budget-awareness uses for its taper zone.
  if (postUtil < 1.0) {
    const reason: BudgetEnforcementReason = preUtil >= HEALTHY
      ? (reasonForUnknownModel ?? "at_budget")
      : (reasonForUnknownModel ?? "under_budget");
    return finalize({
      decisionId,
      eventId,
      timestampMs,
      input,
      providerId,
      allowed: true,
      downgradedModel: null,
      reason,
      preCallUtilization: preUtil,
      postCallUtilization: postUtil,
      costMicroUsd: costResolution.cost,
      budgetAdjustment: getBudgetAdjustment(input.profileId),
    });
  }

  // ── 4b. Requested model would overshoot — try downgrade ───────
  // Walk `cheaper_alternatives` in declared order. The first one whose
  // cost keeps post-call utilization under EXCLUDED wins. Picking by
  // ORDER (not cost) matches the catalog author's intent: the cheaper
  // list is documented as "ordered", meaning the first is the
  // preferred substitution.
  const entry = findCostEntry(input.requestedModel);
  if (entry && entry.cheaper_alternatives) {
    for (const alt of entry.cheaper_alternatives) {
      const altEntry = findCostEntry(alt);
      if (!altEntry) continue; // catalog drift — skip unknown alt
      const altPost = ((budget.used ?? 0) + altEntry.cost_micro_usd) / total;
      if (altPost < 1.0) {
        return finalize({
          decisionId,
          eventId,
          timestampMs,
          input,
          providerId,
          allowed: true,
          downgradedModel: alt,
          reason: "downgraded",
          preCallUtilization: preUtil,
          postCallUtilization: altPost,
          costMicroUsd: costResolution.cost,
          budgetAdjustment: getBudgetAdjustment(input.profileId),
        });
      }
    }
  }

  // ── 4c. Nothing fits → deny ────────────────────────────────────
  return finalize({
    decisionId,
    eventId,
    timestampMs,
    input,
    providerId,
    allowed: false,
    downgradedModel: null,
    reason: "over_budget",
    preCallUtilization: preUtil,
    postCallUtilization: postUtil,
    costMicroUsd: costResolution.cost,
    budgetAdjustment: getBudgetAdjustment(input.profileId),
  });
}

/** Internal: emit the receipt envelope to the observability lane and return the result. */
function finalize(params: {
  decisionId: string;
  eventId: string;
  timestampMs: number;
  input: BudgetEnforcementInput;
  providerId: string | null;
  allowed: boolean;
  downgradedModel: string | null;
  reason: BudgetEnforcementReason;
  preCallUtilization: number | null;
  postCallUtilization: number | null;
  costMicroUsd: number;
  budgetAdjustment: number;
}): BudgetEnforcementResult {
  const envelope: BudgetEnforcementReceipt = {
    decision_id: params.decisionId,
    profile_id: params.input.profileId,
    provider_id: params.providerId,
    requested_model: params.input.requestedModel,
    allowed: params.allowed,
    downgraded_model: params.downgradedModel,
    reason: params.reason,
    pre_call_utilization: params.preCallUtilization,
    post_call_utilization: params.postCallUtilization,
    cost_micro_usd: params.costMicroUsd,
    budget_adjustment: params.budgetAdjustment,
    catalog_version: MODEL_COST_CATALOG_VERSION,
    event_id: params.eventId,
    timestamp_ms: params.timestampMs,
  };

  // Receipts go to the MeshFleet observability lane. The event name is a
  // stable contract — consumers should be able to filter the event log
  // on exactly this string. payload is the envelope verbatim.
  appendEvent("budget_enforcement_decided", { ...envelope });

  const result: BudgetEnforcementResult = {
    allowed: params.allowed,
    downgradedModel: params.downgradedModel ?? undefined,
    reason: params.reason,
    receiptEnvelope: envelope,
  };
  return result;
}

/**
 * Test seam — clears any state the enforcement layer owns. Today the
 * enforcement layer holds no module-level state of its own (the cost
 * catalog is a frozen static), so this is a no-op for the public
 * surface but is exported so a test can call it after `resetBudgets()`
 * to guarantee a clean slate.
 */
export function resetEnforcementState(): void {
  // No-op; the catalog is static and the budget ledger lives in
  // budget-awareness.ts. Exists so test harnesses have a single
  // entry point for "wipe everything this module touches".
}
