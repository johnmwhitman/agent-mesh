/** Provider-neutral execution contracts. Requested model is an execution selection input, not runtime identity or attestation. */

export type RuntimeEvidenceLevel = "none" | "reported" | "observed" | "attested";
export type RuntimeStatus = "success" | "failure" | "cancelled" | "timeout";

export interface ExecutionSpec {
  fleetId: string;
  agentId: string;
  prompt: string;
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
  return { ok: errors.length === 0, errors };
}
