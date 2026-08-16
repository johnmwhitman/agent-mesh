/**
 * D3 handler-seam tests — src/discussion-mcp.ts, the module that wires
 * `createDiscussionStore` (src/discussion-store.ts, D2) to the REAL ledger
 * (db.ts's `withLedger`), the real one-shot child spawn path, and the real
 * SSE notify channel, exactly as src/index.ts's four Discussion tool
 * handlers (ask_peer, wake_agent, reply_discussion, get_discussion) consume
 * it.
 *
 * Why this file targets discussion-mcp.ts rather than src/index.ts's
 * `toolHandlers` directly: src/index.ts boots a stdio transport + SSE HTTP
 * server as top-level side effects on import (see test/dispatch-registry.
 * test.ts's own file-header note) — the whole existing suite's convention is
 * static source-shape assertions for index.ts (dispatch-registry.test.ts)
 * plus behavioral tests against the underlying logic modules directly
 * (core.test.ts never imports index.ts either). This file follows that same
 * convention for the four new tools' real wiring, and adds static-shape
 * assertions for the parts that only live in index.ts (input schemas, error
 * translation).
 *
 * `deps.spawn` is overridden with a fake, deterministic launcher via
 * `_resetDiscussionStoreForTests` (discussion-mcp.ts's test-only seam) so
 * these tests never shell out to a real `opencode` process — `deps.ledger`
 * stays wired to the REAL SQLite seam via `withTempDb`, matching every other
 * integration test in this repo.
 *
 * Sources: SUCCESSION/a2a-discussions/lane-1-cdx-discussions-api-design.md
 * §15 (test list; items 20/21/26/27 are exercised here at this layer — 15-19
 * and 22-25 are ask_peer rendezvous / resident-mode behavior already covered
 * by test/discussion-reservation.test.ts's D2 suite against the store
 * directly), SUCCESSION/a2a-discussions/drafts/d3-wiring-blueprint.md
 * (§§0-7), and drafts/d3-blueprint-errata.md (tool-count reconciliation —
 * also asserted in test/dispatch-registry.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { withTempDb } from "./helpers/with-temp-db.js";
import { createFleet, registerAgentInLedger, sendMessage, type Agent } from "../src/core.js";
import { readLedger } from "../src/db.js";
import {
  getDiscussionStore,
  primeDiscussionSweepIndex,
  _resetDiscussionStoreForTests,
} from "../src/discussion-mcp.js";
import type { ChildExitInfo, SpawnFn, SpawnHandle, SpawnJob } from "../src/discussion-store.js";
import type {
  CancelResult,
  ExecutionSpec,
  RuntimeAdapter,
  RuntimeHandle,
  RuntimeResult,
} from "../src/runtime/types.js";

// ============================================================
// Fixtures
// ============================================================

const FLEET = "fleet-mcp-1";
const AGENT_A = "agent-mcp-a";
const AGENT_B = "agent-mcp-b";

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

/** A fake, synchronous, never-actually-launches spawn — records every job it
 *  was asked to run and lets a test manually settle it via the captured
 *  `onExit`, mirroring the real launcher's contract without shelling out. */
function makeFakeSpawn(): { spawn: SpawnFn; jobs: SpawnJob[]; exits: Array<(info: ChildExitInfo) => void> } {
  const jobs: SpawnJob[] = [];
  const exits: Array<(info: ChildExitInfo) => void> = [];
  const spawn: SpawnFn = (job, onExit) => {
    jobs.push(job);
    exits.push(onExit);
    const handle: SpawnHandle = { attempt_id: job.attempt_id, handle: {} };
    return handle;
  };
  return { spawn, jobs, exits };
}

function askPeerDefaults(overrides: Record<string, unknown> = {}) {
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
// Static source-shape assertions (index.ts cannot be imported — see header).
// ============================================================

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(here, "..", "src", "index.ts"), "utf8");

function toolBlock(name: string): string {
  const marker = `name: "${name}"`;
  const start = indexSource.indexOf(marker);
  assert.ok(start !== -1, `tool "${name}" not found in ListTools`);
  const end = indexSource.indexOf("\n    {", start);
  return indexSource.slice(start, end === -1 ? start + 2000 : end);
}

test("ask_peer inputSchema: exact bounds and required fields (blueprint §4)", () => {
  const block = toolBlock("ask_peer");
  assert.match(block, /minimum:\s*2,\s*\n\s*maximum:\s*32/, "max_turns must be 2..32");
  assert.match(block, /minimum:\s*1000,\s*\n\s*maximum:\s*900000/, "timeout_ms must be 1000..900000");
  assert.match(block, /minimum:\s*1000,\s*\n\s*maximum:\s*300000/, "turn_timeout_ms must be 1000..300000");
  assert.match(block, /additionalProperties:\s*false/);
  for (const field of ["from_agent_id", "to_agent_id", "fleet_id", "payload", "max_turns", "timeout_ms", "turn_timeout_ms", "wake_peer"]) {
    assert.ok(block.includes(`"${field}"`), `ask_peer schema missing field "${field}"`);
  }
});

test("wake_agent inputSchema: exact required fields (blueprint §5)", () => {
  const block = toolBlock("wake_agent");
  assert.match(block, /additionalProperties:\s*false/);
  for (const field of ["agent_id", "discussion_id", "expected_head_message_id"]) {
    assert.ok(block.includes(`"${field}"`), `wake_agent schema missing field "${field}"`);
  }
});

test("reply_discussion inputSchema: type enum and close default note (blueprint §6)", () => {
  const block = toolBlock("reply_discussion");
  assert.match(block, /enum:\s*\["question",\s*"result"\]/);
  assert.match(block, /additionalProperties:\s*false/);
  for (const field of ["agent_id", "discussion_id", "attempt_id", "reply_to_message_id", "type", "payload"]) {
    assert.ok(block.includes(`"${field}"`), `reply_discussion schema missing field "${field}"`);
  }
  // `close` is optional — must NOT be in the required array for this tool.
  const requiredMatch = block.match(/required:\s*\[([^\]]*)\]/);
  assert.ok(requiredMatch, "reply_discussion missing a required[] array");
  assert.ok(!requiredMatch![1].includes("close"), "close must be optional, not required");
});

test("get_discussion inputSchema: only discussion_id is required (blueprint §7)", () => {
  const block = toolBlock("get_discussion");
  assert.match(block, /additionalProperties:\s*false/);
  const requiredMatch = block.match(/required:\s*\[([^\]]*)\]/);
  assert.ok(requiredMatch);
  assert.equal(requiredMatch![1].replace(/\s/g, ""), '"discussion_id"');
});

test("all four Discussion handlers translate DiscussionError via the extended {error, detail_fields} contract", () => {
  for (const name of ["ask_peer", "wake_agent", "reply_discussion", "get_discussion"]) {
    const marker = `toolHandlers["${name}"] = async (args) => {`;
    const start = indexSource.indexOf(marker);
    assert.ok(start !== -1, `handler for "${name}" not found`);
    const end = indexSource.indexOf("\ntoolHandlers[", start + 1);
    const body = indexSource.slice(start, end === -1 ? start + 1500 : end);
    assert.match(body, /instanceof DiscussionError/, `${name} handler must branch on DiscussionError`);
    assert.match(body, /jsonDiscussionError\(err\.code, err\.detail\)/, `${name} handler must use jsonDiscussionError`);
  }
});

// ============================================================
// Behavioral tests against the real wiring (fake spawn, real ledger).
// ============================================================

test("wake_peer:false results in zero process launches (test 20)", async () => {
  const db = withTempDb();
  try {
    seedFleetAndAgents();
    const fake = makeFakeSpawn();
    _resetDiscussionStoreForTests({ spawn: fake.spawn });
    const store = getDiscussionStore();

    const opened = await store.openDiscussion(askPeerDefaults({ wake_peer: false }));
    assert.equal(opened.wake_reserved, false);
    assert.equal(fake.jobs.length, 0, "wake_peer:false must never spawn");
  } finally {
    db.cleanup();
  }
});

test("wake_peer:true reserves exactly one attempt and starts exactly one process (test 21/26)", async () => {
  const db = withTempDb();
  try {
    seedFleetAndAgents();
    const fake = makeFakeSpawn();
    _resetDiscussionStoreForTests({ spawn: fake.spawn });
    const store = getDiscussionStore();

    const opened = await store.openDiscussion(askPeerDefaults({ wake_peer: true }));
    assert.equal(opened.wake_reserved, true);
    assert.ok(opened.reservation, "expected a turn-2 reservation");
    assert.equal(fake.jobs.length, 1, "wake_peer:true must launch exactly one process");
    assert.equal(fake.jobs[0]!.attempt_id, opened.reservation!.attempt_id);
    assert.equal(fake.jobs[0]!.discussion_id, opened.discussion_id);

    const view = store.getDiscussion({ discussion_id: opened.discussion_id });
    const active = view.attempts.filter((a) => a.state === "reserved" || a.state === "started");
    assert.equal(active.length, 1, "exactly one live attempt after one wake_peer:true open");
  } finally {
    db.cleanup();
  }
});

test("wake_agent: concurrent duplicate wakes start exactly one process (test 27)", async () => {
  const db = withTempDb();
  try {
    seedFleetAndAgents();
    const fake = makeFakeSpawn();
    _resetDiscussionStoreForTests({ spawn: fake.spawn });
    const store = getDiscussionStore();

    const opened = await store.openDiscussion(askPeerDefaults({ wake_peer: false }));

    // Two "concurrent" wake_agent calls against the same head — the store
    // serializes both through the same ledger transaction, so this exercises
    // the same dedupe path a real race would (see discussion-store.ts's own
    // comment on test #27 for why a single ledger commit already makes this
    // deterministic rather than requiring an artificial barrier here).
    const [first, second] = await Promise.all([
      store.wakeAgent({ agent_id: AGENT_B, discussion_id: opened.discussion_id, expected_head_message_id: opened.root_message_id }),
      store.wakeAgent({ agent_id: AGENT_B, discussion_id: opened.discussion_id, expected_head_message_id: opened.root_message_id }),
    ]);

    assert.equal(first.attempt_id, second.attempt_id, "duplicate wakes must observe the SAME attempt");
    assert.equal(fake.jobs.length, 1, "duplicate concurrent wakes must launch exactly one process");
  } finally {
    db.cleanup();
  }
});

test("wake_agent: guard rejection (not_found) leaves the ledger completely unmutated", async () => {
  const db = withTempDb();
  try {
    seedFleetAndAgents();
    const fake = makeFakeSpawn();
    _resetDiscussionStoreForTests({ spawn: fake.spawn });
    const store = getDiscussionStore();

    const before = readLedger();
    const beforeMessageCount = Object.keys(before.messages).length;
    const beforeReceiptCount = Object.keys(before.receipts ?? {}).length;

    await assert.rejects(
      () => store.wakeAgent({ agent_id: AGENT_B, discussion_id: "no-such-discussion", expected_head_message_id: "no-such-message" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { code?: string }).code, "not_found");
        return true;
      }
    );

    const after = readLedger();
    assert.equal(Object.keys(after.messages).length, beforeMessageCount, "no message written on rejection");
    assert.equal(Object.keys(after.receipts ?? {}).length, beforeReceiptCount, "no receipt written on rejection");
    assert.equal(fake.jobs.length, 0, "a rejected wake must never launch a process");
  } finally {
    db.cleanup();
  }
});

test("wake_agent: stale_head error detail is snake_case (blueprint §5 exact payload)", async () => {
  const db = withTempDb();
  try {
    seedFleetAndAgents();
    const fake = makeFakeSpawn();
    _resetDiscussionStoreForTests({ spawn: fake.spawn });
    const store = getDiscussionStore();

    const opened = await store.openDiscussion(askPeerDefaults({ wake_peer: false }));

    await assert.rejects(
      () => store.wakeAgent({ agent_id: AGENT_B, discussion_id: opened.discussion_id, expected_head_message_id: "wrong-head" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        const e = err as { code?: string; detail?: Record<string, unknown> };
        assert.equal(e.code, "stale_head");
        assert.equal(e.detail?.expected_head_message_id, "wrong-head");
        assert.equal(e.detail?.current_head_message_id, opened.root_message_id);
        return true;
      }
    );
  } finally {
    db.cleanup();
  }
});

test("get_discussion: snake_case flat DiscussionView shape (blueprint §7 success result)", async () => {
  const db = withTempDb();
  try {
    seedFleetAndAgents();
    const fake = makeFakeSpawn();
    _resetDiscussionStoreForTests({ spawn: fake.spawn });
    const store = getDiscussionStore();

    const opened = await store.openDiscussion(askPeerDefaults({ wake_peer: false }));
    const view = store.getDiscussion({ discussion_id: opened.discussion_id });

    for (const field of [
      "discussion_id",
      "root_message_id",
      "fleet_id",
      "participants",
      "policy",
      "status",
      "head_message_id",
      "turns_used",
      "turns_remaining",
      "transcript",
      "attempts",
      "integrity_findings",
    ]) {
      assert.ok(field in view, `DiscussionView missing "${field}"`);
    }
    assert.equal(view.discussion_id, opened.discussion_id);
    assert.equal(view.root_message_id, opened.root_message_id);
    assert.equal(view.fleet_id, FLEET);
    assert.deepEqual(view.participants, [AGENT_A, AGENT_B]);
  } finally {
    db.cleanup();
  }
});

test("reply_discussion: a completed reply is reflected in get_discussion with remaining_turns/status snake_case", async () => {
  const db = withTempDb();
  try {
    seedFleetAndAgents();
    const fake = makeFakeSpawn();
    _resetDiscussionStoreForTests({ spawn: fake.spawn });
    const store = getDiscussionStore();

    const opened = await store.openDiscussion(askPeerDefaults({ wake_peer: false }));
    const wake = await store.wakeAgent({
      agent_id: AGENT_B,
      discussion_id: opened.discussion_id,
      expected_head_message_id: opened.root_message_id,
    });

    const reply = await store.replyDiscussion({
      agent_id: AGENT_B,
      discussion_id: opened.discussion_id,
      attempt_id: wake.attempt_id,
      reply_to_message_id: wake.head_message_id,
      type: "result",
      payload: "answer",
      close: true,
    });

    assert.equal(reply.status, "closed");
    assert.ok("message_id" in reply && "turn" in reply && "remaining_turns" in reply);

    const view = store.getDiscussion({ discussion_id: opened.discussion_id });
    assert.equal(view.status, "closed");
  } finally {
    db.cleanup();
  }
});

test("D3 recorded obligation: primeDiscussionSweepIndex seeds a fresh store's known-discussion set from the ledger", async () => {
  const db = withTempDb();
  try {
    seedFleetAndAgents();
    const fake = makeFakeSpawn();
    _resetDiscussionStoreForTests({ spawn: fake.spawn });
    const store = getDiscussionStore();

    // Open a discussion with a wake so there's a live `reserved` attempt with
    // a deadline in the past, then throw away this store instance (simulating
    // a process restart) WITHOUT ever calling getDiscussion/sweepStranded on
    // the new instance first.
    const opened = await store.openDiscussion(
      askPeerDefaults({ wake_peer: true, timeout_ms: 1000, turn_timeout_ms: 1000 })
    );
    assert.ok(opened.reservation);

    // Simulate the deadline having already passed.
    const pastClock = () => opened.reservation!.deadline + 1;
    const fake2 = makeFakeSpawn();
    _resetDiscussionStoreForTests({ spawn: fake2.spawn, clock: pastClock });

    // Prime BEFORE touching the discussion at all on the fresh instance —
    // this is the exact "restart, then sweep" scenario the D3 obligation
    // exists for (discussion-store.ts's sweepStranded doc comment / tests
    // K2/K3 precedent).
    const primedCount = primeDiscussionSweepIndex();
    assert.ok(primedCount >= 1, "priming must discover at least the opened discussion");

    const freshStore = getDiscussionStore();
    const sweep = await freshStore.sweepStranded(pastClock());
    const terminalizedForThisDiscussion = sweep.terminalized.filter((t) => t.discussion_id === opened.discussion_id);
    assert.equal(
      terminalizedForThisDiscussion.length,
      1,
      "a freshly-primed store must find and terminalize the stranded attempt without ever calling getDiscussion first"
    );
    assert.equal(terminalizedForThisDiscussion[0]!.state, "deadman");
  } finally {
    db.cleanup();
  }
});

test("cdx pass-1/pass-2 fix: priming a ledger with many non-discussion messages + canonical + non-canonical discussions finds exactly the right ids and never calls getDiscussion", async () => {
  const db = withTempDb();
  try {
    seedFleetAndAgents();
    const fake = makeFakeSpawn();
    _resetDiscussionStoreForTests({ spawn: fake.spawn });
    const store = getDiscussionStore();

    // N non-discussion messages: correlation_id set (so they pass the first
    // early-out) but payload has no `discussion/v1` fragment anywhere — these
    // must be rejected by the cheap substring pre-filter, never
    // JSON.parsed as an envelope.
    const N = 50;
    for (let i = 0; i < N; i++) {
      sendMessage(AGENT_A, AGENT_B, FLEET, "handoff", JSON.stringify({ note: `plain message ${i}`, i }), `not-a-discussion-${i}`);
    }

    // 2 canonical discussions (real store writes: fixed key order, no
    // whitespace — JSON.stringify's default rendering).
    const opened1 = await store.openDiscussion(askPeerDefaults({ wake_peer: false }));
    const opened2 = await store.openDiscussion(askPeerDefaults({ wake_peer: false }));

    // cdx pass-2: a hand-crafted discussion root serialized NON-canonically —
    // pretty-printed (2-space indent, so `": "` has a space the old marker
    // `"$meshfleet":"discussion/v1"` would have missed) AND with `$meshfleet`
    // reordered away from being the first key. The loosened bare-fragment
    // marker (`discussion/v1`) must still find this one; `parseEnvelope`
    // itself is whitespace/order-agnostic (it JSON.parses, then reads named
    // fields), so this is a fully valid, derivable discussion root — just not
    // one this codebase's own writers would ever actually produce.
    const reorderedDiscussionId = randomUUID();
    const now = Date.now();
    const prettyPrintedReorderedEnvelope = JSON.stringify(
      {
        turn: 1,
        kind: "question",
        reply_to: null,
        discussion_id: reorderedDiscussionId,
        body: "pretty-printed, reordered-keys root",
        close: false,
        attempt_id: randomUUID(),
        $meshfleet: "discussion/v1",
        policy: {
          participants: [AGENT_A, AGENT_B],
          max_turns: 4,
          conversation_deadline: now + 60_000,
          turn_timeout_ms: 5_000,
        },
      },
      null,
      2
    );
    assert.ok(!prettyPrintedReorderedEnvelope.includes('"$meshfleet":"discussion/v1"'), "fixture must actually break the old canonical-only marker");
    sendMessage(AGENT_A, AGENT_B, FLEET, "question", prettyPrintedReorderedEnvelope, reorderedDiscussionId);

    // Fresh store instance (simulating a restart) — getDiscussion is spied
    // so the test fails loudly if priming ever falls back to per-id
    // hydration instead of the cheap seedKnownDiscussionIds path.
    const fake2 = makeFakeSpawn();
    _resetDiscussionStoreForTests({ spawn: fake2.spawn });
    const freshStore = getDiscussionStore();
    let getDiscussionCalls = 0;
    const originalGetDiscussion = freshStore.getDiscussion.bind(freshStore);
    freshStore.getDiscussion = ((params) => {
      getDiscussionCalls++;
      return originalGetDiscussion(params);
    }) as typeof freshStore.getDiscussion;

    const primedCount = primeDiscussionSweepIndex();

    assert.equal(primedCount, 3, "must find both canonical discussions AND the pretty-printed/reordered one, ignoring all 50 non-discussion messages");
    assert.equal(getDiscussionCalls, 0, "priming must never call getDiscussion (no per-id hydration)");

    // The seeded ids are still usable once the sweeper actually runs lazily.
    const sweep = await freshStore.sweepStranded(Date.now() + 24 * 60 * 60 * 1000);
    const sweptIds = new Set(sweep.terminalized.map((t) => t.discussion_id));
    // All three discussions are already `closed`-eligible-or-open with no
    // live attempt (wake_peer:false was used / no wake ever reserved for the
    // hand-crafted root), so sweepStranded should find nothing to
    // terminalize — the assertion here is just that calling it over the
    // seeded ids does not throw.
    void opened1;
    void opened2;
    void sweptIds;
  } finally {
    db.cleanup();
  }
});

test("D3 startup wiring: the deferred prime call is registered AFTER server.connect(transport) (registration-order)", () => {
  const connectIdx = indexSource.indexOf("await server.connect(transport)");
  const setImmediateIdx = indexSource.indexOf("setImmediate(() => {");
  const primeCallIdx = indexSource.indexOf("primeDiscussionSweepIndex()");

  assert.ok(connectIdx !== -1, "could not locate server.connect(transport) in index.ts");
  assert.ok(setImmediateIdx !== -1, "could not locate the setImmediate deferral wrapping the prime call");
  assert.ok(primeCallIdx !== -1, "could not locate the primeDiscussionSweepIndex() call site");

  assert.ok(connectIdx < setImmediateIdx, "setImmediate(...) prime deferral must appear after server.connect(transport)");
  assert.ok(setImmediateIdx < primeCallIdx, "primeDiscussionSweepIndex() call must be inside the setImmediate deferral");
});

test("D3 startup wiring: a periodic sweepStranded loop is wired (priming alone never terminalizes)", () => {
  // The D3 recorded obligation (discussion-store.ts "D3 OBLIGATION" note)
  // names BOTH halves: prime the sweep index at startup AND run the
  // periodic sweeper. The prime is asserted by the test above; this test
  // pins the missing second half — without a periodic `sweepStranded()`
  // call, a stranded `reserved`/`started` attempt would sit live forever
  // (never `deadman`, never killed, turn budget never charged) as long as
  // no tool traffic touches its discussion.
  assert.ok(
    indexSource.includes("MESHFLEET_DISCUSSION_SWEEP_MS"),
    "the discussion sweeper must be configurable via MESHFLEET_DISCUSSION_SWEEP_MS (0 disables)",
  );
  assert.ok(
    indexSource.includes(".sweepStranded()"),
    "the periodic discussion sweeper must call store.sweepStranded()",
  );
  assert.ok(
    indexSource.includes("discussionSweeper.unref()"),
    "the discussion sweeper interval must be unref'd so it cannot hold the process open",
  );
  // The sweeper must be registered after the startup prime (which seeds the
  // ids the sweeper scans) and after the ratification sweeper block.
  const primeIdx = indexSource.indexOf("primeDiscussionSweepIndex()");
  const discussionSweepIdx = indexSource.indexOf("MESHFLEET_DISCUSSION_SWEEP_MS");
  const ratifyIdx = indexSource.indexOf("ratification sweep");
  assert.ok(primeIdx !== -1 && discussionSweepIdx !== -1 && ratifyIdx !== -1, "expected markers missing from index.ts");
  assert.ok(
    ratifyIdx < discussionSweepIdx,
    "the discussion sweeper must be registered after the ratification sweeper block",
  );
  assert.ok(
    primeIdx < discussionSweepIdx,
    "the discussion sweeper must be registered after the sweep-index prime",
  );
});

test("D3 sweeper obligation: a fresh store primed from the ledger then swept terminalizes a past-deadline reservation", async () => {
  // Behavioral end-to-end for the obligation the wiring test above pins
  // statically: a process restart leaves a stranded `reserved` attempt with
  // a passed deadline; priming discovers its discussion; one sweepStranded
  // call (exactly what the periodic loop invokes) terminalizes it as
  // `deadman` and charges the turn.
  const db = withTempDb();
  try {
    seedFleetAndAgents();
    const fake = makeFakeSpawn();
    _resetDiscussionStoreForTests({ spawn: fake.spawn });
    const store = getDiscussionStore();

    const opened = await store.openDiscussion(
      askPeerDefaults({ wake_peer: true, timeout_ms: 1000, turn_timeout_ms: 1000 })
    );
    assert.ok(opened.reservation);

    const pastClock = () => opened.reservation!.deadline + 1;
    const fake2 = makeFakeSpawn();
    _resetDiscussionStoreForTests({ spawn: fake2.spawn, clock: pastClock });

    // Restart simulation: prime, then sweep — no getDiscussion in between,
    // exactly the periodic loop's call pattern.
    const primedCount = primeDiscussionSweepIndex();
    assert.ok(primedCount >= 1, "priming must discover the stranded discussion");

    const freshStore = getDiscussionStore();
    const sweep = await freshStore.sweepStranded(pastClock());
    const terminalizedForThisDiscussion = sweep.terminalized.filter((t) => t.discussion_id === opened.discussion_id);
    assert.equal(terminalizedForThisDiscussion.length, 1, "the sweep must terminalize the stranded attempt");
    assert.equal(terminalizedForThisDiscussion[0]!.state, "deadman");

    const view = freshStore.getDiscussion({ discussion_id: opened.discussion_id });
    assert.equal(view.status, "deadman", "the discussion must derive as deadman after the sweep");
    assert.equal(view.attempts.find((a) => a.attempt_id === opened.reservation!.attempt_id)?.state, "deadman");
  } finally {
    db.cleanup();
  }
});

test("primeDiscussionSweepIndex is best-effort: an empty ledger primes zero discussions without throwing", () => {
  const db = withTempDb();
  try {
    assert.doesNotThrow(() => {
      const count = primeDiscussionSweepIndex();
      assert.equal(count, 0);
    });
  } finally {
    db.cleanup();
  }
});

test("ask_peer full round trip via openDiscussion+awaitAnswer (composing exactly as the ask_peer handler does)", async () => {
  const db = withTempDb();
  try {
    seedFleetAndAgents();
    const fake = makeFakeSpawn();
    _resetDiscussionStoreForTests({ spawn: fake.spawn });
    const store = getDiscussionStore();

    const opened = await store.openDiscussion(askPeerDefaults({ wake_peer: true }));
    assert.equal(fake.jobs.length, 1);

    // Answer the reservation as the woken child would, then let the exit
    // callback fire so the fake spawn's lifecycle matches a real child's.
    const wakeAttemptId = opened.reservation!.attempt_id;
    await store.replyDiscussion({
      agent_id: AGENT_B,
      discussion_id: opened.discussion_id,
      attempt_id: wakeAttemptId,
      reply_to_message_id: opened.root_message_id,
      type: "result",
      payload: "the answer",
      close: true,
    });
    fake.exits[0]!({ code: 0 });

    const result = await store.awaitAnswer(opened.discussion_id, opened.root_message_id);
    assert.equal(result.status, "answered");
    assert.equal(result.answer?.payload, JSON.stringify({
      $meshfleet: "discussion/v1",
      discussion_id: opened.discussion_id,
      turn: 2,
      attempt_id: wakeAttemptId,
      reply_to: opened.root_message_id,
      kind: "result",
      body: "the answer",
      close: true,
    }));
  } finally {
    db.cleanup();
  }
});

// ============================================================
// Model-selected execution — task 3
// Discussion launches use the default RuntimeAdapter; the synchronous
// SpawnFn contract is preserved by returning a deferred proxy over
// runtime.start() that maps success/failure/cancellation/timeout back onto
// the store's existing `onExit` (exactly once). The proxy must inherit the
// participant's stored `agent_file` and `requested_model` and must NOT
// raw-spawn OpenCode.
// ============================================================

interface DeferredRuntime {
  adapter: RuntimeAdapter;
  starts: ExecutionSpec[];
  /** Pending wait promises, one per started attempt, each a deferred `RuntimeResult`. */
  waits: Array<{ resolve: (r: RuntimeResult) => void; reject: (e: unknown) => void }>;
  /** Pending cancel calls, one per cancel invocation, each a deferred `CancelResult`. */
  cancels: Array<{
    handle: RuntimeHandle;
    reason: string;
    resolve: (r: CancelResult) => void;
    reject: (e: unknown) => void;
  }>;
  /** Outstanding `start` promises, one per start call, each a deferred `RuntimeHandle`. */
  pendingStarts: Array<{
    resolve: (h: RuntimeHandle) => void;
    reject: (e: unknown) => void;
    spec: ExecutionSpec;
  }>;
}

function makeDeferredRuntime(): DeferredRuntime {
  const waits: DeferredRuntime["waits"] = [];
  const cancels: DeferredRuntime["cancels"] = [];
  const pendingStarts: DeferredRuntime["pendingStarts"] = [];
  const starts: ExecutionSpec[] = [];

  const adapter: RuntimeAdapter = {
    id: "deferred-test",
    describe() { return { id: "deferred-test", displayName: "Deferred Test", defaultTimeoutMs: 60_000 }; },
    validate() { return { ok: true, errors: [] }; },
    start(spec: ExecutionSpec): Promise<RuntimeHandle> {
      starts.push(spec);
      return new Promise<RuntimeHandle>((resolve, reject) => {
        pendingStarts.push({ resolve, reject, spec });
      });
    },
    wait(handle: RuntimeHandle): Promise<RuntimeResult> {
      void handle;
      return new Promise<RuntimeResult>((resolve, reject) => {
        waits.push({ resolve, reject });
      });
    },
    cancel(handle: RuntimeHandle, reason: string): Promise<CancelResult> {
      return new Promise<CancelResult>((resolve, reject) => {
        cancels.push({ handle, reason, resolve, reject });
      });
    },
  };

  return { adapter, starts, waits, cancels, pendingStarts };
}

/** Build a real Agent with a persisted `agent_file` and `requested_model`. */
function agentWithLaunchConfig(id: string, opts: { agentFile?: string; requestedModel?: string } = {}): Agent {
  const a: Agent = {
    id,
    fleet_id: FLEET,
    role: "worker",
    prompt: "",
    status: "running",
    started_at: Date.now(),
  };
  if (opts.agentFile !== undefined) a.agent_file = opts.agentFile;
  if (opts.requestedModel !== undefined) a.requested_model = opts.requestedModel;
  return a;
}

test("Task 3 #6 — Discussion supplies the stored requestedAgent and requestedModel to the runtime adapter", async () => {
  const db = withTempDb();
  try {
    createFleet(FLEET);
    registerAgentInLedger(agentWithLaunchConfig(AGENT_A));
    registerAgentInLedger(agentWithLaunchConfig(AGENT_B, { agentFile: "oracle", requestedModel: "opencode-go/minimax-m3" }));

    const runtime = makeDeferredRuntime();
    _resetDiscussionStoreForTests({ runtime: runtime.adapter });
    const store = getDiscussionStore();

    const opened = await store.openDiscussion(askPeerDefaults({ wake_peer: true }));
    assert.ok(opened.reservation, "wake_peer:true must produce a reservation");
    assert.equal(runtime.starts.length, 1, "the deferred adapter's start must be called exactly once");
    const spec = runtime.starts[0]!;
    assert.equal(spec.fleetId, FLEET);
    assert.equal(spec.agentId, AGENT_B);
    assert.equal(spec.requestedAgent, "oracle", "the persisted agent_file must reach the adapter");
    assert.equal(spec.requestedModel, "opencode-go/minimax-m3", "the persisted requested_model must reach the adapter");

    // Settle: resolve the start, then a successful wait, then verify the
    // attempt settles `failed` (no synthesized reply) exactly once.
    runtime.pendingStarts[0]!.resolve({ id: "h-1", startedAt: 1, isAlive: () => true });
    await new Promise((done) => setImmediate(done));
    runtime.waits[0]!.resolve({ status: "success", stdout: "ok", stderr: "", exitCode: 0, diagnostics: [], identity: { adapterId: "deferred-test", evidence: "none" } });
    await new Promise((done) => setImmediate(done));

    const view = store.getDiscussion({ discussion_id: opened.discussion_id });
    const attempt = view.attempts.find((a) => a.attempt_id === opened.reservation!.attempt_id);
    assert.equal(attempt?.state, "failed", "a successful runtime that never called reply_discussion settles failed (no synthesized reply)");
  } finally {
    db.cleanup();
  }
});

test("Task 3 #7 — a successful runtime completion followed by reply_discussion never re-invokes onExit (exactly once)", async () => {
  const db = withTempDb();
  try {
    createFleet(FLEET);
    registerAgentInLedger(agentWithLaunchConfig(AGENT_A));
    registerAgentInLedger(agentWithLaunchConfig(AGENT_B, { agentFile: "oracle", requestedModel: "opencode-go/minimax-m3" }));

    const runtime = makeDeferredRuntime();
    _resetDiscussionStoreForTests({ runtime: runtime.adapter });
    const store = getDiscussionStore();

    const opened = await store.openDiscussion(askPeerDefaults({ wake_peer: true }));
    assert.ok(opened.reservation);

    runtime.pendingStarts[0]!.resolve({ id: "h-1", startedAt: 1, isAlive: () => true });

    await store.replyDiscussion({
      agent_id: AGENT_B,
      discussion_id: opened.discussion_id,
      attempt_id: opened.reservation!.attempt_id,
      reply_to_message_id: opened.root_message_id,
      type: "result",
      payload: "the answer",
      close: true,
    });

    // Now the runtime wait resolves successfully — must NOT trigger a failed
    // settlement (the attempt is already `completed` via the reply receipt).
    runtime.waits[0]!.resolve({ status: "success", stdout: "ok", stderr: "", exitCode: 0, diagnostics: [], identity: { adapterId: "deferred-test", evidence: "none" } });
    await new Promise((done) => setImmediate(done));

    const view = store.getDiscussion({ discussion_id: opened.discussion_id });
    const attempt = view.attempts.find((a) => a.attempt_id === opened.reservation!.attempt_id);
    assert.equal(attempt?.state, "completed", "the attempt is `completed` from the reply — a late successful wait must not flip it to failed");
    // No second launch was ever issued.
    assert.equal(runtime.starts.length, 1);
  } finally {
    db.cleanup();
  }
});

test("Task 3 #8 — a deadman kill BEFORE start() resolves cancels the late runtime handle exactly once", async () => {
  const db = withTempDb();
  try {
    createFleet(FLEET);
    registerAgentInLedger(agentWithLaunchConfig(AGENT_A));
    registerAgentInLedger(agentWithLaunchConfig(AGENT_B, { agentFile: "oracle", requestedModel: "opencode-go/minimax-m3" }));

    const runtime = makeDeferredRuntime();
    const terminalEvents: unknown[] = [];
    _resetDiscussionStoreForTests({
      runtime: runtime.adapter,
      notify: (event) => terminalEvents.push(event),
    });
    const store = getDiscussionStore();

    const opened = await store.openDiscussion(
      askPeerDefaults({ wake_peer: true, timeout_ms: 1000, turn_timeout_ms: 1000 })
    );
    assert.ok(opened.reservation);

    // start() is still pending. Drive the deadman settlement with the past
    // deadline via the explicit `nowMs` argument to sweepStranded — the kill
    // must be recorded as requested even though no runtime handle exists yet.
    const pastClock = opened.reservation!.deadline + 1;
    const sweep = await store.sweepStranded(pastClock);
    assert.equal(sweep.terminalized.length, 1, "deadman must terminalize the reservation");
    assert.equal(sweep.terminalized[0]!.state, "deadman");
    assert.equal(runtime.cancels.length, 0, "no runtime handle exists yet, so the cancel call is deferred");

    // Now the start resolves — the deferred proxy must observe the prior
    // cancellation request and call cancel(handle) on the late runtime handle
    // exactly once, then call wait() to drain the runtime.
    runtime.pendingStarts[0]!.resolve({ id: "h-late", startedAt: 1, isAlive: () => true });
    await new Promise((done) => setImmediate(done));
    assert.equal(runtime.cancels.length, 1, "the late handle must be cancelled exactly once");
    assert.equal(runtime.cancels[0]!.reason, "discussion deadline");
    assert.equal(runtime.waits.length, 1, "wait() starts without waiting for cancellation to settle");
    // Reject cancellation to prove it cannot suppress the already-running
    // wait path, then settle the runtime as cancelled.
    runtime.cancels[0]!.reject(new Error("injected cancel rejection"));
    runtime.waits[0]!.resolve({ status: "cancelled", stdout: "", stderr: "", exitCode: null, diagnostics: [], identity: { adapterId: "deferred-test", evidence: "none" } });
    await new Promise((done) => setImmediate(done));
    assert.equal(runtime.waits.length, 1, "wait() must still be called even after a pre-start cancellation");
    assert.equal(
      terminalEvents.filter((event) => (event as { kind?: string }).kind === "terminal").length,
      1,
      "cancellation and wait settlement produce exactly one terminal notification"
    );
  } finally {
    db.cleanup();
  }
});

test("Task 3 #9 — an adapter start() rejection follows the existing failed-exit path (no retry, no reply)", async () => {
  const db = withTempDb();
  try {
    createFleet(FLEET);
    registerAgentInLedger(agentWithLaunchConfig(AGENT_A));
    registerAgentInLedger(agentWithLaunchConfig(AGENT_B, { agentFile: "oracle", requestedModel: "opencode-go/minimax-m3" }));

    const runtime = makeDeferredRuntime();
    _resetDiscussionStoreForTests({ runtime: runtime.adapter });
    const store = getDiscussionStore();

    const opened = await store.openDiscussion(askPeerDefaults({ wake_peer: true }));
    assert.ok(opened.reservation);

    // Reject the pending start; the proxy must invoke onExit({code: null})
    // exactly once and never issue a second start.
    runtime.pendingStarts[0]!.reject(new Error("injected adapter start failure"));
    await new Promise((done) => setImmediate(done));

    const view = store.getDiscussion({ discussion_id: opened.discussion_id });
    const attempt = view.attempts.find((a) => a.attempt_id === opened.reservation!.attempt_id);
    assert.equal(attempt?.state, "failed", "an adapter start rejection must settle the attempt to failed");
    assert.equal(runtime.starts.length, 1, "no automatic retry — a single start call is the boundary");
  } finally {
    db.cleanup();
  }
});

test("Task 3 #10 — omitted model selection leaves requestedModel absent from the adapter spec", async () => {
  const db = withTempDb();
  try {
    createFleet(FLEET);
    registerAgentInLedger(agentWithLaunchConfig(AGENT_A));
    registerAgentInLedger(agentWithLaunchConfig(AGENT_B, { agentFile: "oracle" })); // no requested_model

    const runtime = makeDeferredRuntime();
    _resetDiscussionStoreForTests({ runtime: runtime.adapter });
    const store = getDiscussionStore();

    const opened = await store.openDiscussion(askPeerDefaults({ wake_peer: true }));
    assert.ok(opened.reservation);

    assert.equal(runtime.starts.length, 1);
    const spec = runtime.starts[0]!;
    assert.equal(spec.requestedAgent, "oracle");
    assert.equal(spec.requestedModel, undefined, "an unselected participant must not have a requestedModel on the adapter spec");
  } finally {
    db.cleanup();
  }
});

test("Task 3 #11 — a failed runtime result with exitCode 0 settles once and never retries", async () => {
  const db = withTempDb();
  try {
    createFleet(FLEET);
    registerAgentInLedger(agentWithLaunchConfig(AGENT_A));
    registerAgentInLedger(agentWithLaunchConfig(AGENT_B, {
      requestedModel: "opencode-go/minimax-m3",
    }));

    const runtime = makeDeferredRuntime();
    const terminalEvents: unknown[] = [];
    _resetDiscussionStoreForTests({
      runtime: runtime.adapter,
      notify: (event) => terminalEvents.push(event),
    });
    const store = getDiscussionStore();
    const opened = await store.openDiscussion(askPeerDefaults({ wake_peer: true }));
    assert.ok(opened.reservation);

    runtime.pendingStarts[0]!.resolve({ id: "h-failure", startedAt: 1, isAlive: () => true });
    await new Promise((done) => setImmediate(done));
    runtime.waits[0]!.resolve({
      status: "failure",
      stdout: "",
      stderr: "requested model mismatch",
      exitCode: 0,
      diagnostics: [],
      identity: { adapterId: "deferred-test", evidence: "observed", model: "openai/gpt-5" },
    });
    await new Promise((done) => setImmediate(done));

    const attempt = store
      .getDiscussion({ discussion_id: opened.discussion_id })
      .attempts.find((candidate) => candidate.attempt_id === opened.reservation!.attempt_id);
    assert.equal(attempt?.state, "failed");
    assert.equal(runtime.starts.length, 1, "Discussion never retries a failed runtime result");
    assert.equal(
      terminalEvents.filter((event) => (event as { kind?: string }).kind === "terminal").length,
      1,
      "the deferred proxy invokes the store exit path once"
    );
  } finally {
    db.cleanup();
  }
});

test("Task 3 #12 — a runtime wait rejection follows the failed-exit path once", async () => {
  const db = withTempDb();
  try {
    createFleet(FLEET);
    registerAgentInLedger(agentWithLaunchConfig(AGENT_A));
    registerAgentInLedger(agentWithLaunchConfig(AGENT_B));

    const runtime = makeDeferredRuntime();
    const terminalEvents: unknown[] = [];
    _resetDiscussionStoreForTests({
      runtime: runtime.adapter,
      notify: (event) => terminalEvents.push(event),
    });
    const store = getDiscussionStore();
    const opened = await store.openDiscussion(askPeerDefaults({ wake_peer: true }));
    assert.ok(opened.reservation);

    runtime.pendingStarts[0]!.resolve({ id: "h-wait-reject", startedAt: 1, isAlive: () => true });
    await new Promise((done) => setImmediate(done));
    runtime.waits[0]!.reject(new Error("injected wait rejection"));
    await new Promise((done) => setImmediate(done));

    const attempt = store
      .getDiscussion({ discussion_id: opened.discussion_id })
      .attempts.find((candidate) => candidate.attempt_id === opened.reservation!.attempt_id);
    assert.equal(attempt?.state, "failed");
    assert.equal(runtime.starts.length, 1);
    assert.equal(
      terminalEvents.filter((event) => (event as { kind?: string }).kind === "terminal").length,
      1
    );
  } finally {
    db.cleanup();
  }
});
