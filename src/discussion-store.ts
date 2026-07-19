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

import type { Message, Receipt } from "./core.js";
import type { DerivedDiscussion, Policy, TranscriptEntry, WakeState } from "./discussion.js";

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
}

function notImplemented(method: string): never {
  throw new Error(`NOT_IMPLEMENTED: DiscussionStore.${method} — D2 implementation not yet landed`);
}

/**
 * D2 pre-stage stub. Every operation throws immediately so the red suite in
 * test/discussion-reservation.test.ts fails ONLY on this exact marker until
 * D2 lands — never on a type error, never on an accidental pass. Swap this
 * factory body for the real implementation; the exported types above are the
 * contract D2 must satisfy unchanged.
 */
export function createDiscussionStore(deps: DiscussionStoreDeps): DiscussionStore {
  void deps;
  return {
    async openDiscussion() {
      return notImplemented("openDiscussion");
    },
    async awaitAnswer() {
      return notImplemented("awaitAnswer");
    },
    async wakeAgent() {
      return notImplemented("wakeAgent");
    },
    async replyDiscussion() {
      return notImplemented("replyDiscussion");
    },
    getDiscussion() {
      return notImplemented("getDiscussion");
    },
    async sweepStranded() {
      return notImplemented("sweepStranded");
    },
  };
}
