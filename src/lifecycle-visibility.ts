/**
 * Read-only lifecycle visibility. This module deliberately bypasses every
 * writer, recovery, projection, PID, and public getter seam.
 */
import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { type MeshData } from "./core.js";
import { resolveDbFile } from "./db.js";
import type { VerifyFinding } from "./verify.js";

export const LIFECYCLE_JSON_SCHEMA = "meshfleet.lifecycle/v1";
export const LIFECYCLE_SCAN_LIMIT = 200_000;
const OUTBOX_LAG_MS = 60_000;
const MAX_SUPPORTED_STORAGE_VERSION = 3;
const MODES = new Set(["legacy", "shadow", "durable"]);
const WORK_STATES = new Set(["pending", "running", "succeeded", "failed", "cancelled"]);
const ATTEMPT_STATES = new Set(["pending", "running", "expired", "succeeded", "failed", "cancelled"]);
const EVENT_KINDS = new Set(["attempt_created", "lease_acquired", "lease_expired", "attempt_retried", "attempt_succeeded", "attempt_failed", "attempt_cancelled"]);

type Row = Record<string, unknown>;
export type LifecycleMode = "legacy" | "shadow" | "durable";
export interface LifecycleSnapshot {
  data: MeshData;
  logicalVersion: number | null;
  storageVersion: number;
  snapshotKind: "copied-sqlite-files";
  lifecycleTablesPresent: boolean;
  fleetModes: Map<string, string | null>;
  work: Row[];
  attempts: Row[];
  events: Row[];
  outbox: Row[];
  scanExceeded: boolean;
}

function json(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`${label} is not JSON text`);
  try { return JSON.parse(value); } catch { throw new Error(`${label} contains invalid JSON`); }
}
function rows(db: Database.Database, sql: string): Row[] { return db.prepare(sql).all() as Row[]; }
function dataRows(db: Database.Database, table: string, key: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows(db, `SELECT ${key} AS k, data FROM ${table}`)) out[String(row.k)] = json(row.data, `${table}.${String(row.k)}`);
  return out;
}
function hasColumn(sql: string | undefined, column: string): boolean {
  return Boolean(sql && new RegExp(`\\b${column}\\b`, "i").test(sql));
}
function numberOrNull(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function modeOf(snapshot: LifecycleSnapshot, fleetId: string): LifecycleMode {
  const raw = snapshot.fleetModes.get(fleetId);
  return raw === "shadow" || raw === "durable" ? raw : "legacy";
}

/** One direct SQLite snapshot; it never initializes, migrates, or opens the writer handle. */
export function readLifecycleSnapshot(file: string = resolveDbFile()): LifecycleSnapshot {
  if (!existsSync(file)) throw new Error("ledger file not found");
  // SQLite may update an existing -shm file even for a readonly connection.
  // Audit a private copy so the evidence database and its sidecars are never
  // opened, while preserving any uncheckpointed WAL pages for the snapshot.
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-lifecycle-snapshot-"));
  const copy = join(dir, "snapshot.db");
  for (const ext of ["-shm", "-wal"]) if (existsSync(file + ext)) copyFileSync(file + ext, copy + ext);
  copyFileSync(file, copy);
  const db = new Database(copy, { readonly: true, fileMustExist: true });
  try {
    // readonly is the SQLite OPEN_READONLY/mode=ro equivalent in better-sqlite3;
    // query_only additionally rejects writes even if a future driver changes flags.
    db.pragma("query_only = ON");
    db.exec("BEGIN");
    try {
      const schema = rows(db, "SELECT name, sql FROM sqlite_master WHERE type = 'table'");
      const sql = new Map(schema.map((row) => [String(row.name), typeof row.sql === "string" ? row.sql : undefined]));
      const required = ["meta", "fleets", "agents", "messages", "inboxes", "capabilities", "receipts", "ratifications", "templates"];
      if (required.some((table) => !sql.has(table))) throw new Error("not a meshfleet ledger: required logical tables are missing");
      const meta = rows(db, "SELECT key, value FROM meta");
      const metaMap = new Map(meta.map((row) => [String(row.key), String(row.value)]));
      const storageText = metaMap.get("storage_schema_version");
      const storageVersion = storageText === undefined ? 1 : /^\d+$/.test(storageText) ? Number(storageText) : NaN;
      if (!Number.isInteger(storageVersion) || storageVersion < 1 || storageVersion > MAX_SUPPORTED_STORAGE_VERSION) {
        throw new Error(`unsupported storage schema version: ${storageText ?? "missing"}`);
      }
      const fleetsSql = sql.get("fleets");
      const fleetRows = rows(db, hasColumn(fleetsSql, "lifecycle_mode") ? "SELECT id, data, lifecycle_mode FROM fleets" : "SELECT id, data FROM fleets");
      const fleets: Record<string, unknown> = {};
      const fleetModes = new Map<string, string | null>();
      for (const row of fleetRows) { fleets[String(row.id)] = json(row.data, `fleets.${String(row.id)}`); fleetModes.set(String(row.id), typeof row.lifecycle_mode === "string" ? row.lifecycle_mode : null); }
      const lifecycleTablesPresent = ["work_items", "attempts", "attempt_events"].every((table) => sql.has(table));
      const outboxPresent = sql.has("lifecycle_event_outbox");
      const work = lifecycleTablesPresent ? rows(db, "SELECT * FROM work_items") : [];
      const attempts = lifecycleTablesPresent ? rows(db, "SELECT * FROM attempts") : [];
      const events = lifecycleTablesPresent ? rows(db, "SELECT * FROM attempt_events") : [];
      const outbox = outboxPresent ? rows(db, "SELECT * FROM lifecycle_event_outbox") : [];
      const total = work.length + attempts.length + events.length + outbox.length;
      const data: MeshData = {
        fleets: fleets as MeshData["fleets"],
        agents: dataRows(db, "agents", "id") as MeshData["agents"],
        messages: dataRows(db, "messages", "id") as MeshData["messages"],
        inboxes: dataRows(db, "inboxes", "agent_id") as MeshData["inboxes"],
        capabilities: dataRows(db, "capabilities", "agent_id") as MeshData["capabilities"],
        receipts: dataRows(db, "receipts", "key") as MeshData["receipts"],
        ratifications: dataRows(db, "ratifications", "message_id") as MeshData["ratifications"],
        templates: dataRows(db, "templates", "key"),
      };
      db.exec("COMMIT");
      return { data, logicalVersion: numberOrNull(Number(metaMap.get("schema_version"))), storageVersion, snapshotKind: "copied-sqlite-files", lifecycleTablesPresent, fleetModes, work, attempts, events, outbox, scanExceeded: total > LIFECYCLE_SCAN_LIMIT };
    } catch (error) { try { db.exec("ROLLBACK"); } catch { /* no mutation, best effort */ } throw error; }
  } finally { db.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup cannot mask an audit */ } }
}

function issue(findings: VerifyFinding[], mode: LifecycleMode, check: string, subject: string, detail: string, warning = false): void {
  findings.push({ severity: warning || mode === "shadow" ? "warning" : "error", check, subject, detail });
}
function validTimestamp(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function payload(row: Row): Row | undefined { try { const parsed = json(row.payload, "event payload"); return parsed !== null && typeof parsed === "object" ? parsed as Row : undefined; } catch { return undefined; } }

/** Lifecycle checks are namespaced and composed with the pure logical verifier. */
export function verifyLifecycleSnapshot(snapshot: LifecycleSnapshot, now: number = Date.now()): VerifyFinding[] {
  const findings: VerifyFinding[] = [];
  const modes = new Map<string, LifecycleMode>();
  for (const id of Object.keys(snapshot.data.fleets)) {
    const raw = snapshot.fleetModes.get(id);
    if (raw !== null && raw !== undefined && !MODES.has(raw)) issue(findings, "durable", "lifecycle.mode.invalid", id, "fleet lifecycle mode is not legacy, shadow, or durable");
    modes.set(id, modeOf(snapshot, id));
  }
  const authoritative = [...modes.values()].some((mode) => mode !== "legacy");
  const diagnosticMode: LifecycleMode = [...modes.values()].includes("durable") ? "durable" : [...modes.values()].includes("shadow") ? "shadow" : "legacy";
  if (!snapshot.lifecycleTablesPresent) {
    for (const [id, mode] of modes) if (mode !== "legacy") issue(findings, mode, "lifecycle.schema.missing_authority", id, "fleet declares lifecycle mode but lifecycle authority tables are absent");
    return findings;
  }
  if (snapshot.scanExceeded) { issue(findings, authoritative ? "durable" : "legacy", "lifecycle.verify.scan_limit", "lifecycle", `lifecycle scan exceeds ${LIFECYCLE_SCAN_LIMIT} rows`); return findings; }
  if (!authoritative && snapshot.work.length + snapshot.attempts.length + snapshot.events.length + snapshot.outbox.length === 0) return findings;
  const workById = new Map(snapshot.work.map((row) => [String(row.work_id), row]));
  const attemptsById = new Map(snapshot.attempts.map((row) => [String(row.attempt_id), row]));
  const attemptsByWork = new Map<string, Row[]>();
  for (const attempt of snapshot.attempts) { const list = attemptsByWork.get(String(attempt.work_id)) ?? []; list.push(attempt); attemptsByWork.set(String(attempt.work_id), list); }
  const fleetForWork = (row: Row): LifecycleMode => modes.get(String(row.fleet_id)) ?? "legacy";
  for (const work of snapshot.work) {
    const id = String(work.work_id); const mode = fleetForWork(work); const fleetId = String(work.fleet_id);
    if (!snapshot.data.fleets[fleetId]) issue(findings, mode, "lifecycle.work.orphan_fleet", id, "work references a fleet missing from MeshData");
    if (mode !== "durable") issue(findings, mode, "lifecycle.work.non_durable_fleet", id, "lifecycle work belongs to a non-durable fleet");
    const current = attemptsById.get(String(work.current_attempt_id));
    if (!current || String(current.work_id) !== id) issue(findings, mode, "lifecycle.work.current_attempt", id, "work current_attempt_id does not reference its own attempt");
    const terminal = ["succeeded", "failed", "cancelled"].includes(String(work.status));
    if (!WORK_STATES.has(String(work.status)) || (terminal !== (work.terminal_at !== null && work.terminal_at !== undefined)) || (!terminal && (work.terminal_at !== null && work.terminal_at !== undefined))) issue(findings, mode, "lifecycle.work.state", id, "work state and terminal timestamp do not reconcile");
    if (!validTimestamp(work.created_at) || !validTimestamp(work.updated_at) || Number(work.updated_at) < Number(work.created_at) || (work.terminal_at != null && (!validTimestamp(work.terminal_at) || Number(work.terminal_at) < Number(work.updated_at)))) issue(findings, mode, "lifecycle.work.timestamp_order", id, "work timestamps are invalid or out of order");
    const list = [...(attemptsByWork.get(id) ?? [])].sort((a, b) => Number(a.attempt_number) - Number(b.attempt_number));
    let previousEpoch = -1;
    for (let i = 0; i < list.length; i++) {
      const attempt = list[i]!; const aid = String(attempt.attempt_id);
      if (!ATTEMPT_STATES.has(String(attempt.status))) issue(findings, mode, "lifecycle.attempt.state", aid, "attempt status is invalid");
      if (!Number.isInteger(attempt.attempt_number) || Number(attempt.attempt_number) !== i + 1) issue(findings, mode, "lifecycle.attempt.number", aid, "attempt numbers are not contiguous from 1");
      if (!Number.isInteger(attempt.owner_epoch) || Number(attempt.owner_epoch) < previousEpoch) issue(findings, mode, "lifecycle.attempt.epoch", aid, "attempt epochs do not increase across retry history");
      previousEpoch = Number(attempt.owner_epoch);
      const running = String(attempt.status) === "running";
      const terminalAttempt = ["succeeded", "failed", "cancelled"].includes(String(attempt.status));
      if ((running && (!attempt.owner_id || !validTimestamp(attempt.lease_until))) || (!running && attempt.lease_until != null) || (terminalAttempt !== (attempt.terminal_at != null))) issue(findings, mode, "lifecycle.attempt.lease_state", aid, "attempt lease, owner, and terminal fields do not reconcile");
      if (!validTimestamp(attempt.created_at) || !validTimestamp(attempt.updated_at) || Number(attempt.updated_at) < Number(attempt.created_at) || !validTimestamp(attempt.eligible_at)) issue(findings, mode, "lifecycle.attempt.state", aid, "attempt timestamps or eligibility are invalid");
      if (attempt.launch_registered_at != null && (attempt.launch_intent_at == null || Number(attempt.launch_registered_at) < Number(attempt.launch_intent_at))) issue(findings, mode, "lifecycle.attempt.launch_state", aid, "launch registration does not follow launch intent");
      if (running && validTimestamp(attempt.lease_until) && Number(attempt.lease_until) < now) issue(findings, mode, "lifecycle.attempt.expired_lease", aid, "running attempt lease is expired", true);
      if (running && attempt.launch_intent_at != null && attempt.launch_registered_at == null && validTimestamp(attempt.lease_until) && Number(attempt.lease_until) < now) issue(findings, mode, "lifecycle.attempt.launch_quarantine_pending", aid, "expired launch intent awaits quarantine recovery", true);
    }
    if (list.filter((attempt) => String(attempt.status) === "running").some((attempt) => String(attempt.attempt_id) !== String(work.current_attempt_id))) issue(findings, mode, "lifecycle.attempt.state", id, "only the current attempt may run");
  }
  for (const attempt of snapshot.attempts) if (!workById.has(String(attempt.work_id))) issue(findings, diagnosticMode, "lifecycle.attempt.orphan_work", String(attempt.attempt_id), "attempt references missing work");
  const ids = new Set<string>(); let expected = 1;
  for (const event of [...snapshot.events].sort((a, b) => Number(a.seq) - Number(b.seq))) {
    const mode = workById.get(String(event.work_id)) ? fleetForWork(workById.get(String(event.work_id))!) : diagnosticMode;
    if (!Number.isInteger(event.seq) || Number(event.seq) !== expected++ || ids.has(String(event.event_id))) issue(findings, mode, "lifecycle.event.sequence", String(event.event_id), "event sequence is not globally contiguous or event id is duplicated");
    ids.add(String(event.event_id));
    if (!workById.has(String(event.work_id)) || (event.attempt_id != null && !attemptsById.has(String(event.attempt_id))) || !EVENT_KINDS.has(String(event.kind))) issue(findings, mode, "lifecycle.event.reference", String(event.event_id), "event references missing work/attempt or has an invalid kind");
    const body = payload(event);
    if (!body || !body.work || !body.attempt || String((body.work as Row).work_id) !== String(event.work_id) || String((body.attempt as Row).attempt_id) !== String(event.attempt_id) || !validTimestamp(event.occurred_at)) issue(findings, mode, "lifecycle.event.payload", String(event.event_id), "event payload is invalid or does not identify its row");
  }
  for (const work of snapshot.work) {
    const mode = fleetForWork(work); const related = snapshot.events.filter((event) => String(event.work_id) === String(work.work_id));
    if (related.length === 0) issue(findings, mode, "lifecycle.replay.unreplayable", String(work.work_id), "work has no lifecycle event history");
    else {
      const last = payload([...related].sort((a, b) => Number(a.seq) - Number(b.seq)).at(-1)!);
      const replayWork = last?.work;
      if (!last || replayWork === null || typeof replayWork !== "object" || String((replayWork as Row).status) !== String(work.status) || String((replayWork as Row).current_attempt_id) !== String(work.current_attempt_id) || Number((replayWork as Row).owner_epoch) !== Number(work.owner_epoch)) issue(findings, mode, "lifecycle.replay.state_mismatch", String(work.work_id), "event replay terminal snapshot disagrees with stored work");
    }
  }
  for (const [fleetId, mode] of modes) if (mode === "durable") {
    const agents = Object.values(snapshot.data.agents).filter((agent) => agent.fleet_id === fleetId);
    for (const agent of agents) {
      const mapped = snapshot.work.filter((work) => String(work.fleet_id) === fleetId && String(work.agent_id) === agent.id);
      if (mapped.length !== 1) issue(findings, mode, "lifecycle.projection.missing_work", agent.id, "durable agent must map to exactly one work item");
      else {
        const work = mapped[0]!; const expectedStatus = ({ pending: "pending", running: "running", complete: "succeeded", failed: "failed", interrupted: "cancelled" } as Record<string, string>)[agent.status];
        if (expectedStatus !== String(work.status)) issue(findings, mode, "lifecycle.projection.agent_state", agent.id, "durable agent projection status disagrees with work");
        const retry = Math.max(0, (attemptsByWork.get(String(work.work_id))?.length ?? 1) - 1);
        if ((agent.retry_count ?? 0) !== retry) issue(findings, mode, "lifecycle.projection.retry_count", agent.id, "durable agent retry_count disagrees with attempt history");
      }
    }
  }
  const outIds = new Set<string>(); let outExpected = 1;
  for (const row of [...snapshot.outbox].sort((a, b) => Number(a.seq) - Number(b.seq))) {
    if (!Number.isInteger(row.seq) || Number(row.seq) !== outExpected++ || outIds.has(String(row.event_id))) issue(findings, diagnosticMode, "lifecycle.outbox.sequence", String(row.event_id), "outbox sequence is not contiguous or event id is duplicated");
    outIds.add(String(row.event_id));
    try { json(row.payload, "outbox payload"); } catch { issue(findings, diagnosticMode, "lifecycle.outbox.payload", String(row.event_id), "outbox payload is invalid JSON"); }
    if (!validTimestamp(row.created_at) || (row.projected_at != null && (!validTimestamp(row.projected_at) || Number(row.projected_at) < Number(row.created_at)))) issue(findings, diagnosticMode, "lifecycle.outbox.projected_before_created", String(row.event_id), "outbox projection timestamp precedes creation");
    if (row.projected_at == null && validTimestamp(row.created_at) && now - Number(row.created_at) > OUTBOX_LAG_MS) issue(findings, diagnosticMode, "lifecycle.outbox.projection_lag", String(row.event_id), "outbox row remains unprojected beyond the lag threshold", true);
  }
  return findings;
}

export interface LifecycleView { schema: typeof LIFECYCLE_JSON_SCHEMA; kind: "lifecycle"; data: Record<string, unknown>; missingFleet: boolean; exitError: boolean; }
export function buildLifecycleView(snapshot: LifecycleSnapshot, fleetId?: string, now: number = Date.now()): LifecycleView {
  const missingFleet = fleetId !== undefined && !snapshot.data.fleets[fleetId];
  const scopedWork = snapshot.work.filter((row) => !fleetId || String(row.fleet_id) === fleetId);
  const scopedIds = new Set(scopedWork.map((row) => String(row.work_id)));
  const scopedAttempts = snapshot.attempts.filter((row) => scopedIds.has(String(row.work_id)));
  const issues = verifyLifecycleSnapshot(snapshot, now).filter((finding) => !fleetId || finding.subject === fleetId || scopedIds.has(finding.subject) || scopedAttempts.some((row) => String(row.attempt_id) === finding.subject));
  const modeCounts = { legacy: 0, shadow: 0, durable: 0 };
  for (const id of Object.keys(snapshot.data.fleets)) modeCounts[modeOf(snapshot, id)]++;
  const statusCounts: Record<string, number> = {};
  for (const work of scopedWork) statusCounts[String(work.status)] = (statusCounts[String(work.status)] ?? 0) + 1;
  const pending = snapshot.outbox.filter((row) => row.projected_at == null);
  const oldest = pending.reduce<number | null>((old, row) => validTimestamp(row.created_at) && (old === null || Number(row.created_at) < old) ? Number(row.created_at) : old, null);
  const data = {
    observed_at_ms: now, logical_version: snapshot.logicalVersion, storage_version: snapshot.storageVersion, snapshot_kind: snapshot.snapshotKind, authority: "sqlite", scope: fleetId ? { fleet_id: fleetId } : { fleet_id: null },
    fleet: { modes: modeCounts, authority: modeCounts.durable ? "durable/canonical" : modeCounts.shadow ? "shadow/not-authoritative" : "legacy/not-applicable", status: statusCounts, counts: { fleets: fleetId ? 1 : Object.keys(snapshot.data.fleets).length, agents: fleetId ? Object.values(snapshot.data.agents).filter((agent) => agent.fleet_id === fleetId).length : Object.keys(snapshot.data.agents).length } },
    work: { total: scopedWork.length, status: statusCounts },
    attempt: { total: scopedAttempts.length, current: scopedWork.filter((work) => work.current_attempt_id != null).length },
    lease: { running: scopedAttempts.filter((row) => row.status === "running").length, expired: scopedAttempts.filter((row) => row.status === "running" && validTimestamp(row.lease_until) && Number(row.lease_until) < now).length },
    eligibility: { pending: scopedAttempts.filter((row) => row.status === "pending").length, due: scopedAttempts.filter((row) => row.status === "pending" && validTimestamp(row.eligible_at) && Number(row.eligible_at) <= now).length },
    recovery: { launch_quarantine_pending: scopedAttempts.filter((row) => row.status === "running" && row.launch_intent_at != null && row.launch_registered_at == null && validTimestamp(row.lease_until) && Number(row.lease_until) < now).length, runtime_pid_present: scopedAttempts.filter((row) => row.runtime_pid != null).length },
    events: { total: snapshot.events.filter((row) => !fleetId || scopedIds.has(String(row.work_id))).length, sequence_high_watermark: snapshot.events.reduce((max, row) => Math.max(max, Number(row.seq) || 0), 0) },
    outbox: { authority: "sqlite", projection: "ndjson", total: snapshot.outbox.length, projected: snapshot.outbox.length - pending.length, pending: pending.length, sequence_high_watermark: snapshot.outbox.reduce((max, row) => Math.max(max, Number(row.seq) || 0), 0), oldest_pending_lag_ms: oldest === null ? null : Math.max(0, now - oldest), repair_needed: pending.length > 0, repair_command: null },
    issues,
  };
  return { schema: LIFECYCLE_JSON_SCHEMA, kind: "lifecycle", data, missingFleet, exitError: issues.some((finding) => finding.severity === "error") };
}

export function formatLifecycleView(view: LifecycleView): string {
  const data = view.data as Record<string, any>;
  const lines = ["Agent Mesh lifecycle", `Authority: ${data.authority} (NDJSON is projection only)`, `Snapshot: ${data.snapshot_kind}`, `Scope: ${data.scope.fleet_id ?? "all fleets"}`, `Lifecycle authority: ${data.fleet.authority}`, `Work: ${data.work.total}`, `Attempts: ${data.attempt.total}`, `Events: ${data.events.total} (high watermark ${data.events.sequence_high_watermark})`, `Outbox: ${data.outbox.total} total, ${data.outbox.projected} projected, ${data.outbox.pending} pending, oldest lag ${data.outbox.oldest_pending_lag_ms ?? "not-applicable"}ms`, `Repair needed: ${data.outbox.repair_needed ? "yes" : "no"}; repair command: not exposed`];
  if (view.missingFleet) lines.push("Issue: requested fleet is missing");
  if (data.issues.length === 0) lines.push("Issues: none");
  else for (const finding of data.issues) lines.push(`${String(finding.severity).toUpperCase()} ${finding.check} ${finding.subject}: ${finding.detail}`);
  return lines.join("\n");
}
