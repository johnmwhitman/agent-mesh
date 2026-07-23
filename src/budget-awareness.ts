/**
 * Budget awareness — let remaining provider budget influence route_work scores.
 *
 * Sibling of routing-feedback.ts, and deliberately the same shape: both export a
 * bounded multiplier that core.ts folds into a match's weight. Feedback answers
 * "has this agent done this well before?"; budget answers "can this agent's
 * provider still afford to do it at all?".
 *
 * Algorithm: piecewise-linear on utilization (spent / allowance).
 *   util <= HEALTHY(0.60)     -> 1.0            (no thumb on the scale)
 *   HEALTHY < util < DEMOTE   -> 1.0 .. FLOOR   (linear taper)
 *   util >= DEMOTE(0.80)      -> FLOOR(0.5)     (strongly demoted)
 *   util >= 1.0               -> 0              (excluded entirely)
 *
 * Range is [0, 1.0] — note the asymmetry with routing feedback's [0.5, 1.5].
 * Budget can only ever PENALIZE. A lane with budget to spare is not "better"
 * than one that is merely unmeasured; it is simply not worse. Rewarding cheap
 * lanes would quietly re-route judgment work to whichever provider happened to
 * be idle, which is how you end up with a bulk model rendering a merge verdict.
 *
 * Providers with no telemetry report `measured: false` and are treated as
 * NEUTRAL (1.0), never as empty. Unknown is not the same as exhausted: several
 * real providers (SuperGrok chat, Codex, Antigravity, Claude Max) expose no
 * usable quota API at all, and excluding them for that would disable most of
 * the fleet. The cost of this choice is that those lanes cannot self-correct —
 * they fail loudly at dispatch time instead, which the caller must handle.
 */

export interface ProviderBudget {
  /** Provider/lane id, e.g. "grok-build", "ollama-cloud". */
  provider: string;
  /** False when no quota API exists — the entry is then advisory only. */
  measured: boolean;
  /** Consumed so far in the current window. */
  used?: number;
  /** Ceiling for the current window. Omit when the vendor publishes none. */
  total?: number;
  /** Free-form window label, e.g. "2026-07-01→2026-08-01". */
  period?: string;
  /** Where the number came from — required for measured entries. */
  source?: string;
}

const HEALTHY = 0.6;
const DEMOTE = 0.8;
const FLOOR = 0.5;
const NEUTRAL = 1.0;
const EXCLUDED = 0;

/** provider id -> budget */
const budgets = new Map<string, ProviderBudget>();
/** agent id -> provider id */
const agentProvider = new Map<string, string>();

/**
 * Report a provider's budget. Callers own the polling; this module never makes
 * network calls, so it stays deterministic and testable.
 */
export function setProviderBudget(b: ProviderBudget): void {
  if (!b.provider) throw new Error("setProviderBudget: provider is required");
  if (b.measured && (b.used === undefined || b.used < 0)) {
    throw new Error(`setProviderBudget(${b.provider}): measured entries need a non-negative 'used'`);
  }
  if (b.total !== undefined && b.total <= 0) {
    throw new Error(`setProviderBudget(${b.provider}): 'total' must be positive when present`);
  }
  budgets.set(b.provider, { ...b });
}

/** Bind an agent to the provider whose budget it draws on. */
export function setAgentProvider(agentId: string, provider: string): void {
  agentProvider.set(agentId, provider);
}

export function getProviderBudget(provider: string): ProviderBudget | undefined {
  const b = budgets.get(provider);
  return b ? { ...b } : undefined;
}

/** Utilization in [0, ∞), or undefined when it cannot be computed. */
export function getUtilization(provider: string): number | undefined {
  const b = budgets.get(provider);
  if (!b || !b.measured || b.used === undefined || !b.total) return undefined;
  return b.used / b.total;
}

/**
 * The multiplier core.ts applies to a match weight. Unknown agent, unknown
 * provider, or unmeasured budget all yield NEUTRAL.
 */
export function getBudgetAdjustment(agentId: string): number {
  const provider = agentProvider.get(agentId);
  if (!provider) return NEUTRAL;
  const util = getUtilization(provider);
  if (util === undefined) return NEUTRAL;
  if (util >= 1) return EXCLUDED;
  if (util <= HEALTHY) return NEUTRAL;
  if (util >= DEMOTE) return FLOOR;
  // Linear taper between HEALTHY and DEMOTE.
  const t = (util - HEALTHY) / (DEMOTE - HEALTHY);
  return NEUTRAL - t * (NEUTRAL - FLOOR);
}

/** Everything known right now — for `fleet_status`-style reporting. */
export function getBudgetSnapshot(): Array<ProviderBudget & { utilization?: number }> {
  return [...budgets.values()]
    .map((b) => ({ ...b, utilization: getUtilization(b.provider) }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

export function resetBudgets(): void {
  budgets.clear();
  agentProvider.clear();
}
