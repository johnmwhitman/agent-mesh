/**
 * Heartbeat — periodic liveness check for running agents.
 *
 * Emits heartbeat events while an agent is running. If the heartbeat
 * loop detects that more than `maxMissed` intervals have passed since
 * the last successful tick (e.g. because the agent process is hung or
 * the MCP server is blocked), the agent is marked as failed via the
 * onMaxMissed callback.
 *
 * The heartbeat loop runs in the same process as the MCP server. If the
 * MCP server itself is blocked, the heartbeat loop is blocked too —
 * which is the case we want to detect (a blocked agent means a blocked
 * MCP server).
 *
 * For distributed heartbeats (cross-process), see v0.8/v1.0.
 */

import { appendEvent } from "./core.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeartbeatEvent {
  type: "heartbeat";
  agent_id: string;
  fleet_id: string;
  timestamp: number;
  tick: number;
}

export interface CreateHeartbeatOptions {
  /** How often to emit a heartbeat, in ms. */
  intervalMs: number;
  /** Called on every heartbeat tick. */
  onHeartbeat: (event: HeartbeatEvent) => void;
  /** Max consecutive dead liveness checks before auto-fail. */
  maxMissed: number;
  /** Called when the agent is auto-failed due to missed heartbeats. */
  onMaxMissed?: (reason: string) => void;
  /**
   * Liveness probe, checked on every tick. Returning true resets the
   * missed counter; returning false counts as a missed heartbeat. When
   * omitted, the heartbeat is observational only and never auto-fails.
   */
  isAlive?: () => boolean;
}

export interface HeartbeatHandle {
  stop: () => void;
  /** Number of heartbeats emitted so far. */
  tick: () => number;
  /** Whether the heartbeat has been stopped. */
  isStopped: () => boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let globalMaxMissed = 5;

export function setMaxMissedHeartbeats(n: number): void {
  globalMaxMissed = n;
}

export function resetHeartbeatState(): void {
  // Currently no global state to reset beyond per-handle timers.
  // Kept for API symmetry with other modules.
}

// ---------------------------------------------------------------------------
// createHeartbeat
// ---------------------------------------------------------------------------

export function createHeartbeat(
  agentId: string,
  fleetId: string,
  options: CreateHeartbeatOptions
): HeartbeatHandle {
  let tickCount = 0;
  let stopped = false;
  const maxMissed = options.maxMissed ?? globalMaxMissed;
  let missedCount = 0;
  let maxMissedFired = false;

  const handle: HeartbeatHandle = {
    stop: () => {
      stopped = true;
    },
    tick: () => tickCount,
    isStopped: () => stopped,
  };

  const interval = setInterval(() => {
    if (stopped) {
      clearInterval(interval);
      return;
    }

    const now = Date.now();

    // Emit the heartbeat
    tickCount++;
    const event: HeartbeatEvent = {
      type: "heartbeat",
      agent_id: agentId,
      fleet_id: fleetId,
      timestamp: now,
      tick: tickCount,
    };

    try {
      appendEvent("heartbeat", {
        agent_id: agentId,
        fleet_id: fleetId,
        tick: tickCount,
        timestamp: now,
      });
    } catch {
      // appendEvent may fail in tests; ignore.
    }

    options.onHeartbeat(event);

    // Liveness check: only ticks where the probe reports the agent dead
    // count as "missed". A healthy long-running agent never auto-fails.
    // (Pre-fix behavior counted EVERY tick as missed, which SIGKILLed
    // every agent running longer than intervalMs * maxMissed.)
    if (options.isAlive === undefined || options.isAlive()) {
      missedCount = 0;
      return;
    }
    missedCount++;

    if (missedCount >= maxMissed && !maxMissedFired) {
      maxMissedFired = true;
      const reason = `Agent ${agentId} failed ${missedCount} consecutive liveness checks (max ${maxMissed} before auto-fail)`;
      try {
        appendEvent("heartbeat_max_missed", {
          agent_id: agentId,
          fleet_id: fleetId,
          heartbeat_count: tickCount,
          max_missed: maxMissed,
          timestamp: now,
        });
      } catch {
        // ignore
      }
      options.onMaxMissed?.(reason);
      clearInterval(interval);
      return;
    }
  }, options.intervalMs);

  // Unref so the interval doesn't prevent process exit
  if (typeof interval.unref === "function") {
    interval.unref();
  }

  return handle;
}
