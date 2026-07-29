/**
 * D2 red-test suite — reservation/wake/reply mechanics for Meshfleet
 * Discussions, run entirely against `createDiscussionStore(deps)` from
 * src/discussion-store.ts (interface + types only; no implementation yet).
 *
 * Sources:
 *   - SUCCESSION/a2a-discussions/lane-1-cdx-discussions-api-design.md
 *     §15 "Red-first test list" — sections "Anti-loop and budgeting" (23-34)
 *     and "Receipts and concurrency" (44-52).
 *   - SUCCESSION/a2a-discussions/drafts/cdx-author-review.md H0.2/H0.3 —
 *     the fix-list this suite is built to satisfy: real concurrency via
 *     barriers/independent transactions (not `Promise.resolve` wrappers),
 *     a real handler exercised with injectable spawn/kill/clock/txn
 *     failures, exact error codes with before/after zero-mutation snapshots,
 *     exact receipt-action parsing, rollback failpoints, a `withLedger`-spy
 *     seam for sync-callback enforcement, and guard coverage (quota,
 *     kill-switch, escalation receipt).
 *   - SUCCESSION/a2a-discussions/drafts/d3-wiring-blueprint.md — the exact
 *     transaction-boundary/step ordering these tests assume (§§0-7).
 *
 * RED-READY: `src/discussion-store.ts`'s `createDiscussionStore` is
 * currently a stub whose every method throws
 * `Error("NOT_IMPLEMENTED: DiscussionStore.<method> ...")`. Every test below
 * is written to PASS UNCHANGED once D2 lands; right now each one fails
 * either directly (an unwrapped store call throws the marker) or via an
 * `assert.rejects`/`assert.equal` mismatch whose failure output embeds the
 * same marker (see the file-level note in the harness section below for why
 * a bare, matcher-less `assert.rejects` is deliberately avoided everywhere
 * mutation state is asserted — it would accidentally pass against a stub
 * that does nothing).
 *
 * Three deliberate spec-ambiguity resolutions (documented at point of use,
 * summarized here for reviewers):
 *   1. Tests 23-25 (SSE/inbox/reconnect never spawn) are exercised at this
 *      store's actual surface — direct ledger writes simulating "a message
 *      arrived" plus repeated `getDiscussion`/`sweepStranded` calls
 *      simulating polling/reconciliation — because the resident
 *      supervisor/SSE ingestion loop itself is out of D2's store scope (see
 *      src/discussion.ts's file-header scope boundary; it is spec §10 /
 *      delivery-order step 6 territory).
 *   2. `ask_peer`'s full blocking rendezvous wait (spec §9) is split at this
 *      store layer into `openDiscussion` (fast, commit-and-return) +
 *      `awaitAnswer` (the blocking wait) — see src/discussion-store.ts's
 *      `DiscussionStore` doc comment. This suite only needs `openDiscussion`;
 *      it never needs to race a real conversation-deadline timeout.
 *   3. Test 34 ("a second reply from one attempt is rejected") targets the
 *      attempt's ORIGINAL recorded head as `reply_to_message_id` on the
 *      retry. Blueprint §6 steps 7-8 could, taken maximally literally, let a
 *      retry against an already-advanced canonical head surface `stale_head`
 *      before `second_reply` — but "this specific attempt_id is already
 *      spent" is the more natural, and more useful, gate to check first for
 *      a reused attempt id, so this suite asserts `second_reply` takes
 *      precedence for that shape of retry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createDiscussionStore,
  DiscussionError,
  DEFAULT_GUARD_CONFIG,
  type DiscussionStore,
  type DiscussionStoreDeps,
  type LedgerTx,
  type LedgerFn,
  type NewMessage,
  type SpawnJob,
  type SpawnHandle,
  type SpawnFn,
  type KillFn,
  type ClockFn,
  type NotifyFn,
  type ChildExitInfo,
  type GuardConfig,
  type AskPeerParams,
  type OpenDiscussionResult,
} from "../src/discussion-store.js";
import type { Message, Receipt } from "../src/core.js";

// ============================================================
// Fixtures
// ============================================================

const FLEET = "fleet-1";
const AGENT_A = "agent-a";
const AGENT_B = "agent-b";

function defaultAskPeerParams(overrides: Partial<AskPeerParams> = {}): AskPeerParams {
  return {
    from_agent_id: AGENT_A,
    to_agent_id: AGENT_B,
    fleet_id: FLEET,
    payload: "root question",
    max_turns: 4,
    timeout_ms: 60_000,
    turn_timeout_ms: 5_000,
    wake_peer: false,
    ...overrides,
  };
}

// ============================================================
// Fake ledger: a synchronous, copy-on-write, fault-injectable transaction
// executor mirroring src/db.ts's `withLedger` contract closely enough for
// these tests without pulling in real SQLite. A mutator that throws leaves
// the backing state completely untouched (true rollback semantics) — this
// is what makes tests 49/50's atomicity proofs meaningful.
// ============================================================

interface FakeAgent {
  fleetId: string;
  requestedAgent?: string;
  requestedModel?: string;
}

interface FakeState {
  messages: Map<string, Message>;
  receipts: Map<string, Receipt>;
  agents: Map<string, FakeAgent>;
}

function makeFakeState(): FakeState {
  return { messages: new Map(), receipts: new Map(), agents: new Map() };
}

function registerAgents(
  state: FakeState,
  fleetId: string,
  agentIds: string[],
  launchConfigs: Record<string, { requestedAgent?: string; requestedModel?: string }> = {}
): void {
  for (const id of agentIds) {
    state.agents.set(`${fleetId}:${id}`, {
      fleetId,
      ...(launchConfigs[id] ?? {}),
    });
  }
}

/** Injectable failure points, keyed by predicate over the exact call being
 *  made — deliberately NOT ordinal-count-based, so a test targets a specific
 *  receipt ACTION (per the blueprint §1 grammar) rather than coupling itself
 *  to an assumed internal call order. Each fires (and self-clears) exactly
 *  once, the first time its predicate matches. */
interface LedgerFaults {
  throwOnWriteReceipt?: (action: string, messageId: string, agentId: string) => boolean;
  throwOnAppendMessage?: (input: NewMessage) => boolean;
  missingLaunchConfigFor?: Set<string>;
}

class FakeLedgerTxImpl implements LedgerTx {
  constructor(
    private readonly draft: FakeState,
    private readonly clock: ClockFn,
    private readonly faults: LedgerFaults
  ) {}

  now(): number {
    return this.clock();
  }

  agentExists(agentId: string, fleetId: string): boolean {
    const a = this.draft.agents.get(`${fleetId}:${agentId}`);
    return !!a && a.fleetId === fleetId;
  }

  agentLaunchConfig(
    agentId: string,
    fleetId: string
  ): { requestedAgent?: string; requestedModel?: string } | undefined {
    if (this.faults.missingLaunchConfigFor?.has(`${fleetId}:${agentId}`)) {
      return undefined;
    }
    const a = this.draft.agents.get(`${fleetId}:${agentId}`);
    if (!a || a.fleetId !== fleetId) return undefined;
    const out: { requestedAgent?: string; requestedModel?: string } = {};
    if (a.requestedAgent !== undefined) out.requestedAgent = a.requestedAgent;
    if (a.requestedModel !== undefined) out.requestedModel = a.requestedModel;
    return out;
  }

  getMessage(messageId: string): Message | undefined {
    return this.draft.messages.get(messageId);
  }

  messagesByCorrelation(discussionId: string): Message[] {
    return Array.from(this.draft.messages.values()).filter((m) => m.correlation_id === discussionId);
  }

  receiptsForMessage(messageId: string): Receipt[] {
    return Array.from(this.draft.receipts.values()).filter((r) => r.message_id === messageId);
  }

  allReceiptsForDiscussion(discussionId: string): Receipt[] {
    const ids = new Set(this.messagesByCorrelation(discussionId).map((m) => m.id));
    return Array.from(this.draft.receipts.values()).filter((r) => ids.has(r.message_id));
  }

  appendMessage(input: NewMessage): Message {
    if (this.faults.throwOnAppendMessage?.(input)) {
      this.faults.throwOnAppendMessage = undefined;
      throw new Error(`injected appendMessage failure for ${input.id}`);
    }
    if (this.draft.messages.has(input.id)) {
      throw new Error(`duplicate message id ${input.id}`);
    }
    const msg: Message = { ...input, acknowledged: false };
    this.draft.messages.set(input.id, msg);
    return msg;
  }

  writeReceipt(messageId: string, agentId: string, action: string, note?: string): Receipt {
    const key = `${messageId}:${agentId}:${action}`;
    const existing = this.draft.receipts.get(key);
    if (existing) return existing;
    if (this.faults.throwOnWriteReceipt?.(action, messageId, agentId)) {
      this.faults.throwOnWriteReceipt = undefined;
      throw new Error(`injected writeReceipt failure for ${action}`);
    }
    const receipt: Receipt = {
      message_id: messageId,
      agent_id: agentId,
      action,
      timestamp: this.clock(),
      ...(note !== undefined ? { note } : {}),
    };
    this.draft.receipts.set(key, receipt);
    return receipt;
  }

  countRecentWakeReservations(agentId: string, windowStartMs: number, nowMs: number): number {
    let n = 0;
    for (const r of this.draft.receipts.values()) {
      if (r.agent_id !== agentId) continue;
      if (!r.action.startsWith("discussion.wake.reserved.v1:")) continue;
      if (r.timestamp >= windowStartMs && r.timestamp <= nowMs) n++;
    }
    return n;
  }
}

/**
 * Builds the `LedgerFn` itself: one synchronous call = one atomic
 * transaction over a copy-on-write draft. Commits only if `mutator` returns
 * normally; any throw (including an injected fault) discards the WHOLE draft,
 * so a fault injected after an `appendMessage` still rolls that append back
 * too — the generic mechanism tests 49/50 rely on. Also enforces the same
 * synchronous-mutator invariant `src/db.ts`'s real `withLedger` enforces
 * (test 52).
 */
function makeRawLedger(state: FakeState, clock: ClockFn, faults: LedgerFaults): LedgerFn {
  return function ledger<T>(mutator: (tx: LedgerTx) => T): T {
    const draft: FakeState = {
      messages: new Map(state.messages),
      receipts: new Map(state.receipts),
      agents: new Map(state.agents),
    };
    const tx = new FakeLedgerTxImpl(draft, clock, faults);
    const result = mutator(tx);
    if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
      throw new Error("ledger mutator must be synchronous (it returned a thenable)");
    }
    // Commit: only reached if `mutator` returned normally (no throw).
    state.messages = draft.messages;
    state.receipts = draft.receipts;
    state.agents = draft.agents;
    return result;
  };
}

// ============================================================
// Barrier — genuine concurrency for tests 27/44/G1 (cdx: "start two promises
// against the txn barrier, not Promise.resolve wrappers"). Each `arrive()`
// call suspends until ALL parties have called it; only then do ALL suspended
// promises resume (in the same microtask batch). This guarantees both
// dispatched calls are in flight — neither has touched the store yet — before
// either one proceeds into it, unlike `Promise.resolve(store.foo())` (which
// eagerly and fully executes the first call before the second is even
// invoked, since JS evaluates the argument before wrapping it).
// ============================================================

class Barrier {
  private arrivedCount = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly parties: number) {}
  arrive(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      this.arrivedCount++;
      if (this.arrivedCount === this.parties) {
        const toRelease = this.waiters;
        this.waiters = [];
        this.arrivedCount = 0;
        for (const w of toRelease) w();
      }
    });
  }
}

// ============================================================
// Harness
// ============================================================

interface RecordedSpawnCall {
  job: SpawnJob;
  handle: SpawnHandle;
  /** Simulates the child process's 'exit' event firing (test 30). */
  triggerExit: (info?: ChildExitInfo) => void;
}

interface Harness {
  state: FakeState;
  deps: DiscussionStoreDeps;
  store: DiscussionStore;
  spawnCalls: RecordedSpawnCall[];
  killCalls: SpawnHandle[];
  notifyEvents: unknown[];
  /** Mutable — advance `clockRef.value` to move the injected clock forward deterministically. */
  clockRef: { value: number };
  ledgerFaults: LedgerFaults;
  /** Records "ledger:return" / "spawn:called" / "notify:called" in real call
   *  order — the ordering proof for tests 45 and 51. */
  sequence: string[];
}

function makeHarness(
  opts: {
    guardConfig?: GuardConfig;
    state?: FakeState;
    registerDefaultAgents?: boolean;
    notify?: NotifyFn;
  } = {}
): Harness {
  const state = opts.state ?? makeFakeState();
  if (opts.registerDefaultAgents !== false) registerAgents(state, FLEET, [AGENT_A, AGENT_B]);

  const clockRef = { value: 1_700_000_000_000 };
  const clock: ClockFn = () => clockRef.value;
  const ledgerFaults: LedgerFaults = {};
  const sequence: string[] = [];
  const spawnCalls: RecordedSpawnCall[] = [];
  const killCalls: SpawnHandle[] = [];
  const notifyEvents: unknown[] = [];

  const rawLedger = makeRawLedger(state, clock, ledgerFaults);
  const ledger: LedgerFn = (mutator) => {
    const result = rawLedger(mutator);
    sequence.push("ledger:return");
    return result;
  };

  const spawn: SpawnFn = (job, onExit) => {
    const handle: SpawnHandle = { attempt_id: job.attempt_id, handle: { killed: false } };
    spawnCalls.push({ job, handle, triggerExit: (info = { code: 0 }) => onExit(info) });
    sequence.push("spawn:called");
    return handle;
  };

  const kill: KillFn = (handle) => {
    killCalls.push(handle);
    (handle.handle as { killed: boolean }).killed = true;
  };

  const notify: NotifyFn = (event) => {
    notifyEvents.push(event);
    sequence.push("notify:called");
  };

  const deps: DiscussionStoreDeps = {
    ledger,
    spawn,
    kill,
    clock,
    notify: opts.notify ?? notify,
    guardConfig: opts.guardConfig ?? DEFAULT_GUARD_CONFIG,
  };

  const store = createDiscussionStore(deps);
  return { state, deps, store, spawnCalls, killCalls, notifyEvents, clockRef, ledgerFaults, sequence };
}

async function openRoot(store: DiscussionStore, overrides: Partial<AskPeerParams> = {}): Promise<OpenDiscussionResult> {
  return store.openDiscussion(defaultAskPeerParams(overrides));
}

function snapshotSizes(state: FakeState): { messages: number; receipts: number } {
  return { messages: state.messages.size, receipts: state.receipts.size };
}

function countReceiptsForAction(state: FakeState, action: string): number {
  return Array.from(state.receipts.values()).filter((r) => r.action === action).length;
}

/** A `DiscussionError`-shaped rejection matcher — used for EVERY expected
 *  application-level rejection in this suite instead of a bare, matcher-less
 *  `assert.rejects`. A bare `assert.rejects(fn)` would accept ANY rejection —
 *  including the current stub's `NOT_IMPLEMENTED` throw — which would make
 *  the surrounding zero-mutation assertions accidentally pass against a stub
 *  that never touches the ledger at all. Requiring `instanceof DiscussionError`
 *  (which the stub never throws) keeps every such test genuinely red now. */
function isDiscussionError(code: string, extra?: (err: DiscussionError) => boolean) {
  return (err: unknown): boolean => err instanceof DiscussionError && err.code === code && (extra ? extra(err) : true);
}

/** For fault-injection tests (49/50/51) where the FUTURE rejection reason is
 *  an arbitrary propagated internal error (not necessarily a `DiscussionError`
 *  — it's an unexpected fault, not a normal validation rejection), so we
 *  cannot require a specific `DiscussionError` code. Requiring "any rejection
 *  reason that ISN'T the current stub's marker" still keeps the test
 *  genuinely red now (the stub's `NOT_IMPLEMENTED` message is rejected by
 *  this matcher, so `assert.rejects` itself fails and its failure output
 *  embeds the actual NOT_IMPLEMENTED error) while asserting nothing about
 *  what the eventual real error looks like. */
function isNotTheNotImplementedStub(err: unknown): boolean {
  return !(err instanceof Error && /NOT_IMPLEMENTED/.test(err.message));
}

// ============================================================
// Anti-loop and budgeting — spec tests 23-34
// ============================================================

test("D2-red #23 — delivering an SSE event results in zero run-launch calls", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store);
  // "An SSE event arrives": a message/receipt lands directly in the ledger,
  // OUTSIDE any wake/reply call. Per spec §10 the resident supervisor "only
  // marks the durable inbox dirty" — the ingestion loop itself is out of this
  // store's scope (see file header, resolution 1); what IS in scope is the
  // invariant that reconciling via a read must never spawn.
  h.deps.ledger((tx) => tx.writeReceipt(opened.root_message_id, AGENT_B, "seen"));
  h.store.getDiscussion({ discussion_id: opened.discussion_id }); // the reconciliation read
  assert.equal(h.spawnCalls.length, 0);
});

test("D2-red #24 — inbox polling results in zero run-launch calls", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store);
  for (let i = 0; i < 5; i++) {
    h.store.getDiscussion({ discussion_id: opened.discussion_id });
  }
  assert.equal(h.spawnCalls.length, 0);
});

test("D2-red #25 — SSE reconnect and reconciliation result in zero run-launch calls", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store);
  h.store.getDiscussion({ discussion_id: opened.discussion_id }); // reconcile before "reconnect"
  await h.store.sweepStranded(h.clockRef.value); // periodic reconciliation sweep
  h.store.getDiscussion({ discussion_id: opened.discussion_id }); // reconcile after "reconnect"
  assert.equal(h.spawnCalls.length, 0);
});

test("D2-red #26 — one explicit wake starts exactly one process", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store);
  const result = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  assert.equal(result.turn, 2);
  assert.ok(result.attempt_id.length > 0);
  assert.equal(h.spawnCalls.length, 1);
  const job = h.spawnCalls[0].job;
  assert.equal(job.discussion_id, opened.discussion_id);
  assert.equal(job.agent_id, AGENT_B);
  assert.equal(job.attempt_id, result.attempt_id);
  assert.equal(job.turn, 2);
  assert.equal(job.head_message_id, opened.root_message_id);
  assert.equal(job.deadline, result.deadline);
  assert.equal(job.policy.max_turns, 4);
  assert.ok(job.transcript.some((entry) => entry.message.id === opened.root_message_id));
});

test("D2-red #27 — concurrent duplicate wakes start exactly one process", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store);
  const barrier = new Barrier(2);
  const wakeParams = {
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  };
  async function dispatch() {
    await barrier.arrive(); // neither call touches the store until BOTH are in flight
    return h.store.wakeAgent(wakeParams);
  }
  const [r1, r2] = await Promise.all([dispatch(), dispatch()]);
  assert.equal(h.spawnCalls.length, 1, "duplicate concurrent wakes must never launch twice");
  assert.equal(r1.attempt_id, r2.attempt_id, "the second caller must observe the SAME existing attempt");
  assert.equal(r1.turn, 2);
  assert.equal(r2.turn, 2);
});

test("D2-red #28 — max_turns cannot be increased after opening", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store, { max_turns: 2 });
  const before = h.store.getDiscussion({ discussion_id: opened.discussion_id });
  assert.equal(before.policy.max_turns, 2);

  // Attempt to smuggle a larger budget via a forged child envelope carrying
  // its own `policy` block — §6: "Only the root carries `policy`."
  h.deps.ledger((tx) =>
    tx.appendMessage({
      id: "forged-policy-bump",
      from_agent_id: AGENT_B,
      to_agent_id: AGENT_A,
      fleet_id: FLEET,
      type: "result",
      correlation_id: opened.discussion_id,
      timestamp: h.clockRef.value,
      payload: JSON.stringify({
        $meshfleet: "discussion/v1",
        discussion_id: opened.discussion_id,
        turn: 2,
        attempt_id: "forged-attempt",
        reply_to: opened.root_message_id,
        kind: "result",
        body: "pretend the budget is bigger now",
        close: false,
        // max_turns capped at the spec's own immutable bound (32, not 99): see
        // this suite's implementation report, "test-contract conflict #1" —
        // src/discussion.ts's `isPolicyShape` (src/discussion.ts:64-65,95)
        // independently rejects ANY policy with max_turns > MAX_MAX_TURNS (32)
        // as an unparseable envelope ("invalid_envelope") before the
        // turn!==1-with-policy check that yields `child_policy_forbidden` is
        // ever reached (src/discussion.ts:412-421). A max_turns of 99 can
        // never reach that check, so it cannot exercise this test's actual
        // intent (lane-1 §11 / d3-wiring-blueprint.md §4: max_turns is
        // integer 2..32) — 32 is the largest value that still parses AND is
        // "bigger" than the real policy's max_turns of 4, preserving the
        // test's own "pretend the budget is bigger now" narrative.
        policy: { participants: [AGENT_A, AGENT_B], max_turns: 32, conversation_deadline: h.clockRef.value + 60_000, turn_timeout_ms: 5000 },
      }),
    })
  );

  const after = h.store.getDiscussion({ discussion_id: opened.discussion_id });
  assert.equal(after.policy.max_turns, 2, "the immutable root policy must be unaffected by a forged child policy");
  assert.ok(
    after.integrity_findings.some((f) => f.code === "child_policy_forbidden" && f.message_id === "forged-policy-bump"),
    `expected a child_policy_forbidden finding, got: ${JSON.stringify(after.integrity_findings)}`
  );
});

test("D2-red #29 — failed spawn consumes one turn and does not auto-retry", async () => {
  const h = makeHarness();
  h.deps.spawn = () => {
    throw new Error("injected spawn failure");
  };
  const opened = await openRoot(h.store);
  const result = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  assert.equal(result.turn, 2, "the reservation itself must succeed even though the launch failed");
  const view = h.store.getDiscussion({ discussion_id: opened.discussion_id });
  const attempt = view.attempts.find((a) => a.attempt_id === result.attempt_id);
  assert.equal(attempt?.state, "failed");
  assert.equal(view.turns_used, 2, "the failed reservation still consumes its turn");
  assert.equal(h.killCalls.length, 0, "nothing was ever launched, so nothing needs killing");
});

test("D2-red #30 — child exit without a reply consumes the turn and does not auto-retry", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store);
  const wake = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  assert.equal(h.spawnCalls.length, 1);
  h.spawnCalls[0].triggerExit({ code: 0 }); // the child ran and exited WITHOUT ever calling reply_discussion
  const view = h.store.getDiscussion({ discussion_id: opened.discussion_id });
  const attempt = view.attempts.find((a) => a.attempt_id === wake.attempt_id);
  assert.equal(attempt?.state, "failed");
  assert.equal(view.turns_used, 2);
  assert.equal(h.spawnCalls.length, 1, "no automatic second launch for the same turn");
});

test("D2-red #31 — deadman kills the child and writes exactly one terminal receipt", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store, { turn_timeout_ms: 1_000 });
  const wake = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  assert.equal(h.spawnCalls.length, 1);

  h.clockRef.value = wake.deadline + 1;
  const sweep = await h.store.sweepStranded(h.clockRef.value);
  assert.equal(sweep.terminalized.length, 1);
  assert.equal(sweep.terminalized[0].attempt_id, wake.attempt_id);
  assert.equal(sweep.terminalized[0].state, "deadman");
  assert.equal(h.killCalls.length, 1);
  assert.equal(h.killCalls[0].attempt_id, wake.attempt_id);

  const view = h.store.getDiscussion({ discussion_id: opened.discussion_id });
  const attempt = view.attempts.find((a) => a.attempt_id === wake.attempt_id);
  assert.equal(attempt?.state, "deadman");

  // Idempotent: a second sweep finds nothing left to do, and does not kill again.
  const sweep2 = await h.store.sweepStranded(h.clockRef.value + 10_000);
  assert.equal(sweep2.terminalized.length, 0);
  assert.equal(h.killCalls.length, 1);
});

test("D2-red #32a — no wake accepted once closed", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store);
  const wake = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  const reply = await h.store.replyDiscussion({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    attempt_id: wake.attempt_id,
    reply_to_message_id: opened.root_message_id,
    type: "result",
    payload: "done",
    close: true,
  });
  assert.equal(reply.status, "closed");

  const before = snapshotSizes(h.state);
  await assert.rejects(
    () =>
      h.store.wakeAgent({ agent_id: AGENT_A, discussion_id: opened.discussion_id, expected_head_message_id: reply.message_id }),
    isDiscussionError("terminal_state", (e) => e.detail.status === "closed")
  );
  assert.deepEqual(snapshotSizes(h.state), before, "a rejected wake must leave the ledger untouched");
  assert.equal(h.spawnCalls.length, 1, "only the original wake ever launched");
});

test("D2-red #32b — no wake accepted once exhausted", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store, { max_turns: 2 });
  const wake = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  const reply = await h.store.replyDiscussion({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    attempt_id: wake.attempt_id,
    reply_to_message_id: opened.root_message_id,
    type: "result",
    payload: "no more turns",
    close: false,
  });
  assert.equal(reply.status, "exhausted");

  const before = snapshotSizes(h.state);
  await assert.rejects(
    () =>
      h.store.wakeAgent({ agent_id: AGENT_A, discussion_id: opened.discussion_id, expected_head_message_id: reply.message_id }),
    isDiscussionError("terminal_state", (e) => e.detail.status === "exhausted")
  );
  assert.deepEqual(snapshotSizes(h.state), before);
});

test("D2-red #32c — no wake accepted once the conversation deadline has passed", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store, { timeout_ms: 1_000, turn_timeout_ms: 1_000 });
  h.clockRef.value += 2_000; // past conversation_deadline; nothing was ever reserved

  const before = snapshotSizes(h.state);
  await assert.rejects(
    () =>
      h.store.wakeAgent({ agent_id: AGENT_B, discussion_id: opened.discussion_id, expected_head_message_id: opened.root_message_id }),
    isDiscussionError("terminal_state", (e) => e.detail.status === "expired")
  );
  assert.deepEqual(snapshotSizes(h.state), before);
  assert.equal(h.spawnCalls.length, 0);
});

test("D2-red #32d — no wake accepted once deadman", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store, { turn_timeout_ms: 1_000 });
  const wake = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  h.clockRef.value = wake.deadline + 1;
  await h.store.sweepStranded(h.clockRef.value);
  const view = h.store.getDiscussion({ discussion_id: opened.discussion_id });
  assert.equal(view.status, "deadman");

  const before = snapshotSizes(h.state);
  await assert.rejects(
    () =>
      h.store.wakeAgent({ agent_id: AGENT_A, discussion_id: opened.discussion_id, expected_head_message_id: opened.root_message_id }),
    isDiscussionError("terminal_state", (e) => e.detail.status === "deadman")
  );
  assert.deepEqual(snapshotSizes(h.state), before);
});

test("D2-red #32e — no wake accepted once the aggregate is invalid", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store);
  // A second valid-shaped root for the SAME discussion id — an unambiguous invalidation trigger.
  h.deps.ledger((tx) =>
    tx.appendMessage({
      id: "forged-second-root",
      from_agent_id: AGENT_A,
      to_agent_id: AGENT_B,
      fleet_id: FLEET,
      type: "question",
      correlation_id: opened.discussion_id,
      timestamp: h.clockRef.value,
      payload: JSON.stringify({
        $meshfleet: "discussion/v1",
        discussion_id: opened.discussion_id,
        turn: 1,
        attempt_id: "forged-root-attempt",
        reply_to: null,
        kind: "question",
        body: "forged duplicate root",
        close: false,
        policy: { participants: [AGENT_A, AGENT_B], max_turns: 4, conversation_deadline: h.clockRef.value + 60_000, turn_timeout_ms: 5000 },
      }),
    })
  );
  const view = h.store.getDiscussion({ discussion_id: opened.discussion_id });
  assert.equal(view.status, "invalid");

  const before = snapshotSizes(h.state);
  await assert.rejects(
    () =>
      h.store.wakeAgent({ agent_id: AGENT_B, discussion_id: opened.discussion_id, expected_head_message_id: opened.root_message_id }),
    isDiscussionError("terminal_state", (e) => e.detail.status === "invalid")
  );
  assert.deepEqual(snapshotSizes(h.state), before);
});

test("D2-red #33 — a stranded RESERVED-only attempt (never launched) is terminalized by the sweeper", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store, { turn_timeout_ms: 1_000 });
  const forgedAttemptId = "forged-attempt-reserved-only";
  const deadline = h.clockRef.value + 1_000;
  const note = JSON.stringify({ discussion_id: opened.discussion_id, head_message_id: opened.root_message_id, deadline });
  // Simulates a crash between reservation-commit and launcher-invocation:
  // the reservation receipt exists, but `spawn` was never called for it.
  h.deps.ledger((tx) => tx.writeReceipt(opened.root_message_id, AGENT_B, `discussion.wake.reserved.v1:2:${forgedAttemptId}`, note));
  assert.equal(h.spawnCalls.length, 0);

  h.clockRef.value = deadline + 1;
  const sweep = await h.store.sweepStranded(h.clockRef.value);
  assert.equal(sweep.terminalized.length, 1);
  assert.equal(sweep.terminalized[0].attempt_id, forgedAttemptId);
  assert.equal(sweep.terminalized[0].state, "deadman");

  const view = h.store.getDiscussion({ discussion_id: opened.discussion_id });
  assert.equal(view.attempts.find((a) => a.attempt_id === forgedAttemptId)?.state, "deadman");

  const sweep2 = await h.store.sweepStranded(h.clockRef.value + 10_000);
  assert.equal(sweep2.terminalized.length, 0);
});

test("D2-red #34 — a second reply from one attempt is rejected", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store);
  const wake = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  await h.store.replyDiscussion({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    attempt_id: wake.attempt_id,
    reply_to_message_id: opened.root_message_id,
    type: "question",
    payload: "first reply",
    close: false,
  });

  const before = snapshotSizes(h.state);
  await assert.rejects(
    () =>
      h.store.replyDiscussion({
        agent_id: AGENT_B,
        discussion_id: opened.discussion_id,
        attempt_id: wake.attempt_id,
        reply_to_message_id: opened.root_message_id,
        type: "question",
        payload: "second reply, same attempt",
        close: false,
      }),
    isDiscussionError("second_reply")
  );
  assert.deepEqual(snapshotSizes(h.state), before, "a rejected second reply must append no message and write no receipt");
});

// ============================================================
// Receipts and concurrency — spec tests 44-52
// ============================================================

test("D2-red #44 — reservation and turn allocation are atomic under concurrent independent writers", async () => {
  const h = makeHarness();
  const barrier = new Barrier(2);
  async function dispatch(payload: string) {
    await barrier.arrive();
    return h.store.openDiscussion(defaultAskPeerParams({ payload, wake_peer: true }));
  }
  const [r1, r2] = await Promise.all([dispatch("q1"), dispatch("q2")]);
  assert.notEqual(r1.discussion_id, r2.discussion_id);
  assert.notEqual(r1.root_message_id, r2.root_message_id);
  assert.ok(r1.reservation && r2.reservation);
  assert.notEqual(r1.reservation!.attempt_id, r2.reservation!.attempt_id);
  assert.equal(h.spawnCalls.length, 2, "one independent launch per independent discussion");

  const v1 = h.store.getDiscussion({ discussion_id: r1.discussion_id });
  const v2 = h.store.getDiscussion({ discussion_id: r2.discussion_id });
  assert.equal(v1.attempts.length, 1);
  assert.equal(v2.attempts.length, 1);
  assert.equal(v1.attempts[0].turn, 2);
  assert.equal(v2.attempts[0].turn, 2);
});

test("D2-red #45 — a spawn cannot begin before its reservation commits", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store);
  h.sequence.length = 0; // isolate the wake call's own ordering
  await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  const ledgerIdx = h.sequence.indexOf("ledger:return");
  const spawnIdx = h.sequence.indexOf("spawn:called");
  assert.ok(ledgerIdx !== -1, "expected the reservation to commit through the ledger seam");
  assert.ok(spawnIdx !== -1, "expected spawn to be called");
  assert.ok(ledgerIdx < spawnIdx, `expected ledger commit strictly before spawn; got order: ${h.sequence.join(",")}`);
});

test("D2-red #46 — completed, failed, and deadman are mutually exclusive terminal states", async () => {
  // (a) completed wins; a later deadman sweep must not also terminalize it.
  const h1 = makeHarness();
  const opened1 = await openRoot(h1.store, { turn_timeout_ms: 1_000 });
  const wake1 = await h1.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened1.discussion_id,
    expected_head_message_id: opened1.root_message_id,
  });
  await h1.store.replyDiscussion({
    agent_id: AGENT_B,
    discussion_id: opened1.discussion_id,
    attempt_id: wake1.attempt_id,
    reply_to_message_id: opened1.root_message_id,
    type: "result",
    payload: "answer",
    close: false,
  });
  h1.clockRef.value = wake1.deadline + 1;
  const sweep1 = await h1.store.sweepStranded(h1.clockRef.value);
  assert.equal(sweep1.terminalized.length, 0, "already-terminal (completed) attempts are not the sweeper's business");
  assert.equal(h1.killCalls.length, 0);
  const view1 = h1.store.getDiscussion({ discussion_id: opened1.discussion_id });
  assert.equal(view1.attempts.find((a) => a.attempt_id === wake1.attempt_id)?.state, "completed");

  // (b) deadman wins; a later reply attempt against the same (already dead) attempt is rejected outright.
  const h2 = makeHarness();
  const opened2 = await openRoot(h2.store, { turn_timeout_ms: 1_000 });
  const wake2 = await h2.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened2.discussion_id,
    expected_head_message_id: opened2.root_message_id,
  });
  h2.clockRef.value = wake2.deadline + 1;
  await h2.store.sweepStranded(h2.clockRef.value);
  await assert.rejects(
    () =>
      h2.store.replyDiscussion({
        agent_id: AGENT_B,
        discussion_id: opened2.discussion_id,
        attempt_id: wake2.attempt_id,
        reply_to_message_id: opened2.root_message_id,
        type: "result",
        payload: "too late",
        close: false,
      }),
    isDiscussionError("attempt_not_active")
  );
  const view2 = h2.store.getDiscussion({ discussion_id: opened2.discussion_id });
  assert.equal(view2.attempts.find((a) => a.attempt_id === wake2.attempt_id)?.state, "deadman");
  assert.equal(view2.transcript.length, 1, "the rejected late reply must never be appended");
});

test("D2-red #47 — duplicate receipt writes remain idempotent", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store);
  const wake = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  const reply = await h.store.replyDiscussion({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    attempt_id: wake.attempt_id,
    reply_to_message_id: opened.root_message_id,
    type: "result",
    payload: "answer",
    close: true,
  });

  const completedAction = `discussion.wake.completed.v1:2:${wake.attempt_id}`;
  assert.equal(countReceiptsForAction(h.state, completedAction), 1);
  const original = Array.from(h.state.receipts.values()).find((r) => r.action === completedAction);
  assert.ok(original);

  // A hypothetical duplicate internal write attempt (same key) must be a
  // no-op — mirrors core.ts's `_writeReceipt` idempotency the real ledger
  // depends on, and which this fake mirrors identically.
  const note = JSON.stringify({
    discussion_id: opened.discussion_id,
    head_message_id: opened.root_message_id,
    deadline: wake.deadline,
    reply_message_id: reply.message_id,
  });
  const dup = h.deps.ledger((tx) => tx.writeReceipt(opened.root_message_id, AGENT_B, completedAction, note));
  assert.equal(countReceiptsForAction(h.state, completedAction), 1, "no second receipt must be created");
  assert.equal(dup.timestamp, original!.timestamp, "the existing receipt must be returned unchanged, not overwritten");
});

test("D2-red #48 — forged or unmatched discussion.* receipts produce integrity findings", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store);

  // An action that doesn't parse as any known lifecycle event at all.
  h.deps.ledger((tx) => tx.writeReceipt(opened.root_message_id, AGENT_B, "discussion.bogus.v1:2:forged-attempt"));
  // A wake-shaped action whose note is missing required fields.
  h.deps.ledger((tx) =>
    tx.writeReceipt(opened.root_message_id, AGENT_B, "discussion.wake.reserved.v1:2:forged-attempt-2", JSON.stringify({ discussion_id: opened.discussion_id }))
  );

  const view = h.store.getDiscussion({ discussion_id: opened.discussion_id });
  const codes = view.integrity_findings.map((f) => f.code);
  assert.ok(codes.includes("unmatched_receipt"), `expected an unmatched_receipt finding; got: ${codes.join(",")}`);
  assert.ok(codes.includes("malformed_receipt_note"), `expected a malformed_receipt_note finding; got: ${codes.join(",")}`);
  assert.equal(view.attempts.length, 0, "neither forged receipt may authorize a real attempt");
});

test("D2-red #49 — root send plus root receipt commit atomically", async () => {
  const h = makeHarness();
  h.ledgerFaults.throwOnWriteReceipt = (action) => action.startsWith("discussion.turn.sent.v1");
  await assert.rejects(() => openRoot(h.store), isNotTheNotImplementedStub);
  assert.equal(
    h.ledgerFaults.throwOnWriteReceipt,
    undefined,
    "expected the injected fault to actually fire (the root receipt write must be attempted)"
  );
  assert.equal(h.state.messages.size, 0, "the root message must not survive a rolled-back transaction");
  assert.equal(h.state.receipts.size, 0);
});

test("D2-red #50 — reply message plus completion receipt commit atomically", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store);
  const wake = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  const beforeMessages = h.state.messages.size;
  const beforeReceipts = h.state.receipts.size;

  h.ledgerFaults.throwOnWriteReceipt = (action) => action.startsWith("discussion.wake.completed.v1");
  await assert.rejects(
    () =>
      h.store.replyDiscussion({
        agent_id: AGENT_B,
        discussion_id: opened.discussion_id,
        attempt_id: wake.attempt_id,
        reply_to_message_id: opened.root_message_id,
        type: "result",
        payload: "answer",
        close: true,
      }),
    isNotTheNotImplementedStub
  );
  assert.equal(
    h.ledgerFaults.throwOnWriteReceipt,
    undefined,
    "expected the injected fault to actually fire (the completion receipt write must be attempted)"
  );
  assert.equal(h.state.messages.size, beforeMessages, "the reply message must not survive a rolled-back transaction");
  assert.equal(h.state.receipts.size, beforeReceipts);
});

test("D2-red #51 — notification occurs only after commit", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store);
  h.sequence.length = 0;
  await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  const ledgerIdx = h.sequence.indexOf("ledger:return");
  const notifyIdx = h.sequence.indexOf("notify:called");
  assert.ok(ledgerIdx !== -1 && notifyIdx !== -1);
  assert.ok(ledgerIdx < notifyIdx, `expected commit strictly before notify; got order: ${h.sequence.join(",")}`);

  // A rolled-back transaction must produce zero notifications.
  const h2 = makeHarness();
  h2.ledgerFaults.throwOnWriteReceipt = (action) => action.startsWith("discussion.turn.sent.v1");
  await assert.rejects(() => openRoot(h2.store), isNotTheNotImplementedStub);
  assert.equal(h2.ledgerFaults.throwOnWriteReceipt, undefined, "expected the injected fault to actually fire");
  assert.equal(h2.notifyEvents.length, 0, "a rolled-back transaction must produce zero notifications");
});

test("D2 reliability — notifier failure cannot hide a committed root or block its reserved launch", async () => {
  const h = makeHarness({
    notify: () => {
      throw new Error("subscriber transport unavailable");
    },
  });

  const opened = await openRoot(h.store, { wake_peer: true });

  assert.ok(opened.discussion_id, "the committed root must still be returned");
  assert.equal(opened.wake_reserved, true);
  assert.equal(h.spawnCalls.length, 1, "the reserved attempt must still launch");
  const view = h.store.getDiscussion({ discussion_id: opened.discussion_id });
  assert.equal(view.transcript.length, 1, "the committed root remains readable");
  assert.equal(view.attempts[0]?.state, "started");
});

test("D2 reliability — notifier failure cannot block an explicitly reserved wake launch", async () => {
  let notificationsFail = false;
  const h = makeHarness({
    notify: () => {
      if (notificationsFail) throw new Error("subscriber transport unavailable");
    },
  });
  const opened = await openRoot(h.store);
  notificationsFail = true;

  const wake = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });

  assert.ok(wake.attempt_id);
  assert.equal(h.spawnCalls.length, 1, "post-commit notification failure must not strand the reservation");
  assert.equal(
    h.store.getDiscussion({ discussion_id: opened.discussion_id }).attempts[0]?.state,
    "started"
  );
});

test("D2 reliability — notifier failure cannot turn a committed reply into an apparent rejection", async () => {
  let notificationsFail = false;
  const h = makeHarness({
    notify: () => {
      if (notificationsFail) throw new Error("subscriber transport unavailable");
    },
  });
  const opened = await openRoot(h.store);
  const wake = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  notificationsFail = true;

  const reply = await h.store.replyDiscussion({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    attempt_id: wake.attempt_id,
    reply_to_message_id: opened.root_message_id,
    type: "result",
    payload: "answer",
    close: true,
  });

  assert.equal(reply.status, "closed");
  const view = h.store.getDiscussion({ discussion_id: opened.discussion_id });
  assert.equal(view.status, "closed");
  assert.equal(view.transcript.length, 2);
});

test("D2 reliability — notifier failure cannot escape a child exit callback after durable settlement", async () => {
  let notificationsFail = false;
  const h = makeHarness({
    notify: () => {
      if (notificationsFail) throw new Error("subscriber transport unavailable");
    },
  });
  const opened = await openRoot(h.store);
  await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  notificationsFail = true;

  assert.doesNotThrow(() => h.spawnCalls[0]!.triggerExit({ code: 1 }));
  assert.equal(
    h.store.getDiscussion({ discussion_id: opened.discussion_id }).attempts[0]?.state,
    "failed"
  );
});

test("D2 reliability — notifier failure cannot stop a stranded-attempt sweep after its first settlement", async () => {
  let notificationsFail = false;
  const h = makeHarness({
    notify: () => {
      if (notificationsFail) throw new Error("subscriber transport unavailable");
    },
  });
  const first = await openRoot(h.store);
  await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: first.discussion_id,
    expected_head_message_id: first.root_message_id,
  });
  const second = await openRoot(h.store);
  await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: second.discussion_id,
    expected_head_message_id: second.root_message_id,
  });
  notificationsFail = true;
  h.clockRef.value += 301_000;

  const swept = await h.store.sweepStranded(h.clockRef.value);

  assert.equal(swept.terminalized.length, 2, "both durable settlements must be returned");
  assert.deepEqual(
    new Set(swept.terminalized.map((entry) => entry.discussion_id)),
    new Set([first.discussion_id, second.discussion_id])
  );
  assert.equal(h.killCalls.length, 2, "both local child handles must still be killed");
});

test("D2-red #52 — no asynchronous callback is ever passed to the ledger seam", async () => {
  const h = makeHarness();
  // Sanity-check the harness's own enforcement mirrors src/db.ts's real
  // `withLedger` guard (cdx fix-list #7: "Spy directly on withLedger and
  // reject thenable callbacks") — an async mutator must be rejected outright.
  assert.throws(() => {
    (h.deps.ledger as <T>(m: (tx: LedgerTx) => T) => T)(((async () => 1) as unknown) as (tx: LedgerTx) => number);
  }, /synchronous/);

  // The real proof: every store operation below must complete successfully
  // through THIS SAME enforcing seam. If any of the store's internal
  // mutators were ever async (returned a thenable), the harness's ledger
  // would throw "...must be synchronous..." and the operation would reject —
  // reaching the end of this test IS the proof that never happened.
  const opened = await openRoot(h.store);
  const wake = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  await h.store.replyDiscussion({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    attempt_id: wake.attempt_id,
    reply_to_message_id: opened.root_message_id,
    type: "result",
    payload: "answer",
    close: true,
  });
  assert.ok(opened.discussion_id);
  assert.ok(wake.attempt_id);
});

// ============================================================
// Kleppmann adds — restart-safety / no-refund correctness properties beyond
// the spec's own enumerated red-test list.
// ============================================================

test("D2-red K1 — killing a mid-turn attempt does not refund its consumed budget", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store, { max_turns: 2, turn_timeout_ms: 1_000 }); // root(1) + exactly one more turn
  const wake = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  h.clockRef.value = wake.deadline + 1;
  const sweep = await h.store.sweepStranded(h.clockRef.value);
  assert.equal(sweep.terminalized[0]?.state, "deadman");

  const view = h.store.getDiscussion({ discussion_id: opened.discussion_id });
  assert.equal(view.turns_used, 2, "the killed attempt's turn must NOT be refunded");
  assert.equal(view.turns_remaining, 0);
  assert.equal(view.status, "deadman", "deadman outranks exhausted in the §12 precedence");

  await assert.rejects(
    () =>
      h.store.wakeAgent({ agent_id: AGENT_A, discussion_id: opened.discussion_id, expected_head_message_id: view.head_message_id }),
    isDiscussionError("terminal_state", (e) => e.detail.status === "deadman")
  );
});

test("D2-red K2 — the deadman deadline is an absolute timestamp that survives a server restart", async () => {
  const state = makeFakeState();
  registerAgents(state, FLEET, [AGENT_A, AGENT_B]);
  const clockRef = { value: 1_700_000_000_000 };
  const clock: ClockFn = () => clockRef.value;

  function freshDeps(): DiscussionStoreDeps {
    const ledger = makeRawLedger(state, clock, {});
    return {
      ledger,
      spawn: (job, _onExit) => ({ attempt_id: job.attempt_id, handle: {} }),
      kill: () => {},
      clock,
      notify: () => {},
      guardConfig: DEFAULT_GUARD_CONFIG,
    };
  }

  const store1 = createDiscussionStore(freshDeps());
  const opened = await store1.openDiscussion(defaultAskPeerParams({ turn_timeout_ms: 5_000 }));
  const wake = await store1.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  const recordedDeadline = wake.deadline;
  assert.equal(recordedDeadline, clockRef.value + 5_000);

  // "Restart": a brand-new store instance — fresh in-memory launcher/waiter
  // state, zero prior bookkeeping — over the SAME underlying ledger. Mirrors
  // §9: "A server restart may lose the in-memory waiting call, but not the
  // discussion."
  clockRef.value += 2_000; // time passes during the "restart"
  const store2 = createDiscussionStore(freshDeps());

  const view = store2.getDiscussion({ discussion_id: opened.discussion_id });
  const attempt = view.attempts.find((a) => a.attempt_id === wake.attempt_id);
  assert.equal(attempt?.deadline, recordedDeadline, "the deadline must be unchanged by the restart, not recomputed relative to it");

  clockRef.value = recordedDeadline + 1;
  const sweep = await store2.sweepStranded(clockRef.value);
  assert.equal(sweep.terminalized[0]?.attempt_id, wake.attempt_id);
  assert.equal(sweep.terminalized[0]?.state, "deadman");
});

test("D2-red K3 — the attempt record rebuilds entirely from receipts after a restart (no hidden in-memory state)", async () => {
  const state = makeFakeState();
  registerAgents(state, FLEET, [AGENT_A, AGENT_B]);
  const clockRef = { value: 1_700_000_000_000 };
  const clock: ClockFn = () => clockRef.value;

  function freshDeps(): DiscussionStoreDeps {
    return {
      ledger: makeRawLedger(state, clock, {}),
      spawn: (job) => ({ attempt_id: job.attempt_id, handle: {} }),
      kill: () => {},
      clock,
      notify: () => {},
      guardConfig: DEFAULT_GUARD_CONFIG,
    };
  }

  const store1 = createDiscussionStore(freshDeps());
  const opened = await store1.openDiscussion(defaultAskPeerParams({}));
  const wake = await store1.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  await store1.replyDiscussion({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    attempt_id: wake.attempt_id,
    reply_to_message_id: opened.root_message_id,
    type: "result",
    payload: "the answer",
    close: true,
  });
  const viewBeforeRestart = store1.getDiscussion({ discussion_id: opened.discussion_id });

  // Full restart: fresh store, fresh spawn/kill/notify wiring, zero prior
  // in-memory launcher/attempt bookkeeping — only the ledger persists.
  const store2 = createDiscussionStore(freshDeps());
  const viewAfterRestart = store2.getDiscussion({ discussion_id: opened.discussion_id });

  assert.deepEqual(viewAfterRestart.attempts, viewBeforeRestart.attempts);
  assert.equal(viewAfterRestart.status, "closed");
  assert.equal(viewAfterRestart.status, viewBeforeRestart.status);
  assert.deepEqual(
    viewAfterRestart.transcript.map((t) => t.message.id),
    viewBeforeRestart.transcript.map((t) => t.message.id)
  );
});

// ============================================================
// Guard trio — hourly quota, global kill-switch, exactly-once escalation
// (d3-wiring-blueprint.md §0 "Guard configuration" / §0 "Exhaustion receipt
// pin"; cdx-author-review.md H0.2/H0.3: "Adopted guards: zero coverage").
// ============================================================

test("D2-red G1 — the hourly wake quota is enforced atomically under concurrent wakes", async () => {
  const h = makeHarness({ guardConfig: { ...DEFAULT_GUARD_CONFIG, wakeQuotaPerHour: 1 } });
  const opened1 = await openRoot(h.store, { payload: "q1" });
  const opened2 = await openRoot(h.store, { payload: "q2" }); // a second, independent discussion — same target agent B

  const barrier = new Barrier(2);
  async function dispatch(opened: OpenDiscussionResult) {
    await barrier.arrive();
    return h.store.wakeAgent({ agent_id: AGENT_B, discussion_id: opened.discussion_id, expected_head_message_id: opened.root_message_id });
  }
  const results = await Promise.allSettled([dispatch(opened1), dispatch(opened2)]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "exactly one wake may succeed under a quota of 1/hour");
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof DiscussionError && rejected[0].reason.code === "quota_exceeded");
  assert.equal(h.spawnCalls.length, 1, "the quota-rejected call must never launch");
});

test("D2-red G2 — the global kill switch denies both wake entry points", async () => {
  const h = makeHarness({ guardConfig: { ...DEFAULT_GUARD_CONFIG, globalKillSwitch: true } });

  await assert.rejects(() => openRoot(h.store, { wake_peer: true }), isDiscussionError("global_kill_active"));
  assert.equal(h.spawnCalls.length, 0);

  // Root creation alone (wake_peer:false) is NOT blocked by the kill switch — only wake reservation is.
  const opened = await openRoot(h.store, { wake_peer: false });
  await assert.rejects(
    () => h.store.wakeAgent({ agent_id: AGENT_B, discussion_id: opened.discussion_id, expected_head_message_id: opened.root_message_id }),
    isDiscussionError("global_kill_active")
  );
  assert.equal(h.spawnCalls.length, 0);
});

test("D2-red G3 — unresolved exhaustion writes exactly one escalation receipt", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store, { max_turns: 2 });
  const wake = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  const reply = await h.store.replyDiscussion({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    attempt_id: wake.attempt_id,
    reply_to_message_id: opened.root_message_id,
    type: "result",
    payload: "final",
    close: false,
  });
  assert.equal(reply.status, "exhausted");

  const escalations = Array.from(h.state.receipts.values()).filter((r) => r.action === "escalate_human" && r.message_id === opened.root_message_id);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].agent_id, AGENT_A, "escalation is attributed to the ROOT sender");

  // Idempotency: a subsequent maintenance sweep must not duplicate it.
  await h.store.sweepStranded(h.clockRef.value);
  const after = Array.from(h.state.receipts.values()).filter((r) => r.action === "escalate_human");
  assert.equal(after.length, 1);
});

// ============================================================
// Review fixes for a TOCTOU gap between reservation and launch
// (finding #1), and missing `timeout_ms` range validation (finding #7).
// ============================================================

test("D2-red cdx-1 — a reservation whose deadline elapses between commit and launch settles deadman instead of spawning", async () => {
  // A bespoke harness (not `makeHarness()`): the repro needs a clock that
  // simulates wall-clock time advancing PAST the reservation's own deadline
  // strictly BETWEEN `wakeAgent`'s reservation transaction and the launcher's
  // own started-CAS transaction that follows it — a gap this store's
  // synchronous, no-intervening-`await` call chain never gives test code a
  // chance to reach into directly. `deps.clock`/`tx.now()` call order for
  // this exact flow (each `writeReceipt` ALSO reads the clock once more, for
  // the receipt's own timestamp — see the fake `FakeLedgerTxImpl` above):
  // openDiscussion's pre-transaction `deps.clock()` read (call 1), its root
  // transaction's `tx.now()` (call 2) and root-receipt `writeReceipt` (call
  // 3); wakeAgent's reservation transaction's `tx.now()` (call 4, which
  // stamps the attempt's deadline) and its reservation-receipt `writeReceipt`
  // (call 5); then the launcher's started-CAS transaction's `tx.now()` (call
  // 6) — so a call-counting clock can deterministically simulate "wall clock
  // jumped past the deadline" landing exactly on call 6, mimicking a slow
  // scheduler tick or queued launcher work in a real process, without
  // disturbing the deadline computation itself (calls 1-5 all still read the
  // original time).
  const state = makeFakeState();
  registerAgents(state, FLEET, [AGENT_A, AGENT_B]);
  const baseTime = 1_700_000_000_000;
  const jumpMs = 2_000;
  const jumpOnCall = 6;
  let callCount = 0;
  let jumped = false;
  const clock: ClockFn = () => {
    callCount++;
    if (callCount >= jumpOnCall) jumped = true;
    return jumped ? baseTime + jumpMs : baseTime;
  };
  const ledgerFaults: LedgerFaults = {};
  const ledger = makeRawLedger(state, clock, ledgerFaults);
  const spawnCalls: RecordedSpawnCall[] = [];
  const killCalls: SpawnHandle[] = [];
  const notifyEvents: unknown[] = [];
  const spawn: SpawnFn = (job, onExit) => {
    const handle: SpawnHandle = { attempt_id: job.attempt_id, handle: { killed: false } };
    spawnCalls.push({ job, handle, triggerExit: (info = { code: 0 }) => onExit(info) });
    return handle;
  };
  const kill: KillFn = (handle) => {
    killCalls.push(handle);
    (handle.handle as { killed: boolean }).killed = true;
  };
  const notify: NotifyFn = (event) => notifyEvents.push(event);
  const deps: DiscussionStoreDeps = { ledger, spawn, kill, clock, notify, guardConfig: DEFAULT_GUARD_CONFIG };
  const store = createDiscussionStore(deps);

  // turn_timeout_ms:1_000 (the minimum valid bound) — short enough that a
  // 2_000ms simulated jump lands well past the attempt's deadline, and
  // timeout_ms:60_000 keeps the conversation deadline from being the binding
  // cap (proving the ATTEMPT deadline, not the conversation one, is what
  // triggers this).
  const opened = await store.openDiscussion(defaultAskPeerParams({ turn_timeout_ms: 1_000, timeout_ms: 60_000 }));

  const wake = await store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });

  assert.equal(spawnCalls.length, 0, "a dead-on-arrival reservation must never reach deps.spawn");
  assert.equal(killCalls.length, 0, "nothing was ever launched, so nothing needs killing");

  const view = store.getDiscussion({ discussion_id: opened.discussion_id });
  const attempt = view.attempts.find((a) => a.attempt_id === wake.attempt_id);
  assert.equal(attempt?.state, "deadman", "the reservation must settle deadman instead of starting/launching");
  assert.equal(view.turns_used, 2, "the turn is still consumed exactly once, not refunded");

  const startedReceipts = Array.from(state.receipts.values()).filter((r) =>
    r.action.startsWith(`discussion.wake.started.v1:2:${wake.attempt_id}`)
  );
  assert.equal(startedReceipts.length, 0, "the attempt must never be CASed to started once its deadline has already elapsed");

  const deadmanNotifications = notifyEvents.filter(
    (e) => typeof e === "object" && e !== null && (e as { kind?: string }).kind === "terminal" && (e as { state?: string }).state === "deadman"
  );
  assert.equal(deadmanNotifications.length, 1, "settlement must still notify exactly once, post-commit");
});

test("D2-red cdx-2a — timeout_ms of 999ms is rejected", async () => {
  const h = makeHarness();
  await assert.rejects(() => openRoot(h.store, { timeout_ms: 999 }), isDiscussionError("invalid_envelope"));
  assert.equal(h.state.messages.size, 0, "a rejected timeout_ms must append no message");
});

test("D2-red cdx-2b — timeout_ms of exactly 1000ms (the minimum) is accepted", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store, { timeout_ms: 1_000, turn_timeout_ms: 1_000 });
  assert.ok(opened.discussion_id);
  const view = h.store.getDiscussion({ discussion_id: opened.discussion_id });
  assert.equal(view.policy.conversation_deadline, h.clockRef.value + 1_000);
});

test("D2-red cdx-2c — timeout_ms of exactly 900000ms (the maximum, 15m) is accepted", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store, { timeout_ms: 900_000 });
  assert.ok(opened.discussion_id);
  const view = h.store.getDiscussion({ discussion_id: opened.discussion_id });
  assert.equal(view.policy.conversation_deadline, h.clockRef.value + 900_000);
});

test("D2-red cdx-2d — timeout_ms of 900001ms is rejected", async () => {
  const h = makeHarness();
  await assert.rejects(() => openRoot(h.store, { timeout_ms: 900_001 }), isDiscussionError("invalid_envelope"));
  assert.equal(h.state.messages.size, 0, "a rejected timeout_ms must append no message");
});

// ============================================================
// Model-selected execution — task 3
// The Discussion wake path inherits the participant's persisted `agent_file`
// and `requested_model` via `LedgerTx.agentLaunchConfig(agentId, fleetId)`.
// The reservation/start transaction must copy both into the `SpawnJob` and
// the canonical `fleet_id` of the discussion's head message.
// ============================================================

test("Task 3 #1 — agentLaunchConfig returns the persisted launch config for a selected participant", async () => {
  const state = makeFakeState();
  registerAgents(state, FLEET, [AGENT_A, AGENT_B], {
    [AGENT_B]: { requestedAgent: "oracle", requestedModel: "opencode-go/minimax-m3" },
  });
  const h = makeHarness({ state, registerDefaultAgents: false });

  let observed: { requestedAgent?: string; requestedModel?: string } | undefined;
  h.deps.ledger((tx) => {
    observed = tx.agentLaunchConfig(AGENT_B, FLEET);
  });
  assert.deepEqual(observed, { requestedAgent: "oracle", requestedModel: "opencode-go/minimax-m3" });
});

test("Task 3 #2 — agentLaunchConfig returns undefined for a non-participant and ignores wrong-fleet lookups", async () => {
  const state = makeFakeState();
  registerAgents(state, FLEET, [AGENT_A, AGENT_B], {
    [AGENT_B]: { requestedAgent: "oracle", requestedModel: "opencode-go/minimax-m3" },
  });
  const h = makeHarness({ state, registerDefaultAgents: false });

  let unknown: { requestedAgent?: string; requestedModel?: string } | undefined;
  let wrongFleet: { requestedAgent?: string; requestedModel?: string } | undefined;
  h.deps.ledger((tx) => {
    unknown = tx.agentLaunchConfig("stranger", FLEET);
    wrongFleet = tx.agentLaunchConfig(AGENT_B, "other-fleet");
  });
  assert.equal(unknown, undefined, "no row for a stranger must return undefined");
  assert.equal(wrongFleet, undefined, "a same-id agent in a different fleet must NOT match");
});

test("Task 3 #3 — selected participant's SpawnJob carries the persisted requestedAgent and requestedModel", async () => {
  const state = makeFakeState();
  registerAgents(state, FLEET, [AGENT_A, AGENT_B], {
    [AGENT_B]: { requestedAgent: "oracle", requestedModel: "opencode-go/minimax-m3" },
  });
  const h = makeHarness({ state, registerDefaultAgents: false });
  const opened = await openRoot(h.store);

  const wake = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });

  assert.equal(h.spawnCalls.length, 1);
  const job = h.spawnCalls[0]!.job;
  assert.equal(job.agent_id, AGENT_B);
  assert.equal(job.attempt_id, wake.attempt_id);
  assert.equal(job.fleet_id, FLEET, "the canonical head fleet_id must be copied into the SpawnJob");
  assert.equal(job.requested_agent, "oracle", "the persisted agent_file must be copied as requested_agent");
  assert.equal(job.requested_model, "opencode-go/minimax-m3", "the persisted requested_model must be copied as requested_model");
});

test("Task 3 #4 — omitted selection leaves both launch-config fields undefined and fleet_id intact", async () => {
  const state = makeFakeState();
  registerAgents(state, FLEET, [AGENT_A, AGENT_B]);
  const h = makeHarness({ state, registerDefaultAgents: false });
  const opened = await openRoot(h.store);

  await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });

  const job = h.spawnCalls[0]!.job;
  assert.equal(job.fleet_id, FLEET);
  assert.equal(job.requested_agent, undefined, "an agent with no agent_file must not be promoted to one");
  assert.equal(job.requested_model, undefined, "an agent with no requested_model must not be promoted to one");
});

test("Task 3 #5 — a missing launch-config lookup fails the reserved attempt without spawning", async () => {
  const h = makeHarness();
  const opened = await openRoot(h.store);
  h.ledgerFaults.missingLaunchConfigFor = new Set([`${FLEET}:${AGENT_B}`]);

  const wake = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });

  assert.equal(h.spawnCalls.length, 0, "a missing launch config must never reach the spawn seam");
  const attempt = h.store
    .getDiscussion({ discussion_id: opened.discussion_id })
    .attempts.find((candidate) => candidate.attempt_id === wake.attempt_id);
  assert.equal(attempt?.state, "failed");
});
