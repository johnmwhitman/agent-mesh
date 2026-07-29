import {
  cancelProcessExecution,
  resolveChildEnvironment,
  startProcessExecution,
  waitForProcessExecution,
  type RawProcessResult,
  type SpawnProcess,
} from "./process.js";
import {
  hasVerifiedIsolatedWorkspace,
  validateExecutionSpec,
  type CancelResult,
  type ExecutionSpec,
  type RuntimeAdapter,
  type RuntimeDescriptor,
  type RuntimeHandle,
  type RuntimeResult,
  type ValidationResult,
} from "./types.js";
import { isAbsolute } from "node:path";

const DEFAULT_KIMI_PROMPT_BYTES = 1024 * 1024;
const MAX_KIMI_FINAL_FRAMES = 64;

export interface KimiRuntimeAdapterOptions {
  /** Operator-resolved exact executable. There is intentionally no ambient `kimi` fallback. */
  command: string;
  /** Configured compatibility pin; the private binding owner verifies the executable separately. */
  harnessVersion: string;
  /** Opaque workspace bindings pre-verified by the adapter owner. Never paths or account names. */
  verifiedWorkspaceBindingIds?: readonly string[];
  spawnProcess?: SpawnProcess;
  terminationGraceMs?: number;
  maxPromptBytes?: number;
}

function result(
  raw: RawProcessResult,
  status: RuntimeResult["status"],
  error?: string,
  stdout = "",
): RuntimeResult {
  return {
    status,
    stdout,
    // Kimi diagnostics may echo prompts, paths, or authentication details.
    // Raw stderr remains bounded in-memory for normalization and is never
    // projected into the public runtime result.
    stderr: "",
    exitCode: raw.exitCode,
    signal: raw.signal,
    error,
    diagnostics: error ? [{ severity: "error", message: error }] : [],
    // A requested model is not an observed model. Print JSON 1.49.0 exposes
    // no effective model identity, provider account, or accounting lane.
    identity: { adapterId: "kimi-cli", evidence: "none" },
  };
}

function parseFinalAssistantText(stdout: string): string {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("missing final assistant frame");
  if (lines.length > MAX_KIMI_FINAL_FRAMES) {
    throw new Error(`too many final assistant frames (maximum ${MAX_KIMI_FINAL_FRAMES})`);
  }

  let finalText = "";
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("malformed JSONL frame");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("final frame must be an object");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 2 || keys[0] !== "content" || keys[1] !== "role") {
      throw new Error("final frame schema changed");
    }
    if (record.role !== "assistant" || typeof record.content !== "string" || record.content.length === 0) {
      throw new Error("final frame must contain non-empty assistant text");
    }
    finalText = record.content;
  }
  return finalText;
}

function isProviderOverrideEnvironment(name: string): boolean {
  const normalized = name.toUpperCase();
  return normalized.startsWith("KIMI_") || normalized.startsWith("OPENAI_");
}

/**
 * Offline-testable adapter for the official Kimi CLI print surface.
 *
 * OAuth remains entirely CLI-owned. This adapter never reads, imports, refreshes,
 * or serializes credentials and refuses provider/API override environment keys
 * so a subscription binding cannot silently become a different accounting lane.
 */
export class KimiRuntimeAdapter implements RuntimeAdapter {
  readonly id = "kimi-cli";
  private readonly command: string;
  private readonly harnessVersion: string;
  private readonly verifiedWorkspaceBindingIds: ReadonlySet<string>;
  private readonly spawnProcess?: SpawnProcess;
  private readonly terminationGraceMs?: number;
  private readonly maxPromptBytes: number;

  constructor(options: KimiRuntimeAdapterOptions) {
    this.command = options.command;
    this.harnessVersion = options.harnessVersion;
    this.verifiedWorkspaceBindingIds = new Set(options.verifiedWorkspaceBindingIds ?? []);
    this.spawnProcess = options.spawnProcess;
    this.terminationGraceMs = options.terminationGraceMs;
    this.maxPromptBytes = options.maxPromptBytes ?? DEFAULT_KIMI_PROMPT_BYTES;
  }

  describe(): RuntimeDescriptor {
    return {
      id: this.id,
      displayName: "Kimi CLI",
      defaultTimeoutMs: 30 * 60 * 1000,
      harness: {
        name: "kimi-cli",
        version: this.harnessVersion,
        versionEvidence: "configured",
        transports: ["stdin-text", "stream-json-final"],
      },
      workspace: { mode: "caller-provided", supportsIsolation: true },
      permissions: {
        mode: "workspace",
        capabilities: ["filesystem.read", "filesystem.write", "shell", "test", "git"],
      },
      session: { mode: "ephemeral" },
    };
  }

  validate(spec: ExecutionSpec): ValidationResult {
    const errors = [...validateExecutionSpec(spec).errors];
    if (!this.command || !isAbsolute(this.command)) errors.push("Kimi command must be an absolute path");
    if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(this.harnessVersion)) {
      errors.push("Kimi harnessVersion must be a bounded version label");
    }
    if (!Number.isSafeInteger(this.maxPromptBytes) || this.maxPromptBytes <= 0) {
      errors.push("Kimi maxPromptBytes must be a positive safe integer");
    }
    if (spec.input !== undefined) errors.push("Kimi adapter owns stdin input delivery");
    if (!spec.prompt) errors.push("Kimi prompt is required");
    if (Buffer.byteLength(spec.prompt, "utf8") > this.maxPromptBytes) {
      errors.push(`Kimi prompt exceeds configured limit of ${this.maxPromptBytes} bytes`);
    }
    if (spec.requestedModel !== undefined &&
        (!spec.requestedModel ||
          spec.requestedModel.length > 256 ||
          /[\s\0]/u.test(spec.requestedModel))) {
      errors.push("Kimi requestedModel must be a bounded non-whitespace string");
    }
    if (spec.environmentPolicy === undefined || spec.environmentPolicy.mode === "inherit") {
      errors.push("Kimi requires an explicit scrubbed or allowlist environment policy");
    }
    for (const name of [
      ...Object.keys(spec.environment ?? {}),
      ...(spec.environmentPolicy?.allowlist ?? []),
    ]) {
      if (isProviderOverrideEnvironment(name)) {
        errors.push(`Kimi provider override environment is not allowed: ${name}`);
      }
    }
    if (!spec.permissions) {
      errors.push("Kimi requires an explicit permission request");
    } else if (spec.permissions.mode === "interactive") {
      errors.push("Kimi print adapter does not support interactive permission");
    } else if (spec.permissions.mode === "plan" &&
        (spec.permissions.edit !== "forbidden" || !this.hasAdmittedWorkspace(spec))) {
      errors.push("Kimi plan mode requires forbidden workspace edits in verified isolation");
    } else if (spec.permissions.mode === "unattended" &&
        (spec.permissions.edit !== "workspace" || !this.hasAdmittedWorkspace(spec))) {
      errors.push("Kimi unattended mode requires workspace-only edits in verified isolation");
    }
    if (!spec.session || spec.session.mode !== "new") {
      errors.push("Kimi print adapter currently supports new sessions only");
    }
    return { ok: errors.length === 0, errors };
  }

  private hasAdmittedWorkspace(spec: ExecutionSpec): boolean {
    return hasVerifiedIsolatedWorkspace(spec) &&
      this.verifiedWorkspaceBindingIds.has(spec.workspace!.bindingId!);
  }

  async start(spec: ExecutionSpec): Promise<RuntimeHandle> {
    const validation = this.validate(spec);
    if (!validation.ok) throw new Error(`Invalid Kimi execution spec: ${validation.errors.join(", ")}`);

    const args = [
      "--print",
      "--input-format", "text",
      "--output-format", "stream-json",
      "--final-message-only",
      "--work-dir", spec.cwd,
      ...(spec.requestedModel ? ["--model", spec.requestedModel] : []),
      ...(spec.permissions?.mode === "plan" ? ["--plan"] : []),
    ];
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
        args,
        cwd: spec.cwd,
        environment: resolveChildEnvironment(process.env, spec.environment, spec.environmentPolicy),
        timeoutMs: spec.timeoutMs,
        terminationGraceMs: this.terminationGraceMs,
        normalizeClose: (raw) => {
          if (raw.signal) return result(raw, "failure", `Kimi process terminated by signal ${raw.signal}`);
          if (raw.exitCode !== 0) return result(raw, "failure", `Kimi process failed with exit code ${raw.exitCode}`);
          try {
            return result(raw, "success", undefined, parseFinalAssistantText(raw.stdout));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return result(raw, "failure", `Invalid Kimi stream-json output: ${message}`);
          }
        },
        // Node spawn errors include the executable path. Keep that private
        // operator binding out of public results and diagnostics.
        normalizeSpawnError: (raw) => result(raw, "failure", "Kimi process failed to start"),
        normalizeTimeout: (raw) => result(raw, "timeout", `Kimi timed out after ${spec.timeoutMs}ms`),
        normalizeCancellation: (raw, reason) => result(raw, "cancelled", `Kimi cancelled: ${reason}`),
        normalizeOutputOverflow: (raw, stream, limit) =>
          result(raw, "failure", `${stream} exceeded configured limit of ${limit} bytes`),
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
