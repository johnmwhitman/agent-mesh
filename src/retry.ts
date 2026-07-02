/**
 * Retry — automatic agent re-spawn with exponential backoff.
 *
 * v0.7.x hardening: when an agent process fails transiently (non-zero exit,
 * watchdog timeout, error), we respawn it after a backoff delay. After
 * MAX_ATTEMPTS exhausted, the agent is marked permanently failed.
 *
 * Design notes:
 * - Backoff is configurable via AGENT_MESH_RETRY_BASE_MS env var.
 * - scheduleRetry() returns a handle so tests (and the spawn path) can cancel.
 * - jitter is ±20% by default; tests disable it for determinism.
 * - We deliberately do NOT retry clean exits (code 0). Those are successes.
 */

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_MS = 1000;

export interface RetryConfig {
  maxAttempts: number;
  baseMs: number;
  jitter: boolean;
}

let config: RetryConfig = {
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  baseMs: DEFAULT_BASE_MS,
  jitter: true,
};

function readEnv(): void {
  const envBase = Number(process.env.AGENT_MESH_RETRY_BASE_MS);
  if (Number.isFinite(envBase) && envBase > 0) {
    config.baseMs = envBase;
  }
}

// Read env on module load.
readEnv();

export function setRetryConfig(partial: Partial<RetryConfig>): void {
  if (partial.maxAttempts !== undefined) config.maxAttempts = partial.maxAttempts;
  if (partial.baseMs !== undefined) config.baseMs = partial.baseMs;
  if (partial.jitter !== undefined) config.jitter = partial.jitter;
}

export function getRetryConfig(): RetryConfig {
  return { ...config };
}

export function resetRetryConfig(): void {
  config = {
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    baseMs: DEFAULT_BASE_MS,
    jitter: true,
  };
  readEnv();
}

/**
 * Exponential backoff: baseMs * 2^(attempt-1).
 * attempt is 1-indexed (1 = first retry = base delay).
 */
export function computeBackoff(
  attempt: number,
  baseMs: number = config.baseMs,
  jitter: boolean = config.jitter
): number {
  if (attempt < 1) return 0;
  const exponential = baseMs * Math.pow(2, attempt - 1);
  if (!jitter) return Math.floor(exponential);
  const factor = 1 + (Math.random() * 0.4 - 0.2); // ±20%
  return Math.floor(exponential * factor);
}

/**
 * Whether a retry should be attempted given the current attempt count.
 * attempt is 1-indexed (the attempt that JUST failed).
 */
export function shouldRetry(attempt: number): boolean {
  return attempt < config.maxAttempts;
}

export interface RetryHandle {
  /** The underlying timer (exposed for tests). */
  r: ReturnType<typeof setTimeout> | undefined;
  /** Cancel the scheduled retry. No-op if already fired. */
  cancel: () => void;
}

/**
 * Schedule a retry callback after `computeBackoff(attempt, baseMs, jitter)` ms.
 * Returns a handle that can cancel the timer.
 */
export function scheduleRetry(
  attempt: number,
  fn: () => void,
  baseMs: number = config.baseMs,
  jitter: boolean = config.jitter
): RetryHandle {
  const handle: RetryHandle = {
    r: undefined,
    cancel: () => {
      if (handle.r !== undefined) {
        clearTimeout(handle.r);
        handle.r = undefined;
      }
    },
  };
  const delay = computeBackoff(attempt, baseMs, jitter);
  handle.r = setTimeout(() => {
    handle.r = undefined;
    fn();
  }, delay);
  // Unref so the timer doesn't prevent process exit if the parent process
  // is shutting down. (The spawn path's `child.on('close')` already runs the
  // process exit path, but unref is the safe default.)
  if (typeof (handle.r as NodeJS.Timeout).unref === "function") {
    (handle.r as NodeJS.Timeout).unref();
  }
  return handle;
}