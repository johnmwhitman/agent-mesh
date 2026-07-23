import { agentTimeoutMs, buildRunArgs } from "../spawn-config.js";
import { classifySpawnResult } from "../spawn-result.js";
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
  type RuntimeDiagnostic,
  type RuntimeHandle,
  type RuntimeResult,
  type ValidationResult,
} from "./types.js";

export interface OpenCodeRuntimeAdapterOptions {
  command?: string;
  buildArgs?: (spec: ExecutionSpec) => string[];
  spawnProcess?: SpawnProcess;
  terminationGraceMs?: number;
}

function diagnosticsFor(result: { warning?: string; error?: string }): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  if (result.warning) diagnostics.push({ severity: "warning", message: result.warning });
  if (result.error) diagnostics.push({ severity: "error", message: result.error });
  return diagnostics;
}

function failure(
  raw: RawProcessResult,
  error: string,
  status: "failure" | "cancelled" | "timeout" = "failure",
): RuntimeResult {
  return {
    status,
    stdout: raw.stdout,
    stderr: raw.stderr,
    exitCode: raw.exitCode,
    signal: raw.signal,
    error,
    diagnostics: [{ severity: "error", message: error }],
    identity: { adapterId: "opencode-cli", evidence: "none" },
  };
}

/** Compatibility adapter preserving the existing `opencode run` behavior. */
export class OpenCodeRuntimeAdapter implements RuntimeAdapter {
  readonly id = "opencode-cli";
  private readonly command: string;
  private readonly buildArgs: (spec: ExecutionSpec) => string[];
  private readonly spawnProcess?: SpawnProcess;
  private readonly terminationGraceMs?: number;

  constructor(options: OpenCodeRuntimeAdapterOptions = {}) {
    this.command = options.command ?? "opencode";
    this.buildArgs = options.buildArgs ?? ((spec) => buildRunArgs({ prompt: spec.prompt, agentFile: spec.requestedAgent }));
    this.spawnProcess = options.spawnProcess;
    this.terminationGraceMs = options.terminationGraceMs;
  }

  describe(): RuntimeDescriptor {
    return { id: this.id, displayName: "OpenCode CLI", defaultTimeoutMs: agentTimeoutMs() };
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
        // Preserve current OpenCode behavior while allowing explicit overrides.
        environment: { ...process.env, ...spec.environment, AGENT_MESH_CHILD: "1" },
        timeoutMs: spec.timeoutMs,
        terminationGraceMs: this.terminationGraceMs,
        normalizeClose: (raw) => {
          const classified = classifySpawnResult({
            exitCode: raw.exitCode,
            stdout: raw.stdout,
            stderr: raw.stderr,
            requestedAgent: spec.requestedAgent,
          });
          return {
            status: classified.success ? "success" : "failure",
            stdout: classified.stdout,
            stderr: classified.stderr,
            exitCode: raw.exitCode,
            signal: raw.signal,
            error: classified.error,
            diagnostics: diagnosticsFor(classified),
            identity: {
              adapterId: this.id,
              agent: classified.runtime_agent,
              model: classified.runtime_model,
              evidence: classified.runtime_agent || classified.runtime_model ? "observed" : "none",
            },
          };
        },
        normalizeSpawnError: (raw, error) => failure(raw, error.message),
        normalizeTimeout: (raw) => failure(raw, `Timed out after ${spec.timeoutMs}ms`, "timeout"),
        normalizeCancellation: (raw, reason) => failure(raw, `Cancelled: ${reason}`, "cancelled"),
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
