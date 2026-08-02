import { performance } from "node:perf_hooks";

export const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

type WaitUntilOptions = {
  deadlineMs?: number;
  now?: () => number;
  observed?: () => string;
  pause?: (delayMs: number) => Promise<void>;
  pollIntervalMs?: number;
};

const monotonicNow = (): number => performance.now();
const pause = (delayMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

export const waitDeadline = (
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  now: () => number = monotonicNow,
): number => now() + timeoutMs;

export const waitUntil = async (
  predicate: () => boolean,
  what: string,
  options: WaitUntilOptions = {},
): Promise<void> => {
  const now = options.now ?? monotonicNow;
  const wait = options.pause ?? pause;
  const pollIntervalMs = options.pollIntervalMs ?? 5;
  const startedMs = now();
  const deadlineMs = options.deadlineMs ?? startedMs + DEFAULT_WAIT_TIMEOUT_MS;
  let polls = 0;

  while (!predicate()) {
    const currentMs = now();
    if (currentMs >= deadlineMs) {
      const observed = options.observed ? ` | observed: ${options.observed()}` : "";
      throw new Error(
        `timed out waiting for ${what} (elapsed ${Math.max(0, currentMs - startedMs)}ms, ${polls} polls)${observed}`,
      );
    }

    polls += 1;
    await wait(Math.min(pollIntervalMs, deadlineMs - currentMs));
  }
};
