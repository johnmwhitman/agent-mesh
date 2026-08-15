/**
 * Parser for `opencode run --format json`, which emits NDJSON events rather
 * than prose.
 *
 * WHY THIS EXISTS: `hollow-result.ts` documents a known, deliberate gap — an
 * agent that emits a non-empty statement of intent and no deliverable banks as
 * success, because the only signal available was "did stdout have bytes".
 * That header also names the honest close: a STRUCTURAL signal from the
 * runtime, which `--format json` supplies. This module is that channel.
 *
 * MEASURED 2026-08-05 against the installed `opencode` (not assumed from docs).
 * A trivial one-turn run emits exactly three NDJSON lines:
 *
 *   {"type":"step_start","part":{"type":"step-start",...}}
 *   {"type":"text","part":{"type":"text","text":"hi",...}}
 *   {"type":"step_finish","part":{"type":"step-finish","reason":"stop",
 *                                 "tokens":{...},"cost":0.086,...}}
 *
 * So: assistant prose arrives as `text` parts, and every step ends with a
 * `step_finish` carrying a `reason`. Tool invocations arrive as their own
 * discrete parts, which is what lets us count them.
 *
 * WHAT THE TOOL COUNT IS FOR, and it is the important part: an agent asked to
 * audit a repo that made ZERO tool calls did not read anything. It cannot have.
 * That makes the 2026-08-04 fabrication class — an agent *reporting* that it ran
 * a `/usr/bin/find` control it never ran — structurally visible for the first
 * time, without sniffing its prose for keywords. We are no longer asking the
 * agent whether it did the work; we are reading what it did.
 *
 * FAIL-SAFE BY CONSTRUCTION: every parse failure yields `parsed: false` and the
 * caller falls back to the raw stream and today's behaviour. An older
 * `opencode` without `--format json`, a truncated stream, or a future event
 * shape degrades to exactly the guard we have now — never to a *weaker* one.
 */

/** A single structural observation about how a runtime turn actually went. */
export interface OpenCodeTrace {
  /**
   * False when the stream could not be read as the expected NDJSON. Callers
   * MUST treat every other field as unknown when this is false — absent
   * evidence, never evidence of absence.
   */
  parsed: boolean
  /** Assistant prose, the `text` parts concatenated in order. */
  text: string
  /** How many tool invocations the runtime actually made. */
  toolCalls: number
  /** Distinct tool names observed, in first-seen order. For operator display. */
  toolNames: string[]
  /**
   * The `reason` on the LAST `step_finish`. `"stop"` is a turn that ended
   * because the model was done. `"tool-calls"` means the turn ended with a tool
   * loop still open — the model wanted to continue and did not get to.
   */
  finishReason?: string
  /** How many `step_finish` events were seen; 0 means the turn never closed. */
  steps: number
  /**
   * The runtime-emitted session id, when every event that carries one agrees
   * on it (envelope AND part). The requester cannot know this value in
   * advance, which is what makes it usable as a join key to the runtime's own
   * persisted evidence. Undefined when no event carried an id or when any two
   * observations conflict — conflicting identity is no identity.
   */
  sessionId?: string
}

/** What a `text`-ish part looks like once we stop trusting the wrapper. */
function partText(part: unknown): string | undefined {
  if (typeof part !== 'object' || part === null) return undefined
  const text = (part as { text?: unknown }).text
  return typeof text === 'string' ? text : undefined
}

function partToolName(part: unknown): string | undefined {
  if (typeof part !== 'object' || part === null) return undefined
  const record = part as { tool?: unknown; name?: unknown }
  if (typeof record.tool === 'string') return record.tool
  if (typeof record.name === 'string') return record.name
  return undefined
}

/**
 * Parse an `opencode run --format json` stream.
 *
 * Deliberately tolerant of unknown event types: this reads the events it
 * understands and ignores the rest, so a new opencode event kind adds
 * information rather than breaking the guard. It is NOT tolerant of a stream
 * that yields no recognisable events at all — that returns `parsed: false`,
 * because a parser that reports a confident empty result on an unreadable
 * stream is exactly the silent instrument this repo keeps getting burned by.
 */
export function parseOpenCodeEvents(stdout: string): OpenCodeTrace {
  const empty: OpenCodeTrace = { parsed: false, text: '', toolCalls: 0, toolNames: [], steps: 0 }
  if (stdout.trim() === '') return empty

  const chunks: string[] = []
  const toolNames: string[] = []
  let toolCalls = 0
  let steps = 0
  let finishReason: string | undefined
  let recognised = 0
  let sessionId: string | undefined
  let sessionConflict = false

  const observeSessionId = (value: unknown): void => {
    if (value === undefined || value === null) return
    if (typeof value !== 'string' || value === '') {
      sessionConflict = true
      return
    }
    if (sessionId === undefined) {
      sessionId = value
      return
    }
    if (sessionId !== value) sessionConflict = true
  }

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event: unknown
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue // a non-JSON line is noise, not a parse failure of the whole stream
    }
    if (typeof event !== 'object' || event === null) continue
    const { type, part } = event as { type?: unknown; part?: unknown }
    if (typeof type !== 'string') continue
    recognised += 1

    observeSessionId((event as { sessionID?: unknown }).sessionID)
    observeSessionId((part as { sessionID?: unknown } | undefined)?.sessionID)

    if (type === 'text') {
      const text = partText(part)
      if (text !== undefined) chunks.push(text)
      continue
    }
    if (type === 'step_finish') {
      steps += 1
      const reason = (part as { reason?: unknown } | undefined)?.reason
      if (typeof reason === 'string') finishReason = reason
      continue
    }
    // Everything tool-shaped counts as a tool invocation. Matched on the event
    // type rather than an allow-list of tool names, so a tool this build has
    // never heard of still counts as work done.
    if (type === 'tool' || type === 'tool_call' || type === 'tool_use') {
      toolCalls += 1
      const name = partToolName(part)
      if (name !== undefined && !toolNames.includes(name)) toolNames.push(name)
    }
  }

  if (recognised === 0) return empty
  return {
    parsed: true,
    text: chunks.join(''),
    toolCalls,
    toolNames,
    finishReason,
    steps,
    sessionId: sessionConflict ? undefined : sessionId,
  }
}
