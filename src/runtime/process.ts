import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { CancelResult, ExecutionSpec, RuntimeHandle, RuntimeResult } from "./types.js";

export interface RawProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Fixed child stdio policy: no inherited stdin or parent MCP stdout writes. */
export const RUNTIME_CHILD_STDIO: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface ProcessLaunch {
  command: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  normalizeClose(raw: RawProcessResult): RuntimeResult;
  normalizeSpawnError(raw: RawProcessResult, error: Error): RuntimeResult;
  normalizeTimeout(raw: RawProcessResult): RuntimeResult;
  normalizeCancellation(raw: RawProcessResult, reason: string): RuntimeResult;
}

interface ProcessRuntimeHandle extends RuntimeHandle {
  completion: Promise<RuntimeResult>;
  cancel(reason: string): CancelResult;
}

function asProcessHandle(handle: RuntimeHandle): ProcessRuntimeHandle {
  const candidate = handle as Partial<ProcessRuntimeHandle>;
  if (candidate.completion === undefined || candidate.cancel === undefined) {
    throw new Error(`Runtime handle ${handle.id} is not owned by this process adapter`);
  }
  return candidate as ProcessRuntimeHandle;
}

function terminate(child: ChildProcess | undefined): void {
  if (child && !child.killed && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may have exited between the liveness check and kill().
    }
  }
}

/**
 * Launch a child without a shell. Its stdout/stderr are captured and never
 * forwarded to the parent MCP stdout stream.
 */
export function startProcessExecution(
  spec: ExecutionSpec,
  launch: ProcessLaunch,
  spawnProcess: SpawnProcess = spawn,
): RuntimeHandle {
  let child: ChildProcess | undefined;
  let stdout = "";
  let stderr = "";
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let finish!: (result: RuntimeResult) => void;
  const completion = new Promise<RuntimeResult>((resolve) => {
    finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      resolve(result);
    };
  });
  const raw = (): RawProcessResult => ({
    exitCode: child?.exitCode ?? null,
    signal: child?.signalCode ?? null,
    stdout,
    stderr,
  });

  try {
    child = spawnProcess(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.environment,
      shell: false,
      stdio: RUNTIME_CHILD_STDIO,
      windowsHide: true,
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    queueMicrotask(() => finish(launch.normalizeSpawnError(raw(), failure)));
  }

  if (child) {
    child.stdout?.on("data", (data: Buffer | string) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data: Buffer | string) => {
      stderr += data.toString();
    });
    child.on("error", (error: Error) => {
      finish(launch.normalizeSpawnError(raw(), error));
    });
    child.on("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      finish(launch.normalizeClose({ exitCode, signal, stdout, stderr }));
    });
    timeout = setTimeout(() => {
      terminate(child);
      finish(launch.normalizeTimeout(raw()));
    }, launch.timeoutMs);
    timeout.unref?.();
  }

  const handle: ProcessRuntimeHandle = {
    id: randomUUID(),
    pid: child?.pid,
    startedAt: Date.now(),
    isAlive: () => !settled && child !== undefined && child.exitCode === null && child.signalCode === null,
    completion,
    cancel: (reason: string): CancelResult => {
      if (settled) return { accepted: false, reason: "already settled" };
      terminate(child);
      finish(launch.normalizeCancellation(raw(), reason));
      return { accepted: true, reason };
    },
  };
  return handle;
}

export async function waitForProcessExecution(
  handle: RuntimeHandle,
  signal?: AbortSignal,
): Promise<RuntimeResult> {
  const processHandle = asProcessHandle(handle);
  const onAbort = () => processHandle.cancel("Aborted by caller");
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await processHandle.completion;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function cancelProcessExecution(
  handle: RuntimeHandle,
  reason: string,
): Promise<CancelResult> {
  return asProcessHandle(handle).cancel(reason);
}
