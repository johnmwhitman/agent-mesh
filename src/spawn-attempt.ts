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

// A colon can belong to a credential (Basic user:password). Only a later,
// whitespace-separated key[:=] starts a new field. Scan each word once rather
// than retrying a variable-length lookahead at every byte.
function authValueEnd(message: string, start: number): number {
  let i = start;
  while (i < message.length && !/["'\\\r\n,;}\]]/.test(message[i])) {
    if (i > start && /\s/.test(message[i - 1]) && /[A-Z0-9_]/i.test(message[i])) {
      const wordStart = i;
      while (i < message.length && /[A-Z0-9_-]/i.test(message[i])) i += 1;
      let marker = i;
      while (/[ \t]/.test(message[marker] ?? "")) marker += 1;
      if (message[marker] === ":" || message[marker] === "=") {
        let boundary = wordStart;
        while (boundary > start && /\s/.test(message[boundary - 1])) boundary -= 1;
        return boundary;
      }
    } else i += 1;
  }
  return i;
}

// Scan each identifier and credential value once. In particular, do not retry
// a variable-length key-prefix pattern at every byte of a long ordinary word.
function redactAssignments(message: string): string {
  const keys = /\b[A-Z0-9_][A-Z0-9_-]*/gi;
  const sensitiveKey = /(?:API[_-]?KEY|ACCESS[_-]?KEY|TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE[_-]?KEY|AUTHORIZATION)$/i;
  const chunks: string[] = [];
  let copied = 0;
  let match: RegExpExecArray | null;
  while ((match = keys.exec(message)) !== null) {
    // Handle bare schemes in the same pass as assignments: masking them in a
    // prior pass can erase the next sensitive key and strand its quoted value.
    if (/^(?:basic|bearer)$/i.test(match[0]) && /\s/.test(message[keys.lastIndex] ?? "")) {
      let start = keys.lastIndex;
      while (/\s/.test(message[start] ?? "")) start += 1;
      const end = authValueEnd(message, start);
      chunks.push(message.slice(copied, start), "[redacted]");
      copied = end;
      keys.lastIndex = end;
      continue;
    }
    if (!sensitiveKey.test(match[0])) continue;
    let i = keys.lastIndex;
    // A JSON key can be quoted inside one or more JSON-encoded strings.
    while (message[i] === "\\") i += 1;
    if (message[i] === '"' || message[i] === "'") i += 1;
    while (/\s/.test(message[i] ?? "")) i += 1;
    if (message[i] !== ":" && message[i] !== "=") continue;
    i += 1;
    while (/\s/.test(message[i] ?? "")) i += 1;
    const valueStart = i;
    while (message[i] === "\\") i += 1;
    const depth = i - valueStart;
    const quote = message[i];
    let replacement = "[redacted]";
    if (quote === '"' || quote === "'") {
      const delimiter = message.slice(valueStart, ++i);
      // At escape depth d, a closing quote has d (mod 2*(d+1))
      // preceding backslashes. Other quotes belong to the credential value.
      for (; i < message.length; i += 1) {
        if (message[i] !== quote) continue;
        let slashStart = i;
        while (slashStart > valueStart && message[slashStart - 1] === "\\") slashStart -= 1;
        if ((i - slashStart) % (2 * (depth + 1)) === depth) { i += 1; break; }
      }
      // An unterminated value consumes the remainder, including newlines.
      replacement = delimiter + replacement + delimiter;
    } else {
      i = valueStart;
      if (/(?:^|[_-])AUTHORIZATION$/i.test(match[0])) {
        const scheme = /^(?:basic|bearer)\s+/i.exec(message.slice(i));
        if (scheme) { replacement = scheme[0] + replacement; i += scheme[0].length; }
        i = authValueEnd(message, i);
      } else {
        while (i < message.length && !/["'\s,;}\]]/.test(message[i])) i += 1;
      }
    }
    chunks.push(message.slice(copied, valueStart), replacement);
    copied = i;
    keys.lastIndex = i;
  }
  chunks.push(message.slice(copied));
  return chunks.join("");
}

export function redactDiagnosticMessage(message: string): string {
  // Bound work before any regex/scanner. Drop the cut lexical token so a
  // truncated standalone credential cannot evade its token-length matcher.
  // Unterminated quoted values and PEM blocks below mask their remaining tail.
  let end = Math.min(message.length, 8_192);
  if (end < message.length) {
    while (end > 0 && !/\s/.test(message[end - 1])) end -= 1;
  }
  const input = message.slice(0, end);
  const normalized = input
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/-----BEGIN [A-Z0-9 ]{0,64}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,64}PRIVATE KEY-----|$)/gi, "[redacted private key]");
  return redactAssignments(normalized)
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
