/**
 * Boot-time consumption of the crash journal written by `crash-handler.ts`.
 *
 * The crash path deliberately never touches SQLite — the native binding is a
 * prime suspect in any crash — so the durable fingerprint it leaves is one
 * JSONL line per crash beside the ledger. That journal is not a dead artifact:
 * it is THIS module's input. On the next healthy start the parent instance
 * reads it, hands the named agent ids to `recoverInterruptedAgents` (which
 * attributes `stopped_reason: "server_crash"` vs `"process_lost"`), and then
 * retires the file by renaming it — the content is forensic evidence and is
 * preserved, never deleted.
 *
 * Ordering rule: the caller retires the journal only AFTER the ledger marks
 * are durably applied. If marking throws, the journal stays in place and the
 * next boot re-applies it; application is idempotent (a reason, once set, is
 * never overwritten), so a crash between apply and retire loses nothing and
 * invents nothing.
 *
 * Malformed lines (a torn final line from a dying process, garbage from a
 * full disk) are COUNTED and reported, never silently dropped — a journal
 * that lies by omission would be the exact failure this product exists to
 * prevent. They are retired along with the rest so the same garbage is not
 * re-counted forever; the rename preserves the bytes for a human.
 */
import { existsSync, readFileSync, renameSync } from "node:fs";
import { withLedger, withLedgerAndStorage } from "./db.js";
import { appendEvent } from "./core.js";
import { parseAgentResultEnvelope, resultPathFor } from "./result-contract.js";

export interface CrashJournalRecord {
  event: string;
  reason?: string;
  pid?: number;
  timestamp?: number;
  in_flight?: Array<{ agent_id?: unknown; fleet_id?: unknown; pid?: unknown }>;
}

export interface CrashJournalRead {
  /** Parsed `server_crash` records, oldest first. */
  records: CrashJournalRecord[];
  /** Agent ids named in-flight by any record (union across records). */
  namedAgentIds: Set<string>;
  /** Lines that were not valid `server_crash` records — counted loudly. */
  malformedLines: number;
}

const EMPTY: CrashJournalRead = Object.freeze({
  records: [],
  namedAgentIds: new Set<string>(),
  malformedLines: 0,
});

/**
 * Read the crash journal. A missing file is the healthy case and returns the
 * empty read. An unreadable file THROWS — the caller decides how loud to be,
 * and must leave the file in place.
 */
export function readCrashJournal(path: string): CrashJournalRead {
  if (!existsSync(path)) return EMPTY;
  const raw = readFileSync(path, "utf8");
  const records: CrashJournalRecord[] = [];
  const namedAgentIds = new Set<string>();
  let malformedLines = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines++;
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as CrashJournalRecord).event !== "server_crash"
    ) {
      malformedLines++;
      continue;
    }
    const record = parsed as CrashJournalRecord;
    records.push(record);
    if (Array.isArray(record.in_flight)) {
      for (const entry of record.in_flight) {
        if (entry && typeof entry.agent_id === "string") namedAgentIds.add(entry.agent_id);
      }
    }
  }
  return { records, namedAgentIds, malformedLines };
}

/**
 * Retire an applied journal by renaming it beside itself. Returns the new
 * path, or undefined if the rename failed — in which case the caller reports
 * it and the next boot re-applies, which is safe by the idempotence rule
 * above. Never deletes: the journal is evidence.
 */
export function retireCrashJournal(path: string, now: number): string | undefined {
  const retiredPath = `${path}.applied-${now}`;
  try {
    renameSync(path, retiredPath);
    return retiredPath;
  } catch {
    return undefined;
  }
}

/**
 * Recover declarations a crash prevented settle from recording.
 *
 * An agent that wrote `{"outcome":"refused"}` and then lost its server to a crash declared its
 * outcome — and today that declaration is silently lost: the row decays to `interrupted` with
 * `result_contract` unset. Losing an agent-authored envelope because settle never ran is the
 * silent-loss class this product exists to prevent, so the next healthy boot recovers it.
 *
 * THE FIELD ONLY EVER HOLDS OBSERVATIONS THAT MEAN THE SAME THING READ LATE. That rule shapes
 * every branch here (design adversarially reviewed 2026-08-06):
 *   - Only `refused` and `blocked` are recovered — they are parse-level facts, identical at any
 *     read time. `done`'s split into `ok`/`artifact_missing` is a SETTLE-TIME measurement (the
 *     artifact existence check has a window; tmpdirs age), so `done` is never recovered — a late
 *     existence check could record `artifact_missing` for work whose files existed at crash time.
 *   - A missing file records nothing. At settle, absence means the agent stayed silent; at boot,
 *     hours later, it more likely means tmp cleanup. Absence has lost its meaning.
 *   - An unparseable file records nothing — never `invalid` from a boot read, because a write
 *     torn BY THE CRASH is indistinguishable from agent fault, and recording it would assign
 *     culpability nobody observed.
 *   - The attempt id comes from the LEDGER (legacy: `runtime_attempts.length`, one entry per
 *     attempt that reached a spawn; durable: `work_items.current_attempt_id`) — never from
 *     globbing the tmpdir, which could credit attempt N with attempt N-1's refusal. No attempt
 *     evidence on the row → no path → no recovery. Honest ignorance.
 *   - Never overwrites a set value; only `interrupted` rows named by the crash journal.
 *
 * Consequence, documented rather than "fixed": interrupted rows only ever show NEGATIVE
 * recovered declarations. On an interrupted row, unset means UNKNOWN — not "did not refuse".
 */
export interface DeclarationRecoveryOutcome {
  /** Declarations recovered into result_contract (refused | blocked only). */
  recovered: number;
}

export function recoverCrashDeclarations(
  crashNamedAgentIds: ReadonlySet<string>,
): DeclarationRecoveryOutcome {
  if (crashNamedAgentIds.size === 0) return { recovered: 0 };

  // Pass 1 — resolve candidates and their attempt ids from the ledger, read-only.
  const candidates: Array<{ agentId: string; attempt: string | number }> = [];
  withLedgerAndStorage((data, db) => {
    for (const agent of Object.values(data.agents)) {
      if (!crashNamedAgentIds.has(agent.id)) continue;
      if (agent.status !== "interrupted" || agent.result_contract !== undefined) continue;
      const mode = db.prepare("SELECT lifecycle_mode FROM fleets WHERE id = ?").get(agent.fleet_id) as
        | { lifecycle_mode?: string | null }
        | undefined;
      if (mode?.lifecycle_mode === "durable") {
        const work = db.prepare("SELECT current_attempt_id FROM work_items WHERE work_id = ?").get(agent.id) as
          | { current_attempt_id?: string | null }
          | undefined;
        if (work?.current_attempt_id) candidates.push({ agentId: agent.id, attempt: work.current_attempt_id });
      } else if (agent.runtime_attempts !== undefined && agent.runtime_attempts.length > 0) {
        candidates.push({ agentId: agent.id, attempt: agent.runtime_attempts.length });
      }
    }
  });

  // Pass 2 — filesystem reads OUTSIDE any transaction (a disk read must not hold the write lock).
  const readable: Array<{ agentId: string; outcome: "refused" | "blocked" }> = [];
  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = readFileSync(resultPathFor(candidate.agentId, candidate.attempt), "utf8");
    } catch {
      continue; // absence means nothing at boot — tmp cleanup, not agent silence
    }
    const parsed = parseAgentResultEnvelope(raw);
    if (!parsed.ok) continue; // torn-by-crash vs agent fault: confounded, so never boot-`invalid`
    if (parsed.envelope.outcome !== "refused" && parsed.envelope.outcome !== "blocked") continue;
    readable.push({ agentId: candidate.agentId, outcome: parsed.envelope.outcome });
  }

  // Pass 3 — one transaction, preconditions re-checked so re-application stays idempotent.
  const applied: Array<{ agentId: string; outcome: "refused" | "blocked" }> = [];
  if (readable.length > 0) {
    withLedger((data) => {
      for (const r of readable) {
        const agent = data.agents[r.agentId];
        if (!agent || agent.status !== "interrupted" || agent.result_contract !== undefined) continue;
        agent.result_contract = r.outcome;
        applied.push(r);
      }
    });
  }
  for (const r of applied) {
    appendEvent("result_contract_recovered", { agent_id: r.agentId, outcome: r.outcome });
  }
  return { recovered: applied.length };
}
