export type AttemptTerminalEvent = "timeout" | "heartbeat" | "error" | "close";

export function createAttemptSettlementGate(): (event: AttemptTerminalEvent) => boolean {
  let settled = false;
  return (_event) => {
    if (settled) return false;
    settled = true;
    return true;
  };
}
