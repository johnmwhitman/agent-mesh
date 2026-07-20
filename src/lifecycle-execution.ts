/**
 * Single-host bridge from the durable lifecycle authority to RuntimeAdapter.
 * It owns no public MCP schema and never treats SQLite as multi-host storage.
 */
import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { withLedgerAndStorage } from "./db.js";
import {
  _checkFleetCompletion,
  _createFleet,
  _registerAgent,
  appendEventOnce,
  type Agent,
  type MeshData,
} from "./core.js";
import { LifecycleStore, type LifecycleState } from "./attempt-lifecycle.js";
import type { RuntimeAdapter, RuntimeHandle, RuntimeResult } from "./runtime/types.js";

export type LifecycleMode = "legacy" | "shadow" | "durable";
export interface DurableAgentSpec { fleetId: string; agentId: string; role: string; prompt: string; agentFile?: string; }
export interface LifecycleExecutionCoordinatorOptions {
  ownerId?: string;
  now?: () => number;
  leaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  /** Diagnostic containment only; never consulted for lease authority. */
  terminatePid?: (pid: number) => void;
  /** Test-only seam for the crash window after durable intent commits. */
  beforeRuntimeStart?: () => void;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 1_000;
const OUTBOX_CLAIM_MS = 30_000;
let outboxAfterAppendForTest: (() => void) | undefined;

/** Test-only crash-window seam: invoked after append and before SQLite acknowledgement. */
export function setOutboxAfterAppendForTest(hook: (() => void) | undefined): void {
  outboxAfterAppendForTest = hook;
}

function modeFrom(value: string | undefined): LifecycleMode {
  const mode = value ?? "legacy";
  if (mode === "legacy" || mode === "shadow" || mode === "durable") return mode;
  throw new Error("MESHFLEET_LIFECYCLE_MODE must be legacy, shadow, or durable");
}

export function defaultLifecycleMode(): LifecycleMode {
  return modeFrom(process.env.MESHFLEET_LIFECYCLE_MODE);
}

function redact(value: unknown): string {
  return String(value ?? "runtime failure")
    .replace(/(Bearer\s+|api[_-]?key[=:]\s*|token[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000);
}

function lifecycle(db: Database.Database, now: () => number): LifecycleStore {
  return new LifecycleStore({ database: db, now });
}

function queueEvent(db: Database.Database, event: string, payload: Record<string, unknown>, now: number): void {
  db.prepare("INSERT INTO lifecycle_event_outbox (event_id, event, payload, created_at) VALUES (?, ?, ?, ?)")
    .run(randomUUID(), event, JSON.stringify(payload), now);
}

function modeFor(db: Database.Database, fleetId: string): LifecycleMode {
  const row = db.prepare("SELECT lifecycle_mode FROM fleets WHERE id = ?").get(fleetId) as { lifecycle_mode?: string | null } | undefined;
  return modeFrom(row?.lifecycle_mode ?? undefined);
}

function persistMode(db: Database.Database, fleetId: string, mode: LifecycleMode): void {
  // Insert a placeholder for a newly-created projection. Lazy ledger persistence
  // subsequently upserts the JSON data without erasing this physical authority.
  db.prepare("INSERT INTO fleets (id, data, lifecycle_mode) VALUES (?, '{}', ?) ON CONFLICT(id) DO UPDATE SET lifecycle_mode = excluded.lifecycle_mode")
    .run(fleetId, mode);
}

export function projectLifecycleOutbox(ownerId: string = randomUUID(), now: number = Date.now()): number {
  let projected = 0;
  while (true) {
    const row = withLedgerAndStorage((_data, db) => {
      const candidate = db.prepare("SELECT seq, event_id, event, payload FROM lifecycle_event_outbox WHERE projected_at IS NULL AND (claimed_at IS NULL OR claimed_at <= ?) ORDER BY seq LIMIT 1")
        .get(now - OUTBOX_CLAIM_MS) as { seq: number; event_id: string; event: string; payload: string } | undefined;
      if (!candidate) return undefined;
      const claimed = db.prepare("UPDATE lifecycle_event_outbox SET claimed_by = ?, claimed_at = ? WHERE event_id = ? AND projected_at IS NULL AND (claimed_at IS NULL OR claimed_at <= ?)")
        .run(ownerId, now, candidate.event_id, now - OUTBOX_CLAIM_MS);
      return claimed.changes === 1 ? candidate : undefined;
    });
    if (!row) return projected;
    appendEventOnce(row.event_id, row.event, JSON.parse(row.payload) as Record<string, unknown>);
    outboxAfterAppendForTest?.();
    withLedgerAndStorage((_data, db) => {
      db.prepare("UPDATE lifecycle_event_outbox SET projected_at = ? WHERE event_id = ? AND claimed_by = ? AND projected_at IS NULL")
        .run(now, row.event_id, ownerId);
    });
    projected++;
  }
}

/**
 * NDJSON is a repairable projection, never authority. A projection fault must
 * not alter an already-committed MCP success or suppress durable scheduling.
 */
export function repairLifecycleOutbox(ownerId: string = randomUUID(), now: number = Date.now()): { projected: number; error?: string } {
  try {
    return { projected: projectLifecycleOutbox(ownerId, now) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Agent Mesh lifecycle outbox projection deferred; SQLite remains authoritative: ${detail}`);
    return { projected: 0, error: detail };
  }
}

export class LifecycleExecutionCoordinator {
  readonly ownerId: string;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly terminatePid: (pid: number) => void;
  private readonly beforeRuntimeStart?: () => void;
  private readonly handles = new Map<string, RuntimeHandle>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly runtime: RuntimeAdapter, options: LifecycleExecutionCoordinatorOptions = {}) {
    this.ownerId = options.ownerId ?? randomUUID();
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.terminatePid = options.terminatePid ?? ((pid) => { try { process.kill(pid, "SIGTERM"); } catch { /* diagnostic containment only */ } });
    this.beforeRuntimeStart = options.beforeRuntimeStart;
  }

  modeForFleet(fleetId: string): LifecycleMode {
    return withLedgerAndStorage((_data, db) => modeFor(db, fleetId));
  }

  recordMode(fleetId: string, mode: LifecycleMode): void {
    withLedgerAndStorage((_data, db) => persistMode(db, fleetId, mode));
  }

  createFleet(fleetId: string, specs: DurableAgentSpec[]): void {
    withLedgerAndStorage((data, db) => {
      persistMode(db, fleetId, "durable");
      _createFleet(data, fleetId);
      const store = lifecycle(db, this.now);
      for (const spec of specs) {
        _registerAgent(data, { id: spec.agentId, fleet_id: fleetId, role: spec.role, prompt: spec.prompt, agent_file: spec.agentFile, status: "pending" });
        const initial = store.createWork({ workId: spec.agentId, fleetId, agentId: spec.agentId, maxAttempts: this.maxAttempts, retryBaseMs: this.retryBaseMs });
        const lease = store.acquireLease({ workId: spec.agentId, attemptId: initial.attempts[0].attempt_id, ownerId: this.ownerId, leaseMs: this.leaseMs });
        if (!lease.accepted) throw new Error(`durable lifecycle lease acquisition failed for ${spec.agentId}`);
      }
      queueEvent(db, "fleet_created", { fleet_id: fleetId }, this.now());
      queueEvent(db, "spawn_fleet_called", { fleet_id: fleetId, agent_count: specs.length }, this.now());
    });
    repairLifecycleOutbox(this.ownerId, this.now());
    for (const spec of specs) this.launch(spec.agentId);
    this.scheduleRecoveryWake();
  }

  attachAgent(spec: DurableAgentSpec): { error?: string } {
    const result = withLedgerAndStorage((data, db): { error?: string } => {
      const target = data.fleets[spec.fleetId];
      if (!target) return { error: `Fleet ${spec.fleetId} not found` };
      if (modeFor(db, spec.fleetId) !== "durable") return { error: `Fleet ${spec.fleetId} is not durable` };
      if (target.status !== "running") return { error: `Fleet ${spec.fleetId} is ${target.status}, not running` };
      _registerAgent(data, { id: spec.agentId, fleet_id: spec.fleetId, role: spec.role, prompt: spec.prompt, agent_file: spec.agentFile, status: "pending" });
      const store = lifecycle(db, this.now);
      const initial = store.createWork({ workId: spec.agentId, fleetId: spec.fleetId, agentId: spec.agentId, maxAttempts: this.maxAttempts, retryBaseMs: this.retryBaseMs });
      const lease = store.acquireLease({ workId: spec.agentId, attemptId: initial.attempts[0].attempt_id, ownerId: this.ownerId, leaseMs: this.leaseMs });
      if (!lease.accepted) return { error: "durable lifecycle lease acquisition failed" };
      return {};
    });
    if (!result.error) this.launch(spec.agentId);
    return result;
  }

  recover(): void {
    if (this.stopped) return;
    const expiredPids = withLedgerAndStorage((_data, db) => lifecycle(db, this.now).expiredRuntimePids());
    for (const { pid } of expiredPids) this.terminatePid(pid);
    const recovered = withLedgerAndStorage((data, db) => {
      const states = lifecycle(db, this.now).recoverExpired();
      for (const state of states) {
        this.projectPending(data, state);
        const agent = state.work.agent_id ? data.agents[state.work.agent_id] : undefined;
        if (!agent) continue;
        if (state.work.status === "pending") {
          const current = state.attempts.find((attempt) => attempt.attempt_id === state.work.current_attempt_id);
          queueEvent(db, "agent_retry_scheduled", { agent_id: agent.id, from_attempt: state.attempts.length - 1, to_attempt: state.attempts.length, delay_ms: Math.max(0, (current?.eligible_at ?? this.now()) - this.now()), last_error: "lease expired", timestamp: this.now() }, this.now());
        } else if (state.work.status === "failed") {
          const quarantined = String(state.work.error ?? "").includes("launch intent expired before durable handle registration");
          queueEvent(db, quarantined ? "agent_launch_quarantined" : "agent_failed_permanent", { agent_id: agent.id, attempts: state.attempts.length, last_error: agent.error, timestamp: this.now() }, this.now());
        }
      }
      return states;
    });
    void recovered;
    this.launchDue();
    this.scheduleRecoveryWake();
    repairLifecycleOutbox(this.ownerId, this.now());
  }

  /** Stop local scheduling and best-effort cancel only this process's handles. */
  stop(): void {
    this.stopped = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const handle of this.handles.values()) void this.runtime.cancel(handle, "coordinator stopped");
    this.handles.clear();
  }

  private launchDue(): void {
    if (this.stopped) return;
    const ids = withLedgerAndStorage((_data, db) => lifecycle(db, this.now).dueWork().map((state) => state.work.work_id));
    for (const agentId of ids) this.claimAndLaunch(agentId);
  }

  private claimAndLaunch(agentId: string): void {
    if (this.stopped) return;
    const claimed = withLedgerAndStorage((data, db) => {
      const store = lifecycle(db, this.now);
      const state = store.getState(agentId);
      if (!state) return false;
      const current = state.attempts.find((attempt) => attempt.attempt_id === state.work.current_attempt_id);
      if (!current) return false;
      const lease = store.acquireLease({ workId: agentId, attemptId: current.attempt_id, ownerId: this.ownerId, leaseMs: this.leaseMs });
      if (!lease.accepted) return false;
      const agent = data.agents[agentId];
      if (agent) agent.status = "pending";
      return true;
    });
    if (claimed) this.launch(agentId);
  }

  private launch(agentId: string): void {
    if (this.stopped) return;
    if (this.handles.has(agentId)) return;
    const state = withLedgerAndStorage((data, db) => {
      const current = lifecycle(db, this.now).getState(agentId);
      if (!current) return undefined;
      const currentAttempt = current.attempts.find((attempt) => attempt.attempt_id === current.work.current_attempt_id);
      if (!currentAttempt || currentAttempt.owner_id !== this.ownerId || currentAttempt.status !== "running") return undefined;
      const intended = lifecycle(db, this.now).markLaunchIntent({ workId: agentId, attemptId: currentAttempt.attempt_id, ownerId: this.ownerId, ownerEpoch: currentAttempt.owner_epoch });
      if (!intended.accepted) return undefined;
      const agent = data.agents[agentId];
      if (agent) queueEvent(db, "agent_launch_intended", { fleet_id: agent.fleet_id, agent_id: agentId, attempt_id: currentAttempt.attempt_id }, this.now());
      return { state: intended.state, agent };
    });
    if (!state || !state.agent) return;
    const current = state.state.attempts.find((attempt) => attempt.attempt_id === state.state.work.current_attempt_id);
    if (!current || current.owner_id !== this.ownerId || current.status !== "running") return;
    const spec = { fleetId: state.agent.fleet_id, agentId, role: state.agent.role, prompt: state.agent.prompt, requestedAgent: state.agent.agent_file, cwd: process.cwd(), timeoutMs: this.runtime.describe().defaultTimeoutMs };
    this.beforeRuntimeStart?.();
    void this.runtime.start(spec).then((handle) => {
      if (this.stopped) { void this.runtime.cancel(handle, "coordinator stopped before launch observation"); return; }
      const launched = withLedgerAndStorage((data, db) => {
        const store = lifecycle(db, this.now);
        const renewed = store.renewLease({ workId: agentId, attemptId: current.attempt_id, ownerId: this.ownerId, ownerEpoch: current.owner_epoch, leaseMs: this.leaseMs });
        if (!renewed.accepted) return false;
        const metadata = store.recordRuntimeMetadata({ workId: agentId, attemptId: current.attempt_id, ownerId: this.ownerId, ownerEpoch: current.owner_epoch, pid: handle.pid, metadata: { adapter_id: this.runtime.id, handle_id: handle.id, observed_at: this.now() } });
        if (!metadata.accepted) return false;
        const agent = data.agents[agentId];
        if (!agent) return false;
        agent.status = "running";
        agent.started_at = this.now();
        if (handle.pid !== undefined) agent.pid = handle.pid;
        queueEvent(db, "agent_spawned", { fleet_id: agent.fleet_id, agent_id: agentId, role: agent.role, agent_file: agent.agent_file }, this.now());
        return true;
      });
      if (!launched) { void this.runtime.cancel(handle, "lease lost before launch observation"); return; }
      this.handles.set(agentId, handle);
      this.startRenewal(agentId, current.attempt_id, current.owner_epoch, handle);
      void this.runtime.wait(handle)
        .then((result) => this.settle(agentId, current.attempt_id, current.owner_epoch, result))
        .catch((error: unknown) => this.settle(agentId, current.attempt_id, current.owner_epoch, {
          status: "failure", stdout: "", stderr: "", exitCode: null, error: redact(error), diagnostics: [], identity: { adapterId: this.runtime.id, evidence: "none" },
        }));
    }).catch((error: unknown) => this.settle(agentId, current.attempt_id, current.owner_epoch, {
      status: "failure", stdout: "", stderr: "", exitCode: null, error: redact(error), diagnostics: [], identity: { adapterId: this.runtime.id, evidence: "none" },
    }));
  }

  private startRenewal(agentId: string, attemptId: string, epoch: number, handle: RuntimeHandle): void {
    const timer = setInterval(() => {
      if (this.stopped) { clearInterval(timer); return; }
      const renewed = withLedgerAndStorage((_data, db) => lifecycle(db, this.now).renewLease({ workId: agentId, attemptId, ownerId: this.ownerId, ownerEpoch: epoch, leaseMs: this.leaseMs }).accepted);
      if (!renewed) { clearInterval(timer); void this.runtime.cancel(handle, "lease lost"); }
      else this.scheduleRecoveryWake();
    }, Math.max(1, Math.floor(this.leaseMs / 2)));
    timer.unref?.();
    this.timers.set(agentId, timer);
  }

  private settle(agentId: string, attemptId: string, epoch: number, result: RuntimeResult): void {
    if (this.stopped) return;
    const timer = this.timers.get(agentId);
    if (timer) clearInterval(timer);
    this.timers.delete(agentId);
    this.handles.delete(agentId);
    const settled = withLedgerAndStorage((data, db) => {
      const store = lifecycle(db, this.now);
      const success = result.status === "success";
      const output = redact(result.stdout);
      const outcome = success ? store.settle({ workId: agentId, attemptId, ownerId: this.ownerId, ownerEpoch: epoch, outcome: "success", result: output })
        : store.settleWithRetry({ workId: agentId, attemptId, ownerId: this.ownerId, ownerEpoch: epoch, outcome: "failure", result: output, error: redact(result.error ?? result.stderr) });
      if (!outcome.accepted) return undefined;
      this.projectPending(data, outcome.state, result);
      const agent = data.agents[agentId];
      if (agent) {
        if (outcome.state.work.status === "succeeded") queueEvent(db, "agent_completed", { fleet_id: agent.fleet_id, agent_id: agentId }, this.now());
        if (outcome.state.work.status === "failed") queueEvent(db, "agent_failed_permanent", { agent_id: agentId, attempts: outcome.state.attempts.length, last_error: agent.error, timestamp: this.now() }, this.now());
        if (outcome.state.work.status === "pending") queueEvent(db, "agent_retry_scheduled", { agent_id: agentId, from_attempt: outcome.state.attempts.length - 1, to_attempt: outcome.state.attempts.length, delay_ms: Math.max(0, (outcome.state.attempts.at(-1)?.eligible_at ?? this.now()) - this.now()), last_error: agent.error, timestamp: this.now() }, this.now());
      }
      return outcome.state;
    });
    if (!settled) return; // stale completion is a no-op, including projections.
    const next = settled.attempts.find((attempt) => attempt.attempt_id === settled.work.current_attempt_id);
    if (next?.status === "pending") this.scheduleDue(agentId, next.eligible_at);
    this.scheduleRecoveryWake();
    repairLifecycleOutbox(this.ownerId, this.now());
  }

  private projectPending(data: MeshData, state: LifecycleState, result?: RuntimeResult): void {
    const agent = state.work.agent_id ? data.agents[state.work.agent_id] : undefined;
    if (!agent) return;
    const current = state.attempts.find((attempt) => attempt.attempt_id === state.work.current_attempt_id);
    agent.retry_count = Math.max(0, (current?.attempt_number ?? state.attempts.length) - 1);
    if (state.work.status === "pending") { agent.status = "pending"; agent.error = state.work.error === undefined ? undefined : redact(state.work.error); return; }
    if (state.work.status === "succeeded" || state.work.status === "failed" || state.work.status === "cancelled") {
      agent.status = state.work.status === "succeeded" ? "complete" : "failed";
      agent.output = typeof state.work.result === "string" ? state.work.result : "";
      agent.error = state.work.error === undefined ? undefined : redact(state.work.error);
      if (result?.identity.agent) agent.runtime_agent = result.identity.agent;
      if (result?.identity.model) agent.runtime_model = result.identity.model;
      agent.completed_at = this.now();
      _checkFleetCompletion(data, agent.fleet_id);
    }
  }

  private scheduleDue(agentId: string, eligibleAt: number): void {
    if (this.stopped) return;
    const existing = this.timers.get(`due:${agentId}`);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => { this.timers.delete(`due:${agentId}`); this.claimAndLaunch(agentId); }, Math.max(0, eligibleAt - this.now()));
    timer.unref?.();
    this.timers.set(`due:${agentId}`, timer);
  }

  private scheduleRecoveryWake(): void {
    if (this.stopped) return;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    const wakeAt = withLedgerAndStorage((_data, db) => lifecycle(db, this.now).nextWakeAt());
    if (wakeAt === null) { this.recoveryTimer = undefined; return; }
    this.recoveryTimer = setTimeout(() => this.recover(), Math.max(0, wakeAt - this.now()));
    this.recoveryTimer.unref?.();
  }
}
