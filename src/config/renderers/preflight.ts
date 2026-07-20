import type { CanonicalMcpStdioConnection } from "../mcp-stdio-connection.js";
import {
  CANONICAL_CONNECTION_FIELDS,
  RendererResult,
  RendererUnsupportedField,
  RendererWarning,
} from "./renderer-result.js";

const SECRET_KEY_PARTS = new Set([
  "apikey",
  "secret",
  "token",
  "password",
  "privatekey",
  "auth",
]);

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLocaleLowerCase("en-US");
}

function compact(value: string): string {
  return normalized(value).replace(/[^a-z0-9]+/g, "");
}

function isSecretKey(value: string): boolean {
  const parts = normalized(value).split(/[^a-z0-9]+/).filter(Boolean);
  const compactValue = parts.join("");
  const hasCompoundKey = parts.some(
    (part, index) =>
      (part === "api" && parts[index + 1] === "key") ||
      (part === "private" && parts[index + 1] === "key")
  );
  return hasCompoundKey || parts.some((part) => SECRET_KEY_PARTS.has(part)) || SECRET_KEY_PARTS.has(compactValue);
}

function isLongBase64Like(value: string): boolean {
  const candidate = value.trim();
  if (candidate.length < 40 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(candidate)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[+/_-]/].filter((re) => re.test(candidate)).length;
  return classes >= 2;
}

function secretValueReason(value: string): string | undefined {
  if (/\bbearer\s+\S+/iu.test(value)) return "Bearer credential material";
  if (/(?:https?|wss?|postgres(?:ql)?):\/\/[^\s/@:]+:[^\s/@]+@/iu.test(value)) {
    return "credential-bearing URL";
  }
  if (/-----BEGIN[^\n-]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)[^\n-]*-----/iu.test(value)) {
    return "PEM/private-key material";
  }
  if (/(?:api[_-]?key|secret|token|password|private[_-]?key|auth)\s*[:=]\s*\S+/iu.test(value)) {
    return "inline secret assignment";
  }
  if (isLongBase64Like(value)) return "long base64-like credential material";
  if (value.trim() && isSecretKey(value)) return "secret-like token or identifier";
  return undefined;
}

interface Finding {
  readonly path: string;
  readonly reason: string;
}

function findSecret(value: unknown, path: string, seen: WeakSet<object>): Finding | undefined {
  if (typeof value === "string") {
    const reason = secretValueReason(value);
    return reason ? { path, reason } : undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const finding = findSecret(value[index], `${path}[${index}]`, seen);
      if (finding) return finding;
    }
    return undefined;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (isSecretKey(key)) return { path: childPath, reason: "secret-like field name" };
    const finding = findSecret(child, childPath, seen);
    if (finding) return finding;
  }
  return undefined;
}

export function preflightRendererSpec<TConfig>(
  target: string,
  spec: CanonicalMcpStdioConnection
): RendererResult<TConfig> | undefined {
  const finding = findSecret(spec, "spec", new WeakSet<object>());
  if (!finding) return undefined;
  const warnings: RendererWarning[] = [
    {
      code: "secret-rejected",
      message: `Refused to render caller-supplied secret-like material: ${finding.reason}.`,
      field: finding.path,
    },
  ];
  return {
    target,
    status: "secret-rejected",
    warnings,
    unsupported: [],
    note: "No configuration was emitted because renderer preflight failed closed.",
  };
}

const DEFAULT_UNSUPPORTED_REASON: Record<string, string> = {
  name: "Human-readable name is not represented in the target configuration.",
  protocol: "Protocol metadata is implied by the target configuration shape.",
  envAllowlist: "The target does not expose a safe canonical environment allowlist field.",
  capabilities: "Capability metadata is not represented in the target configuration.",
  timeout: "The target does not standardize per-server timeout semantics.",
  trust: "Trust metadata is not represented in the target configuration.",
  description: "Description metadata is not represented in the target configuration.",
};

export function unsupportedCanonicalFields(
  represented: readonly string[],
  reasons: Readonly<Record<string, string>> = {}
): RendererUnsupportedField[] {
  const representedSet = new Set(represented);
  const seen = new Set<string>();
  const fields: RendererUnsupportedField[] = [];
  for (const field of CANONICAL_CONNECTION_FIELDS) {
    if (representedSet.has(field) || seen.has(field)) continue;
    seen.add(field);
    fields.push({
      field,
      reason: reasons[field] ?? DEFAULT_UNSUPPORTED_REASON[field] ?? "Not represented by target.",
    });
  }
  return fields;
}
