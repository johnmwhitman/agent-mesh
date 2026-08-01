import { hasProviderRefusalSignal } from "./spawn-result.js";

/**
 * Choosing where a refused agent goes next.
 *
 * Pure and separated from `index.ts` on purpose. The decision has four independent gates and an
 * ordering rule, and every one of them is a place to be wrong; folding it into the spawn loop
 * would mean the only way to test it is to spawn real child processes, which is exactly the shape
 * of test that cannot run on every platform. The integration test still proves a real hop end to
 * end — this makes the reasoning provable everywhere.
 */
export interface FailoverRequest {
  /** Every registered runtime id, in the registry's own order. */
  available: readonly string[];
  /** Runtime ids already tried for this agent, including the one that just failed. */
  attempted: readonly string[];
  /** The composed failure detail from the attempt that just failed. */
  failureDetail: string;
  /** The caller's pinned `provider/model`, if any. */
  requestedModel?: string;
  /** Would this runtime accept the spec it would actually be given? */
  accepts: (runtimeId: string) => boolean;
}

export type FailoverDecision =
  | { hop: true; to: string }
  | { hop: false; reason: "not_a_provider_refusal" | "model_is_pinned" | "no_candidate_accepts" };

/**
 * ⚠️ Order is the caller's list order, which today is the registry's SORTED id order — alphabetical
 * and therefore arbitrary. It encodes no preference, health, cost, or remaining quota, because
 * MeshFleet observes none of those: `recommend_route` exists for ranking and is advisory-only by
 * design. With two runtimes and the failed one excluded there is exactly one candidate, so the
 * order cannot matter yet. It starts mattering at three, and the fix then is a real input to rank
 * on, not a cleverer sort.
 */
export function decideFailover(req: FailoverRequest): FailoverDecision {
  // Gate 1 — the provider refused, rather than the work failing. Hopping on every retry regardless
  // of cause converts one quota-burning failure into a quota-AMPLIFYING one: a malformed prompt
  // would burn each registered subscription in turn to re-learn the same bug, unbounded as more
  // adapters are added. See `hasProviderRefusalSignal` for what this can and cannot see.
  if (!hasProviderRefusalSignal(req.failureDetail)) {
    return { hop: false, reason: "not_a_provider_refusal" };
  }
  // Gate 2 — a pinned model is provider-scoped and cannot be carried across harnesses. Passing
  // `opencode-go/minimax-m3` to a different CLI's `--model` either fails for a second reason or
  // runs something the caller never named. A caller who pinned a model asked for THAT model.
  if (req.requestedModel !== undefined) {
    return { hop: false, reason: "model_is_pinned" };
  }
  const attempted = new Set(req.attempted);
  for (const id of req.available) {
    // Gate 3 — never re-offer a runtime that already refused; the retry budget is small and
    // spending it to prove the same thing twice is how it gets wasted.
    if (attempted.has(id)) continue;
    // Gate 4 — only somewhere that can actually take the spec. This is a static check and knows
    // nothing about whether the run will SUCCEED; it only rules out the knowably useless.
    if (req.accepts(id)) return { hop: true, to: id };
  }
  return { hop: false, reason: "no_candidate_accepts" };
}
