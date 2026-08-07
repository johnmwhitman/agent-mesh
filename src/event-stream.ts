/**
 * Unified event stream — subscriber registry.
 *
 * Every call to `appendEvent` (core.ts) also calls `notifyEventSubscribers`
 * here, pushing the raw NDJSON entry to all connected SSE clients.
 *
 * Design mirrors realtime.ts:
 *   - Module-level state, reset between tests via shutdownEventStream()
 *   - Optional per-subscriber fleet_id filter
 *   - Write failures remove the subscriber (backpressure handling)
 *   - Shutdown closes all connections cleanly
 */

import type { ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EventStreamSubscriber {
  res: ServerResponse;
  fleet_id?: string; // undefined = no filter (all events)
  connected_at: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const MAX_EVENT_STREAM_CONNECTIONS_DEFAULT = 20;

let maxConnections = MAX_EVENT_STREAM_CONNECTIONS_DEFAULT;
/** All active event-stream subscribers. */
const subscribers = new Set<EventStreamSubscriber>();

export function setMaxEventStreamConnections(n: number): void {
  maxConnections = n;
}

export function getEventStreamSubscriberCount(fleet_id?: string): number {
  if (fleet_id === undefined) return subscribers.size;
  let count = 0;
  for (const sub of subscribers) {
    if (sub.fleet_id === undefined || sub.fleet_id === fleet_id) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Register a new event-stream subscriber.
 * Returns false (and closes res) when the global cap is reached.
 */
export function addEventSubscriber(res: ServerResponse, fleet_id?: string): boolean {
  if (subscribers.size >= maxConnections) {
    try {
      res.end();
    } catch {
      // ignore
    }
    return false;
  }
  subscribers.add({ res, fleet_id, connected_at: Date.now() });
  return true;
}

export function removeEventSubscriber(res: ServerResponse): void {
  for (const sub of subscribers) {
    if (sub.res === res) {
      subscribers.delete(sub);
      return;
    }
  }
}

export function shutdownEventStream(): void {
  for (const sub of subscribers) {
    try {
      sub.res.end();
    } catch {
      // ignore
    }
  }
  subscribers.clear();
  maxConnections = MAX_EVENT_STREAM_CONNECTIONS_DEFAULT;
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

/**
 * Format a raw event object as an SSE event frame.
 * `event` is the event kind string (e.g. "message_sent"); `data` is the full
 * JSON object. This matches the NDJSON event log shape exactly.
 */
function formatEventFrame(eventKind: string, data: Record<string, unknown>): string {
  return `event: ${eventKind}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Push one ledger event to all matching subscribers.
 *
 * @param eventKind - the event type string (first arg to appendEvent)
 * @param data      - the full event object already written to the NDJSON log
 */
export function notifyEventSubscribers(
  eventKind: string,
  data: Record<string, unknown>
): number {
  if (subscribers.size === 0) return 0;

  const fleetId = typeof data.fleet_id === "string" ? data.fleet_id : undefined;
  const payload = formatEventFrame(eventKind, data);

  let notified = 0;
  const toRemove: EventStreamSubscriber[] = [];

  for (const sub of subscribers) {
    // Fleet filter: skip if subscriber wants a specific fleet and this event
    // doesn't carry that fleet_id.
    if (sub.fleet_id !== undefined && sub.fleet_id !== fleetId) {
      continue;
    }
    try {
      const ok = sub.res.write(payload);
      if (ok) {
        notified++;
      } else {
        toRemove.push(sub);
      }
    } catch {
      toRemove.push(sub);
    }
  }

  for (const sub of toRemove) {
    subscribers.delete(sub);
    try {
      sub.res.end();
    } catch {
      // ignore
    }
  }

  return notified;
}
