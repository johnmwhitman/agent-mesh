import type { RuntimeDiagnostic } from "./runtime/types.js";

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

function redactDiagnosticMessage(message: string): string {
  return message
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi, "[redacted private key]")
    .replace(/(\bauthorization\s*[:=]\s*(?:basic|bearer)\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(\b(?:basic|bearer)\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(["']?(?:(?:[A-Z0-9]+[_-])*(?:API[_-]?KEY|ACCESS[_-]?KEY|TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE[_-]?KEY))["']?\s*[:=]\s*)(["'])(.*?)\2/gi, "$1$2[redacted]$2")
    .replace(/(["']?(?:(?:[A-Z0-9]+[_-])*(?:API[_-]?KEY|ACCESS[_-]?KEY|TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE[_-]?KEY))["']?\s*[:=]\s*["']?)[^"'\s,;}\]]+/gi, "$1[redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:(?:proj|or-v1|ant)-)?[A-Za-z0-9_-]{16,}|(?:xai-|pplx-)[A-Za-z0-9]{20,}|(?:gsk_|hf_|r8_)[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|AKIA[0-9A-Z]{16}|xox[bap]-[A-Za-z0-9-]{10,}|eyJhbGciOi[A-Za-z0-9_.-]{40,})\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Project successful-run warnings into bounded public diagnostics. Raw stderr and
 * error-severity diagnostics are deliberately excluded.
 */
export function projectSuccessDiagnostics(
  diagnostics: readonly RuntimeDiagnostic[],
): RuntimeDiagnostic[] | undefined {
  const projected: RuntimeDiagnostic[] = [];
  let remaining = 2_000;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== "warning" || projected.length >= 16 || remaining <= 0) continue;
    const message = redactDiagnosticMessage(diagnostic.message).slice(0, remaining);
    if (!message) continue;
    const code = diagnostic.code
      && /^[A-Z0-9_.-]{1,64}$/.test(diagnostic.code)
      && redactDiagnosticMessage(diagnostic.code) === diagnostic.code
      ? diagnostic.code
      : undefined;
    projected.push({ severity: "warning", message, ...(code ? { code } : {}) });
    remaining -= message.length;
  }
  return projected.length > 0 ? projected : undefined;
}
