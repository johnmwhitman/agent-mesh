/**
 * Generates the discussion-derivation corpus by running the REAL TypeScript
 * implementation (src/discussion.ts) against hand-crafted scenarios and
 * recording the output as ground truth.
 *
 * Run: node blackbox/a2a-discussion-v0.1/generate-corpus.mjs
 * Output: blackbox/a2a-discussion-v0.1/corpus/v0.1/cases.json
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveDiscussion, parseEnvelope, parseReceiptAction } from "../../dist/discussion.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, "corpus/v0.1/cases.json");
const PROFILE = "meshfleet.a2a.discussion-derivation.v0.1";

function makeEnvelope(overrides = {}) {
  return JSON.stringify({
    $meshfleet: "discussion/v1",
    discussion_id: "d1",
    turn: 1,
    attempt_id: "a1",
    reply_to: null,
    kind: "question",
    body: "hello",
    close: false,
    ...overrides,
  });
}

function msg(id, from, to, fleet, type, payload, corr, ts = 1000) {
  return {
    id, from_agent_id: from, to_agent_id: to, fleet_id: fleet,
    type, payload, correlation_id: corr, timestamp: ts,
    acknowledged: false, recipients: undefined,
  };
}

function receipt(agentId, messageId, action, note = undefined, ts = 1100) {
  return {
    id: `${messageId}:${agentId}:${action}`,
    agent_id: agentId, message_id: messageId,
    action, note: note ? JSON.stringify(note) : undefined,
    timestamp: ts,
  };
}

function project(derived) {
  return {
    status: derived.status,
    turns_used: derived.turns_used,
    turns_remaining: derived.turns_remaining,
    transcript_length: derived.transcript.length,
    attempts_count: derived.attempts.length,
    integrity_finding_codes: derived.integrity_findings.map(f => f.code).sort(),
  };
}

const NOW = 50000;
const DEADLINE = 60000;
const cases = [];

function add(id, description, input, expected_output) {
  cases.push({ id, description, input, expected_output });
}

// -- Case 1: minimal valid discussion (root only, open)
{
  const rootPayload = makeEnvelope({
    policy: { participants: ["alice", "bob"], max_turns: 4, conversation_deadline: DEADLINE, turn_timeout_ms: 30000 },
  });
  const msgs = [msg("m1", "alice", "bob", "f1", "question", rootPayload, "d1", 900)];
  const result = deriveDiscussion("d1", msgs, [], NOW);
  add("minimal-open", "Single root message, no receipts — status open", {
    discussion_id: "d1", messages: msgs, receipts: [], now: NOW,
  }, project(result));
}

// -- Case 2: no correlated messages
{
  const result = deriveDiscussion("d1", [], [], NOW);
  add("no-messages", "Empty message set — no valid root", {
    discussion_id: "d1", messages: [], receipts: [], now: NOW,
  }, project(result));
}

// -- Case 3: non-discussion payload (not valid JSON envelope)
{
  const msgs = [msg("m1", "alice", "bob", "f1", "question", "plain text", "d1")];
  const result = deriveDiscussion("d1", msgs, [], NOW);
  add("non-envelope-payload", "Message payload is not a discussion/v1 envelope", {
    discussion_id: "d1", messages: msgs, receipts: [], now: NOW,
  }, project(result));
}

// -- Case 4: wrong version string
{
  const badPayload = JSON.stringify({
    $meshfleet: "discussion/v2", discussion_id: "d1", turn: 1, attempt_id: "a1",
    reply_to: null, kind: "question", body: "hello", close: false,
    policy: { participants: ["alice", "bob"], max_turns: 4, conversation_deadline: DEADLINE, turn_timeout_ms: 30000 },
  });
  const msgs = [msg("m1", "alice", "bob", "f1", "question", badPayload, "d1")];
  const result = deriveDiscussion("d1", msgs, [], NOW);
  add("wrong-version", "Envelope has discussion/v2 instead of discussion/v1", {
    discussion_id: "d1", messages: msgs, receipts: [], now: NOW,
  }, project(result));
}

// -- Case 5: duplicate roots
{
  const rootPayload = makeEnvelope({
    policy: { participants: ["alice", "bob"], max_turns: 4, conversation_deadline: DEADLINE, turn_timeout_ms: 30000 },
  });
  const msgs = [
    msg("m1", "alice", "bob", "f1", "question", rootPayload, "d1", 900),
    msg("m2", "alice", "bob", "f1", "question", rootPayload, "d1", 901),
  ];
  const result = deriveDiscussion("d1", msgs, [], NOW);
  add("duplicate-roots", "Two valid root messages — invalid", {
    discussion_id: "d1", messages: msgs, receipts: [], now: NOW,
  }, project(result));
}

// -- Case 6: root with close=true (finding but not invalidating)
{
  const rootPayload = makeEnvelope({
    close: true,
    policy: { participants: ["alice", "bob"], max_turns: 4, conversation_deadline: DEADLINE, turn_timeout_ms: 30000 },
  });
  const msgs = [msg("m1", "alice", "bob", "f1", "question", rootPayload, "d1")];
  const result = deriveDiscussion("d1", msgs, [], NOW);
  add("root-close-true", "Root envelope sets close=true — finding but discussion remains valid", {
    discussion_id: "d1", messages: msgs, receipts: [], now: NOW,
  }, project(result));
}

// -- Case 7: child envelope carrying a policy block (invalidating)
{
  const rootPayload = makeEnvelope({
    policy: { participants: ["alice", "bob"], max_turns: 4, conversation_deadline: DEADLINE, turn_timeout_ms: 30000 },
  });
  const childPayload = makeEnvelope({
    turn: 2, attempt_id: "a2", reply_to: "m1", kind: "result",
    policy: { participants: ["alice", "bob"], max_turns: 4, conversation_deadline: DEADLINE, turn_timeout_ms: 30000 },
  });
  const msgs = [
    msg("m1", "alice", "bob", "f1", "question", rootPayload, "d1", 900),
    msg("m2", "bob", "alice", "f1", "result", childPayload, "d1", 1000),
  ];
  const result = deriveDiscussion("d1", msgs, [], NOW);
  add("child-policy-forbidden", "Child envelope carries a policy block — invalidating", {
    discussion_id: "d1", messages: msgs, receipts: [], now: NOW,
  }, project(result));
}

// -- Case 8: correlation_id mismatch
{
  const rootPayload = makeEnvelope({
    discussion_id: "d1",
    policy: { participants: ["alice", "bob"], max_turns: 4, conversation_deadline: DEADLINE, turn_timeout_ms: 30000 },
  });
  const msgs = [msg("m1", "alice", "bob", "f1", "question", rootPayload, "other_correlation")];
  const result = deriveDiscussion("d1", msgs, [], NOW);
  add("correlation-mismatch", "Message correlation_id does not match envelope discussion_id", {
    discussion_id: "d1", messages: msgs, receipts: [], now: NOW,
  }, project(result));
}

// -- Case 9: participant mismatch (root participants != message from/to)
{
  const rootPayload = makeEnvelope({
    policy: { participants: ["alice", "charlie"], max_turns: 4, conversation_deadline: DEADLINE, turn_timeout_ms: 30000 },
  });
  const msgs = [msg("m1", "alice", "bob", "f1", "question", rootPayload, "d1")];
  const result = deriveDiscussion("d1", msgs, [], NOW);
  add("participant-mismatch", "Root policy participants don't match message from/to", {
    discussion_id: "d1", messages: msgs, receipts: [], now: NOW,
  }, project(result));
}

// -- Case 10: expired discussion (past deadline with no activity)
{
  const rootPayload = makeEnvelope({
    policy: { participants: ["alice", "bob"], max_turns: 4, conversation_deadline: 2000, turn_timeout_ms: 30000 },
  });
  const msgs = [msg("m1", "alice", "bob", "f1", "question", rootPayload, "d1", 900)];
  const result = deriveDiscussion("d1", msgs, [], NOW);
  add("expired-deadline", "Discussion past conversation_deadline — status expired", {
    discussion_id: "d1", messages: msgs, receipts: [], now: NOW,
  }, project(result));
}

// -- Case 11: root missing policy block
{
  const rootPayload = makeEnvelope({});
  const msgs = [msg("m1", "alice", "bob", "f1", "question", rootPayload, "d1")];
  const result = deriveDiscussion("d1", msgs, [], NOW);
  add("root-missing-policy", "Root envelope has no policy block — no valid root", {
    discussion_id: "d1", messages: msgs, receipts: [], now: NOW,
  }, project(result));
}

// -- Case 12: root type mismatch (message.type != 'question')
{
  const rootPayload = makeEnvelope({
    policy: { participants: ["alice", "bob"], max_turns: 4, conversation_deadline: DEADLINE, turn_timeout_ms: 30000 },
  });
  const msgs = [msg("m1", "alice", "bob", "f1", "result", rootPayload, "d1")];
  const result = deriveDiscussion("d1", msgs, [], NOW);
  add("root-type-mismatch", "Root message type is 'result' not 'question'", {
    discussion_id: "d1", messages: msgs, receipts: [], now: NOW,
  }, project(result));
}

// -- Case 13: broadcast message (forbidden)
{
  const rootPayload = makeEnvelope({
    policy: { participants: ["alice", "bob"], max_turns: 4, conversation_deadline: DEADLINE, turn_timeout_ms: 30000 },
  });
  const msgs = [msg("m1", "alice", "*", "f1", "question", rootPayload, "d1")];
  const result = deriveDiscussion("d1", msgs, [], NOW);
  add("broadcast-forbidden", "Broadcast message — discussion/v1 is direct only", {
    discussion_id: "d1", messages: msgs, receipts: [], now: NOW,
  }, project(result));
}

// -- Case 14: max_turns out of bounds (1, below minimum 2)
{
  const rootPayload = makeEnvelope({
    policy: { participants: ["alice", "bob"], max_turns: 1, conversation_deadline: DEADLINE, turn_timeout_ms: 30000 },
  });
  const msgs = [msg("m1", "alice", "bob", "f1", "question", rootPayload, "d1")];
  const result = deriveDiscussion("d1", msgs, [], NOW);
  add("max-turns-below-minimum", "Policy max_turns=1 below minimum 2 — envelope rejected", {
    discussion_id: "d1", messages: msgs, receipts: [], now: NOW,
  }, project(result));
}

// -- Case 15: parseReceiptAction valid wake reserved
{
  const parsed = parseReceiptAction("discussion.wake.reserved.v1:1:attempt-1");
  add("parse-receipt-wake-reserved", "Parse a valid wake reserved receipt action", {
    action: "discussion.wake.reserved.v1:1:attempt-1",
  }, parsed ? { kind: parsed.kind, state: parsed.state, turn: parsed.turn, attempt_id: parsed.attempt_id } : null);
}

// -- Case 16: parseReceiptAction invalid format
{
  const parsed = parseReceiptAction("discussion.wake.reserved:1:attempt-1");
  add("parse-receipt-no-version", "Receipt action missing v1 suffix — only 3 dot parts", {
    action: "discussion.wake.reserved:1:attempt-1",
  }, parsed);
}

// -- Case 17: parseEnvelope valid
{
  const payload = makeEnvelope({ body: "test body" });
  const parsed = parseEnvelope(payload);
  add("parse-envelope-valid", "Parse a valid discussion/v1 envelope", {
    payload,
  }, parsed ? {
    discussion_id: parsed.discussion_id, turn: parsed.turn, kind: parsed.kind,
    close: parsed.close, has_policy: parsed.policy !== undefined,
  } : null);
}

// -- Case 18: parseEnvelope missing required field
{
  const parsed = parseEnvelope(JSON.stringify({ $meshfleet: "discussion/v1", discussion_id: "d1" }));
  add("parse-envelope-incomplete", "Envelope missing turn, attempt_id, reply_to, kind, body, close", {
    payload: JSON.stringify({ $meshfleet: "discussion/v1", discussion_id: "d1" }),
  }, parsed);
}

// Write corpus
const corpus = {
  schema_version: "0.1",
  profile: PROFILE,
  generated_by: "generate-corpus.mjs",
  generated_from: "src/discussion.ts (TypeScript reference implementation)",
  cases,
};

writeFileSync(OUT, JSON.stringify(corpus, null, 2) + "\n");
console.log(`Wrote ${cases.length} cases to ${OUT}`);
