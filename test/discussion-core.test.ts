import { test } from "node:test";
import assert from "node:assert/strict";

import { MESSAGE_TYPES, type Message, type MessageType, type Receipt } from "../src/core.js";
import {
  deriveDiscussion,
  parseEnvelope,
  parseReceiptAction,
  recomputeStatus,
  validateEnvelope,
  validatePayloadSize,
  type Envelope,
  type EnvelopeKind,
  type Policy,
} from "../src/discussion.js";

// ---------------------------------------------------------------------------
// Test helpers — construct real core.ts Message/Receipt shapes directly
// (discussion.ts is pure; no ledger, no withTempDb needed).
//
// A fixed clock throughout: cdx review flagged a prior D5 test as time-flaky
// (it captured `base.now` once, then built a deadline from a LATER
// `Date.now()` call — the two could straddle a millisecond boundary). Every
// "now"/deadline/timestamp value below is derived from this one constant,
// never from a fresh `Date.now()` call.
// ---------------------------------------------------------------------------

const FIXED_NOW = 1_700_000_000_000;

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

function mkMessage(opts: {
  id: string;
  type: MessageType;
  from: string;
  to: string;
  fleetId: string;
  payload: string;
  correlationId?: string;
  timestamp?: number;
}): Message {
  return {
    id: opts.id,
    from_agent_id: opts.from,
    to_agent_id: opts.to,
    fleet_id: opts.fleetId,
    type: opts.type,
    payload: opts.payload,
    correlation_id: opts.correlationId,
    timestamp: opts.timestamp ?? FIXED_NOW,
    acknowledged: false,
  };
}

function mkReceipt(messageId: string, agentId: string, action: string, note?: string, timestamp = FIXED_NOW): Receipt {
  return { message_id: messageId, agent_id: agentId, action, timestamp, note };
}

function mkPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    participants: ["agent-a", "agent-b"],
    max_turns: 6,
    conversation_deadline: FIXED_NOW + 60_000,
    turn_timeout_ms: 30_000,
    ...overrides,
  };
}

function envelopeJson(opts: {
  discussionId: string;
  turn: number;
  attemptId: string;
  replyTo: string | null;
  kind: EnvelopeKind;
  body?: string;
  close?: boolean;
  policy?: Policy;
}): string {
  const env: Envelope = {
    $meshfleet: "discussion/v1",
    discussion_id: opts.discussionId,
    turn: opts.turn,
    attempt_id: opts.attemptId,
    reply_to: opts.replyTo,
    kind: opts.kind,
    body: opts.body ?? "body",
    close: opts.close ?? false,
    policy: opts.policy,
  };
  return JSON.stringify(env);
}

/** Builds a root message for a discussion: agent-a -> agent-b on fleet f1, with the given policy. */
function rootMessage(
  discussionId: string,
  policy: Policy,
  overrides: { id?: string; kind?: EnvelopeKind; type?: MessageType; close?: boolean } = {}
): Message {
  const payload = envelopeJson({
    discussionId,
    turn: 1,
    attemptId: nextId("attempt"),
    replyTo: null,
    kind: overrides.kind ?? "question",
    close: overrides.close ?? false,
    policy,
  });
  return mkMessage({
    id: overrides.id ?? nextId("root"),
    type: overrides.type ?? "question",
    from: policy.participants[0],
    to: policy.participants[1],
    fleetId: "f1",
    payload,
    correlationId: discussionId,
  });
}

/** A structurally-plain reply with NO backing receipts — used to prove unauthorized replies are never admitted. */
function plainReply(discussionId: string, head: Message, turn: number, kind: EnvelopeKind, fleetId = "f1"): Message {
  return replyWithAttemptId(discussionId, head, turn, kind, nextId("envattempt"), fleetId);
}

/** A structurally-plain reply whose envelope carries a CALLER-CHOSEN attempt_id (for testing attempt-id binding). */
function replyWithAttemptId(
  discussionId: string,
  head: Message,
  turn: number,
  kind: EnvelopeKind,
  attemptId: string,
  fleetId = "f1"
): Message {
  const payload = envelopeJson({
    discussionId,
    turn,
    attemptId,
    replyTo: head.id,
    kind,
  });
  return mkMessage({
    id: nextId("msg"),
    type: kind,
    from: head.to_agent_id,
    to: head.from_agent_id,
    fleetId,
    payload,
    correlationId: discussionId,
  });
}

function wakeNoteJson(discussionId: string, headId: string, deadline: number, replyMessageId?: string): string {
  const note: Record<string, unknown> = { discussion_id: discussionId, head_message_id: headId, deadline };
  if (replyMessageId !== undefined) note.reply_message_id = replyMessageId;
  return JSON.stringify(note);
}

function wakeReceipt(
  headId: string,
  agentId: string,
  state: "reserved" | "started" | "completed" | "failed" | "deadman",
  turn: number,
  attemptId: string,
  discussionId: string,
  deadline: number,
  replyMessageId?: string,
  timestamp = FIXED_NOW
): Receipt {
  return mkReceipt(
    headId,
    agentId,
    `discussion.wake.${state}.v1:${turn}:${attemptId}`,
    wakeNoteJson(discussionId, headId, deadline, replyMessageId),
    timestamp
  );
}

/**
 * Builds a reply continuing from `head`, PLUS the reserved+completed receipts that
 * authorize it (bound to `head`). The envelope's OWN `attempt_id` is set to the SAME
 * attempt id used for the receipts — admission requires this to match (cdx pass-2
 * fix 1); an earlier version of this helper generated two DIFFERENT ids here, which
 * is exactly the gap cdx's review caught (discussion-core.test.ts formerly at :175).
 */
function authorizeReply(
  discussionId: string,
  head: Message,
  turn: number,
  kind: EnvelopeKind,
  opts: { close?: boolean; deadline?: number; attemptId?: string; envelopeTurn?: number; fleetId?: string } = {}
): { message: Message; receipts: Receipt[]; attemptId: string } {
  const attemptId = opts.attemptId ?? nextId("attempt");
  const deadline = opts.deadline ?? FIXED_NOW + 30_000;
  const messageId = nextId("msg");
  const payload = envelopeJson({
    discussionId,
    turn: opts.envelopeTurn ?? turn,
    attemptId, // <-- matches the receipts' attempt id, not a separately-generated one
    replyTo: head.id,
    kind,
    close: opts.close ?? false,
  });
  const message = mkMessage({
    id: messageId,
    type: kind,
    from: head.to_agent_id,
    to: head.from_agent_id,
    fleetId: opts.fleetId ?? head.fleet_id,
    payload,
    correlationId: discussionId,
  });
  const reserved = wakeReceipt(head.id, head.to_agent_id, "reserved", turn, attemptId, discussionId, deadline);
  const completed = wakeReceipt(head.id, head.to_agent_id, "completed", turn, attemptId, discussionId, deadline, messageId);
  return { message, receipts: [reserved, completed], attemptId };
}

/** A reserved attempt that then fails — no reply message is ever produced. */
function failedAttempt(discussionId: string, head: Message, turn: number, attemptId = nextId("attempt")): Receipt[] {
  const deadline = FIXED_NOW + 30_000;
  return [
    wakeReceipt(head.id, head.to_agent_id, "reserved", turn, attemptId, discussionId, deadline),
    wakeReceipt(head.id, head.to_agent_id, "failed", turn, attemptId, discussionId, deadline),
  ];
}

// ===========================================================================
// Spec red tests 1-14 (SUCCESSION/a2a-discussions/lane-1-cdx-discussions-api-design.md §15)
// ===========================================================================

test("Spec #1: root uses existing 'question'; reply uses only 'question' or 'result'", () => {
  const policy = mkPolicy();
  const discussionId = nextId("disc");
  const root = rootMessage(discussionId, policy);
  const envelope = parseEnvelope(root.payload);
  assert.equal(envelope?.kind, "question");
  assert.equal(root.type, "question");

  const r1 = authorizeReply(discussionId, root, 2, "result");
  const replyEnvelope = parseEnvelope(r1.message.payload);
  assert.equal(replyEnvelope?.kind, "result");

  const r2 = authorizeReply(discussionId, r1.message, 3, "question");
  const followUpEnvelope = parseEnvelope(r2.message.payload);
  assert.equal(followUpEnvelope?.kind, "question");

  const result = deriveDiscussion(discussionId, [root, r1.message, r2.message], [...r1.receipts, ...r2.receipts]);
  assert.equal(result.transcript.length, 3);
});

test("Spec #2: no new MESSAGE_TYPES member is introduced", () => {
  assert.deepEqual([...MESSAGE_TYPES].sort(), ["alert", "handoff", "question", "request_help", "result"].sort());
  const policy = mkPolicy();
  const badKindPayload = JSON.stringify({
    $meshfleet: "discussion/v1",
    discussion_id: "d1",
    turn: 1,
    attempt_id: "a1",
    reply_to: null,
    kind: "alert",
    body: "b",
    close: false,
    policy,
  });
  assert.equal(parseEnvelope(badKindPayload), null);
});

test("Spec #3: serialized envelope at 65,537 UTF-8 bytes is rejected", () => {
  assert.equal(validatePayloadSize("x".repeat(65537)), false);
});

test("Spec #4: exactly 65,536 UTF-8 bytes is accepted", () => {
  assert.equal(validatePayloadSize("x".repeat(65536)), true);
});

test("Spec #5: two roots with one discussion id make the aggregate invalid", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root1 = rootMessage(discussionId, policy);
  const root2 = rootMessage(discussionId, policy);

  const result = deriveDiscussion(discussionId, [root1, root2], []);
  assert.equal(result.status, "invalid");
  assert.ok(result.integrity_findings.some((f) => f.code === "duplicate_root"));
});

test("Spec #6: a correlated legacy message is reported as foreign, not merged", () => {
  const discussionId = nextId("disc");
  const legacy = mkMessage({
    id: nextId("legacy"),
    type: "question",
    from: "agent-a",
    to: "agent-b",
    fleetId: "f1",
    payload: JSON.stringify({ old_format: true }),
    correlationId: discussionId,
  });

  const result = deriveDiscussion(discussionId, [legacy], []);
  assert.equal(result.status, "invalid"); // no valid root at all
  assert.ok(result.integrity_findings.some((f) => f.code === "invalid_envelope" && f.message_id === legacy.id));
});

test("Spec #7: messages order by server turn ordinal, not timestamp", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  root.timestamp = FIXED_NOW; // identical timestamp for every message on purpose
  const r1 = authorizeReply(discussionId, root, 2, "result");
  r1.message.timestamp = FIXED_NOW;
  const r2 = authorizeReply(discussionId, r1.message, 3, "question");
  r2.message.timestamp = FIXED_NOW;

  const result = deriveDiscussion(discussionId, [root, r1.message, r2.message], [...r1.receipts, ...r2.receipts]);
  assert.equal(result.transcript.length, 3);
  assert.deepEqual(
    result.transcript.map((e) => e.turn),
    [1, 2, 3]
  );
});

test("Spec #8: chain resolution follows reply_to + receipt authorization, independent of array/arrival order", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  const r1 = authorizeReply(discussionId, root, 2, "result");
  const r2 = authorizeReply(discussionId, r1.message, 3, "question");

  const allMessages = [root, r1.message, r2.message];
  const allReceipts = [...r1.receipts, ...r2.receipts];

  const forward = deriveDiscussion(discussionId, allMessages, allReceipts);
  const reversed = deriveDiscussion(discussionId, [...allMessages].reverse(), [...allReceipts].reverse());

  assert.deepEqual(
    forward.transcript.map((e) => e.message.id),
    reversed.transcript.map((e) => e.message.id)
  );
  assert.equal(forward.head_message_id, reversed.head_message_id);
  assert.equal(forward.status, reversed.status);
});

test("Spec #9: wrong-fleet and third-participant replies are rejected (finding + head does not advance + fail-closed invalid)", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  // agent-c is a third participant in a different fleet entirely.
  const intruder = plainReply(discussionId, root, 2, "result", "f2");
  const withIntruder: Message = { ...intruder, from_agent_id: "agent-c" };

  const result = deriveDiscussion(discussionId, [root, withIntruder], []);
  assert.ok(result.integrity_findings.some((f) => f.code === "wrong_fleet"));
  assert.ok(result.integrity_findings.some((f) => f.code === "participant_violation"));
  assert.equal(result.transcript.length, 1, "wrong-fleet message must not join the transcript");
  assert.equal(result.head_message_id, root.id, "head must not advance past a rejected candidate");
  assert.equal(result.status, "invalid", "a participant/fleet violation fails the whole discussion closed");
});

test("Spec #10: broadcast root and broadcast reply are rejected", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  const broadcastRoot: Message = { ...root, to_agent_id: "*", recipients: ["agent-b", "agent-c"] };

  const envelope = parseEnvelope(broadcastRoot.payload);
  const validation = validateEnvelope(envelope, broadcastRoot);
  assert.equal(validation.valid, false);
  assert.equal(validation.reason, "broadcast_forbidden");
});

test("Spec #11: acking every message leaves the derived transcript unchanged", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  const r1 = authorizeReply(discussionId, root, 2, "result");

  const beforeAck = deriveDiscussion(discussionId, [root, r1.message], r1.receipts);
  assert.equal(beforeAck.transcript.length, 2);

  const ackedRoot = { ...root, acknowledged: true };
  const ackedReply = { ...r1.message, acknowledged: true };
  const afterAck = deriveDiscussion(discussionId, [ackedRoot, ackedReply], r1.receipts);

  assert.equal(afterAck.transcript.length, beforeAck.transcript.length);
  assert.deepEqual(
    afterAck.transcript.map((e) => e.message.id),
    beforeAck.transcript.map((e) => e.message.id)
  );
});

test("Spec #12: a fork from one head is detected and blocks future wakes (status invalid)", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  // Two DIFFERENT, each independently authorized (valid completed receipt), replies race for root's head.
  const forkA = authorizeReply(discussionId, root, 2, "result");
  const forkB = authorizeReply(discussionId, root, 2, "result");

  const result = deriveDiscussion(
    discussionId,
    [root, forkA.message, forkB.message],
    [...forkA.receipts, ...forkB.receipts]
  );
  assert.ok(result.integrity_findings.some((f) => f.code === "fork"));
  assert.equal(result.status, "invalid", "an authorized fork must make the discussion fail-closed invalid");
});

test("Spec #13: two authorized replies contesting the same (stale) head both lose — neither becomes canonical", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  const winner = authorizeReply(discussionId, root, 2, "result");
  const staleLoser = authorizeReply(discussionId, root, 3, "result"); // ALSO authorized at root, not at winner

  const result = deriveDiscussion(
    discussionId,
    [root, winner.message, staleLoser.message],
    [...winner.receipts, ...staleLoser.receipts]
  );
  assert.equal(result.head_message_id, root.id, "neither contested reply becomes canonical head");
  assert.equal(result.status, "invalid");
  assert.ok(!result.transcript.some((e) => e.message.id === staleLoser.message.id));
  assert.ok(!result.transcript.some((e) => e.message.id === winner.message.id));
});

test("Spec #14: a failed attempt produces an ordinal gap without corrupting the transcript", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy({ max_turns: 8 });
  const root = rootMessage(discussionId, policy);
  const r2 = authorizeReply(discussionId, root, 2, "result");
  // Turn 3 IS reserved on turn2's head, then fails — no message is ever produced for it,
  // but the reservation itself is real, so the reservation SEQUENCE stays continuous (2,3,4).
  const failReceipts = failedAttempt(discussionId, r2.message, 3);
  // Turn 4 correctly replies to turn2 (the real head), skipping the failed turn 3.
  const r4 = authorizeReply(discussionId, r2.message, 4, "question");

  const result = deriveDiscussion(
    discussionId,
    [root, r2.message, r4.message],
    [...r2.receipts, ...failReceipts, ...r4.receipts]
  );

  assert.deepEqual(
    result.transcript.map((e) => e.turn),
    [1, 2, 4],
    "transcript must show the gap at turn 3, not renumber positions"
  );
  assert.equal(result.head_message_id, r4.message.id);
  assert.ok(result.attempts.some((a) => a.turn === 3 && a.state === "failed"));
  assert.equal(result.turns_used, 4, "turn budget includes the failed-but-reserved turn 3 attempt");
  assert.notEqual(result.status, "invalid");
});

// ===========================================================================
// D1-D5 regression tests (drafts/h0.1-envelope-derivation-draft-v2.md defects)
// ===========================================================================

test("D1: payload-size guard uses UTF-8 byte length, not JS string length", () => {
  // '€' is 1 UTF-16 code unit (string.length counts it as 1) but 3 UTF-8 bytes.
  const euroPayload = "€".repeat(65536);
  assert.equal(euroPayload.length, 65536);
  assert.equal(Buffer.byteLength(euroPayload, "utf8"), 65536 * 3);
  assert.equal(validatePayloadSize(euroPayload), false, "byte length, not code-unit length, must gate the guard");
  assert.equal(validatePayloadSize("x".repeat(65536)), true);
});

test("D2: root candidate must have message.type === 'question' AND envelope.kind === 'question'", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const fakeRoot = rootMessage(discussionId, policy, { type: "result" }); // envelope still claims kind: question

  const result = deriveDiscussion(discussionId, [fakeRoot], []);
  assert.equal(result.status, "invalid");
  assert.ok(result.integrity_findings.some((f) => f.code === "root_not_question" && f.message_id === fakeRoot.id));
});

test("D3: an invalid candidate at a head is excluded from admission AND does not block a separate, authorized valid candidate — but the discussion is still invalid overall", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  const badFleet = plainReply(discussionId, root, 2, "result", "f2");
  const withBadFleet: Message = { ...badFleet, from_agent_id: "agent-c" };
  const good = authorizeReply(discussionId, root, 2, "result");

  const result = deriveDiscussion(discussionId, [root, withBadFleet, good.message], good.receipts);
  assert.ok(result.integrity_findings.some((f) => f.code === "wrong_fleet" && f.message_id === withBadFleet.id));
  assert.ok(!result.integrity_findings.some((f) => f.code === "fork"), "one bad + one authorized-good is not a fork");
  assert.equal(result.head_message_id, good.message.id, "the authorized valid candidate must still advance the head");
  assert.equal(result.transcript.length, 2);
  assert.equal(result.status, "invalid", "cdx ruling: participant/fleet violations invalidate even alongside a good candidate");
});

test("D4: receipt action parsing extracts the real lifecycle state, not a value that can never match", () => {
  const parsed = parseReceiptAction("discussion.wake.completed.v1:3:a7");
  assert.ok(parsed);
  assert.equal(parsed?.kind, "wake");
  if (parsed?.kind === "wake") assert.equal(parsed.state, "completed");
  assert.equal(parsed?.turn, 3);
  assert.equal(parsed?.attempt_id, "a7");

  // End-to-end: a validly-noted reserved receipt followed by a validly-noted completed
  // receipt for the SAME attempt_id must resolve to state 'completed', not stay 'reserved'.
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  const r = authorizeReply(discussionId, root, 2, "result", { attemptId: "a7" });

  const result = deriveDiscussion(discussionId, [root, r.message], r.receipts);
  const attempt = result.attempts.find((a) => a.attempt_id === "a7");
  assert.ok(attempt);
  assert.equal(attempt?.state, "completed", "must reflect the terminal receipt, not default to 'reserved'");
  assert.equal(attempt?.reply_message_id, r.message.id);
});

test("D5: recomputeStatus implements the full fail-closed precedence chain (fixed clock throughout, no flaky Date.now())", () => {
  const policy = mkPolicy({ conversation_deadline: FIXED_NOW + 60_000, max_turns: 10 });
  const rootMessageId = "root-x";
  const base = { transcript: [], rootMessageId, attempts: [], policy, now: FIXED_NOW, turnsUsed: 1 };

  // invalid beats everything, including an explicit close.
  assert.equal(recomputeStatus({ ...base, invalid: true, transcript: [closedEntry(policy, "some-other-id")] }), "invalid");

  // closed beats deadman.
  assert.equal(
    recomputeStatus({
      ...base,
      invalid: false,
      transcript: [closedEntry(policy, "some-other-id")],
      attempts: [attemptWithState("deadman", FIXED_NOW + 1_000)],
    }),
    "closed"
  );
  // ... but the ROOT's own close is never authoritative.
  assert.equal(
    recomputeStatus({ ...base, invalid: false, transcript: [closedEntry(policy, rootMessageId)] }),
    "open"
  );

  // deadman beats expired.
  assert.equal(
    recomputeStatus({
      ...base,
      invalid: false,
      policy: mkPolicy({ conversation_deadline: FIXED_NOW - 1 }), // already expired
      attempts: [attemptWithState("deadman", FIXED_NOW + 1_000)],
    }),
    "deadman"
  );

  // expired beats exhausted.
  assert.equal(
    recomputeStatus({
      ...base,
      invalid: false,
      policy: mkPolicy({ conversation_deadline: FIXED_NOW - 1, max_turns: 2 }),
      attempts: [attemptWithState("completed", FIXED_NOW + 1_000, 5)], // would be "exhausted" if not expired
      turnsUsed: 2,
    }),
    "expired"
  );

  // exhausted beats active.
  assert.equal(
    recomputeStatus({
      ...base,
      invalid: false,
      policy: mkPolicy({ max_turns: 2 }),
      attempts: [attemptWithState("completed", FIXED_NOW + 1_000, 2), attemptWithState("reserved", FIXED_NOW + 60_000, 2)],
      turnsUsed: 3, // root + 2 distinct validated reservations
    }),
    "exhausted"
  );

  // exactly one live (unexpired reserved/started) attempt -> active.
  assert.equal(
    recomputeStatus({ ...base, invalid: false, attempts: [attemptWithState("reserved", FIXED_NOW + 60_000)] }),
    "active"
  );

  // nothing pending -> open.
  assert.equal(recomputeStatus({ ...base, invalid: false }), "open");
});

function closedEntry(policy: Policy, messageId: string) {
  const discussionId = "closed-disc";
  const payload = envelopeJson({
    discussionId,
    turn: 1,
    attemptId: "a1",
    replyTo: null,
    kind: "question",
    close: true,
    policy,
  });
  const message = mkMessage({
    id: messageId,
    type: "question",
    from: policy.participants[0],
    to: policy.participants[1],
    fleetId: "f1",
    payload,
    correlationId: discussionId,
  });
  return { turn: 1, message, receipts: [] };
}

function attemptWithState(state: "reserved" | "started" | "completed" | "failed" | "deadman", deadline: number, turn = 2) {
  return {
    attempt_id: nextId("attempt"),
    turn,
    agent_id: "agent-b",
    state,
    deadline,
  };
}

// ===========================================================================
// cdx author-review fixes (pass 1 + pass 2) + the "new bugs" extras
// ===========================================================================

test("Fix 1: a wake receipt with a malformed note is an integrity finding, never tolerated into an attempt", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  const reply = plainReply(discussionId, root, 2, "result");

  // note is missing head_message_id and deadline entirely.
  const badNoteReceipt = mkReceipt(root.id, root.to_agent_id, "discussion.wake.completed.v1:2:a1", JSON.stringify({ foo: "bar" }));
  const nonJsonNoteReceipt = mkReceipt(root.id, root.to_agent_id, "discussion.wake.reserved.v1:2:a2", "{not json");

  const result = deriveDiscussion(discussionId, [root, reply], [badNoteReceipt, nonJsonNoteReceipt]);
  assert.ok(result.integrity_findings.some((f) => f.code === "malformed_receipt_note" && f.message_id === root.id));
  assert.equal(result.integrity_findings.filter((f) => f.code === "malformed_receipt_note").length, 2);
  assert.equal(result.transcript.length, 1, "the reply must not be admitted off a malformed note");
  assert.equal(result.attempts.length, 0, "a malformed-note attempt is not surfaced as a usable attempt");
});

test("Fix 1a: a completed-only receipt (no 'reserved' lineage root) does not authorize anything", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  const attemptId = "only-completed";
  const reply = replyWithAttemptId(discussionId, root, 2, "result", attemptId);
  const completedOnly = wakeReceipt(root.id, root.to_agent_id, "completed", 2, attemptId, discussionId, FIXED_NOW + 30_000, reply.id);

  const result = deriveDiscussion(discussionId, [root, reply], [completedOnly]);
  assert.equal(result.transcript.length, 1, "a completed-only receipt must not admit the reply");
  assert.ok(result.integrity_findings.some((f) => f.code === "attempt_missing_reservation"));
  assert.equal(result.attempts.length, 0, "an unreserved attempt is not a validated attempt");
  assert.equal(result.turns_used, 1, "an unreserved attempt must not move the budget");
});

test("Fix 1b: conflicting deadlines across one attempt's own receipts is an identity conflict, order-independently — not a false deadman", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const attemptId = "conflicting-deadline";

  function build(order: "early-first" | "late-first") {
    const root = rootMessage(discussionId, policy);
    const early = wakeReceipt(root.id, root.to_agent_id, "reserved", 2, attemptId, discussionId, FIXED_NOW + 10_000);
    const late = wakeReceipt(root.id, root.to_agent_id, "reserved", 2, attemptId, discussionId, FIXED_NOW + 99_999);
    const receipts = order === "early-first" ? [early, late] : [late, early];
    return deriveDiscussion(discussionId, [root], receipts, FIXED_NOW + 50_000);
  }

  // If the deadline were resolved by "whichever receipt is seen last" (order-dependent),
  // one ordering would report a stranded/expired (deadline 10_000, already passed at
  // now=50_000) attempt while the other would report a healthy future one — an
  // order-dependent FALSE deadman. Both orderings must instead report the same thing:
  // an unresolvable identity conflict, deterministically.
  const a = build("early-first");
  const b = build("late-first");
  assert.ok(a.integrity_findings.some((f) => f.code === "attempt_identity_conflict"));
  assert.ok(b.integrity_findings.some((f) => f.code === "attempt_identity_conflict"));
  assert.equal(a.status, "invalid");
  assert.equal(b.status, "invalid");
  assert.equal(a.attempts.length, 0, "a conflicting attempt is not surfaced as a usable/validated attempt");
  assert.equal(b.attempts.length, 0);
});

test("Fix 1c: envelope.attempt_id must match the authorizing receipt's attempt id, even when turn and reply_message_id both match", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  const realAttemptId = "real-attempt";
  // The reply's OWN envelope claims a DIFFERENT attempt id than the one that actually reserved/completed.
  const reply = replyWithAttemptId(discussionId, root, 2, "result", "spoofed-attempt-id");
  const reserved = wakeReceipt(root.id, root.to_agent_id, "reserved", 2, realAttemptId, discussionId, FIXED_NOW + 30_000);
  const completed = wakeReceipt(root.id, root.to_agent_id, "completed", 2, realAttemptId, discussionId, FIXED_NOW + 30_000, reply.id);

  const result = deriveDiscussion(discussionId, [root, reply], [reserved, completed]);
  assert.equal(result.transcript.length, 1, "turn + reply_message_id matching alone must not admit the reply");
  assert.ok(result.integrity_findings.some((f) => f.code === "unauthorized_reply" && f.message_id === reply.id));
  // The underlying attempt is itself perfectly valid (just not bound to this reply's own claimed id) —
  // it still shows up as a validated attempt and still consumes budget.
  assert.ok(result.attempts.some((a) => a.attempt_id === realAttemptId && a.state === "completed"));
  assert.equal(result.turns_used, 2);
});

test("Fix 1d: a completion committed AFTER its deadline does not authorize admission", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  const attemptId = "late-attempt";
  const deadline = FIXED_NOW + 1_000;
  const reply = replyWithAttemptId(discussionId, root, 2, "result", attemptId);
  const reserved = wakeReceipt(root.id, root.to_agent_id, "reserved", 2, attemptId, discussionId, deadline);
  const lateCompleted = wakeReceipt(
    root.id,
    root.to_agent_id,
    "completed",
    2,
    attemptId,
    discussionId,
    deadline,
    reply.id,
    deadline + 5_000 // committed 5s AFTER the deadline
  );

  const now = deadline + 10_000; // also past the deadline by the time we look
  const result = deriveDiscussion(discussionId, [root, reply], [reserved, lateCompleted], now);
  assert.equal(result.transcript.length, 1, "a late completion must not admit the reply");
  assert.ok(result.integrity_findings.some((f) => f.code === "late_completion"));
  // The attempt falls back to its last ON-TIME signal (reserved), which is now a
  // stranded/expired reservation — status should reflect that (deadman), not pretend
  // nothing happened.
  assert.equal(result.status, "deadman");
});

test("Fix 2: a structurally perfect reply with ZERO backing receipts is never admitted", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  const receiptless = plainReply(discussionId, root, 2, "result");

  const result = deriveDiscussion(discussionId, [root, receiptless], []);
  assert.equal(result.transcript.length, 1, "receiptless reply must not be canonized");
  assert.equal(result.head_message_id, root.id);
  assert.ok(result.integrity_findings.some((f) => f.code === "unauthorized_reply" && f.message_id === receiptless.id));
  assert.notEqual(result.status, "invalid", "a merely-unauthorized reply (no receipt at all) is not itself corruption");
});

test("Fix 2b: a gap in the RESERVATION sequence itself (a turn never reserved at all) is an ordinal_discontinuity, fail-closed invalid", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy({ max_turns: 8 });
  const root = rootMessage(discussionId, policy);
  const r2 = authorizeReply(discussionId, root, 2, "result");
  // Turn 3 is never reserved at all (contrast with Spec #14, where it WAS reserved then
  // failed) — turn 4 replies straight to turn 2, the real head.
  const r4 = authorizeReply(discussionId, r2.message, 4, "question");

  const result = deriveDiscussion(discussionId, [root, r2.message, r4.message], [...r2.receipts, ...r4.receipts]);
  assert.ok(result.integrity_findings.some((f) => f.code === "ordinal_discontinuity"));
  assert.equal(result.status, "invalid");
});

test("Fix 3a: attempt-identity conflict — same attempt_id bound to a different head across its own receipts", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  const r2 = authorizeReply(discussionId, root, 2, "result");

  // Reuse attempt id "reused" first on root as head, then again on r2.message as head.
  const attemptId = "reused";
  const onRoot = wakeReceipt(root.id, root.to_agent_id, "reserved", 5, attemptId, discussionId, FIXED_NOW + 30_000);
  const onR2 = wakeReceipt(r2.message.id, r2.message.to_agent_id, "reserved", 5, attemptId, discussionId, FIXED_NOW + 30_000);

  const result = deriveDiscussion(discussionId, [root, r2.message], [...r2.receipts, onRoot, onR2]);
  assert.ok(result.integrity_findings.some((f) => f.code === "attempt_identity_conflict"));
  assert.equal(result.status, "invalid");
});

test("Fix 3b: attempt-identity conflict — same attempt_id completes with two different reply_message_id values", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  const attemptId = "dual-complete";
  const replyA = plainReply(discussionId, root, 2, "result");
  const replyB = plainReply(discussionId, root, 2, "result");

  const reserved = wakeReceipt(root.id, root.to_agent_id, "reserved", 2, attemptId, discussionId, FIXED_NOW + 30_000);
  const completedA = wakeReceipt(root.id, root.to_agent_id, "completed", 2, attemptId, discussionId, FIXED_NOW + 30_000, replyA.id);
  const completedB = wakeReceipt(root.id, root.to_agent_id, "completed", 2, attemptId, discussionId, FIXED_NOW + 30_000, replyB.id);

  const result = deriveDiscussion(discussionId, [root, replyA, replyB], [reserved, completedA, completedB]);
  assert.ok(result.integrity_findings.some((f) => f.code === "attempt_identity_conflict"));
  assert.equal(result.status, "invalid");
});

test("Fix 3c: multiple simultaneously-live attempts make recomputeStatus fail-closed invalid, not 'open'", () => {
  const policy = mkPolicy();
  const result = recomputeStatus({
    invalid: false,
    transcript: [],
    rootMessageId: "root-x",
    attempts: [attemptWithState("reserved", FIXED_NOW + 60_000), attemptWithState("started", FIXED_NOW + 60_000)],
    policy,
    now: FIXED_NOW,
    turnsUsed: 1,
  });
  assert.equal(result, "invalid");
});

test("Fix 3d: a mix of one expired-stranded and one future-live attempt is ALSO invalid, not 'deadman'", () => {
  const policy = mkPolicy({ conversation_deadline: FIXED_NOW + 120_000 });
  const result = recomputeStatus({
    invalid: false,
    transcript: [],
    rootMessageId: "root-x",
    attempts: [attemptWithState("reserved", FIXED_NOW - 1), attemptWithState("started", FIXED_NOW + 60_000)],
    policy,
    now: FIXED_NOW,
    turnsUsed: 1,
  });
  assert.equal(result, "invalid", "two live attempts violate 'at most one active' regardless of individual expiry");
});

test("Fix 3e: a participant/fleet violation on a message with NO connection to the canonical chain still invalidates", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  // Wrong fleet AND reply_to references a message id that never exists anywhere —
  // this candidate is never a bucket member for ANY head the walk ever visits.
  const disconnected = plainReply(discussionId, root, 5, "result", "f2");
  const disconnectedPayload = JSON.parse(disconnected.payload) as Record<string, unknown>;
  disconnectedPayload.reply_to = "totally-unrelated-message-id";
  const trulyDisconnected: Message = { ...disconnected, payload: JSON.stringify(disconnectedPayload) };

  const result = deriveDiscussion(discussionId, [root, trulyDisconnected], []);
  assert.ok(result.integrity_findings.some((f) => f.code === "wrong_fleet" && f.message_id === trulyDisconnected.id));
  assert.equal(
    result.status,
    "invalid",
    "the violation invalidates even though this message was never a live-head candidate at all"
  );
});

// ===========================================================================
// cdx pass-3: two reproduced blockers
// ===========================================================================

test("P3-1: a rejected root-shaped candidate from a foreign fleet/agent still invalidates (root-shaped masquerade)", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);

  // A second turn:1/reply_to:null candidate: type/kind both 'question' (so it does NOT
  // trip root_not_question), but has NO policy block at all — it fails root selection via
  // root_missing_policy and is therefore never a "second root" (no duplicate_root path).
  // It is ALSO on a completely foreign fleet, from/to agents that are not this discussion's
  // participants at all. A prior revision excluded every root-shaped candidate from the
  // global fleet/participant pass, so this message walked away with only the (relatively
  // benign-sounding) `root_missing_policy` finding and the discussion reported `open`.
  const fakeRootPayload = envelopeJson({
    discussionId,
    turn: 1,
    attemptId: nextId("attempt"),
    replyTo: null,
    kind: "question",
    // no policy
  });
  const fakeRoot = mkMessage({
    id: nextId("fake-root"),
    type: "question",
    from: "agent-x",
    to: "agent-y",
    fleetId: "f-evil",
    payload: fakeRootPayload,
    correlationId: discussionId,
  });

  const result = deriveDiscussion(discussionId, [root, fakeRoot], []);
  const fakeRootFindings = result.integrity_findings.filter((f) => f.message_id === fakeRoot.id);
  assert.ok(fakeRootFindings.some((f) => f.code === "root_missing_policy"));
  assert.ok(fakeRootFindings.some((f) => f.code === "wrong_fleet"), "the foreign fleet must still be caught");
  assert.ok(fakeRootFindings.some((f) => f.code === "participant_violation"), "the foreign agents must still be caught");
  assert.ok(
    !fakeRootFindings.some((f) => f.code === "kind_type_mismatch"),
    "kind_type_mismatch would just restate root_not_question's own type/kind check — must not double-label"
  );
  assert.equal(result.status, "invalid", "a foreign-fleet/foreign-agent masquerade must not leave the discussion 'open'");
});

test("P3-2: a receipt bound to a non-validated (legacy/malformed) message is excluded, not authorized (receipt_on_invalid_head)", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);

  // A legacy/malformed correlated message — same shape as Spec #6's foreign traffic —
  // never passes envelope validation, so it's never in `valid`.
  const legacy = mkMessage({
    id: nextId("legacy"),
    type: "question",
    from: "agent-a",
    to: "agent-b",
    fleetId: "f1",
    payload: JSON.stringify({ old_format: true }),
    correlationId: discussionId,
  });
  // A perfectly well-formed reservation receipt, physically attached to that legacy message,
  // with an agent matching the legacy message's own (raw) recipient.
  const reservedOnLegacy = wakeReceipt(legacy.id, "agent-b", "reserved", 2, "legacy-attempt", discussionId, FIXED_NOW + 60_000);

  const result = deriveDiscussion(discussionId, [root, legacy], [reservedOnLegacy], FIXED_NOW);
  assert.ok(
    result.integrity_findings.some((f) => f.code === "receipt_on_invalid_head" && f.message_id === legacy.id),
    "the receipt must be flagged, not silently accepted"
  );
  assert.equal(result.attempts.length, 0, "an attempt bound to an invalid head is never a validated attempt");
  assert.equal(result.turns_used, 1, "must not move the budget");
  assert.equal(result.status, "open", "must not report 'active' off a reservation bound to garbage data");
});

test("P3-3: a receipt bound to a valid-but-UNREACHABLE envelope (an orphan) is excluded, not authorized", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);

  // The orphan is a perfectly well-formed discussion/v1 envelope — correct fleet,
  // correct participants, correct kind/type — its ONLY problem is that reply_to
  // points at a message id that never exists anywhere, so the canonical walk from
  // the root never reaches it. §11 (wake_agent): "Valid only for a resident
  // participant who is the recipient of the CANONICAL HEAD" — a structurally
  // valid-but-unreachable envelope is not the canonical head no matter how
  // well-formed it (or a receipt bound to it) looks in isolation.
  const orphan = replyWithAttemptId(discussionId, root, 2, "result", "orphan-envelope-attempt");
  const orphanPayload = JSON.parse(orphan.payload) as Record<string, unknown>;
  orphanPayload.reply_to = "totally-nonexistent-message-id";
  const trulyOrphaned: Message = { ...orphan, payload: JSON.stringify(orphanPayload) };

  // One perfectly well-formed reservation, bound to the orphan as its head.
  const reservedOnOrphan = wakeReceipt(
    trulyOrphaned.id,
    trulyOrphaned.to_agent_id,
    "reserved",
    2,
    "orphan-reservation",
    discussionId,
    FIXED_NOW + 60_000
  );

  const result = deriveDiscussion(discussionId, [root, trulyOrphaned], [reservedOnOrphan], FIXED_NOW);
  assert.equal(result.head_message_id, root.id, "canonical head must stay at root — the orphan was never admitted");
  assert.equal(result.attempts.length, 0, "an attempt bound to an unreachable head is never a validated attempt");
  assert.equal(result.turns_used, 1, "must not move the budget off a reservation bound to an orphan");
  assert.equal(result.status, "open", "must not report 'active' off a reservation bound to an unreachable envelope");
  assert.ok(
    result.integrity_findings.some((f) => f.code === "receipt_on_invalid_head" && f.message_id === trulyOrphaned.id),
    "the receipt must be flagged as bound to a non-canonical head"
  );
});

test("P3-4: a completed turn-4 attempt bound directly to root must not advance the walk before the discontinuity check fires", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy({ max_turns: 8 });
  const root = rootMessage(discussionId, policy);

  // A fully well-formed, fully authorized (matching reply id, turn, AND attempt id)
  // completed attempt — EXCEPT it claims turn 4 directly off root (currentTurn=1),
  // with NO reservation ever made for turns 2 or 3 at this head. Under the prior
  // design this was admitted immediately (the walk only consulted
  // completedByHead/authorization, not turn continuity), THEN a post-walk
  // discontinuity check flipped status to invalid — too late: transcript, head,
  // attempts, and turns_used had already been built from the illegitimate winner.
  const reply4 = authorizeReply(discussionId, root, 4, "result");

  const result = deriveDiscussion(discussionId, [root, reply4.message], reply4.receipts, FIXED_NOW);

  assert.equal(result.status, "invalid");
  assert.equal(result.head_message_id, root.id, "canonical head must NOT advance to the discontinuous reply");
  assert.deepEqual(
    result.transcript.map((e) => e.turn),
    [1],
    "transcript must contain ONLY the root — no provisionally-canonical descendant"
  );
  assert.equal(
    result.attempts.length,
    0,
    "the discontinuous attempt must be excluded from the validated-attempts output entirely"
  );
  assert.equal(result.turns_used, 1, "budget must not move for an attempt that never legitimately advanced");
  assert.ok(
    result.integrity_findings.some(
      (f) => f.code === "ordinal_discontinuity" && f.message_id === root.id && f.detail.includes(reply4.attemptId)
    ),
    "the inline gate must name the exact head and the specific rejected attempt"
  );
});

test("Fix 4a: root policy bounds are enforced — max_turns > 32 and turn_timeout_ms outside 1s..5m reject the envelope", () => {
  const discussionId = nextId("disc");
  const overMaxTurns = JSON.stringify({
    $meshfleet: "discussion/v1",
    discussion_id: discussionId,
    turn: 1,
    attempt_id: "a1",
    reply_to: null,
    kind: "question",
    body: "b",
    close: false,
    policy: { participants: ["agent-a", "agent-b"], max_turns: 33, conversation_deadline: FIXED_NOW + 60_000, turn_timeout_ms: 30_000 },
  });
  assert.equal(parseEnvelope(overMaxTurns), null, "max_turns=33 exceeds the 2..32 bound");

  const tooShortTimeout = JSON.stringify({
    $meshfleet: "discussion/v1",
    discussion_id: discussionId,
    turn: 1,
    attempt_id: "a1",
    reply_to: null,
    kind: "question",
    body: "b",
    close: false,
    policy: { participants: ["agent-a", "agent-b"], max_turns: 6, conversation_deadline: FIXED_NOW + 60_000, turn_timeout_ms: 999 },
  });
  assert.equal(parseEnvelope(tooShortTimeout), null, "turn_timeout_ms=999 is under the 1s floor");

  const tooLongTimeout = JSON.stringify({
    $meshfleet: "discussion/v1",
    discussion_id: discussionId,
    turn: 1,
    attempt_id: "a1",
    reply_to: null,
    kind: "question",
    body: "b",
    close: false,
    policy: {
      participants: ["agent-a", "agent-b"],
      max_turns: 6,
      conversation_deadline: FIXED_NOW + 60_000,
      turn_timeout_ms: 300_001,
    },
  });
  assert.equal(parseEnvelope(tooLongTimeout), null, "turn_timeout_ms=300001 is over the 5m ceiling");
});

test("Fix 4b: a non-root envelope carrying a policy block is rejected and invalidates the discussion", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  const r2 = authorizeReply(discussionId, root, 2, "result");

  // Tamper: re-serialize r2's message with a policy block attached (turn=2, not the root).
  const tamperedPayload = JSON.stringify({ ...JSON.parse(r2.message.payload), policy });
  const tampered: Message = { ...r2.message, payload: tamperedPayload };

  const result = deriveDiscussion(discussionId, [root, tampered], r2.receipts);
  assert.ok(result.integrity_findings.some((f) => f.code === "child_policy_forbidden" && f.message_id === tampered.id));
  assert.equal(result.status, "invalid");
});

test("Fix 4c: root close:true is a finding, and root envelope.kind mismatch is caught even when message.type is 'question'", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const closedRoot = rootMessage(discussionId, policy, { close: true });
  const result = deriveDiscussion(discussionId, [closedRoot], []);
  assert.ok(result.integrity_findings.some((f) => f.code === "root_close_forbidden" && f.message_id === closedRoot.id));
  assert.notEqual(result.status, "closed", "the root's own close must never be authoritative");
  assert.notEqual(result.status, "invalid", "root_close_forbidden is a finding, not itself an invalidating condition");

  const kindMismatchRoot = rootMessage(discussionId, policy, { kind: "result" }); // message.type stays 'question'
  const result2 = deriveDiscussion(discussionId, [kindMismatchRoot], []);
  assert.equal(result2.status, "invalid");
  assert.ok(result2.integrity_findings.some((f) => f.code === "root_not_question" && f.message_id === kindMismatchRoot.id));
});

test("Fix 4d: an oversized correlated payload is rejected during derivation, not just at the original send", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const oversizedPayload = JSON.stringify({
    $meshfleet: "discussion/v1",
    discussion_id: discussionId,
    turn: 1,
    attempt_id: "a1",
    reply_to: null,
    kind: "question",
    body: "x".repeat(70_000),
    close: false,
    policy,
  });
  const oversized = mkMessage({
    id: nextId("oversized"),
    type: "question",
    from: "agent-a",
    to: "agent-b",
    fleetId: "f1",
    payload: oversizedPayload,
    correlationId: discussionId,
  });

  const result = deriveDiscussion(discussionId, [oversized], []);
  assert.equal(result.status, "invalid"); // excluded from `valid` -> no root found
  assert.ok(result.integrity_findings.some((f) => f.code === "payload_too_large" && f.message_id === oversized.id));
});

test("Fix 5a: turns_used is driven by validated attempts, not a raw/forged envelope.turn", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy({ max_turns: 20 });
  const root = rootMessage(discussionId, policy);

  // A validly-authorized attempt whose REAL (receipt-sourced) turn is 2 ...
  const attemptId = "a1";
  const forgedReply = plainReply(discussionId, root, 99, "result"); // envelope claims turn 99!
  const reserved = wakeReceipt(root.id, root.to_agent_id, "reserved", 2, attemptId, discussionId, FIXED_NOW + 30_000);
  const completed = wakeReceipt(root.id, root.to_agent_id, "completed", 2, attemptId, discussionId, FIXED_NOW + 30_000, forgedReply.id);

  const result = deriveDiscussion(discussionId, [root, forgedReply], [reserved, completed]);
  // The forged reply is never admitted: its claimed turn (99) doesn't match the
  // attempt's real turn (2), so no authorization match is found.
  assert.equal(result.transcript.length, 1);
  assert.ok(result.integrity_findings.some((f) => f.code === "unauthorized_reply" && f.message_id === forgedReply.id));
  assert.equal(result.turns_used, 2, "budget reflects the validated attempt's real turn, never the forged 99");
});

test("Fix 5b: an attempt beyond max_turns is rejected — turns_used caps at budget, turns_remaining clamps at zero", () => {
  // cdx pass-6: this test previously BLESSED over-budget reservations (asserted
  // turns_used=5 against a max_turns=3 policy, with no finding at all) — inverted
  // here to assert the correct behavior: rejection, not accumulation.
  const discussionId = nextId("disc");
  const policy = mkPolicy({ max_turns: 3 });
  const root = rootMessage(discussionId, policy);
  // Two in-budget, fully-authorized reservations (turns 2,3) followed by a THIRD,
  // otherwise-perfectly-authorized one (turn 4) that exceeds the budget.
  const r2 = authorizeReply(discussionId, root, 2, "result");
  const r3 = authorizeReply(discussionId, r2.message, 3, "question");
  const r4 = authorizeReply(discussionId, r3.message, 4, "result");
  // ...and a further reply chained off the rejected one, which must never even be reached.
  const r5 = authorizeReply(discussionId, r4.message, 5, "question");

  const result = deriveDiscussion(
    discussionId,
    [root, r2.message, r3.message, r4.message, r5.message],
    [...r2.receipts, ...r3.receipts, ...r4.receipts, ...r5.receipts],
    FIXED_NOW
  );
  assert.equal(result.turns_used, 3, "root (1) + only the 2 in-budget reservations");
  assert.equal(result.turns_remaining, 0, "must clamp at 0, not go negative");
  assert.equal(result.head_message_id, r3.message.id, "the walk must not advance past the over-budget attempt");
  assert.deepEqual(result.attempts.map((a) => a.turn).sort(), [2, 3]);
  assert.ok(
    result.integrity_findings.some((f) => f.code === "attempt_beyond_budget" && f.detail.includes(r4.attemptId)),
    "the over-budget attempt must be flagged, not silently accepted"
  );
  assert.notEqual(result.status, "invalid", "budget overflow excludes the attempt; it does not corrupt the aggregate");
  assert.equal(result.status, "exhausted");
});

test("P3-5a: a tail of validated FAILED reservations beyond max_turns is capped, each overflow flagged individually", () => {
  // cdx's exact repro shape: max_turns 3, validated failed reservations for turns
  // 2 through 6, all bound to root (a straight failed-reservation tail — nobody
  // ever successfully replied). Previously: turns_used 6, attempts [2..6], status
  // 'exhausted', and ZERO integrity findings about the overflow.
  const discussionId = nextId("disc");
  const policy = mkPolicy({ max_turns: 3 });
  const root = rootMessage(discussionId, policy);
  const allReceipts = [2, 3, 4, 5, 6].flatMap((t) => failedAttempt(discussionId, root, t));

  const result = deriveDiscussion(discussionId, [root], allReceipts, FIXED_NOW);

  assert.equal(result.status, "exhausted");
  assert.equal(result.turns_used, 3, "root (1) + only turns 2 and 3 — 4/5/6 are beyond budget");
  assert.deepEqual(result.attempts.map((a) => a.turn).sort(), [2, 3]);
  for (const overflowTurn of [4, 5, 6]) {
    assert.ok(
      result.integrity_findings.some(
        (f) => f.code === "attempt_beyond_budget" && f.detail.includes(`turn ${overflowTurn}`)
      ),
      `turn ${overflowTurn} must get its own overflow finding`
    );
  }
});

test("P3-5b: a validated DEADMAN terminates registration immediately — it is NOT a continuity filler, unlike failed (cdx pass-7 correction of a pass-6 misreading)", () => {
  // Same raw shape as the old (WRONG) version of this test — deadman receipts
  // for turns 2 through 6, all bound to root — but the spec is unambiguous
  // that deadman is discussion-terminal (§12 rule 3, §14 "close the discussion
  // fail-closed"), not attempt-local like a failed reservation. So turn 2
  // (in-budget, deadman) is registered and then everything stops: turn 3
  // (also in-budget) is never reached — it was never legitimately reachable
  // once the discussion died at turn 2 — while turns 4-6 (over budget
  // regardless) still get their own independent overflow findings via the
  // unconditional budget pass, which runs no matter where the walk stopped.
  const discussionId = nextId("disc");
  const policy = mkPolicy({ max_turns: 3 });
  const root = rootMessage(discussionId, policy);
  const deadline = FIXED_NOW + 30_000;
  const allReceipts = [2, 3, 4, 5, 6].flatMap((t) => [
    wakeReceipt(root.id, root.to_agent_id, "reserved", t, `deadman-attempt-${t}`, discussionId, deadline),
    wakeReceipt(root.id, root.to_agent_id, "deadman", t, `deadman-attempt-${t}`, discussionId, deadline),
  ]);

  const result = deriveDiscussion(discussionId, [root], allReceipts, FIXED_NOW);

  assert.equal(result.status, "deadman");
  assert.equal(result.turns_used, 2, "root (1) + only turn 2 — the deadman that ended the discussion");
  assert.deepEqual(result.attempts.map((a) => ({ turn: a.turn, state: a.state })), [{ turn: 2, state: "deadman" }]);
  assert.ok(
    result.integrity_findings.some(
      (f) => f.code === "receipt_on_invalid_head" && f.detail.includes("deadman-attempt-3")
    ),
    "turn 3 (in-budget, but never reached past the deadman) must be flagged, not silently dropped"
  );
  for (const overflowTurn of [4, 5, 6]) {
    assert.ok(
      result.integrity_findings.some(
        (f) => f.code === "attempt_beyond_budget" && f.detail.includes(`turn ${overflowTurn}`)
      ),
      `turn ${overflowTurn} must still get its own overflow finding, independent of where the walk stopped`
    );
  }
});

test("P3-5c: a fully-authorized COMPLETED reply beyond max_turns is rejected, not admitted", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy({ max_turns: 3 });
  const root = rootMessage(discussionId, policy);
  // A single, otherwise-perfect completed attempt (matching reply id, turn, AND
  // attempt id — every authorization check passes) claiming turn 5 directly off
  // root, with no reservations for 2/3/4 at all.
  const reply5 = authorizeReply(discussionId, root, 5, "result");

  const result = deriveDiscussion(discussionId, [root, reply5.message], reply5.receipts, FIXED_NOW);

  assert.equal(result.head_message_id, root.id, "the over-budget completed reply must not advance the head");
  assert.deepEqual(result.transcript.map((e) => e.turn), [1]);
  assert.equal(result.attempts.length, 0);
  assert.equal(result.turns_used, 1);
  assert.ok(
    result.integrity_findings.some((f) => f.code === "attempt_beyond_budget" && f.detail.includes(reply5.attemptId))
  );
  assert.notEqual(result.status, "invalid");
});

test("P3-6: cdx's exact repro — a validated deadman at turn 2 must terminate the walk, even with a fully-authorized completed turn 3 waiting behind it", () => {
  // §12 rule 3 ranks deadman above expired/exhausted; §13 "terminal states never
  // reopen"; §14 is explicit: "Deadman: terminate the child, write deadman,
  // close the discussion fail-closed." A prior reading treated deadman as just
  // another gap-filler (like failed) — cdx reproduced deadman-turn-2 followed by
  // a legitimately completed turn-3 advancing the walk anyway (transcript [1,3],
  // head advanced, no finding at all). Corrected: the discussion ends at the
  // deadman; turn 3 is never reached no matter how well-formed it is.
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  const deadline = FIXED_NOW + 30_000;
  const deadmanAttemptId = "dm2";
  const deadmanReceipts = [
    wakeReceipt(root.id, root.to_agent_id, "reserved", 2, deadmanAttemptId, discussionId, deadline),
    wakeReceipt(root.id, root.to_agent_id, "deadman", 2, deadmanAttemptId, discussionId, deadline),
  ];
  // A separate, fully-authorized completed attempt for turn 3 — reservation,
  // completion, matching reply message, everything checks out on its own.
  const reply3 = authorizeReply(discussionId, root, 3, "result");

  const result = deriveDiscussion(
    discussionId,
    [root, reply3.message],
    [...deadmanReceipts, ...reply3.receipts],
    FIXED_NOW
  );

  assert.equal(result.status, "deadman");
  assert.equal(result.head_message_id, root.id, "the head must NOT advance to the turn-3 reply");
  assert.deepEqual(result.transcript.map((e) => e.turn), [1], "transcript must contain ONLY the root");
  assert.deepEqual(
    result.attempts.map((a) => ({ turn: a.turn, state: a.state })),
    [{ turn: 2, state: "deadman" }],
    "only the deadman attempt is canonical — turn 3 must not appear"
  );
  assert.equal(result.turns_used, 2, "root (1) + the deadman turn — turn 3 never legitimately happened");
  assert.ok(
    result.integrity_findings.some((f) => f.detail.includes(reply3.attemptId)),
    "turn-3 material must be flagged (unreachable/rejected), not silently vanish"
  );
  assert.notEqual(result.status, "invalid", "a deadman is an ordinary spec-sanctioned terminal outcome, not corruption");
});

test("P3-7: a lone over-budget FAILED attempt gets attempt_beyond_budget regardless of where continuity scanning stops", () => {
  // cdx's exact repro: max_turns 3, a single validated failed reservation at
  // turn 5, with NOTHING reserved for turns 2-4 at all. The turn-by-turn
  // continuity scan (registerContiguousTail) naturally stops at the first
  // missing turn (2) — a normal, non-error stopping condition — long before
  // it would ever reach turn 5 to check its budget. Previously this meant the
  // attempt got only the generic `receipt_on_invalid_head` fallback instead of
  // the specific `attempt_beyond_budget` finding. Fixed by evaluating the
  // budget bound on every validated attempt unconditionally, independent of
  // reachability or continuity.
  const discussionId = nextId("disc");
  const policy = mkPolicy({ max_turns: 3 });
  const root = rootMessage(discussionId, policy);
  const loneFailedReceipts = failedAttempt(discussionId, root, 5, "lone-failed-5");

  const result = deriveDiscussion(discussionId, [root], loneFailedReceipts, FIXED_NOW);

  assert.equal(result.turns_used, 1, "the over-budget attempt must not move the budget");
  assert.equal(result.attempts.length, 0);
  assert.ok(
    result.integrity_findings.some(
      (f) => f.code === "attempt_beyond_budget" && f.detail.includes("lone-failed-5")
    ),
    "the specific overflow finding must fire even though continuity scanning never reaches turn 5"
  );
  assert.ok(
    !result.integrity_findings.some((f) => f.code === "receipt_on_invalid_head"),
    "attempt_beyond_budget already fully explains the exclusion — the generic fallback must not ALSO fire for the same attempt"
  );
  assert.notEqual(result.status, "invalid");
});

test("P3-8: deadman at turn 2 blocks EVERYTHING after it — a subsequent failed filler and completed winner both fail to register or admit", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy({ max_turns: 8 });
  const root = rootMessage(discussionId, policy);
  const deadline = FIXED_NOW + 30_000;

  const deadmanReceipts = [
    wakeReceipt(root.id, root.to_agent_id, "reserved", 2, "dm2", discussionId, deadline),
    wakeReceipt(root.id, root.to_agent_id, "deadman", 2, "dm2", discussionId, deadline),
  ];
  // A failed reservation at turn 3 — exactly the kind of entry that WOULD
  // legitimately fill a gap if turn 2 had been failed instead of deadman.
  const failedReceipts = [
    wakeReceipt(root.id, root.to_agent_id, "reserved", 3, "f3", discussionId, deadline),
    wakeReceipt(root.id, root.to_agent_id, "failed", 3, "f3", discussionId, deadline),
  ];
  // A fully-authorized completed attempt at turn 4 — structurally perfect on its own.
  const reply4 = authorizeReply(discussionId, root, 4, "result");

  const result = deriveDiscussion(
    discussionId,
    [root, reply4.message],
    [...deadmanReceipts, ...failedReceipts, ...reply4.receipts],
    FIXED_NOW
  );

  assert.equal(result.status, "deadman");
  assert.equal(result.head_message_id, root.id, "head must stay at root — neither turn 3 nor turn 4 is ever reached");
  assert.deepEqual(result.transcript.map((e) => e.turn), [1]);
  assert.deepEqual(
    result.attempts.map((a) => ({ turn: a.turn, state: a.state })),
    [{ turn: 2, state: "deadman" }],
    "ONLY the deadman is canonical — neither the failed filler nor the completed winner registers"
  );
  assert.equal(result.turns_used, 2);
  assert.ok(
    result.integrity_findings.some((f) => f.detail.includes("f3")),
    "the would-be filler at turn 3 must be flagged, not silently dropped"
  );
  assert.ok(
    result.integrity_findings.some((f) => f.detail.includes(reply4.attemptId)),
    "the would-be winner at turn 4 must be flagged, not silently dropped"
  );
  assert.notEqual(result.status, "invalid");
});

test("P3-9: a malformed duplicate claiming the SAME turn as a legitimate deadman still elevates status to invalid (documented, not accidental)", () => {
  // Pins the deliberate interaction documented at the deadman-termination site
  // in discussion.ts: a deadman is an ordinary terminal outcome and reports
  // `deadman` on its own (see P3-6/P3-8) — but it is not a "free pass". If the
  // SAME ledger ALSO contains a second, distinct attempt claiming the
  // deadman's own turn (a duplicate ordinal — exactly the kind of corruption
  // §12 rule 1 already treats as invalidating), the post-walk duplicate-turn
  // check still runs (it is not short-circuited by reaching a deadman) and
  // `invalid` outranks `deadman` in the precedence — by ORDINARY precedence,
  // not by any special-casing of deadman in this codebase.
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  const deadline = FIXED_NOW + 30_000;

  const deadmanReceipts = [
    wakeReceipt(root.id, root.to_agent_id, "reserved", 2, "dm2", discussionId, deadline),
    wakeReceipt(root.id, root.to_agent_id, "deadman", 2, "dm2", discussionId, deadline),
  ];
  // A second, distinct attempt ALSO claiming turn 2 — a genuine duplicate ordinal.
  const duplicateReceipts = [
    wakeReceipt(root.id, root.to_agent_id, "reserved", 2, "dup2", discussionId, deadline),
    wakeReceipt(root.id, root.to_agent_id, "failed", 2, "dup2", discussionId, deadline),
  ];

  const result = deriveDiscussion(discussionId, [root], [...deadmanReceipts, ...duplicateReceipts], FIXED_NOW);

  assert.equal(result.status, "invalid", "the duplicate ordinal must win precedence over the otherwise-legitimate deadman");
  assert.ok(result.integrity_findings.some((f) => f.code === "duplicate_turn" && f.detail.includes("dm2")));
  assert.ok(result.integrity_findings.some((f) => f.code === "duplicate_turn" && f.detail.includes("dup2")));
});

test("Fix 6: close only takes effect via an authorized valid reply, and canonical traversal stops there", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  const closer = authorizeReply(discussionId, root, 2, "result", { close: true });
  // A further, otherwise-valid authorized reply exists past the close point.
  const afterClose = authorizeReply(discussionId, closer.message, 3, "question");

  const result = deriveDiscussion(
    discussionId,
    [root, closer.message, afterClose.message],
    [...closer.receipts, ...afterClose.receipts]
  );

  assert.equal(result.status, "closed");
  assert.equal(result.head_message_id, closer.message.id, "traversal must stop AT the closing reply");
  assert.equal(result.transcript.length, 2);
  assert.ok(
    result.integrity_findings.some((f) => f.code === "unreachable_envelope" && f.message_id === afterClose.message.id),
    "the reply past the close point is never consulted, so it's reported orphaned rather than silently dropped"
  );
});

test("Fix 7 / extra: expired (unswept) reserved/started attempts surface as 'deadman', not 'open'", () => {
  const policy = mkPolicy({ conversation_deadline: FIXED_NOW + 120_000 });
  const result = recomputeStatus({
    invalid: false,
    transcript: [],
    rootMessageId: "root-x",
    attempts: [attemptWithState("reserved", FIXED_NOW - 1)], // deadline already passed, never swept to deadman
    policy,
    now: FIXED_NOW,
    turnsUsed: 1,
  });
  assert.equal(result, "deadman");

  // deadman still wins over expired even when BOTH the attempt and the conversation deadline have passed.
  const bothExpired = recomputeStatus({
    invalid: false,
    transcript: [],
    rootMessageId: "root-x",
    attempts: [attemptWithState("started", FIXED_NOW - 1)],
    policy: mkPolicy({ conversation_deadline: FIXED_NOW - 1 }),
    now: FIXED_NOW,
    turnsUsed: 1,
  });
  assert.equal(bothExpired, "deadman");
});

test("Extra: an orphaned envelope that never reconnects to the canonical chain gets an integrity finding, not silence", () => {
  const discussionId = nextId("disc");
  const policy = mkPolicy();
  const root = rootMessage(discussionId, policy);
  const badFleet = plainReply(discussionId, root, 2, "result", "f2");
  const withBadFleet: Message = { ...badFleet, from_agent_id: "agent-c" };
  // grandchild replies to badFleet, which never becomes canonical head. grandchild's OWN
  // fleet/participants/kind are all valid — its only problem is that its parent never
  // reaches the walk, so grandchild itself is never even considered. It must not just vanish.
  const grandchild = mkMessage({
    id: nextId("msg"),
    type: "question",
    from: "agent-a",
    to: "agent-b",
    fleetId: "f1",
    payload: envelopeJson({
      discussionId,
      turn: 3,
      attemptId: nextId("envattempt"),
      replyTo: withBadFleet.id,
      kind: "question",
    }),
    correlationId: discussionId,
  });

  const result = deriveDiscussion(discussionId, [root, withBadFleet, grandchild], []);
  assert.ok(
    result.integrity_findings.some((f) => f.code === "unreachable_envelope" && f.message_id === grandchild.id)
  );
  assert.ok(
    !result.integrity_findings.some((f) => f.message_id === grandchild.id && f.code !== "unreachable_envelope"),
    "grandchild's own fleet/participants/kind are fine — unreachable_envelope should be its ONLY finding"
  );
});
