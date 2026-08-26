import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
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
  updateTimeout(timeoutMs: number): void;
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

export interface RecordedProcessContainmentOptions {
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  graceMs?: number;
  platform?: NodeJS.Platform;
  /**
   * Optional descendant enumerator, used by `walkAndKillDescendants` to find
   * processes whose PGID is the supplied pid (or whose PPID is the pid) so
   * that a child that called `setsid(2)` and broke away from the parent's
   * process group is still terminated. Defaults to a POSIX `ps -o pid= -o
   * ppid= -o pgid=` walker for live tests; injected in production so the
   * caller can pre-cache the snapshot. `platform: "win32"` skips the walk.
   */
  listDescendants?: (pid: number, platform: NodeJS.Platform) => number[];
}

/**
 * Best-effort containment when a server restart preserved only a detached
 * runtime pid in SQLite. POSIX children are process-group leaders, so the
 * negative pid contains descendants just like the live-handle path.
 *
 * Gate #3 of `t_db8af59c` (2026-08-26): the negative-pid group kill is not
 * enough. A child that called `setsid(2)` (typical of a long-lived tool
 * wrapper that wants to outlive its parent) escapes the parent's process
 * group, and `process.kill(-pgid)` does not reach it. `walkAndKillDescendants`
 * is the second pass — it enumerates direct children of the leader by PPID,
 * sends each the same TERM/KILL sequence, and recurses. On Windows the
 * platform has no process-group signal semantics at all, so the same walker
 * has to be the primary path. Without this second pass, a real OpenCode
 * child that spawned `nohup … &` to detach from its CLI wrapper would
 * survive any timeout reap and continue holding its SQLite lease.
 */
export function containRecordedProcess(
  pid: number,
  options: RecordedProcessContainmentOptions = {},
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const kill = options.kill ?? process.kill.bind(process);
  const schedule = options.schedule ?? setTimeout;
  const platform = options.platform ?? process.platform;
  const target = platform === "win32" ? pid : -pid;
  try {
    kill(target, "SIGTERM");
  } catch {
    return false;
  }
  // Gate #3 second pass: walk the descendant tree and terminate anything
  // that detached from the leader's process group. Best-effort: a child that
  // is still spawning during the walk is not caught, but the grace-window
  // escalation below still runs after the walk so the leader's own group is
  // SIGKILLed on the deadline.
  walkAndKillDescendants(pid, { ...options, platform }, kill);
  schedule(() => {
    try { kill(target, "SIGKILL"); } catch { /* already exited */ }
    // Escalate the descendants too — a child that ignored SIGTERM gets the
    // same grace window. Same shape as the leader's escalation above; the
    // walk itself is cheap so re-walking on the grace timer is acceptable.
    walkAndKillDescendants(pid, { ...options, platform }, kill, "SIGKILL");
  }, options.graceMs ?? DEFAULT_TERMINATION_GRACE_MS);
  return true;
}

/**
 * Walk every direct child of `pid` and terminate it with `signal`, then
 * recurse into each child. Intended as the second pass after a
 * process-group kill so a child that broke away via `setsid(2)` still gets
 * the same TERM/KILL escalation as the leader. Exported so tests can verify
 * the walker without spawning a real process tree.
 *
 * The walker enumerates only DIRECT children of `pid` and recurses — a full
 * ps-tree enumeration would scale O(processes on host), which is
 * unacceptable when the only caller is the per-fleet reap path that fires
 * once per worker. The recursion is bounded by the size of the worker's own
 * tree, which the leader itself forked and can re-walk cheaply.
 */
export function walkAndKillDescendants(
  pid: number,
  options: RecordedProcessContainmentOptions & { platform: NodeJS.Platform },
  kill: (pid: number, signal: NodeJS.Signals) => void = (options.kill ?? process.kill.bind(process)),
  signal: NodeJS.Signals = "SIGTERM",
): number {
  if (!Number.isInteger(pid) || pid <= 0) return 0;
  if (options.platform === "win32") return 0;
  const list = options.listDescendants ?? defaultListDescendants;
  let killed = 0;
  for (const child of list(pid, options.platform)) {
    try {
      kill(child, signal);
      killed += 1;
    } catch {
      // A child may already be gone; the walker is best-effort.
    }
    killed += walkAndKillDescendants(child, options, kill, signal);
  }
  return killed;
}

/**
 * POSIX-only descendant enumerator: shells out to `ps -o pid=,ppid= -A` and
 * filters to children whose PPID matches `pid`. Returned as a number array
 * of PIDs.
 *
 * `ps` is the portable POSIX primitive; `pgrep -P` is BSD/macOS-only and
 * `ps -e -o pid,ppid` is what every Linux distribution ships. The `-A`
 * selector is BSD's "every process"; `-e` is SysV's. We pass `-A` because
 * it works on both and on macOS, where the team typically runs.
 *
 * Not invoked on Windows — `walkAndKillDescendants` short-circuits the
 * walker when `platform === "win32"`, and `defaultListDescendants` here
 * throws if a caller ever tries. The throw is a guard against silent
 * fallthrough, not an expected runtime path.
 */
function defaultListDescendants(pid: number, platform: NodeJS.Platform): number[] {
  if (platform === "win32") {
    throw new Error("defaultListDescendants is POSIX-only; walkAndKillDescendants short-circuits Windows");
  }
  let raw: string;
  try {
    raw = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // `ps` is missing or timed out. Returning an empty list is the same
    // outcome as "no descendants found" — the leader's negative-pid kill
    // still runs, and a follow-up `containRecordedProcess` on the same pid
    // will try again. The fallback intentionally does NOT throw, because
    // the reap path is the wrong place to introduce a NEW failure mode.
    return [];
  }
  const out: number[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [childStr, ppidStr] = trimmed.split(/\s+/);
    const child = Number(childStr);
    const ppid = Number(ppidStr);
    if (!Number.isInteger(child) || !Number.isInteger(ppid)) continue;
    if (ppid === pid) out.push(child);
  }
  return out;
}

/**
 * The variable a spawned agent's nested MeshFleet reads to know it is a CHILD and must not run
 * parent-only startup work. Exported so the writer (every runtime adapter, via
 * `resolveChildEnvironment`) and the reader (server startup) name it once and cannot drift apart.
 */
export const CHILD_MARKER_ENV = "AGENT_MESH_CHILD";

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
  // Baseline is adapter-owned, so explicit caller data cannot accidentally
  // remove it.
  //
  // The CHILD MARKER goes last and is not adapter-owned, because leaving it to
  // each adapter is a defect this codebase has already shipped: only the
  // OpenCode adapter set it, so a fleet configured onto the Claude, Kimi,
  // local-process, or local-demo adapter spawned a child whose nested MeshFleet
  // booted as a FULL PARENT on the operator's ledger — running startup
  // recovery, the abandoned-fleet reconciler, crash-journal retirement, and a
  // second competing ratification sweeper. That is not hypothetical: a second
  // instance on one ledger marked 31 of 52 of the parent's healthy running
  // agents `interrupted` on the 2026-07-02 ledger, which is why the liveness
  // probe in `recoverInterruptedAgents` exists at all — and the probe does not
  // cover an agent inside its retry backoff (still `running`, dead pid) or one
  // whose adapter reported no pid.
  //
  // Every adapter that spawns an agent child already funnels through this
  // function, so stamping it here makes the marker structurally unforgettable
  // rather than a line each new adapter must remember. It is written LAST so
  // neither caller data nor an adapter baseline can suppress it.
  return { ...inherited, ...explicit, ...baseline, [CHILD_MARKER_ENV]: "1" };
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
  const startedAt = Date.now();
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

  const armTimeout = (timeoutMs: number): void => {
    if (timeout !== undefined) clearTimeout(timeout);
    if (settled || terminalRequest) return;
    const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt));
    timeout = setTimeout(() => {
      if (settled || terminalRequest) return;
      terminalRequest = { status: "timeout" };
      requestProcessTermination();
    }, remaining);
    timeout.unref?.();
  };

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
    armTimeout(launch.timeoutMs);
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
    startedAt,
    isAlive: () => !settled && child !== undefined && child.exitCode === null && child.signalCode === null,
    updateTimeout: armTimeout,
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
