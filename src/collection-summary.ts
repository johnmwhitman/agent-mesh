/**
 * Make agent loss impossible to miss when collecting a fleet's results.
 *
 * THE INCIDENT (2026-08-04, reported by a user): the server died partway
 * through a 7-agent fleet. Two agents died with it — one of them the caller's
 * highest-priority job. The five survivors ran on and finished normally.
 * `collect_results` returned all seven entries, the two dead ones carrying
 * `status: "interrupted"` and an empty output, and **nothing else said anything
 * had gone wrong**. The loss surfaced only because a human counted.
 *
 * That is the failure this module exists to prevent. Quoting the fleet-command
 * discipline: *a crashed agent reports nothing, and its silence looks identical
 * to "not finished yet."* A caller should not have to know that `interrupted`
 * means "this work is gone and will never arrive" — the response must say so.
 *
 * Note the relationship to the OTHER open defect. False-completion claims work
 * that never happened; this loses work that did and stays quiet. Same disease —
 * the record asserting more certainty than it has — approached from opposite
 * ends. Both fixes are the same move: report what is actually known.
 */

/** The agent shape this module needs. Kept structural so tests need no ledger. */
export interface CollectableAgent {
  id?: string
  role?: string
  status?: string
  output?: string
  error?: string
  result_contract?: string
  result_artifacts?: readonly string[]
}

export interface LostAgent {
  role: string
  status: string
  /** Why the caller should care, in the caller's terms — not ours. */
  meaning: string
}

export interface DegradedAgent {
  role: string
  status: string
  result_contract: string
  error?: string
}

export interface NonconformingAgent {
  agent_id: string
  role: string
  status: string
  /** Null means this row predates result contracts; "absent" is a distinct declaration. */
  result_contract: string | null
}

export interface CollectionSummary {
  total: number
  /** Terminal and reported: the caller has something to read. */
  delivered: number
  /** Terminal with nothing to read — the work is gone. */
  lost: number
  /** Not terminal yet. Distinguished from lost so silence is never ambiguous. */
  still_running: number
  lost_agents: LostAgent[]
  degraded_agents: DegradedAgent[]
  /** Declared envelope conformance only; never correctness or independent outcome evidence. */
  contract_conforming: number
  contract_nonconforming: number
  nonconforming_agents: NonconformingAgent[]
  /** Present ONLY when something was lost. Absence is a real all-clear. */
  warning?: string
}

/**
 * `interrupted` is the infrastructure-death status: the agent was killed and
 * never reported. `failed` is loud on its own — it carries an error and every
 * consumer already reroutes on it — but it is still counted here so the caller
 * gets one honest tally instead of three.
 */
const TERMINAL_WITHOUT_RESULT = new Set(['interrupted', 'failed', 'cancelled'])
const NON_TERMINAL = new Set(['pending', 'running', 'spawning'])

function meaningOf(status: string): string {
  switch (status) {
    case 'interrupted':
      return 'killed before it reported — this work is GONE and will never arrive; re-dispatch it'
    case 'cancelled':
      return 'cancelled before it reported; re-dispatch if the work is still wanted'
    case 'failed':
      return 'ran and failed; see its error'
    default:
      return `terminal with no result (status: ${status})`
  }
}

export function summarizeCollection(agents: readonly CollectableAgent[]): CollectionSummary {
  const lost_agents: LostAgent[] = []
  const degraded_agents: DegradedAgent[] = []
  const nonconforming_agents: NonconformingAgent[] = []
  let delivered = 0
  let still_running = 0
  let contract_conforming = 0

  for (const agent of agents) {
    const status = agent.status ?? 'unknown'
    const result_contract = agent.result_contract
    const hasOutput = typeof agent.output === 'string' && agent.output.trim() !== ''
    const hasReportedResult = hasOutput || (agent.result_artifacts?.length ?? 0) > 0
    if (NON_TERMINAL.has(status)) {
      still_running++
      continue
    }
    if (result_contract === 'ok' && hasReportedResult) {
      contract_conforming++
    } else {
      nonconforming_agents.push({
        agent_id: agent.id ?? '(unknown)',
        role: agent.role ?? '(unnamed)',
        status,
        result_contract: result_contract ?? null,
      })
    }
    const reportedAfterFailure =
      status === 'failed' &&
      result_contract === 'ok' &&
      hasReportedResult
    if (reportedAfterFailure) {
      degraded_agents.push({
        role: agent.role ?? '(unnamed)',
        status,
        result_contract,
        ...(agent.error !== undefined ? { error: agent.error } : {}),
      })
      delivered++
      continue
    }
    if (TERMINAL_WITHOUT_RESULT.has(status)) {
      lost_agents.push({ role: agent.role ?? '(unnamed)', status, meaning: meaningOf(status) })
      continue
    }
    delivered++
  }

  const summary: CollectionSummary = {
    total: agents.length,
    delivered,
    lost: lost_agents.length,
    still_running,
    lost_agents,
    degraded_agents,
    contract_conforming,
    contract_nonconforming: nonconforming_agents.length,
    nonconforming_agents: nonconforming_agents.sort((left, right) =>
      left.role < right.role ? -1 : left.role > right.role ? 1 :
        left.agent_id < right.agent_id ? -1 : left.agent_id > right.agent_id ? 1 : 0,
    ),
  }

  if (lost_agents.length > 0) {
    const names = lost_agents.map((a) => `${a.role} (${a.status})`).join(', ')
    summary.warning =
      `${lost_agents.length} of ${agents.length} agents produced no result: ${names}. ` +
      `Work assigned to them was NOT done. An agent killed by a crash reports nothing, and its ` +
      `silence is indistinguishable from "not finished yet" — so this collection is INCOMPLETE, ` +
      `not merely smaller. Re-dispatch the lost roles explicitly before treating the fleet as done.`
  }

  return summary
}
