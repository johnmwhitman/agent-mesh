/**
 * Generates the tampered-ledger corpus: a clean baseline plus one declarative
 * delta per vector. Run: npx tsx scripts/generate-corpus.ts
 *
 * This is the canonical, single command for regenerating every committed
 * tampered-ledger vector under `test/fixtures/corpus/`, including the
 * `discussion.*` family. There is intentionally no second writer.
 *
 * Deltas are DECLARATIVE (op/path/value) so the harness can prove each tampered
 * ledger differs from the baseline in exactly the declared paths — minimality is
 * machine-checked, not author-asserted. That is what makes the baseline a valid
 * near-neighbour control for every vector.
 *
 * Three safety gates sit in front of the writes:
 *
 *   1. Inventory gate (fail-closed, GIT-INDEX BACKED). The committed
 *      `test/fixtures/corpus/manifest.json` is read straight from
 *      `git show HEAD:test/fixtures/corpus/manifest.json`, never from the
 *      working tree. A subsequent edit that narrows V[] (or a partial run that
 *      deletes the on-disk manifest) cannot disable this gate, because the
 *      gate targets the committed state, not what's on disk. When the
 *      manifest is tracked, every committed vector id must appear in V[].
 *      When it isn't tracked (a fresh tree), the generator refuses rather
 *      than silently scaffolding a smaller corpus.
 *
 *   2. Authored-invariant gate (fail-closed, ATOMIC). Every fixture and the
 *      manifest are first materialised under a sibling `corpus.staging-<pid>`
 *      directory and verified in isolation. Only on full success are they
 *      renamed into place. A failure mid-run, an OS-level interrupt, or an
 *      invariant mismatch leaves the corpus directory byte-identical to its
 *      pre-run state — there is no window where partial or invalid output
 *      is observable from the corpus directory.
 *
 *   3. Authored-finding gate (per-vector). `caught` vectors must produce
 *      their check at `error` severity with `ok: false`; `anomaly` vectors
 *      must produce their check at `warning`; `undetectable` vectors
 *      must produce zero findings. Failing any of these exits 1 before
 *      the staging directory is renamed into place.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, renameSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { verifyMeshData } from "../src/verify.js";
import { loadDataFromFile } from "../src/core.js";

const NOW = 1_800_000_000_000;
const T0 = 1_700_000_000_000;
const OUT = join(import.meta.dirname, "..", "test", "fixtures", "corpus");

const BASELINE = {
  schema_version: 2,
  fleets: { f1: { id: "f1", status: "complete", created_at: T0, completed_at: T0 + 9000 } },
  agents: {
    a1: { id: "a1", fleet_id: "f1", role: "Proposer", prompt: "p", status: "complete", started_at: T0 + 10, completed_at: T0 + 8000 },
    a2: { id: "a2", fleet_id: "f1", role: "Reviewer", prompt: "p", status: "complete", started_at: T0 + 10, completed_at: T0 + 8000 },
    a3: { id: "a3", fleet_id: "f1", role: "Engineer", prompt: "p", status: "complete", started_at: T0 + 10, completed_at: T0 + 8000 },
  },
  messages: {
    m1: { id: "m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1", type: "handoff", payload: "review the migration", timestamp: T0 + 100, acknowledged: true },
    m2: { id: "m2", from_agent_id: "a1", to_agent_id: "*", fleet_id: "f1", type: "alert", payload: "PROPOSAL: ship the migration", timestamp: T0 + 200, acknowledged: true, recipients: ["a2", "a3"] },
  },
  inboxes: { a1: [] as string[], a2: [] as string[], a3: [] as string[] },
  capabilities: {},
  receipts: {
    "m1:a2:ack": { message_id: "m1", agent_id: "a2", action: "ack", timestamp: T0 + 150 },
    "m2:a2:ack": { message_id: "m2", agent_id: "a2", action: "ack", timestamp: T0 + 250 },
    "m2:a3:ack": { message_id: "m2", agent_id: "a3", action: "ack", timestamp: T0 + 260 },
    "m2:a2:r-ack": { message_id: "m2", agent_id: "a2", action: "r-ack", timestamp: T0 + 300 },
    "m2:a3:r-ack": { message_id: "m2", agent_id: "a3", action: "r-ack", timestamp: T0 + 310 },
  },
  ratifications: {
    m2: { message_id: "m2", proposer: "a1", fleet_id: "f1", subject: "ship the migration", quorum: 2, voters: ["a2", "a3"], required_signoffs: [] as string[], opened_at: T0 + 200, silence_policy: "abstain", status: "ratified", resolved_at: T0 + 320 },
  },
  templates: {},
};

type Op = { op: "set" | "delete" | "push"; path: string; value?: unknown };
type Vector = {
  id: string;
  /** The check this vector EXISTS to pin. Authored, never snapshotted. */
  primary: string;
  /** caught = overclaim, must be error + ok:false. anomaly = warning-only, ok stays true.
   *  undetectable = the free core structurally cannot see it; must produce ZERO findings. */
  classification: "caught" | "anomaly" | "undetectable";
  /** What a reader of the tampered ledger would wrongly believe. */
  lie: string;
  ops: Op[];
};

function applyOps(data: any, ops: Op[]): void {
  for (const { op, path, value } of ops) {
    const parts = path.split("|");
    const last = parts.pop() as string;
    let node = data;
    for (const p of parts) node = node[p];
    if (op === "set") node[last] = value;
    else if (op === "delete") delete node[last];
    else if (op === "push") node[last].push(value);
  }
}

// Discussion family helpers — kept inline here so the canonical generator
// stays self-contained (no dist build dependency). The harness applies the
// same `applyOps` workflow as every other vector; the envelope payloads are
// constructed by hand to match what a live discussion/v1 exchange would
// produce under the same NOW anchor.
//
// The discussion/v1 family is emitted dynamically by `verifyMeshData` (via
// `deriveDiscussion`) as `discussion.<code>` checks. The COVERAGE assertion
// in `test/corpus.test.ts` separately unions those from
// `DISCUSSION_ERROR_CODES`, so the discussion vectors do not need to be in
// `src/verify.ts`'s hand-maintained emit list to be recognised as coverage.
function makeEnv(overrides: Record<string, unknown> = {}): string {
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

const DISCUSSION_POLICY = {
  participants: ["a1", "a2"],
  max_turns: 4,
  conversation_deadline: NOW + 50000,
  turn_timeout_ms: 30000,
};
const DISCUSSION_ROOT = makeEnv({ policy: DISCUSSION_POLICY });

const V: Vector[] = [
  // ===================== CAUGHT: overclaims (error, ok:false) =====================
  { id: "agent-invalid-started-at", primary: "agent.invalid_timestamp", classification: "caught",
    lie: "an agent start time is present but not a finite number, so its lifecycle ordering cannot be audited",
    ops: [{ op: "set", path: "agents|a2|started_at", value: null }] },
  { id: "agent-invalid-completed-at", primary: "agent.invalid_timestamp", classification: "caught",
    lie: "an agent completion time is present but not a finite number, so its terminal state cannot be ordered",
    ops: [{ op: "set", path: "agents|a2|completed_at", value: null }] },
  { id: "agent-tampered-timestamp", primary: "agent.tampered_timestamp", classification: "caught",
    lie: "an agent is on record as having started before the fleet that spawned it existed",
    ops: [{ op: "set", path: "agents|a2|started_at", value: T0 - 5000 }] },
  { id: "agent-completed-before-started", primary: "agent.tampered_timestamp", classification: "caught",
    lie: "an agent finished before it started — a duration fabricated from an impossible interval",
    ops: [{ op: "set", path: "agents|a2|completed_at", value: T0 + 5 }] },
  { id: "agent-completed-before-fleet", primary: "agent.tampered_timestamp", classification: "caught",
    lie: "an agent is on record as having completed before the fleet that spawned it existed",
    ops: [
      { op: "delete", path: "agents|a2|started_at" },
      { op: "set", path: "agents|a2|completed_at", value: T0 - 5000 },
    ] },
  { id: "inbox-dangling-message", primary: "inbox.dangling_message", classification: "caught",
    lie: "an agent's queue names a work item that does not exist anywhere in the ledger",
    ops: [{ op: "push", path: "inboxes|a2", value: "m-ghost" }] },
  { id: "inbox-acked-still-queued", primary: "inbox.acked_still_queued", classification: "caught",
    lie: "a message is simultaneously acknowledged and still pending — two contradictory states of the same delivery",
    ops: [{ op: "push", path: "inboxes|a2", value: "m1" }] },
  { id: "message-ack-overclaim", primary: "message.ack_flag_mismatch", classification: "caught",
    lie: "the message claims it was acknowledged while no recipient receipt supports it — the headline overclaim",
    ops: [{ op: "delete", path: "receipts|m1:a2:ack" }] },
  { id: "message-invalid-timestamp", primary: "message.invalid_timestamp", classification: "caught",
    lie: "a message carries a non-finite timestamp, so every ordering claim involving it is unfalsifiable",
    ops: [{ op: "set", path: "messages|m1|timestamp", value: null }] },
  { id: "message-tampered-timestamp", primary: "message.tampered_timestamp", classification: "caught",
    lie: "a message predates the fleet it was sent in",
    ops: [{ op: "set", path: "messages|m1|timestamp", value: T0 - 1000 }] },
  { id: "receipt-orphan-message", primary: "receipt.orphan_message", classification: "caught",
    lie: "a receipt attests to acknowledging a message that never existed",
    ops: [{ op: "set", path: "receipts|m-ghost:a2:ack", value: { message_id: "m-ghost", agent_id: "a2", action: "ack", timestamp: T0 + 400 } }] },
  { id: "receipt-before-message", primary: "receipt.before_message", classification: "caught",
    lie: "an agent acknowledged a message before that message was sent",
    ops: [{ op: "set", path: "receipts|m1:a2:ack|timestamp", value: T0 + 50 }] },
  { id: "receipt-invalid-timestamp", primary: "receipt.invalid_timestamp", classification: "caught",
    lie: "a receipt's time is non-finite, so it can never be shown to be out of order",
    ops: [{ op: "set", path: "receipts|m1:a2:ack|timestamp", value: null }] },
  { id: "receipt-key-mismatch", primary: "receipt.key_mismatch", classification: "caught",
    lie: "the receipt's key attributes the ack to a3 while its body attributes it to a2 — attribution smuggling past the idempotency guarantee",
    ops: [{ op: "set", path: "receipts|m1:a3:ack", value: { message_id: "m1", agent_id: "a2", action: "ack", timestamp: T0 + 150 } }] },
  { id: "receipt-missing-agent-id", primary: "receipt.missing_agent_id", classification: "caught",
    lie: "a receipt asserts an acknowledgement with no identifiable acknowledger",
    ops: [{ op: "set", path: "receipts|m1:x:ack", value: { message_id: "m1", action: "ack", timestamp: T0 + 150 } }] },
  { id: "receipt-missing-action", primary: "receipt.missing_action", classification: "caught",
    lie: "a receipt records that something happened without recording what happened",
    ops: [{ op: "set", path: "receipts|m1:a2:x", value: { message_id: "m1", agent_id: "a2", timestamp: T0 + 150 } }] },
  { id: "receipt-non-recipient-ack", primary: "receipt.non_recipient_ack", classification: "caught",
    lie: "a3 is on record as having acknowledged a message addressed only to a2 — an ack asserting a delivery that never happened",
    ops: [{ op: "set", path: "receipts|m1:a3:ack", value: { message_id: "m1", agent_id: "a3", action: "ack", timestamp: T0 + 160 } }] },
  { id: "capability-missing-agent-id", primary: "capability.missing_agent_id", classification: "caught",
    lie: "a capability is registered to nobody, so routing can dispatch real work to an unidentifiable holder",
    ops: [{ op: "set", path: "capabilities|   ", value: { fleet_id: "f1", role: "x", skills: ["y"] } }] },
  { id: "capability-unroutable", primary: "capability.unroutable", classification: "caught",
    lie: "a capability row is stored and reported healthy while routing silently drops it — write, route and verify disagreeing",
    ops: [{ op: "set", path: "capabilities|a2", value: { agent_id: "a2", fleet_id: "f1", role: "", skills: [] } }] },
  { id: "ratification-orphan-proposal", primary: "ratification.orphan_proposal", classification: "caught",
    lie: "a council ratified a proposal whose text is not in the ledger — a decision with no motion",
    ops: [{ op: "set", path: "ratifications|m2|message_id", value: "m-ghost" }] },
  { id: "ratification-duplicate-voters", primary: "ratification.duplicate_voters", classification: "caught",
    lie: "one agent occupies two seats on the roster, so its single vote counts twice toward quorum",
    ops: [{ op: "set", path: "ratifications|m2|voters", value: ["a2", "a2", "a3"] }] },
  { id: "ratification-quorum-exceeds-voters", primary: "ratification.quorum_exceeds_voters", classification: "caught",
    lie: "the council reports a threshold its own roster could never reach, yet reports it met",
    ops: [{ op: "set", path: "ratifications|m2|quorum", value: 99 }] },
  { id: "ratification-signoff-not-voter", primary: "ratification.signoff_not_voter", classification: "caught",
    lie: "a mandatory sign-off is required from an agent who was never eligible to vote",
    ops: [{ op: "set", path: "ratifications|m2|required_signoffs", value: ["a1"] }] },
  { id: "ratification-weight-for-non-voter", primary: "ratification.weight_for_non_voter", classification: "caught",
    lie: "voting power is assigned to an agent who holds no seat",
    ops: [{ op: "set", path: "ratifications|m2|weights", value: { a1: 2 } }] },
  { id: "ratification-invalid-weight", primary: "ratification.invalid_weight", classification: "caught",
    lie: "a seat carries a weight outside the legal range, so the quorum arithmetic is not the arithmetic that was agreed",
    ops: [{ op: "set", path: "ratifications|m2|weights", value: { a2: 0 } }] },
  { id: "ratification-total-weight-exceeded", primary: "ratification.total_weight_exceeded", classification: "caught",
    lie: "total council weight is inflated past the cap, making the recorded quorum meaningless",
    ops: [{ op: "set", path: "ratifications|m2|weights", value: { a2: 9_000_000, a3: 9_000_000 } }] },
  { id: "ratification-vote-seq-gap", primary: "ratification.vote_seq_gap", classification: "caught",
    lie: "a ballot in the recast chain is missing — a vote was cast and then removed from history",
    ops: [{ op: "set", path: "receipts|m2:a2:r-decline:2", value: { message_id: "m2", agent_id: "a2", action: "r-decline:2", timestamp: T0 + 315 } }] },
  { id: "ratification-duplicate-vote-seq", primary: "ratification.duplicate_vote_seq", classification: "caught",
    lie: "two contradictory ballots occupy the same sequence position, so which one counted is unresolvable",
    ops: [{ op: "set", path: "receipts|m2:a2:r-decline:0", value: { message_id: "m2", agent_id: "a2", action: "r-decline:0", timestamp: T0 + 315 } }] },
  { id: "ratification-malformed-vote-action", primary: "ratification.malformed_vote_action", classification: "caught",
    lie: "a vote-shaped record cannot be parsed as a vote, so the tally silently omits a ballot that looks present",
    ops: [{ op: "set", path: "receipts|m2:a2:r-ack:x", value: { message_id: "m2", agent_id: "a2", action: "r-ack:x", timestamp: T0 + 315 } }] },

  // ===================== ANOMALY: warning-only (real, but not an overclaim) =====================
  { id: "agent-orphan-fleet", primary: "agent.orphan_fleet", classification: "anomaly",
    lie: "an agent belongs to a fleet this ledger has never seen (legitimate for a cross-attached fleet, hence a warning)",
    ops: [{ op: "set", path: "agents|a3|fleet_id", value: "f-ghost" }] },
  { id: "capability-unknown-agent", primary: "capability.unknown_agent", classification: "anomaly",
    lie: "a capability is held by an agent absent from this ledger",
    ops: [{ op: "set", path: "capabilities|a-ghost", value: { agent_id: "a-ghost", fleet_id: "f1", role: "x", skills: ["y"] } }] },
  { id: "capability-fleet-mismatch", primary: "capability.fleet_mismatch", classification: "anomaly",
    lie: "a capability places its agent in a fleet this ledger holds, while that agent's own row names a different held fleet — nothing is absent, the two records simply disagree",
    ops: [
      { op: "set", path: "fleets|f2", value: { id: "f2", status: "complete", created_at: T0, completed_at: T0 + 9000 } },
      { op: "set", path: "capabilities|a2", value: { agent_id: "a2", fleet_id: "f2", role: "x", skills: ["y"] } },
    ] },
  { id: "capability-key-mismatch", primary: "capability.key_mismatch", classification: "anomaly",
    lie: "the capability's key and its body name different agents",
    ops: [{ op: "set", path: "capabilities|wrong-key", value: { agent_id: "a2", fleet_id: "f1", role: "x", skills: ["y"] } }] },
  { id: "inbox-unknown-agent", primary: "inbox.unknown_agent", classification: "anomaly",
    lie: "work is queued for an agent that does not exist — an undeliverable item nothing would ever surface",
    ops: [{ op: "set", path: "inboxes|a-ghost", value: ["m1"] }] },
  { id: "message-ack-underclaim", primary: "message.ack_flag_mismatch", classification: "anomaly",
    lie: "the flag says unacknowledged while every recipient receipt says otherwise — surprising, but it claims LESS than the records support",
    ops: [{ op: "set", path: "messages|m1|acknowledged", value: false }] },
  { id: "receipt-unknown-agent", primary: "receipt.unknown_agent", classification: "anomaly",
    lie: "a receipt is attributed to an agent absent from this ledger",
    ops: [{ op: "set", path: "receipts|m2:a-ghost:seen", value: { message_id: "m2", agent_id: "a-ghost", action: "seen", timestamp: T0 + 400 } }] },
  { id: "ratification-vote-from-non-voter", primary: "ratification.vote_from_non_voter", classification: "anomaly",
    lie: "a ballot arrives from an agent with no seat (it is excluded from the tally, so nothing is overclaimed)",
    ops: [{ op: "set", path: "receipts|m2:a1:r-ack", value: { message_id: "m2", agent_id: "a1", action: "r-ack", timestamp: T0 + 305 } }] },
  { id: "ratification-status-mismatch", primary: "ratification.status_mismatch", classification: "anomaly",
    lie: "the council reports RATIFIED while the surviving ballots do not carry the quorum",
    ops: [{ op: "delete", path: "receipts|m2:a2:r-ack" }, { op: "delete", path: "receipts|m2:a3:r-ack" }] },
  { id: "ratification-vote-recast", primary: "ratification.vote_recast", classification: "anomaly",
    lie: "a voter changed its position after the fact (legitimate under the recast protocol, but worth seeing)",
    ops: [{ op: "set", path: "receipts|m2:a2:r-decline:1", value: { message_id: "m2", agent_id: "a2", action: "r-decline:1", timestamp: T0 + 315 } }] },
  { id: "fleet-unreconciled-status", primary: "fleet.unreconciled_status", classification: "anomaly",
    lie: "the fleet still projects RUNNING though every one of its agents has terminated — a stale projection, not a forged one",
    ops: [{ op: "set", path: "fleets|f1|status", value: "running" }, { op: "delete", path: "fleets|f1|completed_at" }] },

  // The OVERCLAIM direction of the same lattice, and the reason it is an error
  // where its sibling above is a warning: an unreconciled fleet understates in
  // the reader's favour, while a sealed fleet asserts finished work over an
  // agent that never finished.
  { id: "fleet-sealed-with-live-agents", primary: "fleet.sealed_with_live_agents", classification: "caught",
    lie: "the fleet is sealed COMPLETE while one of its own agents is still running — it claims work that its own rows say never finished",
    ops: [{ op: "set", path: "agents|a3|status", value: "running" }, { op: "delete", path: "agents|a3|completed_at" }] },
  { id: "fleet-key-mismatch", primary: "fleet.key_mismatch", classification: "caught",
    lie: "the fleet's map key and the id in its own body name different fleets",
    ops: [{ op: "set", path: "fleets|f1|id", value: "f-other" }] },
  { id: "fleet-invalid-created-at", primary: "fleet.invalid_timestamp", classification: "caught",
    lie: "the fleet's own created_at is not a finite number — and it is the anchor its agents' and messages' lifecycle comparisons are made against, so while it is unreadable those comparisons silently pass",
    ops: [{ op: "set", path: "fleets|f1|created_at", value: null }] },
  { id: "agent-key-mismatch", primary: "agent.key_mismatch", classification: "caught",
    lie: "the agent's map key and the id in its own body name different agents",
    ops: [{ op: "set", path: "agents|a3|id", value: "a-other" }] },
  { id: "message-key-mismatch", primary: "message.key_mismatch", classification: "caught",
    lie: "the message's map key and the id in its own body disagree — receipts join on one, inboxes on the other, so one message reads as two different rows",
    ops: [{ op: "set", path: "messages|m1|id", value: "m-other" }] },
  { id: "message-orphan-fleet", primary: "message.orphan_fleet", classification: "anomaly",
    lie: "a message names a fleet this ledger does not hold, so every fleet-scoped check on it silently skipped",
    ops: [{ op: "set", path: "messages|m1|fleet_id", value: "f-ghost" }] },
  { id: "message-vacuous-ack", primary: "message.vacuous_ack", classification: "caught",
    lie: "the message claims ACKNOWLEDGED while addressing nobody — `every` over an empty recipient set is vacuously true, so the claim rests on no delivery evidence at all",
    ops: [{ op: "set", path: "messages|m1|recipients", value: [] }, { op: "delete", path: "receipts|m1:a2:ack" }] },
  { id: "inbox-non-recipient", primary: "inbox.non_recipient", classification: "caught",
    lie: "a message is queued for an agent it was never addressed to — the dual of a non-recipient ack, made through the queue instead of a receipt",
    ops: [{ op: "set", path: "inboxes|a1", value: ["m1"] }] },

  // The sharper half of the sealed-fleet defect: every agent is TERMINAL here,
  // so the live-agent check is silent, and the fleet simply recorded an outcome
  // its own rows do not support.
  { id: "fleet-sealed-lattice-mismatch", primary: "fleet.sealed_lattice_mismatch", classification: "caught",
    lie: "the fleet is sealed COMPLETE while one of its agents FAILED — it claims a success its own rows deny",
    ops: [{ op: "set", path: "agents|a3|status", value: "failed" }] },
  { id: "fleet-sealed-over-interrupted", primary: "fleet.sealed_lattice_mismatch", classification: "caught",
    lie: "the fleet is sealed COMPLETE over an interrupted agent — the lattice says abandoned, which is the status that exists precisely so this is not recorded as success",
    ops: [{ op: "set", path: "agents|a3|status", value: "interrupted" }] },
  { id: "fleet-sealed-failed-over-complete", primary: "fleet.sealed_lattice_mismatch", classification: "anomaly",
    lie: "the fleet is sealed FAILED though every agent completed — it asserts an error that never occurred, but claims LESS than its records support, so it warns rather than errors",
    ops: [{ op: "set", path: "fleets|f1|status", value: "failed" }] },
  { id: "agent-completed-while-live", primary: "agent.completed_while_live", classification: "caught",
    lie: "one agent row asserts both that it is still running and that it has already finished",
    ops: [{ op: "set", path: "agents|a3|status", value: "running" }] },
  { id: "ratification-key-mismatch", primary: "ratification.key_mismatch", classification: "caught",
    lie: "the council outcome is filed under a key that names a different proposal than its own body does",
    ops: [{ op: "set", path: "ratifications|m2|message_id", value: "m1" }] },
  { id: "ratification-invalid-quorum", primary: "ratification.invalid_quorum", classification: "caught",
    lie: "quorum is 0, so RATIFIED recomputes as fully supported over zero ballots — the status mismatch that would otherwise warn becomes completely silent",
    ops: [{ op: "set", path: "ratifications|m2|quorum", value: 0 }] },
  { id: "agent-requested-model-unobserved", primary: "agent.requested_model_unobserved", classification: "caught",
    lie: "a complete agent row carries a persisted `requested_model` selection but its observed `runtime_model` banner is absent — the selection's claim that this agent ran under the requested model rests on no banner capture",
    ops: [{ op: "set", path: "agents|a2|requested_model", value: "opencode-go/minimax-m3" }] },
  { id: "agent-requested-model-mismatch", primary: "agent.requested_model_mismatch", classification: "caught",
    lie: "a complete agent row records a `requested_model` whose observed `runtime_model` is a different model — the selection and the captured banner contradict each other under the same runtimeModelsMatch() rule the spawn classifier uses",
    ops: [
      { op: "set", path: "agents|a2|requested_model", value: "opencode-go/minimax-m3" },
      { op: "set", path: "agents|a2|runtime_model", value: "openai/gpt-5" },
    ] },

  // Restored to the generator 2026-08-06. This vector existed in the committed manifest but in
  // NEITHER generator, so a regeneration silently dropped it and its check went unpinned — found
  // exactly that way. A fixture the generator cannot reproduce is a fixture one `npx tsx
  // scripts/generate-corpus.ts` away from disappearing.
  { id: "message-unknown-recipient", primary: "message.unknown_recipient", classification: "anomaly",
    lie: "a message is addressed to an agent absent from this ledger, inside a fleet the ledger holds",
    ops: [{ op: "set", path: "messages|m3", value: {
      id: "m3", from_agent_id: "a1", to_agent_id: "a-ghost", fleet_id: "f1",
      type: "handoff", payload: "hand this to the reviewer", timestamp: T0 + 400, acknowledged: false,
    } }] },
  { id: "agent-stopped-reason-while-live", primary: "agent.stopped_reason_while_live", classification: "caught",
    lie: "an agent row claims it has not finished and, in the same breath, that it is known why it stopped — a settle-only attribution on a live row",
    ops: [
      { op: "set", path: "agents|a3|status", value: "running" },
      { op: "delete", path: "agents|a3|completed_at" },
      { op: "set", path: "agents|a3|stopped_reason", value: "server_crash" },
    ] },
  { id: "agent-result-contract-while-live", primary: "agent.result_contract_while_live", classification: "caught",
    lie: "an agent row carries a declared settle outcome while its own status says it has not settled — the value callers are told to trust as the stronger signal, on a run that has not produced one",
    ops: [
      { op: "set", path: "agents|a3|status", value: "running" },
      { op: "delete", path: "agents|a3|completed_at" },
      { op: "set", path: "agents|a3|result_contract", value: "ok" },
    ] },
  { id: "agent-runtime-attempt-duplicated", primary: "agent.runtime_attempt_duplicated", classification: "caught",
    lie: "an agent's runtime history repeats the same runtime in adjacent positions, asserting a failover hop to the runtime it was already using — evidence the writer's own idempotence collapses, so no spawn path could have produced it",
    ops: [{ op: "set", path: "agents|a3|runtime_attempts", value: ["opencode-cli", "opencode-cli"] }] },
  { id: "fleet-crash-provenance-unsupported", primary: "fleet.crash_provenance_unsupported", classification: "caught",
    lie: "a fleet blames a server crash for its abandonment while not one of its own agents holds an interrupted row attributing that crash — a shared external cause asserted over records that do not support it",
    ops: [
      { op: "set", path: "fleets|f1|status", value: "abandoned" },
      { op: "set", path: "fleets|f1|stopped_reason", value: "server_crash" },
    ] },

  // ===================== UNDETECTABLE: the honest boundary (ZERO findings) =====================
  { id: "undetectable-forged-seen-receipt", primary: "", classification: "undetectable",
    lie: "a3 is on record as having SEEN the incident alert. It never did. 'seen' is an annotation any third party may legitimately write, so no contradiction exists to detect.",
    ops: [{ op: "set", path: "receipts|m2:a3:seen", value: { message_id: "m2", agent_id: "a3", action: "seen", timestamp: T0 + 270 } }] },
  { id: "undetectable-payload-swap-after-ack", primary: "", classification: "undetectable",
    lie: "the council approved 'ship the migration'; the ledger now reads 'drop the users table'. Receipts bind to message_id, never to payload content, so the approval survives a total rewrite of what was approved.",
    ops: [{ op: "set", path: "messages|m2|payload", value: "PROPOSAL: drop the users table" }] },
  { id: "undetectable-sender-spoof", primary: "", classification: "undetectable",
    lie: "the migration order came from the Engineer, not the Proposer. from_agent_id is an unsigned string; nothing binds a message to its author.",
    ops: [{ op: "set", path: "messages|m1|from_agent_id", value: "a3" }] },
  { id: "undetectable-universal-clock-shift", primary: "", classification: "undetectable",
    lie: "the entire incident happened a day earlier — moved wholesale into or out of an audit window. Only RELATIVE order is checked; no external time anchor exists.",
    ops: [
      { op: "set", path: "fleets|f1|created_at", value: T0 - 86_400_000 },
      { op: "set", path: "fleets|f1|completed_at", value: T0 + 9000 - 86_400_000 },
      { op: "set", path: "agents|a1|started_at", value: T0 + 10 - 86_400_000 }, { op: "set", path: "agents|a1|completed_at", value: T0 + 8000 - 86_400_000 },
      { op: "set", path: "agents|a2|started_at", value: T0 + 10 - 86_400_000 }, { op: "set", path: "agents|a2|completed_at", value: T0 + 8000 - 86_400_000 },
      { op: "set", path: "agents|a3|started_at", value: T0 + 10 - 86_400_000 }, { op: "set", path: "agents|a3|completed_at", value: T0 + 8000 - 86_400_000 },
      { op: "set", path: "messages|m1|timestamp", value: T0 + 100 - 86_400_000 }, { op: "set", path: "messages|m2|timestamp", value: T0 + 200 - 86_400_000 },
      { op: "set", path: "receipts|m1:a2:ack|timestamp", value: T0 + 150 - 86_400_000 },
      { op: "set", path: "receipts|m2:a2:ack|timestamp", value: T0 + 250 - 86_400_000 },
      { op: "set", path: "receipts|m2:a3:ack|timestamp", value: T0 + 260 - 86_400_000 },
      { op: "set", path: "receipts|m2:a2:r-ack|timestamp", value: T0 + 300 - 86_400_000 },
      { op: "set", path: "receipts|m2:a3:r-ack|timestamp", value: T0 + 310 - 86_400_000 },
      { op: "set", path: "ratifications|m2|opened_at", value: T0 + 200 - 86_400_000 },
      { op: "set", path: "ratifications|m2|resolved_at", value: T0 + 320 - 86_400_000 },
    ] },
  { id: "undetectable-ghost-agent-full-history", primary: "", classification: "undetectable",
    lie: "an 'Auditor' agent participated and reported the system clean. It never existed. A coherent persona costs nothing to mint when there is no enrolment proof.",
    ops: [
      { op: "set", path: "agents|a9", value: { id: "a9", fleet_id: "f1", role: "Auditor", prompt: "p", status: "complete", started_at: T0 + 10, completed_at: T0 + 8000 } },
      { op: "set", path: "inboxes|a9", value: [] },
      { op: "set", path: "messages|m9", value: { id: "m9", from_agent_id: "a9", to_agent_id: "a1", fleet_id: "f1", type: "result", payload: "independent audit: clean", timestamp: T0 + 600, acknowledged: true } },
      { op: "set", path: "receipts|m9:a1:ack", value: { message_id: "m9", agent_id: "a1", action: "ack", timestamp: T0 + 650 } },
    ] },
  { id: "undetectable-vote-injection-by-seated-voter", primary: "", classification: "undetectable",
    lie: "a2 is recorded approving the migration. a2 never voted. Ballots are unsigned rows and a2 holds a legitimate seat, so roster checks pass.",
    ops: [{ op: "delete", path: "receipts|m2:a3:r-ack" }, { op: "set", path: "ratifications|m2|quorum", value: 1 }] },
  { id: "undetectable-suppressed-delivery", primary: "", classification: "undetectable",
    lie: "a3 never received the broadcast — its receipt was deleted and the audience list trimmed to match. Absence of a receipt is not an overclaim, and no delivery oracle exists to demand one.",
    ops: [{ op: "delete", path: "receipts|m2:a3:ack" }, { op: "set", path: "messages|m2|recipients", value: ["a2"] }] },
  { id: "undetectable-inbox-delivery-without-receipt", primary: "", classification: "undetectable",
    lie: "work sits in an agent's queue implying delivery, with no receipt attesting to it. Nothing requires inbox membership to be witnessed.",
    ops: [
      { op: "set", path: "messages|m3", value: { id: "m3", from_agent_id: "a1", to_agent_id: "a3", fleet_id: "f1", type: "handoff", payload: "deploy to prod", timestamp: T0 + 500, acknowledged: false } },
      { op: "set", path: "inboxes|a3", value: ["m3"] },
    ] },
  { id: "undetectable-schema-downgrade-ack-backfill", primary: "", classification: "undetectable",
    lie: "a2 is on record as having acknowledged the migration handoff; its receipt was deleted. Declaring the ledger v1 makes the loader BACKFILL an ack receipt from the message's own acknowledged flag, so the overclaim repairs itself before the verifier runs. A ledger that declares an older schema is trusted about its own acks.",
    ops: [{ op: "delete", path: "schema_version" }, { op: "delete", path: "receipts|m1:a2:ack" }] },
  { id: "undetectable-post-mortem-participation", primary: "", classification: "undetectable",
    lie: "an agent sent a message hours after it terminated. Agent lifecycle and message authorship are not cross-checked.",
    ops: [{ op: "set", path: "messages|m4", value: { id: "m4", from_agent_id: "a2", to_agent_id: "a1", fleet_id: "f1", type: "result", payload: "late result", timestamp: T0 + 20_000, acknowledged: false } }] },

  // ===================== DISCUSSION: discussion/v1 envelope integrity =====================
  // Each of the 12 vectors that previously lived in the supplemental
  // `scripts/generate-discussion-corpus.mjs`. They pin every check the verifier
  // emits under the dynamic `discussion.<code>` family (see DISCUSSION_ERROR_CODES
  // in src/verify.ts). The harness applies the same `applyOps` workflow and runs
  // them through the same `verifyMeshData` call as the rest.
  //
  // Timestamps use the same `NOW` anchor and `NOW - X` offsets the prior writer
  // used, so the fixtures the canonical generator emits are byte-identical to
  // the committed ones under SHA-256.
  {
    id: "discussion-no-valid-root", primary: "discussion.no_valid_root", classification: "caught",
    lie: "messages carrying discussion/v1 envelopes exist but none qualifies as a valid root",
    ops: [{
      op: "set", path: "messages|d-m1", value: {
        id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
        type: "result",
        payload: makeEnv({ turn: 2, reply_to: "nonexistent" }),
        correlation_id: "disc-1",
        timestamp: NOW - 1000,
        acknowledged: false,
      },
    }],
  },
  {
    id: "discussion-duplicate-root", primary: "discussion.duplicate_root", classification: "caught",
    lie: "two messages both qualify as valid discussion roots for the same correlation id",
    ops: [
      { op: "set", path: "messages|d-m1", value: {
        id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
        type: "question", payload: DISCUSSION_ROOT,
        correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
      } },
      { op: "set", path: "messages|d-m2", value: {
        id: "d-m2", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
        type: "question", payload: DISCUSSION_ROOT,
        correlation_id: "disc-1", timestamp: NOW - 1999, acknowledged: false,
      } },
    ],
  },
  {
    id: "discussion-child-policy-forbidden", primary: "discussion.child_policy_forbidden", classification: "caught",
    lie: "a non-root envelope carries a policy block — only the root may define the immutable policy",
    ops: [
      { op: "set", path: "messages|d-m1", value: {
        id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
        type: "question", payload: DISCUSSION_ROOT,
        correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
      } },
      { op: "set", path: "messages|d-m2", value: {
        id: "d-m2", from_agent_id: "a2", to_agent_id: "a1", fleet_id: "f1",
        type: "result",
        payload: makeEnv({ turn: 2, attempt_id: "att-2", reply_to: "d-m1", kind: "result", policy: DISCUSSION_POLICY }),
        correlation_id: "disc-1", timestamp: NOW - 1000, acknowledged: false,
      } },
    ],
  },
  {
    id: "discussion-wrong-fleet", primary: "discussion.wrong_fleet", classification: "caught",
    lie: "a discussion envelope is carried by a message in a different fleet than the root",
    ops: [
      { op: "set", path: "messages|d-m1", value: {
        id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
        type: "question", payload: DISCUSSION_ROOT,
        correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
      } },
      { op: "set", path: "messages|d-m2", value: {
        id: "d-m2", from_agent_id: "a2", to_agent_id: "a1", fleet_id: "f-other",
        type: "result",
        payload: makeEnv({ turn: 2, attempt_id: "att-2", reply_to: "d-m1", kind: "result" }),
        correlation_id: "disc-1", timestamp: NOW - 1000, acknowledged: false,
      } },
    ],
  },
  {
    id: "discussion-participant-violation", primary: "discussion.participant_violation", classification: "caught",
    lie: "a discussion message involves an agent not in the policy's two-participant set",
    ops: [
      { op: "set", path: "messages|d-m1", value: {
        id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
        type: "question", payload: DISCUSSION_ROOT,
        correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
      } },
      { op: "set", path: "messages|d-m2", value: {
        id: "d-m2", from_agent_id: "a3", to_agent_id: "a1", fleet_id: "f1",
        type: "result",
        payload: makeEnv({ turn: 2, attempt_id: "att-2", reply_to: "d-m1", kind: "result" }),
        correlation_id: "disc-1", timestamp: NOW - 1000, acknowledged: false,
      } },
    ],
  },
  {
    id: "discussion-kind-type-mismatch", primary: "discussion.kind_type_mismatch", classification: "caught",
    lie: "the envelope kind disagrees with the message type",
    ops: [
      { op: "set", path: "messages|d-m1", value: {
        id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
        type: "question", payload: DISCUSSION_ROOT,
        correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
      } },
      { op: "set", path: "messages|d-m2", value: {
        id: "d-m2", from_agent_id: "a2", to_agent_id: "a1", fleet_id: "f1",
        type: "result",
        payload: makeEnv({ turn: 2, attempt_id: "att-2", reply_to: "d-m1", kind: "question" }),
        correlation_id: "disc-1", timestamp: NOW - 1000, acknowledged: false,
      } },
    ],
  },
  {
    id: "discussion-broadcast-forbidden", primary: "discussion.broadcast_forbidden", classification: "caught",
    lie: "a discussion/v1 envelope is smuggled via a broadcast message",
    ops: [{
      op: "set", path: "messages|d-m1", value: {
        id: "d-m1", from_agent_id: "a1", to_agent_id: "*", fleet_id: "f1",
        type: "question", payload: DISCUSSION_ROOT,
        correlation_id: "disc-1", timestamp: NOW - 1000, acknowledged: false,
      },
    }],
  },
  {
    id: "discussion-invalid-sender", primary: "discussion.invalid_sender", classification: "caught",
    lie: "a reply does not alternate sender and recipient",
    ops: [
      { op: "set", path: "messages|d-m1", value: {
        id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
        type: "question", payload: DISCUSSION_ROOT,
        correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
      } },
      { op: "set", path: "messages|d-m2", value: {
        id: "d-m2", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
        type: "result",
        payload: makeEnv({ turn: 2, attempt_id: "att-2", reply_to: "d-m1", kind: "result" }),
        correlation_id: "disc-1", timestamp: NOW - 800, acknowledged: false,
      } },
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.reserved.v1:2:att-2", value: {
        id: "d-m1:a2:discussion.wake.reserved.v1:2:att-2",
        agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.reserved.v1:2:att-2",
        note: JSON.stringify({ discussion_id: "disc-1", head_message_id: "d-m1", deadline: NOW + 30000 }),
        timestamp: NOW - 1000,
      } },
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.completed.v1:2:att-2", value: {
        id: "d-m1:a2:discussion.wake.completed.v1:2:att-2",
        agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.completed.v1:2:att-2",
        note: JSON.stringify({ discussion_id: "disc-1", head_message_id: "d-m1", deadline: NOW + 30000, reply_message_id: "d-m2" }),
        timestamp: NOW - 800,
      } },
    ],
  },
  {
    id: "discussion-attempt-identity-conflict", primary: "discussion.attempt_identity_conflict", classification: "caught",
    lie: "receipts within a single attempt lifecycle disagree on an immutable field",
    ops: [
      { op: "set", path: "messages|d-m1", value: {
        id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
        type: "question", payload: DISCUSSION_ROOT,
        correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
      } },
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.reserved.v1:2:att-2", value: {
        id: "d-m1:a2:discussion.wake.reserved.v1:2:att-2",
        agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.reserved.v1:2:att-2",
        note: JSON.stringify({ discussion_id: "disc-1", head_message_id: "d-m1", deadline: NOW + 30000 }),
        timestamp: NOW - 1000,
      } },
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.started.v1:2:att-2", value: {
        id: "d-m1:a2:discussion.wake.started.v1:2:att-2",
        agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.started.v1:2:att-2",
        note: JSON.stringify({ discussion_id: "disc-1", head_message_id: "d-m1", deadline: NOW + 25000 }),
        timestamp: NOW - 900,
      } },
    ],
  },
  {
    id: "discussion-duplicate-turn", primary: "discussion.duplicate_turn", classification: "caught",
    lie: "two distinct attempt ids both reserve the same turn number at the same head",
    ops: [
      { op: "set", path: "messages|d-m1", value: {
        id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
        type: "question", payload: DISCUSSION_ROOT,
        correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
      } },
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.reserved.v1:2:att-A", value: {
        id: "d-m1:a2:discussion.wake.reserved.v1:2:att-A",
        agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.reserved.v1:2:att-A",
        note: JSON.stringify({ discussion_id: "disc-1", head_message_id: "d-m1", deadline: NOW + 30000 }),
        timestamp: NOW - 1000,
      } },
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.reserved.v1:2:att-B", value: {
        id: "d-m1:a2:discussion.wake.reserved.v1:2:att-B",
        agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.reserved.v1:2:att-B",
        note: JSON.stringify({ discussion_id: "disc-1", head_message_id: "d-m1", deadline: NOW + 30000 }),
        timestamp: NOW - 999,
      } },
    ],
  },
  {
    id: "discussion-fork", primary: "discussion.fork", classification: "caught",
    lie: "two authorized replies target the same head — the discussion chain forks",
    ops: [
      { op: "set", path: "messages|d-m1", value: {
        id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
        type: "question", payload: DISCUSSION_ROOT,
        correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
      } },
      { op: "set", path: "messages|d-m2a", value: {
        id: "d-m2a", from_agent_id: "a2", to_agent_id: "a1", fleet_id: "f1",
        type: "result",
        payload: makeEnv({ turn: 2, attempt_id: "att-2a", reply_to: "d-m1", kind: "result" }),
        correlation_id: "disc-1", timestamp: NOW - 800, acknowledged: false,
      } },
      { op: "set", path: "messages|d-m2b", value: {
        id: "d-m2b", from_agent_id: "a2", to_agent_id: "a1", fleet_id: "f1",
        type: "result",
        payload: makeEnv({ turn: 2, attempt_id: "att-2b", reply_to: "d-m1", kind: "result" }),
        correlation_id: "disc-1", timestamp: NOW - 799, acknowledged: false,
      } },
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.reserved.v1:2:att-2a", value: {
        id: "d-m1:a2:discussion.wake.reserved.v1:2:att-2a",
        agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.reserved.v1:2:att-2a",
        note: JSON.stringify({ discussion_id: "disc-1", head_message_id: "d-m1", deadline: NOW + 30000 }),
        timestamp: NOW - 1000,
      } },
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.completed.v1:2:att-2a", value: {
        id: "d-m1:a2:discussion.wake.completed.v1:2:att-2a",
        agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.completed.v1:2:att-2a",
        note: JSON.stringify({ discussion_id: "disc-1", head_message_id: "d-m1", deadline: NOW + 30000, reply_message_id: "d-m2a" }),
        timestamp: NOW - 800,
      } },
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.reserved.v1:2:att-2b", value: {
        id: "d-m1:a2:discussion.wake.reserved.v1:2:att-2b",
        agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.reserved.v1:2:att-2b",
        note: JSON.stringify({ discussion_id: "disc-1", head_message_id: "d-m1", deadline: NOW + 30000 }),
        timestamp: NOW - 999,
      } },
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.completed.v1:2:att-2b", value: {
        id: "d-m1:a2:discussion.wake.completed.v1:2:att-2b",
        agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.completed.v1:2:att-2b",
        note: JSON.stringify({ discussion_id: "disc-1", head_message_id: "d-m1", deadline: NOW + 30000, reply_message_id: "d-m2b" }),
        timestamp: NOW - 799,
      } },
    ],
  },
  {
    id: "discussion-ordinal-discontinuity", primary: "discussion.ordinal_discontinuity", classification: "caught",
    lie: "a reply claims a turn that skips over unreserved turns",
    ops: [
      { op: "set", path: "messages|d-m1", value: {
        id: "d-m1", from_agent_id: "a1", to_agent_id: "a2", fleet_id: "f1",
        type: "question", payload: DISCUSSION_ROOT,
        correlation_id: "disc-1", timestamp: NOW - 2000, acknowledged: false,
      } },
      { op: "set", path: "messages|d-m3", value: {
        id: "d-m3", from_agent_id: "a2", to_agent_id: "a1", fleet_id: "f1",
        type: "result",
        payload: makeEnv({ turn: 3, attempt_id: "att-3", reply_to: "d-m1", kind: "result" }),
        correlation_id: "disc-1", timestamp: NOW - 800, acknowledged: false,
      } },
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.reserved.v1:3:att-3", value: {
        id: "d-m1:a2:discussion.wake.reserved.v1:3:att-3",
        agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.reserved.v1:3:att-3",
        note: JSON.stringify({ discussion_id: "disc-1", head_message_id: "d-m1", deadline: NOW + 30000 }),
        timestamp: NOW - 1000,
      } },
      { op: "set", path: "receipts|d-m1:a2:discussion.wake.completed.v1:3:att-3", value: {
        id: "d-m1:a2:discussion.wake.completed.v1:3:att-3",
        agent_id: "a2", message_id: "d-m1",
        action: "discussion.wake.completed.v1:3:att-3",
        note: JSON.stringify({ discussion_id: "disc-1", head_message_id: "d-m1", deadline: NOW + 30000, reply_message_id: "d-m3" }),
        timestamp: NOW - 800,
      } },
    ],
  },
];

// --------------------------------------------------------------------------
// Inventory gate (fail-closed, GIT-INDEX + WORKING-TREE BACKED). The
// committed state lives at `git show HEAD:<path>`; the working tree may
// already diverge from that (a future edit narrowed V[], an in-flight
// cherry-pick added a vector, a committed-manifest regression slipped past
// CI). The gate must read BOTH and treat the union as the authoritative
// preservation target. Reading only the working tree would let a
// `git rm`-then-regenerate corrupt a pinned check invisibly; reading only
// HEAD would let a WT phantom escape without notice.
//
//   - committed manifest at HEAD    (sha-backed, immutable from the
//                                    generator's point of view)
//   - working-tree manifest on disk (the in-flight editor's next state,
//                                    distinct from HEAD when something
//                                    is staged or simply edited)
//
// Either side naming a vector the generator lacks fails closed.
// --------------------------------------------------------------------------
const COMMITTED_MANIFEST_PATH = "test/fixtures/corpus/manifest.json";
type MinimalManifest = { vectors: { id: string }[] };
const LOCK = `${OUT}.lock`;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code !== "ESRCH";
  }
}

function releaseWriterLock(): void {
  try { rmSync(LOCK, { recursive: true, force: true, maxRetries: 5 }); } catch { /* no-op */ }
}

function acquireWriterLock(): void {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, "owner.json"), JSON.stringify({ pid: process.pid, started_at: Date.now() }) + "\n");
      return;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const owner = JSON.parse(readFileSync(join(LOCK, "owner.json"), "utf-8"));
        if (Number.isInteger(owner.pid) && !processIsAlive(owner.pid)) {
          releaseWriterLock();
          continue;
        }
      } catch {
        // A live writer may have created the lock just before writing owner.json.
        // Only reap an ownerless lock after that short creation window has elapsed.
        try {
          if (Date.now() - statSync(LOCK).mtimeMs > 1_000) {
            releaseWriterLock();
            continue;
          }
        } catch { /* another writer released it; retry below */ }
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for corpus writer lock ${LOCK}`);
      }
      sleep(25);
    }
  }
}

function publishPaths(kind: "staging" | "backup"): string[] {
  const prefix = `${basename(OUT)}.${kind}-`;
  try {
    return readdirSync(join(OUT, "..")).filter((entry) => entry.startsWith(prefix)).map((entry) => join(OUT, "..", entry));
  } catch {
    return [];
  }
}

function recoverInterruptedPublish(): void {
  const backups = publishPaths("backup").sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!existsSync(OUT) && backups.length > 0) {
    renameSync(backups.shift()!, OUT);
  }
  if (!existsSync(OUT)) {
    throw new Error(`UNVERIFIED CORPUS SCAFFOLD: ${OUT} is absent after interrupted-publish recovery`);
  }
  for (const path of [...backups, ...publishPaths("staging")]) {
    rmSync(path, { recursive: true, force: true, maxRetries: 5 });
  }
}

function readManifestOrThrow(label: string, read: () => string): MinimalManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(read());
  } catch (err) {
    throw new Error(`UNVERIFIED CORPUS SCAFFOLD: cannot read ${label} manifest: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as MinimalManifest).vectors) ||
      !(parsed as MinimalManifest).vectors.every((vector) => typeof vector?.id === "string" && vector.id.length > 0)) {
    throw new Error(`UNVERIFIED CORPUS SCAFFOLD: ${label} manifest has no valid vector inventory`);
  }
  return parsed as MinimalManifest;
}

acquireWriterLock();
try {
  recoverInterruptedPublish();
  const committedManifest = readManifestOrThrow("git HEAD", () =>
    execFileSync("git", ["show", `HEAD:${COMMITTED_MANIFEST_PATH}`], { encoding: "utf-8" }),
  );
  const workingTreeManifest = readManifestOrThrow("git working-tree", () => readFileSync(join(OUT, "manifest.json"), "utf-8"));
  const generatedIds = new Set(V.map((v) => v.id));
  const missing = [...new Set([...committedManifest.vectors, ...workingTreeManifest.vectors].map((v) => v.id))]
    .filter((id) => !generatedIds.has(id));
  if (missing.length > 0) {
    throw new Error(
      `INCOMPLETE CORPUS INVENTORY: canonical generator is missing ${missing.length} manifest ${missing.length === 1 ? "entry" : "entries"} ` +
        `(sourced from the union of git HEAD and git working-tree manifests):\n` +
        missing.map((id) => `  - ${id}`).join("\n") +
        `\nAdd an entry to V[] in scripts/generate-corpus.ts before regenerating.`,
    );
  }
} catch (err) {
  releaseWriterLock();
  console.error((err as Error).message);
  process.exit(1);
}

// --------------------------------------------------------------------------
// Atomic write. Start by copying everything currently under `OUT` (which the
// fixture writer does not produce — README.md and any future companion files)
// into the staging dir, then materialise every fixture and the manifest on
// top. The staging dir is the candidate for the atomic swap; only on full
// success is it renamed onto `OUT`. A failure mid-run, an OS-level interrupt,
// or an invariant mismatch leaves `OUT` byte-identical to its pre-run state.
// --------------------------------------------------------------------------
const STAGING = `${OUT}.staging-${process.pid}-${Date.now()}`;
const BACKUP = `${OUT}.backup-${process.pid}-${Date.now()}`;

function cleanupStaging() {
  try { rmSync(STAGING, { recursive: true, force: true, maxRetries: 5 }); } catch { /* no-op */ }
}
function cleanupBackup() {
  try { rmSync(BACKUP, { recursive: true, force: true, maxRetries: 5 }); } catch { /* no-op */ }
}

process.on("exit", cleanupStaging);
process.on("SIGINT", () => { cleanupStaging(); releaseWriterLock(); process.exit(130); });
process.on("SIGTERM", () => { cleanupStaging(); releaseWriterLock(); process.exit(143); });

const pauseAfterLock = Number(process.env.MESH_FLEET_CORPUS_PAUSE_AFTER_LOCK_MS ?? "0");
if (Number.isFinite(pauseAfterLock) && pauseAfterLock > 0) sleep(pauseAfterLock);

mkdirSync(STAGING, { recursive: true });
// Carry across every existing file in OUT that the writer doesn't produce.
// `cp -R` would do this, but shell-out is needless — Node's readdirSync +
// copyFileSync is portable and lets us skip the files we are about to
// overwrite (which would be a no-op) while preserving everything else.
if (existsSync(OUT)) {
  for (const entry of readdirSync(OUT)) {
    copyFileSync(join(OUT, entry), join(STAGING, entry));
  }
}

writeFileSync(join(STAGING, "baseline.json"), JSON.stringify(BASELINE, null, 2) + "\n");

const baseReport: any = verifyMeshData(loadDataFromFile(join(STAGING, "baseline.json")) as any, NOW);
if (baseReport.findings.length !== 0) {
  console.error("FATAL: baseline is not clean", baseReport.findings);
  cleanupStaging();
  process.exit(1);
}

const manifest: any = { now: NOW, baseline: "baseline.json", vectors: [] };
const problems: string[] = [];

for (const v of V) {
  const d: any = structuredClone(BASELINE);
  applyOps(d, v.ops);
  // Write into the staging dir only — the corpus directory is untouched
  // until the staging dir passes verification AND is atomically renamed.
  writeFileSync(join(STAGING, `${v.id}.json`), JSON.stringify(d, null, 2) + "\n");
  const report: any = verifyMeshData(loadDataFromFile(join(STAGING, `${v.id}.json`)) as any, NOW);
  const findings = report.findings
    .map((f: any) => ({ severity: f.severity, check: f.check, subject: f.subject }))
    .sort((a: any, b: any) => `${a.check}${a.subject}`.localeCompare(`${b.check}${b.subject}`));

  // Authored invariants — these are asserted, never snapshotted.
  if (v.classification === "caught") {
    const hit = findings.find((f: any) => f.check === v.primary && f.severity === "error");
    if (!hit) problems.push(`${v.id}: expected ERROR ${v.primary}, got ${JSON.stringify(findings)}`);
    if (report.ok) problems.push(`${v.id}: classified caught but ok=true`);
  } else if (v.classification === "anomaly") {
    const hit = findings.find((f: any) => f.check === v.primary && f.severity === "warning");
    if (!hit) problems.push(`${v.id}: expected WARNING ${v.primary}, got ${JSON.stringify(findings)}`);
  } else {
    if (findings.length !== 0) problems.push(`${v.id}: classified undetectable but produced ${JSON.stringify(findings)}`);
    if (!report.ok) problems.push(`${v.id}: classified undetectable but ok=false`);
  }

  manifest.vectors.push({ id: v.id, primary: v.primary, classification: v.classification, lie: v.lie, ops: v.ops, expected_ok: report.ok, expected_findings: findings });
}

writeFileSync(join(STAGING, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

if (problems.length) {
  console.error(`\n${problems.length} PROBLEM(S):`);
  for (const p of problems) console.error("  " + p);
  cleanupStaging();
  process.exit(1);
}

// This narrow failpoint is intentionally inert unless a test explicitly opts
// in. It proves that a completely staged candidate cannot alter the published
// corpus before the publication boundary.
if (process.env.MESH_FLEET_CORPUS_FAILPOINT === "before-publish") {
  cleanupStaging();
  releaseWriterLock();
  console.error("FATAL: requested pre-publish failure");
  process.exit(91);
}

const stagedManifest = readManifestOrThrow("staged", () => readFileSync(join(STAGING, "manifest.json"), "utf-8"));
if (stagedManifest.vectors.length !== V.length || !existsSync(join(STAGING, "baseline.json")) ||
    stagedManifest.vectors.some((vector) => !existsSync(join(STAGING, `${vector.id}.json`)))) {
  cleanupStaging();
  releaseWriterLock();
  console.error("FATAL: staged corpus is incomplete");
  process.exit(1);
}

// All fixtures + manifest staged and verified. Now atomic swap:
// 1. Move existing OUT to BACKUP (no-op if OUT doesn't exist).
// 2. Rename STAGING to OUT.
// 3. Remove BACKUP.
// If anything throws between 1 and 2, restore OUT from BACKUP. Once STAGING
// is renamed to OUT, the corpus is the new state.
try {
  if (existsSync(OUT)) renameSync(OUT, BACKUP);
  if (process.env.MESH_FLEET_CORPUS_FAILPOINT === "after-backup") {
    console.error("FATAL: requested after-backup interruption");
    process.exit(92);
  }
  renameSync(STAGING, OUT);
} catch (err) {
  // Restore whatever we can.
  if (existsSync(BACKUP) && !existsSync(OUT)) {
    try { renameSync(BACKUP, OUT); } catch { /* leave the staged set untouched */ }
  }
  cleanupStaging();
  releaseWriterLock();
  console.error(`FATAL: atomic swap failed: ${(err as Error).message}`);
  process.exit(1);
}
cleanupBackup();
releaseWriterLock();

console.log(`wrote ${V.length} vectors + baseline + manifest to test/fixtures/corpus/`);
const byClass = (c: string) => V.filter((v) => v.classification === c).length;
console.log(`  caught=${byClass("caught")} anomaly=${byClass("anomaly")} undetectable=${byClass("undetectable")}`);
console.log("all authored invariants hold");
