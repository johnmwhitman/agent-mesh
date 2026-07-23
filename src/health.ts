/**
 * Health — liveness, observability, and rate-limiting for the agent-mesh.
 *
 * Two MCP tools:
 *   - `ping`   — minimal liveness check (returns "ok" with current timestamp)
 *   - `get_health` — deeper report: ledger size, fleet/agent/message counts,
 *                     uptime, recent events
 *
 * Plus:
 *   - `checkRateLimit` — IP-keyed rate limiting with separate read and write
 *     buckets. The /api/brief/generate-style writes are already rate-limited
 *     in src/index.ts; this module adds read-side rate limiting to prevent
 *     a misbehaving client from hammering `list_fleets`, `fleet_status`, etc.
 *   - `getLedgerSize` — combined size of the JSON ledger and the NDJSON
 *     event log. Used by the size-warning logic in src/index.ts.
 *
 * All functions are pure (no I/O), easy to test, and side-effect-free
 * except for the in-memory rate-limit buckets.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { loadData, resolveEventLogFile } from './core.js'
import { resolveDbFile } from './db.js'

// ---------------------------------------------------------------------------
// Process startup time (for uptime)
// ---------------------------------------------------------------------------

const PROCESS_START_MS = Date.now()

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

export interface PingResult {
  status: 'ok'
  timestamp: number
}

export function ping(): PingResult {
  return {
    status: 'ok',
    timestamp: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// getHealth
// ---------------------------------------------------------------------------

export interface HealthReport {
  status: 'ok' | 'degraded' | 'error'
  uptime_ms: number
  fleets: number
  agents: number
  messages: number
  capabilities: number
  events: number
  ledger_bytes: number
  events_log_bytes: number
  last_event_timestamp?: number
  /**
   * Fleets left `running` past 24h whose agents have ALL reached a terminal state. These are
   * projection inconsistencies, not hangs, so they do not set `degraded` — but they are
   * counted here so fixing the false alarm never hides them. Reconciling them to a terminal
   * fleet status is a separate, explicit operator action.
   */
  abandoned_fleets: number
}

export function getHealth(): HealthReport {
  const data = loadData()
  const fleets = Object.values(data.fleets)
  const agents = Object.values(data.agents)
  const messages = Object.values(data.messages)
  const capabilities = Object.values(data.capabilities)

  const { ledgerBytes, eventsBytes, eventCount, lastTimestamp } = readStorageStats()

  const now = Date.now()
  const ONE_DAY = 24 * 60 * 60 * 1000

  // A fleet left `running` past 24h is one of two very different things, and reporting them
  // as the same thing made this signal useless.
  //
  // STUCK — work could still be moving (an agent is `pending` or `running`), or the fleet has
  // no agents at all so nothing will ever trigger its completion. That is a hang: actionable,
  // and it drives `degraded`.
  //
  // ABANDONED — every agent has reached a terminal state but the fleet was never closed. This
  // is a projection inconsistency, not a hung worker: `recoverInterruptedAgents` flips crashed
  // agents to `interrupted` without calling `_checkFleetCompletion`, and `_checkFleetCompletion`
  // terminalizes only on `complete`/`failed`, so such a fleet can never close on its own. It is
  // reported in its own field rather than folded into `degraded`, because a status latched at
  // `degraded` forever carries exactly as much information as no status at all.
  const isLiveAgentStatus = (s: string): boolean => s === 'pending' || s === 'running'
  const oldRunning = fleets.filter((f) => f.status === 'running' && now - f.created_at > ONE_DAY)

  let hasStuckFleet = false
  let abandonedFleets = 0
  for (const fleet of oldRunning) {
    const fleetAgents = agents.filter((a) => a.fleet_id === fleet.id)
    // Note the empty case is deliberately STUCK, not abandoned: `[].every(terminal)` is
    // vacuously true, and treating that as "finished" would silently clear a fleet that
    // nothing can ever complete.
    if (fleetAgents.length === 0 || fleetAgents.some((a) => isLiveAgentStatus(a.status))) {
      hasStuckFleet = true
    } else {
      abandonedFleets += 1
    }
  }

  const hasCorruptLedger = ledgerBytes < 0

  let status: 'ok' | 'degraded' | 'error' = 'ok'
  if (hasCorruptLedger) status = 'error'
  else if (hasStuckFleet) status = 'degraded'

  return {
    status,
    uptime_ms: now - PROCESS_START_MS,
    fleets: fleets.length,
    agents: agents.length,
    messages: messages.length,
    capabilities: capabilities.length,
    events: eventCount,
    abandoned_fleets: abandonedFleets,
    ledger_bytes: ledgerBytes,
    events_log_bytes: eventsBytes,
    last_event_timestamp: lastTimestamp,
  }
}

// ---------------------------------------------------------------------------
// Storage stats
// ---------------------------------------------------------------------------

interface StorageStats {
  ledgerBytes: number
  eventsBytes: number
  eventCount: number
  lastTimestamp: number | undefined
}

function readStorageStats(): StorageStats {
  const out: StorageStats = {
    ledgerBytes: 0,
    eventsBytes: 0,
    eventCount: 0,
    lastTimestamp: undefined,
  }

  // Ledger file: the live SQLite db (via the withLedger seam). Falls back to a
  // legacy agent-mesh.json only when the db doesn't exist yet (pre-migration).
  // Either may be absent on disk (fresh install / test temp dir) — skip if so.
  try {
    const ledgerPath = findLedgerFile()
    if (ledgerPath) {
      const stat = statSync(ledgerPath)
      out.ledgerBytes = stat.size
    }
  } catch {
    out.ledgerBytes = -1
  }

  // Event log: scan parent dir for agent-mesh.events.log
  try {
    const eventsPath = findEventsLogFile()
    if (eventsPath) {
      const stat = statSync(eventsPath)
      out.eventsBytes = stat.size
      // Count lines and find last timestamp
      const content = readFileSync(eventsPath, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)
      out.eventCount = lines.length
      if (lines.length > 0) {
        const last = lines[lines.length - 1] as string
        try {
          const parsed = JSON.parse(last) as { timestamp?: number }
          out.lastTimestamp = parsed.timestamp
        } catch {
          // skip
        }
      }
    }
  } catch {
    // skip
  }

  return out
}

function findLedgerFile(): string | null {
  // The canonical ledger path (SQLite db). Returns null when it doesn't exist
  // yet (fresh install / isolated test) → 0 bytes. No real-file fallback scan:
  // that read the developer's real ledger under test and made sizes nondeterministic.
  const dbFile = resolveDbFile()
  return dbFile && dbFile !== ':memory:' && existsSync(dbFile) ? dbFile : null
}

function findEventsLogFile(): string | null {
  // The configured event-log path — the same one appendEvent writes to (and the
  // isolated temp path under test). Null when it doesn't exist yet → 0 bytes.
  const f = resolveEventLogFile()
  return f && existsSync(f) ? f : null
}

// ---------------------------------------------------------------------------
// getLedgerSize — public API
// ---------------------------------------------------------------------------

export function getLedgerSize(): number {
  const stats = readStorageStats()
  return Math.max(0, stats.ledgerBytes) + Math.max(0, stats.eventsBytes)
}

// ---------------------------------------------------------------------------
// Rate limiting (read + write buckets, IP-keyed)
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  readPerHour: number
  writePerHour: number
}

let currentConfig: RateLimitConfig = {
  readPerHour: 600, // 600 reads/hour = 10/min, comfortable for humans
  writePerHour: 60, // 60 writes/hour = 1/min, tighter because writes are expensive
}

export function setRateLimitConfig(config: Partial<RateLimitConfig>): void {
  currentConfig = { ...currentConfig, ...config }
}

export function getRateLimitConfig(): RateLimitConfig {
  return { ...currentConfig }
}

interface RateLimitBucket {
  count: number
  resetAt: number
}

const rateLimit = new Map<string, RateLimitBucket>()

const RATE_WINDOW_MS = 60 * 60 * 1000

export function resetRateLimits(): void {
  rateLimit.clear()
}

export function checkRateLimit(
  ip: string,
  bucket: 'read' | 'write'
): boolean {
  const now = Date.now()
  const key = `${ip}:${bucket}`
  const entry = rateLimit.get(key)
  const limit = bucket === 'read' ? currentConfig.readPerHour : currentConfig.writePerHour

  if (!entry || entry.resetAt < now) {
    rateLimit.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return true
  }
  if (entry.count >= limit) {
    return false
  }
  entry.count++
  return true
}

// Backwards-compatible single-arg signature for existing call sites.
export function checkWriteRateLimit(ip: string): boolean {
  return checkRateLimit(ip, 'write')
}

// ---------------------------------------------------------------------------
// Re-export
// ---------------------------------------------------------------------------

export type { HealthReport as default }