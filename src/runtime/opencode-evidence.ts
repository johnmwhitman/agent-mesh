import { existsSync } from "node:fs";
import { createRequire } from "node:module";

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
 *   - The database is opened READ-ONLY. This reader never writes to, creates,
 *     or migrates the child's state store.
 *   - Any absence, malformed value, or disagreement yields `undefined`
 *     (absent evidence), never a guess. Callers keep the fail-closed guard.
 *   - The observed value is the harness-qualified form
 *     `<providerNamespace>/<modelID>`: the assistant message row records the
 *     bare model id and, on this build, not the provider, while the operator
 *     declares the namespace separately (same declaration that qualifies the
 *     CLI argv). A model the provider refused still fails closed upstream —
 *     a refused stream produces no usable assistant row at all.
 *
 * `better-sqlite3` is already a hard dependency of this package (the ledger
 * uses it), so the reader shares the project's pinned SQLite rather than
 * adding a second one.
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

export function readOpenCodeSessionEvidence(
  options: OpenCodeSessionEvidenceOptions,
): OpenCodeSessionEvidence | undefined {
  const { dbPath, sessionId, providerNamespace } = options;
  if (!SESSION_ID.test(sessionId)) return undefined;
  if (!providerNamespace || !existsSync(dbPath)) return undefined;

  let db: import("better-sqlite3").Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare(
        "SELECT json_extract(data, '$.modelID') AS modelID " +
          "FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant' " +
          "ORDER BY time_created ASC LIMIT 1",
      )
      .get(sessionId) as { modelID?: unknown } | undefined;
    const modelID = row?.modelID;
    if (typeof modelID !== "string" || !MODEL_ID.test(modelID)) return undefined;
    return { model: `${providerNamespace}/${modelID}` };
  } catch {
    // Missing/corrupt/locked store, missing table — all are absent evidence.
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // closing a read-only handle must never turn absent evidence into a crash
    }
  }
}
