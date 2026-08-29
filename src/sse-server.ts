/**
 * SSE Server — HTTP endpoint for Server-Sent Events inbox push.
 *
 * The agent-mesh MCP server normally runs over stdio. This module adds a
 * separate HTTP listener that agents can connect to for real-time push
 * delivery of incoming P2P messages.
 *
 * Endpoints:
 *   GET /inbox/:agent_id/stream — SSE stream of events for that agent
 *   GET /healthz — liveness check
 *
 * Events are SSE-formatted: `event: <type>\ndata: <json>\n\n`
 *
 * Configuration via env vars:
 *   MESHFLEET_SSE_PORT — port to listen on (default 13579)
 *   MESHFLEET_SSE_HOST — bind address (default 127.0.0.1)
 *   MESHFLEET_AUTH_TOKEN — optional bearer token; when set, every endpoint
 *     except /healthz requires `Authorization: Bearer <token>` or `?token=`
 *     (EventSource cannot set headers). Unset = open access (local trust).
 *
 * The server is bound to 127.0.0.1 by default for security — if you bind any
 * wider, set MESHFLEET_AUTH_TOKEN.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  addSubscriber,
  removeSubscriber,
  shutdownServer as shutdownSubscribers,
} from "./realtime.js";
import {
  addEventSubscriber,
  getEventStreamSubscriberCount,
  getMaxEventStreamConnections,
  removeEventSubscriber,
  shutdownEventStream,
} from "./event-stream.js";
import { resolveEnv } from "./env.js";
import { createA2AHttpHandler, type A2ATaskStatus } from "./a2a/http.js";
import {
  createRoutePlaneProviderHandler,
  createRoutePlaneProviderHealthHandler,
  type RoutePlaneProviderEndpointMountOptions,
} from "./routeplane-provider-endpoint.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 13579;
const DEFAULT_HOST = "127.0.0.1";
const HEARTBEAT_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let httpServer: ReturnType<typeof createServer> | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
const activeStreams = new Set<ServerResponse>();
/** Per-stream: who it serves + the credential it was admitted with, for re-auth on token change. */
const streamCredentials = new Map<ServerResponse, { agentId: string; credential: string | undefined }>();

/** Credentials for fleet-wide event stream connections (no agentId). */
const eventStreamCredentials = new Map<ServerResponse, { fleetId: string | undefined; credential: string | undefined }>();

export interface SseServerOptions {
  readonly a2a?: {
    readonly submitTask: (input: { readonly text: string; readonly metadata?: Record<string, unknown> }) => Promise<{ readonly fleetId: string; readonly agentId: string }>;
    readonly getTaskStatus: (fleetId: string, agentId: string) => A2ATaskStatus | undefined;
  };
  /**
   * Optional RoutePlane provider endpoint (the `routeplane/intelligent-router`
   * profile entry point). When provided, the SSE server mounts
   * `POST /v1/chat/completions` and `GET /v1/router/health` on the same
   * loopback listener. Disabled (not mounted) by default — operators must
   * opt in to expose the seam.
   */
  readonly routeplaneProvider?: RoutePlaneProviderEndpointMountOptions;
}

export function ssePort(): number {
  const v = Number(process.env.MESHFLEET_SSE_PORT);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_PORT;
}

export function sseHost(): string {
  return process.env.MESHFLEET_SSE_HOST ?? DEFAULT_HOST;
}

export function formatHostForUrl(host: string): string {
  const unbracketed = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return unbracketed.includes(":") ? `[${unbracketed}]` : unbracketed;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".").map(Number);
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) && octets[0] === 127;
}

export function isSseServerRunning(): boolean {
  return httpServer !== null && httpServer.listening;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Initial comment to establish the stream
  res.write(":ok\n\n");
}

function parseInboxPath(pathname: string): string | null {
  const m = pathname.match(/^\/inbox\/([A-Za-z0-9_-]+)\/stream\/?$/);
  return m ? (m[1] ?? null) : null;
}

/**
 * Optional auth token (MESHFLEET_AUTH_TOKEN, legacy AGENT_MESH_AUTH_TOKEN).
 * Read per-request so a long-lived server honors an operator's change without
 * a restart. Unset = open access (the historical local-trust default).
 */
function authToken(): string | undefined {
  const sseToken = process.env.MESHFLEET_SSE_TOKEN;
  if (sseToken?.trim()) return sseToken;
  const configured = resolveEnv(process.env, "MESHFLEET_AUTH_TOKEN", "AGENT_MESH_AUTH_TOKEN");
  return configured?.trim() ? configured : undefined;
}

/** Constant-time comparison over digests, so length differences leak nothing. */
function tokenMatches(expected: string, provided: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

/**
 * The credential a request presented — `Authorization: Bearer <token>` preferred
 * (scheme case-insensitive per RFC 7235); `?token=` accepted because EventSource
 * cannot set headers.
 */
function providedToken(req: IncomingMessage, url: URL): string | undefined {
  const m = req.headers.authorization?.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? url.searchParams.get("token") ?? undefined;
}

/** True when the given credential passes the CURRENT token config. */
function credentialAuthorized(provided: string | undefined): boolean {
  const expected = authToken();
  if (expected === undefined) return true;
  return provided !== undefined && tokenMatches(expected, provided);
}

/**
 * Re-check every live stream against the current token config and end those
 * that no longer authorize — enabling or rotating MESHFLEET_AUTH_TOKEN must
 * revoke streams admitted under the old (or no) token, not only new requests.
 * Runs on every heartbeat tick; exported for direct use and tests.
 */
export function enforceStreamAuth(): void {
  for (const [res, { agentId, credential }] of streamCredentials) {
    if (!credentialAuthorized(credential)) {
      try {
        res.end();
      } catch {
        // already broken; the close handler still cleans up
      }
      removeSubscriber(agentId, res);
      streamCredentials.delete(res);
      activeStreams.delete(res);
    }
  }
  for (const [res, { credential }] of eventStreamCredentials) {
    if (!credentialAuthorized(credential)) {
      try {
        res.end();
      } catch {
        // already broken; the close handler still cleans up
      }
      removeEventSubscriber(res);
      eventStreamCredentials.delete(res);
      activeStreams.delete(res);
    }
  }
}

function handle401(res: ServerResponse): void {
  res.writeHead(401, { "Content-Type": "text/plain", "WWW-Authenticate": "Bearer" });
  res.end("unauthorized");
}

function handleSseConnection(agentId: string, res: ServerResponse, credential: string | undefined): void {
  // Ask BEFORE writing headers. The old order sent a 200 and an `:ok` SSE frame
  // first, so a connection refused by the per-agent cap looked to the client like
  // a successful subscribe followed by an unexplained drop — and it was then
  // registered in activeStreams/streamCredentials anyway, because the rejection
  // was unobservable. A refused client now gets a status code that says so.
  const subscribed = addSubscriber(agentId, res);
  if (!subscribed.accepted) {
    res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "5" });
    res.end(`too many concurrent inbox streams for this agent (limit ${subscribed.limit})`);
    return;
  }
  setSseHeaders(res);
  activeStreams.add(res);
  streamCredentials.set(res, { agentId, credential });

  const cleanup = () => {
    removeSubscriber(agentId, res);
    activeStreams.delete(res);
    streamCredentials.delete(res);
  };

  res.on("close", cleanup);
  res.on("error", cleanup);
}

function handleEventStreamConnection(fleetId: string | undefined, res: ServerResponse, credential: string | undefined): void {
  if (getEventStreamSubscriberCount() >= getMaxEventStreamConnections()) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("event stream connection limit reached");
    return;
  }
  setSseHeaders(res);
  addEventSubscriber(res, fleetId);
  activeStreams.add(res);
  eventStreamCredentials.set(res, { fleetId, credential });

  const cleanup = () => {
    removeEventSubscriber(res);
    activeStreams.delete(res);
    eventStreamCredentials.delete(res);
  };

  res.on("close", cleanup);
  res.on("error", cleanup);
}

function handleHealthz(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
}

function handle404(res: ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

export function startSseServer(options: SseServerOptions = {}): Promise<{ host: string; port: number }> {
  return new Promise((resolve, reject) => {
    if (httpServer) {
      reject(new Error("SSE server already running"));
      return;
    }
    const port = ssePort();
    const host = sseHost();
    if (!isLoopbackHost(host) && authToken() === undefined) {
      reject(new Error("refusing SSE/A2A startup on non-loopback host without an auth token"));
      return;
    }
    const baseUrl = `http://${formatHostForUrl(host)}:${port}`;

    const a2aHandler = options.a2a
      ? createA2AHttpHandler({
        baseUrl,
        submitTask: options.a2a.submitTask,
        getTaskStatus: options.a2a.getTaskStatus,
      })
      : undefined;
    // MeshFleet provider endpoint — opt-in. Profiles that set
    // `model: routeplane/intelligent-router` connect to this URL. Auth
    // is gated by the same MESHFLEET_SSE_TOKEN the rest of the SSE
    // server uses, so the boundary stays aligned.
    const providerHandler = options.routeplaneProvider
      ? createRoutePlaneProviderHandler(options.routeplaneProvider)
      : undefined;
    const providerHealthHandler = options.routeplaneProvider
      ? createRoutePlaneProviderHealthHandler(options.routeplaneProvider)
      : undefined;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // CORS preflight — permissive for local dev
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        });
        res.end();
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", "*");

      const url = new URL(req.url ?? "/", baseUrl);

      if (url.pathname === "/healthz" || url.pathname === "/healthz/") {
        handleHealthz(res);
        return;
      }

      const credential = providedToken(req, url);
      if (!credentialAuthorized(credential)) {
        handle401(res);
        return;
      }

      if (a2aHandler && (url.pathname.startsWith("/a2a/") || url.pathname.startsWith("/.well-known/agent-card.json"))) {
        a2aHandler(req, res);
        return;
      }

      if (providerHealthHandler && url.pathname === "/v1/router/health") {
        void providerHealthHandler(req, res);
        return;
      }

      if (providerHandler && url.pathname === "/v1/chat/completions") {
        void providerHandler(req, res);
        return;
      }

      if (url.pathname === "/events/stream" || url.pathname === "/events/stream/") {
        if (req.method !== "GET") {
          res.writeHead(405, { "Content-Type": "text/plain" });
          res.end("method not allowed");
          return;
        }
        const fleetId = url.searchParams.get("fleet_id") || undefined;
        handleEventStreamConnection(fleetId, res, credential);
        return;
      }

      const agentId = parseInboxPath(url.pathname);
      if (agentId) {
        if (req.method !== "GET") {
          res.writeHead(405, { "Content-Type": "text/plain" });
          res.end("method not allowed");
          return;
        }
        handleSseConnection(agentId, res, credential);
        return;
      }

      handle404(res);
    });

    server.once("error", (err) => {
      httpServer = null;
      reject(err);
    });

    server.listen(port, host, () => {
      httpServer = server;
      // Heartbeat: re-check auth (a rotated token revokes stale streams within
      // one interval), then keep the surviving streams alive
      heartbeatTimer = setInterval(() => {
        enforceStreamAuth();
        for (const res of activeStreams) {
          try {
            res.write(":hb\n\n");
          } catch {
            // stream closed; will be cleaned up by the close handler
          }
        }
      }, HEARTBEAT_INTERVAL_MS);
      resolve({ host, port });
    });
  });
}

export function stopSseServer(): Promise<void> {
  return new Promise((resolve) => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    // Close all active streams cleanly
    for (const res of activeStreams) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    activeStreams.clear();
    streamCredentials.clear();
    eventStreamCredentials.clear();
    shutdownSubscribers();
    shutdownEventStream();
    if (httpServer) {
      const server = httpServer;
      httpServer = null;
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
}

/**
 * Build the URL a client should connect to for the given agent's inbox stream.
 * Used by the `subscribe_inbox` MCP tool handler.
 */
export function subscribeInboxUrl(agentId: string, baseUrl?: string): string {
  const port = ssePort();
  const host = baseUrl ?? "127.0.0.1";
  return `http://${formatHostForUrl(host)}:${port}/inbox/${agentId}/stream`;
}

export function subscribeEventsUrl(fleetId?: string, baseUrl?: string): string {
  const port = ssePort();
  const host = baseUrl ?? "127.0.0.1";
  const base = `http://${formatHostForUrl(host)}:${port}/events/stream`;
  return fleetId ? `${base}?fleet_id=${encodeURIComponent(fleetId)}` : base;
}
