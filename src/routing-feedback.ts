/**
 * Routing feedback loop — adjust future route_work scores based on
 * whether prior routings succeeded.
 *
 * Algorithm: Wilson-style score with a soft prior of 4 neutral outcomes.
 *   adjustment = 1.0 + (successes - failures) / (total + 4) * 0.5
 *
 * This puts a single fresh outcome in a small influence range and lets
 * many consistent outcomes push the agent up or down with diminishing
 * returns. Range is [0.5, 1.5].
 */

interface AgentStats {
  successes: number;
  failures: number;
}

const state = new Map<string, AgentStats>();

const PRIOR = 4;
const SCALE = 0.5;
const NEUTRAL = 1.0;

export function recordRoutingOutcome(
  agentId: string,
  _capabilityKey: string,
  success: boolean
): void {
  const existing = state.get(agentId) ?? { successes: 0, failures: 0 };
  if (success) existing.successes++;
  else existing.failures++;
  state.set(agentId, existing);
}

export function getRoutingAdjustment(agentId: string): number {
  const s = state.get(agentId);
  if (!s) return NEUTRAL;
  const total = s.successes + s.failures;
  if (total === 0) return NEUTRAL;
  const delta = (s.successes - s.failures) / (total + PRIOR);
  return NEUTRAL + delta * SCALE;
}

export function resetRoutingFeedback(): void {
  state.clear();
}

export function getRoutingStats(agentId: string): AgentStats | undefined {
  const s = state.get(agentId);
  return s ? { ...s } : undefined;
}