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

const DEFAULT_CLAUDE_PROMPT_BYTES = 1024 * 1024;

export interface ClaudeRuntimeAdapterOptions {
  /** Operator-resolved exact executable. There is intentionally no ambient `claude` fallback. */
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
    // Provider diagnostics may carry prompts, paths, account state, or authentication detail.
    // They remain bounded by the common process layer but never cross the runtime boundary.
    stderr: "",
    exitCode: raw.exitCode,
    signal: raw.signal,
    error,
    diagnostics: error ? [{ severity: "error", message: error }] : [],
    // A caller-selected model is not observed identity. Text print mode exposes no independent
    // effective-model or account attestation, so the evidence level remains honest.
    identity: { adapterId: "claude-cli", evidence: "none" },
  };
}

function isProviderOverrideEnvironment(name: string): boolean {
  const normalized = name.toUpperCase();
  return normalized.startsWith("ANTHROPIC_") ||
    normalized.startsWith("CLAUDE_") ||
    normalized.startsWith("AWS_") ||
    normalized.startsWith("AMAZON_") ||
    normalized.startsWith("GOOGLE_") ||
    normalized.startsWith("VERTEX_") ||
    normalized.startsWith("AZURE_") ||
    normalized.startsWith("FOUNDRY_");
}

/**
 * Offline-testable adapter for Claude Code's noninteractive print surface.
 *
 * OAuth remains entirely CLI-owned. This adapter never reads, imports, refreshes, or serializes
 * credentials. It refuses provider-routing environment overrides so an OAuth subscription cannot
 * silently become an API-key, Bedrock, Vertex, or Foundry accounting lane.
 */
export class ClaudeRuntimeAdapter implements RuntimeAdapter {
  readonly id = "claude-cli";
  private readonly command: string;
  private readonly harnessVersion: string;
  private readonly verifiedWorkspaceBindingIds: ReadonlySet<string>;
  private readonly spawnProcess?: SpawnProcess;
  private readonly terminationGraceMs?: number;
  private readonly maxPromptBytes: number;

  constructor(options: ClaudeRuntimeAdapterOptions) {
    this.command = options.command;
    this.harnessVersion = options.harnessVersion;
    this.verifiedWorkspaceBindingIds = new Set(options.verifiedWorkspaceBindingIds ?? []);
    this.spawnProcess = options.spawnProcess;
    this.terminationGraceMs = options.terminationGraceMs;
    this.maxPromptBytes = options.maxPromptBytes ?? DEFAULT_CLAUDE_PROMPT_BYTES;
  }

  describe(): RuntimeDescriptor {
    return {
      id: this.id,
      displayName: "Claude Code CLI",
      defaultTimeoutMs: 30 * 60 * 1000,
      harness: {
        name: "claude-cli",
        version: this.harnessVersion,
        versionEvidence: "configured",
        transports: ["stdin-text", "text-final"],
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
    if (!this.command || !isAbsolute(this.command)) errors.push("Claude command must be an absolute path");
    if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(this.harnessVersion)) {
      errors.push("Claude harnessVersion must be a bounded version label");
    }
    if (!Number.isSafeInteger(this.maxPromptBytes) || this.maxPromptBytes <= 0) {
      errors.push("Claude maxPromptBytes must be a positive safe integer");
    }
    if (spec.input !== undefined) errors.push("Claude adapter owns stdin input delivery");
    if (!spec.prompt) errors.push("Claude prompt is required");
    if (Buffer.byteLength(spec.prompt, "utf8") > this.maxPromptBytes) {
      errors.push(`Claude prompt exceeds configured limit of ${this.maxPromptBytes} bytes`);
    }
    if (spec.requestedAgent !== undefined) {
      errors.push("Claude adapter does not support OpenCode agent-file selection");
    }
    // MeshFleet's public model selector is currently OpenCode-specific `provider/model` data.
    // Claude Code accepts aliases or Claude model names, so passing that value through would run
    // a different selection contract than the caller requested. Omission uses the authenticated
    // CLI account's default; typed cross-runtime model translation is separate work.
    if (spec.requestedModel !== undefined) {
      errors.push("Claude adapter does not accept the OpenCode-specific requestedModel selector");
    }
    if (spec.environmentPolicy === undefined || spec.environmentPolicy.mode === "inherit") {
      errors.push("Claude requires an explicit scrubbed or allowlist environment policy");
    }
    for (const name of [
      ...Object.keys(spec.environment ?? {}),
      ...(spec.environmentPolicy?.allowlist ?? []),
    ]) {
      if (isProviderOverrideEnvironment(name)) {
        errors.push(`Claude provider override environment is not allowed: ${name}`);
      }
    }
    if (!spec.permissions) {
      errors.push("Claude requires an explicit permission request");
    } else if (spec.permissions.mode === "interactive") {
      errors.push("Claude print adapter does not support interactive permission");
    } else if (spec.permissions.mode === "plan" &&
        (spec.permissions.edit !== "forbidden" || !this.hasAdmittedWorkspace(spec))) {
      errors.push("Claude plan mode requires forbidden workspace edits in verified isolation");
    } else if (spec.permissions.mode === "unattended" &&
        (spec.permissions.edit !== "workspace" || !this.hasAdmittedWorkspace(spec))) {
      errors.push("Claude unattended mode requires workspace-only edits in verified isolation");
    }
    if (!spec.session || spec.session.mode !== "new") {
      errors.push("Claude print adapter currently supports new sessions only");
    }
    return { ok: errors.length === 0, errors };
  }

  private hasAdmittedWorkspace(spec: ExecutionSpec): boolean {
    return hasVerifiedIsolatedWorkspace(spec) &&
      this.verifiedWorkspaceBindingIds.has(spec.workspace!.bindingId!);
  }

  async start(spec: ExecutionSpec): Promise<RuntimeHandle> {
    const validation = this.validate(spec);
    if (!validation.ok) throw new Error(`Invalid Claude execution spec: ${validation.errors.join(", ")}`);

    // Auto mode stays noninteractive while preserving Claude Code's background safety checks.
    // The stronger bypassPermissions mode would contradict this adapter's workspace-only claim:
    // an admitted worktree is evidence of isolation, not an OS sandbox around arbitrary paths.
    const permissionMode = spec.permissions!.mode === "plan" ? "plan" : "auto";
    const args = [
      "-p",
      "--input-format", "text",
      "--output-format", "text",
      "--no-session-persistence",
      "--safe-mode",
      "--no-chrome",
      "--permission-mode", permissionMode,
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
          if (raw.signal) return result(raw, "failure", `Claude process terminated by signal ${raw.signal}`);
          if (raw.exitCode !== 0) {
            return result(raw, "failure", `Claude process failed with exit code ${raw.exitCode}`);
          }
          if (raw.stdout.trim().length === 0) {
            return result(raw, "failure", "Claude returned an empty final response");
          }
          return result(raw, "success", undefined, raw.stdout);
        },
        normalizeSpawnError: (raw) => result(raw, "failure", "Claude process failed to start"),
        normalizeTimeout: (raw) => result(raw, "timeout", `Claude timed out after ${spec.timeoutMs}ms`),
        normalizeCancellation: (raw, reason) => result(raw, "cancelled", `Claude cancelled: ${reason}`),
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
