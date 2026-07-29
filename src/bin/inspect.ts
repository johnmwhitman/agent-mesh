#!/usr/bin/env node
/**
 * agent-mesh inspect — CLI inspector for running fleets.
 *
 * Usage:
 *   npx agent-mesh inspect                    # show all fleets (default)
 *   npx agent-mesh inspect <fleet_id>         # show one fleet + its agents
 *   npx agent-mesh inspect --metrics          # fleet summary metrics
 *   npx agent-mesh inspect --events [n]      # recent events (default 20)
 *   npx agent-mesh inspect --export [file]   # dump the full ledger as JSON
 *   npx agent-mesh inspect --verify [file]   # audit ledger integrity (exit 1 on errors)
 *   npx agent-mesh inspect --verify-v2 [file] # opt-in versioned verifier envelope (exit 1 on errors)
 *   npx agent-mesh inspect --verify-v3 [file] # opt-in local consistency bands (exit 1 on errors)
 *   npx agent-mesh inspect --explain         # explain each --verify finding (implies --verify)
 *   npx agent-mesh inspect --json            # JSON output for fleets / --councils / --verify
 *   npx agent-mesh inspect --help             # usage
 *
 * Reads the same SQLite ledger as the MCP server (via the withLedger seam).
 */

import { existsSync, writeFileSync } from 'node:fs'
import {
  formatAgentRow,
  buildTimeline,
  buildTimelineJson,
  buildTimelineWindowJson,
  filterTimelineWindow,
  formatEventLog,
  formatFleetSummary,
  getFleetMetrics,
  formatReceiptTrail,
  formatTimeline,
  formatTimelineWindow,
  formatCouncil,
  formatVerifyReport,
  formatLiveMessage,
  dedupeFollowRows,
  buildCouncilsJson,
  buildFleetsJson,
  buildVerifyJson,
  buildVerifyV2Json,
  buildVerifyV3Json,
  formatVerifyV2Report,
  formatVerifyV3Report,
  INSPECT_JSON_SCHEMA,
  PROVISIONAL_NOTE,
  type AgentRow,
} from '../inspector.js'
import { buildLifecycleView, formatLifecycleView, readLifecycleSnapshot } from '../lifecycle-visibility.js'
import { listFleets, loadData, readEventLog, getReceipts, CURRENT_SCHEMA_VERSION, type Agent, type Message } from '../core.js'
import { resolveDbFile, closeFollowDb, maxMessageRowid, pollMessagesSince, type MessageRow } from '../db.js'
import { verifyLedger, verifyLedgerFile } from '../verify.js'
import { runDemo } from '../demo.js'

const USAGE = `agent-mesh inspect — CLI inspector for running fleets

  Usage:
  npx agent-mesh inspect                    Show all fleets
  npx agent-mesh inspect <fleet_id>         Show one fleet and its agents
  npx agent-mesh inspect --metrics          Show summary metrics
  npx agent-mesh inspect --events [n]      Show recent events (default 20)
  npx agent-mesh inspect --receipts [fleet] Show message receipts (who saw / acked)
  npx agent-mesh inspect --councils [fleet] Show councils (tally vs quorum, who voted)
  npx agent-mesh inspect timeline [fleet] [--from bound] [--to bound]  Reconstruct an optional half-open incident window
  npx agent-mesh inspect --follow|-f [--fleet id]  Live-tail new P2P messages (ctrl-c to stop)
  npx agent-mesh inspect --export [file]    Dump the full ledger as JSON (stdout if no file)
  npx agent-mesh inspect --verify [file]    Audit ledger integrity (exit 1 on errors); [file] audits that ledger file read-only
  npx agent-mesh inspect --verify-v2 [file] Opt-in versioned verifier envelope (exit 1 on errors); [file] audits that ledger file read-only
  npx agent-mesh inspect --verify-v3 [file] Opt-in severity-derived local consistency bands (exit 1 on errors); [file] audits that ledger file read-only
  npx agent-mesh inspect --lifecycle [fleet] Show opt-in SQLite lifecycle diagnostics (--json supported)
  npx agent-mesh inspect --explain          Explain each --verify finding: meaning, benign cause, how to investigate (implies --verify)
  npx agent-mesh inspect --json             Machine-readable output for all inspect data modes
  npx agent-mesh doctor                     Diagnose install health (--json for machine output)
  npx agent-mesh inspect --help             This help
  npx agent-mesh demo                       60-second walkthrough on a temp ledger, ends with a real --verify
`

function main(): void {
  // The bin is invoked both as `agent-mesh <cmd>` and `agent-mesh inspect <flags>`
  // (every documented inspect form carries the literal token) — strip it so a
  // positional ledger-file argument can never swallow the subcommand name.
  const argv = process.argv.slice(2)
  if (argv[0] === 'inspect') argv.shift()

  // Subcommand dispatch (kept as ONE block at the top so parallel lanes merge cleanly).
  if (argv[0] === 'demo') {
    try {
      const result = runDemo()
      process.exitCode = result.report.ok ? 0 : 1
      return
    } catch (err) {
      process.stderr.write(`demo failed: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }
  }

  const args = argv
  const jsonMode = args.includes('--json')
  const explain = args.includes('--explain')

  if (args[0] === 'doctor') {
    // Lazy import keeps this dispatch a single merge-clean block (no top-of-file
    // import hunk to conflict with parallel lanes touching this file).
    void import('../doctor.js').then((d) => d.doctorMain(args.slice(1)))
    return
  }

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE)
    process.exit(0)
  }

  if (args[0] === 'timeline') {
    let timelineArgs: ParsedTimelineArgs
    try {
      timelineArgs = parseTimelineArgs(args.slice(1))
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(2)
    }
    if (!timelineArgs.bounded) {
      printTimeline(timelineArgs.fleetId, timelineArgs.json)
      return
    }
    printTimelineWindow(timelineArgs)
    return
  }

  const verifyV1 = args.includes('--verify')
  const verifyV2 = args.includes('--verify-v2')
  const verifyV3 = args.includes('--verify-v3')
  const verifierFlags = [verifyV1 ? '--verify' : undefined, verifyV2 ? '--verify-v2' : undefined, verifyV3 ? '--verify-v3' : undefined].filter((flag): flag is string => flag !== undefined)
  if (verifierFlags.length > 1) {
    process.stderr.write(`${verifierFlags.join(' and ')} cannot be used together\n`)
    process.exit(2)
  }

  if (args.includes('--lifecycle')) {
    const positionalLifecycle = args.filter((arg) => !arg.startsWith('-'))
    const allowed = new Set(['--lifecycle', '--json'])
    if (args.some((arg) => arg.startsWith('-') && !allowed.has(arg)) || positionalLifecycle.length > 1) {
      process.stderr.write('--lifecycle accepts only an optional fleet id and --json\n')
      process.exit(2)
    }
    try {
      const view = buildLifecycleView(readLifecycleSnapshot(), positionalLifecycle[0])
      process.stdout.write(jsonMode ? JSON.stringify({ schema: view.schema, kind: view.kind, data: view.data }, null, 2) + '\n' : formatLifecycleView(view) + '\n')
      process.exitCode = view.missingFleet || view.exitError ? 1 : 0
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(2)
    }
    return
  }

  if (args.includes('--follow') || args.includes('-f')) {
    runFollow(args)
    return
  }

  if (args.includes('--metrics')) {
    printMetrics(jsonMode)
    return
  }

  if (args.includes('--events')) {
    const limitArg = args[args.indexOf('--events') + 1]
    const limit = limitArg ? parseInt(limitArg, 10) || 20 : 20
    printEvents(limit, jsonMode)
    return
  }

  if (args.includes('--export')) {
    const outArg = args[args.indexOf('--export') + 1]
    exportLedger(outArg && !outArg.startsWith('-') ? outArg : undefined)
    return
  }

  const positional = args.filter((a) => !a.startsWith('-'))

  if (verifyV2) {
    const file = positional[0]
    let report
    try {
      // v2 never calls verifyLedger(): that legacy fresh-install fallback can
      // initialize an absent configured ledger. This is always a dedicated
      // read-only file audit, including the configured path when no file is given.
      report = verifyLedgerFile(file ?? resolveDbFile())
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(2)
    }
    const envelope = buildVerifyV2Json(report)
    process.stdout.write(
      jsonMode
        ? JSON.stringify(envelope, null, 2) + '\n'
        : formatVerifyV2Report(envelope, { explain }) + '\n'
    )
    process.exitCode = report.ok ? 0 : 1
    return
  }

  if (verifyV3) {
    const file = positional[0]
    let report
    try {
      // Like v2, v3 always uses the dedicated read-only file snapshot and
      // never calls the legacy fresh-install verification path.
      report = verifyLedgerFile(file ?? resolveDbFile())
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(2)
    }
    const envelope = buildVerifyV3Json(report)
    process.stdout.write(
      jsonMode
        ? JSON.stringify(envelope, null, 2) + '\n'
        : formatVerifyV3Report(envelope, { explain }) + '\n'
    )
    process.exitCode = report.ok ? 0 : 1
    return
  }

  // --explain implies --verify. A positional path audits THAT ledger file
  // (zero-install: point it at a backup or an export from another machine).
  if (verifyV1 || explain) {
    const file = positional[0]
    if (file !== undefined && !existsSync(file)) {
      process.stderr.write(`Ledger file not found: ${file}\n`)
      process.exit(2)
    }
    let report
    try {
      report = file !== undefined ? verifyLedgerFile(file) : verifyLedger()
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(2)
    }
    process.stdout.write(
      jsonMode
        ? JSON.stringify(buildVerifyJson(report, { explain }), null, 2) + '\n'
        : formatVerifyReport(report, { explain }) + '\n'
    )
    // exitCode (not exit()): pipe writes flush asynchronously; a hard exit can
    // truncate large JSON mid-stream.
    process.exitCode = report.ok ? 0 : 1
    return
  }

  if (args.includes('--receipts')) {
    printReceipts(positional[0], jsonMode)
    return
  }

  if (args.includes('--councils')) {
    printCouncils(positional[0], jsonMode)
    return
  }

  if (positional.length === 0) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify(buildFleetsJson(listFleets()), null, 2) + '\n')
      return
    }
    printAllFleets()
    return
  }

  printOneFleet(positional[0] as string, jsonMode)
}

interface ParsedTimelineArgs {
  fleetId?: string
  fromMs?: number
  toMs?: number
  bounded: boolean
  json: boolean
}

function parseTimelineBound(flag: '--from' | '--to', raw: string): number {
  if (/^\d+$/.test(raw)) {
    const parsed = Number(raw)
    if (Number.isSafeInteger(parsed)) return parsed
    throw new Error(`timeline: invalid ${flag} bound`)
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2}))?$/.exec(raw)
  if (iso === null) {
    throw new Error(`timeline: invalid ${flag} bound`)
  }
  const year = Number(iso[1])
  const month = Number(iso[2])
  const day = Number(iso[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]!) {
    throw new Error(`timeline: invalid ${flag} bound`)
  }
  if (
    iso[4] !== undefined &&
    (Number(iso[4]) > 23 || Number(iso[5]) > 59 || Number(iso[6]) > 59)
  ) {
    throw new Error(`timeline: invalid ${flag} bound`)
  }

  const parsed = Date.parse(raw)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`timeline: invalid ${flag} bound`)
  }
  return parsed
}

function parseTimelineArgs(args: string[]): ParsedTimelineArgs {
  let fleetId: string | undefined
  let fromMs: number | undefined
  let toMs: number | undefined
  let sawFrom = false
  let sawTo = false
  let json = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--json') {
      if (json) throw new Error('timeline: --json may be specified once')
      json = true
      continue
    }

    if (arg === '--from' || arg === '--to') {
      const alreadySeen = arg === '--from' ? sawFrom : sawTo
      if (alreadySeen) throw new Error(`timeline: ${arg} may be specified once`)
      if (arg === '--from') sawFrom = true
      else sawTo = true

      const raw = args[i + 1]
      if (raw === undefined || raw.startsWith('-')) {
        throw new Error(`timeline: ${arg} requires a bound`)
      }
      const parsed = parseTimelineBound(arg, raw)
      if (arg === '--from') fromMs = parsed
      else toMs = parsed
      i += 1
      continue
    }

    if (arg.startsWith('-')) {
      throw new Error(`timeline: unknown option ${arg}`)
    }
    if (fleetId !== undefined) {
      throw new Error('timeline: accepts at most one fleet id')
    }
    fleetId = arg
  }

  if (fromMs !== undefined && toMs !== undefined && fromMs >= toMs) {
    throw new Error('timeline: --from must be < --to')
  }

  return {
    fleetId,
    fromMs,
    toMs,
    bounded: sawFrom || sawTo,
    json,
  }
}

/**
 * Live-tail new P2P messages (`inspect --follow`/`-f`). Read-only forever: the
 * poll loop runs on a DEDICATED `{ readonly: true, fileMustExist: true }`
 * connection (`db.ts`'s follow-only handle) — never the shared `getDb()`
 * writer, which bootstraps schema/meta/WAL on cold open. No daemon beyond
 * this one setInterval, no config file (same MESHFLEET_DB_FILE /
 * resolveDbFile() the rest of `inspect` uses).
 *
 * Cursor is the messages table's implicit SQLite rowid, not a timestamp: two
 * messages inserted in the same millisecond would tie under `timestamp > X`
 * and one would silently never print. rowid is strictly increasing per
 * insert, so it can't tie. `--fleet` filters INSIDE the poll query (SQL WHERE
 * fleet_id = ?), so a message in another fleet can never advance the cursor
 * past a same-tick message in the watched fleet before that one is seen.
 */
function runFollow(args: string[]): void {
  const fleetIdx = args.indexOf('--fleet')
  const fleetId = fleetIdx >= 0 ? args[fleetIdx + 1] : undefined
  if (fleetIdx >= 0 && (!fleetId || fleetId.startsWith('-'))) {
    process.stderr.write('--fleet requires a fleet id\n')
    process.exit(2)
  }

  // A genuinely missing ledger is a hard error here (never invent demo data
  // by silently creating one just because --follow opened a connection) —
  // distinct from an EXISTING, empty ledger, which is the ordinary "watching,
  // no messages yet" idle case below. Every other `inspect` subcommand
  // auto-creates the ledger file on first touch (that's fine for a one-shot
  // report), but a live-tail session watching a file that doesn't exist yet
  // reads as broken, not idle. This is a fast pre-check only — the real
  // enforcement is `pollMessagesSince`/`maxMessageRowid`'s dedicated
  // `fileMustExist: true` connection, which throws (never creates) if the
  // file is deleted in the TOCTOU window between this check and that open.
  const dbFile = resolveDbFile()
  if (!existsSync(dbFile)) {
    process.stderr.write(`Ledger not found: ${dbFile}\n`)
    process.exit(2)
  }

  const intervalMs = 400
  // dedupeFollowRows tracks emitted ids (bounded) so a message that somehow
  // resurfaces at a different rowid is never printed twice. Today's real
  // persistence (db.ts's ON CONFLICT DO UPDATE) preserves rowid across an
  // in-place update, so this can't happen through the normal write path — but
  // it's cheap insurance against any future persistence change, migration, or
  // raw-SQL admin script that reintroduces rowid churn.
  const seenIds = new Set<string>()
  let cursor: number
  try {
    cursor = maxMessageRowid()
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  }

  // Signal handlers go up BEFORE the banner, and the ordering is load-bearing.
  //
  // The banner says "ctrl-c to stop" and is the readiness signal anything
  // watching this process keys off. Registering the handlers afterwards left a
  // window where the banner made that promise while the default SIGTERM/SIGINT
  // disposition would still kill the process outright — no `closeFollowDb()`,
  // exit by signal rather than through the cleanup path.
  //
  // Found by CI, not by reading: the SIGTERM test went red on ubuntu/Node 24
  // with `code: null` on a commit that only touched documentation, which is the
  // signature of a latent race rather than a regression.
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (timer !== undefined) clearInterval(timer)
    closeFollowDb()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  process.stdout.write(
    `ledger: ${dbFile}  · poll ${intervalMs}ms  · ctrl-c to stop\n` +
      `watching… no messages yet  (spawn a fleet or send_message from MCP)\n`
  )

  const tick = (): void => {
    if (stopped) return
    let rows: MessageRow[]
    try {
      rows = pollMessagesSince(cursor, fleetId)
    } catch (err) {
      // A poll-time failure (e.g. the ledger vanished mid-session) must not
      // crash with a raw stack trace — report and stop, same spirit as
      // `agent-mesh dashboard`'s per-tick catch.
      process.stderr.write(`follow: ${err instanceof Error ? err.message : String(err)}\n`)
      stop()
      process.exitCode = 1
      return
    }
    if (rows.length === 0) return
    cursor = rows[rows.length - 1]!.rowid // advance past EVERY returned row, matched or not, parsed or not
    for (const row of dedupeFollowRows(rows, seenIds)) {
      try {
        process.stdout.write(formatLiveMessage(JSON.parse(row.data) as Message) + '\n')
      } catch (err) {
        // One malformed `data` blob must not take down the whole live-tail —
        // skip it, note it, keep watching.
        process.stderr.write(
          `follow: skipping malformed message row (id=${row.id}): ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }
  }

  timer = setInterval(tick, intervalMs)

  tick() // first poll immediately — don't make the caller wait a full interval
}

function printReceipts(fleetId?: string, json = false): void {
  const data = loadData()
  const messages = Object.values(data.messages)
    .filter((m) => !fleetId || m.fleet_id === fleetId)
    .sort((a, b) => a.timestamp - b.timestamp)
  if (json) {
    const items = messages.map((m) => ({ message: m, receipts: getReceipts(m.id) }))
    process.stdout.write(JSON.stringify({ schema: 'meshfleet.receipts/v1', items }, null, 2) + '\n')
    return
  }
  process.stdout.write(PROVISIONAL_NOTE + '\n\n')
  if (messages.length === 0) {
    process.stdout.write(
      fleetId ? `No messages in fleet ${fleetId}.\n` : 'No messages recorded.\n'
    )
    return
  }
  for (const m of messages) {
    process.stdout.write(formatReceiptTrail(m, getReceipts(m.id)) + '\n\n')
  }
}

function printCouncils(fleetId?: string, json = false): void {
  const data = loadData()
  const councils = Object.values(data.ratifications ?? {})
    .filter((r) => !fleetId || r.fleet_id === fleetId)
    .sort((a, b) => a.opened_at - b.opened_at)
  if (json) {
    const items = councils.map((r) => ({ ratification: r, votes: getReceipts(r.message_id) }))
    process.stdout.write(JSON.stringify(buildCouncilsJson(items), null, 2) + '\n')
    return
  }
  process.stdout.write(PROVISIONAL_NOTE + '\n\n')
  if (councils.length === 0) {
    process.stdout.write(
      fleetId ? `No councils in fleet ${fleetId}.\n` : 'No councils opened.\n'
    )
    return
  }
  for (const r of councils) {
    process.stdout.write(formatCouncil(r, getReceipts(r.message_id)) + '\n\n')
  }
}

function printTimeline(fleetId?: string, json = false): void {
  const data = loadData()
  const rows = buildTimeline(data, fleetId ? { fleetId } : {})
  process.stdout.write(json ? JSON.stringify(buildTimelineJson(rows), null, 2) + '\n' : formatTimeline(rows) + '\n')
}

function printTimelineWindow(args: ParsedTimelineArgs): void {
  const data = loadData()
  const rows = buildTimeline(data, args.fleetId ? { fleetId: args.fleetId } : {})
  const selected = filterTimelineWindow(rows, { fromMs: args.fromMs, toMs: args.toMs })
  process.stdout.write(
    args.json
      ? JSON.stringify(
          buildTimelineWindowJson(selected, {
            fromMs: args.fromMs,
            toMs: args.toMs,
            fleetId: args.fleetId,
          }),
          null,
          2,
        ) + '\n'
      : formatTimelineWindow(selected, { fromMs: args.fromMs, toMs: args.toMs }) + '\n',
  )
}

function printAllFleets(): void {
  const fleets = listFleets()
  if (fleets.length === 0) {
    process.stdout.write('No fleets found. Run spawn_fleet from your OpenCode session.\n')
    return
  }

  process.stdout.write(`${fleets.length} fleet${fleets.length === 1 ? '' : 's'}:\n\n`)
  for (const fleet of fleets) {
    process.stdout.write(formatFleetSummary(fleet) + '\n')
  }
  process.stdout.write(
    `\nTip: run \`npx agent-mesh inspect <fleet_id>\` to see agents in a fleet.\n`
  )
}

function printOneFleet(fleetId: string, json = false): void {
  const data = loadData()
  const fleet = data.fleets[fleetId]
  if (!fleet) {
    if (json) {
      process.stdout.write(
        JSON.stringify(
          { schema: INSPECT_JSON_SCHEMA, kind: 'error', error: `Fleet ${fleetId} not found` },
          null,
          2,
        ) + '\n'
      )
    } else {
      process.stderr.write(`Fleet ${fleetId} not found.\n`)
    }
    process.exitCode = 1
    return
  }

  const agents: Agent[] = Object.values(data.agents).filter(
    (a): a is Agent => (a as Agent).fleet_id === fleetId
  )

  if (json) {
    process.stdout.write(
      JSON.stringify({ schema: INSPECT_JSON_SCHEMA, kind: 'fleet', data: { fleet, agents } }, null, 2) + '\n'
    )
    return
  }

  process.stdout.write(`Fleet ${fleetId}\n`)
  process.stdout.write(`Status: ${fleet.status}\n`)
  process.stdout.write(`Created: ${new Date(fleet.created_at).toISOString()}\n`)
  if (fleet.completed_at) {
    process.stdout.write(
      `Completed: ${new Date(fleet.completed_at).toISOString()}\n`
    )
    process.stdout.write(
      `Duration: ${fleet.completed_at - fleet.created_at}ms\n`
    )
  }
  process.stdout.write(`\nAgents (${agents.length}):\n`)

  if (agents.length === 0) {
    process.stdout.write('  (none)\n')
    return
  }

  for (const a of agents) {
    const row: AgentRow = {
      role: a.role,
      status: a.status,
      started_at: a.started_at,
      completed_at: a.completed_at,
      agent_file: a.agent_file,
    }
    process.stdout.write('  ' + formatAgentRow(row) + '\n')
  }
}

function printMetrics(json = false): void {
  const m = getFleetMetrics()
  if (json) {
    process.stdout.write(
      JSON.stringify({ schema: INSPECT_JSON_SCHEMA, kind: 'metrics', data: m }, null, 2) + '\n'
    )
    return
  }
  process.stdout.write('Agent Mesh — Fleet Metrics\n\n')
  process.stdout.write(`Total fleets:       ${m.total_fleets}\n`)
  process.stdout.write(`  completed:        ${m.completed_fleets}\n`)
  process.stdout.write(`  failed:           ${m.failed_fleets}\n`)
  process.stdout.write(`  running:          ${m.running_fleets}\n`)
  process.stdout.write(`  abandoned:        ${m.abandoned_fleets}\n`)
  process.stdout.write(`Total agents:       ${m.total_agents}\n`)
  process.stdout.write(`Total messages:     ${m.total_messages}\n`)
  process.stdout.write(`Total capabilities: ${m.total_capabilities}\n`)
  process.stdout.write(
    `Avg fleet duration: ${m.avg_fleet_duration_ms}ms\n`
  )
  process.stdout.write(`Success rate:       ${(m.success_rate * 100).toFixed(1)}%\n`)
}

function printEvents(limit: number, json = false): void {
  const events = readEventLog(limit)
  if (json) {
    process.stdout.write(
      JSON.stringify({ schema: INSPECT_JSON_SCHEMA, kind: 'events', data: events }, null, 2) + '\n'
    )
    return
  }
  process.stdout.write(formatEventLog(events) + '\n')
}

/** Dump the full ledger as pretty JSON — the "prove it" audit path for a binary store. */
function exportLedger(file?: string): void {
  const json = JSON.stringify({ schema_version: CURRENT_SCHEMA_VERSION, ...loadData() }, null, 2)
  if (file) {
    writeFileSync(file, json + '\n')
    process.stdout.write(`Ledger exported to ${file}\n`)
  } else {
    process.stdout.write(json + '\n')
  }
}

main()
