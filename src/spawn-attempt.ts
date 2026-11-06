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
function redactAssignments(message: string, hide: (start: number, end: number) => void): void {
  const keys = /\b[A-Z0-9_][A-Z0-9_-]*/gi;
  const sensitiveKey = /(?:API[_-]?KEY|ACCESS[_-]?KEY|TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE[_-]?KEY|AUTHORIZATION)$/i;
  let match: RegExpExecArray | null;
  while ((match = keys.exec(message)) !== null) {
    // Handle bare schemes in the same pass as assignments: masking them in a
    // prior pass can erase the next sensitive key and strand its quoted value.
    if (/^(?:basic|bearer)$/i.test(match[0]) && /\s/.test(message[keys.lastIndex] ?? "")) {
      let start = keys.lastIndex;
      while (/\s/.test(message[start] ?? "")) start += 1;
      const end = authValueEnd(message, start);
      hide(start, end);
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
    let contentStart = valueStart;
    let contentEnd: number;
    if (quote === '"' || quote === "'") {
      const delimiter = message.slice(valueStart, ++i);
      contentStart = i;
      contentEnd = message.length;
      // At escape depth d, a closing quote has d (mod 2*(d+1))
      // preceding backslashes. Other quotes belong to the credential value.
      for (; i < message.length; i += 1) {
        if (message[i] !== quote) continue;
        let slashStart = i;
        while (slashStart > valueStart && message[slashStart - 1] === "\\") slashStart -= 1;
        if ((i - slashStart) % (2 * (depth + 1)) === depth) {
          contentEnd = i - delimiter.length + 1;
          i += 1; break;
        }
      }
      // An unterminated value consumes the remainder, including newlines.
    } else {
      i = valueStart;
      if (/(?:^|[_-])AUTHORIZATION$/i.test(match[0])) {
        const scheme = /^(?:basic|bearer)\s+/i.exec(message.slice(i));
        if (scheme) { i += scheme[0].length; contentStart = i; }
        i = authValueEnd(message, i);
      } else {
        while (i < message.length && !/["'\s,;}\]]/.test(message[i])) i += 1;
      }
      contentEnd = i;
    }
    hide(contentStart, contentEnd);
    keys.lastIndex = i;
  }
}

// Start with main 1293b40d's masks. Keep source positions for surviving bytes:
// legacy masks can consume a closing quote, so their output alone cannot tell
// a closed credential from an unterminated one. Later passes may only mask
// surviving bytes; they can never restore anything the legacy pass removed.
function legacyDiagnosticMasks(input: string): { text: string; positions: number[] } {
  let text = input;
  let positions = Array.from({ length: input.length }, (_, i) => i);
  const mask = (pattern: RegExp, prefix = 0, quoted = false, value = "[redacted]") => {
    const chunks: string[] = [];
    const next: number[] = [];
    let copied = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const keptPrefix = prefix ? match[prefix].length + (quoted ? match[2].length : 0) : 0;
      const keptSuffix = quoted ? match[2].length : 0;
      let end = start + match[0].length;
      // A later legacy pattern may match only part of a synthetic marker.
      // Consume the whole marker instead of leaving a misleading trailing ].
      if (!keptSuffix && end > start && positions[end - 1] === -1) {
        while (end < positions.length && positions[end] === -1) end += 1;
      }
      chunks.push(text.slice(copied, start + keptPrefix), value, text.slice(end - keptSuffix, end));
      next.push(...positions.slice(copied, start + keptPrefix), ...Array<number>(value.length).fill(-1),
        ...positions.slice(end - keptSuffix, end));
      copied = end;
    }
    chunks.push(text.slice(copied));
    next.push(...positions.slice(copied));
    text = chunks.join(""); positions = next;
  };
  mask(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi, 0, false, "[redacted private key]");
  mask(/(\bauthorization\s*[:=]\s*(?:basic|bearer)\s+)[^\s,;]+/gi, 1);
  mask(/(\b(?:basic|bearer)\s+)[^\s,;]+/gi, 1);
  // Anchor at each maximal identifier, retaining legacy suffix recognition
  // (e.g. OPENAIAPIKEY). This avoids retrying its unbounded prefix at every
  // character of a long word. Accepting extra prefixes only adds masking.
  mask(/((?<![A-Z0-9_-])[A-Z0-9_-]*(?:API[_-]?KEY|ACCESS[_-]?KEY|TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE[_-]?KEY)["']?\s*[:=]\s*)(["'])(.*?)\2/gi, 1, true);
  mask(/((?<![A-Z0-9_-])[A-Z0-9_-]*(?:API[_-]?KEY|ACCESS[_-]?KEY|TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE[_-]?KEY)["']?\s*[:=]\s*["']?)[^"'\s,;}\]]+/gi, 1);
  mask(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:(?:proj|or-v1|ant)-)?[A-Za-z0-9_-]{16,}|(?:xai-|pplx-)[A-Za-z0-9]{20,}|(?:gsk_|hf_|r8_)[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|AKIA[0-9A-Z]{16}|xox[bap]-[A-Za-z0-9-]{10,}|eyJhbGciOi[A-Za-z0-9_.-]{40,})\b/g);
  return { text, positions };
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
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const legacy = legacyDiagnosticMasks(normalized);
  const hidden = new Uint8Array(normalized.length);
  redactAssignments(normalized, (start, end) => hidden.fill(1, start, end));
  const output: string[] = [];
  let masking = false;
  for (let i = 0; i < legacy.text.length; i += 1) {
    const hide = legacy.positions[i] >= 0 && hidden[legacy.positions[i]] === 1;
    if (hide) {
      if (!masking) output.push("[redacted]");
    } else output.push(legacy.text[i]);
    masking = hide;
  }
  return output.join("")
    .replace(/\[redacted\](?:\[redacted\])+/g, "[redacted]")
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
