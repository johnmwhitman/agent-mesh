/**
 * Process-level crash handling for the MCP stdio server.
 *
 * WHY THIS EXISTS: until now there was no `uncaughtException` or
 * `unhandledRejection` handler anywhere in this codebase. A single unhandled
 * rejection — in the ratification sweep, the heartbeat, an SSE handler, any
 * promise chain — took the whole server down. Its spawned agents were left
 * mid-flight, their rows decayed to `interrupted`, and the caller learned
 * nothing until it counted results. The product's first priority is that nobody
 * loses anything silently; a crash that leaves no fingerprint is the purest
 * violation of it available.
 *
 * THE ORDERING IS THE DESIGN. Each step is placed to survive the failure of
 * every step after it:
 *
 *   1. Freeze what we know from memory only — no I/O. The heap may be bad, so
 *      we read what is already resident and nothing else.
 *   2. Append ONE line to a crash journal with a synchronous write. Not SQLite:
 *      a native DB binding is exactly the thing that may have just died, and
 *      this is the minimum durable proof that we died at all.
 *   3. Best-effort ledger mark, wrapped so a throw cannot stop the exit.
 *   4. stderr diagnostic. NEVER stdout — stdout is the MCP transport, and a
 *      non-protocol byte written there corrupts the client's session.
 *   5. Exit deliberately with a distinct code.
 *
 * WHY EXIT RATHER THAN CARRY ON: after an uncaught exception Node's own docs
 * put the process in an undefined state. For most servers "log and continue" is
 * a defensible gamble. Not for this one: a zombie that looks alive keeps
 * emitting heartbeats, keeps answering `get_health`, and can lose another
 * fleet — while reporting that everything is fine. A deliberate exit is worse
 * for uptime and better for the truth, and this product is in the truth
 * business.
 *
 * 🔴 DELIBERATE DEPARTURE FROM THE DESIGN REVIEW — we do NOT kill the children.
 * The review argued for SIGKILLing every spawned agent, on the grounds that
 * survivors finishing unobserved muddies the ledger story. In the incident that
 * motivated this module, five of seven agents survived the crash and DELIVERED
 * THEIR WORK. Killing them would have destroyed five good results to make the
 * record tidier. Losing work loudly is still losing work. If a survivor's
 * output can no longer be captured, that is a reason to record the uncertainty,
 * never a reason to guarantee the loss. Revisit only with evidence that
 * orphans cannot deliver.
 */
import { appendFileSync } from 'node:fs'

/** EX_SOFTWARE. Distinct from 0 (clean), 1 (generic), 143/130 (signals). */
export const CRASH_EXIT_CODE = 70

/** Prefix every crash line carries, so a forensic reader can grep one token. */
export const CRASH_PREFIX = 'meshfleet: CRASH'

export type CrashReason = 'uncaughtException' | 'unhandledRejection'

export interface InFlightAgent {
  agent_id: string
  fleet_id?: string
  pid?: number
}

export interface CrashRecord {
  event: 'server_crash'
  reason: CrashReason
  error_name: string
  error_message: string
  stack: string
  pid: number
  timestamp: number
  /** Agents that were mid-flight. These are the ones at risk of silent loss. */
  in_flight: InFlightAgent[]
}

const STACK_LIMIT = 2048
const MESSAGE_LIMIT = 512

function describe(err: unknown): { name: string; message: string; stack: string } {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: (err.message ?? '').slice(0, MESSAGE_LIMIT),
      stack: (err.stack ?? '').slice(0, STACK_LIMIT),
    }
  }
  // A rejection can carry ANY value — a string, undefined, a plain object.
  // Stringifying must never itself throw inside a crash handler.
  let rendered: string
  try {
    rendered = typeof err === 'string' ? err : JSON.stringify(err) ?? String(err)
  } catch {
    rendered = '(unstringifiable rejection value)'
  }
  return { name: 'NonError', message: rendered.slice(0, MESSAGE_LIMIT), stack: '' }
}

/** Pure: build the record from already-resident data. Does no I/O. */
export function buildCrashRecord(
  reason: CrashReason,
  err: unknown,
  inFlight: readonly InFlightAgent[],
  now: number,
  pid: number
): CrashRecord {
  const { name, message, stack } = describe(err)
  return {
    event: 'server_crash',
    reason,
    error_name: name,
    error_message: message,
    stack,
    pid,
    timestamp: now,
    in_flight: [...inFlight],
  }
}

/**
 * Pure: the stderr diagnostic. One token (`meshfleet: CRASH`) makes a crash
 * greppable and distinguishable from a clean shutdown or a signal.
 */
export function formatCrashStderr(record: CrashRecord, journalPath: string, dbMarked: boolean): string {
  const pids = record.in_flight.map((a) => a.pid).filter((p): p is number => typeof p === 'number')
  return [
    `${CRASH_PREFIX} kind=${record.reason} exit=${CRASH_EXIT_CODE}`,
    `${CRASH_PREFIX} message=${record.error_message.split('\n')[0] || '(none)'}`,
    `${CRASH_PREFIX} agents=${record.in_flight.length} pids=${pids.length ? pids.join(',') : 'none'}`,
    `${CRASH_PREFIX} journal=${journalPath} db_mark=${dbMarked ? 'ok' : 'skipped'}`,
    record.stack ? record.stack : '',
    '',
  ].join('\n')
}

export interface CrashHandlerDeps {
  /** Agents believed mid-flight. Read from memory only. */
  snapshotInFlight: () => InFlightAgent[]
  /** Where the durable one-line fingerprint goes. */
  journalPath: string
  /** Best-effort ledger mark. May throw; the caller swallows it. */
  markOrphaned?: (record: CrashRecord) => void
  writeStderr?: (s: string) => void
  exit?: (code: number) => void
  now?: () => number
}

/**
 * Run the crash path. Exported for tests so the ordering can be asserted
 * without killing a test runner.
 *
 * Every step is individually wrapped: a failure in the journal must not stop
 * the ledger mark, a failure in the ledger mark must not stop the diagnostic,
 * and nothing at all may stop the exit.
 */
export function handleCrash(reason: CrashReason, err: unknown, deps: CrashHandlerDeps): void {
  const now = deps.now ?? Date.now
  const writeStderr = deps.writeStderr ?? ((s: string) => process.stderr.write(s))
  const exit = deps.exit ?? ((code: number) => process.exit(code))

  let inFlight: InFlightAgent[] = []
  try {
    inFlight = deps.snapshotInFlight()
  } catch {
    // A broken snapshot must not cost us the fingerprint.
  }

  const record = buildCrashRecord(reason, err, inFlight, now(), process.pid)

  try {
    appendFileSync(deps.journalPath, JSON.stringify(record) + '\n', { flag: 'a' })
  } catch {
    // Unwritable journal is survivable; stderr still carries the story.
  }

  let dbMarked = false
  try {
    if (deps.markOrphaned) {
      deps.markOrphaned(record)
      dbMarked = true
    }
  } catch {
    // The native DB binding is a prime suspect in any crash. Never retry here.
  }

  try {
    writeStderr(formatCrashStderr(record, deps.journalPath, dbMarked))
  } catch {
    // Even stderr can be gone (closed pipe). Exit anyway.
  }

  exit(CRASH_EXIT_CODE)
}

/**
 * Register the handlers. Idempotent guard included: re-entering the crash path
 * while already handling one must not loop.
 */
export function installCrashHandlers(deps: CrashHandlerDeps): void {
  let handling = false
  const once = (reason: CrashReason) => (err: unknown) => {
    if (handling) return
    handling = true
    handleCrash(reason, err, deps)
  }
  process.on('uncaughtException', once('uncaughtException'))
  process.on('unhandledRejection', once('unhandledRejection'))
}
