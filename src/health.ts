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
import { join, dirname, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { loadData, resolveEventLogFile } from './core.js'
import { ensureLedgerInstanceId, resolveDbFile } from './db.js'

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

/**
 * Where this ledger file lives in the consumer's mental model.
 *
 *  - `user`    — the canonical default `~/.config/opencode/agent-mesh.db`
 *    (the consumer's main evidence store).
 *  - `project` — anywhere else on the filesystem that is NOT a tempdir,
 *    typically a `MESHFLEET_DB_FILE` override pointed at a per-project
 *    file. Expected to carry different identity from `user`.
 *  - `test`    — any path under `os.tmpdir()`. Multiple invocations create
 *    multiple distinct ledgers; identity is expected to vary per run.
 *  - `memory`  — the `:memory:` SQLite handle. No persisted identity
 *    possible (no meta table survives process exit), so callers must
 *    know they are looking at a transient.
 *
 * Two consumers that disagree on scope SHOULD disagree on identity. The
 * scope field is the cheap pre-check; the id is the binding check.
 */
export type LedgerScope = 'user' | 'project' | 'test' | 'memory'

/**
 * Classify a resolved ledger path into a scope. Pure: takes the path string,
 * returns the scope. `memory` is the literal `':memory:'` handle; everything
 * else is path-based.
 */
export function classifyLedgerScope(ledgerPath: string): LedgerScope {
  if (ledgerPath === ':memory:') return 'memory'
  const abs = resolve(ledgerPath)
  const tmp = resolve(tmpdir())
  // Path-segment test: `/tmp` contains `/tmp-thing` falsely; walk segments.
  // Normalized leading separators make a startsWith safe on POSIX, and the
  // Windows tmp is also `os.tmpdir()` so the same predicate handles both.
  if (abs === tmp || abs.startsWith(tmp + '/') || abs.startsWith(tmp + '\\')) return 'test'
  // The canonical user ledger lives at `<homedir>/.config/opencode/agent-mesh.db`.
  // A MESHFLEET_DB_FILE override pointed at the same path is still `user` —
  // only the resolver decides. HOME is read first so test fixtures that
  // override HOME (the supported isolation pattern) classify consistently;
  // `homedir()` is the fallback for environments where HOME is unset.
  const home = process.env['HOME'] && process.env['HOME']!.length > 0
    ? process.env['HOME']!
    : homedir()
  const userDefault = resolve(join(home, '.config', 'opencode', 'agent-mesh.db'))
  if (abs === userDefault) return 'user'
  return 'project'
}

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
   * Fleets whose agents have ALL reached a terminal state with at least one
   * `interrupted` — the fleet's process died rather than finishing or erroring.
   * These are not hangs, so they do not set `degraded`, but they are counted so
   * the condition can never become invisible.
   *
   * Counts both the stored `abandoned` status (0.16.0+, the normal case, no age
   * gate) and the legacy inference over fleets still mislabelled `running` past
   * 24h in a ledger that has not been reconciled.
   */
  abandoned_fleets: number
  /**
   * Absolute path of the SQLite ledger file backing this server. Resolved via
   * `MESHFLEET_DB_FILE` → `setLedgerPath` → compiled-in default. Included so a
   * consumer that receives an unexpected `ledger_instance_id` can tell at a
   * glance whether the server is reading the file it assumed.
   *
   * String `':memory:'` for the in-memory handle (test fixtures).
   */
  ledger_path: string
  /**
   * Non-secret stable identity of the ledger file (16 hex chars, 64 bits of
   * randomness minted at first-open). Two readers of the SAME file receive
   * the same id across processes and restarts; two readers of DIFFERENT
   * files (even on the same path, after a move-aside + recreate) receive
   * different ids. The id is published in health exactly so consumers can
   * detect wrong-store paths that would otherwise look like an empty
   * ledger.
   */
  ledger_instance_id: string
  /**
   * Where this ledger is expected to live (see {@link LedgerScope}). Together
   * with `ledger_instance_id` this lets a consumer answer "did I open the
   * ledger I meant?" without comparing absolute paths in a Slack thread.
   */
  ledger_scope: LedgerScope
  /**
   * True iff a `MESHFLEET_EXPECTED_LEDGER_ID` env var is set on this server
   * AND its value does not equal this ledger's `ledger_instance_id`. A
   * mismatch sets `status` to `degraded` (NOT `error` — the data is fine,
   * the operator's expectation is wrong, and an error here would mask the
   * real shape of the problem) and is the loud signal the dogfood run
   * needed to distinguish "empty intended ledger" from "wrong store".
   */
  ledger_identity_mismatch: boolean
  /**
   * The expected id from `MESHFLEET_EXPECTED_LEDGER_ID`, when set. Echoed
   * back so the operator can see what the server was comparing against
   * without needing access to the server's environment. `undefined` when
   * the env var is unset.
   */
  expected_ledger_id?: string
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

  // Resolve the ledger identity surface. resolveDbFile may return a temp
  // path under MESHFLEET_DB_FILE; resolve() so the path is absolute and
  // the scope classifier doesn't have to know about `..` segments.
  const ledgerPath = resolveDbFile()
  const ledgerScope = classifyLedgerScope(ledgerPath)
  // ensureLedgerInstanceId both READS the persisted id and mints one if
  // absent. Mint-on-read (not just mint-on-first-open) means an older ledger
  // gets backfilled on its next health probe, with no schema bump required.
  const ledgerInstanceId = ensureLedgerInstanceId()
  // Operator-set expectation. Trimmed to defend against a stray whitespace in
  // a shell command. An unset var compares unequal to any string, so the
  // mismatch flag stays false in the common case (no env var).
  const expectedRaw = process.env['MESHFLEET_EXPECTED_LEDGER_ID']
  const expectedLedgerId = typeof expectedRaw === 'string' ? expectedRaw.trim() : ''
  const hasExpectation = expectedLedgerId.length > 0
  const ledgerIdentityMismatch =
    hasExpectation && expectedLedgerId !== ledgerInstanceId

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
  // Since 0.16.0 abandonment is a STORED fleet status, so it is counted from the
  // rows rather than inferred. Counting only the inference would have silenced
  // this number the moment the reconciler started labelling fleets correctly —
  // the alarm would read 0 precisely because the condition was now being
  // recorded. Never remove an alarm without its replacement signal.
  //
  // No age gate on the stored form: `abandoned` is a decided outcome, not a
  // suspicion that needs 24h to ripen. The inference below is kept for ledgers
  // that have not been reconciled yet (an old ledger opened read-only, or a
  // fleet abandoned since the last startup sweep); the two sets are disjoint,
  // one matching `status === 'abandoned'` and the other `status === 'running'`.
  let abandonedFleets = fleets.filter((f) => f.status === 'abandoned').length
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
  // An unreadable event log degrades health rather than passing as healthy. It is
  // not `error` — the SQLite ledger is the authoritative store and still works —
  // but a caller cannot verify what was emitted while it is unreadable, and this
  // surface exists to say so. Recording the sentinel without letting it decide
  // anything would leave `status: 'ok'` over a log nobody can read.
  const hasUnreadableEventLog = eventsBytes < 0
  // An identity mismatch is DEGRADED, not ERROR. The ledger is fine, the operator
  // is wrong, and an error here would block tool dispatch over a configuration
  // mistake that is repairable by clearing the env var. The whole point of the
  // identity surface is to be loud WITHOUT being fatal — the data is still good.
  const hasIdentityMismatch = ledgerIdentityMismatch

  let status: 'ok' | 'degraded' | 'error' = 'ok'
  if (hasCorruptLedger) status = 'error'
  else if (hasStuckFleet || hasUnreadableEventLog || hasIdentityMismatch) status = 'degraded'

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
    ledger_path: ledgerPath,
    ledger_instance_id: ledgerInstanceId,
    ledger_scope: ledgerScope,
    ledger_identity_mismatch: ledgerIdentityMismatch,
    expected_ledger_id: hasExpectation ? expectedLedgerId : undefined,
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
    // An UNREADABLE event log is not an EMPTY one. This catch used to leave the
    // initialized zeros in place, so `get_health` reported `events: 0` for a log
    // that was corrupt or permission-denied — indistinguishable from a healthy
    // fresh install, on the one surface an operator consults to find out whether
    // anything is wrong. Mirrors the sentinel the ledger branch above already
    // uses (`ledgerBytes = -1`), so a reader can tell "cannot read" from "none".
    out.eventsBytes = -1
    out.eventCount = -1
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