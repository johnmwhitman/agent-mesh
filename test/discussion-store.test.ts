import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDiscussionStore,
  DiscussionError,
  DEFAULT_GUARD_CONFIG,
  type DiscussionStore,
  type DiscussionStoreDeps,
  type DiscussionNotifyEvent,
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
} from "../src/discussion-store.js";
import type { Message, Receipt } from "../src/core.js";

// ============================================================================
// In-memory fake dependencies
// ============================================================================

const FLEET_ID = "fleet-test-1";
const AGENT_A = "agent-alpha";
const AGENT_B = "agent-beta";

interface AgentRecord {
  fleetId: string;
  requestedAgent?: string;
  requestedModel?: string;
}

interface FakeLedgerState {
  messages: Map<string, Message>;
  receipts: Map<string, Receipt>;
  agents: Map<string, AgentRecord>;
}

function createFakeLedgerState(): FakeLedgerState {
  return {
    messages: new Map(),
    receipts: new Map(),
    agents: new Map(),
  };
}

class FakeLedgerTx implements LedgerTx {
  constructor(
    private readonly draft: FakeLedgerState,
    private readonly clock: ClockFn
  ) {}

  now(): number {
    return this.clock();
  }

  agentExists(agentId: string, fleetId: string): boolean {
    const record = this.draft.agents.get(`${fleetId}:${agentId}`);
    return Boolean(record && record.fleetId === fleetId);
  }

  agentLaunchConfig(
    agentId: string,
    fleetId: string
  ): { requestedAgent?: string; requestedModel?: string } | undefined {
    const record = this.draft.agents.get(`${fleetId}:${agentId}`);
    if (!record || record.fleetId !== fleetId) return undefined;
    const out: { requestedAgent?: string; requestedModel?: string } = {};
    if (record.requestedAgent !== undefined) out.requestedAgent = record.requestedAgent;
    if (record.requestedModel !== undefined) out.requestedModel = record.requestedModel;
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
    const messageIds = new Set(this.messagesByCorrelation(discussionId).map((m) => m.id));
    return Array.from(this.draft.receipts.values()).filter((r) => messageIds.has(r.message_id));
  }

  appendMessage(input: NewMessage): Message {
    if (this.draft.messages.has(input.id)) {
      throw new Error(`Duplicate message id ${input.id}`);
    }
    const message: Message = { ...input, acknowledged: false };
    this.draft.messages.set(input.id, message);
    return message;
  }

  writeReceipt(messageId: string, agentId: string, action: string, note?: string): Receipt {
    const key = `${messageId}:${agentId}:${action}`;
    const existing = this.draft.receipts.get(key);
    if (existing) return existing;
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
    let count = 0;
    for (const receipt of this.draft.receipts.values()) {
      if (receipt.agent_id !== agentId) continue;
      if (!receipt.action.startsWith("discussion.wake.reserved.v1:")) continue;
      if (receipt.timestamp >= windowStartMs && receipt.timestamp <= nowMs) {
        count++;
      }
    }
    return count;
  }
}

interface TestHarness {
  state: FakeLedgerState;
  store: DiscussionStore;
  deps: DiscussionStoreDeps;
  clock: { now: number; advance(ms: number): void };
  spawnJobs: SpawnJob[];
  spawnHandles: SpawnHandle[];
  childExits: Array<(info: ChildExitInfo) => void>;
  killedHandles: SpawnHandle[];
  notifications: DiscussionNotifyEvent[];
  registerAgent(agentId: string, fleetId?: string, config?: { requestedAgent?: string; requestedModel?: string }): void;
}

function createTestHarness(opts: {
  initialTime?: number;
  guardConfig?: Partial<GuardConfig>;
  notify?: NotifyFn;
  spawn?: SpawnFn;
} = {}): TestHarness {
  const state = createFakeLedgerState();
  let currentTime = opts.initialTime ?? 1_700_000_000_000;
  const clockFn: ClockFn = () => currentTime;

  const spawnJobs: SpawnJob[] = [];
  const spawnHandles: SpawnHandle[] = [];
  const childExits: Array<(info: ChildExitInfo) => void> = [];
  const killedHandles: SpawnHandle[] = [];
  const notifications: DiscussionNotifyEvent[] = [];

  const ledger: LedgerFn = <T>(mutator: (tx: LedgerTx) => T): T => {
    // Copy-on-write semantics for atomic synchronous transactions
    const draft: FakeLedgerState = {
      messages: new Map(state.messages),
      receipts: new Map(state.receipts),
      agents: new Map(state.agents),
    };
    const tx = new FakeLedgerTx(draft, clockFn);
    const result = mutator(tx);
    if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
      throw new Error("Ledger transaction must be synchronous");
    }
    state.messages = draft.messages;
    state.receipts = draft.receipts;
    state.agents = draft.agents;
    return result;
  };

  const spawn: SpawnFn = opts.spawn ?? ((job, onExit) => {
    spawnJobs.push(job);
    childExits.push(onExit);
    const handle: SpawnHandle = { attempt_id: job.attempt_id, handle: { id: job.attempt_id } };
    spawnHandles.push(handle);
    return handle;
  });

  const kill: KillFn = (handle) => {
    killedHandles.push(handle);
  };

  const notify: NotifyFn = opts.notify ?? ((event) => {
    notifications.push(event);
  });

  const guardConfig: GuardConfig = {
    ...DEFAULT_GUARD_CONFIG,
    ...(opts.guardConfig ?? {}),
  };

  const deps: DiscussionStoreDeps = {
    ledger,
    spawn,
    kill,
    clock: clockFn,
    notify,
    guardConfig,
  };

  const store = createDiscussionStore(deps);

  const registerAgent = (agentId: string, fleetId = FLEET_ID, config?: { requestedAgent?: string; requestedModel?: string }) => {
    state.agents.set(`${fleetId}:${agentId}`, {
      fleetId,
      ...(config ?? {}),
    });
  };

  // Register default agents
  registerAgent(AGENT_A, FLEET_ID);
  registerAgent(AGENT_B, FLEET_ID);

  return {
    state,
    store,
    deps,
    clock: {
      get now() { return currentTime; },
      set now(v: number) { currentTime = v; },
      advance(ms: number) { currentTime += ms; },
    },
    spawnJobs,
    spawnHandles,
    childExits,
    killedHandles,
    notifications,
    registerAgent,
  };
}

function defaultParams(overrides: Partial<AskPeerParams> = {}): AskPeerParams {
  return {
    from_agent_id: AGENT_A,
    to_agent_id: AGENT_B,
    fleet_id: FLEET_ID,
    payload: "Hello peer",
    max_turns: 4,
    timeout_ms: 60_000,
    turn_timeout_ms: 10_000,
    wake_peer: false,
    ...overrides,
  };
}

// ============================================================================
// Direct Unit Tests: Invariants for createDiscussionStore
// ============================================================================

test("DiscussionStore: openDiscussion validates input bounds and rejects invalid envelopes", async () => {
  const h = createTestHarness();

  // timeout_ms bounds: 1000..900000
  await assert.rejects(
    () => h.store.openDiscussion(defaultParams({ timeout_ms: 999 })),
    (err: unknown) => err instanceof DiscussionError && err.code === "invalid_envelope" && err.detail.entity === "timeout_ms"
  );
  await assert.rejects(
    () => h.store.openDiscussion(defaultParams({ timeout_ms: 900_001 })),
    (err: unknown) => err instanceof DiscussionError && err.code === "invalid_envelope" && err.detail.entity === "timeout_ms"
  );

  // turn_timeout_ms bounds: 1000..300000
  await assert.rejects(
    () => h.store.openDiscussion(defaultParams({ turn_timeout_ms: 999 })),
    (err: unknown) => err instanceof DiscussionError && err.code === "invalid_envelope" && err.detail.entity === "turn_timeout_ms"
  );
  await assert.rejects(
    () => h.store.openDiscussion(defaultParams({ turn_timeout_ms: 300_001 })),
    (err: unknown) => err instanceof DiscussionError && err.code === "invalid_envelope" && err.detail.entity === "turn_timeout_ms"
  );

  // max_turns bounds: 2..32
  await assert.rejects(
    () => h.store.openDiscussion(defaultParams({ max_turns: 1 })),
    (err: unknown) => err instanceof DiscussionError && err.code === "invalid_envelope" && err.detail.entity === "max_turns"
  );
  await assert.rejects(
    () => h.store.openDiscussion(defaultParams({ max_turns: 33 })),
    (err: unknown) => err instanceof DiscussionError && err.code === "invalid_envelope" && err.detail.entity === "max_turns"
  );

  // turn_timeout_ms cannot exceed timeout_ms
  await assert.rejects(
    () => h.store.openDiscussion(defaultParams({ timeout_ms: 5_000, turn_timeout_ms: 6_000 })),
    (err: unknown) => err instanceof DiscussionError && err.code === "turn_timeout_exceeds_conversation_timeout"
  );

  // Broadcast or self-talk rejected
  await assert.rejects(
    () => h.store.openDiscussion(defaultParams({ to_agent_id: "*" })),
    (err: unknown) => err instanceof DiscussionError && err.code === "broadcast_rejected"
  );
  await assert.rejects(
    () => h.store.openDiscussion(defaultParams({ from_agent_id: AGENT_A, to_agent_id: AGENT_A })),
    (err: unknown) => err instanceof DiscussionError && err.code === "broadcast_rejected"
  );

  // Oversized envelope (> 65536 bytes)
  const hugePayload = "x".repeat(70_000);
  await assert.rejects(
    () => h.store.openDiscussion(defaultParams({ payload: hugePayload })),
    (err: unknown) => err instanceof DiscussionError && err.code === "envelope_oversize"
  );

  // Agent existence check
  await assert.rejects(
    () => h.store.openDiscussion(defaultParams({ to_agent_id: "agent-nonexistent" })),
    (err: unknown) => err instanceof DiscussionError && err.code === "not_found" && err.detail.entity === "agent"
  );
});

test("DiscussionStore: openDiscussion creates durable root message and optional wake reservation", async () => {
  const h = createTestHarness();

  // Without wake_peer
  const res1 = await h.store.openDiscussion(defaultParams({ wake_peer: false }));
  assert.ok(res1.discussion_id);
  assert.ok(res1.root_message_id);
  assert.equal(res1.wake_reserved, false);
  assert.equal(res1.reservation, undefined);
  assert.equal(h.spawnJobs.length, 0);

  const rootMsg = h.state.messages.get(res1.root_message_id);
  assert.ok(rootMsg);
  assert.equal(rootMsg.from_agent_id, AGENT_A);
  assert.equal(rootMsg.to_agent_id, AGENT_B);
  assert.equal(rootMsg.fleet_id, FLEET_ID);
  assert.equal(rootMsg.type, "question");

  const receipts1 = h.state.receipts;
  const sentReceipt = Array.from(receipts1.values()).find(
    (r) => r.message_id === res1.root_message_id && r.action.startsWith("discussion.turn.sent.v1:1:")
  );
  assert.ok(sentReceipt);
  assert.equal(sentReceipt.agent_id, AGENT_A);

  // With wake_peer: true
  const res2 = await h.store.openDiscussion(defaultParams({ wake_peer: true }));
  assert.equal(res2.wake_reserved, true);
  assert.ok(res2.reservation);
  assert.equal(res2.reservation.turn, 2);
  assert.equal(res2.reservation.deadline, h.clock.now + 10_000);
  assert.equal(h.spawnJobs.length, 1);
  assert.equal(h.spawnJobs[0].attempt_id, res2.reservation.attempt_id);
  assert.equal(h.spawnJobs[0].turn, 2);
  assert.equal(h.spawnJobs[0].head_message_id, res2.root_message_id);
});

test("DiscussionStore: guard config enforces quota and global kill switch", async () => {
  const hKill = createTestHarness({ guardConfig: { globalKillSwitch: true } });
  await assert.rejects(
    () => hKill.store.openDiscussion(defaultParams({ wake_peer: true })),
    (err: unknown) => err instanceof DiscussionError && err.code === "global_kill_active"
  );
  // Root without wake is allowed even under kill switch
  const openWithoutWake = await hKill.store.openDiscussion(defaultParams({ wake_peer: false }));
  assert.ok(openWithoutWake.discussion_id);

  // wakeAgent under global kill switch is rejected
  await assert.rejects(
    () => hKill.store.wakeAgent({
      agent_id: AGENT_B,
      discussion_id: openWithoutWake.discussion_id,
      expected_head_message_id: openWithoutWake.root_message_id,
    }),
    (err: unknown) => err instanceof DiscussionError && err.code === "global_kill_active"
  );

  // Quota enforcement
  const hQuota = createTestHarness({ guardConfig: { wakeQuotaPerHour: 1 } });
  const open1 = await hQuota.store.openDiscussion(defaultParams({ wake_peer: true }));
  assert.equal(open1.wake_reserved, true);

  // Second wake for AGENT_B within rolling hour exceeds quota
  const open2 = await hQuota.store.openDiscussion(defaultParams({ wake_peer: false }));
  await assert.rejects(
    () => hQuota.store.wakeAgent({
      agent_id: AGENT_B,
      discussion_id: open2.discussion_id,
      expected_head_message_id: open2.root_message_id,
    }),
    (err: unknown) => err instanceof DiscussionError && err.code === "quota_exceeded"
  );
});

test("DiscussionStore: wakeAgent validates participants, head message, and active attempts", async () => {
  const h = createTestHarness();
  const opened = await h.store.openDiscussion(defaultParams({ wake_peer: false }));

  // Non-existent discussion
  await assert.rejects(
    () => h.store.wakeAgent({
      agent_id: AGENT_B,
      discussion_id: "missing-disc-id",
      expected_head_message_id: opened.root_message_id,
    }),
    (err: unknown) => err instanceof DiscussionError && err.code === "not_found" && err.detail.entity === "discussion"
  );

  // Wrong participant (AGENT_A is sender, recipient is AGENT_B)
  await assert.rejects(
    () => h.store.wakeAgent({
      agent_id: AGENT_A,
      discussion_id: opened.discussion_id,
      expected_head_message_id: opened.root_message_id,
    }),
    (err: unknown) => err instanceof DiscussionError && err.code === "wrong_participant"
  );

  // Stale head message id
  await assert.rejects(
    () => h.store.wakeAgent({
      agent_id: AGENT_B,
      discussion_id: opened.discussion_id,
      expected_head_message_id: "wrong-head-msg",
    }),
    (err: unknown) => err instanceof DiscussionError && err.code === "stale_head"
  );

  // Successful wakeAgent
  const wake1 = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  assert.equal(wake1.turn, 2);
  assert.equal(wake1.head_message_id, opened.root_message_id);
  assert.equal(wake1.remaining_turns, 2); // 4 max turns - 2 turns used = 2 remaining
  assert.equal(h.spawnJobs.length, 1);

  // Duplicate wake from the same agent returns existing active attempt (deduplicated)
  const wakeDup = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  assert.equal(wakeDup.attempt_id, wake1.attempt_id);
  assert.equal(h.spawnJobs.length, 1, "Duplicate wake must not spawn again");
});

test("DiscussionStore: replyDiscussion records reply and updates discussion status", async () => {
  const h = createTestHarness();
  const opened = await h.store.openDiscussion(defaultParams({ wake_peer: false, max_turns: 4 }));
  const wake = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });

  // Attempt mismatch / participant validation
  await assert.rejects(
    () => h.store.replyDiscussion({
      agent_id: AGENT_A, // wrong agent
      discussion_id: opened.discussion_id,
      attempt_id: wake.attempt_id,
      reply_to_message_id: opened.root_message_id,
      type: "result",
      payload: "answer",
    }),
    (err: unknown) => err instanceof DiscussionError && err.code === "wrong_participant"
  );

  // Stale head check
  await assert.rejects(
    () => h.store.replyDiscussion({
      agent_id: AGENT_B,
      discussion_id: opened.discussion_id,
      attempt_id: wake.attempt_id,
      reply_to_message_id: "stale-id",
      type: "result",
      payload: "answer",
    }),
    (err: unknown) => err instanceof DiscussionError && err.code === "stale_head"
  );

  // Successful open reply (turn 2)
  const reply1 = await h.store.replyDiscussion({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    attempt_id: wake.attempt_id,
    reply_to_message_id: opened.root_message_id,
    type: "question",
    payload: "follow-up question",
    close: false,
  });
  assert.equal(reply1.turn, 2);
  assert.equal(reply1.status, "open");
  assert.equal(reply1.remaining_turns, 2);

  // Second reply with same attempt id is rejected
  await assert.rejects(
    () => h.store.replyDiscussion({
      agent_id: AGENT_B,
      discussion_id: opened.discussion_id,
      attempt_id: wake.attempt_id,
      reply_to_message_id: reply1.message_id,
      type: "result",
      payload: "second answer",
    }),
    (err: unknown) => err instanceof DiscussionError && err.code === "second_reply"
  );

  // Next turn (turn 3) from AGENT_A
  const wake3 = await h.store.wakeAgent({
    agent_id: AGENT_A,
    discussion_id: opened.discussion_id,
    expected_head_message_id: reply1.message_id,
  });
  assert.equal(wake3.turn, 3);

  // Close discussion via reply
  const replyClose = await h.store.replyDiscussion({
    agent_id: AGENT_A,
    discussion_id: opened.discussion_id,
    attempt_id: wake3.attempt_id,
    reply_to_message_id: reply1.message_id,
    type: "result",
    payload: "final answer",
    close: true,
  });
  assert.equal(replyClose.status, "closed");

  const view = h.store.getDiscussion({ discussion_id: opened.discussion_id });
  assert.equal(view.status, "closed");
  assert.equal(view.transcript.length, 3);
});

test("DiscussionStore: replyDiscussion past deadline is rejected", async () => {
  const h = createTestHarness();
  const opened = await h.store.openDiscussion(defaultParams({ turn_timeout_ms: 5_000 }));
  const wake = await h.store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });

  // Advance time past attempt deadline
  h.clock.advance(6_000);

  await assert.rejects(
    () => h.store.replyDiscussion({
      agent_id: AGENT_B,
      discussion_id: opened.discussion_id,
      attempt_id: wake.attempt_id,
      reply_to_message_id: opened.root_message_id,
      type: "result",
      payload: "too late",
    }),
    (err: unknown) => err instanceof DiscussionError && err.code === "past_deadline"
  );
});

test("DiscussionStore: escalation receipt written on budget exhaustion", async () => {
  const h = createTestHarness({ guardConfig: { escalateOnBudgetExhaustion: true } });
  const opened = await h.store.openDiscussion(defaultParams({ max_turns: 2 }));
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
    payload: "exhausting turn",
    close: false,
  });
  assert.equal(reply.status, "exhausted");

  const escalations = Array.from(h.state.receipts.values()).filter(
    (r) => r.action === "escalate_human" && r.message_id === opened.root_message_id
  );
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].agent_id, AGENT_A);
  const note = JSON.parse(escalations[0].note ?? "{}") as Record<string, unknown>;
  assert.equal(note.reason, "budget_exhausted");
});

test("DiscussionStore: getDiscussion supports include_receipts and seedKnownDiscussionIds", async () => {
  const h = createTestHarness();
  const opened = await h.store.openDiscussion(defaultParams({ wake_peer: true }));

  // Default include_receipts is true
  const viewWithReceipts = h.store.getDiscussion({ discussion_id: opened.discussion_id });
  assert.ok(viewWithReceipts.transcript[0].receipts.length > 0);

  // include_receipts: false strips receipts from transcript
  const viewWithoutReceipts = h.store.getDiscussion({ discussion_id: opened.discussion_id, include_receipts: false });
  assert.equal(viewWithoutReceipts.transcript[0].receipts.length, 0);

  // Non-existent discussion throws not_found
  assert.throws(
    () => h.store.getDiscussion({ discussion_id: "unknown-id" }),
    (err: unknown) => err instanceof DiscussionError && err.code === "not_found"
  );

  // seedKnownDiscussionIds adds ids to known set for sweeping without deriving
  h.store.seedKnownDiscussionIds(["arbitrary-id-1", "arbitrary-id-2"]);
  const sweep = await h.store.sweepStranded(h.clock.now);
  assert.ok(Array.isArray(sweep.terminalized));
});

test("DiscussionStore: sweepStranded marks overdue active attempts as deadman and invokes kill", async () => {
  const h = createTestHarness();
  const opened = await h.store.openDiscussion(defaultParams({ turn_timeout_ms: 5_000, wake_peer: true }));
  assert.ok(opened.reservation);
  assert.equal(h.spawnHandles.length, 1);

  // Before deadline, sweep terminalizes nothing
  const sweepBefore = await h.store.sweepStranded(h.clock.now + 1_000);
  assert.equal(sweepBefore.terminalized.length, 0);
  assert.equal(h.killedHandles.length, 0);

  // Advance past deadline
  h.clock.advance(6_000);
  const sweepAfter = await h.store.sweepStranded(h.clock.now);
  assert.equal(sweepAfter.terminalized.length, 1);
  assert.equal(sweepAfter.terminalized[0].attempt_id, opened.reservation.attempt_id);
  assert.equal(sweepAfter.terminalized[0].state, "deadman");
  assert.equal(h.killedHandles.length, 1);
  assert.equal(h.killedHandles[0].attempt_id, opened.reservation.attempt_id);

  // Post-sweep view shows attempt as deadman and status as deadman
  const view = h.store.getDiscussion({ discussion_id: opened.discussion_id });
  assert.equal(view.status, "deadman");
  assert.equal(view.attempts[0].state, "deadman");
});

test("DiscussionStore: child process exit callback settles attempt to failed if no completed receipt", async () => {
  const h = createTestHarness();
  const opened = await h.store.openDiscussion(defaultParams({ wake_peer: true }));
  assert.equal(h.childExits.length, 1);

  // Child exits without replying
  h.childExits[0]({ code: 1 });

  const view = h.store.getDiscussion({ discussion_id: opened.discussion_id });
  assert.equal(view.attempts[0].state, "failed");

  // Attempting to reply against failed attempt is rejected
  await assert.rejects(
    () => h.store.replyDiscussion({
      agent_id: AGENT_B,
      discussion_id: opened.discussion_id,
      attempt_id: opened.reservation!.attempt_id,
      reply_to_message_id: opened.root_message_id,
      type: "result",
      payload: "answer after exit",
    }),
    (err: unknown) => err instanceof DiscussionError && err.code === "attempt_not_active"
  );
});

test("DiscussionStore: awaitAnswer resolves when reply arrives", async () => {
  const h = createTestHarness();
  const opened = await h.store.openDiscussion(defaultParams({ wake_peer: true, max_turns: 4 }));

  const waitPromise = h.store.awaitAnswer(opened.discussion_id, opened.root_message_id);

  // Child replies with close: true
  await h.store.replyDiscussion({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    attempt_id: opened.reservation!.attempt_id,
    reply_to_message_id: opened.root_message_id,
    type: "result",
    payload: "rendezvous answer",
    close: true,
  });

  const result = await waitPromise;
  assert.equal(result.status, "answered");
  assert.equal(result.discussion_id, opened.discussion_id);
  assert.equal(result.root_message_id, opened.root_message_id);
  assert.ok(result.answer);
  assert.equal(result.discussion.status, "closed");
});

test("DiscussionStore: notification failure never rolls back or fails committed operations", async () => {
  const h = createTestHarness({
    notify: () => {
      throw new Error("Broken notify transport");
    },
  });

  // openDiscussion succeeds despite notify throw
  const opened = await h.store.openDiscussion(defaultParams({ wake_peer: true }));
  assert.ok(opened.discussion_id);
  assert.equal(opened.wake_reserved, true);

  // wakeAgent succeeds despite notify throw
  const reply1 = await h.store.replyDiscussion({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    attempt_id: opened.reservation!.attempt_id,
    reply_to_message_id: opened.root_message_id,
    type: "question",
    payload: "next question",
    close: false,
  });
  assert.ok(reply1.message_id);

  const wake2 = await h.store.wakeAgent({
    agent_id: AGENT_A,
    discussion_id: opened.discussion_id,
    expected_head_message_id: reply1.message_id,
  });
  assert.ok(wake2.attempt_id);

  // replyDiscussion close succeeds despite notify throw
  const reply2 = await h.store.replyDiscussion({
    agent_id: AGENT_A,
    discussion_id: opened.discussion_id,
    attempt_id: wake2.attempt_id,
    reply_to_message_id: reply1.message_id,
    type: "result",
    payload: "final",
    close: true,
  });
  assert.equal(reply2.status, "closed");

  // getDiscussion reflects valid state
  const view = h.store.getDiscussion({ discussion_id: opened.discussion_id });
  assert.equal(view.status, "closed");
  assert.equal(view.transcript.length, 3);
});
