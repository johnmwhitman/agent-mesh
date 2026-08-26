import { appendEvent, failRunningAgentForFleetRuntimeTimeout, expireStaleAgents } from "./core.js";

export interface ExpiredFleetAgent {
  agent_id: string;
  fleet_id: string;
  pid?: number;
  reason: string;
  /** A mode-specific owner already attempted handle/PID containment. */
  cancellation_attempted?: true;
}

export interface ActiveLegacyTimeoutIdentity {
  fleetId: string;
  handleId: string;
  attempt: number;
}

/** Own the timeout-vs-normal wait-result branch so timeout can never fall through to retry. */
export function routeLegacyRuntimeResult(
  status: string,
  handlers: { onTimeout: () => void; onNonTimeout: () => void },
): void {
  if (status === "timeout") {
    handlers.onTimeout();
    return;
  }
  handlers.onNonTimeout();
}

/**
 * Settle a timeout result only when it still belongs to the active legacy
 * attempt. Handle identity is checked before the ledger transition so a stale
 * callback cannot fail a replacement attempt that reused the same agent row.
 */
export function terminalizeLegacyRuntimeTimeout(options: {
  agentId: string;
  fleetId: string;
  handleId: string;
  attempt: number;
  active?: ActiveLegacyTimeoutIdentity;
  now?: number;
  appendTimeoutEvent?: typeof appendEvent;
  onEventError?: (error: unknown) => void;
}): boolean {
  const { active } = options;
  if (
    !active ||
    active.fleetId !== options.fleetId ||
    active.handleId !== options.handleId ||
    active.attempt !== options.attempt
  ) return false;
  const now = options.now ?? Date.now();
  const reason = "Fleet runtime timeout elapsed";
  const transitioned = failRunningAgentForFleetRuntimeTimeout(
    options.agentId,
    options.fleetId,
    reason,
    now,
  );
  if (transitioned) {
    try {
      (options.appendTimeoutEvent ?? appendEvent)("agent_fleet_timeout", {
        agent_id: options.agentId,
        fleet_id: options.fleetId,
        reason,
        timed_out_at: now,
      });
    } catch (error) {
      // Ledger truth already won. Event-log projection follows the same
      // non-fatal policy as scheduled timeout observation.
      options.onEventError?.(error);
    }
  }
  return transitioned;
}

export interface FleetTimeoutEnforcerOptions {
  now?: () => number;
  nextDeadline: (fleetId: string) => number | undefined;
  expire: (fleetId: string, now: number) => ExpiredFleetAgent[];
  /** Gate #2 (t_db8af59c, 2026-08-26): optional override for the staleness
   * reap function. Defaults to the production `expireStaleAgents`. Tests
   * inject a deterministic clock-bound version. */
  expireStaleAgentsFn?: (fleetId: string, now: number) => ExpiredFleetAgent[];
  cancelAgent: (agent: ExpiredFleetAgent) => void | Promise<unknown>;
  onExpired?: (agent: ExpiredFleetAgent, now: number) => void | Promise<unknown>;
  onError?: (error: unknown) => void;
  retryDelayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  clear?: (timer: unknown) => void;
}

/**
 /** Owns only deadline scheduling. Ledger mutation and runtime cancellation stay
  * injected so the same scheduler can drive legacy and durable lifecycle modes.
  *
  * Gate #2 of `t_db8af59c` (2026-08-26): every `refresh` also runs the
  * staleness watchdog (`expireStaleAgents`) before checking the wall-clock
  * budget. The two reapers are complementary — the budget reaper fires when
  * the wall clock crosses zero, the staleness reaper fires well before that if
  * the worker has been silent through the most recent quarter of its budget.
  * Putting both behind one `refresh` is what gives a single supervisor cycle
  * authority to detect and reap any stuck worker.
  */
 export class FleetTimeoutEnforcer {
  private readonly now: () => number;
  private readonly nextDeadline: FleetTimeoutEnforcerOptions["nextDeadline"];
  private readonly expire: FleetTimeoutEnforcerOptions["expire"];
  private readonly expireStaleAgentsFn: NonNullable<FleetTimeoutEnforcerOptions["expireStaleAgentsFn"]>;
  private readonly cancelAgent: FleetTimeoutEnforcerOptions["cancelAgent"];
  private readonly onExpired?: FleetTimeoutEnforcerOptions["onExpired"];
  private readonly onError: NonNullable<FleetTimeoutEnforcerOptions["onError"]>;
  private readonly retryDelayMs: number;
  private readonly schedule: NonNullable<FleetTimeoutEnforcerOptions["schedule"]>;
  private readonly clear: NonNullable<FleetTimeoutEnforcerOptions["clear"]>;
  private readonly timers = new Map<string, unknown>();

  constructor(options: FleetTimeoutEnforcerOptions) {
    this.now = options.now ?? Date.now;
    this.nextDeadline = options.nextDeadline;
    this.expire = options.expire;
    this.expireStaleAgentsFn = options.expireStaleAgentsFn ?? ((fleetId, at) => expireStaleAgents(fleetId, at));
    this.cancelAgent = options.cancelAgent;
    this.onExpired = options.onExpired;
    this.onError = options.onError ?? (() => {});
    this.retryDelayMs = Number.isFinite(options.retryDelayMs)
      ? Math.max(1, Math.min(60_000, options.retryDelayMs!))
      : 1_000;
    this.schedule = options.schedule ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
    this.clear = options.clear ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  /** Enforce elapsed deadlines immediately, then arm the next active agent. */
  refresh(fleetId: string): void {
    this.clearFleet(fleetId);
    const at = this.now();
    // Gate #2 (t_db8af59c, 2026-08-26): reap stalled workers BEFORE checking
    // the wall-clock deadline. A stalled worker whose budget has not yet
    // elapsed would otherwise survive until the budget fires; the conductor
    // hand-off's "21+ hour zombie" pattern is the failure mode this ordering
    // removes. The two reapers are independent — this one (staleness) wins
    // on the stuck case, the next one (budget) wins on the forever case.
    let staleExpired: ExpiredFleetAgent[];
    try {
      staleExpired = this.expireStaleAgentsFn(fleetId, at);
    } catch (error) {
      this.onError(error);
      staleExpired = [];
    }
    for (const agent of staleExpired) {
      if (!agent.cancellation_attempted) {
        try {
          const cancellation = this.cancelAgent(agent);
          if (cancellation && typeof (cancellation as Promise<unknown>).catch === "function") {
            void (cancellation as Promise<unknown>).catch((error) => this.onError(error));
          }
        } catch (error) {
          this.onError(error);
        }
      }
      try {
        const observed = this.onExpired?.(agent, at);
        if (observed && typeof (observed as Promise<unknown>).catch === "function") {
          void (observed as Promise<unknown>).catch((error) => this.onError(error));
        }
      } catch (error) {
        this.onError(error);
      }
    }
    let expired: ExpiredFleetAgent[];
    try {
      expired = this.expire(fleetId, at);
    } catch (error) {
      this.onError(error);
      this.arm(fleetId, this.retryDelayMs);
      return;
    }
    for (const agent of expired) {
      if (!agent.cancellation_attempted) {
        try {
          const cancellation = this.cancelAgent(agent);
          if (cancellation && typeof (cancellation as Promise<unknown>).catch === "function") {
            void (cancellation as Promise<unknown>).catch((error) => this.onError(error));
          }
        } catch (error) {
          // Ledger terminalization already won. Runtime cancellation is best effort.
          this.onError(error);
        }
      }
      try {
        const observed = this.onExpired?.(agent, at);
        if (observed && typeof (observed as Promise<unknown>).catch === "function") {
          void (observed as Promise<unknown>).catch((error) => this.onError(error));
        }
      } catch (error) {
        this.onError(error);
      }
    }
    let deadline: number | undefined;
    try {
      deadline = this.nextDeadline(fleetId);
    } catch (error) {
      this.onError(error);
      this.arm(fleetId, this.retryDelayMs);
      return;
    }
    if (deadline === undefined) return;
    const delayMs = Math.max(0, deadline - this.now());
    this.arm(fleetId, delayMs);
  }

  private arm(fleetId: string, delayMs: number): void {
    try {
      const timer = this.schedule(() => {
        this.timers.delete(fleetId);
        this.refresh(fleetId);
      }, delayMs);
      this.timers.set(fleetId, timer);
    } catch (error) {
      this.onError(error);
    }
  }

  clearFleet(fleetId: string): void {
    const timer = this.timers.get(fleetId);
    if (timer === undefined) return;
    this.clear(timer);
    this.timers.delete(fleetId);
  }

  stop(): void {
    for (const fleetId of [...this.timers.keys()]) this.clearFleet(fleetId);
  }
}
