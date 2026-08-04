/**
 * agent-mesh doctor — 30-second install diagnosis.
 *
 * Checks the most common silent-death causes for a fresh (or upgraded)
 * meshfleet install: Node floor, the better-sqlite3 native binding, where the
 * ledger will live and whether it can be written, whether an existing ledger
 * opens, the event-log path, and whether an MCP client (opencode) is around.
 *
 * Every check is a pure function returning a DoctorCheck so the diagnosis is
 * unit-testable without spawning the binary; runDoctor() wires them to the
 * real environment. `--json` emits the meshfleet.doctor/v1 report verbatim.
 */

import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDbFile, readLedgerFile } from './db.js'
import { resolveEventLogFile, type MeshData } from './core.js'

export type DoctorStatus = 'ok' | 'warn' | 'fail'

export interface DoctorCheck {
  check: string
  status: DoctorStatus
  detail: string
  fix?: string
}

export interface DoctorReport {
  schema: 'meshfleet.doctor/v1'
  checks: DoctorCheck[]
}

export const SQLITE_REBUILD_FIX = 'npm rebuild better-sqlite3'

// --- helpers -----------------------------------------------------------------

/** Walk up from `p` to the nearest directory that actually exists. */
function nearestExistingDir(p: string): string {
  let dir = p
  while (!existsSync(dir)) {
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dir
}

function isWritable(p: string): boolean {
  try {
    accessSync(p, constants.W_OK)
    return true
  } catch {
    return false
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// --- check 1: Node version ---------------------------------------------------

/** Node >= 20 — the better-sqlite3 floor (and this package's engines field). */
export function checkNodeVersion(version: string = process.version): DoctorCheck {
  const major = parseInt(version.replace(/^v/, ''), 10)
  if (Number.isNaN(major)) {
    return {
      check: 'node-version',
      status: 'warn',
      detail: `could not parse Node version "${version}" — expected >= 20`,
    }
  }
  if (major >= 20) {
    return {
      check: 'node-version',
      status: 'ok',
      detail: `${version} (>= 20 required by better-sqlite3)`,
    }
  }
  return {
    check: 'node-version',
    status: 'fail',
    detail: `${version} is below the Node 20 floor better-sqlite3 requires`,
    fix: 'install Node >= 20 (e.g. `nvm install 20`) and reinstall meshfleet',
  }
}

// --- check 2: better-sqlite3 native binding ----------------------------------

function loadSqliteBinding(): void {
  const req = createRequire(import.meta.url)
  const Database = req('better-sqlite3') as new (file: string) => { close(): void }
  new Database(':memory:').close()
}

/** The #1 silent killer: the native binding fails to load (ABI mismatch or blocked install scripts). */
export function checkSqliteBinding(load: () => void = loadSqliteBinding): DoctorCheck {
  try {
    load()
    return {
      check: 'better-sqlite3',
      status: 'ok',
      detail: 'native binding loads and opens an in-memory database',
    }
  } catch (e) {
    const msg = errMessage(e)
    let diagnosis = 'native binding failed to load'
    if (/NODE_MODULE_VERSION|compiled against a different/i.test(msg)) {
      diagnosis = 'ABI mismatch — the binding was built for a different Node version'
    } else if (/cannot find module/i.test(msg)) {
      diagnosis = 'native binding missing — install scripts were likely blocked or skipped'
    }
    return {
      check: 'better-sqlite3',
      status: 'fail',
      detail: `${diagnosis}: ${msg}`,
      fix: SQLITE_REBUILD_FIX,
    }
  }
}

// --- check 3: ledger path resolution -----------------------------------------

/** Where the SQLite ledger will live, and whether that directory is writable. */
export function checkLedgerPath(dbFile: string = resolveDbFile()): DoctorCheck {
  const dir = dirname(dbFile)
  if (existsSync(dir)) {
    if (isWritable(dir)) {
      return {
        check: 'ledger-path',
        status: 'ok',
        detail: `ledger lives at ${dbFile} (directory exists, writable)`,
      }
    }
    return {
      check: 'ledger-path',
      status: 'fail',
      detail: `ledger directory ${dir} is not writable`,
      fix: `fix permissions on ${dir} (e.g. \`chmod u+w ${dir}\`)`,
    }
  }
  const ancestor = nearestExistingDir(dir)
  if (isWritable(ancestor)) {
    return {
      check: 'ledger-path',
      status: 'ok',
      detail: `ledger lives at ${dbFile} (directory missing — created on first run)`,
    }
  }
  return {
    check: 'ledger-path',
    status: 'fail',
    detail: `cannot create ledger directory ${dir}: nearest existing ancestor ${ancestor} is not writable`,
    fix: `fix permissions on ${ancestor}, or point MESHFLEET_DB_FILE at a writable location`,
  }
}

// --- check 4: ledger openability ---------------------------------------------

/** If a ledger exists, open it and report entity counts; absence is a normal fresh install. */
export function checkLedgerOpen(
  dbFile: string = resolveDbFile(),
  // READ-ONLY by default: the doctor must never create, convert, or write the
  // ledger it is diagnosing (readLedgerFile opens {readonly, fileMustExist}).
  read: () => MeshData = () => readLedgerFile(dbFile)
): DoctorCheck {
  if (!existsSync(dbFile)) {
    return {
      check: 'ledger-open',
      status: 'ok',
      detail: 'fresh install — no ledger yet (normal)',
    }
  }
  try {
    const data = read()
    const n = (dict: Record<string, unknown> | undefined): number =>
      Object.keys(dict ?? {}).length
    return {
      check: 'ledger-open',
      status: 'ok',
      detail: `ledger opens: ${n(data.fleets)} fleets, ${n(data.agents)} agents, ${n(
        data.messages
      )} messages, ${n(data.receipts)} receipts`,
    }
  } catch (e) {
    return {
      check: 'ledger-open',
      status: 'fail',
      detail: `ledger at ${dbFile} exists but cannot be read: ${errMessage(e)}`,
      fix: `run \`npx agent-mesh inspect --verify\`; if corrupt, move ${dbFile} aside and restart`,
    }
  }
}

// --- check 5: event-log writability ------------------------------------------

/** The NDJSON event log must be appendable (silent event loss otherwise). */
export function checkEventLog(logFile: string = resolveEventLogFile()): DoctorCheck {
  if (existsSync(logFile)) {
    if (isWritable(logFile)) {
      return {
        check: 'event-log',
        status: 'ok',
        detail: `event log at ${logFile} (writable)`,
      }
    }
    return {
      check: 'event-log',
      status: 'fail',
      detail: `event log ${logFile} exists but is not writable`,
      fix: `fix permissions on ${logFile}`,
    }
  }
  const ancestor = nearestExistingDir(dirname(logFile))
  if (isWritable(ancestor)) {
    return {
      check: 'event-log',
      status: 'ok',
      detail: `event log lives at ${logFile} (created on first event)`,
    }
  }
  return {
    check: 'event-log',
    status: 'fail',
    detail: `cannot create event log ${logFile}: ${ancestor} is not writable`,
    fix: `fix permissions on ${ancestor}`,
  }
}

// --- check 6: MCP client hint ------------------------------------------------

/** Warn-not-fail: meshfleet is an MCP server — is the usual client even here? */
export function checkOpencodeClient(
  pathEnv: string = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync
): DoctorCheck {
  const delim = platform === 'win32' ? ';' : ':'
  const exts = platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  for (const dir of pathEnv.split(delim).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, 'opencode' + ext)
      if (exists(candidate)) {
        return {
          check: 'opencode-client',
          status: 'ok',
          detail: `opencode found at ${candidate}`,
        }
      }
    }
  }
  return {
    check: 'opencode-client',
    status: 'warn',
    detail: 'opencode not found on PATH — fine if another MCP client hosts meshfleet',
    fix: 'see the README "Install in 30 seconds" section for the opencode.jsonc MCP config',
  }
}

// --- MCP handshake -----------------------------------------------------------

/**
 * The environment a handshake probe runs in.
 *
 * Two things must be true. The probe must not touch the live ledger — on
 * 2026-08-03 a demo harness spawned the real server without redirecting the db
 * path and wrote a synthetic fleet into the shared ledger; a diagnostic that
 * can corrupt the thing it diagnoses is worse than no diagnostic. And the probe
 * must not race the running server for the SSE port, which is what the server's
 * own child-mode switch already suppresses.
 *
 * Both the current and the legacy env names are redirected, because the server
 * resolves either one.
 */
export function handshakeEnv(
  base: NodeJS.ProcessEnv,
  probeDir: string
): NodeJS.ProcessEnv {
  return {
    ...base,
    MESHFLEET_DB_FILE: join(probeDir, 'probe.db'),
    MESHFLEET_EVENT_LOG_FILE: join(probeDir, 'probe-events.jsonl'),
    AGENT_MESH_EVENT_LOG_FILE: join(probeDir, 'probe-events.jsonl'),
    AGENT_MESH_CHILD: '1',
    // The probe IS the human CLI asking the server to speak; never let the
    // front-door dispatch reinterpret the spawn.
    MESHFLEET_MCP: '1',
  }
}

/** Where the server entry lives relative to this module (dist/ at runtime). */
export function defaultServerEntry(): string {
  return fileURLToPath(new URL('./index.js', import.meta.url))
}

/**
 * Speak MCP `initialize` to a freshly spawned server and require an answer.
 *
 * This is the check the other six could not make: every one of them can pass
 * while the server boots, says nothing and hangs on stdin — which was exactly
 * what `npx meshfleet doctor` did before this slice existed. A hang must read
 * as a failure, so the probe owns a timeout and kills its child.
 */
export async function checkMcpHandshake(
  opts: { entry?: string; timeoutMs?: number } = {}
): Promise<DoctorCheck> {
  const entry = opts.entry ?? defaultServerEntry()
  const timeoutMs = opts.timeoutMs ?? 10_000

  if (!existsSync(entry)) {
    return {
      check: 'mcp-handshake',
      status: 'warn',
      detail: `server entry not found at ${entry} — nothing to probe`,
      fix: 'npm run build (or reinstall the package)',
    }
  }

  const probeDir = mkdtempSync(join(tmpdir(), 'meshfleet-doctor-'))
  const child = spawn(process.execPath, [entry], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: handshakeEnv(process.env, probeDir),
  })

  try {
    const serverName = await new Promise<string | null>((resolve) => {
      let buf = ''
      let settled = false
      const finish = (v: string | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      }
      const timer = setTimeout(() => finish(null), timeoutMs)

      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString('utf8')
        let nl: number
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          try {
            const msg = JSON.parse(line) as {
              id?: unknown
              result?: { serverInfo?: { name?: string; version?: string } }
            }
            if (msg.id === 1 && msg.result) {
              const info = msg.result.serverInfo
              finish(info?.name ? `${info.name} ${info.version ?? ''}`.trim() : 'server')
              return
            }
          } catch {
            // Not JSON-RPC — a banner or a warning line. Keep reading.
          }
        }
      })
      child.on('error', () => finish(null))
      child.on('exit', () => finish(null))

      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'meshfleet-doctor', version: '1' },
          },
        }) + '\n'
      )
    })

    if (serverName === null) {
      return {
        check: 'mcp-handshake',
        status: 'fail',
        detail:
          'no MCP initialize response — the server starts but never speaks. ' +
          'An MCP client would hang here with no error.',
        fix: `run it directly and read stderr: MESHFLEET_MCP=1 node ${entry}`,
      }
    }
    return {
      check: 'mcp-handshake',
      status: 'ok',
      detail: `initialize answered by ${serverName}`,
    }
  } finally {
    child.kill('SIGKILL')
    try {
      rmSync(probeDir, { recursive: true, force: true })
    } catch {
      // A leftover temp dir is not worth failing a diagnostic over.
    }
  }
}

// --- report ------------------------------------------------------------------

/** The synchronous checks. Kept separate so callers can skip the spawn. */
export function runDoctor(): DoctorReport {
  return {
    schema: 'meshfleet.doctor/v1',
    checks: [
      checkNodeVersion(),
      checkSqliteBinding(),
      checkLedgerPath(),
      checkLedgerOpen(),
      checkEventLog(),
      checkOpencodeClient(),
    ],
  }
}

/** The full diagnosis, including the spawned handshake probe. */
export async function runDoctorFull(
  opts: { entry?: string; timeoutMs?: number } = {}
): Promise<DoctorReport> {
  const report = runDoctor()
  return { ...report, checks: [...report.checks, await checkMcpHandshake(opts)] }
}

export function doctorExitCode(report: DoctorReport): 0 | 1 {
  return report.checks.some((c) => c.status === 'fail') ? 1 : 0
}

const ICONS: Record<DoctorStatus, string> = { ok: '✔', warn: '⚠', fail: '✖' }

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ['meshfleet doctor — install health', '']
  const pad = Math.max(...report.checks.map((c) => c.check.length)) + 2
  for (const c of report.checks) {
    lines.push(` ${ICONS[c.status]} ${c.check.padEnd(pad)}${c.detail}`)
    if (c.fix) lines.push(`   ${''.padEnd(pad)}fix: ${c.fix}`)
  }
  const count = (s: DoctorStatus): number =>
    report.checks.filter((c) => c.status === s).length
  lines.push('')
  lines.push(
    `${count('ok')} ok, ${count('warn')} warn, ${count('fail')} fail — ${
      doctorExitCode(report) === 0 ? 'healthy' : 'NOT healthy'
    }`
  )
  return lines.join('\n')
}

/** CLI entry — called from the `meshfleet doctor` and `agent-mesh doctor` dispatches. */
export async function doctorMain(args: string[]): Promise<void> {
  const report = args.includes('--no-spawn') ? runDoctor() : await runDoctorFull()
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    process.stdout.write(formatDoctorReport(report) + '\n')
  }
  process.exitCode = doctorExitCode(report) // never exit() after async-flushed writes
}
