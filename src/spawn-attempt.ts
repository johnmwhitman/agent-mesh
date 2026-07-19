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
