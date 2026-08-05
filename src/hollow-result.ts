/**
 * The single predicate for "a runtime exited successfully but banked nothing".
 *
 * WHY THIS FILE EXISTS: the check lived in two places — the inline spawn path in
 * index.ts and the durable path in lifecycle-execution.ts — as two copies of the
 * same expression with two copies of the rationale. Two copies of a safety
 * predicate drift, and any widening of it has to land in both or the hole simply
 * moves to whichever path was missed. One predicate, one place, both callers.
 *
 * WHAT IT CATCHES TODAY, STATED PLAINLY: zero bytes on stdout. That is a real
 * failure and it is caught. It is NOT the whole class.
 *
 * KNOWN, DELIBERATE GAP — do not mistake this guard for complete coverage:
 * an agent that emits a NON-EMPTY statement of intent and no deliverable still
 * banks as success. Two recorded instances:
 *
 *   2026-08-01 — the incident this guard was originally written for. Its own
 *   test docstring describes the agent as "sealed `complete` with a one-line
 *   preamble as its entire output". A preamble is not zero bytes, so the fix
 *   that shipped did not cover the incident that motivated it.
 *
 *   2026-08-04 — fleet 2a87864e, agent fc0517c9 (opencode-cli / grok-4.3). Ran
 *   39s, output was ~300 bytes: "Waiting for background exploration agents ...
 *   I will not poll background_output until the system-reminder arrives." The
 *   runtime had spawned its own background sub-agents, said it would wait, and
 *   its turn ended. Banked complete. `collect_results` would hand a caller that
 *   intent text AS the completed audit.
 *
 * WHY THE GAP IS STILL OPEN RATHER THAN PATCHED HERE: closing it by reading the
 * prose ("I will", "waiting for") is a keyword sniffer. It misfires on
 * legitimate short answers, and a false negative is not free — it retries an
 * expensive agent. The honest close is a STRUCTURAL signal from the runtime that
 * the turn ended with work still open, which `opencode run --format json` can
 * supply (it emits `step_finish` with a finish reason, and tool invocations as
 * discrete parts). That is a separate slice because it changes the adapter's
 * output channel. Until it lands, this predicate must not pretend to more reach
 * than it has.
 */
import type { RuntimeResult } from './runtime/types.js'

/** The prose every caller shows when {@link isHollowSuccess} fires. */
export const HOLLOW_SUCCESS_REASON =
  'Runtime exited successfully but produced no output. Treated as a failure: an empty ' +
  'result is indistinguishable from a real one to every caller, so sealing it as complete ' +
  'would claim work that never happened.'

/**
 * True when the runtime reported success but banked nothing a caller could use.
 *
 * Kept narrow ON PURPOSE (see the file header): it decides only on the absence
 * of output, never on what the output says.
 */
export function isHollowSuccess(result: Pick<RuntimeResult, 'status' | 'stdout'>): boolean {
  return result.status === 'success' && result.stdout.trim() === ''
}
