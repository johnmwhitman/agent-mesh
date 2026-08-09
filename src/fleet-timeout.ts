export interface ExpiredFleetAgent {
  agent_id: string;
  fleet_id: string;
  pid?: number;
  reason: string;
  /** A mode-specific owner already attempted handle/PID containment. */
  cancellation_attempted?: true;
}

export interface FleetTimeoutEnforcerOptions {
  now?: () => number;
  nextDeadline: (fleetId: string) => number | undefined;
  expire: (fleetId: string, now: number) => ExpiredFleetAgent[];
  cancelAgent: (agent: ExpiredFleetAgent) => void | Promise<unknown>;
  onExpired?: (agent: ExpiredFleetAgent, now: number) => void | Promise<unknown>;
  onError?: (error: unknown) => void;
  retryDelayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  clear?: (timer: unknown) => void;
}

/**
 * Owns only deadline scheduling. Ledger mutation and runtime cancellation stay
 * injected so the same scheduler can drive legacy and durable lifecycle modes.
 */
export class FleetTimeoutEnforcer {
  private readonly now: () => number;
  private readonly nextDeadline: FleetTimeoutEnforcerOptions["nextDeadline"];
  private readonly expire: FleetTimeoutEnforcerOptions["expire"];
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
