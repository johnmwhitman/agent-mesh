import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cancelProcessExecution,
  startProcessExecution,
  resolveChildEnvironment,
  waitForProcessExecution,
  type RawProcessResult,
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

const compiledWorker = fileURLToPath(new URL("./demo-worker.js", import.meta.url));
const sourceWorker = fileURLToPath(new URL("./demo-worker.ts", import.meta.url));

/**
 * The published package always has the compiled worker. Uncompiled runs (tsx
 * tests, source checkouts) fall back to the .ts source — which is deliberately
 * type-annotation-free, i.e. already valid ESM. Node 20 still refuses it on
 * file EXTENSION alone (CI: all three Node 20 legs, no others), so the
 * fallback stages a content-hashed .mjs copy in tmpdir and spawns that. The
 * hash busts the cache when the source changes; bytes are identical, so the
 * worker's determinism contract is unaffected. Published installs never take
 * this branch.
 */
function resolveWorkerPath(): string {
  if (existsSync(compiledWorker)) return compiledWorker;
  const source = readFileSync(sourceWorker);
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const stagedDir = join(tmpdir(), "meshfleet-demo-worker");
  const staged = join(stagedDir, `demo-worker-${digest}.mjs`);
  if (!existsSync(staged)) {
    mkdirSync(stagedDir, { recursive: true });
    copyFileSync(sourceWorker, staged);
  }
  return staged;
}

const WORKER_PATH = resolveWorkerPath();

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
    // Honest identity: this adapter runs the shipped deterministic worker and
    // proves nothing about any model, because there is none.
    identity: { adapterId: "local-demo", evidence: "none" },
  };
}

/**
 * Zero-dependency runtime so a stranger's first `spawn_fleet` works before any
 * external CLI is installed. Command is the CURRENT Node executable and the
 * argv is the shipped worker — no operator paths, no credentials, no network.
 * It refuses model/agent requests instead of pretending to honor them.
 */
export class LocalDemoRuntimeAdapter implements RuntimeAdapter {
  readonly id = "local-demo";

  describe(): RuntimeDescriptor {
    return {
      id: this.id,
      displayName: "Local demo worker (no model)",
      defaultTimeoutMs: 60_000,
      // Never a failover target: a deterministic echo is not a substitute for
      // a failed model-backed agent. Explicit selection only.
      failoverEligible: false,
    };
  }

  validate(spec: ExecutionSpec): ValidationResult {
    const errors = [...validateExecutionSpec(spec).errors];
    if (typeof spec.prompt !== "string" || spec.prompt.trim().length === 0) {
      errors.push("local-demo refuses a blank prompt — it will not invent output");
    }
    if (spec.requestedModel !== undefined) {
      errors.push("local-demo has no AI model; do not request one — attach a real runtime instead");
    }
    if (spec.requestedAgent !== undefined) {
      errors.push("local-demo does not load agent files");
    }
    if (spec.input !== undefined) {
      errors.push("local-demo is argv-only and does not support stdin input");
    }
    return { ok: errors.length === 0, errors };
  }

  async start(spec: ExecutionSpec): Promise<RuntimeHandle> {
    const validation = this.validate(spec);
    if (!validation.ok) throw new Error(`Invalid execution spec: ${validation.errors.join(", ")}`);
    return startProcessExecution(spec, {
      command: process.execPath,
      args: [WORKER_PATH, spec.prompt],
      cwd: spec.cwd,
      environment: resolveChildEnvironment(process.env, spec.environment, spec.environmentPolicy),
      timeoutMs: spec.timeoutMs,
      normalizeClose: (raw) => {
        if (raw.signal) return normalized(raw, "failure", `Process terminated by signal ${raw.signal}`);
        if (raw.exitCode !== 0) return normalized(raw, "failure", `Worker failed with exit code ${raw.exitCode}`);
        return normalized(raw, "success");
      },
      normalizeSpawnError: (raw, error) => normalized(raw, "failure", error.message),
      normalizeTimeout: (raw) => normalized(raw, "timeout", `Timed out after ${spec.timeoutMs}ms`),
      normalizeCancellation: (raw, reason) => normalized(raw, "cancelled", `Cancelled: ${reason}`),
      normalizeOutputOverflow: (raw, stream, limit) =>
        normalized(raw, "failure", `${stream} exceeded configured limit of ${limit} bytes`),
    });
  }

  wait(handle: RuntimeHandle, signal?: AbortSignal): Promise<RuntimeResult> {
    return waitForProcessExecution(handle, signal);
  }

  cancel(handle: RuntimeHandle, reason: string): Promise<CancelResult> {
    return cancelProcessExecution(handle, reason);
  }
}
