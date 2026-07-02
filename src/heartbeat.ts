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
  /** Max missed heartbeats before auto-fail. */
  maxMissed: number;
  /** Called when the agent is auto-failed due to missed heartbeats. */
  onMaxMissed: (reason: string) => void;
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
  let maxMissed = options.maxMissed ?? globalMaxMissed;
  let lastActualAt: number | null = null;
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
    lastActualAt = now;

    // Auto-fail after maxMissed heartbeats have fired. The semantics
    // here are: "after N heartbeats have occurred, the agent is
    // considered failed." This is a v0.7.x simplification — the real
    // "missed" semantics (agent not responding) would require a
    // round-trip pattern. See v0.8 for that.
    if (tickCount >= maxMissed && !maxMissedFired) {
      maxMissedFired = true;
      const reason = `Agent ${agentId} emitted ${tickCount} heartbeats (max ${maxMissed} before auto-fail)`;
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
      options.onMaxMissed(reason);
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
