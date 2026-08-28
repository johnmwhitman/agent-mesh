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
  getFleetTimeoutMs,
  readAppendedEventIds,
  loadData,
  type Agent,
  type FleetTimedOutAgent,
  type MeshData,
} from "./core.js";
import { LifecycleStore, type LifecycleState } from "./attempt-lifecycle.js";
import type { RuntimeAdapter, RuntimeHandle, RuntimeResult } from "./runtime/types.js";
import { containRecordedProcess } from "./runtime/process.js";
import { projectSuccessDiagnostics } from "./spawn-attempt.js";
import { isHollowSuccess, HOLLOW_SUCCESS_REASON } from "./hollow-result.js";
import {
  readResultContractEvidence,
  resultPathFor,
  withResultContract,
  type ResultContractStatus,
} from "./result-contract.js";

export type LifecycleMode = "legacy" | "shadow" | "durable";
export interface DurableAgentSpec {
  fleetId: string;
  agentId: string;
  role: string;
  prompt: string;
  agentFile?: string;
  requestedModel?: string;
  /** Caller-declared: the envelope must name at least one produced file (see Agent.expects_artifact). */
  expectsArtifact?: boolean;
}
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
  /** Notify the process-level deadline scheduler after a durable agent changes state. */
  onAgentStateChange?: (fleetId: string) => void;
}

interface TrackedRuntimeHandle {
  handle: RuntimeHandle;
  attemptId: string;
  ownerEpoch: number;
}

interface DurableTimedOutAgent extends FleetTimedOutAgent {
  attemptId: string;
  ownerEpoch: number;
  runtimePid?: number;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 1_000;
let outboxAfterAppendForTest: (() => void) | undefined;
let outboxBeforeCommitForTest: (() => void) | undefined;

/** Test-only crash-window seam: invoked after append and before SQLite acknowledgement. */
export function setOutboxAfterAppendForTest(hook: (() => void) | undefined): void {
  outboxAfterAppendForTest = hook;
}

/** Test-only seam held inside the serialized SQLite projection transaction. */
export function setOutboxBeforeCommitForTest(hook: (() => void) | undefined): void {
  outboxBeforeCommitForTest = hook;
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
  void ownerId;
  let projected = 0;
  // ONE read of the event log for the whole drain, not one per row. The dedupe
  // below used to re-read the entire file inside the write-lock-holding
  // transaction for every candidate — O(rows × log size), measured at 10.2 ms
  // per row on a real 18 MB log. Correctness is unchanged: the only thing this
  // dedupe protects against is a previous projector that appended and then died
  // before marking the row, and that append predates this drain, so a snapshot
  // taken here sees it. See readAppendedEventIds for the concurrency argument.
  const seen = readAppendedEventIds();
  while (true) {
    const row = withLedgerAndStorage((_data, db) => {
      // Keep selection, event-id dedupe/append, and the durable acknowledgement
      // in ONE BEGIN IMMEDIATE transaction. A competing single-host projector
      // blocks here; it can never overtake an earlier seq or append concurrently.
      const candidate = db.prepare("SELECT seq, event_id, event, payload FROM lifecycle_event_outbox WHERE projected_at IS NULL ORDER BY seq LIMIT 1")
        .get() as { seq: number; event_id: string; event: string; payload: string } | undefined;
      if (!candidate) return undefined;
      appendEventOnce(candidate.event_id, candidate.event, JSON.parse(candidate.payload) as Record<string, unknown>, seen);
      outboxAfterAppendForTest?.();
      outboxBeforeCommitForTest?.();
      db.prepare("UPDATE lifecycle_event_outbox SET projected_at = ? WHERE event_id = ? AND projected_at IS NULL")
        .run(now, candidate.event_id);
      return candidate;
    });
    if (!row) return projected;
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
  private readonly onAgentStateChange?: (fleetId: string) => void;
  private readonly handles = new Map<string, TrackedRuntimeHandle>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly runtime: RuntimeAdapter, options: LifecycleExecutionCoordinatorOptions = {}) {
    this.ownerId = options.ownerId ?? randomUUID();
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.terminatePid = options.terminatePid ?? ((pid) => { containRecordedProcess(pid); });
    this.beforeRuntimeStart = options.beforeRuntimeStart;
    this.onAgentStateChange = options.onAgentStateChange;
  }

  modeForFleet(fleetId: string): LifecycleMode {
    return withLedgerAndStorage((_data, db) => modeFor(db, fleetId));
  }

  recordMode(fleetId: string, mode: LifecycleMode): void {
    withLedgerAndStorage((_data, db) => persistMode(db, fleetId, mode));
  }

  /**
   * Terminalize elapsed durable work through LifecycleStore before cancelling
   * this coordinator's matching runtime handles. This keeps attempt authority,
   * public agent projection, and the fleet aggregate in one SQLite transaction.
   */
  expireFleetTimeout(fleetId: string, now: number = this.now()): FleetTimedOutAgent[] {
    const timeoutMs = getFleetTimeoutMs(fleetId);
    const expired = withLedgerAndStorage((data, db): DurableTimedOutAgent[] => {
      if (modeFor(db, fleetId) !== "durable") return [];
      const store = lifecycle(db, () => now);
      const timedOut: DurableTimedOutAgent[] = [];
      for (const agent of Object.values(data.agents)) {
        if (
          agent.fleet_id !== fleetId ||
          agent.status !== "running" ||
          agent.started_at === undefined ||
          agent.started_at + timeoutMs > now
        ) continue;
        const state = store.getState(agent.id);
        const attemptId = state?.work.current_attempt_id;
        const current = attemptId
          ? state?.attempts.find((attempt) => attempt.attempt_id === attemptId)
          : undefined;
        if (!current) continue;
        const runtimeRow = db.prepare("SELECT runtime_pid FROM attempts WHERE attempt_id = ?")
          .get(current.attempt_id) as { runtime_pid: number | null } | undefined;
        const runtimePid = runtimeRow?.runtime_pid ?? undefined;
        const cancelled = store.cancel(agent.id);
        if (!cancelled.accepted) continue;
        this.projectPending(data, cancelled.state);
        const reason = `Fleet timeout exceeded after ${timeoutMs}ms`;
        const projected = data.agents[agent.id];
        if (projected) projected.error = reason;
        timedOut.push({
          agent_id: agent.id,
          fleet_id: fleetId,
          pid: runtimePid,
          reason,
          cancellation_attempted: true,
          attemptId: current.attempt_id,
          ownerEpoch: current.owner_epoch,
          runtimePid,
        });
        queueEvent(db, "agent_fleet_timeout", {
          agent_id: agent.id,
          fleet_id: fleetId,
          reason,
          timed_out_at: now,
        }, now);
      }
      return timedOut;
    });
    for (const agent of expired) {
      const dueTimer = this.timers.get(`due:${agent.agent_id}`);
      if (dueTimer) clearTimeout(dueTimer);
      this.timers.delete(`due:${agent.agent_id}`);
      const tracked = this.handles.get(agent.agent_id);
      const exactLocalOwner = tracked
        && tracked.attemptId === agent.attemptId
        && tracked.ownerEpoch === agent.ownerEpoch;
      if (exactLocalOwner) {
        this.releaseLocalHandle(agent.agent_id, agent.attemptId, agent.ownerEpoch, agent.reason);
        if (agent.runtimePid !== undefined && tracked.handle.pid !== agent.runtimePid) {
          this.terminatePid(agent.runtimePid);
        }
      } else {
        if (tracked) {
          this.forgetLocalHandle(agent.agent_id, tracked.attemptId, tracked.ownerEpoch);
          if (agent.runtimePid === undefined || tracked.handle.pid !== agent.runtimePid) {
            void this.runtime.cancel(tracked.handle, "stale durable handle after fleet timeout");
          }
        }
        if (agent.runtimePid !== undefined) this.terminatePid(agent.runtimePid);
      }
    }
    if (expired.length > 0) repairLifecycleOutbox(this.ownerId, now);
    return expired;
  }

  /** Re-arm runtime-owned hard ceilings for this coordinator's live handles. */
  updateFleetRuntimeTimeout(fleetId: string, timeoutMs: number): void {
    const data = loadData();
    for (const [agentId, tracked] of this.handles) {
      if (data.agents[agentId]?.fleet_id === fleetId) tracked.handle.updateTimeout?.(timeoutMs);
    }
  }

  createFleet(fleetId: string, specs: DurableAgentSpec[]): void {
    withLedgerAndStorage((data, db) => {
      persistMode(db, fleetId, "durable");
      _createFleet(data, fleetId);
      const store = lifecycle(db, this.now);
      for (const spec of specs) {
        _registerAgent(data, {
          id: spec.agentId,
          fleet_id: fleetId,
          role: spec.role,
          prompt: spec.prompt,
          agent_file: spec.agentFile,
          requested_model: spec.requestedModel,
          expects_artifact: spec.expectsArtifact,
          status: "pending",
        });
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
      _registerAgent(data, {
        id: spec.agentId,
        fleet_id: spec.fleetId,
        role: spec.role,
        prompt: spec.prompt,
        agent_file: spec.agentFile,
        requested_model: spec.requestedModel,
        expects_artifact: spec.expectsArtifact,
        status: "pending",
      });
      const store = lifecycle(db, this.now);
      const initial = store.createWork({ workId: spec.agentId, fleetId: spec.fleetId, agentId: spec.agentId, maxAttempts: this.maxAttempts, retryBaseMs: this.retryBaseMs });
      const lease = store.acquireLease({ workId: spec.agentId, attemptId: initial.attempts[0].attempt_id, ownerId: this.ownerId, leaseMs: this.leaseMs });
      if (!lease.accepted) return { error: "durable lifecycle lease acquisition failed" };
      return {};
    });
    if (!result.error) this.launch(spec.agentId);
    if (!result.error) this.scheduleRecoveryWake();
    return result;
  }

  recover(): void {
    if (this.stopped) return;
    // ONE clock read for the whole pass. Containment (expiredRuntimePids) and reclaim
    // (recoverExpired) run in separate transactions; when each read the clock for itself, a
    // lease expiring in the window between them was invisible to the first and visible to the
    // second. The result was work reclaimed and relaunched while its dead process was never
    // terminated — an orphan running alongside its own replacement. The recovery wake is armed
    // for exactly lease_until, so passes land on that boundary by design, which is what made
    // this reachable in practice rather than merely in theory.
    //
    // Freezing the clock makes the two queries agree by construction. A lease that expires
    // moments after `at` is simply caught by the next wake, which is correct: skipping a
    // reclaim is recoverable, reclaiming without containing is not.
    const at = this.now();
    const frozen = (): number => at;
    // A fleet deadline that elapsed while this process was down outranks lease
    // recovery. If recoverExpired() runs first it creates a retry and resets the
    // projected start state, erasing the outage interval before timeout can see
    // it. Terminalize all elapsed durable work against the same frozen clock
    // before reclaiming any lease.
    const durableFleetIds = withLedgerAndStorage((data, db) => Object.values(data.fleets)
      .filter((fleet) => fleet.status === "running" && modeFor(db, fleet.id) === "durable")
      .map((fleet) => fleet.id));
    for (const fleetId of durableFleetIds) this.expireFleetTimeout(fleetId, at);
    const expiredPids = withLedgerAndStorage((_data, db) => lifecycle(db, frozen).expiredRuntimePids());
    for (const { pid } of expiredPids) this.terminatePid(pid);
    const recovered = withLedgerAndStorage((data, db) => {
      const states = lifecycle(db, frozen).recoverExpired();
      for (const state of states) {
        this.projectPending(data, state);
        const agent = state.work.agent_id ? data.agents[state.work.agent_id] : undefined;
        if (!agent) continue;
        if (state.work.status === "pending") {
          const current = state.attempts.find((attempt) => attempt.attempt_id === state.work.current_attempt_id);
          queueEvent(db, "agent_retry_scheduled", { fleet_id: agent.fleet_id, agent_id: agent.id, from_attempt: state.attempts.length - 1, to_attempt: state.attempts.length, delay_ms: Math.max(0, (current?.eligible_at ?? this.now()) - this.now()), last_error: "lease expired", timestamp: this.now() }, this.now());
        } else if (state.work.status === "failed") {
          const quarantined = String(state.work.error ?? "").includes("launch intent expired before durable handle registration");
          queueEvent(db, quarantined ? "agent_launch_quarantined" : "agent_failed_permanent", { fleet_id: agent.fleet_id, agent_id: agent.id, attempts: state.attempts.length, last_error: agent.error, timestamp: this.now() }, this.now());
        }
      }
      return states;
    });
    void recovered;
    this.pruneStaleLocalHandles(at);
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
    for (const tracked of this.handles.values()) void this.runtime.cancel(tracked.handle, "coordinator stopped");
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
    const launchIntentAt = current.launch_intent_at ?? this.now();
    // Derived from the attempt id, never stored: `settle` recomputes the identical path from the
    // same two facts, so a restart between launch and settle cannot lose track of which file this
    // attempt was told to write. Per attempt, so a retry never inherits the previous declaration.
    const resultPath = resultPathFor(agentId, current.attempt_id);
    const spec = {
      fleetId: state.agent.fleet_id,
      agentId,
      role: state.agent.role,
      // The stored prompt stays the caller's text; the contract is appended only to what the
      // runtime is handed, so a retry rebuilt from the durable row never double-appends it.
      // The artifact expectation rides the durable row for the same reason the model does:
      // a retry must be taught the same contract the first attempt was.
      prompt: withResultContract(state.agent.prompt, resultPath, state.agent.expects_artifact === true),
      environment: { RESULT_PATH: resultPath },
      requestedAgent: state.agent.agent_file,
      // Always reconstruct from the durable Agent row so retries and recovery
      // survive process restarts; never rely solely on the original in-memory spec.
      requestedModel: state.agent.requested_model,
      cwd: process.cwd(),
      timeoutMs: getFleetTimeoutMs(state.agent.fleet_id),
    };
    this.beforeRuntimeStart?.();
    void this.runtime.start(spec).then((handle) => {
      if (this.stopped) { void this.runtime.cancel(handle, "coordinator stopped before launch observation"); return; }
      const observedAt = this.now();
      const handleStartIsAdmissible = Number.isSafeInteger(handle.startedAt)
        && handle.startedAt >= launchIntentAt
        && handle.startedAt <= observedAt;
      const runtimeStartedAt = handleStartIsAdmissible ? handle.startedAt : launchIntentAt;
      const launched = withLedgerAndStorage((data, db) => {
        const store = lifecycle(db, this.now);
        const renewed = store.renewLease({ workId: agentId, attemptId: current.attempt_id, ownerId: this.ownerId, ownerEpoch: current.owner_epoch, leaseMs: this.leaseMs });
        if (!renewed.accepted) return false;
        const metadata = store.recordRuntimeMetadata({ workId: agentId, attemptId: current.attempt_id, ownerId: this.ownerId, ownerEpoch: current.owner_epoch, pid: handle.pid, metadata: { adapter_id: this.runtime.id, handle_id: handle.id, observed_at: observedAt } });
        if (!metadata.accepted) return false;
        const agent = data.agents[agentId];
        if (!agent) return false;
        agent.status = "running";
        agent.started_at = runtimeStartedAt;
        if (handle.pid !== undefined) agent.pid = handle.pid;
        queueEvent(db, "agent_spawned", { fleet_id: agent.fleet_id, agent_id: agentId, role: agent.role, agent_file: agent.agent_file }, observedAt);
        return true;
      });
      if (!launched) { void this.runtime.cancel(handle, "lease lost before launch observation"); return; }
      try {
        // set_fleet_timeout may have changed while runtime.start() was pending,
        // before this handle was reachable through the live-handle map.
        handle.updateTimeout?.(getFleetTimeoutMs(state.agent.fleet_id));
      } catch (error) {
        void this.runtime.cancel(handle, "failed to apply current fleet timeout after launch");
        this.settle(agentId, current.attempt_id, current.owner_epoch, {
          status: "failure",
          stdout: "",
          stderr: "",
          exitCode: null,
          error: redact(error),
          diagnostics: [],
          identity: { adapterId: this.runtime.id, evidence: "none" },
        });
        return;
      }
      this.handles.set(agentId, { handle, attemptId: current.attempt_id, ownerEpoch: current.owner_epoch });
      this.startRenewal(agentId, current.attempt_id, current.owner_epoch, handle);
      this.onAgentStateChange?.(state.agent.fleet_id);
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
      if (!renewed) this.releaseLocalHandle(agentId, attemptId, epoch, "lease lost");
      else this.scheduleRecoveryWake();
    }, Math.max(1, Math.floor(this.leaseMs / 2)));
    timer.unref?.();
    this.timers.set(agentId, timer);
  }

  private settle(agentId: string, attemptId: string, epoch: number, result: RuntimeResult): void {
    if (this.stopped) return;
    if (result.status === "timeout") {
      this.settleRuntimeTimeout(agentId, attemptId, epoch);
      return;
    }
    const tracked = this.handles.get(agentId);
    if (tracked?.attemptId === attemptId && tracked.ownerEpoch === epoch) {
      const timer = this.timers.get(agentId);
      if (timer) clearInterval(timer);
      this.timers.delete(agentId);
      this.handles.delete(agentId);
    }
    // Read OUTSIDE the ledger transaction: a filesystem read inside it would hold the write lock
    // for as long as the disk takes, and the value decides nothing this release anyway.
    // The expectation is read from the durable row — the same source a retry's teaching used —
    // so the ladder judges the envelope against what the agent was actually told.
    const expectsArtifact = loadData().agents[agentId]?.expects_artifact === true;
    const resultEvidence = result.resultContract === undefined
      ? readResultContractEvidence(resultPathFor(agentId, attemptId), { cwd: process.cwd(), expectsArtifact })
      : { status: result.resultContract };
    const settled = withLedgerAndStorage((data, db) => {
      const store = lifecycle(db, this.now);
      // HOLLOW SUCCESS (2026-08-01): exit 0 with no output at all is not success.
      // A runtime can burn its whole turn on tool calls and never emit a final
      // answer; settling that as `succeeded` claims work that never happened, and
      // it is invisible downstream because an empty result reads exactly like a
      // real one. Route it through the SAME retry path as a failure — which in
      // this durable coordinator is what a transient runtime fault already gets —
      // so the attempt can be re-run or failed over rather than silently banked.
      const hollow = isHollowSuccess(result);
      const success = result.status === "success" && !hollow;
      const output = redact(result.stdout);
      const hollowError = HOLLOW_SUCCESS_REASON;
      const outcome = success ? store.settle({ workId: agentId, attemptId, ownerId: this.ownerId, ownerEpoch: epoch, outcome: "success", result: output })
        : store.settleWithRetry({ workId: agentId, attemptId, ownerId: this.ownerId, ownerEpoch: epoch, outcome: "failure", result: output, error: redact(hollow ? hollowError : (result.error ?? result.stderr)) });
      if (!outcome.accepted) return undefined;
      this.projectPending(data, outcome.state, result, resultEvidence.status, resultEvidence.resultArtifacts);
      const agent = data.agents[agentId];
      if (agent) {
        if (outcome.state.work.status === "succeeded") queueEvent(db, "agent_completed", { fleet_id: agent.fleet_id, agent_id: agentId }, this.now());
        if (outcome.state.work.status === "failed") queueEvent(db, "agent_failed_permanent", { fleet_id: agent.fleet_id, agent_id: agentId, attempts: outcome.state.attempts.length, last_error: agent.error, timestamp: this.now() }, this.now());
        if (outcome.state.work.status === "pending") queueEvent(db, "agent_retry_scheduled", { fleet_id: agent.fleet_id, agent_id: agentId, from_attempt: outcome.state.attempts.length - 1, to_attempt: outcome.state.attempts.length, delay_ms: Math.max(0, (outcome.state.attempts.at(-1)?.eligible_at ?? this.now()) - this.now()), last_error: agent.error, timestamp: this.now() }, this.now());
      }
      return outcome.state;
    });
    if (!settled) return; // stale completion is a no-op, including projections.
    const settledFleetId = loadData().agents[agentId]?.fleet_id;
    if (settledFleetId) this.onAgentStateChange?.(settledFleetId);
    const next = settled.attempts.find((attempt) => attempt.attempt_id === settled.work.current_attempt_id);
    if (next?.status === "pending") this.scheduleDue(agentId, next.eligible_at);
    this.scheduleRecoveryWake();
    repairLifecycleOutbox(this.ownerId, this.now());
  }

  /**
   * A runtime timeout is direct evidence that this attempt's already-armed hard
   * ceiling fired. Terminalize only that still-owned attempt: re-reading the
   * fleet override here would let a late extension turn an in-flight shutdown
   * into a retry, while expiring the whole fleet could fail unrelated agents.
   */
  private settleRuntimeTimeout(agentId: string, attemptId: string, epoch: number): void {
    const now = this.now();
    const reason = "Fleet runtime timeout elapsed";
    const fleetId = withLedgerAndStorage((data, db) => {
      const agent = data.agents[agentId];
      if (!agent) return undefined;
      const store = lifecycle(db, () => now);
      const state = store.getState(agentId);
      const current = state?.attempts.find((attempt) => attempt.attempt_id === state.work.current_attempt_id);
      if (
        !state ||
        state.work.status !== "running" ||
        state.work.current_attempt_id !== attemptId ||
        state.work.owner_epoch !== epoch ||
        !current ||
        current.status !== "running" ||
        current.owner_id !== this.ownerId ||
        current.owner_epoch !== epoch ||
        current.lease_until === null ||
        current.lease_until <= now
      ) return undefined;
      const cancelled = store.cancel(agentId);
      if (!cancelled.accepted) return undefined;
      this.projectPending(data, cancelled.state);
      agent.error = reason;
      queueEvent(db, "agent_fleet_timeout", {
        agent_id: agentId,
        fleet_id: agent.fleet_id,
        reason,
        timed_out_at: now,
      }, now);
      return agent.fleet_id;
    });
    const tracked = this.handles.get(agentId);
    if (tracked?.attemptId === attemptId && tracked.ownerEpoch === epoch) {
      const timer = this.timers.get(agentId);
      if (timer) clearInterval(timer);
      this.timers.delete(agentId);
      this.handles.delete(agentId);
    }
    if (!fleetId) return; // stale timeout callbacks never affect a replacement attempt.
    this.onAgentStateChange?.(fleetId);
    this.scheduleRecoveryWake();
    repairLifecycleOutbox(this.ownerId, now);
  }

  private projectPending(
    data: MeshData,
    state: LifecycleState,
    result?: RuntimeResult,
    resultContract?: ResultContractStatus,
    resultArtifacts?: readonly string[],
  ): void {
    const agent = state.work.agent_id ? data.agents[state.work.agent_id] : undefined;
    if (!agent) return;
    const current = state.attempts.find((attempt) => attempt.attempt_id === state.work.current_attempt_id);
    agent.retry_count = Math.max(0, (current?.attempt_number ?? state.attempts.length) - 1);
    if (state.work.status === "pending") { agent.status = "pending"; agent.error = state.work.error === undefined ? undefined : redact(state.work.error); return; }
    if (state.work.status === "succeeded" || state.work.status === "failed" || state.work.status === "cancelled") {
      agent.status = state.work.status === "succeeded" ? "complete" : "failed";
      agent.output = typeof state.work.result === "string" ? state.work.result : "";
      agent.error = state.work.error === undefined ? undefined : redact(state.work.error);
      agent.diagnostics = state.work.status === "succeeded" && result
        ? projectSuccessDiagnostics(result.diagnostics)
        : undefined;
      if (result?.identity.agent) agent.runtime_agent = result.identity.agent;
      if (result?.identity.model) agent.runtime_model = result.identity.model;
      // Recorded on both terminal statuses, and only where an attempt actually ran — a projection
      // reached during recovery, with no result to speak of, leaves the field as it found it.
      if (resultContract !== undefined) agent.result_contract = resultContract;
      if (resultArtifacts !== undefined) agent.result_artifacts = [...resultArtifacts];
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

  private forgetLocalHandle(
    agentId: string,
    attemptId: string,
    ownerEpoch: number,
  ): TrackedRuntimeHandle | undefined {
    const tracked = this.handles.get(agentId);
    if (!tracked || tracked.attemptId !== attemptId || tracked.ownerEpoch !== ownerEpoch) return undefined;
    const timer = this.timers.get(agentId);
    if (timer) clearInterval(timer);
    this.timers.delete(agentId);
    this.handles.delete(agentId);
    return tracked;
  }

  private releaseLocalHandle(agentId: string, attemptId: string, ownerEpoch: number, reason: string): void {
    const tracked = this.forgetLocalHandle(agentId, attemptId, ownerEpoch);
    if (!tracked) return;
    void this.runtime.cancel(tracked.handle, reason);
  }

  private pruneStaleLocalHandles(now: number): void {
    const trackedHandles = [...this.handles];
    const stale = withLedgerAndStorage((_data, db) => {
      const currentAttempt = db.prepare(`
        SELECT w.status AS work_status, w.owner_epoch AS work_owner_epoch,
               a.status AS attempt_status,
               a.owner_id, a.owner_epoch, a.lease_until
          FROM work_items w
          JOIN attempts a ON a.attempt_id = w.current_attempt_id
         WHERE w.work_id = ? AND a.attempt_id = ?
      `);
      return trackedHandles.filter(([agentId, tracked]) => {
        const current = currentAttempt.get(agentId, tracked.attemptId) as {
          work_status: string;
          work_owner_epoch: number;
          attempt_status: string;
          owner_id: string | null;
          owner_epoch: number;
          lease_until: number | null;
        } | undefined;
        const stillOwned =
          current?.work_status === "running"
          && current.attempt_status === "running"
          && current.owner_id === this.ownerId
          && current.owner_epoch === tracked.ownerEpoch
          && current.work_owner_epoch === tracked.ownerEpoch
          && current.lease_until !== null
          && current.lease_until > now;
        return !stillOwned;
      });
    });
    for (const [agentId, tracked] of stale) {
      this.releaseLocalHandle(agentId, tracked.attemptId, tracked.ownerEpoch, "durable lease expired");
    }
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
