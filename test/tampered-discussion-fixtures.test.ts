import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyMeshData } from "../src/verify.js";
import { loadDataFromFile } from "../src/core.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function found(report: any, check: string) {
  return report.findings.filter((f: any) => f.check === check);
}

function loadFixture(name: string) {
  const file = join(__dirname, "fixtures", `${name}.json`);
  return loadDataFromFile(file);
}

test("clean 3-turn closed discussion verifies with zero discussion findings", () => {
  const data = loadFixture("tampered-discussion-baseline");
  const report = verifyMeshData(data);
  const discussionFindings = report.findings.filter((f: any) => f.check.startsWith("discussion."));
  assert.deepEqual(discussionFindings, []);
  assert.equal(report.ok, true);
});

// --- tamper class 1: two roots ---------------------------------------------

test("two-roots-as-documented: a reversed-order second root is excluded via root_participant_mismatch, not invalidated", () => {
  // As literally specified in the source delta, the second root's from/to are
  // REVERSED vs policy.participants order — it fails root SELECTION but both
  // agents are still real participants, so the module's own global
  // fleet/participant pass has nothing to object to. This is the module's
  // documented non-invalidating root-masquerade case (design doc's
  // `root_masquerade`): it stays 'closed', matching corrected-fixtures.json's
  // execution-validated derivation exactly.
  const data = loadFixture("tampered-discussion-two-roots-as-documented");
  const report = verifyMeshData(data);
  assert.ok(found(report, "discussion.root_participant_mismatch").length > 0);
  assert.ok(found(report, "discussion.unmatched_receipt").length > 0);
  assert.equal(found(report, "discussion.derive_invalid").length, 0);
});

test("two-roots-fixed: a genuine duplicate root (matching participant order) is an error and invalidates", () => {
  const data = loadFixture("tampered-discussion-two-roots-fixed");
  const report = verifyMeshData(data);
  assert.equal(report.ok, false);
  const errs = found(report, "discussion.duplicate_root");
  assert.ok(errs.length > 0);
  assert.equal(errs[0].severity, "error");
  assert.ok(found(report, "discussion.derive_invalid").length > 0);
});

// --- tamper class 2: forked head --------------------------------------------

test("fork: two distinct completed attempts at the same head is an error and invalidates", () => {
  const data = loadFixture("tampered-discussion-fork");
  const report = verifyMeshData(data);
  assert.equal(report.ok, false);
  const errs = found(report, "discussion.fork");
  assert.equal(errs.length, 2); // both contenders get their own finding
  assert.ok(errs.every((f: any) => f.severity === "error"));
  assert.ok(found(report, "discussion.derive_invalid").length > 0);
});

// --- tamper class 3: duplicate turn ordinal --------------------------------

test("duplicate-ordinal: two attempts claiming the same turn is a fork + duplicate_turn error pair", () => {
  // Structurally identical to the fork fixture in this module's model (two
  // validated completed attempts at the same head+turn) — same finding
  // codes, per corrected-fixtures.json's own note on this fixture.
  const data = loadFixture("tampered-discussion-duplicate-ordinal");
  const report = verifyMeshData(data);
  assert.equal(report.ok, false);
  assert.equal(found(report, "discussion.fork").length, 2);
  assert.equal(found(report, "discussion.duplicate_turn").length, 2);
  assert.ok(found(report, "discussion.duplicate_turn").every((f: any) => f.severity === "error"));
});

// --- tamper class 4: invalid sender -----------------------------------------

test("invalid-sender-as-documented: a third agent outside policy.participants is participant_violation, an error", () => {
  const data = loadFixture("tampered-discussion-invalid-sender-as-documented");
  const report = verifyMeshData(data);
  assert.equal(report.ok, false);
  const errs = found(report, "discussion.participant_violation");
  assert.ok(errs.length > 0);
  assert.equal(errs[0].severity, "error");
});

test("invalid-sender-alternation: two real participants out of alternation order is invalid_sender, an error", () => {
  const data = loadFixture("tampered-discussion-invalid-sender-alternation");
  const report = verifyMeshData(data);
  assert.equal(report.ok, false);
  const errs = found(report, "discussion.invalid_sender");
  assert.ok(errs.length > 0);
  assert.equal(errs[0].severity, "error");
});

// --- tamper class 5: receipt bound to a nonexistent attempt -----------------

test("receipt-invalid-attempt: a completed receipt retargeted to a nonexistent attempt is a WARNING, not an overclaim", () => {
  // Design-doc-vs-module conflict resolved here: the doc's
  // `discussion.receipt_invalid_attempt` guessed "error". The real module
  // just excludes the orphaned completion (attempt_missing_reservation) and
  // the reply it would have authorized (unauthorized_reply) — status stays
  // 'active' per corrected-fixtures.json's actual_derivation, so both are
  // warnings under the overclaim/surprise rule, not errors.
  const data = loadFixture("tampered-discussion-receipt-invalid-attempt");
  const report = verifyMeshData(data);
  const missingReservation = found(report, "discussion.attempt_missing_reservation");
  assert.ok(missingReservation.length > 0);
  assert.equal(missingReservation[0].severity, "warning");
  const unauthorized = found(report, "discussion.unauthorized_reply");
  assert.ok(unauthorized.length > 0);
  assert.equal(unauthorized[0].severity, "warning");
  assert.equal(found(report, "discussion.derive_invalid").length, 0);
  // The excluded reservation still legitimately consumed a turn (understated
  // budget) — this is exactly the corpus the budget cross-check is for.
  const budget = found(report, "discussion.budget_turns_mismatch");
  assert.ok(budget.length > 0);
  assert.equal(budget[0].severity, "warning");
});

// --- tamper class 6: contradictory terminals --------------------------------

test("contradictory-terminals-as-documented: an incomplete-note deadman is rejected outright (malformed_receipt_note, warning)", () => {
  const data = loadFixture("tampered-discussion-contradictory-terminals-as-documented");
  const report = verifyMeshData(data);
  const malformed = found(report, "discussion.malformed_receipt_note");
  assert.ok(malformed.length > 0);
  assert.equal(malformed[0].severity, "warning");
  assert.equal(found(report, "discussion.derive_invalid").length, 0);
});

test("contradictory-terminals-fixed: an attempt with two terminal states is attempt_identity_conflict, an error", () => {
  const data = loadFixture("tampered-discussion-contradictory-terminals-fixed");
  const report = verifyMeshData(data);
  assert.equal(report.ok, false);
  const errs = found(report, "discussion.attempt_identity_conflict");
  assert.ok(errs.length > 0);
  assert.equal(errs[0].severity, "error");
});

// --- tamper class 7: post-deadline reply ------------------------------------

test("post-deadline-reply: a completion after the deadline is late_completion, a WARNING (excluded cleanly, not invalidating)", () => {
  const data = loadFixture("tampered-discussion-post-deadline-reply");
  const report = verifyMeshData(data);
  const late = found(report, "discussion.late_completion");
  assert.ok(late.length > 0);
  assert.equal(late[0].severity, "warning");
  assert.equal(found(report, "discussion.derive_invalid").length, 0);
});

// --- tamper class 8: ordinal jump --------------------------------------------

test("ordinal-jump-as-documented: bumping only the envelope's turn just makes the reply unauthorized (no real jump yet)", () => {
  const data = loadFixture("tampered-discussion-ordinal-jump-as-documented");
  const report = verifyMeshData(data);
  assert.ok(found(report, "discussion.unauthorized_reply").length > 0);
  assert.equal(found(report, "discussion.ordinal_discontinuity").length, 0);
  assert.equal(found(report, "discussion.derive_invalid").length, 0);
});

test("ordinal-jump-fixed: a turn bumped consistently across receipts AND envelope is ordinal_discontinuity, an error", () => {
  const data = loadFixture("tampered-discussion-ordinal-jump-fixed");
  const report = verifyMeshData(data);
  assert.equal(report.ok, false);
  const errs = found(report, "discussion.ordinal_discontinuity");
  assert.ok(errs.length >= 2); // inline walk-gate finding + the post-walk aggregate finding
  assert.ok(errs.every((f: any) => f.severity === "error"));
});

// --- broadcast-smuggle (tamper class 9, as scoped by this module) -----------

test("broadcast-smuggle: a discussion/v1 envelope sent as a broadcast is excluded via broadcast_forbidden, an error", () => {
  // §6's direct-only invariant. discussion.ts's own STEP-2 envelope
  // validation already rejects this (isBroadcastMessage) — verify's
  // passthrough surfaces it. Kept at ERROR despite discussion.ts not
  // invalidating the aggregate on this alone: unlike its validation-failure
  // siblings (foreign/malformed junk), this specifically evidences an
  // attempt to smuggle multi-recipient delivery into a direct-only exchange.
  const data = loadFixture("tampered-discussion-broadcast-smuggle");
  const report = verifyMeshData(data);
  const errs = found(report, "discussion.broadcast_forbidden");
  assert.ok(errs.length > 0);
  assert.equal(errs[0].severity, "error");
  assert.equal(report.ok, false);
});

// --- reply-target-mismatch (the locally-detectable slice of payload_mutation,
// tamper class 10 as scoped by this module) ----------------------------------

test("reply-target-mismatch: a completed attempt's claimed reply message disagrees with its own envelope", () => {
  // The wake-completed receipt (unchanged) still claims reply_message_id
  // 'msg-2'; msg-2's OWN envelope.reply_to was retargeted away from the
  // attempt's real head. discussion.ts's live-walk authorization never
  // even considers msg-2 anymore (it no longer replies to the head at all),
  // so att-2 is admitted only through the tail/dead-end path — which does
  // not re-check reply linkage. This is exactly the gap the new
  // reply_target_mismatch check closes.
  const data = loadFixture("tampered-discussion-reply-target-mismatch");
  const report = verifyMeshData(data);
  const errs = found(report, "discussion.reply_target_mismatch");
  assert.ok(errs.length > 0);
  assert.equal(errs[0].severity, "error");
  assert.equal(report.ok, false);
});

// --- budget-accounting consistency ------------------------------------------

test("budget-mismatch: a dangling reservation past a closed discussion understates the raw reservation count (warning)", () => {
  // A trailing 'reserved' receipt attached to the (already closed) final
  // head is never visited by the walk (close=true stops traversal before
  // any lookup past that head), so it is correctly excluded from
  // turns_used — but it is real raw reservation evidence the naive count
  // sees. canonical (2) < raw (3): understates, a warning, not an overclaim.
  const data = loadFixture("tampered-discussion-budget-mismatch");
  const report = verifyMeshData(data);
  const errs = found(report, "discussion.budget_turns_mismatch");
  assert.ok(errs.length > 0);
  assert.equal(errs[0].severity, "warning");
  // The dangling reservation itself is also generically surfaced as noise.
  assert.ok(found(report, "discussion.receipt_on_invalid_head").length > 0);
});
