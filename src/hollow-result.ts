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
 * 2026-08-05 — THE GAP IS NOW PARTLY CLOSED, structurally. The slice this header
 * asked for landed: the opencode adapter runs with `--format json` and parses
 * the event stream (`runtime/opencode-events.ts`), so a `RuntimeTrace` is
 * available carrying what the turn actually DID. Two structural signals now
 * feed this predicate, neither of which reads the prose:
 *
 *   1. The turn ended with a tool loop still open (`finishReason === 'tool-calls'`).
 *      That is the recorded false-completion shape: the agent meant to continue
 *      and its turn ended instead.
 *   2. The turn never closed at all (`steps === 0` on a parsed stream).
 *
 * DELIBERATELY NOT A KEYWORD SNIFFER, and that constraint still stands: nothing
 * here inspects what the agent SAID. Sniffing for "I will" / "waiting for"
 * misfires on legitimate short answers, and a false negative is not free — it
 * retries an expensive agent.
 *
 * STILL OPEN, stated plainly so this header keeps its honesty: an agent that
 * finishes cleanly (`reason: 'stop'`) having made real tool calls but written a
 * useless answer is NOT caught here, and cannot be — that is a judgement about
 * content, which belongs to the caller reading the result. What the trace now
 * gives that caller is `toolCalls`: an audit that reports findings on zero tool
 * calls read nothing, and that is visible without trusting a word of its prose.
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
 * Decides on the ABSENCE of output and on STRUCTURAL facts about the turn —
 * never on what the output says (see the file header).
 *
 * The trace is optional and its absence is not evidence: a runtime that cannot
 * report structure falls through to exactly the byte-level check that shipped
 * before, so this predicate can only ever catch MORE than it used to, never
 * less. That property is what makes it safe to widen.
 */
export function isHollowSuccess(
  result: Pick<RuntimeResult, 'status' | 'stdout'> & Partial<Pick<RuntimeResult, 'trace'>>,
): boolean {
  if (result.status !== 'success') return false
  if (result.stdout.trim() === '') return true

  const trace = result.trace
  if (!trace) return false
  // A tool loop still open when the turn ended: the agent intended to keep
  // working. Banking this as complete is how intent text becomes a finished
  // audit downstream.
  if (trace.finishReason === 'tool-calls') return true
  // A parsed stream that never produced a single `step_finish` never closed a
  // turn — there is no point at which the runtime said it was done.
  if (trace.steps === 0) return true
  return false
}

/**
 * Prose for a result that completed cleanly but shows no evidence of reading
 * anything. NOT a failure — it is a caveat the caller must see.
 *
 * Kept separate from {@link isHollowSuccess} on purpose: whether zero tool calls
 * is wrong depends entirely on the job. "Summarise this text" legitimately needs
 * none; "audit this repo" cannot be done without one. Failing it here would
 * retry every harmless one-shot, so the honest move is to hand the caller the
 * fact and let the job decide. Returns `undefined` when there is nothing to say.
 */
export function noToolCallNotice(
  result: Pick<RuntimeResult, 'status'> & Partial<Pick<RuntimeResult, 'trace'>>,
): string | undefined {
  const trace = result.trace
  if (result.status !== 'success' || !trace || trace.toolCalls > 0) return undefined
  return (
    'This agent made ZERO tool calls: it read no file and ran no command. Any claim it ' +
    'makes about repository contents, file:line locations, or the result of a command was ' +
    'produced without observation. Treat findings as unsourced.'
  )
}
