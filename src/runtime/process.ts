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
export const DEFAULT_TERMINATION_GRACE_MS = 100;

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
  terminationGraceMs?: number;
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

function isRunning(child: ChildProcess | undefined): child is ChildProcess {
  return child !== undefined && child.exitCode === null && child.signalCode === null;
}

function terminate(child: ChildProcess | undefined, signal: NodeJS.Signals): boolean {
  if (isRunning(child)) {
    try {
      return child.kill(signal);
    } catch {
      // The process may have exited between the liveness check and kill().
    }
  }
  return false;
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
  let terminationGrace: ReturnType<typeof setTimeout> | undefined;
  let terminalRequest: { status: "timeout" | "cancelled"; reason?: string } | undefined;
  let processError: Error | undefined;
  let sigtermSent = false;
  let sigkillSent = false;
  let finish!: (result: RuntimeResult) => void;
  const cleanupChildListeners = () => {
    if (!child) return;
    child.stdout?.removeListener("data", onStdout);
    child.stderr?.removeListener("data", onStderr);
    child.removeListener("error", onError);
    child.removeListener("close", onClose);
  };
  const completion = new Promise<RuntimeResult>((resolve) => {
    finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (terminationGrace !== undefined) clearTimeout(terminationGrace);
      cleanupChildListeners();
      resolve(result);
    };
  });
  const raw = (): RawProcessResult => ({
    exitCode: child?.exitCode ?? null,
    signal: child?.signalCode ?? null,
    stdout,
    stderr,
  });
  const settleAfterClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    const closed = { exitCode, signal, stdout, stderr };
    if (terminalRequest?.status === "timeout") {
      finish(launch.normalizeTimeout(closed));
    } else if (terminalRequest?.status === "cancelled") {
      finish(launch.normalizeCancellation(closed, terminalRequest.reason ?? "Cancelled"));
    } else if (processError) {
      finish(launch.normalizeSpawnError(closed, processError));
    } else {
      finish(launch.normalizeClose(closed));
    }
  };
  const requestProcessTermination = () => {
    if (settled || !isRunning(child)) return;
    if (!sigtermSent) {
      sigtermSent = true;
      terminate(child, "SIGTERM");
    }
    if (settled || !isRunning(child) || terminationGrace !== undefined) return;
    terminationGrace = setTimeout(() => {
      terminationGrace = undefined;
      if (settled || !isRunning(child) || sigkillSent) return;
      sigkillSent = true;
      terminate(child, "SIGKILL");
    }, launch.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS);
    terminationGrace.unref?.();
  };
  function onStdout(data: Buffer | string): void {
    stdout += data.toString();
  }
  function onStderr(data: Buffer | string): void {
    stderr += data.toString();
  }
  function onError(error: Error): void {
    if (settled) return;
    processError = error;
    requestProcessTermination();
  }
  function onClose(exitCode: number | null, signal: NodeJS.Signals | null): void {
    settleAfterClose(exitCode, signal);
  }

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
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
    child.on("close", onClose);
    timeout = setTimeout(() => {
      if (settled || terminalRequest) return;
      terminalRequest = { status: "timeout" };
      requestProcessTermination();
    }, launch.timeoutMs);
    timeout.unref?.();
  } else {
    queueMicrotask(() => {
      if (terminalRequest?.status === "cancelled") {
        finish(launch.normalizeCancellation(raw(), terminalRequest.reason ?? "Cancelled"));
      } else {
        finish(launch.normalizeSpawnError(raw(), processError ?? new Error("Process failed to spawn")));
      }
    });
  }

  const handle: ProcessRuntimeHandle = {
    id: randomUUID(),
    pid: child?.pid,
    startedAt: Date.now(),
    isAlive: () => !settled && child !== undefined && child.exitCode === null && child.signalCode === null,
    completion,
    cancel: (reason: string): CancelResult => {
      if (settled) return { accepted: false, reason: "already settled" };
      if (terminalRequest) return { accepted: false, reason: "termination already requested" };
      terminalRequest = { status: "cancelled", reason };
      if (!child) {
        finish(launch.normalizeCancellation(raw(), reason));
      } else {
        requestProcessTermination();
      }
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
