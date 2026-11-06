// Exact redactor from main 1293b40d6802b60fe38fdedadfb896c9393c468a.
// Offline differential oracle; do not update alongside the candidate.
export function baseRedactDiagnosticMessage(message: string): string {
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
