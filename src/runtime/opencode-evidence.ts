import {
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Read-only runtime-model evidence from the OpenCode state database.
 *
 * WHY THIS EXISTS: under `opencode run --format json` (MeshFleet's always-on
 * flag) the CLI's `> agent · model` stderr banner is suppressed — measured
 * 2026-08-13/14 against opencode 1.17.13 — so the banner channel in
 * `spawn-result.ts` cannot observe the effective model. The same measurement
 * showed the effective model IS persisted by the child itself: the assistant
 * `message` row for the run's session carries `modelID` (and the session row
 * carries `{id, providerID}`). The session id is emitted by the runtime in
 * the NDJSON stream, which the requester cannot predict.
 *
 * TRUTH CONTRACT:
 *   - The ONLY accepted key is the session id observed in the child's own
 *     NDJSON stream — never a value derived from the request, the argv, or
 *     the environment. Cross-session and stale evidence cannot satisfy a run.
 *   - The child's database is never opened. A stable post-child copy of the
 *     DB/WAL/SHM set is opened READ-ONLY in a private temporary directory and
 *     removed after the query. This preserves uncheckpointed WAL evidence
 *     without letting SQLite create or update the child's `-shm` file.
 *   - Any absence, malformed value, or disagreement yields `undefined`
 *     (absent evidence), never a guess. Callers keep the fail-closed guard.
 *   - The observed value is the persisted qualified form
 *     `<providerID>/<modelID>`. Provider identity comes from the exact
 *     assistant row or the joined session.model object, never from the
 *     configured expectation. The observed provider must equal that expected
 *     namespace; missing, malformed, mismatched, or conflicting identity fails
 *     closed. A refused stream produces no usable assistant row at all.
 *
 * `better-sqlite3` is already a hard dependency of this package (the ledger
 * uses it), so the reader shares the project's pinned SQLite rather than
 * adding a second one. Pinned better-sqlite3 12.11.1 opens with
 * sqlite3_open_v2() but no SQLITE_OPEN_URI flag and compiles SQLITE_USE_URI=0;
 * its process-global SQLITE_USE_URI=1 escape hatch makes `immutable=1`
 * available, but an immutable fixture ignored a live WAL transaction. It is
 * therefore not a safe substitute for the private sidecar-preserving copy.
 */

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

export interface OpenCodeSessionEvidenceOptions {
  /** Absolute path to the child's `opencode.db`. */
  dbPath: string;
  /** Session id observed in the child's NDJSON stream. */
  sessionId: string;
  /**
   * Operator-declared provider namespace (the same declaration as the argv
   * boundary). Required: evidence without a declared namespace cannot be
   * compared to a requested wire id without guessing.
   */
  providerNamespace: string;
}

export interface OpenCodeSessionEvidence {
  /** Harness-qualified observed model, e.g. `routeplane/z-ai/glm-5.2`. */
  model: string;
}

/** Measured opencode session ids: `ses_` followed by a Crockford-ish token. */
const SESSION_ID = /^ses_[A-Za-z0-9]{4,64}$/;
/** Model ids observed in the wild: `provider/leaf`, dotted/dashed segments. */
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/i;
/** OpenCode provider ids are one lowercase namespace segment. */
const PROVIDER_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const SNAPSHOT_SUFFIXES = ["", "-wal", "-shm"] as const;

interface FileEvidence {
  size: bigint;
  mtimeNs: bigint;
}

interface PrivateSnapshot {
  directory: string;
  dbPath: string;
}

function fileEvidence(path: string): FileEvidence {
  const stat = statSync(path, { bigint: true });
  return {
    size: stat.size,
    mtimeNs: stat.mtimeNs,
  };
}

function sourceEvidence(dbPath: string): Map<string, FileEvidence> | undefined {
  if (!existsSync(dbPath)) return undefined;
  const evidence = new Map<string, FileEvidence>();
  for (const suffix of SNAPSHOT_SUFFIXES) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path)) evidence.set(suffix, fileEvidence(path));
  }
  return evidence;
}

function sameEvidence(
  left: Map<string, FileEvidence>,
  right: Map<string, FileEvidence>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [suffix, expected] of left) {
    const actual = right.get(suffix);
    if (
      !actual ||
      actual.size !== expected.size ||
      actual.mtimeNs !== expected.mtimeNs
    ) return false;
  }
  return true;
}

/**
 * Copy a quiescent DB/WAL/SHM set without ever opening the source. If another
 * process changes any member during the copy, retry from fresh bytes; continued
 * churn is absent evidence rather than a potentially torn identity claim.
 */
function privateSnapshot(dbPath: string): PrivateSnapshot | undefined {
  const directory = mkdtempSync(join(tmpdir(), "mf-opencode-evidence-snapshot-"));
  const copy = join(directory, "opencode.db");
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = sourceEvidence(dbPath);
      if (!before) break;
      for (const suffix of SNAPSHOT_SUFFIXES) {
        rmSync(`${copy}${suffix}`, { force: true });
      }
      for (const suffix of before.keys()) {
        copyFileSync(
          `${dbPath}${suffix}`,
          `${copy}${suffix}`,
          constants.COPYFILE_FICLONE,
        );
      }
      const after = sourceEvidence(dbPath);
      if (after && sameEvidence(before, after)) return { directory, dbPath: copy };
    }
  } catch {
    // Copy races, locked sidecars, and unreadable files are absent evidence.
  }
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  } catch {
    // Cleanup failure must not turn absent evidence into a runtime crash.
  }
  return undefined;
}

export function readOpenCodeSessionEvidence(
  options: OpenCodeSessionEvidenceOptions,
): OpenCodeSessionEvidence | undefined {
  const { dbPath, sessionId, providerNamespace } = options;
  if (!SESSION_ID.test(sessionId)) return undefined;
  if (
    !providerNamespace ||
    providerNamespace.length > 64 ||
    !PROVIDER_ID.test(providerNamespace) ||
    providerNamespace.includes("..")
  ) return undefined;

  const snapshot = privateSnapshot(dbPath);
  if (!snapshot) return undefined;

  let db: import("better-sqlite3").Database | undefined;
  try {
    db = new Database(snapshot.dbPath, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    const row = db
      .prepare(
        "SELECT " +
          "json_extract(message.data, '$.modelID') AS assistantModelID, " +
          "json_extract(message.data, '$.providerID') AS assistantProviderID, " +
          "session.model AS sessionModel, " +
          "json_extract(session.model, '$.id') AS sessionModelID, " +
          "json_extract(session.model, '$.providerID') AS sessionProviderID " +
          "FROM message JOIN session ON session.id = message.session_id " +
          "WHERE message.session_id = ? AND json_extract(message.data, '$.role') = 'assistant' " +
          "ORDER BY message.time_created ASC LIMIT 1",
      )
      .get(sessionId) as {
        assistantModelID?: unknown;
        assistantProviderID?: unknown;
        sessionModel?: unknown;
        sessionModelID?: unknown;
        sessionProviderID?: unknown;
      } | undefined;
    if (!row) return undefined;

    const assistantModelID = row.assistantModelID;
    const assistantProviderID = row.assistantProviderID;
    const sessionModelID = row.sessionModelID;
    const sessionProviderID = row.sessionProviderID;
    if (typeof assistantModelID !== "string" || !MODEL_ID.test(assistantModelID)) return undefined;
    if (
      assistantProviderID !== null &&
      assistantProviderID !== undefined &&
      (typeof assistantProviderID !== "string" || !PROVIDER_ID.test(assistantProviderID))
    ) return undefined;
    if (row.sessionModel !== null && row.sessionModel !== undefined) {
      if (
        typeof sessionModelID !== "string" ||
        !MODEL_ID.test(sessionModelID) ||
        typeof sessionProviderID !== "string" ||
        !PROVIDER_ID.test(sessionProviderID)
      ) return undefined;
    }
    if (
      typeof sessionModelID === "string" &&
      sessionModelID !== assistantModelID
    ) return undefined;
    if (
      typeof assistantProviderID === "string" &&
      typeof sessionProviderID === "string" &&
      assistantProviderID !== sessionProviderID
    ) return undefined;

    const observedProvider =
      typeof assistantProviderID === "string" ? assistantProviderID : sessionProviderID;
    if (observedProvider !== providerNamespace) return undefined;
    return { model: `${observedProvider}/${assistantModelID}` };
  } catch {
    // Missing/corrupt/locked store, missing table — all are absent evidence.
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // closing a read-only handle must never turn absent evidence into a crash
    }
    try {
      rmSync(snapshot.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    } catch {
      // Cleanup failure must not turn absent evidence into a runtime crash.
    }
  }
}
