/**
 * Canonical MCP stdio connection specification for Agent Mesh.
 *
 * This module defines a single source of truth for the packaged `meshfleet`
 * stdio MCP server identity, command, argv, transport, and capability metadata.
 * It contains NO inline secrets, tokens, or credentials. Environment variable
 * references are allowed only where a target has proven support.
 *
 * All renderers MUST consume this spec and preserve:
 * - server identity ("meshfleet")
 * - transport ("stdio")
 * - command + argv (["npx", "-y", "meshfleet"])
 * - timeout semantics where supported
 *
 * Unsupported fields MUST be reported explicitly; they are never silently dropped.
 */

export type Transport = "stdio" | "sse" | "http";

export type Capability = "tools" | "prompts" | "resources" | "sampling";

export interface TimeoutPolicy {
  /** Default tool call timeout in milliseconds. */
  readonly defaultToolTimeoutMs: number;
  /** Optional per-tool overrides. */
  readonly perTool?: Readonly<Record<string, number>>;
}

export interface TrustMetadata {
  /** Whether the server is considered trusted for local stdio execution. */
  readonly localStdioTrusted: boolean;
  /** Notes about provenance or verification. */
  readonly notes?: string;
}

export interface CanonicalMcpStdioConnection {
  /** Stable server identity used by all clients. */
  readonly serverId: string;
  /** Human-readable name. */
  readonly name: string;
  /** Protocol version this connection targets. */
  readonly protocol: string;
  /** Transport. Always "stdio" for the packaged executable. */
  readonly transport: Transport;
  /** Command and argv that start the server. */
  readonly command: readonly string[];
  /** Environment variable allowlist for this connection (no inline secrets). */
  readonly envAllowlist: readonly string[];
  /** Declared MCP capabilities. */
  readonly capabilities: readonly Capability[];
  /** Timeout policy. */
  readonly timeout: TimeoutPolicy;
  /** Trust metadata. */
  readonly trust: TrustMetadata;
  /** Optional description for documentation. */
  readonly description?: string;
}

/**
 * The single canonical spec for the packaged Agent Mesh MCP stdio server.
 * This object is frozen and must not be mutated at runtime.
 */
export const MESH_FLEET_STDIO: CanonicalMcpStdioConnection = Object.freeze({
  serverId: "meshfleet",
  name: "Agent Mesh (meshfleet)",
  protocol: "2024-11-05",
  transport: "stdio",
  command: Object.freeze(["npx", "-y", "meshfleet"]),
  envAllowlist: Object.freeze([
    "MESHFLEET_DB_FILE",
    "AGENT_MESH_CHILD",
    "MESHFLEET_RATIFY_SWEEP_MS",
    "npm_config_offline",
  ]),
  capabilities: Object.freeze(["tools"] as const),
  timeout: Object.freeze({
    defaultToolTimeoutMs: 300_000,
  }),
  trust: Object.freeze({
    localStdioTrusted: true,
    notes: "Packaged via npm; stdio process boundary verified by mcp-stdio.test.ts",
  }),
  description:
    "Packaged Agent Mesh MCP server. Provides fleet coordination, message routing, and receipt ledger over stdio.",
});

/**
 * Type guard for the canonical connection.
 */
export function isCanonicalMcpStdioConnection(
  value: unknown
): value is CanonicalMcpStdioConnection {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.serverId === "string" &&
    typeof v.name === "string" &&
    typeof v.protocol === "string" &&
    (v.transport === "stdio" || v.transport === "sse" || v.transport === "http") &&
    Array.isArray(v.command) &&
    Array.isArray(v.envAllowlist) &&
    Array.isArray(v.capabilities) &&
    typeof v.timeout === "object" &&
    v.timeout !== null &&
    typeof (v.timeout as Record<string, unknown>).defaultToolTimeoutMs === "number" &&
    typeof v.trust === "object" &&
    v.trust !== null &&
    typeof (v.trust as Record<string, unknown>).localStdioTrusted === "boolean"
  );
}
