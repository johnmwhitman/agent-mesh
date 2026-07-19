/**
 * Discussions layer — pure envelope/transcript/status derivation (h0.1, D1 pre-stage).
 *
 * Implements spec sections 6 (wire convention), 7 (transcript derivation), 8
 * (turn receipts), and 12 (status precedence) from
 * SUCCESSION/a2a-discussions/lane-1-cdx-discussions-api-design.md.
 *
 * Scope boundary (deliberate): this module is PURE — no ledger access, no
 * side effects, no `withLedger`/`db.ts` imports. It reads `Message[]` and
 * `Receipt[]` already resolved by a caller and derives a read-only view.
 * Reservation, wake, reply-write, and the resident supervisor (spec §§8-10,
 * delivery-order steps 3+) are deliberately NOT implemented here — those
 * touch src/core.ts and src/verify.ts, which are out of scope for this
 * pre-stage (another session holds uncommitted changes there).
 *
 * Governing principle (cdx pass-2 review): the RESERVATION is the root of
 * trust. A `reserved` receipt is the lineage root every attempt must have;
 * nothing derived from a bare, unauthorized envelope may influence
 * admission, accounting, or invalidation. Concretely:
 *   - A child is admitted only via a validated attempt whose lifecycle
 *     began with `reserved`, whose every receipt agrees on head/turn/agent/
 *     deadline, whose agent matches the head's recipient, whose completion
 *     (if any) committed at-or-before the deadline, and whose OWN
 *     `envelope.attempt_id` matches the authorizing receipt's attempt id.
 *   - `turns_used` counts the root plus the number of DISTINCT such
 *     validated reservations — never a raw/unauthenticated envelope turn.
 *   - Duplicate-turn and ordinal-continuity checks run over that validated
 *     attempt set, not over trusted-but-unauthorized parsed envelopes.
 *   - Participant/fleet violations invalidate wherever they are found —
 *     including on envelopes that never even reach the canonical head
 *     (orphans) — not only ones encountered live during the walk.
 */
import { BROADCAST, MAX_PAYLOAD_BYTES, type Message, type Receipt } from "./core.js";

// ============================================================
// §6 — Discussion wire convention
// ============================================================

export type EnvelopeKind = "question" | "result";

export interface Policy {
  participants: [string, string];
  max_turns: number;
  conversation_deadline: number;
  turn_timeout_ms: number;
}

export interface Envelope {
  $meshfleet: string;
  discussion_id: string;
  turn: number;
  attempt_id: string;
  reply_to: string | null;
  kind: EnvelopeKind;
  body: string;
  close: boolean;
  policy?: Policy;
}

/** Re-exported so callers don't need a second import just for the byte ceiling. */
export const DISCUSSION_MAX_PAYLOAD_BYTES = MAX_PAYLOAD_BYTES;

/** §11 `ask_peer` bounds: `max_turns` integer 2..32. */
export const MIN_MAX_TURNS = 2;
export const MAX_MAX_TURNS = 32;
/** §11 `ask_peer` bounds: `turn_timeout_ms` 1s..5m. */
export const MIN_TURN_TIMEOUT_MS = 1_000;
export const MAX_TURN_TIMEOUT_MS = 5 * 60_000;

/**
 * §6: "The entire serialized envelope, not merely `body`, must fit within 64 KiB."
 * D1: byte-size guard, not JS string length. Re-checked on every correlated
 * message during derivation (cdx pass-1 fix 4), not just at the original send.
 */
export function validatePayloadSize(payload: string): boolean {
  return Buffer.byteLength(payload, "utf8") <= DISCUSSION_MAX_PAYLOAD_BYTES;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** cdx pass-1 fix 4: enforce `max_turns` 2..32 and `turn_timeout_ms` 1s..5m, not just shape. */
function isPolicyShape(v: unknown): v is Policy {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  if (!Array.isArray(p.participants) || p.participants.length !== 2) return false;
  const [a, b] = p.participants;
  if (!isNonEmptyString(a) || !isNonEmptyString(b) || a === b) return false;
  if (!Number.isInteger(p.max_turns)) return false;
  if ((p.max_turns as number) < MIN_MAX_TURNS || (p.max_turns as number) > MAX_MAX_TURNS) return false;
  if (!isFiniteNumber(p.conversation_deadline)) return false;
  if (!Number.isInteger(p.turn_timeout_ms)) return false;
  if ((p.turn_timeout_ms as number) < MIN_TURN_TIMEOUT_MS || (p.turn_timeout_ms as number) > MAX_TURN_TIMEOUT_MS) {
    return false;
  }
  return true;
}

/**
 * Parses a JSON payload string into an `Envelope`. Returns null for anything
 * that isn't valid JSON or doesn't have the required discussion/v1 shape.
 * Permissive about the exact `$meshfleet` VALUE (checked in `validateEnvelope`)
 * but strict about shape: a `policy` block, if present, must satisfy
 * `isPolicyShape` (bounds included) or the whole envelope is rejected.
 */
export function parseEnvelope(payload: string): Envelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const e = parsed as Record<string, unknown>;

  if (!isNonEmptyString(e.$meshfleet)) return null;
  if (!isNonEmptyString(e.discussion_id)) return null;
  if (!Number.isInteger(e.turn) || (e.turn as number) < 1) return null;
  if (!isNonEmptyString(e.attempt_id)) return null;
  if (!("reply_to" in e) || (e.reply_to !== null && !isNonEmptyString(e.reply_to))) return null;
  if (e.kind !== "question" && e.kind !== "result") return null;
  if (typeof e.body !== "string") return null;
  if (typeof e.close !== "boolean") return null;
  if (e.policy !== undefined && !isPolicyShape(e.policy)) return null;

  return {
    $meshfleet: e.$meshfleet,
    discussion_id: e.discussion_id as string,
    turn: e.turn as number,
    attempt_id: e.attempt_id as string,
    reply_to: (e.reply_to as string | null) ?? null,
    kind: e.kind,
    body: e.body as string,
    close: e.close as boolean,
    policy: e.policy as Policy | undefined,
  };
}

export interface EnvelopeValidation {
  valid: boolean;
  reason?: string;
}

/** True when `msg` addresses more than one recipient (broadcast), per core's resolved-recipients convention. */
function isBroadcastMessage(message: Message): boolean {
  return message.to_agent_id === BROADCAST || message.recipients !== undefined;
}

/**
 * Validates a parsed envelope against the message that carried it: version,
 * broadcast prohibition, `discussion_id === correlation_id`, and the 64 KiB
 * serialized ceiling.
 */
export function validateEnvelope(envelope: Envelope | null, message: Message): EnvelopeValidation {
  if (!envelope) return { valid: false, reason: "invalid_envelope" };
  if (!validatePayloadSize(message.payload)) return { valid: false, reason: "payload_too_large" };
  if (envelope.$meshfleet !== "discussion/v1") return { valid: false, reason: "invalid_version" };
  if (isBroadcastMessage(message)) return { valid: false, reason: "broadcast_forbidden" };
  if (message.correlation_id !== envelope.discussion_id) {
    return { valid: false, reason: "correlation_mismatch" };
  }
  if (envelope.kind !== "question" && envelope.kind !== "result") {
    return { valid: false, reason: "invalid_kind" };
  }
  return { valid: true };
}

// ============================================================
// §8 — Turn receipt lifecycle parsing
// ============================================================

export type WakeState = "reserved" | "started" | "completed" | "failed" | "deadman";
const WAKE_STATES: readonly WakeState[] = ["reserved", "started", "completed", "failed", "deadman"];
const TERMINAL_STATES: readonly WakeState[] = ["completed", "failed", "deadman"];

export type ParsedReceiptAction =
  | { kind: "wake"; state: WakeState; turn: number; attempt_id: string }
  | { kind: "turn_sent"; turn: number; attempt_id: string };

/** True for any receipt action in the `discussion.*` namespace, matched or not — used to decide whether an unmatched action deserves an integrity finding. */
export function looksLikeDiscussionAction(action: string): boolean {
  return action.startsWith("discussion.");
}

/**
 * Parses `discussion.wake.<state>.v1:<turn>:<attempt>` or
 * `discussion.turn.sent.v1:<turn>:<attempt>`.
 *
 * D4: the wire format is `<name>:<turn>:<attempt>` — splitting the WHOLE
 * action on ':' yields exactly 3 parts. The name itself is dot-separated
 * into exactly 4 parts: `discussion.<event>.<state>.v1` (namespace, event,
 * state, version) — NOT 3, which is what silently discarded the real `v1`
 * suffix and made state-extraction unreachable in an earlier draft.
 */
export function parseReceiptAction(action: string): ParsedReceiptAction | null {
  const colonParts = action.split(":");
  if (colonParts.length !== 3) return null;
  const [name, turnStr, attemptId] = colonParts;

  if (!/^\d+$/.test(turnStr)) return null;
  const turn = Number(turnStr);
  if (!Number.isSafeInteger(turn) || turn < 1) return null;
  if (!isNonEmptyString(attemptId)) return null;

  const nameParts = name.split(".");
  if (nameParts.length !== 4) return null;
  const [namespace, event, state, version] = nameParts;
  if (namespace !== "discussion") return null;
  if (version !== "v1") return null;

  if (event === "wake" && (WAKE_STATES as string[]).includes(state)) {
    return { kind: "wake", state: state as WakeState, turn, attempt_id: attemptId };
  }
  if (event === "turn" && state === "sent") {
    return { kind: "turn_sent", turn, attempt_id: attemptId };
  }
  return null;
}

/** §8 note metadata, once validated: `{ discussion_id, head_message_id, deadline, reply_message_id? }`. */
interface WakeReceiptNote {
  discussion_id: string;
  head_message_id: string;
  deadline: number;
  reply_message_id?: string;
}

/**
 * Validates EVERY note field the spec requires (§8: "attached to the
 * inbound head message that authorized the wake ... discussion_id,
 * head_message_id, deadline, reply_message_id"). `head_message_id` must
 * equal the id of the message the receipt is physically attached to
 * (`receipt.message_id`) — that self-consistency is what makes "attached to
 * the authorizing head" a checkable fact rather than an assumption. A
 * `completed` receipt must also carry a non-empty `reply_message_id`.
 */
function validateWakeReceiptNote(
  receipt: Receipt,
  parsed: Extract<ParsedReceiptAction, { kind: "wake" }>,
  discussionId: string
): { ok: true; note: WakeReceiptNote } | { ok: false; reason: string } {
  if (!receipt.note) return { ok: false, reason: "missing_note" };
  let raw: unknown;
  try {
    raw = JSON.parse(receipt.note);
  } catch {
    return { ok: false, reason: "note_not_json" };
  }
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "note_not_object" };
  const n = raw as Record<string, unknown>;

  if (n.discussion_id !== discussionId) return { ok: false, reason: "note_discussion_mismatch" };
  if (n.head_message_id !== receipt.message_id) return { ok: false, reason: "note_head_mismatch" };
  if (!isFiniteNumber(n.deadline)) return { ok: false, reason: "note_deadline_invalid" };
  if (parsed.state === "completed" && !isNonEmptyString(n.reply_message_id)) {
    return { ok: false, reason: "note_missing_reply" };
  }
  if (n.reply_message_id !== undefined && !isNonEmptyString(n.reply_message_id)) {
    return { ok: false, reason: "note_reply_invalid" };
  }

  return {
    ok: true,
    note: {
      discussion_id: n.discussion_id,
      head_message_id: n.head_message_id,
      deadline: n.deadline as number,
      reply_message_id: n.reply_message_id as string | undefined,
    },
  };
}

// ============================================================
// §7 / §12 — Transcript derivation and status
// ============================================================

export interface TranscriptEntry {
  turn: number;
  message: Message;
  receipts: Receipt[];
}

export interface IntegrityFinding {
  code: string;
  message_id?: string;
  detail: string;
}

export interface AttemptInfo {
  attempt_id: string;
  turn: number;
  agent_id: string;
  state: WakeState;
  deadline: number;
  reply_message_id?: string;
}

export type DiscussionStatus =
  | "open"
  | "active"
  | "closed"
  | "exhausted"
  | "expired"
  | "deadman"
  | "invalid";

export interface DerivedDiscussion {
  discussion_id: string;
  root_message_id: string;
  fleet_id: string;
  participants: [string, string];
  policy: Policy;
  status: DiscussionStatus;
  head_message_id: string;
  turns_used: number;
  turns_remaining: number;
  transcript: TranscriptEntry[];
  attempts: AttemptInfo[];
  integrity_findings: IntegrityFinding[];
}

const EMPTY_POLICY: Policy = {
  participants: ["", ""],
  max_turns: 0,
  conversation_deadline: 0,
  turn_timeout_ms: 0,
};

function invalidResult(discussionId: string, findings: IntegrityFinding[]): DerivedDiscussion {
  return {
    discussion_id: discussionId,
    root_message_id: "",
    fleet_id: "",
    participants: ["", ""],
    policy: EMPTY_POLICY,
    status: "invalid",
    head_message_id: "",
    turns_used: 0,
    turns_remaining: 0,
    transcript: [],
    attempts: [],
    integrity_findings: findings,
  };
}

interface ValidCandidate {
  envelope: Envelope;
  message: Message;
}

/** An attempt whose ENTIRE receipt lifecycle validated: reservation-rooted, internally
 *  consistent, correctly agented, and (if completed) timely. Safe for admission + budget. */
interface ValidatedAttempt {
  attempt_id: string;
  turn: number;
  agent_id: string;
  head_message_id: string;
  state: WakeState;
  deadline: number;
  reply_message_id?: string;
}

/**
 * Derives an ordered transcript + status for one discussion from durable
 * messages and receipts. Pure and read-only (spec §7's six-step algorithm);
 * scans messages directly, not inboxes, since acknowledgment removes inbox
 * membership but never deletes messages.
 */
export function deriveDiscussion(
  discussionId: string,
  messages: Message[],
  receipts: Receipt[],
  now: number = Date.now()
): DerivedDiscussion {
  const findings: IntegrityFinding[] = [];
  let discussionInvalid = false;
  /** Every message id that has already received a specific finding — the unreachable
   *  sweep at the end only reports genuine, unexplained orphans (cdx pass-2 fix 4). */
  const explained = new Set<string>();
  /** Push a finding and, if it names a message, mark that message explained. */
  function note(finding: IntegrityFinding): void {
    findings.push(finding);
    if (finding.message_id) explained.add(finding.message_id);
  }

  // STEP 1: select messages correlated to this discussion.
  const correlated = messages.filter((m) => m.correlation_id === discussionId);
  const correlatedIds = new Set(correlated.map((m) => m.id));

  // STEP 2: parse + validate discussion/v1 envelopes; everything else is foreign/malformed.
  // A non-root envelope carrying `policy` is rejected outright (§6: "Only the root
  // carries `policy`") and invalidates the aggregate, since a compliant writer never
  // produces this. Messages rejected here never enter `valid`, so they can never be
  // double-labeled by the unreachable sweep below (which only iterates `valid`).
  const valid = new Map<string, ValidCandidate>();
  for (const msg of correlated) {
    const envelope = parseEnvelope(msg.payload);
    const validation = validateEnvelope(envelope, msg);
    if (!validation.valid || !envelope) {
      note({
        code: validation.reason ?? "invalid_envelope",
        message_id: msg.id,
        detail: `Envelope validation failed: ${validation.reason ?? "invalid_envelope"}`,
      });
      continue;
    }
    if (envelope.turn !== 1 && envelope.policy !== undefined) {
      discussionInvalid = true;
      note({
        code: "child_policy_forbidden",
        message_id: msg.id,
        detail: "Only the root envelope may carry a policy block",
      });
      continue;
    }
    valid.set(msg.id, { envelope, message: msg });
  }

  // STEP 3: find exactly one valid root. Root candidate must have
  // message.type === 'question' AND envelope.kind === 'question' — both fields
  // must independently agree.
  const rootCandidates: ValidCandidate[] = [];
  for (const candidate of valid.values()) {
    const { envelope, message } = candidate;
    if (envelope.turn !== 1 || envelope.reply_to !== null) continue;

    if (message.type !== "question" || envelope.kind !== "question") {
      note({
        code: "root_not_question",
        message_id: message.id,
        detail: `Root must be message.type='question' and envelope.kind='question'; got type='${message.type}', kind='${envelope.kind}'`,
      });
      continue;
    }
    if (!envelope.policy) {
      note({
        code: "root_missing_policy",
        message_id: message.id,
        detail: "Root envelope is missing the immutable policy block",
      });
      continue;
    }
    const [p1, p2] = envelope.policy.participants;
    if (message.from_agent_id !== p1 || message.to_agent_id !== p2) {
      note({
        code: "root_participant_mismatch",
        message_id: message.id,
        detail: `Root participants ${p1},${p2} do not match message ${message.from_agent_id},${message.to_agent_id}`,
      });
      continue;
    }
    rootCandidates.push(candidate);
  }

  if (rootCandidates.length === 0) {
    findings.push({ code: "no_valid_root", detail: "No valid discussion/v1 root found for this discussion id" });
    return invalidResult(discussionId, findings);
  }
  if (rootCandidates.length > 1) {
    for (const extra of rootCandidates.slice(1)) {
      note({
        code: "duplicate_root",
        message_id: extra.message.id,
        detail: "A second valid root was found for this discussion id",
      });
    }
    return invalidResult(discussionId, findings);
  }

  const root = rootCandidates[0];
  const policy = root.envelope.policy as Policy;
  explained.add(root.message.id);

  // root.close === true is a finding but NOT itself authoritative — closing only
  // takes effect through an authorized reply (recomputeStatus never consults the
  // root's own `close`).
  if (root.envelope.close === true) {
    note({
      code: "root_close_forbidden",
      message_id: root.message.id,
      detail: "The root envelope must not set close=true; closing only takes effect via an authorized reply",
    });
  }

  // -----------------------------------------------------------------------
  // GLOBAL structural pass: fleet membership and participant-set membership
  // invalidate wherever they are found — including on envelopes that never
  // reach a live head (orphans), AND on root-SHAPED candidates that already
  // failed root selection (cdx pass-3 fix 1) — not only ones caught live
  // during the walk. Alternation (sender/recipient ORDER) is inherently
  // position-dependent and stays in the walk below.
  //
  // A root-shaped candidate (turn === 1, reply_to === null) that lost root
  // selection is NOT exempt from fleet/participant checks: excluding it
  // entirely (a prior revision's fix) opened exactly the masquerade cdx
  // reproduced — a foreign-fleet/foreign-agent message can deliberately fail
  // root selection (e.g. by omitting `policy`) and walk away with only a
  // relatively benign `root_missing_policy` finding, never invalidating the
  // discussion even though it is transparently not this discussion's
  // traffic. Root-shaped candidates DO skip the kind/type check specifically
  // (root_not_question in STEP 3 already tests that exact same
  // type/kind agreement — re-running it here would double-label the same
  // fact under a second code, which is the over-labeling this pass must
  // avoid).
  // -----------------------------------------------------------------------
  const participantSet = new Set(policy.participants);
  const globallyValid = new Set<string>();
  for (const [msgId, candidate] of valid) {
    if (msgId === root.message.id) continue;
    const { envelope, message } = candidate;
    const isRootShaped = envelope.turn === 1 && envelope.reply_to === null;
    let ok = true;
    if (message.fleet_id !== root.message.fleet_id) {
      discussionInvalid = true;
      note({
        code: "wrong_fleet",
        message_id: msgId,
        detail: `Fleet mismatch: message fleet '${message.fleet_id}' != root fleet '${root.message.fleet_id}'`,
      });
      ok = false;
    }
    if (
      !participantSet.has(message.from_agent_id) ||
      !participantSet.has(message.to_agent_id) ||
      message.from_agent_id === message.to_agent_id
    ) {
      discussionInvalid = true;
      note({
        code: "participant_violation",
        message_id: msgId,
        detail: `Sender/recipient ${message.from_agent_id}->${message.to_agent_id} are not the discussion's two participants`,
      });
      ok = false;
    }
    if (!isRootShaped && message.type !== envelope.kind) {
      discussionInvalid = true;
      note({
        code: "kind_type_mismatch",
        message_id: msgId,
        detail: `Envelope kind '${envelope.kind}' does not match message type '${message.type}'`,
      });
      ok = false;
    }
    // Root-shaped candidates never join `globallyValid`: they are never a
    // legitimate `byReplyTo` bucket member (reply_to === null is never a walk
    // target) and never a legitimate wake-receipt head either (a wake is
    // always reserved against a real, already-canonical chain message).
    if (ok && !isRootShaped) globallyValid.add(msgId);
  }

  // -----------------------------------------------------------------------
  // Receipts pass: validate every discussion.* receipt attached to a
  // correlated message and group by attempt_id. Building `ValidatedAttempt`s
  // (the reservation-rooted, internally-consistent, correctly-agented,
  // timely set) happens in the next block — this block only parses/validates
  // individual receipts.
  // -----------------------------------------------------------------------
  interface RawWakeReceipt {
    receipt: Receipt;
    parsed: Extract<ParsedReceiptAction, { kind: "wake" }>;
    note: WakeReceiptNote;
  }
  const wakeReceiptsByAttempt = new Map<string, RawWakeReceipt[]>();

  for (const receipt of receipts) {
    if (!correlatedIds.has(receipt.message_id)) continue;
    if (!looksLikeDiscussionAction(receipt.action)) continue;

    const parsed = parseReceiptAction(receipt.action);
    if (!parsed) {
      note({
        code: "unmatched_receipt",
        message_id: receipt.message_id,
        detail: `Receipt action '${receipt.action}' does not match a known discussion lifecycle format`,
      });
      continue;
    }

    if (parsed.kind === "turn_sent") {
      const rootAttemptId = root.envelope.attempt_id;
      if (parsed.turn !== 1 || parsed.attempt_id !== rootAttemptId) {
        note({
          code: "unmatched_receipt",
          message_id: receipt.message_id,
          detail: "discussion.turn.sent receipt does not match the root attempt",
        });
      }
      continue;
    }

    // parsed.kind === "wake"
    const validated = validateWakeReceiptNote(receipt, parsed, discussionId);
    if (!validated.ok) {
      note({
        code: "malformed_receipt_note",
        message_id: receipt.message_id,
        detail: `Wake receipt note failed validation: ${validated.reason}`,
      });
      continue;
    }

    const list = wakeReceiptsByAttempt.get(parsed.attempt_id) ?? [];
    list.push({ receipt, parsed, note: validated.note });
    wakeReceiptsByAttempt.set(parsed.attempt_id, list);
  }

  // -----------------------------------------------------------------------
  // Build the validated-attempt set: the reservation is the root of trust.
  // Every check here EXCLUDES the attempt from admission/budget entirely on
  // failure (via `continue`) rather than tolerating a partial view — except
  // internal inconsistency, which also invalidates the whole discussion,
  // since it is a lineage contradiction rather than mere unauthorized noise.
  // -----------------------------------------------------------------------
  const validAttempts = new Map<string, ValidatedAttempt>();
  const rank: Record<WakeState, number> = { reserved: 0, started: 1, completed: 2, failed: 2, deadman: 2 };

  for (const [attemptId, group] of wakeReceiptsByAttempt) {
    // A `reserved` receipt is the mandatory lineage root — completed-only (or
    // started/failed/deadman-only) receipts never authorize anything.
    if (!group.some((g) => g.parsed.state === "reserved")) {
      note({
        code: "attempt_missing_reservation",
        message_id: group[0].receipt.message_id,
        detail: `Attempt '${attemptId}' has no 'reserved' receipt in its lifecycle and cannot be validated`,
      });
      continue;
    }

    const first = group[0];
    const headId = first.note.head_message_id;
    const turn = first.parsed.turn;
    const agentId = first.receipt.agent_id;
    const deadline = first.note.deadline;

    // Every receipt in this attempt's lifecycle must agree on head, turn, agent,
    // AND deadline (an immutable field once reserved) — disagreement on ANY of
    // them is a lineage contradiction, not a preference between conflicting
    // values. Picking "whichever appeared last" (order-dependent) is exactly
    // the false-deadman defect cdx flagged, so no value is trusted unless the
    // whole group agrees on it.
    let consistent = true;
    const completedReplyIds = new Set<string>();
    for (const entry of group) {
      if (
        entry.note.head_message_id !== headId ||
        entry.parsed.turn !== turn ||
        entry.receipt.agent_id !== agentId ||
        entry.note.deadline !== deadline
      ) {
        consistent = false;
      }
      if (entry.parsed.state === "completed" && entry.note.reply_message_id) {
        completedReplyIds.add(entry.note.reply_message_id);
      }
    }
    if (completedReplyIds.size > 1) consistent = false;
    const terminalsSeen = new Set(group.filter((g) => (TERMINAL_STATES as string[]).includes(g.parsed.state)).map((g) => g.parsed.state));
    if (terminalsSeen.size > 1) consistent = false;

    if (!consistent) {
      discussionInvalid = true;
      note({
        code: "attempt_identity_conflict",
        message_id: headId,
        detail: `Attempt '${attemptId}' has internally inconsistent receipts (head/turn/agent/deadline must all agree, and at most one completed reply id / terminal state is permitted)`,
      });
      continue;
    }

    // The head a receipt claims to authorize FROM must itself be a validated
    // discussion candidate — parsed, envelope-valid, AND participant/fleet-
    // valid (cdx pass-3 fix 2) — never merely "some correlated message". A
    // receipt physically attached to a legacy/malformed/foreign message
    // previously resolved its expected agent from THAT message's raw
    // to_agent_id via an unfiltered `messageById` lookup, letting a receipt
    // bound to garbage data become a legitimate live reservation that moved
    // turns_used, duplicate/ordinal checks, and status (cdx reproduced
    // `active`, `turns_used: 2` from a single reserved receipt on a
    // non-discussion message). The root is always trusted directly (it is
    // root-shaped and therefore never a `globallyValid` member per the pass
    // above, yet is obviously a legitimate head — every conversation's first
    // wake is reserved against it).
    const headMsg = headId === root.message.id ? root.message : globallyValid.has(headId) ? valid.get(headId)?.message : undefined;
    if (!headMsg) {
      note({
        code: "receipt_on_invalid_head",
        message_id: headId,
        detail: `Attempt '${attemptId}' is bound to a head that is not a validated, participant/fleet-valid discussion candidate`,
      });
      continue;
    }
    const expectedAgent = headMsg.to_agent_id;
    if (agentId !== expectedAgent) {
      note({
        code: "unauthorized_attempt_agent",
        message_id: headId,
        detail: `Attempt '${attemptId}' acted as '${agentId}', expected '${expectedAgent}'`,
      });
      continue;
    }

    // A completion must have committed AT OR BEFORE the (immutable) attempt
    // deadline and the conversation deadline (§14: "a reply wins only when
    // its completed receipt committed no later than its attempt deadline and
    // the conversation deadline"). A late completion is excluded from
    // candidacy — it never authorizes anything, and the attempt's effective
    // state falls back to whatever non-late signal remains (typically
    // 'reserved'/'started'), which the expired-attempt handling in
    // `recomputeStatus` already covers.
    const candidates = group.filter((entry) => {
      if (entry.parsed.state !== "completed") return true;
      const onTime = entry.receipt.timestamp <= deadline && entry.receipt.timestamp <= policy.conversation_deadline;
      if (!onTime) {
        note({
          code: "late_completion",
          message_id: headId,
          detail: `Attempt '${attemptId}' completed at ${entry.receipt.timestamp}, after its deadline (${deadline}) or the conversation deadline (${policy.conversation_deadline})`,
        });
      }
      return onTime;
    });

    let best = candidates[0];
    for (const entry of candidates) {
      if (rank[entry.parsed.state] >= rank[best.parsed.state]) best = entry;
    }

    validAttempts.set(attemptId, {
      attempt_id: attemptId,
      turn,
      agent_id: agentId,
      head_message_id: headId,
      state: best.parsed.state,
      deadline,
      reply_message_id: best.parsed.state === "completed" ? best.note.reply_message_id : undefined,
    });
  }

  // `validAttempts` at this point is only INTRINSICALLY self-consistent
  // (reservation-rooted, internally agreeing, correctly agented, timely) —
  // it does NOT yet establish that its head is actually on the canonical
  // chain. `completedByHead`, built from it, is still safe to use for
  // admission below: the walk only ever queries it keyed by `currentHead`,
  // which by construction only ever holds already-canonical values (root,
  // then each successively admitted winner) — an entry here for an
  // unreachable head is simply never looked up. Accounting/status,
  // however, must NOT trust this raw set (cdx pass-4) — see the
  // reachability filter applied AFTER the walk, below.
  const completedByHead = new Map<string, ValidatedAttempt[]>();
  for (const attempt of validAttempts.values()) {
    if (attempt.state !== "completed") continue;
    const list = completedByHead.get(attempt.head_message_id) ?? [];
    list.push(attempt);
    completedByHead.set(attempt.head_message_id, list);
  }

  /** Attempt ids that legitimately belong to the canonical accounting: either an
   *  admitted completed attempt, or a failed gap-filler that a later admission's
   *  continuity check validated, a validated deadman that terminated the walk at
   *  its position, or a trailing reservation at a dead end. This — NOT mere
   *  head-reachability — is what gates turns_used/attempts/status (cdx pass-5):
   *  root-shaped reachability alone let a completed attempt claiming turn 4
   *  advance the walk (transcript [1,4], attempts=[4]) before the post-walk
   *  discontinuity check ever ran. */
  const canonicalAttemptIds = new Set<string>();
  /** Attempt ids already given a specific finding — skips a redundant generic
   *  fallback note for the same attempt after the walk. */
  const attemptsExplained = new Set<string>();

  /**
   * A turn beyond the (immutable, bounded 2..32) `max_turns` budget could
   * never have been legitimately reserved by a compliant server — §11's
   * `wake_agent` "atomically checks ... remaining budget" before ever writing
   * a reservation, so a receipt claiming turn > max_turns is, structurally,
   * a receipt no correct server ever mints (cdx pass-6). Unlike a fork,
   * duplicate ordinal, or internally-contradictory attempt — which corrupt
   * the discussion's own internal logic and so invalidate the whole
   * aggregate — an over-budget attempt is a single, cleanly-excludable
   * receipt: the REST of the discussion (everything within budget) remains
   * coherently derivable on its own, and §12 rule 5 already has a named
   * state for "the turn budget is consumed" (`exhausted`) — an attempted
   * continuation past that point reads more naturally as evidence the
   * budget WAS exhausted than as a new invalidating category alongside
   * malformed-root/fork/duplicate-ordinal/participant-violation/
   * contradictory-terminal. So: flagged and excluded, not invalidating.
   */
  function isBeyondBudget(turn: number): boolean {
    return turn > policy.max_turns;
  }

  // Budget is evaluated on EVERY validated attempt here, independently of
  // reachability or continuity (cdx pass-7): a lone over-budget attempt with
  // nothing reserved before it (e.g. only a failed turn 5 against a max_turns
  // of 3) was previously invisible to this check — the turn-by-turn scans
  // below stop at the first missing turn (a normal, non-error stopping
  // condition) before ever reaching it, so it fell through to the generic
  // `receipt_on_invalid_head` fallback instead of the specific
  // `attempt_beyond_budget` finding. Flagging it here, unconditionally, means
  // the scans below never need to (and no longer do) emit this finding
  // themselves — they only need `isBeyondBudget` as an exclusion gate.
  for (const [attemptId, attempt] of validAttempts) {
    if (isBeyondBudget(attempt.turn)) {
      attemptsExplained.add(attemptId);
      note({
        code: "attempt_beyond_budget",
        message_id: attempt.head_message_id,
        detail: `Attempt '${attemptId}' claims turn ${attempt.turn}, beyond the immutable max_turns budget of ${policy.max_turns}`,
      });
    }
  }

  // -----------------------------------------------------------------------
  // STEP 4: walk the linear chain from the root. A child is admitted ONLY
  // via a matching validated completed attempt at the current head, whose
  // reply_message_id, turn, AND envelope.attempt_id all agree with the
  // candidate message (cdx pass-2 fix 1 — attempt id binding was previously
  // unchecked, so an attacker's reply could be admitted under someone else's
  // attempt id as long as turn/reply_message_id happened to match).
  // -----------------------------------------------------------------------
  const byReplyTo = new Map<string, ValidCandidate[]>();
  for (const candidate of valid.values()) {
    if (candidate.message.id === root.message.id) continue;
    const key = candidate.envelope.reply_to;
    if (key === null) continue;
    const list = byReplyTo.get(key) ?? [];
    list.push(candidate);
    byReplyTo.set(key, list);
  }

  const canonicalChain: Array<{ candidate: ValidCandidate; turn: number }> = [{ candidate: root, turn: 1 }];
  let currentHead = root.message.id;
  let currentTurn = 1;
  /** Every head the walk actually reached, root included — used only to distinguish
   *  "never reached" from "reached but rejected" in the fallback finding below. */
  const visitedHeads = new Set<string>([root.message.id]);

  /**
   * Registers a contiguous run of validated attempts bound to `headId`,
   * starting at `fromTurn`, walking one turn at a time so nothing is ever
   * reached by a jump: each FAILED entry legitimately consumed a turn with no
   * message (§6), so scanning continues to the next turn. A DEADMAN entry is
   * discussion-terminal, not a mere gap-filler (§12 rule 3, §14 "Deadman:
   * terminate the child, write deadman, close the discussion fail-closed",
   * §13 invariant "terminal states never reopen") — it is registered (so
   * status correctly resolves to `deadman` via its presence in `attempts`)
   * and scanning STOPS there; nothing legitimately follows a deadman, ever.
   * Any other state found (completed, reserved, or started) is ALSO
   * registered — it was reached by this same turn-by-turn walk, so it is
   * turn-contiguous with the current position even though it didn't (or
   * couldn't yet) advance the transcript itself (e.g. a validly
   * reserved+completed attempt whose reply message separately failed
   * admission for an unrelated reason, such as a mismatched attempt id — the
   * reservation still legitimately happened) — then scanning stops, since
   * nothing further can legitimately exist past a non-failed entry. A turn
   * with NO attempt at all simply ends the scan without registering anything
   * past it — that is a normal end of the conversation, not a discontinuity
   * (this function is never reached for a genuine unexplained jump; that is
   * gated inline, before this is ever called). A turn beyond `max_turns` is
   * excluded (already flagged by the unconditional budget pass above) —
   * failed scanning continues past it (cdx pass-6): a whole tail of
   * over-budget failed reservations (e.g. turns 4-6 after a budget of 3)
   * each independently could never have been legitimately minted and each
   * already has its own finding; an over-budget deadman is likewise not
   * discussion-terminal (it was never a legitimate reservation to begin
   * with), so scanning continues past it too, exactly like an over-budget
   * failed entry.
   */
  function registerContiguousTail(headId: string, fromTurn: number): void {
    const attemptsAtHead = Array.from(validAttempts.values()).filter((a) => a.head_message_id === headId);
    for (let t = fromTurn; ; t++) {
      const atTurn = attemptsAtHead.find((a) => a.turn === t);
      if (!atTurn) break;
      if (isBeyondBudget(atTurn.turn)) {
        // Already flagged by the unconditional budget pass above — just exclude it.
        if (atTurn.state === "failed" || atTurn.state === "deadman") continue; // keep scanning: each over-budget entry stands on its own
        break;
      }
      canonicalAttemptIds.add(atTurn.attempt_id);
      attemptsExplained.add(atTurn.attempt_id);
      if (atTurn.state === "deadman") break; // discussion-terminal (§14): nothing legitimately follows a deadman, ever
      if (atTurn.state !== "failed") break; // completed/reserved/started: nothing legitimately follows either
    }
  }

  for (;;) {
    const bucket = (byReplyTo.get(currentHead) ?? []).filter((c) => globallyValid.has(c.message.id));
    if (bucket.length === 0) {
      registerContiguousTail(currentHead, currentTurn + 1);
      break;
    }

    const prev = canonicalChain[canonicalChain.length - 1].candidate.message;
    const expectedFrom = prev.to_agent_id;
    const expectedTo = prev.from_agent_id;

    const alternationValid: ValidCandidate[] = [];
    for (const candidate of bucket) {
      if (candidate.message.from_agent_id !== expectedFrom || candidate.message.to_agent_id !== expectedTo) {
        discussionInvalid = true;
        note({
          code: "invalid_sender",
          message_id: candidate.message.id,
          detail: `Sender/recipient do not alternate: expected ${expectedFrom}->${expectedTo}, got ${candidate.message.from_agent_id}->${candidate.message.to_agent_id}`,
        });
        continue;
      }
      alternationValid.push(candidate);
    }

    const authorized: Array<{ candidate: ValidCandidate; attempt: ValidatedAttempt }> = [];
    const candidateAttempts = completedByHead.get(currentHead) ?? [];
    for (const candidate of alternationValid) {
      const attempt = candidateAttempts.find(
        (a) =>
          a.reply_message_id === candidate.message.id &&
          a.turn === candidate.envelope.turn &&
          a.attempt_id === candidate.envelope.attempt_id
      );
      if (attempt) {
        authorized.push({ candidate, attempt });
        explained.add(candidate.message.id);
      } else {
        note({
          code: "unauthorized_reply",
          message_id: candidate.message.id,
          detail: `No validated, agent-authorized completed wake attempt (matching reply id, turn, AND attempt id) admits this reply at head '${currentHead}'`,
        });
      }
    }

    if (authorized.length === 0) {
      registerContiguousTail(currentHead, currentTurn + 1);
      break; // dead end
    }
    if (authorized.length > 1) {
      discussionInvalid = true;
      for (const contender of authorized) {
        note({
          code: "fork",
          message_id: contender.candidate.message.id,
          detail: `Two or more authorized replies target head '${currentHead}'`,
        });
      }
      break; // canonical head does not advance past an authorized fork
    }

    const { candidate: winner, attempt } = authorized[0];

    // Budget gate (cdx pass-6): a winner claiming a turn beyond max_turns could
    // never have been legitimately reserved (see `isBeyondBudget`; already
    // flagged by the unconditional budget pass above) — checked BEFORE
    // continuity, since an over-budget winner is rejected outright regardless
    // of whether the gap leading to it would otherwise have been explainable.
    if (isBeyondBudget(attempt.turn)) {
      break; // nothing advances via a reply that could never have been legitimately authorized
    }

    // INLINE turn-continuity gate (cdx pass-5, corrected cdx pass-7): §7 step
    // 4's "child corresponds to a valid authorized attempt" plus §6's turn
    // accounting together mean a winner may only advance the walk if its turn
    // is REACHABLE from the current position — either immediately next, or
    // after every intervening turn number was itself a validated FAILED
    // reservation at this SAME head (§15 test 14: a failed attempt
    // legitimately leaves a MESSAGE-chain gap, because it still consumed its
    // turn — but the RESERVATION sequence itself is never allowed to skip a
    // turn nothing was ever reserved for). Checking this AFTER admission (a
    // prior design) let a discontinuous winner pollute transcript/head/
    // attempts/turns_used before a post-walk check could invalidate the
    // aggregate; checking it HERE means an illegitimate jump simply never
    // advances anything in the first place.
    //
    // DEADMAN is explicitly NOT a legitimate filler (a pass-6 misreading,
    // corrected in pass-7): §12 rule 3 ranks deadman ABOVE expired/exhausted,
    // §13 invariant "terminal states never reopen", and §14 is explicit —
    // "Deadman: terminate the child, write deadman, close the discussion
    // fail-closed." A deadman is discussion-terminal, not attempt-local: if
    // one is found anywhere in the gap before this winner, the winner is
    // never admitted (the discussion had already ended), the deadman itself
    // is registered (so status resolves to `deadman`), and the walk stops —
    // without invalidating (a deadman is an ordinary, spec-sanctioned
    // terminal outcome, not a corruption signal).
    const attemptsAtThisHead = Array.from(validAttempts.values()).filter((a) => a.head_message_id === currentHead);
    let gapOk = attempt.turn > currentTurn;
    let deadmanEncountered: ValidatedAttempt | null = null;
    const fillers: ValidatedAttempt[] = [];
    for (let t = currentTurn + 1; gapOk && t < attempt.turn; t++) {
      const filler = attemptsAtThisHead.find((a) => a.turn === t);
      if (filler && !isBeyondBudget(filler.turn) && filler.state === "deadman") {
        deadmanEncountered = filler;
        gapOk = false;
        break;
      }
      // The `isBeyondBudget` check here is defensive/redundant in practice (the
      // winner's own turn is already gated above, and every filler's turn is
      // strictly less than it), but cdx asked for the bound enforced at all
      // three sites explicitly, not inferred transitively from one of them.
      if (!filler || filler.state !== "failed" || isBeyondBudget(filler.turn)) {
        gapOk = false;
        break;
      }
      fillers.push(filler);
    }

    if (deadmanEncountered) {
      for (const filler of fillers) {
        canonicalAttemptIds.add(filler.attempt_id);
        attemptsExplained.add(filler.attempt_id);
      }
      canonicalAttemptIds.add(deadmanEncountered.attempt_id);
      attemptsExplained.add(deadmanEncountered.attempt_id);
      // NOTE (cdx pass-8, documented deliberately, not an oversight): reaching
      // a deadman here does NOT itself force `discussionInvalid = true`, nor
      // does it short-circuit the POST-WALK duplicate-turn / structural checks
      // below — those still run over every validated attempt bound to a
      // reached head, deadman or not. So a malformed ledger that pairs a
      // legitimate deadman with, e.g., a SECOND distinct attempt also
      // claiming the deadman's own turn (a duplicate ordinal), or a fleet/
      // participant violation on some other reached-head candidate, can still
      // elevate the final status to `invalid` — which outranks `deadman` in
      // §12's precedence. This is intentional: a deadman is an ordinary
      // terminal outcome and must not act as a "free pass" that suppresses a
      // genuine corruption signal detected elsewhere in the same ledger. See
      // the P3-6 vs P3-8 tests: an otherwise-clean deadman reports `deadman`;
      // a deadman ledger that ALSO contains a duplicate/malformed reached-head
      // attempt reports `invalid` instead, by ordinary precedence — not by any
      // special-casing here.
      break; // discussion ended at the deadman; the later winner is never reached
    }

    if (!gapOk) {
      discussionInvalid = true;
      attemptsExplained.add(attempt.attempt_id);
      note({
        code: "ordinal_discontinuity",
        message_id: currentHead,
        detail: `Attempt '${attempt.attempt_id}' claims turn ${attempt.turn} directly from turn ${currentTurn} at head '${currentHead}' without a validated failed reservation for every intervening turn`,
      });
      break; // nothing advances past an unexplained jump
    }

    for (const filler of fillers) {
      canonicalAttemptIds.add(filler.attempt_id);
      attemptsExplained.add(filler.attempt_id);
    }
    canonicalAttemptIds.add(attempt.attempt_id);
    attemptsExplained.add(attempt.attempt_id);

    canonicalChain.push({ candidate: winner, turn: attempt.turn });
    currentHead = winner.message.id;
    currentTurn = attempt.turn;
    visitedHeads.add(currentHead);

    if (winner.envelope.close === true) {
      break; // close only takes effect via an authorized reply; stop traversal there
    }
  }

  const transcript: TranscriptEntry[] = canonicalChain.map(({ candidate, turn }) => ({
    turn,
    message: candidate.message,
    receipts: receipts.filter((r) => r.message_id === candidate.message.id),
  }));

  // Orphan/unreachable correlated envelopes get an integrity finding instead of
  // silently vanishing — but only genuinely unexplained ones. Every specific
  // rejection above already ran through `note()`, which marks its message
  // explained, so a root-shaped-but-rejected message (say, `root_not_question`)
  // is never ALSO double-labeled `unreachable_envelope` here.
  for (const [msgId] of valid) {
    if (explained.has(msgId)) continue;
    findings.push({
      code: "unreachable_envelope",
      message_id: msgId,
      detail: "Valid discussion/v1 envelope never connects to the canonical chain from the root",
    });
  }

  // -----------------------------------------------------------------------
  // Canonical accounting set (cdx pass-4 + pass-5 + pass-7): an attempt is
  // authoritative for turns_used/attempts/status ONLY if `canonicalAttemptIds`
  // — built INLINE, during the walk itself, from admitted winners, the FAILED
  // gap-fillers each admission's own continuity check validated, a validated
  // DEADMAN that terminated the walk at its position (never a gap-filler —
  // see the walk's comments), or a trailing dead-end reservation — actually
  // contains it. Mere head-reachability (`visitedHeads`) is NOT sufficient on
  // its own: root is always reachable, yet a completed attempt claiming turn
  // 4 directly off root, with no reservation ever made for turns 2-3, must
  // NOT count just because its head (root) is legitimate (cdx pass-5's exact
  // repro). Any validated attempt not in `canonicalAttemptIds` gets a
  // fallback finding here UNLESS it was already given a specific one
  // (`attemptsExplained` — e.g. the unconditional budget pass already flagged
  // it, or the discontinuous winner already got `ordinal_discontinuity`).
  // -----------------------------------------------------------------------
  const canonicalAttempts = new Map<string, ValidatedAttempt>();
  for (const [attemptId, attempt] of validAttempts) {
    if (canonicalAttemptIds.has(attemptId)) {
      canonicalAttempts.set(attemptId, attempt);
    } else if (!attemptsExplained.has(attemptId)) {
      note({
        code: "receipt_on_invalid_head",
        message_id: attempt.head_message_id,
        detail: visitedHeads.has(attempt.head_message_id)
          ? `Attempt '${attemptId}' is bound to a reached head but is not part of the continuous canonical reservation sequence`
          : `Attempt '${attemptId}' is bound to a head the canonical walk never reached from the root`,
      });
    }
  }

  // Duplicate-turn and ordinal-continuity checks are kept POST-WALK too, for
  // reporting — scoped to every validated attempt bound to a REACHED head
  // (broader than `canonicalAttempts`, which by construction can never itself
  // contain a duplicate or a gap: the inline gate above only ever adds a
  // strictly-increasing, gap-filled sequence). This is what still catches,
  // e.g., an authorized FORK (two distinct attempts both claiming turn 2 off
  // root) — neither one reaches `canonicalAttemptIds` since the walk breaks
  // before registering either, so only this broader pass surfaces the
  // duplicate for the record. Over-budget attempts (turn > max_turns) are
  // excluded from this scan (cdx pass-6): they are already indivdually
  // flagged and excluded via `attempt_beyond_budget`, a non-invalidating
  // exclusion — without this filter, a lone over-budget attempt with no
  // legitimate lead-in (e.g. a completed reply claiming turn 5 against a
  // budget of 3, with nothing reserved for turns 2-4) would misleadingly
  // read as an `ordinal_discontinuity` here, incorrectly invalidating a
  // discussion whose only real problem was already handled as a plain
  // budget rejection.
  const turnToAttemptIds = new Map<number, string[]>();
  for (const attempt of validAttempts.values()) {
    if (!visitedHeads.has(attempt.head_message_id)) continue;
    if (isBeyondBudget(attempt.turn)) continue;
    const list = turnToAttemptIds.get(attempt.turn) ?? [];
    list.push(attempt.attempt_id);
    turnToAttemptIds.set(attempt.turn, list);
  }
  for (const [turn, attemptIds] of turnToAttemptIds) {
    if (attemptIds.length > 1) {
      discussionInvalid = true;
      for (const attemptId of attemptIds) {
        const attempt = validAttempts.get(attemptId)!;
        note({
          code: "duplicate_turn",
          message_id: attempt.head_message_id,
          detail: `Turn ${turn} is claimed by more than one validated reservation (attempt '${attemptId}')`,
        });
      }
    }
  }
  const distinctTurnsSorted = Array.from(turnToAttemptIds.keys()).sort((a, b) => a - b);
  for (let i = 0; i < distinctTurnsSorted.length; i++) {
    const expected = 2 + i;
    if (distinctTurnsSorted[i] !== expected) {
      discussionInvalid = true;
      findings.push({
        code: "ordinal_discontinuity",
        detail: `Validated reservations jump to turn ${distinctTurnsSorted[i]} without a turn ${expected} ever being reserved`,
      });
      break; // one finding sufficiently explains the discontinuity
    }
  }

  // turns_used = root (1) plus the count of DISTINCT CANONICAL validated
  // reservations — never a raw/unauthenticated envelope turn, never
  // counting wrong-agent or completed-only (unreserved) attempts, and never
  // counting an attempt bound to an unreachable head, all excluded above.
  const turnsUsed = 1 + canonicalAttempts.size;
  const turnsRemaining = Math.max(0, policy.max_turns - turnsUsed);

  const attempts: AttemptInfo[] = Array.from(canonicalAttempts.values()).map((a) => ({
    attempt_id: a.attempt_id,
    turn: a.turn,
    agent_id: a.agent_id,
    state: a.state,
    deadline: a.deadline,
    reply_message_id: a.reply_message_id,
  }));

  const status = recomputeStatus({
    invalid: discussionInvalid,
    transcript,
    rootMessageId: root.message.id,
    attempts,
    policy,
    now,
    turnsUsed,
  });

  return {
    discussion_id: discussionId,
    root_message_id: root.message.id,
    fleet_id: root.message.fleet_id,
    participants: policy.participants,
    policy,
    status,
    head_message_id: currentHead,
    turns_used: turnsUsed,
    turns_remaining: turnsRemaining,
    transcript,
    attempts,
    integrity_findings: findings,
  };
}

export interface StatusInput {
  invalid: boolean;
  transcript: TranscriptEntry[];
  /** The root's message id — its own `close` flag is never authoritative. */
  rootMessageId: string;
  attempts: AttemptInfo[];
  policy: Policy;
  now: number;
  /** Root (1) plus distinct validated reservations — computed once by the caller so
   *  "accounting" has a single, auditable source (cdx pass-2 fix 2). */
  turnsUsed: number;
}

/**
 * §12 fail-closed status precedence:
 *   invalid > closed > deadman > expired > exhausted > active > open.
 *
 * More than one simultaneously-live (reserved or started) attempt — REGARDLESS
 * of whether one, both, or neither has already passed its own deadline —
 * invalidates (invariant "at most one attempt is active per discussion"; a
 * mix of one expired-stranded and one still-future live attempt is just as
 * much a violation as two unexpired ones, cdx pass-2 fix 3). Only once at
 * most one live attempt remains does an individually-expired-but-unswept
 * one get treated as `deadman` (fail-closed: it will never complete, so
 * there's no reason to wait for the sweeper to say so).
 */
export function recomputeStatus(input: StatusInput): DiscussionStatus {
  const { invalid, transcript, rootMessageId, attempts, policy, now, turnsUsed } = input;

  const liveAttempts = attempts.filter((a) => a.state === "reserved" || a.state === "started");

  if (invalid || liveAttempts.length > 1) return "invalid";

  for (const entry of transcript) {
    if (entry.message.id === rootMessageId) continue; // root's own close is never authoritative
    const envelope = parseEnvelope(entry.message.payload);
    if (envelope?.close === true) return "closed";
  }

  const soleLive = liveAttempts[0];
  if (attempts.some((a) => a.state === "deadman") || (soleLive && soleLive.deadline <= now)) return "deadman";

  if (now > policy.conversation_deadline) return "expired";

  if (turnsUsed >= policy.max_turns) return "exhausted";

  if (soleLive && soleLive.deadline > now) return "active";

  return "open";
}
