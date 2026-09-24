import { isAbsolute } from "node:path";
import {
  cancelProcessExecution,
  resolveChildEnvironment,
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
import { parseAgentTextResultEnvelope, type ResultContractStatus } from "../result-contract.js";

const DEFAULT_GROK_PROMPT_BYTES = 1024 * 1024;
// The private wrapper may spend up to 500 ms escalating its detached provider
// group after TERM. Keep the outer runtime alive long enough to finish that
// cleanup before MeshFleet sends KILL to the wrapper process group.
const DEFAULT_GROK_TERMINATION_GRACE_MS = 1_000;
const GROK_TASK_ARG = "Complete the following MeshFleet text task exactly as provided on stdin.";
const PROFILE_ENVIRONMENT = [
  "HOME",
  "USER",
  "USERPROFILE",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "PATH",
  "Path",
] as const;

export interface GrokCliRuntimeAdapterOptions {
  /** Operator-resolved private wrapper. There is intentionally no ambient executable fallback. */
  command: string;
  /** Configured wrapper compatibility label; no version probe runs during registration. */
  harnessVersion: string;
  spawnProcess?: SpawnProcess;
  terminationGraceMs?: number;
  maxPromptBytes?: number;
  /** Test/operator seam. Only fixed profile and interpreter locator names cross into the child. */
  hostEnvironment?: NodeJS.ProcessEnv;
}

function normalized(
  raw: RawProcessResult,
  status: RuntimeResult["status"],
  error?: string,
  stdout = "",
  resultContract?: ResultContractStatus,
): RuntimeResult {
  return {
    status,
    stdout,
    // Wrapper/provider diagnostics can contain prompts, paths, account state, or auth detail.
    stderr: "",
    exitCode: raw.exitCode,
    signal: raw.signal,
    error,
    diagnostics: error ? [{ severity: "error", message: error }] : [],
    identity: { adapterId: "grok-cli", evidence: "none" },
    ...(resultContract ? { resultContract } : {}),
  };
}

function profileEnvironment(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const admitted: NodeJS.ProcessEnv = {};
  for (const name of PROFILE_ENVIRONMENT) {
    const value = host[name];
    if (value !== undefined && value.trim().length > 0) admitted[name] = value;
  }
  return admitted;
}

/**
 * Text-only adapter for the operator-owned Grok subscription wrapper.
 *
 * This is an explicit capacity lane, not an automatic substitute for an agentic runtime:
 * it cannot read or edit a workspace, cannot honor provider/model remapping, and cannot attest
 * the effective account or model. The private wrapper continues to own credential discovery.
 */
export class GrokCliRuntimeAdapter implements RuntimeAdapter {
  readonly id = "grok-cli";
  private readonly command: string;
  private readonly harnessVersion: string;
  private readonly spawnProcess?: SpawnProcess;
  private readonly terminationGraceMs: number;
  private readonly maxPromptBytes: number;
  private readonly hostEnvironment: NodeJS.ProcessEnv;

  constructor(options: GrokCliRuntimeAdapterOptions) {
    this.command = options.command;
    this.harnessVersion = options.harnessVersion;
    this.spawnProcess = options.spawnProcess;
    this.terminationGraceMs = options.terminationGraceMs ?? DEFAULT_GROK_TERMINATION_GRACE_MS;
    this.maxPromptBytes = options.maxPromptBytes ?? DEFAULT_GROK_PROMPT_BYTES;
    this.hostEnvironment = options.hostEnvironment ?? process.env;
  }

  describe(): RuntimeDescriptor {
    return {
      id: this.id,
      displayName: "Grok subscription CLI",
      defaultTimeoutMs: 30 * 60 * 1000,
      failoverEligible: false,
      harness: {
        name: "grk",
        version: this.harnessVersion,
        versionEvidence: "configured",
        transports: ["stdin-text", "final-text"],
      },
      permissions: { mode: "restricted", capabilities: ["text.completion"] },
      session: { mode: "ephemeral" },
    };
  }

  validate(spec: ExecutionSpec): ValidationResult {
    const errors = [...validateExecutionSpec(spec).errors];
    if (!this.command || !isAbsolute(this.command)) {
      errors.push("Grok command must be an absolute path");
    }
    if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(this.harnessVersion)) {
      errors.push("Grok harnessVersion must be a bounded version label");
    }
    if (!Number.isSafeInteger(this.maxPromptBytes) || this.maxPromptBytes <= 0) {
      errors.push("Grok maxPromptBytes must be a positive safe integer");
    }
    if (!spec.prompt) errors.push("Grok prompt is required");
    if (spec.prompt.includes("\0")) {
      errors.push("Grok prompt cannot contain NUL bytes");
    }
    if (Buffer.byteLength(spec.prompt, "utf8") > this.maxPromptBytes) {
      errors.push(`Grok prompt exceeds configured limit of ${this.maxPromptBytes} bytes`);
    }
    if (spec.input !== undefined) errors.push("Grok wrapper owns prompt delivery");
    if (spec.requestedAgent !== undefined) errors.push("Grok text runtime does not support agent selection");
    if (spec.requestedModel !== undefined) errors.push("Grok text runtime does not support model remapping");
    if (spec.workspace !== undefined) errors.push("Grok text runtime does not accept workspace authority");
    if (spec.environmentPolicy?.mode !== "scrubbed") {
      errors.push("Grok requires a scrubbed host environment policy");
    }
    if (Object.keys(spec.environment ?? {}).length > 0) {
      errors.push("Grok text runtime does not accept caller environment");
    }
    if (spec.permissions?.mode !== "unattended" || spec.permissions.edit !== "forbidden") {
      errors.push("Grok text runtime requires unattended execution with edits forbidden");
    }
    if (spec.session?.mode !== "new") {
      errors.push("Grok text runtime supports new sessions only");
    }
    return { ok: errors.length === 0, errors };
  }

  async start(spec: ExecutionSpec): Promise<RuntimeHandle> {
    const validation = this.validate(spec);
    if (!validation.ok) {
      throw new Error(`Invalid Grok execution spec: ${validation.errors.join(", ")}`);
    }
    const processSpec: ExecutionSpec = {
      ...spec,
      input: {
        transport: "stdin",
        bytes: Buffer.from(spec.prompt, "utf8"),
        maxBytes: this.maxPromptBytes,
      },
    };
    return startProcessExecution(
      processSpec,
      {
        command: this.command,
        args: [GROK_TASK_ARG],
        cwd: spec.cwd,
        environment: resolveChildEnvironment(
          this.hostEnvironment,
          undefined,
          spec.environmentPolicy,
          {
            ...profileEnvironment(this.hostEnvironment),
            // The wrapper enforces an empty local toolset only on this explicit boundary.
            GROK_TEXT_ONLY: "1",
            // A MeshFleet task is already bounded context. Ambient memory injection would widen
            // disclosure beyond the caller's prompt and make the output non-reproducible.
            NO_MEMORY: "1",
          },
        ),
        timeoutMs: spec.timeoutMs,
        terminationGraceMs: this.terminationGraceMs,
        normalizeClose: (raw) => {
          if (raw.signal) {
            return normalized(raw, "failure", `Grok process terminated by signal ${raw.signal}`);
          }
          if (raw.exitCode !== 0) {
            return normalized(raw, "failure", `Grok process failed with exit code ${raw.exitCode}`);
          }
          if (raw.stdout.trim().length === 0) {
            return normalized(raw, "failure", "Grok returned an empty final response");
          }
          const parsed = parseAgentTextResultEnvelope(raw.stdout);
          if (!parsed.ok) {
            return normalized(raw, "failure", `Invalid Grok text result: ${parsed.reason}`);
          }
          return normalized(raw, "success", undefined, parsed.output, parsed.status);
        },
        normalizeSpawnError: (raw) => normalized(raw, "failure", "Grok process failed to start"),
        normalizeTimeout: (raw) => normalized(raw, "timeout", `Grok timed out after ${spec.timeoutMs}ms`),
        normalizeCancellation: (raw, reason) => normalized(raw, "cancelled", `Grok cancelled: ${reason}`),
        normalizeOutputOverflow: (raw, stream, limit) =>
          normalized(raw, "failure", `${stream} exceeded configured limit of ${limit} bytes`),
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
