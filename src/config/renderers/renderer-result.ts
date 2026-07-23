/**
 * Renderer result envelope for MCP connection configuration.
 *
 * Every renderer returns this structure so callers can distinguish:
 * - supported targets with a concrete config
 * - unsupported or unverified targets (explicit status + warnings)
 *
 * No renderer ever silently drops fields; unsupported inputs are reported.
 */

export type RendererStatus =
  | "supported"
  | "unsupported"
  | "unverified"
  | "secret-rejected";

export interface RendererWarning {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
}

export interface RendererUnsupportedField {
  readonly field: string;
  readonly reason: string;
  readonly suggestion?: string;
}

export const CANONICAL_CONNECTION_FIELDS = [
  "serverId",
  "name",
  "protocol",
  "transport",
  "command",
  "envAllowlist",
  "capabilities",
  "timeout",
  "trust",
  "description",
] as const;

export interface RendererResult<TConfig = unknown> {
  /** Target identifier (e.g., "generic-mcp-json", "opencode-jsonc"). */
  readonly target: string;
  /** Outcome status. */
  readonly status: RendererStatus;
  /** The rendered configuration when status is "supported". */
  readonly config?: TConfig;
  /** Structured warnings for the caller (never silent). */
  readonly warnings: readonly RendererWarning[];
  /** Fields from the canonical spec that could not be represented. */
  readonly unsupported: readonly RendererUnsupportedField[];
  /** Optional human-readable note. */
  readonly note?: string;
}

/**
 * Type guard for renderer results.
 */
export function isRendererResult(value: unknown): value is RendererResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.target === "string" &&
    typeof v.status === "string" &&
    Array.isArray(v.warnings) &&
    Array.isArray(v.unsupported)
  );
}
