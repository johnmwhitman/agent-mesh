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
