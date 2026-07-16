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
  type Subscriber,
} from "./realtime.js";
import { resolveEnv } from "./env.js";

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

export function ssePort(): number {
  const v = Number(process.env.MESHFLEET_SSE_PORT);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_PORT;
}

export function sseHost(): string {
  return process.env.MESHFLEET_SSE_HOST ?? DEFAULT_HOST;
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
  return resolveEnv(process.env, "MESHFLEET_AUTH_TOKEN", "AGENT_MESH_AUTH_TOKEN");
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
      // end() fires the close handler's cleanup, but don't rely on event
      // timing for revocation — drop the subscription now.
      removeSubscriber(agentId, res);
      streamCredentials.delete(res);
      activeStreams.delete(res);
    }
  }
}

function handle401(res: ServerResponse): void {
  res.writeHead(401, { "Content-Type": "text/plain", "WWW-Authenticate": "Bearer" });
  res.end("unauthorized");
}

function handleSseConnection(agentId: string, res: ServerResponse, credential: string | undefined): void {
  setSseHeaders(res);
  const sub: Subscriber = { agent_id: agentId, res, connected_at: Date.now() };
  addSubscriber(agentId, res);
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

export function startSseServer(): Promise<{ host: string; port: number }> {
  return new Promise((resolve, reject) => {
    if (httpServer) {
      reject(new Error("SSE server already running"));
      return;
    }
    const port = ssePort();
    const host = sseHost();

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // CORS preflight — permissive for local dev
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        });
        res.end();
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", "*");

      const url = new URL(req.url ?? "/", `http://${host}:${port}`);

      if (url.pathname === "/healthz" || url.pathname === "/healthz/") {
        handleHealthz(res);
        return;
      }

      const credential = providedToken(req, url);
      if (!credentialAuthorized(credential)) {
        handle401(res);
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
    shutdownSubscribers();
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
  return `http://${host}:${port}/inbox/${agentId}/stream`;
}
