import {
  cancelProcessExecution,
  startProcessExecution,
  waitForProcessExecution,
  type RawProcessResult,
  type SpawnProcess,
} from "./process.js";
import {
  validateExecutionSpec,
  type CancelResult,
  type ExecutionSpec,
  type RuntimeAdapter,
  type RuntimeDescriptor,
  type RuntimeHandle,
  type RuntimeResult,
  type ValidationResult,
} from "./types.js";

export interface LocalProcessRuntimeAdapterOptions {
  command: string;
  buildArgs: (spec: ExecutionSpec) => string[];
  spawnProcess?: SpawnProcess;
}

function normalized(
  raw: RawProcessResult,
  status: RuntimeResult["status"],
  error?: string,
): RuntimeResult {
  return {
    status,
    stdout: raw.stdout,
    stderr: raw.stderr,
    exitCode: raw.exitCode,
    signal: raw.signal,
    error,
    diagnostics: error ? [{ severity: "error", message: error }] : [],
    identity: { adapterId: "local-process", evidence: "none" },
  };
}

/** Deterministic generic argv-only runtime for local conformance evidence. */
export class LocalProcessRuntimeAdapter implements RuntimeAdapter {
  readonly id = "local-process";
  private readonly command: string;
  private readonly buildArgs: (spec: ExecutionSpec) => string[];
  private readonly spawnProcess?: SpawnProcess;

  constructor(options: LocalProcessRuntimeAdapterOptions) {
    this.command = options.command;
    this.buildArgs = options.buildArgs;
    this.spawnProcess = options.spawnProcess;
  }

  describe(): RuntimeDescriptor {
    return { id: this.id, displayName: "Local process", defaultTimeoutMs: 30 * 60 * 1000 };
  }

  validate(spec: ExecutionSpec): ValidationResult {
    return validateExecutionSpec(spec);
  }

  async start(spec: ExecutionSpec): Promise<RuntimeHandle> {
    const validation = this.validate(spec);
    if (!validation.ok) throw new Error(`Invalid execution spec: ${validation.errors.join(", ")}`);
    return startProcessExecution(
      spec,
      {
        command: this.command,
        args: this.buildArgs(spec),
        cwd: spec.cwd,
        // The local adapter never inherits ambient process credentials implicitly.
        environment: spec.environment ?? {},
        timeoutMs: spec.timeoutMs,
        normalizeClose: (raw) => {
          if (raw.signal) return normalized(raw, "failure", `Process terminated by signal ${raw.signal}`);
          if (raw.exitCode !== 0) return normalized(raw, "failure", `Process failed with exit code ${raw.exitCode}`);
          return normalized(raw, "success");
        },
        normalizeSpawnError: (raw, error) => normalized(raw, "failure", error.message),
        normalizeTimeout: (raw) => normalized(raw, "timeout", `Timed out after ${spec.timeoutMs}ms`),
        normalizeCancellation: (raw, reason) => normalized(raw, "cancelled", `Cancelled: ${reason}`),
      },
      this.spawnProcess,
    );
  }

  wait(handle: RuntimeHandle, signal?: AbortSignal): Promise<RuntimeResult> {
    return waitForProcessExecution(handle, signal);
  }

  cancel(handle: RuntimeHandle, reason: string): Promise<CancelResult> {
    return cancelProcessExecution(handle, reason);
  }
}
