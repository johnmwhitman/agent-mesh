/**
 * Make a failing background sweep audible without making it deafening.
 *
 * THE DEFECT (found 2026-08-05): the ratification deadline sweep ran every 60s
 * inside `try { … } catch { /* sweep must never take the server down *\/ }` —
 * a comment and nothing else. No log, no event, no counter. So a permanently
 * failing sweep meant ratifications stopped resolving and votes stopped being
 * tallied, forever, with no signal anywhere. This repo's first law names that
 * exact betrayal: "Nobody loses anything silently — a message, a receipt, a
 * VOTE… a loud failure is a bug, a silent one is a betrayal of the claim."
 *
 * It was also invisible from the other direction: because the exception was
 * caught, it never reached the process-level crash handler either.
 *
 * WHY A REPORTER AND NOT JUST A `console.error`: the obvious fix logs on every
 * tick. A sweep that fails permanently then emits a line every 60 seconds
 * forever — 1,440 identical lines a day — and an operator learns to filter it,
 * which reproduces the original silence through a different mechanism. So:
 *
 *   - the FIRST failure is loud, immediately
 *   - identical repeats are counted, not printed
 *   - a CHANGED error is loud again (it is new information)
 *   - every Nth repeat re-surfaces with the running count, so a long outage
 *     cannot scroll out of history entirely
 *   - RECOVERY is announced, because "it started working again" is exactly the
 *     fact a reader needs to size the damage window
 *
 * The intent of the original catch was right — a broken sweep must not take the
 * server down. That is preserved exactly. Only the silence is removed.
 */

export interface SweepReport {
  /** Whether the caller should emit this now. */
  log: boolean
  message: string
  /** Consecutive failures including this one. 0 on a recovery report. */
  consecutiveFailures: number
  /** True when this report marks a return to health. */
  recovered: boolean
}

export interface SweepHealthOptions {
  /** Re-surface a persistent identical failure every N occurrences. */
  repeatEvery?: number
  label?: string
}

const DEFAULT_REPEAT_EVERY = 10

export class SweepHealth {
  private consecutive = 0
  private lastMessage: string | undefined
  private readonly repeatEvery: number
  private readonly label: string

  constructor(opts: SweepHealthOptions = {}) {
    // A non-positive interval would make `% repeatEvery` throw or spam; clamp
    // rather than trust the caller.
    const requested = opts.repeatEvery ?? DEFAULT_REPEAT_EVERY
    this.repeatEvery = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_REPEAT_EVERY
    this.label = opts.label ?? 'ratification sweep'
  }

  /** Record a failed run. Returns whether (and what) to emit. */
  failure(err: unknown): SweepReport {
    const message = err instanceof Error ? err.message : String(err)
    const changed = message !== this.lastMessage
    this.consecutive += 1
    this.lastMessage = message

    const first = this.consecutive === 1
    const periodic = this.consecutive % this.repeatEvery === 0
    const log = first || changed || periodic

    const suffix =
      this.consecutive === 1
        ? ''
        : ` (consecutive failures: ${this.consecutive}${changed ? ', error changed' : ''})`
    return {
      log,
      message: `${this.label} failed (non-fatal): ${message}${suffix}`,
      consecutiveFailures: this.consecutive,
      recovered: false,
    }
  }

  /**
   * Record a successful run. Only reports when it ENDS a failing streak — a
   * healthy sweep must stay quiet or it becomes noise of its own.
   */
  success(): SweepReport {
    const failures = this.consecutive
    if (failures === 0) {
      return { log: false, message: '', consecutiveFailures: 0, recovered: false }
    }
    this.consecutive = 0
    this.lastMessage = undefined
    return {
      log: true,
      message: `${this.label} recovered after ${failures} consecutive failure${failures === 1 ? '' : 's'}`,
      consecutiveFailures: 0,
      recovered: true,
    }
  }

  /** Current streak, for callers that want to attach it to an event. */
  get failureStreak(): number {
    return this.consecutive
  }
}

export interface SweepTickDeps {
  /** The work itself. May throw; that is the whole point. */
  sweep: () => void
  health: SweepHealth
  /** stderr writer. NEVER stdout — stdout is the MCP transport. */
  warn: (message: string) => void
  /** Durable event append. May itself throw; that must not escalate. */
  emit: (event: string, payload: Record<string, unknown>) => void
}

/**
 * One tick of a background sweep, with the reporting attached.
 *
 * This exists as a named exported function ONLY so the failure path can be
 * watched. The logic previously lived inline in a `setInterval` callback, where
 * the only way to observe a failure was to break a live SQLite database — and
 * that turns out to be impossible from outside the process, because the open
 * file descriptor keeps working after the path is overwritten. Untestable code
 * is how the empty catch survived in the first place.
 *
 * Contract: this NEVER throws. A background sweep must not take the server down
 * — that part of the original design was right and is preserved exactly.
 */
export function runSweepTick(deps: SweepTickDeps): void {
  try {
    deps.sweep()
    const recovery = deps.health.success()
    if (recovery.log) {
      safeWarn(deps, recovery.message)
      safeEmit(deps, 'sweep_recovered', { after_failures: recovery.consecutiveFailures })
    }
  } catch (err) {
    // Reporting is itself wrapped. The first draft called `warn` directly here,
    // and a test with a throwing stderr proved it escaped — which would have
    // taken the server down through the very code added to stop that. The
    // reporting path must be at least as robust as the thing it reports on.
    let report: SweepReport
    try {
      report = deps.health.failure(err)
    } catch {
      return
    }
    if (report.log) {
      safeWarn(deps, report.message)
      safeEmit(deps, 'sweep_failed', {
        error: err instanceof Error ? err.message : String(err),
        consecutive_failures: report.consecutiveFailures,
      })
    }
  }
}

function safeWarn(deps: SweepTickDeps, message: string): void {
  try {
    deps.warn(message)
  } catch {
    // stderr can be a closed pipe. Losing the message is bad; taking the
    // server down to announce that we could not announce something is worse.
  }
}

function safeEmit(deps: SweepTickDeps, event: string, payload: Record<string, unknown>): void {
  try {
    deps.emit(event, payload)
  } catch {
    // The event log can be the very thing that is broken. stderr already
    // carried the story; reporting a failure must never become a second one.
  }
}
