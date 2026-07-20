/**
 * Isolated durable lifecycle kernel.
 *
 * This repository deliberately has no dependency on spawning, PID inspection,
 * retry timers, MCP schemas, or the NDJSON event projection. It establishes
 * lifecycle authority for one SQLite database only; it is not a multi-host
 * coordinator.
 */
import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { withStorageTransaction } from "./db.js";

export type WorkStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export type AttemptStatus = "pending" | "running" | "expired" | "succeeded" | "failed" | "cancelled";
export type AttemptEventKind =
  | "attempt_created"
  | "lease_acquired"
  | "lease_expired"
  | "attempt_retried"
  | "attempt_succeeded"
  | "attempt_failed"
  | "attempt_cancelled";

export interface WorkItem {
  work_id: string;
  fleet_id: string;
  agent_id: string | null;
  max_attempts: number;
  retry_base_ms: number;
  retry_jitter: boolean;
  status: WorkStatus;
  current_attempt_id: string | null;
  owner_epoch: number;
  cancelled_at: number | null;
  terminal_at: number | null;
  result: unknown;
  error: unknown;
  created_at: number;
  updated_at: number;
}

export interface Attempt {
  attempt_id: string;
  work_id: string;
  owner_id: string | null;
  owner_epoch: number;
  status: AttemptStatus;
  lease_until: number | null;
  attempt_number: number;
  eligible_at: number;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
  result: unknown;
  error: unknown;
}

export interface AttemptEvent {
  seq: number;
  event_id: string;
  work_id: string;
  attempt_id: string | null;
  owner_epoch: number | null;
  kind: AttemptEventKind;
  occurred_at: number;
  payload: { work: WorkItem; attempt: Attempt };
}

export interface LifecycleState {
  work: WorkItem;
  attempts: Attempt[];
  events: AttemptEvent[];
}

export interface LifecycleStoreOptions {
  now?: () => number;
  nextId?: () => string;
  /** Test-only hook invoked inside the storage transaction before commit. */
  beforeCommit?: () => void;
  /** Internal unified-seam hook. The caller already owns BEGIN IMMEDIATE. */
  database?: Database.Database;
}

export interface CreateWorkInput {
  workId: string;
  fleetId: string;
  agentId?: string;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryJitter?: boolean;
}

export interface LeaseInput {
  workId: string;
  attemptId: string;
  ownerId: string;
  leaseMs: number;
  ownerEpoch?: number;
}

export interface SettleInput {
  workId: string;
  attemptId: string;
  ownerId: string;
  ownerEpoch: number;
  outcome: "success" | "failure";
  result?: unknown;
  error?: unknown;
}

export type MutationResult = { accepted: true; state: LifecycleState } | { accepted: false; reason: string };

interface WorkRow {
  work_id: string; fleet_id: string; status: WorkStatus; current_attempt_id: string | null;
  agent_id: string | null; max_attempts: number; retry_base_ms: number; retry_jitter: number;
  owner_epoch: number; cancelled_at: number | null; terminal_at: number | null;
  result_json: string | null; error_json: string | null; created_at: number; updated_at: number;
}
interface AttemptRow {
  attempt_id: string; work_id: string; owner_id: string | null; owner_epoch: number;
  status: AttemptStatus; lease_until: number | null; created_at: number; updated_at: number;
  attempt_number: number; eligible_at: number;
  terminal_at: number | null; result_json: string | null; error_json: string | null;
}

const terminalWork = new Set<WorkStatus>(["succeeded", "failed", "cancelled"]);

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
function parsed(value: string | null): unknown {
  return value === null ? undefined : JSON.parse(value);
}
function workFrom(row: WorkRow): WorkItem {
  const { result_json, error_json, ...work } = row;
  return { ...work, retry_jitter: Boolean(work.retry_jitter), result: parsed(result_json), error: parsed(error_json) };
}
function attemptFrom(row: AttemptRow): Attempt {
  const { result_json, error_json, ...attempt } = row;
  return { ...attempt, result: parsed(result_json), error: parsed(error_json) };
}

type StoredEventPayload = {
  work: Omit<WorkItem, "result" | "error"> & {
    result: unknown;
    error: unknown;
    result_absent: boolean;
    error_absent: boolean;
  };
  attempt: Omit<Attempt, "result" | "error"> & {
    result: unknown;
    error: unknown;
    result_absent: boolean;
    error_absent: boolean;
  };
};

function encodeEventPayload(work: WorkItem, attempt: Attempt): StoredEventPayload {
  const encodeOutcome = (value: unknown) => ({ value: value === undefined ? null : value, absent: value === undefined });
  const workResult = encodeOutcome(work.result);
  const workError = encodeOutcome(work.error);
  const attemptResult = encodeOutcome(attempt.result);
  const attemptError = encodeOutcome(attempt.error);
  return {
    work: { ...work, result: workResult.value, error: workError.value, result_absent: workResult.absent, error_absent: workError.absent },
    attempt: { ...attempt, result: attemptResult.value, error: attemptError.value, result_absent: attemptResult.absent, error_absent: attemptError.absent },
  };
}

function decodeEventPayload(payload: StoredEventPayload): AttemptEvent["payload"] {
  const decodeWork = ({ result_absent, error_absent, ...work }: StoredEventPayload["work"]): WorkItem => ({
    ...work,
    result: result_absent ? undefined : work.result,
    error: error_absent ? undefined : work.error,
  });
  const decodeAttempt = ({ result_absent, error_absent, ...attempt }: StoredEventPayload["attempt"]): Attempt => ({
    ...attempt,
    result: result_absent ? undefined : attempt.result,
    error: error_absent ? undefined : attempt.error,
  });
  return { work: decodeWork(payload.work), attempt: decodeAttempt(payload.attempt) };
}
function requireNonEmpty(value: string, label: string): void {
  if (!value) throw new Error(`${label} is required`);
}
function requireLeaseMs(value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error("leaseMs must be a positive finite number");
}

export class LifecycleStore {
  private readonly now: () => number;
  private readonly nextId: () => string;
  private readonly beforeCommit?: () => void;
  private readonly database?: Database.Database;

  constructor(options: LifecycleStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.nextId = options.nextId ?? randomUUID;
    this.beforeCommit = options.beforeCommit;
    this.database = options.database;
  }

  private transaction<T>(mutator: (db: Database.Database) => T): T {
    return this.database ? mutator(this.database) : withStorageTransaction(mutator);
  }

  createWork(input: CreateWorkInput): LifecycleState {
    requireNonEmpty(input.workId, "workId");
    requireNonEmpty(input.fleetId, "fleetId");
    return this.transaction((db) => {
      const existing = this.loadWork(db, input.workId);
      if (existing) throw new Error(`work already exists: ${input.workId}`);
      const now = this.now();
      const maxAttempts = input.maxAttempts ?? 3;
      const retryBaseMs = input.retryBaseMs ?? 1000;
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || !Number.isFinite(retryBaseMs) || retryBaseMs < 0) {
        throw new Error("invalid lifecycle retry policy");
      }
      const attempt: Attempt = {
        attempt_id: this.nextId(), work_id: input.workId, owner_id: null, owner_epoch: 0,
        status: "pending", lease_until: null, created_at: now, updated_at: now,
        attempt_number: 1, eligible_at: now,
        terminal_at: null, result: undefined, error: undefined,
      };
      const work: WorkItem = {
        work_id: input.workId, fleet_id: input.fleetId, agent_id: input.agentId ?? null,
        max_attempts: maxAttempts, retry_base_ms: retryBaseMs, retry_jitter: input.retryJitter ?? true,
        status: "pending", current_attempt_id: attempt.attempt_id,
        owner_epoch: 0, cancelled_at: null, terminal_at: null, result: undefined, error: undefined,
        created_at: now, updated_at: now,
      };
      this.insertWork(db, work);
      this.insertAttempt(db, attempt);
      this.appendEvent(db, "attempt_created", work, attempt, now);
      this.beforeCommit?.();
      return this.snapshot(db, work.work_id);
    });
  }

  acquireLease(input: LeaseInput): MutationResult {
    requireNonEmpty(input.ownerId, "ownerId");
    requireLeaseMs(input.leaseMs);
    return this.transaction((db) => {
      const now = this.now();
      const work = this.loadWork(db, input.workId);
      const attempt = this.loadAttempt(db, input.attemptId);
      if (!work || !attempt || attempt.work_id !== input.workId || work.current_attempt_id !== input.attemptId || terminalWork.has(work.status) || attempt.status !== "pending" || attempt.eligible_at > now) {
        return { accepted: false, reason: "work is not leaseable" };
      }
      const epoch = Math.max(work.owner_epoch, attempt.owner_epoch) + 1;
      attempt.owner_id = input.ownerId;
      attempt.owner_epoch = epoch;
      attempt.status = "running";
      attempt.lease_until = now + input.leaseMs;
      attempt.updated_at = now;
      work.owner_epoch = epoch;
      work.status = "running";
      work.updated_at = now;
      this.updateWork(db, work);
      this.updateAttempt(db, attempt);
      this.appendEvent(db, "lease_acquired", work, attempt, now);
      this.beforeCommit?.();
      return { accepted: true, state: this.snapshot(db, work.work_id) };
    });
  }

  renewLease(input: LeaseInput): MutationResult {
    requireNonEmpty(input.ownerId, "ownerId");
    requireLeaseMs(input.leaseMs);
    return this.transaction((db) => {
      const now = this.now();
      const ownerEpoch = input.ownerEpoch;
      const work = this.loadWork(db, input.workId);
      const attempt = this.loadAttempt(db, input.attemptId);
      if (ownerEpoch === undefined || !work || !attempt || !this.ownedMutationAllowed(work, attempt, { ...input, ownerEpoch }, now)) {
        return { accepted: false, reason: "stale or terminal lease" };
      }
      attempt.lease_until = now + input.leaseMs;
      attempt.updated_at = now;
      this.updateAttempt(db, attempt);
      this.appendEvent(db, "lease_acquired", work, attempt, now);
      this.beforeCommit?.();
      return { accepted: true, state: this.snapshot(db, work.work_id) };
    });
  }

  expireAndRetry(workId: string, attemptId: string): MutationResult {
    return this.transaction((db) => {
      const now = this.now();
      const work = this.loadWork(db, workId);
      const attempt = this.loadAttempt(db, attemptId);
      if (!work || !attempt || attempt.work_id !== workId || work.current_attempt_id !== attemptId || terminalWork.has(work.status) || attempt.status !== "running" || attempt.lease_until === null || attempt.lease_until > now) {
        return { accepted: false, reason: "attempt is not expired" };
      }
      attempt.status = "expired";
      attempt.lease_until = null;
      attempt.updated_at = now;
      this.updateAttempt(db, attempt);
      // Record the expiration against the old current attempt before a retry
      // advances ownership. This makes the ordered event stream replayable.
      this.appendEvent(db, "lease_expired", work, attempt, now);
      const nextEpoch = Math.max(work.owner_epoch, attempt.owner_epoch) + 1;
      const retry: Attempt = {
        attempt_id: this.nextId(), work_id: workId, owner_id: null, owner_epoch: nextEpoch,
        status: "pending", lease_until: null, created_at: now, updated_at: now,
        attempt_number: attempt.attempt_number + 1, eligible_at: now,
        terminal_at: null, result: undefined, error: undefined,
      };
      work.current_attempt_id = retry.attempt_id;
      work.owner_epoch = nextEpoch;
      work.status = "pending";
      work.updated_at = now;
      this.updateWork(db, work);
      this.insertAttempt(db, retry);
      this.appendEvent(db, "attempt_retried", work, retry, now);
      this.beforeCommit?.();
      return { accepted: true, state: this.snapshot(db, workId) };
    });
  }

  settle(input: SettleInput): MutationResult {
    return this.transaction((db) => {
      const now = this.now();
      const work = this.loadWork(db, input.workId);
      const attempt = this.loadAttempt(db, input.attemptId);
      if (!work || !attempt || !this.ownedMutationAllowed(work, attempt, input, now)) {
        return { accepted: false, reason: "stale or terminal lease" };
      }
      const succeeded = input.outcome === "success";
      work.status = succeeded ? "succeeded" : "failed";
      work.terminal_at = now;
      work.result = input.result;
      work.error = input.error;
      work.updated_at = now;
      attempt.status = succeeded ? "succeeded" : "failed";
      attempt.terminal_at = now;
      attempt.lease_until = null;
      attempt.result = input.result;
      attempt.error = input.error;
      attempt.updated_at = now;
      this.updateWork(db, work);
      this.updateAttempt(db, attempt);
      this.appendEvent(db, succeeded ? "attempt_succeeded" : "attempt_failed", work, attempt, now);
      this.beforeCommit?.();
      return { accepted: true, state: this.snapshot(db, work.work_id) };
    });
  }

  /**
   * Settle a runtime failure and atomically create a distinct, persistently
   * scheduled retry when the captured work policy permits it.
   */
  settleWithRetry(input: SettleInput): MutationResult {
    if (input.outcome === "success") return this.settle(input);
    return this.transaction((db) => {
      const now = this.now();
      const work = this.loadWork(db, input.workId);
      const attempt = this.loadAttempt(db, input.attemptId);
      if (!work || !attempt || !this.ownedMutationAllowed(work, attempt, input, now)) {
        return { accepted: false, reason: "stale or terminal lease" };
      }
      attempt.status = "failed";
      attempt.terminal_at = now;
      attempt.lease_until = null;
      attempt.result = input.result;
      attempt.error = input.error;
      attempt.updated_at = now;
      this.updateAttempt(db, attempt);
      this.appendEvent(db, "attempt_failed", work, attempt, now);
      if (attempt.attempt_number >= work.max_attempts) {
        work.status = "failed";
        work.terminal_at = now;
        work.result = input.result;
        work.error = input.error;
        work.updated_at = now;
        this.updateWork(db, work);
        this.beforeCommit?.();
        return { accepted: true, state: this.snapshot(db, work.work_id) };
      }
      const epoch = Math.max(work.owner_epoch, attempt.owner_epoch) + 1;
      const eligibleAt = now + Math.floor(work.retry_base_ms * Math.pow(2, attempt.attempt_number - 1));
      const retry: Attempt = {
        attempt_id: this.nextId(), work_id: work.work_id, owner_id: null, owner_epoch: epoch,
        status: "pending", lease_until: null, attempt_number: attempt.attempt_number + 1, eligible_at: eligibleAt,
        created_at: now, updated_at: now, terminal_at: null, result: undefined, error: undefined,
      };
      work.current_attempt_id = retry.attempt_id;
      work.owner_epoch = epoch;
      work.status = "pending";
      work.result = undefined;
      work.error = undefined;
      work.updated_at = now;
      this.updateWork(db, work);
      this.insertAttempt(db, retry);
      this.appendEvent(db, "attempt_retried", work, retry, now);
      this.beforeCommit?.();
      return { accepted: true, state: this.snapshot(db, work.work_id) };
    });
  }

  /** Expire only a durable lease; PID state is deliberately not an input. */
  recoverExpired(): LifecycleState[] {
    return this.transaction((db) => {
      const now = this.now();
      const rows = db.prepare("SELECT work_id, current_attempt_id FROM work_items WHERE status = 'running'").all() as Array<{ work_id: string; current_attempt_id: string }>;
      const recovered: LifecycleState[] = [];
      const scoped = new LifecycleStore({ now: this.now, nextId: this.nextId, beforeCommit: this.beforeCommit, database: db });
      for (const row of rows) {
        const attempt = this.loadAttempt(db, row.current_attempt_id);
        if (!attempt || attempt.lease_until === null || attempt.lease_until > now) continue;
        const result = scoped.expireAndRetry(row.work_id, row.current_attempt_id);
        if (result.accepted) recovered.push(result.state);
      }
      return recovered;
    });
  }

  dueWork(): LifecycleState[] {
    return this.transaction((db) => {
      const now = this.now();
      const rows = db.prepare("SELECT work_id FROM work_items WHERE status = 'pending' AND current_attempt_id IN (SELECT attempt_id FROM attempts WHERE status = 'pending' AND eligible_at <= ?)").all(now) as Array<{ work_id: string }>;
      return rows.map((row) => this.snapshot(db, row.work_id));
    });
  }

  cancel(workId: string): MutationResult {
    return this.transaction((db) => {
      const now = this.now();
      const work = this.loadWork(db, workId);
      if (!work || terminalWork.has(work.status)) return { accepted: false, reason: "work is terminal or unknown" };
      const attempt = work.current_attempt_id ? this.loadAttempt(db, work.current_attempt_id) : undefined;
      if (!attempt) return { accepted: false, reason: "work has no current attempt" };
      work.status = "cancelled";
      work.cancelled_at = now;
      work.terminal_at = now;
      work.updated_at = now;
      attempt.status = "cancelled";
      attempt.lease_until = null;
      attempt.terminal_at = now;
      attempt.updated_at = now;
      this.updateWork(db, work);
      this.updateAttempt(db, attempt);
      this.appendEvent(db, "attempt_cancelled", work, attempt, now);
      this.beforeCommit?.();
      return { accepted: true, state: this.snapshot(db, workId) };
    });
  }

  getState(workId: string): LifecycleState | null {
    return this.transaction((db) => this.loadWork(db, workId) ? this.snapshot(db, workId) : null);
  }

  replay(workId: string): LifecycleState | null {
    return this.transaction((db) => {
      const rows = db.prepare("SELECT seq, event_id, work_id, attempt_id, owner_epoch, kind, occurred_at, payload FROM attempt_events WHERE work_id = ? ORDER BY seq").all(workId) as Array<Omit<AttemptEvent, "payload"> & { payload: string }>;
      if (!rows.length) return null;
      let work: WorkItem | undefined;
      const attempts = new Map<string, Attempt>();
      const events = rows.map((row) => {
        const payload = decodeEventPayload(JSON.parse(row.payload) as StoredEventPayload);
        work = payload.work;
        attempts.set(payload.attempt.attempt_id, payload.attempt);
        return { ...row, payload };
      });
      if (!work) return null;
      return { work, attempts: [...attempts.values()].sort((a, b) => a.created_at - b.created_at || a.attempt_id.localeCompare(b.attempt_id)), events };
    });
  }

  private ownedMutationAllowed(work: WorkItem, attempt: Attempt, input: { workId: string; attemptId: string; ownerId: string; ownerEpoch: number }, now: number): boolean {
    return Boolean(work && attempt && work.current_attempt_id === input.attemptId && attempt.work_id === input.workId && work.status === "running" && attempt.status === "running" && !work.cancelled_at && attempt.owner_id === input.ownerId && attempt.owner_epoch === input.ownerEpoch && work.owner_epoch === input.ownerEpoch && attempt.lease_until !== null && attempt.lease_until > now);
  }

  private loadWork(db: Database.Database, workId: string): WorkItem | undefined {
    const row = db.prepare("SELECT * FROM work_items WHERE work_id = ?").get(workId) as WorkRow | undefined;
    return row && workFrom(row);
  }
  private loadAttempt(db: Database.Database, attemptId: string): Attempt | undefined {
    const row = db.prepare("SELECT * FROM attempts WHERE attempt_id = ?").get(attemptId) as AttemptRow | undefined;
    return row && attemptFrom(row);
  }
  private insertWork(db: Database.Database, work: WorkItem): void {
    db.prepare("INSERT INTO work_items (work_id, fleet_id, agent_id, max_attempts, retry_base_ms, retry_jitter, status, current_attempt_id, owner_epoch, cancelled_at, terminal_at, result_json, error_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(work.work_id, work.fleet_id, work.agent_id, work.max_attempts, work.retry_base_ms, work.retry_jitter ? 1 : 0, work.status, work.current_attempt_id, work.owner_epoch, work.cancelled_at, work.terminal_at, json(work.result), json(work.error), work.created_at, work.updated_at);
  }
  private updateWork(db: Database.Database, work: WorkItem): void {
    db.prepare("UPDATE work_items SET agent_id = ?, max_attempts = ?, retry_base_ms = ?, retry_jitter = ?, status = ?, current_attempt_id = ?, owner_epoch = ?, cancelled_at = ?, terminal_at = ?, result_json = ?, error_json = ?, updated_at = ? WHERE work_id = ?").run(work.agent_id, work.max_attempts, work.retry_base_ms, work.retry_jitter ? 1 : 0, work.status, work.current_attempt_id, work.owner_epoch, work.cancelled_at, work.terminal_at, json(work.result), json(work.error), work.updated_at, work.work_id);
  }
  private insertAttempt(db: Database.Database, attempt: Attempt): void {
    db.prepare("INSERT INTO attempts (attempt_id, work_id, owner_id, owner_epoch, status, lease_until, attempt_number, eligible_at, created_at, updated_at, terminal_at, result_json, error_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(attempt.attempt_id, attempt.work_id, attempt.owner_id, attempt.owner_epoch, attempt.status, attempt.lease_until, attempt.attempt_number, attempt.eligible_at, attempt.created_at, attempt.updated_at, attempt.terminal_at, json(attempt.result), json(attempt.error));
  }
  private updateAttempt(db: Database.Database, attempt: Attempt): void {
    db.prepare("UPDATE attempts SET owner_id = ?, owner_epoch = ?, status = ?, lease_until = ?, attempt_number = ?, eligible_at = ?, updated_at = ?, terminal_at = ?, result_json = ?, error_json = ? WHERE attempt_id = ?").run(attempt.owner_id, attempt.owner_epoch, attempt.status, attempt.lease_until, attempt.attempt_number, attempt.eligible_at, attempt.updated_at, attempt.terminal_at, json(attempt.result), json(attempt.error), attempt.attempt_id);
  }
  private appendEvent(db: Database.Database, kind: AttemptEventKind, work: WorkItem, attempt: Attempt, now: number): void {
    db.prepare("INSERT INTO attempt_events (event_id, work_id, attempt_id, owner_epoch, kind, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)").run(this.nextId(), work.work_id, attempt.attempt_id, attempt.owner_epoch, kind, now, JSON.stringify(encodeEventPayload(work, attempt)));
  }
  private snapshot(db: Database.Database, workId: string): LifecycleState {
    const work = this.loadWork(db, workId);
    if (!work) throw new Error(`work not found: ${workId}`);
    const attempts = (db.prepare("SELECT * FROM attempts WHERE work_id = ? ORDER BY created_at, attempt_id").all(workId) as AttemptRow[]).map(attemptFrom);
    const events = (db.prepare("SELECT seq, event_id, work_id, attempt_id, owner_epoch, kind, occurred_at, payload FROM attempt_events WHERE work_id = ? ORDER BY seq").all(workId) as Array<Omit<AttemptEvent, "payload"> & { payload: string }>).map((row) => ({ ...row, payload: decodeEventPayload(JSON.parse(row.payload) as StoredEventPayload) }));
    return { work, attempts, events };
  }
}
