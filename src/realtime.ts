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
 *   - A THROWN write drops the subscriber; BACKPRESSURE does not (see below)
 *   - Every drop is reported to stderr — never stdout, which is the MCP transport
 *   - Shutdown closes all connections cleanly
 *
 * 🔴 BACKPRESSURE IS NOT A FAILURE, and treating it as one was a silent-loss bug.
 * `ServerResponse.write()` returns `false` when the kernel buffer is full — the
 * data IS accepted and queued, and the stream will drain. The old code read that
 * `false` as fatal: it broke out of the payload loop, abandoning every remaining
 * event for that subscriber, then evicted and `end()`ed the connection, with no
 * log, no counter and no event. A merely SLOW consumer — the ordinary case when a
 * large fleet bursts — was disconnected and told nothing, which is precisely the
 * betrayal this product's first law names. Only a THROW means the stream is
 * genuinely gone.
 *
 * The HTTP server itself is started separately (see startServer in index.ts).
 * This module is just the in-memory registry + notification.
 */

import type { ServerResponse } from "node:http";

/**
 * Diagnostics go to STDERR only. stdout is the MCP protocol transport, and a
 * non-protocol byte written there corrupts the client's session. Wrapped so a
 * closed stderr can never propagate into a notify() caller.
 */
function reportSse(line: string): void {
  try {
    process.stderr.write(`meshfleet: sse ${line}\n`);
  } catch {
    // Even stderr can be gone. Losing the diagnostic must not lose the event.
  }
}

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

/**
 * Register a subscriber, or REFUSE and say so.
 *
 * This used to return `void` and `end()` the response itself when the per-agent
 * cap was hit. The caller had already written a 200 and an `:ok` SSE frame, so a
 * refused client saw a successful handshake followed by a close indistinguishable
 * from a network drop — and an `EventSource` reconnects into the same refusal
 * forever, receiving nothing. A rejection the caller cannot observe is a rejection
 * the client is never told about, so the decision is returned and the response is
 * left entirely to the caller.
 */
export interface SubscribeResult {
  accepted: boolean;
  /** Present when refused, so the caller can say WHY rather than just closing. */
  reason?: "per_agent_connection_cap";
  limit?: number;
}

export function addSubscriber(agent_id: string, res: ServerResponse): SubscribeResult {
  let set = subscribers.get(agent_id);
  if (!set) {
    set = new Set();
    subscribers.set(agent_id, set);
  }
  if (set.size >= maxPerAgent) {
    reportSse(`refused subscriber for agent=${agent_id}: per-agent connection cap ${maxPerAgent} reached`);
    return { accepted: false, reason: "per_agent_connection_cap", limit: maxPerAgent };
  }
  set.add({ agent_id, res, connected_at: Date.now() });
  return { accepted: true };
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
    let dead = false;
    let backpressured = false;
    for (const payload of payloads) {
      try {
        // A `false` return means the kernel buffer is full — the payload is
        // still ACCEPTED and queued, so we keep writing the rest. Breaking here
        // is what silently dropped the tail of a burst for a slow consumer.
        if (!sub.res.write(payload)) backpressured = true;
      } catch {
        // A throw is the stream genuinely being gone. Stop writing to it.
        dead = true;
        break;
      }
    }
    if (dead) {
      toRemove.push(sub);
    } else {
      // Every payload was accepted, queued or not. This subscriber WAS notified.
      notified++;
      if (backpressured) {
        reportSse(`slow consumer for agent=${agent_id}: ${payloads.length} event(s) queued behind a full buffer (connection kept)`);
      }
    }
  }
  for (const sub of toRemove) {
    set.delete(sub);
    reportSse(`dropped subscriber for agent=${agent_id}: stream write threw (client gone)`);
    try {
      sub.res.end();
    } catch {
      // ignore
    }
  }
  if (set.size === 0) subscribers.delete(agent_id);
  return notified;
}
