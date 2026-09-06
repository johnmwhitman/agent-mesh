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
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadData, resolveEventLogFile } from './core.js'
import { resolveDbFile } from './db.js'
import { workReceiptCount } from './work-receipt.js'

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
   * Total rows in the `work_receipts` collection. Reads via the live shared
   * handle so the count is consistent with `record_work_receipt` /
   * `get_work_receipt` rather than with a stale audit snapshot. 0 on
   * pre-v5 ledgers (the table is purely additive and backfill-free).
   */
  work_receipt_count: number
  /**
   * The build-identity surface for the ratified three-copy promotion
   * contract (Kanban receipt dogfood design §5). Mirrors the runtime's own
   * `dist/meshfleet-build-manifest.json` so a caller can compare it against
   * the installed copy and the repo manifest. `null` when the manifest is
   * absent (the running build predates the schema); `status` distinguishes
   * the three failure modes so a downstream probe can act without parsing
   * the whole object.
   */
  build_identity: BuildIdentityReport
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
}

/**
 * Build-identity surface — exactly the shape of `meshfleet-build-manifest.json`
 * (v1) carried on the health response. The whole file is read once per call
 * (no caching) so a caller sees the latest on-disk manifest immediately after
 * a deploy, and a manifest read failure is reported as `status='unreadable'`
 * rather than as `'ok'` with a missing field.
 *
 * `entrypoints_match_runtime` is a derived flag: when the manifest is loaded
 * AND the same `dist/` files hash to the same bytes on disk at the time of
 * the call. A stale install (e.g. tarball unpacked but dist/ left from a
 * prior build) shows up as `false` without needing an out-of-band check.
 */
export interface BuildIdentityReport {
  status: 'ok' | 'absent' | 'unreadable' | 'mismatch'
  /** Schema marker from the loaded manifest. 'unknown' when not loaded. */
  schema?: string
  /** Package name from the loaded manifest. */
  package_name?: string
  /** Package version from the loaded manifest. */
  package_version?: string
  /** Git SHA from the loaded manifest, or null when the build lacked git. */
  source_commit?: string | null
  /** Why `source_commit` is null (e.g. 'git not available'). */
  commit_reason?: string | null
  /** Number of entrypoints listed in the manifest. */
  entrypoint_count?: number
  /** Map of relative path -> SHA-256. */
  entrypoints?: Record<string, string>
  /**
   * True when the loaded manifest's hashes match the on-disk bytes of the
   * same `dist/` files at the time of this call. False on mismatch; `null`
   * when the manifest itself failed to load.
   */
  entrypoints_match_runtime?: boolean | null
  /** Absolute path the manifest was loaded from. */
  manifest_path?: string
}

const BUILD_MANIFEST_FILENAME = 'meshfleet-build-manifest.json'
const DIST_DIR_NAME = 'dist'
/**
 * A loose semver grammar: 1-3 numeric segments separated by dots, optionally
 * followed by `-prerelease` and/or `+build`. Catches `0.21.1`, `1.2.3-rc.4+abc`,
 * rejects empty strings, plain words, and the `null`/missing-package.version
 * case the previous code accepted silently.
 */
const SEMVER_LIKE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.\-]+)*$/

/** Resolve the `dist/` directory this process was loaded from. */
export function resolveRuntimeDistDir(): string | null {
  // import.meta.url is `file://…/dist/health.js` (after build) or
  // `file://…/src/health.ts` (tsx dev). Either way, `dist/` (or `src/`)
  // sits next to it. We resolve the directory of the running file and look
  // for the manifest in that directory; in production builds, that directory
  // IS `dist/`.
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const candidate = join(here, BUILD_MANIFEST_FILENAME)
    if (existsSync(candidate)) return here
    // src/ fallback for `tsx`-driven development — health.ts lives next to
    // its source dist/ if invoked from there. Production builds always hit
    // the first branch.
    return null
  } catch {
    return null
  }
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

  // A build-identity mismatch (missing package metadata, wrong package name,
  // byte mismatch, unsafe entrypoint path, missing required runtime
  // entrypoint, malformed source_commit) is a HARD failure. The previous
  // code returned `status: 'ok'` while `entrypoints_match_runtime: false`,
  // making `status` unreliable as the promotion gate. The mismatch status
  // is now surfaced to `status: 'error'` here so a caller that only reads
  // `status` cannot mistake a broken install for a healthy one.
  const buildIdentity = readBuildIdentity()
  const hasBuildIdentityMismatch = buildIdentity.status === 'mismatch'

  let status: 'ok' | 'degraded' | 'error' = 'ok'
  if (hasCorruptLedger || hasBuildIdentityMismatch) status = 'error'
  else if (hasStuckFleet || hasUnreadableEventLog) status = 'degraded'

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
    work_receipt_count: readWorkReceiptCount(),
    build_identity: buildIdentity,
  }
}

/**
 * Work-receipt row count, wrapped so the live-handle read stays inside the
 * try/catch around `getHealth`'s I/O (a corrupted ledger cannot turn a
 * health check into an exception).
 */
function readWorkReceiptCount(): number {
  try {
    return workReceiptCount()
  } catch {
    return 0
  }
}

/**
 * Load `dist/meshfleet-build-manifest.json` next to the running module and
 * return the surface. Three outcomes: `ok` (loaded, hashes recomputed against
 * disk), `unreadable` (file present but bytes are not valid JSON or the
 * schema is unknown), `absent` (file not next to the module — pre-feature
  runtime, or `tsx` dev).
 *
 * The runtime-vs-installed match check is intentionally cheap (one stat + one
 * hash per listed entrypoint) and unguarded; a one-off mismatch is what the
 * drift probe looks for, not a once-per-day event.
 */
export function readBuildIdentity(): BuildIdentityReport {
  const distDir = resolveRuntimeDistDir()
  if (!distDir) {
    return { status: 'absent' }
  }
  return readBuildIdentityFromDir(distDir)
}

/**
 * Read `meshfleet-build-manifest.json` from the supplied directory and
 * validate every field the promotion gate depends on. Extracted from
 * readBuildIdentity so tests can plant malformed manifests in a temp
 * directory and exercise the real promotion-gate logic without module
 * URL redirection. Production callers go through readBuildIdentity, which
 * resolves the directory from `import.meta.url` (no env seam).
 */
export function readBuildIdentityFromDir(distDir: string): BuildIdentityReport {
  const manifestPath = join(distDir, BUILD_MANIFEST_FILENAME)
  let parsed: unknown
  try {
    const raw = readFileSync(manifestPath, 'utf-8')
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'unreadable', manifest_path: manifestPath }
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as { schema?: unknown }).schema !== 'meshfleet.build/v1'
  ) {
    return { status: 'unreadable', manifest_path: manifestPath }
  }
  const m = parsed as {
    package?: { name?: string; version?: string }
    source_commit?: string | null
    commit_reason?: string | null
    entrypoints?: Record<string, string>
  }
  if (
    typeof m.entrypoints !== 'object' ||
    m.entrypoints === null ||
    Array.isArray(m.entrypoints)
  ) {
    return { status: 'unreadable', manifest_path: manifestPath }
  }
  // The entrypoint map is the canonical SHA-256 -> path table; an empty map is
  // a manifest that built nothing, which we treat as unreadable so a
  // degraded build never claims 'ok'.
  const entrypoints = m.entrypoints
  if (Object.keys(entrypoints).length === 0) {
    return { status: 'unreadable', manifest_path: manifestPath }
  }
  // Fail-closed checks: when the manifest loads cleanly the fields the
  // promotion gate relies on MUST be present and well-formed. The previous
  // code returned `status: 'ok'` regardless of missing package metadata,
  // which meant a manifest with package.version=null still passed the
  // promotion gate — a version-byte mismatch was reachable from a clean
  // manifest read.
  const packageName = typeof m.package?.name === 'string' ? m.package.name.trim() : ''
  const packageVersion = typeof m.package?.version === 'string' ? m.package.version.trim() : ''
  if (packageName !== 'meshfleet' || !SEMVER_LIKE.test(packageVersion)) {
    return { status: 'mismatch', manifest_path: manifestPath }
  }
  // Source commit, when present, must be a 40-char hex SHA. `null` is only
  // permitted when accompanied by a non-empty commit_reason that names the
  // documented cause ("git not available", a non-SHA ref, etc.). A null
  // source_commit with NO reason (the previous code's silent-accept case)
  // is the malformed scenario — a missing required field rather than a
  // documented outcome. Registry-installed packages still pass: their
  // manifest generator writes both `source_commit: null` AND a reason.
  if (m.source_commit !== null && m.source_commit !== undefined) {
    if (typeof m.source_commit !== "string" || !/^[0-9a-f]{40}$/.test(m.source_commit)) {
      return { status: 'mismatch', manifest_path: manifestPath }
    }
  } else if (
    typeof m.commit_reason !== "string" ||
    m.commit_reason.trim() === ""
  ) {
    return { status: 'mismatch', manifest_path: manifestPath }
  }
  // Unsafe paths — reject any entrypoint whose relative path escapes the
  // manifest's distDir, contains null bytes, or is not a plain .js file.
  // The hash map is a publisher <-> runtime contract; a path the runtime
  // cannot resolve is a hole the promotion gate exists to surface.
  const safeEntrypoints: Record<string, string> = {}
  for (const [rel, expected] of Object.entries(entrypoints)) {
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
      return { status: 'mismatch', manifest_path: manifestPath }
    }
    if (
      rel.includes('\u0000') ||
      rel.includes('\\') ||
      rel.startsWith('/') ||
      rel.split('/').some((segment) => segment === '..' || segment === '.') ||
      !rel.endsWith('.js')
    ) {
      return { status: 'mismatch', manifest_path: manifestPath }
    }
    safeEntrypoints[rel] = expected
  }
  // Required runtime entrypoints. The package's main export maps to
  // dist/index.js; the `meshfleet` bin maps to dist/bin/meshfleet.js. A
  // manifest that lists neither is not the published runtime, regardless
  // of what else is present.
  const REQUIRED_RUNTIME_ENTRYPOINTS = ['index.js', 'bin/meshfleet.js'] as const
  for (const required of REQUIRED_RUNTIME_ENTRYPOINTS) {
    if (!Object.prototype.hasOwnProperty.call(safeEntrypoints, required)) {
      return { status: 'mismatch', manifest_path: manifestPath }
    }
  }
  let match = true
  for (const [rel, expected] of Object.entries(safeEntrypoints)) {
    try {
      const bytes = readFileSync(join(distDir, rel))
      const got = createHash('sha256').update(bytes).digest('hex')
      if (got !== expected) {
        match = false
        break
      }
    } catch {
      match = false
      break
    }
  }
  // Fail closed on byte mismatch — the previous code returned `status: 'ok'`
  // with `entrypoints_match_runtime: false` and let the caller treat the
  // mismatch as a warning. Promotion gating that ever reads `status` cannot
  // trust it under that contract, so the only fix is to make mismatch
  // visible at the status field too.
  return {
    status: match ? 'ok' : 'mismatch',
    schema: 'meshfleet.build/v1',
    package_name: packageName,
    package_version: packageVersion,
    source_commit: m.source_commit ?? null,
    commit_reason: m.commit_reason ?? null,
    entrypoint_count: Object.keys(safeEntrypoints).length,
    entrypoints: safeEntrypoints,
    entrypoints_match_runtime: match,
    manifest_path: manifestPath,
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