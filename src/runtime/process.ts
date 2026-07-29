import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { CancelResult, ExecutionSpec, RuntimeEnvironmentPolicy, RuntimeHandle, RuntimeResult } from "./types.js";

export interface RawProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Fixed child stdio policy: no inherited stdin or parent MCP stdout writes. */
export const RUNTIME_CHILD_STDIO: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];
export const RUNTIME_CHILD_STDIN_STDIO: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
export const DEFAULT_TERMINATION_GRACE_MS = 100;
export const DEFAULT_RUNTIME_OUTPUT_LIMIT_BYTES = 1024 * 1024;

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
  normalizeOutputOverflow(raw: RawProcessResult, stream: "stdout" | "stderr", limit: number): RuntimeResult;
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
  if (!child) return false;
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      // Every POSIX child is a detached process-group leader. Signalling its
      // negative pid contains grandchildren that inherited its stdout/stderr.
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // The leader may already be gone while close still waits on pipe-owning
      // descendants. A direct kill is a best-effort fallback for that race.
    }
  }
  if (isRunning(child)) {
    try { return child.kill(signal); } catch { /* exited between checks */ }
  }
  return false;
}

/** Build a deliberately small child environment without leaking ambient values by default. */
export function resolveChildEnvironment(
  host: NodeJS.ProcessEnv,
  explicit: Record<string, string> | undefined,
  policy: RuntimeEnvironmentPolicy | undefined,
  baseline: NodeJS.ProcessEnv = {},
  defaultMode: RuntimeEnvironmentPolicy["mode"] = "scrubbed",
): NodeJS.ProcessEnv {
  const mode = policy?.mode ?? defaultMode;
  const inherited: NodeJS.ProcessEnv = {};
  if (mode === "inherit") Object.assign(inherited, host);
  else if (mode === "allowlist") {
    for (const name of policy?.allowlist ?? []) {
      const value = host[name];
      if (value !== undefined) inherited[name] = value;
    }
  }
  // Baseline is adapter-owned (for example AGENT_MESH_CHILD), so explicit
  // caller data cannot accidentally remove it.
  return { ...inherited, ...explicit, ...baseline };
}

function appendBounded(
  chunks: Buffer[],
  received: number,
  data: Buffer | string,
  limit: number,
): { received: number; overflowed: boolean } {
  const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const room = Math.max(0, limit - received);
  if (room > 0) chunks.push(chunk.subarray(0, room));
  return { received: received + Math.min(chunk.length, room), overflowed: chunk.length > room };
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
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let terminationGrace: ReturnType<typeof setTimeout> | undefined;
  let terminalRequest:
    | { status: "timeout" }
    | { status: "cancelled"; reason: string }
    | { status: "output-overflow"; stream: "stdout" | "stderr"; limit: number }
    | undefined;
  let processError: Error | undefined;
  let sigtermSent = false;
  let sigkillSent = false;
  let pendingTerminalClose:
    | { exitCode: number | null; signal: NodeJS.Signals | null }
    | undefined;
  let finish!: (result: RuntimeResult) => void;
  const stdoutLimit = spec.output?.maxStdoutBytes ?? DEFAULT_RUNTIME_OUTPUT_LIMIT_BYTES;
  const stderrLimit = spec.output?.maxStderrBytes ?? DEFAULT_RUNTIME_OUTPUT_LIMIT_BYTES;
  const cleanupChildListeners = () => {
    if (!child) return;
    child.stdout?.removeListener("data", onStdout);
    child.stderr?.removeListener("data", onStderr);
    child.stdin?.removeListener("error", onStdinError);
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
    stdout: Buffer.concat(stdoutChunks).toString(),
    stderr: Buffer.concat(stderrChunks).toString(),
  });
  const settleAfterClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    const closed = { exitCode, signal, stdout: Buffer.concat(stdoutChunks).toString(), stderr: Buffer.concat(stderrChunks).toString() };
    if (terminalRequest?.status === "timeout") {
      finish(launch.normalizeTimeout(closed));
    } else if (terminalRequest?.status === "cancelled") {
      finish(launch.normalizeCancellation(closed, terminalRequest.reason));
    } else if (terminalRequest?.status === "output-overflow") {
      finish(launch.normalizeOutputOverflow(closed, terminalRequest.stream, terminalRequest.limit));
    } else if (processError) {
      finish(launch.normalizeSpawnError(closed, processError));
    } else {
      finish(launch.normalizeClose(closed));
    }
  };
  const requestProcessTermination = () => {
    if (settled || !child) return;
    if (!sigtermSent) {
      sigtermSent = true;
      terminate(child, "SIGTERM");
    }
    if (settled || terminationGrace !== undefined) return;
    terminationGrace = setTimeout(() => {
      terminationGrace = undefined;
      if (settled || sigkillSent) return;
      sigkillSent = true;
      terminate(child, "SIGKILL");
      if (pendingTerminalClose) {
        const closed = pendingTerminalClose;
        pendingTerminalClose = undefined;
        settleAfterClose(closed.exitCode, closed.signal);
      }
    }, launch.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS);
    // This is the correctness-critical half of TERM→KILL containment. It
    // must keep the worker alive while SIGTERM-resistant descendants still
    // own inherited pipes; unref would allow node to exit before escalation.
  };
  function onStdout(data: Buffer | string): void {
    const appended = appendBounded(stdoutChunks, stdoutBytes, data, stdoutLimit);
    stdoutBytes = appended.received;
    if (appended.overflowed && !terminalRequest) {
      terminalRequest = { status: "output-overflow", stream: "stdout", limit: stdoutLimit };
      requestProcessTermination();
    }
  }
  function onStderr(data: Buffer | string): void {
    const appended = appendBounded(stderrChunks, stderrBytes, data, stderrLimit);
    stderrBytes = appended.received;
    if (appended.overflowed && !terminalRequest) {
      terminalRequest = { status: "output-overflow", stream: "stderr", limit: stderrLimit };
      requestProcessTermination();
    }
  }
  function onStdinError(): void {
    // A child can close stdin before its optional input is written. Its close
    // result is authoritative; swallowing this stream-local error prevents an
    // unhandled event without changing process outcome.
  }
  function onError(error: Error): void {
    if (settled) return;
    processError = error;
    requestProcessTermination();
  }
  function onClose(exitCode: number | null, signal: NodeJS.Signals | null): void {
    // A POSIX process-group leader can close before a SIGTERM-resistant
    // descendant when that descendant does not inherit the leader's pipes.
    // Do not let leader close cancel the correctness-critical group SIGKILL.
    if (
      process.platform !== "win32" &&
      terminalRequest !== undefined &&
      sigtermSent &&
      !sigkillSent &&
      terminationGrace !== undefined
    ) {
      pendingTerminalClose = { exitCode, signal };
      return;
    }
    settleAfterClose(exitCode, signal);
  }

  try {
    child = spawnProcess(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.environment,
      shell: false,
      stdio: spec.input ? RUNTIME_CHILD_STDIN_STDIO : RUNTIME_CHILD_STDIO,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    queueMicrotask(() => finish(launch.normalizeSpawnError(raw(), failure)));
  }

  if (child) {
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.stdin?.on("error", onStdinError);
    child.on("error", onError);
    child.on("close", onClose);
    if (spec.input) child.stdin?.end(spec.input.bytes);
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
