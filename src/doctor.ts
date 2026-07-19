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

import { accessSync, constants, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { resolveDbFile, readLedger } from './db.js'
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
  read: () => MeshData = readLedger
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

// --- report ------------------------------------------------------------------

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

export function doctorExitCode(report: DoctorReport): 0 | 1 {
  return report.checks.some((c) => c.status === 'fail') ? 1 : 0
}

const ICONS: Record<DoctorStatus, string> = { ok: '✔', warn: '⚠', fail: '✖' }

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ['agent-mesh doctor — install health', '']
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

/** CLI entry — called from the `agent-mesh doctor` dispatch in bin/inspect. */
export function doctorMain(args: string[]): void {
  const report = runDoctor()
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    process.stdout.write(formatDoctorReport(report) + '\n')
  }
  process.exit(doctorExitCode(report))
}
