export type AttemptTerminalEvent = "timeout" | "heartbeat" | "error" | "close";

export function createAttemptSettlementGate(): (event: AttemptTerminalEvent) => boolean {
  let settled = false;
  return (_event) => {
    if (settled) return false;
    settled = true;
    return true;
  };
}

export function buildFailureDetail(stderr: string, summary: string): string {
  const raw = stderr.trimEnd();
  const explanation = summary.trim();
  if (!raw) return explanation;
  if (!explanation) return raw;
  if (explanation.includes(raw)) return explanation;
  if (raw.includes(explanation)) return raw;
  return `${raw}\n${explanation}`;
}

/**
 * Annotate a proxied-model routing failure with WHERE it actually failed.
 *
 * Why: an agent whose model is proxied through a local daemon (e.g.
 * `routeplane/minimax/minimax-m3`) surfaces the daemon's own 404 text verbatim —
 * `model 'minimax/minimax-m3' cannot be routed`. That reads exactly like a typo in the model
 * string, so the natural response is to "fix" a selector that was never wrong. Observed
 * 2026-08-01: a spawn failed this way while the model was in fact routable; the daemon had simply
 * been unavailable at spawn time. The wrong diagnosis was recorded and had to be retracted.
 *
 * This does not change retry/failover behaviour or invent a probe — it only says which of the two
 * very different causes the reader should check first.
 */
export function annotateProxiedModelFailure(detail: string, model?: string): string {
  if (!detail || !model) return detail;
  const slash = model.indexOf("/");
  if (slash <= 0) return detail;                       // not a `<proxy>/<model>` selector
  const proxy = model.slice(0, slash);
  const inner = model.slice(slash + 1);
  // Only annotate when the upstream complained about routing THIS selector's inner model.
  if (!/cannot be routed|not routable|no route/i.test(detail)) return detail;
  if (inner && !detail.includes(inner)) return detail;
  if (detail.includes("proxied via")) return detail;    // idempotent: never double-annotate
  return (
    `${detail}\n[agent-mesh] '${inner}' is proxied via '${proxy}'. This error is emitted by ` +
    `'${proxy}' and means IT could not route the model — which happens both when the model is ` +
    `genuinely absent AND when '${proxy}' is unreachable or has not loaded its catalog. Check ` +
    `that '${proxy}' is up and serving the model before editing the model string.`
  );
}
