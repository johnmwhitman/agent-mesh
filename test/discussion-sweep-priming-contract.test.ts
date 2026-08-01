/**
 * The priming→sweeper contract, over the REAL ledger seam.
 *
 * `src/index.ts` spends a `setImmediate` ledger scan at every non-child boot on
 * `primeDiscussionSweepIndex()` (src/discussion-mcp.ts). That scan's entire
 * product is the `knownDiscussionIds` set, and `sweepStranded` is the only
 * consumer of that set — so the priming is worth exactly what the sweeper can
 * do with it, and nothing else in the repo measures the join between them.
 *
 * `test/discussion-reservation.test.ts`'s D2-red K2/K3 already cover
 * restart-safety at the STORE layer, against `makeRawLedger`'s fake state, and
 * they prime the known-id set with an ordinary `getDiscussion` call rather than
 * with the function the server actually calls at boot. These two tests close
 * that gap: real SQLite ledger, real `primeDiscussionSweepIndex`, and a
 * restart that carries no in-memory bookkeeping across it.
 *
 * Both assertions are deliberately about the MECHANISM, not about who invokes
 * it. If a caller is wired in, they keep passing; if the priming is removed as
 * dead code instead, test 2 fails loudly and that removal has to be argued
 * rather than slipped in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { withTempDb } from "./helpers/with-temp-db.js";
import { createFleet, registerAgentInLedger, type Agent } from "../src/core.js";
import { readLedger } from "../src/db.js";
import {
  getDiscussionStore,
  primeDiscussionSweepIndex,
  _resetDiscussionStoreForTests,
} from "../src/discussion-mcp.js";
import type { AskPeerParams, SpawnFn, SpawnHandle } from "../src/discussion-store.js";

const FLEET = "fleet-sweep-priming";
const AGENT_A = "agent-sweep-priming-a";
const AGENT_B = "agent-sweep-priming-b";
const TURN_TIMEOUT_MS = 5_000;

function seedFleetAndAgents(): void {
  createFleet(FLEET);
  const agent = (id: string): Agent => ({
    id,
    fleet_id: FLEET,
    role: "worker",
    prompt: "",
    status: "running",
    started_at: Date.now(),
  });
  registerAgentInLedger(agent(AGENT_A));
  registerAgentInLedger(agent(AGENT_B));
}

/** Never actually launches anything; the child is irrelevant here, only the
 *  `started` receipt it causes to be written is. */
const fakeSpawn: SpawnFn = (job) => {
  const handle: SpawnHandle = { attempt_id: job.attempt_id, handle: {} };
  return handle;
};

function askPeerParams(): AskPeerParams {
  return {
    from_agent_id: AGENT_A,
    to_agent_id: AGENT_B,
    fleet_id: FLEET,
    payload: "root question",
    max_turns: 4,
    timeout_ms: 60_000,
    turn_timeout_ms: TURN_TIMEOUT_MS,
    wake_peer: false,
  };
}

/** Every receipt `action` string currently in the ledger. */
function receiptActions(): string[] {
  const data = readLedger();
  const out: string[] = [];
  for (const value of Object.values(data.receipts)) {
    for (const receipt of Array.isArray(value) ? value : [value]) {
      out.push(receipt.action);
    }
  }
  return out;
}

/** Open a discussion and wake the peer, leaving a live `started` attempt.
 *  Returns the ids and the attempt's absolute deadline. */
async function strandAnAttempt(clock: () => number): Promise<{
  discussionId: string;
  attemptId: string;
  deadline: number;
}> {
  _resetDiscussionStoreForTests({ clock, spawn: fakeSpawn, kill: () => {}, notify: () => {} });
  const store = getDiscussionStore();
  const opened = await store.openDiscussion(askPeerParams());
  const wake = await store.wakeAgent({
    agent_id: AGENT_B,
    discussion_id: opened.discussion_id,
    expected_head_message_id: opened.root_message_id,
  });
  const view = store.getDiscussion({ discussion_id: opened.discussion_id });
  const attempt = view.attempts.find((a) => a.attempt_id === wake.attempt_id);
  assert.equal(attempt?.state, "started", "fixture precondition: the attempt must be live before the restart");
  return { discussionId: opened.discussion_id, attemptId: wake.attempt_id, deadline: wake.deadline };
}

test("boot priming reaches a discussion the server never touched in this process, and the sweeper terminalizes it", async () => {
  const tmp = withTempDb();
  try {
    seedFleetAndAgents();
    const clockRef = { value: 1_700_000_000_000 };
    const clock = (): number => clockRef.value;
    const { discussionId, attemptId, deadline } = await strandAnAttempt(clock);

    // The restart: a brand-new store instance with fresh spawn/kill/notify
    // wiring and an empty known-id set. Only the ledger crosses this line.
    _resetDiscussionStoreForTests({ clock, spawn: fakeSpawn, kill: () => {}, notify: () => {} });
    const restarted = getDiscussionStore();

    // Exactly what src/index.ts runs at every non-child boot — and the ONLY
    // thing that can put this discussion within the new instance's reach,
    // since nothing has asked this instance about it.
    const primedCount = primeDiscussionSweepIndex();
    assert.equal(primedCount, 1, "the boot scan must find the one discussion root in the ledger");

    clockRef.value = deadline + 60_000;
    const sweep = await restarted.sweepStranded(clockRef.value);

    assert.deepEqual(
      sweep.terminalized,
      [{ discussion_id: discussionId, attempt_id: attemptId, state: "deadman" }],
      "the primed id is what lets the sweeper find an attempt this instance never saw"
    );

    const deadmanReceipts = receiptActions().filter((a) => a.startsWith("discussion.wake.deadman.v1:"));
    assert.deepEqual(
      deadmanReceipts,
      [`discussion.wake.deadman.v1:2:${attemptId}`],
      "settlement must leave exactly one deadman receipt naming the attempt — the audit row is the point"
    );

    const after = restarted.getDiscussion({ discussion_id: discussionId });
    assert.equal(after.attempts.find((a) => a.attempt_id === attemptId)?.state, "deadman");
  } finally {
    tmp.cleanup();
  }
});

test("without the boot priming the sweeper's reach is empty — the scan is load-bearing, not decorative", async () => {
  const tmp = withTempDb();
  try {
    seedFleetAndAgents();
    const clockRef = { value: 1_700_000_000_000 };
    const clock = (): number => clockRef.value;
    const { attemptId, deadline } = await strandAnAttempt(clock);

    // Same restart, same past-deadline clock — but no priming, and no read of
    // this discussion through the new instance (a `getDiscussion` would also
    // register the id; that is K2's path, not the server's boot path).
    _resetDiscussionStoreForTests({ clock, spawn: fakeSpawn, kill: () => {}, notify: () => {} });
    const restarted = getDiscussionStore();
    clockRef.value = deadline + 60_000;

    const sweep = await restarted.sweepStranded(clockRef.value);
    assert.deepEqual(sweep.terminalized, [], "an unprimed instance must sweep nothing: its known-id set is empty");
    assert.deepEqual(
      receiptActions().filter((a) => a.startsWith("discussion.wake.deadman.v1:")),
      [],
      `no settlement receipt may exist for ${attemptId} when nothing put it in reach`
    );
  } finally {
    tmp.cleanup();
  }
});
