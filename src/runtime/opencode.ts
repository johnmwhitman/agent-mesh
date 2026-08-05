import { agentTimeoutMs, buildRunArgs } from "../spawn-config.js";
import { classifySpawnResult } from "../spawn-result.js";
import { parseOpenCodeEvents } from "./opencode-events.js";
import { noToolCallNotice } from "../hollow-result.js";
import {
  cancelProcessExecution,
  startProcessExecution,
  resolveChildEnvironment,
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
    this.buildArgs = options.buildArgs ?? ((spec) => buildRunArgs({
      prompt: spec.prompt,
      requestedModel: spec.requestedModel,
      agentFile: spec.requestedAgent,
    }));
    this.spawnProcess = options.spawnProcess;
    this.terminationGraceMs = options.terminationGraceMs;
  }

  describe(): RuntimeDescriptor {
    return { id: this.id, displayName: "OpenCode CLI", defaultTimeoutMs: agentTimeoutMs() };
  }

  validate(spec: ExecutionSpec): ValidationResult {
    const validation = validateExecutionSpec(spec);
    // OpenCode is intentionally left on its verified argv/ignored-stdin
    // contract. Native adapters may opt into ProcessExecution stdin delivery.
    if (spec.input) validation.errors.push("OpenCode CLI does not support stdin input");
    return { ok: validation.errors.length === 0, errors: validation.errors };
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
        environment: resolveChildEnvironment(
          process.env,
          spec.environment,
          spec.environmentPolicy,
          { AGENT_MESH_CHILD: "1" },
          "inherit",
        ),
        timeoutMs: spec.timeoutMs,
        terminationGraceMs: this.terminationGraceMs,
        normalizeClose: (raw) => {
          // The child now speaks NDJSON (`--format json`). Convert it back to
          // prose BEFORE classification so every downstream consumer — the
          // emptiness check, the ledger, `collect_results` — sees the same
          // assistant text it always saw, while the structural facts travel
          // alongside it on `trace`.
          //
          // A stream that does not parse yields `parsed: false`, and we fall
          // back to the raw bytes and today's exact behaviour. Degrading to the
          // OLD guard is safe; degrading to a confident empty parse would not
          // be, which is why the parser refuses to invent one.
          const events = parseOpenCodeEvents(raw.stdout);
          const stdout = events.parsed ? events.text : raw.stdout;
          const classified = classifySpawnResult({
            exitCode: raw.exitCode,
            stdout,
            stderr: raw.stderr,
            requestedAgent: spec.requestedAgent,
            requestedModel: spec.requestedModel,
          });
          return {
            status: classified.success ? "success" : "failure",
            stdout: classified.stdout,
            trace: events.parsed
              ? {
                  toolCalls: events.toolCalls,
                  toolNames: events.toolNames,
                  finishReason: events.finishReason,
                  steps: events.steps,
                }
              : undefined,
            stderr: classified.stderr,
            exitCode: raw.exitCode,
            signal: raw.signal,
            error: classified.error,
            // The zero-tool-call notice rides the diagnostics channel as a
            // WARNING rather than an error, and that choice is the point: an
            // agent that read nothing has not necessarily failed (a one-shot
            // summary needs no tools), but a caller who is about to believe its
            // findings must be told it observed nothing. Attached here, in the
            // adapter, so BOTH the inline path (index.ts) and the durable
            // lifecycle path inherit it — a notice wired into only one of them
            // is a guard with a hole in whichever path was missed.
            diagnostics: [
              ...diagnosticsFor(classified),
              ...(classified.success && events.parsed && events.toolCalls === 0
                ? [
                    {
                      severity: "warning" as const,
                      code: "NO_TOOL_CALLS",
                      message:
                        noToolCallNotice({
                          status: "success",
                          trace: {
                            toolCalls: events.toolCalls,
                            toolNames: events.toolNames,
                            finishReason: events.finishReason,
                            steps: events.steps,
                          },
                        }) ?? "",
                    },
                  ]
                : []),
            ],
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
        normalizeOutputOverflow: (raw, stream, limit) =>
          failure(raw, `${stream} exceeded configured limit of ${limit} bytes`),
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
