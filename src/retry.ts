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
 * - We do not retry classified successes. Exit code 0 alone is not sufficient;
 *   the spawn-result classifier also validates output and runtime diagnostics.
 */

import { resolveEnv } from "./env.js";

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
  const envBase = Number(resolveEnv(process.env, "MESHFLEET_RETRY_BASE_MS", "AGENT_MESH_RETRY_BASE_MS"));
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

/** Largest delay Node will pass to the timer unchanged. A larger value becomes 1 ms. */
export const MAX_SETTABLE_DELAY_MS = 2_147_483_647;

export function delayIsSettable(delayMs: number): boolean {
  return Number.isInteger(delayMs) && delayMs >= 0 && delayMs <= MAX_SETTABLE_DELAY_MS;
}

/**
 * One conversion onto the delay Node will actually wait.
 * A finite value below 1 ms is waited as 1 ms. A value above the 32-bit maximum
 * is not schedulable; Node would also collapse that one to 1 ms, and it stays a refusal.
 */
export function effectiveScheduledDelay(delayMs: number): number | undefined {
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_SETTABLE_DELAY_MS) return undefined;
  if (delayMs < 1) return 1;
  return Math.floor(delayMs);
}

export interface RetryHandle {
  /** The underlying timer (exposed for tests). */
  r: ReturnType<typeof setTimeout> | undefined;
  /** Computed delay. When accepted, this is the value passed to setTimeout. */
  delayMs: number;
  /** False when the delay cannot be armed. No timer exists in that case. */
  accepted: boolean;
  /** Cancel the scheduled retry. No-op if already fired or never armed. */
  cancel: () => void;
}

export type SettledRetry =
  | { action: "schedule"; nextAttempt: number; delayMs: number }
  | { action: "refuse"; attempts: number; delayMs: number };

/**
 * One backoff sample for the attempt that just failed.
 * The attempt number passed to the backoff formula stays `failedAttempt + 1`.
 * The returned delay is the single normalized value for both the timer and the receipt.
 * A delay above the 32-bit maximum is a refusal, and `attempts` stays the failed attempt.
 */
export function settleRetryDelay(
  failedAttempt: number,
  baseMs: number = config.baseMs,
  jitter: boolean = config.jitter
): SettledRetry {
  const nextAttempt = failedAttempt + 1;
  const raw = computeBackoff(nextAttempt, baseMs, jitter);
  const delayMs = effectiveScheduledDelay(raw);
  if (delayMs === undefined) {
    return { action: "refuse", attempts: failedAttempt, delayMs: raw };
  }
  return { action: "schedule", nextAttempt, delayMs };
}

/** Arm a delay that was already computed. Does not draw jitter again. */
export function armComputedDelay(delayMs: number, fn: () => void): RetryHandle {
  const handle: RetryHandle = {
    r: undefined,
    delayMs,
    accepted: false,
    cancel: () => {
      if (handle.r !== undefined) {
        clearTimeout(handle.r);
        handle.r = undefined;
      }
    },
  };
  if (!delayIsSettable(delayMs)) return handle;
  handle.accepted = true;
  handle.r = setTimeout(() => {
    handle.r = undefined;
    fn();
  }, delayMs);
  if (typeof (handle.r as NodeJS.Timeout).unref === "function") {
    (handle.r as NodeJS.Timeout).unref();
  }
  return handle;
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
  const raw = computeBackoff(attempt, baseMs, jitter);
  const delayMs = effectiveScheduledDelay(raw);
  if (delayMs === undefined) {
    return {
      r: undefined,
      delayMs: raw,
      accepted: false,
      cancel: () => {},
    };
  }
  return armComputedDelay(delayMs, fn);
}
