/** Provider-neutral execution contracts. Requested model is an execution selection input, not runtime identity or attestation. */

export type RuntimeEvidenceLevel = "none" | "reported" | "observed" | "attested";
export type RuntimeStatus = "success" | "failure" | "cancelled" | "timeout";
export type RuntimeBindingId = string;

/** How optional input bytes reach a child. `stdin` never serializes bytes into argv or env. */
export interface RuntimeInput {
  transport: "stdin";
  bytes: Uint8Array;
  /** Per-request input ceiling; defaults to `DEFAULT_RUNTIME_INPUT_BYTES`. */
  maxBytes?: number;
}

export const DEFAULT_RUNTIME_INPUT_BYTES = 1024 * 1024;

/** Explicit host-environment admission policy for a child runtime. */
export interface RuntimeEnvironmentPolicy {
  /** `inherit` preserves compatibility; `allowlist` admits only named host values; `scrubbed` admits none. */
  mode: "inherit" | "allowlist" | "scrubbed";
  /** Required only for `allowlist`; names are copied from the host, never synthesized. */
  allowlist?: readonly string[];
}

/** Independent byte ceilings for captured child streams. */
export interface RuntimeOutputLimits {
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

/** Per-execution workspace evidence. Binding ids are opaque portable tokens, never paths. */
export interface RuntimeWorkspaceRequest {
  isolation: "none" | "requested" | "verified";
  bindingId?: RuntimeBindingId;
}

/** Intent for human-gated or unattended execution and its permitted edit surface. */
export interface RuntimePermissionRequest {
  mode: "plan" | "unattended" | "interactive";
  edit: "forbidden" | "workspace";
}

/** Provider-neutral session continuity request. */
export interface RuntimeSessionRequest {
  mode: "new" | "resume";
  bindingId?: RuntimeBindingId;
}

export interface ExecutionSpec {
  fleetId: string;
  agentId: string;
  prompt: string;
  /** Optional opaque bytes delivered through child stdin instead of argv. */
  input?: RuntimeInput;
  role?: string;
  requestedAgent?: string;
  /**
   * Optional execution selection. Public `model` on `spawn_fleet` / `attach_agent`
   * is wired through here as one argv element (`opencode run --model <value>`).
   * It is a caller-supplied execution input, not runtime identity, authentication,
   * billing evidence, or attestation. Observed banner evidence lives in the
   * runtime's `RuntimeIdentity.model` and `Agent.runtime_model`.
   */
  requestedModel?: string;
  cwd: string;
  /** Explicit child environment. Adapters decide whether to inherit host values. */
  environment?: Record<string, string>;
  /** Optional host-environment admission policy; adapter defaults preserve compatibility. */
  environmentPolicy?: RuntimeEnvironmentPolicy;
  /** Optional bounded capture policy. Exceeding either bound is a deterministic failure. */
  output?: RuntimeOutputLimits;
  workspace?: RuntimeWorkspaceRequest;
  permissions?: RuntimePermissionRequest;
  session?: RuntimeSessionRequest;
  timeoutMs: number;
}

export interface RuntimeIdentity {
  adapterId: string;
  agent?: string;
  model?: string;
  provider?: string;
  evidence: RuntimeEvidenceLevel;
}

export interface RuntimeDiagnostic {
  severity: "warning" | "error";
  message: string;
  code?: string;
}

export interface RuntimeResult {
  status: RuntimeStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  diagnostics: RuntimeDiagnostic[];
  identity: RuntimeIdentity;
}

export interface RuntimeHandle {
  readonly id: string;
  readonly pid?: number;
  readonly startedAt: number;
  isAlive(): boolean;
}

export interface RuntimeDescriptor {
  id: string;
  displayName: string;
  defaultTimeoutMs: number;
  /** Future adapters may describe opaque, non-machine-specific execution bindings. */
  bindings?: readonly RuntimeBindingDescriptor[];
  workspace?: RuntimeWorkspaceDescriptor;
  permissions?: RuntimePermissionDescriptor;
  session?: RuntimeSessionDescriptor;
}

/** Publicly safe binding identity: never a host path, account name, or credential reference. */
export interface RuntimeBindingDescriptor {
  id: string;
  kind: "provider" | "runtime" | "workspace";
}

/** Portable workspace capability descriptor; locations intentionally remain private. */
export interface RuntimeWorkspaceDescriptor {
  mode: "caller-provided" | "ephemeral" | "managed";
  supportsIsolation: boolean;
}

/** Capability-oriented permission descriptor, without OS or account details. */
export interface RuntimePermissionDescriptor {
  mode: "restricted" | "workspace" | "unrestricted";
  capabilities: readonly string[];
}

/** Provider-neutral session continuity descriptor. */
export interface RuntimeSessionDescriptor {
  mode: "none" | "ephemeral" | "resumable";
  bindingId?: string;
}

/** True only for a request carrying a portable binding for independently verified isolation. */
export function hasVerifiedIsolatedWorkspace(spec: Pick<ExecutionSpec, "workspace">): boolean {
  return spec.workspace?.isolation === "verified" && isOpaqueBindingId(spec.workspace.bindingId);
}

function isOpaqueBindingId(value: string | undefined): value is RuntimeBindingId {
  // Binding identifiers intentionally admit no path separators, tildes, or
  // whitespace. They identify a runtime-owned record, not a machine location
  // or a user/account name.
  return value !== undefined && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface CancelResult {
  accepted: boolean;
  reason?: string;
}

export interface RuntimeAdapter {
  readonly id: string;
  describe(): RuntimeDescriptor;
  validate(spec: ExecutionSpec): ValidationResult;
  start(spec: ExecutionSpec): Promise<RuntimeHandle>;
  wait(handle: RuntimeHandle, signal?: AbortSignal): Promise<RuntimeResult>;
  cancel(handle: RuntimeHandle, reason: string): Promise<CancelResult>;
}

export function validateExecutionSpec(spec: ExecutionSpec): ValidationResult {
  const errors: string[] = [];
  if (!spec.fleetId) errors.push("fleetId is required");
  if (!spec.agentId) errors.push("agentId is required");
  if (!spec.cwd) errors.push("cwd is required");
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) {
    errors.push("timeoutMs must be a positive finite number");
  }
  if (spec.input && spec.input.transport !== "stdin") errors.push("input transport must be stdin");
  if (spec.input && !(spec.input.bytes instanceof Uint8Array)) errors.push("input bytes must be Uint8Array");
  if (spec.input?.maxBytes !== undefined && (!Number.isSafeInteger(spec.input.maxBytes) || spec.input.maxBytes < 0)) {
    errors.push("input maxBytes must be a non-negative safe integer");
  }
  if (spec.input && spec.input.bytes instanceof Uint8Array && spec.input.bytes.byteLength > (spec.input.maxBytes ?? DEFAULT_RUNTIME_INPUT_BYTES)) {
    errors.push(`input bytes exceed configured limit of ${spec.input.maxBytes ?? DEFAULT_RUNTIME_INPUT_BYTES}`);
  }
  if (spec.environmentPolicy && !["inherit", "allowlist", "scrubbed"].includes(spec.environmentPolicy.mode)) {
    errors.push("environment policy mode is invalid");
  }
  if (spec.environmentPolicy?.mode === "allowlist" && !spec.environmentPolicy.allowlist) {
    errors.push("allowlist environment policy requires allowlist names");
  }
  for (const name of spec.environmentPolicy?.allowlist ?? []) {
    if (!name || name.includes("\0") || name.includes("=")) errors.push(`invalid environment allowlist name: ${JSON.stringify(name)}`);
  }
  for (const [name, limit] of Object.entries({
    maxStdoutBytes: spec.output?.maxStdoutBytes,
    maxStderrBytes: spec.output?.maxStderrBytes,
  })) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
      errors.push(`${name} must be a non-negative safe integer`);
    }
  }
  if (spec.workspace?.isolation === "verified" && !isOpaqueBindingId(spec.workspace.bindingId)) {
    errors.push("verified workspace requires an opaque bindingId");
  }
  if (spec.workspace?.bindingId !== undefined && !isOpaqueBindingId(spec.workspace.bindingId)) {
    errors.push("workspace bindingId must be an opaque identifier");
  }
  if (spec.session?.mode === "resume" && !isOpaqueBindingId(spec.session.bindingId)) {
    errors.push("resumed session requires an opaque bindingId");
  }
  if (spec.session?.bindingId !== undefined && !isOpaqueBindingId(spec.session.bindingId)) {
    errors.push("session bindingId must be an opaque identifier");
  }
  if (spec.workspace && !["none", "requested", "verified"].includes(spec.workspace.isolation)) {
    errors.push("workspace isolation mode is invalid");
  }
  if (spec.permissions && !["plan", "unattended", "interactive"].includes(spec.permissions.mode)) {
    errors.push("permission mode is invalid");
  }
  if (spec.permissions && !["forbidden", "workspace"].includes(spec.permissions.edit)) {
    errors.push("edit permission is invalid");
  }
  if (spec.session && !["new", "resume"].includes(spec.session.mode)) {
    errors.push("session mode is invalid");
  }
  return { ok: errors.length === 0, errors };
}
