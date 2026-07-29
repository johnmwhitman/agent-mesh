/**
 * Discussion reservation/wake/reply store — INTERFACE + TYPES ONLY (D2 pre-stage).
 *
 * This module defines the contract the D2 red-test suite
 * (test/discussion-reservation.test.ts) is written against:
 * `createDiscussionStore(deps)`. Implementation is D2 proper (post-landing);
 * `createDiscussionStore` here is a throwing stub so the red suite fails ONLY
 * on "not implemented" — never on a type error, never on an accidental pass.
 *
 * Sources:
 *   - SUCCESSION/a2a-discussions/lane-1-cdx-discussions-api-design.md
 *     (§§6-14: wire convention, transcript derivation, turn receipts, reply
 *     rendezvous, resident mode, MCP surface, invariants, failure handling).
 *   - SUCCESSION/a2a-discussions/drafts/d3-wiring-blueprint.md (the handler
 *     transaction-boundary design D2's store is built to be driven by).
 *   - SUCCESSION/a2a-discussions/drafts/cdx-author-review.md H0.2/H0.3 (the
 *     fix-list this contract is shaped to make testable: real concurrency via
 *     injectable barriers/independent transactions, a real handler with
 *     injectable spawn/kill/clock/txn failures, exact error codes with
 *     before/after zero-mutation snapshots, exact receipt-action parsing,
 *     rollback failpoints, a `withLedger`-spy seam for sync-callback
 *     enforcement, and guard coverage for quota/kill-switch/escalation).
 *
 * Five seams are independently injectable so tests can prove real properties
 * instead of scripting them:
 *   - ledger: a synchronous, side-effect-free transaction executor mirroring
 *     src/db.ts's `withLedger` contract (spec §13 invariant 20: "Ledger
 *     transactions contain no waiting, networking, spawn, or SSE
 *     notification"; test 52: "No asynchronous callback is returned from
 *     `withLedger`").
 *   - spawn / kill: the one-shot child-process launcher and its deadman kill
 *     path (§10; blueprint §2 "central one-shot launcher").
 *   - clock: the single injected time source, so deadline/deadman/quota-window
 *     tests are deterministic instead of racing wall-clock time.
 *   - notify: best-effort, post-commit-only SSE notification (§13 invariants
 *     21/22; test 51: "Notification occurs only after commit").
 */

import { randomUUID } from "crypto";
import { BROADCAST, type Message, type Receipt } from "./core.js";
import {
  deriveDiscussion,
  validatePayloadSize,
  parseReceiptAction,
  DISCUSSION_MAX_PAYLOAD_BYTES,
  MIN_MAX_TURNS,
  MAX_MAX_TURNS,
  MIN_TURN_TIMEOUT_MS,
  MAX_TURN_TIMEOUT_MS,
  type DerivedDiscussion,
  type Envelope,
  type Policy,
  type TranscriptEntry,
  type WakeState,
} from "./discussion.js";

// ============================================================
// Ledger transaction seam
// ============================================================

/** The shape of a brand-new durable message before the ledger assigns/accepts it. */
export interface NewMessage {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  fleet_id: string;
  type: Message["type"];
  payload: string;
  correlation_id?: string;
  timestamp: number;
}

/**
 * The mutable view a `ledger` mutator sees and writes through. Deliberately
 * narrow — only what discussion reservation/reply logic needs — so a fake
 * implementation in tests can be a plain in-memory object without pulling in
 * src/db.ts's full `MeshData`/SQLite machinery.
 *
 * `now()` is the TRANSACTION-OBSERVED clock (blueprint §4 step "re-read
 * transaction clock") — a correct implementation derives it from the same
 * injected `DiscussionStoreDeps.clock`, re-read fresh inside the transaction
 * rather than trusting a value captured before entry (blueprint §5 step 3
 * "Capture server clock" happens before the transaction; step 1 inside it
 * re-reads).
 */
export interface LedgerTx {
  now(): number;
  agentExists(agentId: string, fleetId: string): boolean;
  /**
   * Read-only launch lookup the reservation/start transaction uses to copy a
   * selected participant's persisted `agent_file` and `requested_model` into
   * the `SpawnJob` — keeping the Discussion wake path aligned with the same
   * selection the original `spawn_fleet`/`attach_agent` call recorded, with
   * no path for the caller to override either field through Discussion tools.
   * Returns `undefined` when no such agent exists in `fleetId`; both fields
   * are individually optional (the absence of one is a legitimate selection,
   * never a fallback trigger).
   */
  agentLaunchConfig(
    agentId: string,
    fleetId: string
  ): { requestedAgent?: string; requestedModel?: string } | undefined;
  getMessage(messageId: string): Message | undefined;
  messagesByCorrelation(discussionId: string): Message[];
  receiptsForMessage(messageId: string): Receipt[];
  allReceiptsForDiscussion(discussionId: string): Receipt[];
  /** Appends one durable message. A correct implementation and a correct fake
   *  both reject a colliding id — server-generated ids should never collide
   *  in practice; this is the seam a test uses to force the internal
   *  "regenerate and retry on UUID collision" path (spec §11 step 5). */
  appendMessage(input: NewMessage): Message;
  /** Idempotent per (message_id, agent_id, action) — mirrors core.ts's
   *  `_writeReceipt`: a duplicate write returns the existing receipt rather
   *  than creating a second one (test 47). */
  writeReceipt(messageId: string, agentId: string, action: string, note?: string): Receipt;
  /** Count of `discussion.wake.reserved.v1:*` receipts for `agentId` with
   *  timestamp in `[windowStartMs, nowMs]` — the rolling-hour quota guard's
   *  data source (blueprint §0 "Guard configuration"). */
  countRecentWakeReservations(agentId: string, windowStartMs: number, nowMs: number): number;
}

/**
 * Executes `mutator` inside one atomic transaction and returns its result.
 * MUST be synchronous end-to-end: `mutator` may not await, return a Promise,
 * spawn, notify, or perform network I/O (spec §13 invariant 20; test 52).
 * Concurrent callers are serialized — the real implementation via SQLite
 * `BEGIN IMMEDIATE`, a fake implementation via synchronous run-to-completion
 * over a copy-on-write draft — so that a mutator which fails partway through
 * leaves NO partial mutation visible to the next caller (tests 49/50), and
 * two overlapping logical callers (tests 27/44) never both observe the
 * pre-mutation state.
 */
export type LedgerFn = <T>(mutator: (tx: LedgerTx) => T) => T;

// ============================================================
// Spawn / kill / clock / notify seams
// ============================================================

export interface SpawnJob {
  discussion_id: string;
  agent_id: string;
  attempt_id: string;
  turn: number;
  head_message_id: string;
  deadline: number;
  transcript: TranscriptEntry[];
  policy: Policy;
  /** Canonical head fleet_id — copied from the discussion's head message and
   *  verified against the participant row before the spawn is allowed. */
  fleet_id: string;
  /** Persisted `agent_file` from the participant's Agent row, when set. */
  requested_agent?: string;
  /** Persisted `requested_model` from the participant's Agent row, when set. */
  requested_model?: string;
}

export interface SpawnHandle {
  attempt_id: string;
  /** Opaque handle the `kill` seam uses to identify the process/task to terminate. */
  handle: unknown;
}

/** Mirrors Node's `child_process` 'exit' event: `code` is the process exit
 *  code, or `null` if the child was killed by a signal. */
export interface ChildExitInfo {
  code: number | null;
}

/**
 * Synchronous launch call (blueprint §2 step 7). A fake may throw
 * synchronously to model spawn failure (blueprint §2 step 9: "On synchronous
 * spawn failure, terminal CAS to `failed`").
 *
 * `onExit` is a callback the STORE's own implementation supplies — the real
 * implementation wires it to the child process's 'exit' event; when it
 * fires, the store checks whether this attempt already has an effective
 * `completed` receipt (a reply beat the exit) and, if not, CASes it to
 * `failed` (blueprint §2 step 10: "On child exit without one valid committed
 * reply, terminal CAS to `failed`"). A fake `spawn` in tests captures
 * `onExit` per job so a test can invoke it manually to simulate the child's
 * process lifecycle ending independently of any reply or deadline.
 */
export type SpawnFn = (job: SpawnJob, onExit: (info: ChildExitInfo) => void) => SpawnHandle;

/** Terminates a still-running child at its deadman deadline (blueprint §2 step
 *  11). Must not throw if the child has already exited. */
export type KillFn = (handle: SpawnHandle) => void;

/** The single injected time source. Both pre-transaction deadline arithmetic
 *  and (via `LedgerTx.now()`) in-transaction reads should derive from this,
 *  so tests can advance time deterministically instead of racing wall clock. */
export type ClockFn = () => number;

export type DiscussionNotifyEvent =
  | { kind: "root_sent"; discussion_id: string; root_message_id: string }
  | { kind: "wake_reserved"; discussion_id: string; attempt_id: string; agent_id: string }
  | { kind: "reply_appended"; discussion_id: string; message_id: string }
  | { kind: "terminal"; discussion_id: string; attempt_id: string; state: WakeState };

/** Best-effort, post-commit only (spec §13 invariants 21/22; test 51). Must
 *  never be awaited by the store, and a throw here must never roll back or
 *  block an already-committed mutation or a pending/claimed launch. */
export type NotifyFn = (event: DiscussionNotifyEvent) => void;

// ============================================================
// Guard configuration (blueprint §0 "Guard configuration")
// ============================================================

export interface GuardConfig {
  /** MESHFLEET_AGENT_WAKE_QUOTA_PER_HOUR, default 60. */
  wakeQuotaPerHour: number;
  /** MESHFLEET_GLOBAL_KILL_SWITCH, default false. */
  globalKillSwitch: boolean;
  /** MESHFLEET_ESCALATE_ON_BUDGET_EXHAUSTION, default true. */
  escalateOnBudgetExhaustion: boolean;
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  wakeQuotaPerHour: 60,
  globalKillSwitch: false,
  escalateOnBudgetExhaustion: true,
};

export interface DiscussionStoreDeps {
  ledger: LedgerFn;
  spawn: SpawnFn;
  kill: KillFn;
  clock: ClockFn;
  notify: NotifyFn;
  guardConfig?: GuardConfig;
}

// ============================================================
// Error taxonomy (blueprint §3)
// ============================================================

export type DiscussionErrorCode =
  | "not_found"
  | "turn_timeout_exceeds_conversation_timeout"
  | "broadcast_rejected"
  | "envelope_oversize"
  | "invalid_envelope"
  | "wrong_participant"
  | "stale_head"
  | "terminal_state"
  | "turn_already_active"
  | "budget_exhausted"
  | "quota_exceeded"
  | "global_kill_active"
  | "attempt_not_active"
  | "second_reply"
  | "past_deadline";

export interface DiscussionErrorDetail {
  entity?: string;
  expected_head_message_id?: string;
  current_head_message_id?: string;
  status?: DerivedDiscussion["status"];
  bytes?: number;
  limit_bytes?: number;
  deadline?: number;
  now?: number;
  [key: string]: unknown;
}

/**
 * Thrown by every mutating store operation on rejection. Carries the exact
 * `code` + snake_case `detail` fields the MCP layer (D3) surfaces verbatim
 * (blueprint §0 "Extend `jsonError`"). Rejection must leave messages, head,
 * attempts, budget, receipts, and launch count unchanged (blueprint §3).
 */
export class DiscussionError extends Error {
  readonly code: DiscussionErrorCode;
  readonly detail: DiscussionErrorDetail;
  constructor(code: DiscussionErrorCode, detail: DiscussionErrorDetail = {}) {
    super(code);
    this.name = "DiscussionError";
    this.code = code;
    this.detail = detail;
  }
}

// ============================================================
// Operation params / results (spec §11, blueprint §§4-7)
// ============================================================

export interface AskPeerParams {
  from_agent_id: string;
  to_agent_id: string;
  fleet_id: string;
  payload: string;
  max_turns: number;
  timeout_ms: number;
  turn_timeout_ms: number;
  wake_peer: boolean;
}

export type AskPeerStatus = "answered" | "timed_out" | "failed" | "deadman" | "invalid";

export interface AskPeerResult {
  discussion_id: string;
  root_message_id: string;
  wake_reserved: boolean;
  status: AskPeerStatus;
  answer?: Message;
  discussion: DerivedDiscussion;
}

/**
 * Result of the FAST, non-blocking half of `ask_peer` (spec §9 steps 1-5):
 * create the root (+ optional turn-2 reservation and launch-claim when
 * `wake_peer:true`), commit, and return — without entering the blocking
 * rendezvous wait (§9 steps 6-7). See `DiscussionStore.openDiscussion` for
 * why this is split out as its own store-layer method.
 */
export interface OpenDiscussionResult {
  discussion_id: string;
  root_message_id: string;
  wake_reserved: boolean;
  reservation?: {
    attempt_id: string;
    turn: number;
    deadline: number;
  };
}

export interface WakeAgentParams {
  agent_id: string;
  discussion_id: string;
  expected_head_message_id: string;
}

export interface WakeAgentResult {
  attempt_id: string;
  turn: number;
  head_message_id: string;
  deadline: number;
  remaining_turns: number;
}

export interface ReplyDiscussionParams {
  agent_id: string;
  discussion_id: string;
  attempt_id: string;
  reply_to_message_id: string;
  type: "question" | "result";
  payload: string;
  close?: boolean;
}

export type ReplyDiscussionStatus = "open" | "closed" | "exhausted";

export interface ReplyDiscussionResult {
  message_id: string;
  turn: number;
  status: ReplyDiscussionStatus;
  remaining_turns: number;
}

export interface GetDiscussionParams {
  discussion_id: string;
  include_receipts?: boolean;
}

/** Identical shape to `DerivedDiscussion` (src/discussion.ts) — re-exported
 *  under the MCP-facing name §11 uses so store consumers don't need a second
 *  import for what is, by design, the very same derivation. */
export type DiscussionView = DerivedDiscussion;

export interface SweepResult {
  /** Attempt ids terminalized this sweep (each newly written `failed` or `deadman`). */
  terminalized: Array<{
    discussion_id: string;
    attempt_id: string;
    state: Extract<WakeState, "failed" | "deadman">;
  }>;
}

// ============================================================
// The store contract
// ============================================================

/**
 * `openDiscussion`/`awaitAnswer`, `wakeAgent`, `replyDiscussion`, and
 * `sweepStranded` are asynchronous at this seam because their post-commit
 * phase (spawn, notify, and — for the rendezvous — the blocking wait, §9)
 * happens OUTSIDE the synchronous ledger transaction (§13 invariant 20). The
 * transaction itself, and every check it performs, remains synchronous inside
 * `deps.ledger`. `getDiscussion` is synchronous and read-only: it never
 * touches the write path, spawns, or notifies (§11).
 *
 * DELIBERATE DEPARTURE FROM THE MCP SURFACE (§11): the spec's single
 * `ask_peer` tool both creates the root (+ optional wake) AND blocks awaiting
 * an answer, in one call. At this store layer that is split into two
 * methods — `openDiscussion` (the fast, commit-and-return half; §9 steps 1-5)
 * and `awaitAnswer` (the blocking rendezvous wait; §9 steps 6-7) — so each
 * half's atomicity and blocking behavior is independently testable without
 * every wake/reply-mechanics test having to race a real conversation-deadline
 * timeout. The eventual D3 MCP handler for `ask_peer` composes them:
 * `const opened = await store.openDiscussion(params); return
 * store.awaitAnswer(opened.discussion_id, opened.root_message_id);` — which
 * is exactly `AskPeerResult` (test 15-22's territory; out of this suite's
 * required scope, but the seam is shaped so those tests can be added later
 * without another interface change).
 */
export interface DiscussionStore {
  openDiscussion(params: AskPeerParams): Promise<OpenDiscussionResult>;
  awaitAnswer(discussionId: string, rootMessageId: string): Promise<AskPeerResult>;
  wakeAgent(params: WakeAgentParams): Promise<WakeAgentResult>;
  replyDiscussion(params: ReplyDiscussionParams): Promise<ReplyDiscussionResult>;
  getDiscussion(params: GetDiscussionParams): DiscussionView;
  /** Terminalizes stranded `reserved`/`started` attempts past their recorded
   *  deadline (§8; blueprint §2 step 13). */
  sweepStranded(nowMs?: number): Promise<SweepResult>;
  /**
   * D3 addition (cdx pass-1 review, discussion-mcp.ts's
   * `primeDiscussionSweepIndex`): seed `knownDiscussionIds` directly from a
   * caller-supplied id set, with NO ledger read and NO derivation — O(1) per
   * id. Exists so startup priming can register which discussions exist
   * without paying `getDiscussion`'s full transaction + `deriveDiscussion`
   * cost for every one of them; `sweepStranded` (and every other mutating
   * method) still derives fully, but only for ids it actually needs, only
   * when it actually runs.
   */
  seedKnownDiscussionIds(discussionIds: Iterable<string>): void;
}

const HOURLY_WINDOW_MS = 3_600_000;

/**
 * `ask_peer`'s conversation-level `timeout_ms` bounds (lane-1 §11: "required,
 * 1s..15m"; d3-wiring-blueprint.md §4 inputSchema `minimum: 1000, maximum:
 * 900000`). Unlike `max_turns`/`turn_timeout_ms`, this bound lives here (not
 * in discussion.ts) because `timeout_ms` is a relative input duration used
 * only to COMPUTE the absolute `conversation_deadline` written into the
 * policy — the policy itself carries no relative timeout field for
 * discussion.ts's envelope validation to bound.
 */
const MIN_CONVERSATION_TIMEOUT_MS = 1_000;
const MAX_CONVERSATION_TIMEOUT_MS = 900_000;

/**
 * D2 implementation. Every mutating operation runs its authoritative checks
 * and writes inside exactly one synchronous `deps.ledger` transaction (spec
 * §13 invariant 20); spawn/kill/notify happen only after that transaction has
 * committed. Nothing about an attempt's lifecycle is trusted from anywhere
 * but the ledger itself — see the "Attempt bookkeeping" note below for the
 * two narrow, non-authoritative exceptions this store keeps in memory.
 */
export function createDiscussionStore(deps: DiscussionStoreDeps): DiscussionStore {
  const guardConfig: GuardConfig = deps.guardConfig ?? DEFAULT_GUARD_CONFIG;

  // ==========================================================================
  // Attempt bookkeeping — deliberately NOT authoritative.
  //
  // `handleRegistry` remembers the live `SpawnHandle` for an attempt THIS
  // store instance actually spawned, so `sweepStranded`/deadman settlement can
  // call `deps.kill` on the right handle. `knownDiscussionIds` remembers which
  // discussion ids this instance has touched, so `sweepStranded` (which has no
  // "list all discussions" primitive on `LedgerTx` — see its own contract
  // comment) knows which ids to re-derive and scan. Neither map is consulted
  // to decide any attempt's STATE, turn, deadline, or terminal outcome — that
  // is always re-derived fresh from `deps.ledger` via `discussion.ts`'s
  // `deriveDiscussion` (see tests K2/K3: a brand-new store instance over the
  // same ledger reconstructs identical attempts/status with an empty registry
  // and an empty known-ids set primed only by whatever the caller just asked
  // about). A missing handle at sweep time (crash before spawn, or a restart)
  // simply means there is nothing local left to kill — the terminal receipt
  // is written from the ledger regardless (test #33).
  //
  // D3 OBLIGATION (cdx pass-1 review, finding #2 — flagged so it doesn't get
  // lost): `knownDiscussionIds` is instance-local and starts EMPTY on every
  // process start. `sweepStranded` only scans ids this instance has already
  // been asked about (tests K2/K3 rely on exactly this — a fresh instance's
  // sweep is primed by a preceding `getDiscussion` call), so a brand-new
  // instance that has touched nothing yet will not discover and terminalize
  // stranded reservations from discussions it never saw. This is acceptable
  // ONLY because D3's server owns one long-lived store instance for its
  // whole process lifetime, not one per request — but that also means D3
  // MUST prime the sweep index at startup by scanning the ledger for
  // correlated discussion roots (e.g. every message whose payload parses as a
  // `discussion/v1` root envelope) and calling `getDiscussion`/touching each
  // resulting id before the periodic sweeper's first run, or attempts
  // stranded across a restart will silently never be swept. `LedgerTx` has no
  // "list all discussions" primitive to do this from inside this module (see
  // `sweepStranded`'s own contract comment) — this is deliberately a D3-layer
  // responsibility, not something D2 can discharge on its own.
  //
  // Vocabulary alignment with docs/A2A-NEXT-SLICE.md: that contract bounds a
  // DIFFERENT object — work-item execution attempts with leases, owner
  // epochs, and fencing tokens for multi-host coordination. A discussion
  // attempt is a conversation turn, not a work item, and this store
  // deliberately does not implement leases, owner epochs, or fencing — there
  // is no multi-host ownership question here, only "has this ledger-recorded
  // reservation passed its recorded deadline." Where the shapes genuinely
  // overlap, field/variable naming is kept aligned on purpose: `attempt_id`
  // is this module's durable, retry-distinct execution identity (same
  // meaning as the slice's `attempt_id`); a settlement's receipt `timestamp`
  // plays the role the slice calls `terminal_at`; and the fake ledger's
  // `sequence`/receipt insertion order plays the role of the slice's
  // monotonic `seq` for lifecycle ordering. Same pattern family (durable,
  // fenced-by-construction lifecycle bookkeeping), different domain
  // (conversation turns vs. distributed work-item ownership) — a candidate
  // for future unification if Discussions ever needs multi-host wake
  // coordination, deliberately not unified now.
  // ==========================================================================
  const handleRegistry = new Map<string, SpawnHandle>();
  const knownDiscussionIds = new Set<string>();

  /**
   * Notification is an observational, best-effort side effect. The durable
   * ledger remains authoritative, so a subscriber failure must never make a
   * committed operation appear rejected, strand a reserved launch, escape a
   * child-process callback, or stop reconciliation of later discussions.
   */
  function notifyBestEffort(event: DiscussionNotifyEvent): void {
    try {
      deps.notify(event);
    } catch {
      // Deliberately swallowed: callers reconcile from the durable ledger.
    }
  }

  function deriveView(discussionId: string, now: number): DerivedDiscussion {
    return deps.ledger((tx) => {
      const messages = tx.messagesByCorrelation(discussionId);
      const receipts = tx.allReceiptsForDiscussion(discussionId);
      return deriveDiscussion(discussionId, messages, receipts, now);
    });
  }

  /**
   * `AttemptInfo` (discussion.ts's public per-attempt view) deliberately does
   * NOT carry `head_message_id` — only the raw internal `ValidatedAttempt`
   * does. Recover it the robust way instead of assuming it always equals the
   * discussion's CURRENT head (true for the sole live attempt in a valid
   * discussion, but not a safe general assumption): every receipt in an
   * attempt's lifecycle is physically attached to its authorizing head
   * message, so the receipt's own `message_id` IS that head, for any
   * lifecycle state.
   */
  function headMessageIdForAttempt(receipts: Receipt[], attemptId: string, fallback: string): string {
    for (const r of receipts) {
      const parsed = parseReceiptAction(r.action);
      if (parsed && parsed.kind === "wake" && parsed.attempt_id === attemptId) return r.message_id;
    }
    return fallback;
  }

  /**
   * Atomically CASes a still-`reserved`/`started` attempt to a terminal state
   * from the ledger's OWN current view (never from a caller-supplied guess).
   * Idempotent by construction: if the attempt is missing, or already
   * terminal (or `completed` — a reply beat this settlement), this is a
   * silent no-op and returns `null` so the caller never double-notifies.
   */
  function settleTerminal(
    discussionId: string,
    attemptId: string,
    state: Extract<WakeState, "failed" | "deadman">
  ): { headMessageId: string; turn: number; agentId: string } | null {
    return deps.ledger((tx) => {
      const now = tx.now();
      const messages = tx.messagesByCorrelation(discussionId);
      const receipts = tx.allReceiptsForDiscussion(discussionId);
      const view = deriveDiscussion(discussionId, messages, receipts, now);
      const attempt = view.attempts.find((a) => a.attempt_id === attemptId);
      if (!attempt) return null;
      if (attempt.state === "completed" || attempt.state === "failed" || attempt.state === "deadman") return null;
      const headMessageId = headMessageIdForAttempt(receipts, attemptId, view.head_message_id);
      const note = JSON.stringify({
        discussion_id: discussionId,
        head_message_id: headMessageId,
        deadline: attempt.deadline,
      });
      tx.writeReceipt(headMessageId, attempt.agent_id, `discussion.wake.${state}.v1:${attempt.turn}:${attemptId}`, note);
      return { headMessageId, turn: attempt.turn, agentId: attempt.agent_id };
    });
  }

  /** Wired as a spawned child's `onExit` callback (blueprint §2 step 10): a
   *  child that exits without ever landing a valid `completed` receipt loses
   *  its turn — no synthesized answer, no retry. */
  function handleChildExit(discussionId: string, attemptId: string): void {
    const settled = settleTerminal(discussionId, attemptId, "failed");
    handleRegistry.delete(attemptId);
    if (settled) {
      notifyBestEffort({ kind: "terminal", discussion_id: discussionId, attempt_id: attemptId, state: "failed" });
    }
  }

  /**
   * The central one-shot launcher (blueprint §2): CAS `reserved` -> `started`
   * in its OWN transaction (separate from the reservation transaction that
   * created it — test #45 proves spawn never begins before the RESERVATION
   * itself already committed, which this ordering guarantees transitively),
   * then spawn only once that commits. A synchronous spawn failure is CASed
   * straight to `failed` (test #29) instead of ever registering a handle.
   *
   * Task 3 (model-selected execution): the same transaction also reads the
   * participant's persisted launch config (per the brief's
   * `LedgerTx.agentLaunchConfig`) and copies its `agent_file` /
   * `requested_model` into the `SpawnJob` together with the canonical head's
   * `fleet_id`. A wake therefore inherits the same selection the original
   * `spawn_fleet`/`attach_agent` recorded — there is no path for the caller
   * to override either field through Discussion tools, and a launch config
   * lookup that misses (the agent was deleted between reservation and start)
   * settles the attempt to `failed` and never hands a job to `deps.spawn`.
   */
  async function launchAttempt(discussionId: string, attemptId: string): Promise<void> {
    const prepared = deps.ledger((tx):
      | { kind: "skip" }
      | { kind: "expired" }
      | { kind: "missing_launch_config"; agentId: string; headMessageId: string; headFleetId: string; turn: number }
      | { kind: "start"; view: DerivedDiscussion; attempt: DerivedDiscussion["attempts"][number]; headMessageId: string; fleetId: string; launchConfig: { requestedAgent?: string; requestedModel?: string } } => {
      const now = tx.now();
      const messages = tx.messagesByCorrelation(discussionId);
      const receipts = tx.allReceiptsForDiscussion(discussionId);
      const view = deriveDiscussion(discussionId, messages, receipts, now);
      const attempt = view.attempts.find((a) => a.attempt_id === attemptId);
      if (!attempt || attempt.state !== "reserved") return { kind: "skip" }; // already claimed, or stale — never double-launch
      // cdx pass-1 finding #1 (TOCTOU between reservation and start): wall
      // clock may have advanced past this attempt's OWN deadline between the
      // reservation transaction that stamped it and this started-CAS
      // transaction (a slow scheduler tick, queued launcher work, GC pause,
      // ...). A dead-on-arrival reservation must never be CASed to `started`
      // or handed to `deps.spawn` — it settles `deadman` here instead (below,
      // via the same idempotent `settleTerminal` the sweeper uses), so the
      // turn is still consumed exactly once and no child is ever launched
      // only to immediately be past its own kill deadline.
      if (now >= attempt.deadline) {
        return { kind: "expired" };
      }
      const headMessageId = headMessageIdForAttempt(receipts, attemptId, view.head_message_id);
      const headMessage = tx.getMessage(headMessageId);
      const headFleetId = headMessage?.fleet_id ?? "";
      const launchConfig = tx.agentLaunchConfig(attempt.agent_id, headFleetId);
      if (!launchConfig) {
        return { kind: "missing_launch_config", agentId: attempt.agent_id, headMessageId, headFleetId, turn: attempt.turn };
      }
      const note = JSON.stringify({
        discussion_id: discussionId,
        head_message_id: headMessageId,
        deadline: attempt.deadline,
      });
      tx.writeReceipt(headMessageId, attempt.agent_id, `discussion.wake.started.v1:${attempt.turn}:${attemptId}`, note);
      return { kind: "start", view, attempt, headMessageId, fleetId: headFleetId, launchConfig };
    });
    if (prepared.kind === "skip") return;
    if (prepared.kind === "expired") {
      const settled = settleTerminal(discussionId, attemptId, "deadman");
      if (settled) {
        notifyBestEffort({ kind: "terminal", discussion_id: discussionId, attempt_id: attemptId, state: "deadman" });
      }
      return;
    }
    if (prepared.kind === "missing_launch_config") {
      // Defensive guard — wakeAgent already verified the participant exists
      // in the canonical fleet at reservation time, so a missing launch
      // config here means the Agent row was deleted between the reservation
      // commit and this started-CAS (or the canonical head's fleet_id has
      // drifted from the participant's fleet, which is structurally
      // impossible in the current write path but defended against anyway).
      // Fail closed: no `started` CAS, no spawn, turn is still consumed.
      const settled = settleTerminal(discussionId, attemptId, "failed");
      if (settled) {
        notifyBestEffort({ kind: "terminal", discussion_id: discussionId, attempt_id: attemptId, state: "failed" });
      }
      return;
    }
    const { view, attempt, headMessageId, fleetId, launchConfig } = prepared;
    const job: SpawnJob = {
      discussion_id: discussionId,
      agent_id: attempt.agent_id,
      attempt_id: attempt.attempt_id,
      turn: attempt.turn,
      head_message_id: headMessageId,
      deadline: attempt.deadline,
      transcript: view.transcript,
      policy: view.policy,
      fleet_id: fleetId,
    };
    if (launchConfig.requestedAgent !== undefined) job.requested_agent = launchConfig.requestedAgent;
    if (launchConfig.requestedModel !== undefined) job.requested_model = launchConfig.requestedModel;
    let handle: SpawnHandle;
    try {
      handle = deps.spawn(job, () => handleChildExit(discussionId, attemptId));
    } catch {
      const settled = settleTerminal(discussionId, attemptId, "failed");
      if (settled) {
        notifyBestEffort({ kind: "terminal", discussion_id: discussionId, attempt_id: attemptId, state: "failed" });
      }
      return;
    }
    handleRegistry.set(attemptId, handle);
  }

  const TERMINAL_STATUSES = new Set<DerivedDiscussion["status"]>(["invalid", "closed", "expired", "exhausted", "deadman"]);

  async function openDiscussion(params: AskPeerParams): Promise<OpenDiscussionResult> {
    // Per-field bounds are checked BEFORE the cross-field relational check
    // below: a JSON-schema-validated caller (the eventual D3 MCP layer, per
    // blueprint §4's `inputSchema` `minimum`/`maximum`) would already reject
    // an individually out-of-bounds field at the schema layer, before ever
    // reaching a semantic "turn_timeout_ms > timeout_ms" comparison between
    // two fields that might themselves be invalid. This also disentangles
    // the two checks at their shared boundary: `MIN_TURN_TIMEOUT_MS` (1000)
    // exceeds `MIN_CONVERSATION_TIMEOUT_MS - 1` (999), so any timeout_ms below
    // 1000 would ALSO trip the relational check first if it ran first,
    // masking the more fundamental bounds violation.
    if (
      !Number.isInteger(params.timeout_ms) ||
      params.timeout_ms < MIN_CONVERSATION_TIMEOUT_MS ||
      params.timeout_ms > MAX_CONVERSATION_TIMEOUT_MS
    ) {
      throw new DiscussionError("invalid_envelope", { entity: "timeout_ms" });
    }
    if (
      !Number.isInteger(params.turn_timeout_ms) ||
      params.turn_timeout_ms < MIN_TURN_TIMEOUT_MS ||
      params.turn_timeout_ms > MAX_TURN_TIMEOUT_MS
    ) {
      throw new DiscussionError("invalid_envelope", { entity: "turn_timeout_ms" });
    }
    if (!Number.isInteger(params.max_turns) || params.max_turns < MIN_MAX_TURNS || params.max_turns > MAX_MAX_TURNS) {
      throw new DiscussionError("invalid_envelope", { entity: "max_turns" });
    }
    if (params.turn_timeout_ms > params.timeout_ms) {
      throw new DiscussionError("turn_timeout_exceeds_conversation_timeout", {});
    }
    if (params.from_agent_id === BROADCAST || params.to_agent_id === BROADCAST || params.from_agent_id === params.to_agent_id) {
      throw new DiscussionError("broadcast_rejected", {});
    }

    const discussionId = randomUUID();
    const rootMessageId = randomUUID();
    const rootAttemptId = randomUUID();
    const turn2AttemptId = params.wake_peer ? randomUUID() : undefined;
    knownDiscussionIds.add(discussionId);

    const preNow = deps.clock();
    const conversationDeadline = preNow + params.timeout_ms;
    const rootEnvelope: Envelope = {
      $meshfleet: "discussion/v1",
      discussion_id: discussionId,
      turn: 1,
      attempt_id: rootAttemptId,
      reply_to: null,
      kind: "question",
      body: params.payload,
      close: false,
      policy: {
        participants: [params.from_agent_id, params.to_agent_id],
        max_turns: params.max_turns,
        conversation_deadline: conversationDeadline,
        turn_timeout_ms: params.turn_timeout_ms,
      },
    };
    const serializedRoot = JSON.stringify(rootEnvelope);
    if (!validatePayloadSize(serializedRoot)) {
      throw new DiscussionError("envelope_oversize", {
        bytes: Buffer.byteLength(serializedRoot, "utf8"),
        limit_bytes: DISCUSSION_MAX_PAYLOAD_BYTES,
      });
    }

    const committed = deps.ledger((tx) => {
      const now = tx.now();
      if (!tx.agentExists(params.from_agent_id, params.fleet_id) || !tx.agentExists(params.to_agent_id, params.fleet_id)) {
        throw new DiscussionError("not_found", { entity: "agent" });
      }

      let reservation: { attempt_id: string; turn: number; deadline: number } | undefined;
      if (params.wake_peer) {
        // Guard checkpoints run BEFORE any mutation (blueprint §4 "no mutation
        // before all wake guards pass") — `wake_peer:false` never reaches here.
        if (guardConfig.globalKillSwitch) {
          throw new DiscussionError("global_kill_active", {});
        }
        const windowStart = now - HOURLY_WINDOW_MS;
        const recentCount = tx.countRecentWakeReservations(params.to_agent_id, windowStart, now);
        if (recentCount >= guardConfig.wakeQuotaPerHour) {
          throw new DiscussionError("quota_exceeded", {});
        }
      }

      tx.appendMessage({
        id: rootMessageId,
        from_agent_id: params.from_agent_id,
        to_agent_id: params.to_agent_id,
        fleet_id: params.fleet_id,
        type: "question",
        payload: serializedRoot,
        correlation_id: discussionId,
        timestamp: now,
      });
      tx.writeReceipt(rootMessageId, params.from_agent_id, `discussion.turn.sent.v1:1:${rootAttemptId}`);

      if (params.wake_peer && turn2AttemptId) {
        const deadline = Math.min(now + params.turn_timeout_ms, conversationDeadline);
        const note = JSON.stringify({ discussion_id: discussionId, head_message_id: rootMessageId, deadline });
        tx.writeReceipt(rootMessageId, params.to_agent_id, `discussion.wake.reserved.v1:2:${turn2AttemptId}`, note);
        reservation = { attempt_id: turn2AttemptId, turn: 2, deadline };
      }

      return { reservation };
    });

    notifyBestEffort({ kind: "root_sent", discussion_id: discussionId, root_message_id: rootMessageId });

    if (committed.reservation) {
      notifyBestEffort({
        kind: "wake_reserved",
        discussion_id: discussionId,
        attempt_id: committed.reservation.attempt_id,
        agent_id: params.to_agent_id,
      });
      await launchAttempt(discussionId, committed.reservation.attempt_id);
    }

    return {
      discussion_id: discussionId,
      root_message_id: rootMessageId,
      wake_reserved: !!committed.reservation,
      reservation: committed.reservation,
    };
  }

  /**
   * The blocking rendezvous half of `ask_peer` (spec §9 steps 6-7). Not
   * exercised by the D2 reservation suite (see this file's own
   * `DiscussionStore` doc comment on why it is split from `openDiscussion`);
   * implemented here as a check-register-check poll over durable state —
   * never holding a ledger transaction while waiting — so a future D3 handler
   * can compose `openDiscussion` + `awaitAnswer` directly per that comment.
   */
  async function awaitAnswer(discussionId: string, rootMessageId: string): Promise<AskPeerResult> {
    knownDiscussionIds.add(discussionId);
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    for (;;) {
      const now = deps.clock();
      const view = deriveView(discussionId, now);

      if (view.status === "closed") {
        const last = view.transcript[view.transcript.length - 1];
        return {
          discussion_id: discussionId,
          root_message_id: rootMessageId,
          wake_reserved: view.attempts.length > 0,
          status: "answered",
          answer: last?.message,
          discussion: view,
        };
      }
      if (view.status === "invalid") {
        return {
          discussion_id: discussionId,
          root_message_id: rootMessageId,
          wake_reserved: view.attempts.length > 0,
          status: "invalid",
          discussion: view,
        };
      }
      if (view.attempts.some((a) => a.state === "deadman")) {
        return {
          discussion_id: discussionId,
          root_message_id: rootMessageId,
          wake_reserved: view.attempts.length > 0,
          status: "deadman",
          discussion: view,
        };
      }
      if (view.status === "exhausted" || view.status === "expired") {
        const lastAttempt = view.attempts[view.attempts.length - 1];
        const status: AskPeerStatus = lastAttempt?.state === "failed" ? "failed" : "timed_out";
        return {
          discussion_id: discussionId,
          root_message_id: rootMessageId,
          wake_reserved: view.attempts.length > 0,
          status,
          discussion: view,
        };
      }
      if (now >= view.policy.conversation_deadline) {
        const active = view.attempts.find((a) => a.state === "reserved" || a.state === "started");
        if (active) {
          const settled = settleTerminal(discussionId, active.attempt_id, "deadman");
          if (settled) {
            const handle = handleRegistry.get(active.attempt_id);
            if (handle) {
              deps.kill(handle);
              handleRegistry.delete(active.attempt_id);
            }
            notifyBestEffort({ kind: "terminal", discussion_id: discussionId, attempt_id: active.attempt_id, state: "deadman" });
          }
        }
        const finalView = deriveView(discussionId, deps.clock());
        return {
          discussion_id: discussionId,
          root_message_id: rootMessageId,
          wake_reserved: finalView.attempts.length > 0,
          status: "timed_out",
          discussion: finalView,
        };
      }
      await sleep(20);
    }
  }

  async function wakeAgent(params: WakeAgentParams): Promise<WakeAgentResult> {
    knownDiscussionIds.add(params.discussion_id);
    const candidateAttemptId = randomUUID();

    const reservation = deps.ledger((tx) => {
      const now = tx.now();
      const messages = tx.messagesByCorrelation(params.discussion_id);
      const receipts = tx.allReceiptsForDiscussion(params.discussion_id);
      if (messages.length === 0) {
        throw new DiscussionError("not_found", { entity: "discussion", discussion_id: params.discussion_id });
      }
      const view = deriveDiscussion(params.discussion_id, messages, receipts, now);

      // Early fail-closed terminal gate (lane-1 §12 precedence, §13 invariant
      // "terminal states never reopen") — deliberately BEFORE the
      // participant/recipient/head checks below. See this file's
      // implementation-report note on tests #32d/#32e/K1: a wake from a
      // non-recipient agent against an already-deadman discussion, and a wake
      // against an `invalid` aggregate (whose derived participants are
      // placeholder empty strings), must both surface as `terminal_state` —
      // a participant/recipient check is meaningless once the aggregate
      // itself is already fail-closed terminal, and would otherwise mask the
      // terminal condition behind a spurious `wrong_participant`.
      if (TERMINAL_STATUSES.has(view.status)) {
        throw new DiscussionError("terminal_state", { status: view.status });
      }

      if (params.agent_id !== view.participants[0] && params.agent_id !== view.participants[1]) {
        throw new DiscussionError("wrong_participant", { entity: "agent" });
      }
      const headMessage = tx.getMessage(view.head_message_id);
      if (!headMessage || headMessage.to_agent_id !== params.agent_id) {
        throw new DiscussionError("wrong_participant", { entity: "agent" });
      }
      if (params.expected_head_message_id !== view.head_message_id) {
        throw new DiscussionError("stale_head", {
          expected_head_message_id: params.expected_head_message_id,
          current_head_message_id: view.head_message_id,
        });
      }

      // Any live (reserved/started) attempt is, by construction, bound to the
      // CURRENT canonical head (the head only ever advances via an admitted
      // completed reply, which would leave no attempt live) — so `active`
      // matching `view.head_message_id` is already established the moment it
      // exists; only the requesting agent still needs to match.
      const active = view.attempts.find((a) => a.state === "reserved" || a.state === "started");
      if (active) {
        if (active.agent_id === params.agent_id) {
          // Concurrent duplicate wakes observe the SAME existing attempt —
          // never a second launch (test #27).
          return {
            newlyReserved: false as const,
            attemptId: active.attempt_id,
            turn: active.turn,
            headMessageId: view.head_message_id,
            deadline: active.deadline,
            remainingTurns: view.turns_remaining,
          };
        }
        throw new DiscussionError("turn_already_active", {});
      }

      if (view.turns_remaining <= 0) {
        throw new DiscussionError("budget_exhausted", {});
      }
      if (guardConfig.globalKillSwitch) {
        throw new DiscussionError("global_kill_active", {});
      }
      const windowStart = now - HOURLY_WINDOW_MS;
      const recentCount = tx.countRecentWakeReservations(params.agent_id, windowStart, now);
      if (recentCount >= guardConfig.wakeQuotaPerHour) {
        throw new DiscussionError("quota_exceeded", {});
      }

      const turn = view.turns_used + 1;
      const deadline = Math.min(now + view.policy.turn_timeout_ms, view.policy.conversation_deadline);
      const note = JSON.stringify({ discussion_id: params.discussion_id, head_message_id: view.head_message_id, deadline });
      tx.writeReceipt(view.head_message_id, params.agent_id, `discussion.wake.reserved.v1:${turn}:${candidateAttemptId}`, note);

      return {
        newlyReserved: true as const,
        attemptId: candidateAttemptId,
        turn,
        headMessageId: view.head_message_id,
        deadline,
        remainingTurns: view.turns_remaining - 1,
      };
    });

    if (reservation.newlyReserved) {
      notifyBestEffort({
        kind: "wake_reserved",
        discussion_id: params.discussion_id,
        attempt_id: reservation.attemptId,
        agent_id: params.agent_id,
      });
      await launchAttempt(params.discussion_id, reservation.attemptId);
    }

    return {
      attempt_id: reservation.attemptId,
      turn: reservation.turn,
      head_message_id: reservation.headMessageId,
      deadline: reservation.deadline,
      remaining_turns: reservation.remainingTurns,
    };
  }

  async function replyDiscussion(params: ReplyDiscussionParams): Promise<ReplyDiscussionResult> {
    knownDiscussionIds.add(params.discussion_id);
    const close = params.close ?? false;

    const settled = deps.ledger((tx) => {
      const now = tx.now();
      const messages = tx.messagesByCorrelation(params.discussion_id);
      const receipts = tx.allReceiptsForDiscussion(params.discussion_id);
      if (messages.length === 0) {
        throw new DiscussionError("not_found", { entity: "discussion", discussion_id: params.discussion_id });
      }
      const view = deriveDiscussion(params.discussion_id, messages, receipts, now);

      const attempt = view.attempts.find((a) => a.attempt_id === params.attempt_id);
      if (!attempt) {
        throw new DiscussionError("not_found", { entity: "attempt", attempt_id: params.attempt_id });
      }
      if (attempt.agent_id !== params.agent_id) {
        throw new DiscussionError("wrong_participant", { entity: "agent" });
      }

      // Deliberate resolution (this file's implementation-report note 3,
      // against lane-1 §13 invariant 12 "at most one reply is emitted by an
      // attempt"): a reused attempt id is rejected from the ATTEMPT's own
      // recorded lifecycle — `second_reply`/`attempt_not_active` — before any
      // generic aggregate-status or head check runs. Test #34 pins
      // `second_reply` ahead of a `stale_head` reading of the same retry.
      if (attempt.state === "completed") {
        throw new DiscussionError("second_reply", {});
      }
      if (attempt.state === "failed" || attempt.state === "deadman") {
        throw new DiscussionError("attempt_not_active", {});
      }

      if (view.status === "invalid" || view.status === "closed" || view.status === "expired") {
        throw new DiscussionError("terminal_state", { status: view.status });
      }

      if (params.reply_to_message_id !== view.head_message_id) {
        throw new DiscussionError("stale_head", {
          expected_head_message_id: params.reply_to_message_id,
          current_head_message_id: view.head_message_id,
        });
      }
      if (now > attempt.deadline || now > view.policy.conversation_deadline) {
        throw new DiscussionError("past_deadline", { deadline: attempt.deadline, now });
      }

      // `params.reply_to_message_id === view.head_message_id` was just verified
      // above (the CAS check), so the active attempt's authorizing head IS the
      // discussion's current canonical head — no need to recover it separately.
      const headMessage = tx.getMessage(view.head_message_id);
      if (!headMessage) {
        throw new DiscussionError("not_found", { entity: "message", message_id: view.head_message_id });
      }

      const envelope: Envelope = {
        $meshfleet: "discussion/v1",
        discussion_id: params.discussion_id,
        turn: attempt.turn,
        attempt_id: params.attempt_id,
        reply_to: params.reply_to_message_id,
        kind: params.type,
        body: params.payload,
        close,
      };
      const serialized = JSON.stringify(envelope);
      if (!validatePayloadSize(serialized)) {
        throw new DiscussionError("envelope_oversize", {
          bytes: Buffer.byteLength(serialized, "utf8"),
          limit_bytes: DISCUSSION_MAX_PAYLOAD_BYTES,
        });
      }

      const replyMessageId = randomUUID();
      tx.appendMessage({
        id: replyMessageId,
        from_agent_id: params.agent_id,
        to_agent_id: headMessage.from_agent_id,
        fleet_id: headMessage.fleet_id,
        type: params.type,
        payload: serialized,
        correlation_id: params.discussion_id,
        timestamp: now,
      });

      const note = JSON.stringify({
        discussion_id: params.discussion_id,
        head_message_id: view.head_message_id,
        deadline: attempt.deadline,
        reply_message_id: replyMessageId,
      });
      tx.writeReceipt(view.head_message_id, params.agent_id, `discussion.wake.completed.v1:${attempt.turn}:${params.attempt_id}`, note);

      const messages2 = tx.messagesByCorrelation(params.discussion_id);
      const receipts2 = tx.allReceiptsForDiscussion(params.discussion_id);
      const view2 = deriveDiscussion(params.discussion_id, messages2, receipts2, now);

      let status: ReplyDiscussionStatus;
      if (close) status = "closed";
      else if (view2.turns_remaining <= 0) status = "exhausted";
      else status = "open";

      if (status === "exhausted" && guardConfig.escalateOnBudgetExhaustion) {
        const rootEntry = view2.transcript[0];
        const rootSenderId = rootEntry ? rootEntry.message.from_agent_id : view2.participants[0];
        const already = tx
          .receiptsForMessage(view2.root_message_id)
          .some((r) => r.action === "escalate_human" && r.agent_id === rootSenderId);
        if (!already) {
          tx.writeReceipt(
            view2.root_message_id,
            rootSenderId,
            "escalate_human",
            JSON.stringify({
              discussion_id: params.discussion_id,
              reason: "budget_exhausted",
              status: "exhausted",
              head_message_id: view2.head_message_id,
              turns_used: view2.turns_used,
              max_turns: view2.policy.max_turns,
            })
          );
        }
      }

      return { messageId: replyMessageId, turn: attempt.turn, status, remainingTurns: view2.turns_remaining };
    });

    notifyBestEffort({ kind: "reply_appended", discussion_id: params.discussion_id, message_id: settled.messageId });
    if (settled.status === "closed") {
      notifyBestEffort({ kind: "terminal", discussion_id: params.discussion_id, attempt_id: params.attempt_id, state: "completed" });
    }

    return {
      message_id: settled.messageId,
      turn: settled.turn,
      status: settled.status,
      remaining_turns: settled.remainingTurns,
    };
  }

  function getDiscussion(params: GetDiscussionParams): DiscussionView {
    knownDiscussionIds.add(params.discussion_id);
    return deps.ledger((tx) => {
      const now = tx.now();
      const messages = tx.messagesByCorrelation(params.discussion_id);
      const receipts = tx.allReceiptsForDiscussion(params.discussion_id);
      if (messages.length === 0) {
        throw new DiscussionError("not_found", { entity: "discussion", discussion_id: params.discussion_id });
      }
      const view = deriveDiscussion(params.discussion_id, messages, receipts, now);
      if (params.include_receipts === false) {
        return { ...view, transcript: view.transcript.map((entry) => ({ ...entry, receipts: [] })) };
      }
      return view;
    });
  }

  /**
   * Terminalizes every stranded `reserved`/`started` attempt past its
   * recorded deadline, across every discussion this store instance has been
   * asked about (see the "Attempt bookkeeping" note above for why that scope
   * — not "every discussion in the ledger" — is what `LedgerTx` actually
   * supports, and why it is still restart-safe: tests K2/K3 prime a fresh
   * store's known-id set with an ordinary `getDiscussion` call first, exactly
   * as a real caller resuming after a restart would).
   */
  async function sweepStranded(nowMs?: number): Promise<SweepResult> {
    const sweepNow = typeof nowMs === "number" ? nowMs : deps.clock();
    const terminalizedOut: SweepResult["terminalized"] = [];

    for (const discussionId of knownDiscussionIds) {
      const settledList = deps.ledger((tx) => {
        const messages = tx.messagesByCorrelation(discussionId);
        const receipts = tx.allReceiptsForDiscussion(discussionId);
        if (messages.length === 0) return [];
        const view = deriveDiscussion(discussionId, messages, receipts, sweepNow);
        const stranded = view.attempts.filter((a) => (a.state === "reserved" || a.state === "started") && a.deadline <= sweepNow);
        const out: Array<{ attemptId: string; agentId: string; turn: number; headMessageId: string }> = [];
        for (const attempt of stranded) {
          const headMessageId = headMessageIdForAttempt(receipts, attempt.attempt_id, view.head_message_id);
          const note = JSON.stringify({
            discussion_id: discussionId,
            head_message_id: headMessageId,
            deadline: attempt.deadline,
          });
          tx.writeReceipt(headMessageId, attempt.agent_id, `discussion.wake.deadman.v1:${attempt.turn}:${attempt.attempt_id}`, note);
          out.push({ attemptId: attempt.attempt_id, agentId: attempt.agent_id, turn: attempt.turn, headMessageId });
        }
        return out;
      });

      for (const s of settledList) {
        terminalizedOut.push({ discussion_id: discussionId, attempt_id: s.attemptId, state: "deadman" });
        const handle = handleRegistry.get(s.attemptId);
        if (handle) {
          deps.kill(handle);
          handleRegistry.delete(s.attemptId);
        }
        notifyBestEffort({ kind: "terminal", discussion_id: discussionId, attempt_id: s.attemptId, state: "deadman" });
      }
    }

    return { terminalized: terminalizedOut };
  }

  function seedKnownDiscussionIds(discussionIds: Iterable<string>): void {
    for (const id of discussionIds) knownDiscussionIds.add(id);
  }

  return {
    openDiscussion,
    awaitAnswer,
    wakeAgent,
    replyDiscussion,
    getDiscussion,
    sweepStranded,
    seedKnownDiscussionIds,
  };
}
