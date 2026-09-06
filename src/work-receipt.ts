/**
 * MeshFleet work receipts — first-class durable attestation of OUT-OF-MCP work.
 *
 * WHY THIS EXISTS, ON THE LEDGER.
 *   Receipts in this project are P2P witnesses on a message. A P2P receipt
 *   names a real message and an agent that acted on it; that invariant is
 *   what the verifier v3 checks. A Kanban completion is NOT a P2P message:
 *   it is the result of an entirely separate system (Hermes) talking to
 *   MeshFleet over MCP and asking it to remember "this task ended this way".
 *   Forcing that into the P2P layer — by minting a fake message + agent +
 *   receipts — would have been cheaper to ship and ruinously expensive to
 *   prove, because every later audit would have to remember which rows were
 *   real messages and which were synthetic stand-ins.
 *
 *   So we add a parallel collection, `work_receipts`, with its own narrow
 *   contract: the canonical payload is the Hermes result-contract envelope
 *   (§2 of the ratified Kanban receipt dogfood design), the immutable key is
 *   `(source, task_id, run_id)`, and the payload SHA-256 is recomputed by the
 *   server before any row is written. Replaying byte-equivalent content
 *   returns the existing row; reusing the key with different bytes is a
 *   conflict and never overwrites history. That last clause is the one this
 *   file exists to enforce.
 *
 * WHAT THIS DOES NOT ESTABLISH.
 *   This is a recording primitive, not an attestation. The recorded "outcome"
 *   is what Hermes declared; the recorded "evidence" is whatever handles
 *   Hermes provided, stored by kind+handle+digest without re-verifying it.
 *   MeshFleet does not fetch the git commit, does not open the attachment,
 *   does not re-run the command, and does not check that the evidence was
 *   produced by the task it names. Callers (the production-quality numerator,
 *   the weekly quality clock, the public pilot) decide what to do with that
 *   fact.
 *
 * The v3 verifier extends with `work_receipt.*` findings — malformed key,
 * identity mismatch (parsed key vs stored identity columns), duplicate
 * logical key, digest mismatch, impossible success combinations,
 * evidence-shape violations — but stays inside its existing
 * unsigned-local-consistency scope. The schema doc on the result contract is
 * the same schema MeshFleet expects to read; a divergence is a verifier
 * error, not a successful record.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  assertWorkReceiptsV5Schema,
  countWorkReceiptsLive,
  readWorkReceiptLive,
  resolveDbFile,
  withWorkReceiptInsert,
} from "./db.js";
import { appendEvent } from "./core.js";

/**
 * Schema marker for the canonical payload. Bumping this is a wire-incompatible
 * change; clients sending an older or unknown marker are rejected before any
 * idempotency check, so a stale client cannot accidentally overwrite a row
 * stored under a newer marker.
 */
export const WORK_RECEIPT_SCHEMA = "hermes.kanban-result/v1";

/** The single source string the Herms contract always uses. */
export const WORK_RECEIPT_SOURCE = "hermes-kanban";

/** Stable enum strings — kept separate so the verifier can match exactly. */
export const TERMINAL_OUTCOMES = ["completed", "failed", "refused", "blocked"] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

export const RESULT_CONTRACT_STATUSES = [
  "ok",
  "refused",
  "blocked",
  "artifact_missing",
  "invalid",
  "absent",
] as const;
export type ResultContractStatus = (typeof RESULT_CONTRACT_STATUSES)[number];

export const QUALITY_GATE_STATUSES = ["passed", "failed"] as const;
export type QualityGateStatus = (typeof QUALITY_GATE_STATUSES)[number];

export const EVIDENCE_KINDS = ["git_commit", "attachment", "artifact", "command_run", "external"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** One evidence handle, with optional digest. Digest grammar: 64-char hex (sha256). */
export interface WorkReceiptEvidence {
  kind: EvidenceKind;
  handle: string;
  digest?: string;
}

export interface WorkReceiptInput {
  schema: string;
  task_id: string;
  run_id: number;
  assignee: string;
  terminal_outcome: TerminalOutcome;
  result_contract: ResultContractStatus;
  quality_gate: QualityGateStatus;
  completed_at: number;
  evidence: WorkReceiptEvidence[];
  payload_sha256: string;
}

/** The persisted shape. `recorded_at` is the server's wall-clock insertion time. */
export interface WorkReceipt extends WorkReceiptInput {
  source: typeof WORK_RECEIPT_SOURCE;
  recorded_at: number;
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const TASK_ID_GRAMMAR = /^t_[A-Za-z0-9]+$/;

/**
 * Persisted-row schema validator. The audit path reads raw SQLite columns
 * and casts them to `WorkReceipt` — TypeScript casts are NOT runtime
 * validation, and the previous code trusted them, which is precisely the
 * `wr.evidence.forEach is not a function` failure mode the malformed-
 * evidence reproduction captured (a hand-edited evidence_json that parses
 * to a non-array leaves a row whose declared shape is not what the
 * verifier assumes). This function is the audit's last gate.
 *
 * Reuses the same per-entry logic the writer's `validateEvidenceArray`
 * applies, so persisted and writer-input paths share one source of truth
 * for "what an evidence entry must look like". A row that fails any check
 * is reported as `work_receipt.invalid_persisted_schema` (one finding per
 * reason) and the row's raw identity columns (`source`, `task_id`,
 * `run_id`) are preserved in the returned receipt so duplicate/identity
 * findings downstream still fire on the same row.
 *
 * The receipt returned on failure has `evidence: []` so downstream
 * invariants (`.length`, `.forEach`) cannot crash — but the raw JSON is
 * preserved in `reasons` so the verifier can report the offending bytes.
 */
export interface PersistedWorkReceiptFields {
  key: string;
  source: string;
  task_id: string;
  run_id: number;
  assignee: string;
  terminal_outcome: string;
  result_contract: string;
  quality_gate: string;
  completed_at: number;
  evidence_json: string;
  payload_sha256: string;
  recorded_at: number;
}

export interface PersistedWorkReceiptValidation {
  ok: boolean;
  /** Reasons the row's persisted schema disagrees with the contract. Empty when ok. */
  reasons: string[];
  /**
   * The validated row. When `ok` is true, this is a fully-typed
   * `WorkReceipt` safe to pass to downstream invariants. When `ok` is
   * false, `evidence` is `[]` (so .forEach / .length never crash), and
   * the identity columns (`source`, `task_id`, `run_id`) are preserved
   * verbatim so the duplicate/identity checks can still reason about
   * the row.
   */
  receipt: WorkReceipt;
}

export function validatePersistedWorkReceiptFields(
  raw: PersistedWorkReceiptFields,
): PersistedWorkReceiptValidation {
  const reasons: string[] = [];
  if (typeof raw.key !== "string" || raw.key === "") {
    reasons.push(`key must be a non-empty string, got ${JSON.stringify(raw.key)}`);
  }
  if (raw.source !== WORK_RECEIPT_SOURCE) {
    reasons.push(
      `source must be the literal "${WORK_RECEIPT_SOURCE}", got ${JSON.stringify(raw.source)}`,
    );
  }
  if (typeof raw.task_id !== "string" || !TASK_ID_GRAMMAR.test(raw.task_id)) {
    reasons.push(
      `task_id must match /${TASK_ID_GRAMMAR.source}/, got ${JSON.stringify(raw.task_id)}`,
    );
  }
  if (!Number.isInteger(raw.run_id) || raw.run_id <= 0) {
    reasons.push(
      `run_id must be a positive integer, got ${JSON.stringify(raw.run_id)}`,
    );
  }
  if (typeof raw.assignee !== "string" || raw.assignee.trim() === "") {
    reasons.push(
      `assignee must be a non-empty string, got ${JSON.stringify(raw.assignee)}`,
    );
  }
  if (!isOneOf(raw.terminal_outcome, TERMINAL_OUTCOMES)) {
    reasons.push(
      `terminal_outcome must be one of ${TERMINAL_OUTCOMES.join("|")}, got ${JSON.stringify(raw.terminal_outcome)}`,
    );
  }
  if (!isOneOf(raw.result_contract, RESULT_CONTRACT_STATUSES)) {
    reasons.push(
      `result_contract must be one of ${RESULT_CONTRACT_STATUSES.join("|")}, got ${JSON.stringify(raw.result_contract)}`,
    );
  }
  if (!isOneOf(raw.quality_gate, QUALITY_GATE_STATUSES)) {
    reasons.push(
      `quality_gate must be one of ${QUALITY_GATE_STATUSES.join("|")}, got ${JSON.stringify(raw.quality_gate)}`,
    );
  }
  // completed_at is unix SECONDS per the writer contract (validated by
  // validateWorkReceipt); record reasons the same way for persisted rows
  // so reader and writer share one source of truth on the unit.
  if (!Number.isInteger(raw.completed_at) || raw.completed_at <= 0) {
    reasons.push(
      `completed_at must be a positive integer (unix seconds), got ${JSON.stringify(raw.completed_at)}`,
    );
  }
  if (!Number.isInteger(raw.recorded_at) || raw.recorded_at <= 0) {
    reasons.push(
      `recorded_at must be a positive integer (unix seconds), got ${JSON.stringify(raw.recorded_at)}`,
    );
  }
  if (typeof raw.payload_sha256 !== "string" || !HEX_SHA256.test(raw.payload_sha256)) {
    reasons.push(
      `payload_sha256 must be a 64-char hex SHA-256 digest, got ${JSON.stringify(raw.payload_sha256)}`,
    );
  }
  if (typeof raw.evidence_json !== "string") {
    reasons.push(
      `evidence_json must be a string (the column is TEXT), got ${typeof raw.evidence_json}`,
    );
  }

  // Parse evidence defensively. Three failure modes:
  //   - JSON.parse throws (corrupted bytes);
  //   - JSON.parse yields a non-array (object, primitive, null);
  //   - JSON.parse yields an array whose entries are not objects
  //     (the v5 reproduction's case: `wr.evidence.forEach` was actually
  //     safe on an array, but entries that are primitives/null would
  //     later crash `computeWorkReceiptPayloadSha256` when it stringified
  //     them — validate each entry before the digest recompute path).
  //
  // On any failure we emit a persisted-schema reason AND substitute []
  // so downstream invariants never see a non-array.
  let evidence: WorkReceipt["evidence"] = [];
  if (typeof raw.evidence_json === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.evidence_json);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      reasons.push(
        `evidence_json must be valid JSON, got parse error: ${detail} (raw bytes: ${raw.evidence_json.slice(0, 80)})`,
      );
    }
    if (parsed !== undefined) {
      if (!Array.isArray(parsed)) {
        reasons.push(
          `evidence_json must parse to an array, got ${parsed === null ? "null" : typeof parsed} (${JSON.stringify(parsed).slice(0, 64)})`,
        );
      } else {
        // Reuse the writer's per-entry validation. validateEvidenceArray
        // rejects null/primitive/non-object entries and produces a per-index
        // reason for each — these flow into the verifier's findings so the
        // audit surfaces exactly which entry broke the contract.
        const entryCheck = validateEvidenceArray(parsed);
        if (entryCheck.reasons.length > 0) {
          for (const r of entryCheck.reasons) reasons.push(`evidence_json ${r}`);
        } else {
          evidence = entryCheck.normalized;
        }
      }
    }
  }

  const receipt: WorkReceipt = {
    schema: WORK_RECEIPT_SCHEMA,
    source: raw.source as typeof WORK_RECEIPT_SOURCE,
    task_id: raw.task_id,
    run_id: raw.run_id,
    assignee: raw.assignee,
    terminal_outcome: raw.terminal_outcome as WorkReceipt["terminal_outcome"],
    result_contract: raw.result_contract as WorkReceipt["result_contract"],
    quality_gate: raw.quality_gate as WorkReceipt["quality_gate"],
    completed_at: raw.completed_at,
    evidence,
    payload_sha256: raw.payload_sha256,
    recorded_at: raw.recorded_at,
  };
  return { ok: reasons.length === 0, reasons, receipt };
}

/**
 * Pure validation. Returns either a normalized record (canonical ordering +
 *  trimmed strings) or a list of rejection reasons. The caller never has to
 * guess what was wrong, and the rejection list is stable for the contract
 * guard tests.
 *
 * `payload_sha256` is recomputed from the OTHER fields; if the caller-supplied
 * digest does not match, the row is refused before the idempotency key is
 * even computed. This is what guarantees that "the canonical payload SHA-256"
 * is real — the server is the only thing that ever authors it.
 */
export function validateWorkReceipt(
  input: unknown,
): { ok: true; receipt: WorkReceiptInput } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reasons: ["input is not a single JSON object"] };
  }
  const obj = input as Record<string, unknown>;

  if (obj.schema !== WORK_RECEIPT_SCHEMA) {
    reasons.push(
      `schema must be the literal "${WORK_RECEIPT_SCHEMA}", got ${JSON.stringify(obj.schema)}`,
    );
  }
  if (typeof obj.task_id !== "string" || !TASK_ID_GRAMMAR.test(obj.task_id)) {
    reasons.push(
      `task_id must match /${TASK_ID_GRAMMAR.source}/, got ${JSON.stringify(obj.task_id)}`,
    );
  }
  if (!Number.isInteger(obj.run_id) || (obj.run_id as number) <= 0) {
    reasons.push(
      `run_id must be a positive integer, got ${JSON.stringify(obj.run_id)}`,
    );
  }
  if (typeof obj.assignee !== "string" || obj.assignee.trim() === "") {
    reasons.push(
      `assignee must be a non-empty string, got ${JSON.stringify(obj.assignee)}`,
    );
  }
  if (!isOneOf(obj.terminal_outcome, TERMINAL_OUTCOMES)) {
    reasons.push(
      `terminal_outcome must be one of ${TERMINAL_OUTCOMES.join("|")}, got ${JSON.stringify(obj.terminal_outcome)}`,
    );
  }
  if (!isOneOf(obj.result_contract, RESULT_CONTRACT_STATUSES)) {
    reasons.push(
      `result_contract must be one of ${RESULT_CONTRACT_STATUSES.join("|")}, got ${JSON.stringify(obj.result_contract)}`,
    );
  }
  if (!isOneOf(obj.quality_gate, QUALITY_GATE_STATUSES)) {
    reasons.push(
      `quality_gate must be one of ${QUALITY_GATE_STATUSES.join("|")}, got ${JSON.stringify(obj.quality_gate)}`,
    );
  }
  if (!Number.isInteger(obj.completed_at) || (obj.completed_at as number) <= 0) {
    reasons.push(
      `completed_at must be a positive integer (unix seconds), got ${JSON.stringify(obj.completed_at)}`,
    );
  }
  if (!Array.isArray(obj.evidence)) {
    reasons.push(`evidence must be an array, got ${typeof obj.evidence}`);
  }
  if (typeof obj.payload_sha256 !== "string" || !HEX_SHA256.test(obj.payload_sha256)) {
    reasons.push(
      `payload_sha256 must be a 64-char hex SHA-256 digest, got ${JSON.stringify(obj.payload_sha256)}`,
    );
  }

  if (reasons.length > 0) return { ok: false, reasons };

  // Cross-field invariants.
  const terminal = obj.terminal_outcome as TerminalOutcome;
  const contract = obj.result_contract as ResultContractStatus;
  const quality = obj.quality_gate as QualityGateStatus;
  const evidence = obj.evidence as unknown[];

  const evidenceCheck = validateEvidenceArray(evidence);
  if (evidenceCheck.reasons.length > 0) reasons.push(...evidenceCheck.reasons);

  // Quality gate passed → result_contract must be ok. (The strict numerator.)
  if (quality === "passed" && contract !== "ok") {
    reasons.push(
      `quality_gate=passed requires result_contract=ok, got result_contract=${JSON.stringify(contract)}`,
    );
  }
  // completed → ok OR artifact_missing (a completed agent that lost an artifact is not refused).
  // Anything else is impossible.
  if (terminal === "completed" && !["ok", "artifact_missing"].includes(contract)) {
    reasons.push(
      `terminal_outcome=completed requires result_contract in {ok, artifact_missing}, got ${JSON.stringify(contract)}`,
    );
  }
  // terminal_outcome=refused|failed → result_contract=ok is impossible (a refused run is not ok).
  if ((terminal === "refused" || terminal === "failed") && contract === "ok") {
    reasons.push(
      `terminal_outcome=${terminal} forbids result_contract=ok (would contradict the declared outcome)`,
    );
  }
  // Evidence is required iff quality_gate=passed — the success numerator includes only rows
  // with at least one handle.
  if (quality === "passed" && evidence.length === 0) {
    reasons.push(`quality_gate=passed requires at least one evidence entry (got 0)`);
  }

  if (reasons.length > 0) return { ok: false, reasons };

  const normalized: WorkReceiptInput = {
    schema: WORK_RECEIPT_SCHEMA,
    task_id: obj.task_id as string,
    run_id: obj.run_id as number,
    assignee: (obj.assignee as string).trim(),
    terminal_outcome: terminal,
    result_contract: contract,
    quality_gate: quality,
    completed_at: obj.completed_at as number,
    evidence: evidenceCheck.normalized,
    payload_sha256: obj.payload_sha256 as string,
  };

  const recomputed = computeWorkReceiptPayloadSha256(normalized);
  if (recomputed !== normalized.payload_sha256) {
    reasons.push(
      `payload_sha256 does not match the canonical digest of the supplied fields ` +
        `(recomputed ${recomputed} from canonicalized input, caller-supplied ${normalized.payload_sha256})`,
    );
    return { ok: false, reasons };
  }

  return { ok: true, receipt: normalized };
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

export function validateEvidenceArray(
  evidence: unknown[],
): { reasons: string[]; normalized: WorkReceiptEvidence[] } {
  const reasons: string[] = [];
  const normalized: WorkReceiptEvidence[] = [];
  evidence.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      reasons.push(`evidence[${index}] is not a single JSON object`);
      return;
    }
    const obj = entry as Record<string, unknown>;
    if (!isOneOf(obj.kind, EVIDENCE_KINDS)) {
      reasons.push(
        `evidence[${index}].kind must be one of ${EVIDENCE_KINDS.join("|")}, got ${JSON.stringify(obj.kind)}`,
      );
      return;
    }
    if (typeof obj.handle !== "string" || obj.handle.trim() === "") {
      reasons.push(`evidence[${index}].handle must be a non-empty string`);
      return;
    }
    if (obj.digest !== undefined && (typeof obj.digest !== "string" || !HEX_SHA256.test(obj.digest))) {
      reasons.push(
        `evidence[${index}].digest must be a 64-char hex SHA-256 string when present, got ${JSON.stringify(obj.digest)}`,
      );
      return;
    }
    // No Windows drive letters or home-dir expansions leak the operator's
    // filesystem through the evidence handle. MeshFleet stores the handle as
    // the caller wrote it (it is evidence, not a path) but rejects anything
    // that looks like a private local path. POSIX-style absolute handles are
    // allowed — they appear in git refs and many canonical handle schemes.
    if (looksLikeLocalPath(obj.handle)) {
      reasons.push(`evidence[${index}].handle must not be an absolute filesystem path`);
      return;
    }
    normalized.push({
      kind: obj.kind as EvidenceKind,
      handle: obj.handle,
      ...(typeof obj.digest === "string" ? { digest: obj.digest } : {}),
    });
  });
  return { reasons, normalized };
}

function looksLikeLocalPath(handle: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(handle)) return true;
  if (handle.startsWith("~")) return true;
  return false;
}

/**
 * The canonical payload. Field order matters for SHA-256 — any caller-built
 * object must produce the same digest after this ordering is applied, and
 * `validateWorkReceipt` does that ordering before calling this function.
 *
 * The evidence array is sorted by `(kind, handle, digest)` so two equivalent
 * sets presented in different orders produce the same digest. JSON uses
 * `JSON.stringify` with sorted keys (object keys are written in insertion
 * order in V8); the order of fields in this function is the canonical
 * insertion order.
 */
export function computeWorkReceiptPayloadSha256(receipt: WorkReceiptInput): string {
  const sortedEvidence = [...receipt.evidence]
    .map((e) => ({
      kind: e.kind,
      handle: e.handle,
      ...(e.digest !== undefined ? { digest: e.digest } : {}),
    }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
      if (a.handle !== b.handle) return a.handle < b.handle ? -1 : 1;
      const ad = a.digest ?? "";
      const bd = b.digest ?? "";
      return ad < bd ? -1 : ad > bd ? 1 : 0;
    });

  const canonical = JSON.stringify({
    schema: receipt.schema,
    task_id: receipt.task_id,
    run_id: receipt.run_id,
    assignee: receipt.assignee,
    terminal_outcome: receipt.terminal_outcome,
    result_contract: receipt.result_contract,
    quality_gate: receipt.quality_gate,
    completed_at: receipt.completed_at,
    evidence: sortedEvidence,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The immutable idempotency key. Stored verbatim in the DB as the primary key
 * of the `work_receipts` table; this is what replay and conflict use.
 *
 * The composite string is the joining format the SQLite UNIQUE INDEX enforces;
 * any change here must move the migration that adds the index. The order is
 * fixed because the verifier scans by it.
 */
export function workReceiptKey(source: string, taskId: string, runId: number): string {
  return `${source}\u0000${taskId}\u0000${runId}`;
}

/** Reverse of {@link workReceiptKey}. Stable across versions. */
export function parseWorkReceiptKey(key: string): { source: string; task_id: string; run_id: number } | null {
  const parts = key.split("\u0000");
  if (parts.length !== 3) return null;
  const [source, task_id, runIdRaw] = parts;
  if (source === undefined || task_id === undefined || runIdRaw === undefined) return null;
  const run_id = Number(runIdRaw);
  if (!Number.isInteger(run_id) || run_id <= 0) return null;
  return { source, task_id, run_id };
}

/** Read all work receipts for a task (one per run_id, immutable history). */
export function getWorkReceiptsForTask(taskId: string): WorkReceipt[] {
  return readAllWorkReceipts().filter((row) => row.task_id === taskId);
}

/** Read all work receipts in insertion order. */
export function getAllWorkReceipts(): WorkReceipt[] {
  return readAllWorkReceipts();
}

/**
 * The DB read seam. Routes through a PRIVATE READ-ONLY TEMP COPY of the
 * configured ledger, the same pattern as `readLedgerFile` in db.ts. The
 * copy is opened readonly, queried for work_receipts rows, and deleted; the
 * live file is touched zero times. Returns an empty array when the ledger
 * is absent or predates work receipts. Read/schema/decoding failures
 * propagate so corruption cannot be mistaken for an absent receipt.
 */
function readAllWorkReceipts(): WorkReceipt[] {
  const dbFile = resolveDbFile();
  if (!dbFile || dbFile === ":memory:" || !existsSync(dbFile)) return [];
  const tmp = mkdtempSync(join(tmpdir(), "meshfleet-work-receipts-"));
  const copy = join(tmp, "audit.db");
  try {
    for (const ext of ["-shm", "-wal"]) {
      if (existsSync(dbFile + ext)) copyFileSync(dbFile + ext, copy + ext);
    }
    copyFileSync(dbFile, copy);
    const conn = new Database(copy, { readonly: true, fileMustExist: true });
    try {
      // The verifier schema check (added by the migration) reports a missing
      // table as a verification finding, not an exception, so we follow the
      // same shape here: empty when the table is absent on a pre-feature
      // ledger, and silently skip rather than blow up on first open.
      const tableRow = conn
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='work_receipts'",
        )
        .get() as { name: string } | undefined;
      const version = conn.prepare("SELECT value FROM meta WHERE key = 'storage_schema_version'").get() as { value: string } | undefined;
      if (Number(version?.value ?? 0) >= 5) assertWorkReceiptsV5Schema(conn);
      if (!tableRow) return [];
      const rows = conn
        .prepare(
          "SELECT source, task_id, run_id, assignee, terminal_outcome, result_contract, " +
            "quality_gate, completed_at, evidence_json, payload_sha256, recorded_at " +
            "FROM work_receipts ORDER BY recorded_at ASC, key ASC",
        )
        .all() as Array<{
          source: string;
          task_id: string;
          run_id: number;
          assignee: string;
          terminal_outcome: string;
          result_contract: string;
          quality_gate: string;
          completed_at: number;
          evidence_json: string;
          payload_sha256: string;
          recorded_at: number;
        }>;
      return rows.map(decodeRow);
    } finally {
      try {
        conn.close();
      } catch {
        /* best-effort */
      }
    }
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* leak beats mask */
    }
  }
}

function decodeRow(row: {
  source: string;
  task_id: string;
  run_id: number;
  assignee: string;
  terminal_outcome: string;
  result_contract: string;
  quality_gate: string;
  completed_at: number;
  evidence_json: string;
  payload_sha256: string;
  recorded_at: number;
}): WorkReceipt {
  const checked = validatePersistedWorkReceiptFields({
    ...row, key: workReceiptKey(row.source, row.task_id, row.run_id),
  });
  if (!checked.ok) throw new Error("invalid persisted work receipt: " + checked.reasons.join("; "));
  return checked.receipt;
}

/**
 * The writer's three outcomes. `inserted` is a fresh row; `replayed` is a
 * byte-identical replay (same key, same canonical bytes — return the existing
 * row); `conflict` is the same key with DIFFERENT bytes, which is the only
 * outcome that refuses history. The MCP handler maps these to
 * `{inserted: true}`, `{replayed: true, recorded_at}`, and a structured error
 * respectively; the verifier inspects the row regardless of how it landed.
 */
export type RecordOutcome =
  | { kind: "inserted"; recorded_at: number }
  | { kind: "replayed"; recorded_at: number }
  | { kind: "conflict"; existing_payload_sha256: string; existing_recorded_at: number };

/**
 * The write path. Validates the input, then runs an immediate SQLite
 * transaction that:
 *
 *   1. Looks up the existing row by composite key.
 *   2. If absent → INSERT and return `inserted` (with a fresh `recorded_at`).
 *   3. If present with the same canonical bytes → return `replayed`.
 *   4. If present with different bytes → return `conflict` (NO mutation).
 *
 * The event-log entry `work_receipt_recorded` is appended ONLY for `inserted`,
 * so a replay does not re-emit and a conflict is recorded only by the row's
 * absence of change. Both are deliberate: events describe a state transition,
 * and neither replay nor conflict changes state.
 */
export function recordWorkReceipt(input: unknown): {
  outcome: RecordOutcome;
  receipt: WorkReceiptInput;
} | { error: string; reasons: string[] } {
  const validated = validateWorkReceipt(input);
  if (!validated.ok) {
    return { error: "invalid_work_receipt", reasons: validated.reasons };
  }
  const receipt = validated.receipt;
  const source = WORK_RECEIPT_SOURCE;
  const key = workReceiptKey(source, receipt.task_id, receipt.run_id);

  const result = withWorkReceiptInsert((db) => {
    const existing = db
      .prepare(
        "SELECT payload_sha256, recorded_at FROM work_receipts WHERE key = ?",
      )
      .get(key) as { payload_sha256: string; recorded_at: number } | undefined;

    if (existing) {
      if (existing.payload_sha256 === receipt.payload_sha256) {
        return { kind: "replayed" as const, recorded_at: existing.recorded_at };
      }
      return {
        kind: "conflict" as const,
        existing_payload_sha256: existing.payload_sha256,
        existing_recorded_at: existing.recorded_at,
      };
    }

    const recorded_at = Math.floor(Date.now() / 1000);
    const evidenceJson = JSON.stringify(receipt.evidence);
    db.prepare(
      "INSERT INTO work_receipts " +
        "(key, source, task_id, run_id, assignee, terminal_outcome, result_contract, " +
        "quality_gate, completed_at, evidence_json, payload_sha256, recorded_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      key,
      source,
      receipt.task_id,
      receipt.run_id,
      receipt.assignee,
      receipt.terminal_outcome,
      receipt.result_contract,
      receipt.quality_gate,
      receipt.completed_at,
      evidenceJson,
      receipt.payload_sha256,
      recorded_at,
    );
    return { kind: "inserted" as const, recorded_at };
  });

  // Event is emitted outside the SQLite transaction (the event log is a
  // separate file). For `inserted`, exactly one event; for `replayed` and
  // `conflict`, none — the row's state is unchanged.
  if (result.kind === "inserted") {
    appendEvent("work_receipt_recorded", {
      source,
      task_id: receipt.task_id,
      run_id: receipt.run_id,
      assignee: receipt.assignee,
      terminal_outcome: receipt.terminal_outcome,
      result_contract: receipt.result_contract,
      quality_gate: receipt.quality_gate,
      recorded_at: result.recorded_at,
    });
  }

  return { outcome: result, receipt };
}

/**
 * Read a single receipt back by composite key. Returns `null`-equivalent
 * (`ok: false, reason: "not_found"`) when no row exists; a structured error
 * when the key itself is malformed. The full row is returned including the
 * recorded_at so callers can correlate with the event log.
 */
export function getWorkReceipt(
  source: string,
  taskId: string,
  runId: number,
): { ok: true; receipt: WorkReceipt } | { ok: false; reason: string } {
  if (source !== WORK_RECEIPT_SOURCE) {
    return {
      ok: false,
      reason: `unknown source "${source}"; MeshFleet only records source=${WORK_RECEIPT_SOURCE}`,
    };
  }
  if (!TASK_ID_GRAMMAR.test(taskId)) {
    return { ok: false, reason: `task_id does not match /${TASK_ID_GRAMMAR.source}/` };
  }
  if (!Number.isInteger(runId) || runId <= 0) {
    return { ok: false, reason: `run_id must be a positive integer` };
  }
  const row = readWorkReceiptLive(source, taskId, runId);
  if (!row) return { ok: false, reason: "not_found" };

  // The live read returns only the keys needed for read-back; fill the rest
  // by issuing a second query for the full row, so the MCP caller gets the
  // exact bytes it would have stored.
  const allRows = getAllWorkReceipts();
  const full = allRows.find(
    (r) => r.source === source && r.task_id === taskId && r.run_id === runId,
  );
  if (!full) return { ok: false, reason: "not_found" };
  return { ok: true, receipt: full };
}

/** Total row count (0 when the ledger has no work_receipts table). */
export function workReceiptCount(): number {
  return countWorkReceiptsLive();
}