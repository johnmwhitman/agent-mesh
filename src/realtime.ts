/**
 * Realtime — SSE subscriber registry.
 *
 * Manages a set of HTTP response streams (one per connected client) per
 * agent. When a message arrives in an agent's inbox, we push it to all
 * connected clients as an SSE event.
 *
 * Design:
 *   - Module-level state, reset between tests via shutdownServer()
 *   - Per-agent cap on connections (default 5, configurable for tests)
 *   - Write failures remove the subscriber (backpressure handling)
 *   - Shutdown closes all connections cleanly
 *
 * The HTTP server itself is started separately (see startServer in index.ts).
 * This module is just the in-memory registry + notification.
 */

import type { ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InboxEventType = "message" | "ack";

export interface InboxEvent {
  type: InboxEventType;
  message_id: string;
  from_agent_id?: string;
  payload?: string;
  timestamp: number;
}

export interface Subscriber {
  agent_id: string;
  res: ServerResponse;
  connected_at: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const MAX_CONNECTIONS_PER_AGENT_DEFAULT = 5;

let maxPerAgent = MAX_CONNECTIONS_PER_AGENT_DEFAULT;
const subscribers = new Map<string, Set<Subscriber>>();

export function setMaxConnectionsPerAgent(n: number): void {
  maxPerAgent = n;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function addSubscriber(agent_id: string, res: ServerResponse): void {
  let set = subscribers.get(agent_id);
  if (!set) {
    set = new Set();
    subscribers.set(agent_id, set);
  }
  if (set.size >= maxPerAgent) {
    // Cap exceeded — reject the connection
    try {
      res.end();
    } catch {
      // ignore
    }
    return;
  }
  set.add({ agent_id, res, connected_at: Date.now() });
}

export function removeSubscriber(agent_id: string, res: ServerResponse): void {
  const set = subscribers.get(agent_id);
  if (!set) return;
  for (const sub of set) {
    if (sub.res === res) {
      set.delete(sub);
      if (set.size === 0) subscribers.delete(agent_id);
      return;
    }
  }
}

export function getSubscriberCount(agent_id: string): number {
  return subscribers.get(agent_id)?.size ?? 0;
}

export function shutdownServer(): void {
  for (const set of subscribers.values()) {
    for (const sub of set) {
      try {
        sub.res.end();
      } catch {
        // ignore
      }
    }
  }
  subscribers.clear();
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

function formatSseEvent(event: InboxEvent): string {
  const data = {
    type: event.type,
    message_id: event.message_id,
    from_agent_id: event.from_agent_id,
    payload: event.payload,
    timestamp: event.timestamp,
  };
  return `event: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function notifySubscribers(agent_id: string, events: InboxEvent[]): number {
  const set = subscribers.get(agent_id);
  if (!set || set.size === 0) return 0;
  const payloads = events.map(formatSseEvent);
  let notified = 0;
  const toRemove: Subscriber[] = [];
  for (const sub of set) {
    let allOk = true;
    for (const payload of payloads) {
      try {
        const ok = sub.res.write(payload);
        if (!ok) {
          allOk = false;
          break;
        }
      } catch {
        allOk = false;
        break;
      }
    }
    if (allOk) {
      notified++;
    } else {
      toRemove.push(sub);
    }
  }
  for (const sub of toRemove) {
    set.delete(sub);
    try {
      sub.res.end();
    } catch {
      // ignore
    }
  }
  if (set.size === 0) subscribers.delete(agent_id);
  return notified;
}
