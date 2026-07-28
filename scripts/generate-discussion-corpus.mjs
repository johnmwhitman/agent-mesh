/**
 * Generates discussion-integrity falsification vectors for the tampered-ledger corpus.
 *
 * Each vector is expressed as ops against the shared baseline — the corpus test enforces
 * minimality (fixture === baseline + ops). The generator applies ops to the baseline,
 * writes the fixture file, runs the real verifier, and captures expected_findings.
 *
 * Run: node scripts/generate-discussion-corpus.mjs
 */
import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyMeshData } from "../dist/verify.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(ROOT, "..", "test/fixtures/corpus");
const MANIFEST_PATH = join(CORPUS_DIR, "manifest.json");

const baseline = JSON.parse(readFileSync(join(CORPUS_DIR, "baseline.json"), "utf8"));
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const NOW = manifest.now;

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

function applyOps(data, ops) {
  for (const { op, path, value } of ops) {
    const parts = path.split("|");
    const last = parts.pop();
    let node = data;
    for (const p of parts) node = node[p];
    if (op === "set") node[last] = value;
    else if (op === "delete") delete node[last];
    else if (op === "push") node[last].push(value);
  }
}

function normalize(findings) {
  return findings
    .map(f => ({ severity: f.severity, check: f.check, subject: f.subject }))
    .sort((a, b) => `${a.check}${a.subject}`.localeCompare(`${b.check}${b.subject}`));
}

function makeEnvelope(overrides = {}) {
  return JSON.stringify({
    $meshfleet: "discussion/v1",
    discussion_id: "disc-1",
    turn: 1,
    attempt_id: "att-1",
    reply_to: null,
    kind: "question",
    body: "hello",
    close: false,
    ...overrides,
  });
}

const POLICY = {
  participants: ["a1", "a2"],
  max_turns: 4,
  conversation_deadline: NOW + 50000,
  turn_timeout_ms: 30000,
};

const results = [];

function add(id, primary, classification, lie, ops) {
  const data = deepClone(baseline);
  applyOps(data, ops);

  const report = verifyMeshData(data, NOW);
  const findings = normalize(report.findings);
  const matching = findings.filter(f => f.check === primary);

  if (matching.length === 0) {
    console.error(`FAIL: ${id} — expected ${primary} but got: ${findings.map(f => f.check).join(", ") || "none"}`);
    return;
  }

  writeFileSync(join(CORPUS_DIR, `${id}.json`), JSON.stringify(data, null, 2) + "\n");

  results.push({
    id, primary, classification, lie, ops,
    expected_ok: report.ok,
    expected_findings: findings,
  });

  console.log(`  ${id}: ${primary} (${classification}) — ${matching.length} match(es), ${findings.length} total`);
}

console.log("Generating discussion falsification vectors...\n");

const ROOT_PAYLOAD = makeEnvelope({ policy: POLICY });

// 1. no_valid_root — discussion/v1 envelope with no valid root
add("discussion-no-valid-root", "discussion.no_valid_root", "caught",
  "messages carrying discussion/v1 envelopes exist but none qualifies as a valid root",
  [
    { op: "set", path: "messages|d-m1", value: {
      id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
      type: "result", payload: makeEnvelope({ turn: 2, reply_to: "nonexistent" }),
      correlation_id: "disc-1", timestamp: NOW - 1000, acknowledged: false,
    }},
  ]);

// 2. duplicate_root — two valid roots
add("discussion-duplicate-root", "discussion.duplicate_root", "caught",
  "two messages both qualify as valid discussion roots for the same correlation id",
  [
    { op: "set", path: "messages|d-m1", value: {
      id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
      type: "question", payload: ROOT_PAYLOAD,
      correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
    }},
    { op: "set", path: "messages|d-m2", value: {
      id: "d-m2", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
      type: "question", payload: ROOT_PAYLOAD,
      correlation_id: "disc-1", timestamp: NOW - 1999, acknowledged: false,
    }},
  ]);

// 3. child_policy_forbidden
add("discussion-child-policy-forbidden", "discussion.child_policy_forbidden", "caught",
  "a non-root envelope carries a policy block — only the root may define the immutable policy",
  [
    { op: "set", path: "messages|d-m1", value: {
      id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
      type: "question", payload: ROOT_PAYLOAD,
      correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
    }},
    { op: "set", path: "messages|d-m2", value: {
      id: "d-m2", from_agent_id: "a2", to_agent_id: "a1", fleet_id: "f1",
      type: "result", payload: makeEnvelope({
        turn: 2, attempt_id: "att-2", reply_to: "d-m1", kind: "result",
        policy: POLICY,
      }),
      correlation_id: "disc-1", timestamp: NOW - 1000, acknowledged: false,
    }},
  ]);

// 4. wrong_fleet
add("discussion-wrong-fleet", "discussion.wrong_fleet", "caught",
  "a discussion envelope is carried by a message in a different fleet than the root",
  [
    { op: "set", path: "messages|d-m1", value: {
      id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
      type: "question", payload: ROOT_PAYLOAD,
      correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
    }},
    { op: "set", path: "messages|d-m2", value: {
      id: "d-m2", from_agent_id: "a2", to_agent_id: "a1", fleet_id: "f-other",
      type: "result", payload: makeEnvelope({
        turn: 2, attempt_id: "att-2", reply_to: "d-m1", kind: "result",
      }),
      correlation_id: "disc-1", timestamp: NOW - 1000, acknowledged: false,
    }},
  ]);

// 5. participant_violation
add("discussion-participant-violation", "discussion.participant_violation", "caught",
  "a discussion message involves an agent not in the policy's two-participant set",
  [
    { op: "set", path: "messages|d-m1", value: {
      id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
      type: "question", payload: ROOT_PAYLOAD,
      correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
    }},
    { op: "set", path: "messages|d-m2", value: {
      id: "d-m2", from_agent_id: "a3", to_agent_id: "a1", fleet_id: "f1",
      type: "result", payload: makeEnvelope({
        turn: 2, attempt_id: "att-2", reply_to: "d-m1", kind: "result",
      }),
      correlation_id: "disc-1", timestamp: NOW - 1000, acknowledged: false,
    }},
  ]);

// 6. kind_type_mismatch
add("discussion-kind-type-mismatch", "discussion.kind_type_mismatch", "caught",
  "the envelope kind disagrees with the message type",
  [
    { op: "set", path: "messages|d-m1", value: {
      id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
      type: "question", payload: ROOT_PAYLOAD,
      correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
    }},
    { op: "set", path: "messages|d-m2", value: {
      id: "d-m2", from_agent_id: "a2", to_agent_id: "a1", fleet_id: "f1",
      type: "result", payload: makeEnvelope({
        turn: 2, attempt_id: "att-2", reply_to: "d-m1", kind: "question",
      }),
      correlation_id: "disc-1", timestamp: NOW - 1000, acknowledged: false,
    }},
  ]);

// 7. broadcast_forbidden
add("discussion-broadcast-forbidden", "discussion.broadcast_forbidden", "caught",
  "a discussion/v1 envelope is smuggled via a broadcast message",
  [
    { op: "set", path: "messages|d-m1", value: {
      id: "d-m1", from_agent_id: "a1", to_agent_id: "*", fleet_id: "f1",
      type: "question", payload: ROOT_PAYLOAD,
      correlation_id: "disc-1", timestamp: NOW - 1000, acknowledged: false,
    }},
  ]);

// 8. invalid_sender (alternation violation)
{
  const wakeNote = { discussion_id: "disc-1", head_message_id: "d-m1", deadline: NOW + 30000 };
  add("discussion-invalid-sender", "discussion.invalid_sender", "caught",
    "a reply does not alternate sender and recipient",
    [
      { op: "set", path: "messages|d-m1", value: {
        id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
        type: "question", payload: ROOT_PAYLOAD,
        correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
      }},
      { op: "set", path: "messages|d-m2", value: {
        id: "d-m2", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
        type: "result", payload: makeEnvelope({
          turn: 2, attempt_id: "att-2", reply_to: "d-m1", kind: "result",
        }),
        correlation_id: "disc-1", timestamp: NOW - 800, acknowledged: false,
      }},
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.reserved.v1:2:att-2", value: {
        id: "d-m1:a2:discussion.wake.reserved.v1:2:att-2",
        agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.reserved.v1:2:att-2",
        note: JSON.stringify(wakeNote), timestamp: NOW - 1000,
      }},
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.completed.v1:2:att-2", value: {
        id: "d-m1:a2:discussion.wake.completed.v1:2:att-2",
        agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.completed.v1:2:att-2",
        note: JSON.stringify({ ...wakeNote, reply_message_id: "d-m2" }), timestamp: NOW - 800,
      }},
    ]);
}

// 9. attempt_identity_conflict
{
  const wakeNote1 = { discussion_id: "disc-1", head_message_id: "d-m1", deadline: NOW + 30000 };
  const wakeNote2 = { discussion_id: "disc-1", head_message_id: "d-m1", deadline: NOW + 25000 };
  add("discussion-attempt-identity-conflict", "discussion.attempt_identity_conflict", "caught",
    "receipts within a single attempt lifecycle disagree on an immutable field",
    [
      { op: "set", path: "messages|d-m1", value: {
        id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
        type: "question", payload: ROOT_PAYLOAD,
        correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
      }},
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.reserved.v1:2:att-2", value: {
        id: "d-m1:a2:discussion.wake.reserved.v1:2:att-2",
        agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.reserved.v1:2:att-2",
        note: JSON.stringify(wakeNote1), timestamp: NOW - 1000,
      }},
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.started.v1:2:att-2", value: {
        id: "d-m1:a2:discussion.wake.started.v1:2:att-2",
        agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.started.v1:2:att-2",
        note: JSON.stringify(wakeNote2), timestamp: NOW - 900,
      }},
    ]);
}

// 10. duplicate_turn
{
  const wakeNote = { discussion_id: "disc-1", head_message_id: "d-m1", deadline: NOW + 30000 };
  add("discussion-duplicate-turn", "discussion.duplicate_turn", "caught",
    "two distinct attempt ids both reserve the same turn number at the same head",
    [
      { op: "set", path: "messages|d-m1", value: {
        id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
        type: "question", payload: ROOT_PAYLOAD,
        correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
      }},
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.reserved.v1:2:att-A", value: {
        id: "d-m1:a2:discussion.wake.reserved.v1:2:att-A",
        agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.reserved.v1:2:att-A",
        note: JSON.stringify(wakeNote), timestamp: NOW - 1000,
      }},
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.reserved.v1:2:att-B", value: {
        id: "d-m1:a2:discussion.wake.reserved.v1:2:att-B",
        agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.reserved.v1:2:att-B",
        note: JSON.stringify(wakeNote), timestamp: NOW - 999,
      }},
    ]);
}

// 11. fork
{
  const wakeNote = { discussion_id: "disc-1", head_message_id: "d-m1", deadline: NOW + 30000 };
  add("discussion-fork", "discussion.fork", "caught",
    "two authorized replies target the same head — the discussion chain forks",
    [
      { op: "set", path: "messages|d-m1", value: {
        id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
        type: "question", payload: ROOT_PAYLOAD,
        correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
      }},
      { op: "set", path: "messages|d-m2a", value: {
        id: "d-m2a", from_agent_id: "a2", to_agent_id: "a1", fleet_id: "f1",
        type: "result", payload: makeEnvelope({ turn: 2, attempt_id: "att-2a", reply_to: "d-m1", kind: "result" }),
        correlation_id: "disc-1", timestamp: NOW - 800, acknowledged: false,
      }},
      { op: "set", path: "messages|d-m2b", value: {
        id: "d-m2b", from_agent_id: "a2", to_agent_id: "a1", fleet_id: "f1",
        type: "result", payload: makeEnvelope({ turn: 2, attempt_id: "att-2b", reply_to: "d-m1", kind: "result" }),
        correlation_id: "disc-1", timestamp: NOW - 799, acknowledged: false,
      }},
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.reserved.v1:2:att-2a", value: {
        id: "d-m1:a2:discussion.wake.reserved.v1:2:att-2a", agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.reserved.v1:2:att-2a",
        note: JSON.stringify(wakeNote), timestamp: NOW - 1000,
      }},
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.completed.v1:2:att-2a", value: {
        id: "d-m1:a2:discussion.wake.completed.v1:2:att-2a", agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.completed.v1:2:att-2a",
        note: JSON.stringify({ ...wakeNote, reply_message_id: "d-m2a" }), timestamp: NOW - 800,
      }},
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.reserved.v1:2:att-2b", value: {
        id: "d-m1:a2:discussion.wake.reserved.v1:2:att-2b", agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.reserved.v1:2:att-2b",
        note: JSON.stringify(wakeNote), timestamp: NOW - 999,
      }},
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.completed.v1:2:att-2b", value: {
        id: "d-m1:a2:discussion.wake.completed.v1:2:att-2b", agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.completed.v1:2:att-2b",
        note: JSON.stringify({ ...wakeNote, reply_message_id: "d-m2b" }), timestamp: NOW - 799,
      }},
    ]);
}

// 12. ordinal_discontinuity
{
  const wakeNote = { discussion_id: "disc-1", head_message_id: "d-m1", deadline: NOW + 30000 };
  add("discussion-ordinal-discontinuity", "discussion.ordinal_discontinuity", "caught",
    "a reply claims a turn that skips over unreserved turns",
    [
      { op: "set", path: "messages|d-m1", value: {
        id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
        type: "question", payload: ROOT_PAYLOAD,
        correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
      }},
      { op: "set", path: "messages|d-m3", value: {
        id: "d-m3", from_agent_id: "a2", to_agent_id: "a1", fleet_id: "f1",
        type: "result", payload: makeEnvelope({ turn: 3, attempt_id: "att-3", reply_to: "d-m1", kind: "result" }),
        correlation_id: "disc-1", timestamp: NOW - 800, acknowledged: false,
      }},
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.reserved.v1:3:att-3", value: {
        id: "d-m1:a2:discussion.wake.reserved.v1:3:att-3", agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.reserved.v1:3:att-3",
        note: JSON.stringify(wakeNote), timestamp: NOW - 1000,
      }},
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.completed.v1:3:att-3", value: {
        id: "d-m1:a2:discussion.wake.completed.v1:3:att-3", agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.completed.v1:3:att-3",
        note: JSON.stringify({ ...wakeNote, reply_message_id: "d-m3" }), timestamp: NOW - 800,
      }},
    ]);
}

console.log(`\nGenerated ${results.length} vectors`);

// Update manifest
const existingIds = new Set(manifest.vectors.map(v => v.id));
for (const r of results) {
  if (existingIds.has(r.id)) {
    const idx = manifest.vectors.findIndex(v => v.id === r.id);
    manifest.vectors[idx] = r;
  } else {
    manifest.vectors.push(r);
  }
}

writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Manifest updated: ${manifest.vectors.length} total vectors`);
