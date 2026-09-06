/**
 * Ledger integrity verification (v0.13) — the read side of "prove it".
 *
 * The write path enforces these invariants transactionally; verify re-derives
 * them from a snapshot so a ledger can be AUDITED after the fact — hand-edited,
 * migrated, copied between machines, or written by an older version. Every
 * check corresponds to a guarantee the write path makes:
 *
 *   - receipts are keyed `${message_id}:${agent_id}:${action}` (the idempotency
 *     guarantee) and always point at a real message, never before it in time.
 *   - a message's derived `acknowledged` flag is true iff every addressed
 *     recipient holds an 'ack' receipt; an 'ack' consumes the inbox entry.
 *   - a ratification's quorum fits its voter set, signoffs are voters, no agent
 *     holds both polarities on one proposal, and a terminal status recomputes
 *     from the receipts via the canonical tally (ratify.computeTally).
 *
 * Severity: "error" = the ledger asserts something its own records do not
 * support (audit-breaking). "warning" = surprising but not overclaiming —
 * e.g. receipts from agents this ledger never registered (cross-attached
 * fleets do this legitimately), or an acknowledged flag that UNDERstates.
 *
 * Read-only by design: verification never mutates the ledger it audits.
 */
import { existsSync } from "fs";
import { BROADCAST, SEALED_FLEET_STATUSES, TERMINAL_AGENT_STATUSES, fleetLatticeOutcome, isRoutableCapability, isUsableAgentId, messageRecipients, type MeshData, type Message, type Receipt } from "./core.js";
import { MAX_TOTAL_WEIGHT, MAX_VOTE_WEIGHT, computeTally, parseVoteAction } from "./ratify.js";
import { deriveDiscussion, parseEnvelope, parseReceiptAction } from "./discussion.js";
import { readLedger } from "./db.js";
import { readLifecycleSnapshot, readLifecycleSnapshotFile, verifyLifecycleSnapshot } from "./lifecycle-visibility.js";
import { runtimeModelsMatch } from "./spawn-result.js";

/**
 * Discussion integrity-finding codes (src/discussion.ts) that get ERROR
 * severity when passed through as `discussion.<code>` verify findings.
 * Everything NOT in this set is a WARNING. The rule, applied uniformly: a
 * code is an ERROR iff discussion.ts's OWN derivation treats it as a lineage/
 * authorization contradiction — i.e. it either sets `discussionInvalid`
 * internally, or is one of the two immediate `invalidResult` returns
 * (`no_valid_root`, `duplicate_root`). Every other discussion.ts finding is
 * something the module's own architecture already excludes safely without
 * corrupting the rest of the derivation (its own phrase, re:
 * `attempt_beyond_budget`: "flagged and excluded, not invalidating") — a
 * surprise for an auditor, not an overclaim by the ledger, so it is a
 * warning here for the same reason `receipt.unknown_agent` is a warning
 * above: real, legitimate ledgers produce this finding too.
 *
 * This deliberately DIVERGES from SUCCESSION/a2a-discussions/drafts/
 * verify-discussion-checks.md, which predates validation against the real
 * module and calls every named check "error". The corrected, execution-
 * validated fixtures (SUCCESSION/a2a-discussions/staged-code/
 * corrected-fixtures.json) show several of the doc's "error" calls do NOT
 * flip a discussion to status:'invalid' on their own — `attempt_missing_
 * reservation` (fixture 7, receipt_invalid_attempt): status stays 'active';
 * `malformed_receipt_note` (fixture 8, contradictory_terminals-as-
 * documented): status stays 'closed'; `late_completion` (fixture 10,
 * post_deadline_reply): status stays 'active'; `unauthorized_reply` /
 * `receipt_on_invalid_head` (fixture 11, ordinal_jump-as-documented):
 * status stays 'open'. Downgraded to warning here to match discussion.ts's
 * own precedence, not the doc's pre-validation guess.
 *
 * `broadcast_forbidden` is the one deliberate exception kept at ERROR
 * despite never setting `discussionInvalid`: unlike its STEP-2 envelope-
 * validation siblings (`invalid_envelope`/`payload_too_large`/
 * `invalid_version`/`correlation_mismatch`/`invalid_kind` — foreign or
 * malformed traffic that merely happens to share a correlation id), a
 * broadcast-shaped discussion/v1 envelope is itself an active attempt to
 * smuggle multi-recipient delivery into the direct-only invariant (§6) —
 * the design doc's call for this one code is kept as-is.
 */
const DISCUSSION_ERROR_CODES = new Set<string>([
  "child_policy_forbidden",
  "no_valid_root",
  "duplicate_root",
  "wrong_fleet",
  "participant_violation",
  "kind_type_mismatch",
  "attempt_identity_conflict",
  "invalid_sender",
  "fork",
  "ordinal_discontinuity",
  "duplicate_turn",
  "broadcast_forbidden", // deliberate override — see comment above
]);

export interface VerifyFinding {
  severity: "error" | "warning";
  /** Machine-readable check id, e.g. "receipt.orphan_message". */
  check: string;
  /** The offending entity: a receipt key, message id, agent id, ... */
  subject: string;
  detail: string;
}

/**
 * What a passing verification does and does not establish.
 *
 * `ok: true` is routinely over-read as "this ledger is untampered". It is not,
 * and the gap is not obvious from the outside: five independent LLM reviewers,
 * handed a one-line description of this project, each concluded the verifier
 * checked a cryptographic hash chain. It does not. It re-derives every claim
 * from the ledger's own records — which is exactly the material an editor with
 * write access would also have changed.
 *
 * That boundary is deliberate and documented in the README (signing and
 * auditor-grade attestation are a separate concern; signatures never enter this
 * core). Shipping the boundary *inside the report* means it travels with the
 * artifact instead of living only in prose the reader may never see.
 */
export interface VerifyScope {
  /** What a pass DOES establish. */
  covers: string;
  /** What a pass does NOT establish. */
  excludes: string;
}

export const VERIFY_SCOPE: VerifyScope = {
  covers:
    "internal consistency — every receipt, flag, inbox entry, and ratification tally is supported by the ledger's own records",
  excludes:
    "authenticity — there is no hash chain or signature here, so an edit that rewrites the ledger consistently is indistinguishable from honest history",
};

export interface VerifyReport {
  /** True when no errors were found (warnings allowed). */
  ok: boolean;
  /** The guarantee boundary. Constant today; a field so callers read it rather than assume it. */
  scope: VerifyScope;
  errors: number;
  warnings: number;
  counts: {
    fleets: number;
    agents: number;
    messages: number;
    receipts: number;
    ratifications: number;
  };
  findings: VerifyFinding[];
}

/** True when every addressed recipient of `msg` holds an 'ack' receipt — the same derivation _writeReceipt uses. */
/**
 * Does this row carry an identity of its own to compare its map key against?
 *
 * Guarded rather than assumed: a row whose `id` is absent or blank has not made
 * a competing claim, so there is nothing to disagree with. Reporting a mismatch
 * there would turn every legitimately id-less legacy row into a hard error —
 * the same false-positive shape the capability checks already normalize around.
 */
function hasUsableId(row: { id?: unknown } | undefined): row is { id: string } {
  return typeof row?.id === "string" && row.id.length > 0;
}

function derivedAcknowledged(msg: Message, validatedAckReceipts: ReadonlySet<string>): boolean {
  return messageRecipients(msg).every((r) => validatedAckReceipts.has(`${msg.id}:${r}:ack`));
}

/** Verify a MeshData snapshot. Pure and read-only; `now` only affects deadline-dependent tally recomputation. */
export function verifyMeshData(data: MeshData, now: number = Date.now()): VerifyReport {
  const findings: VerifyFinding[] = [];
  const error = (check: string, subject: string, detail: string): void => {
    findings.push({ severity: "error", check, subject, detail });
  };
  const warning = (check: string, subject: string, detail: string): void => {
    findings.push({ severity: "warning", check, subject, detail });
  };

  const receipts = data.receipts ?? {};
  const ratifications = data.ratifications ?? {};

  // --- fleets ---------------------------------------------------------------
  // Fixing the writer does nothing for a ledger that already holds the bad row,
  // which is exactly what this audit is for. Before the completion lattice, a
  // crash left the fleet at `running` with every one of its agents terminal —
  // a projection that contradicts its own rows. The startup reconciler repairs
  // these, so the audit should be able to see any that a reconciler has not
  // reached (an export, a read-only copy, a ledger written by an older build).
  //
  // Warning, not error: the rows are internally consistent and nothing is
  // overclaimed by them — the fleet's own agents state the truth plainly. It is
  // a stale projection, not a forged one.
  for (const [key, f] of Object.entries(data.fleets)) {
    if (hasUsableId(f) && key !== f.id) {
      error(
        "fleet.key_mismatch",
        key,
        `fleet stored under key "${key}" but its body claims id "${f.id}" — the map name and the row's own identity are different facts, and every join in this ledger picks one of them`
      );
    }
    // The container every lifecycle comparison in this file is made AGAINST —
    // each one scoped to the fleet the row itself names — and until now the one
    // timestamp nothing validated. Agents, messages and receipts each get an
    // `*.invalid_timestamp` error; `fleet.created_at` is READ three times below
    // (`agent.tampered_timestamp` ×2, and `message.tampered_timestamp`) and was
    // checked nowhere.
    //
    // That asymmetry is not cosmetic, it is load-bearing in the wrong
    // direction: `<` against a non-finite right-hand side evaluates false, so
    // degrading this one field makes all three tamper findings silently NOT
    // fire — and the fleet drew no finding of its own to replace them. A
    // ledger whose agents start and whose messages are sent before their fleet
    // existed verified `ok: true` with `created_at` set to null, absent, NaN,
    // Infinity, or a non-numeric string. This is reachable from a real FILE,
    // not only from a hand-built object: `null`, an absent key and a string all
    // survive a JSON round-trip verbatim, and NaN/±Infinity arrive as `null`
    // because that is what `JSON.stringify` emits for them — a different value
    // that lands in the same hole. The audit went quiet in both directions at
    // once, which is the failure this product exists to prevent.
    //
    // Error, not warning: every sibling `*.invalid_timestamp` is an error, and
    // `created_at` is REQUIRED by the `Fleet` type — so "missing or non-finite"
    // is the message/receipt wording, not the agent wording (theirs guards
    // optional fields and exempts `undefined`).
    //
    // Deliberately BEFORE the empty-fleet `continue` below. A fleet row's own
    // timestamp is valid or not on its own terms; whether the ledger happens to
    // hold agents for it is a different fact, and an empty fleet is exactly the
    // shape an export or a partial copy produces.
    if (!Number.isFinite(f.created_at)) {
      error(
        "fleet.invalid_timestamp",
        f.id,
        `fleet ${f.id} has a missing or non-finite created_at — the lifecycle comparisons for THIS fleet's own agents and messages are made against it, and each of those silently passes while it cannot be ordered`
      );
    }
    const fleetAgents = Object.values(data.agents).filter((a) => a.fleet_id === f.id);
    // An EMPTY fleet is deliberately excluded from BOTH directions below:
    // `[].every(...)` is vacuously true, and such a fleet is stuck rather than
    // finished. health.ts makes the same distinction, and the two must not
    // disagree.
    if (fleetAgents.length === 0) continue;

    // The OVERCLAIM direction. `complete` and `failed` are sealed — a recompute
    // must never rewrite them — so a sealed fleet is the ledger's final word on
    // that work. If one of its agents is still live, that word is false, and
    // `core.ts` makes the argument itself in the comment that justifies the
    // `abandoned` status: `complete` "claims work that never happened".
    //
    // Error, not warning, and this is the asymmetry that matters: the
    // underclaim below is a stale projection the fleet's own agents contradict
    // in the reader's favour, while this asserts finished work over an agent
    // that has not finished. An evidence product cannot report that clean.
    //
    // `abandoned` is deliberately NOT in this set. `attach_agent` reopens an
    // abandoned fleet and injects a live replacement, so `abandoned` alongside
    // a running agent is a legitimate transient state — flagging it would put a
    // hard error on the only recovery path the lattice offers.
    // Fleet-level crash provenance with nothing in the fleet to support it.
    // The writer sets `stopped_reason` only when the fleet is `abandoned` AND
    // every interrupted member carries `server_crash`, so at write time at
    // least one member did. Members are never removed (`attach_agent` only
    // adds) and no path clears a member's reason, so a fleet asserting a shared
    // crash cause while NO member's row records one is claiming an external
    // event its own records do not support.
    //
    // Two neighbouring states are deliberately NOT flagged, because both are
    // honestly reachable: (1) a non-`abandoned` fleet carrying the field —
    // `attach_agent` reopens an abandoned fleet and clears `completed_at` but
    // not `stopped_reason`, so the residue is real history, not a lie; and
    // (2) a MIX of `server_crash` and `process_lost` members, which that same
    // reopen-and-re-abandon path produces. Only the zero-support case has no
    // honest producer, and a check that fires on legitimate states trains an
    // operator to filter the channel — the failure mode this repo already
    // learned from its sweeper.
    if (f.status === "abandoned" && f.stopped_reason !== undefined) {
      const supporting = fleetAgents.filter(
        (a) => a.status === "interrupted" && a.stopped_reason === "server_crash"
      );
      if (supporting.length === 0) {
        error(
          "fleet.crash_provenance_unsupported",
          f.id,
          `fleet ${f.id} is recorded abandoned with stopped_reason=${f.stopped_reason}, but not one of its ${fleetAgents.length} agents carries an interrupted row attributing the crash — the fleet asserts a shared cause its own records do not support`
        );
      }
    }

    if (SEALED_FLEET_STATUSES.has(f.status)) {
      const live = fleetAgents.filter((a) => !TERMINAL_AGENT_STATUSES.has(a.status));
      if (live.length > 0) {
        error(
          "fleet.sealed_with_live_agents",
          f.id,
          `fleet ${f.id} is sealed as ${f.status}, but ${live.length} of its ${fleetAgents.length} agents ${live.length === 1 ? "is" : "are"} still ${JSON.stringify(live.map((a) => a.status))} (${JSON.stringify(live.map((a) => a.id))}) — a sealed fleet claims work that its own agents say never finished`
        );
        continue;
      }
      // Every agent is terminal, so the check above is silent — and that is
      // exactly where the sharper forgery hides. A fleet sealed `complete` over
      // a `failed` or `interrupted` agent claims SUCCESS over work its own rows
      // say did not succeed, and the lattice that decides the write is a pure
      // function of those same rows, so the disagreement is fully local.
      // `core.ts` names both halves: `complete` "claims work that never
      // happened", `failed` "claims an error that never occurred".
      const outcome = fleetLatticeOutcome(fleetAgents);
      if (outcome !== undefined && outcome !== f.status) {
        const detail = `fleet ${f.id} is sealed as ${f.status}, but its own agents (${JSON.stringify(fleetAgents.map((a) => a.status))}) recompute to ${outcome}`;
        // Split by DIRECTION, exactly as `message.ack_flag_mismatch` does, and
        // for the same reason. Sealed `complete` over an agent that failed or
        // was interrupted claims a success the rows deny — an overclaim, and an
        // error. Sealed `failed` over agents that all completed asserts an
        // error that never occurred, which is false but claims LESS than the
        // records support; that is the understating direction, and this repo
        // reports understatement as a warning rather than pretending the two
        // are equally dangerous to a reader.
        if (f.status === "complete") {
          error("fleet.sealed_lattice_mismatch", f.id, `${detail} — a sealed success over work its own rows say did not succeed`);
        } else {
          warning("fleet.sealed_lattice_mismatch", f.id, `${detail} (understates; a fleet recorded ${f.status} whose agents all reached ${outcome} claims an outcome worse than its records support)`);
        }
      }
      continue;
    }

    // The UNDERCLAIM direction: still open while every agent has finished.
    if (f.status !== "running" && f.status !== "pending") continue;
    if (!fleetAgents.every((a) => TERMINAL_AGENT_STATUSES.has(a.status))) continue;
    warning(
      "fleet.unreconciled_status",
      f.id,
      `fleet ${f.id} is recorded as ${f.status} but all ${fleetAgents.length} of its agents have finished — the fleet status was never recomputed`
    );
  }

  // --- agents ---------------------------------------------------------------
  for (const [key, a] of Object.entries(data.agents)) {
    if (hasUsableId(a) && key !== a.id) {
      error(
        "agent.key_mismatch",
        key,
        `agent stored under key "${key}" but its body claims id "${a.id}" — receipts, inboxes and fleet membership all join on one of these two, so they cannot disagree`
      );
    }
    const startedAtValid = a.started_at === undefined || Number.isFinite(a.started_at);
    const completedAtValid = a.completed_at === undefined || Number.isFinite(a.completed_at);
    if (!startedAtValid) {
      error("agent.invalid_timestamp", a.id, `agent ${a.id} has a present but non-finite started_at timestamp`);
    }
    if (!completedAtValid) {
      error("agent.invalid_timestamp", a.id, `agent ${a.id} has a present but non-finite completed_at timestamp`);
    }
    if (!data.fleets[a.fleet_id]) {
      warning("agent.orphan_fleet", a.id, `agent ${a.id} references fleet ${a.fleet_id}, which this ledger does not hold`);
    } else {
      const fleet = data.fleets[a.fleet_id];
      if (fleet && startedAtValid && a.started_at !== undefined && a.started_at < fleet.created_at) {
        error("agent.tampered_timestamp", a.id, `agent started before fleet was created`);
      }
      if (fleet && completedAtValid && a.completed_at !== undefined && a.completed_at < fleet.created_at) {
        error("agent.tampered_timestamp", a.id, `agent completed before fleet was created`);
      }
    }
    if (
      startedAtValid &&
      completedAtValid &&
      a.started_at !== undefined &&
      a.completed_at !== undefined &&
      a.completed_at < a.started_at
    ) {
      error("agent.tampered_timestamp", a.id, `agent completed before it started`);
    }
    // One row asserting both "still in progress" and "already finished". The
    // write path sets status and completed_at in the same statement and refuses
    // to touch an agent that already has one, so the two cannot come apart
    // honestly. This matters beyond the row itself: the fleet lattice keys on
    // status alone, so a non-terminal agent carrying a completion timestamp
    // holds its whole fleet open while presenting as done to anything reading
    // timestamps.
    if (!TERMINAL_AGENT_STATUSES.has(a.status) && a.completed_at !== undefined) {
      error(
        "agent.completed_while_live",
        a.id,
        `agent ${a.id} is recorded ${a.status} but carries completed_at=${a.completed_at} — the same row claims it is still running and that it has already finished`
      );
    }

    // Two fields that ONLY a settle can produce, on a row that says it has not
    // settled. Same shape as `completed_while_live` above, reached through the
    // schema that arrived after that check was written.
    //
    // The bound is deliberately `pending`/`running` and not "anything that is
    // not `interrupted`". Both fields are legitimately CARRIED by rows that
    // moved on: nothing clears `stopped_reason` when the durable projection
    // later writes `complete`/`failed` over a previously interrupted row
    // (`lifecycle-execution.ts` projectPending), and flagging that would put an
    // error on an honest history. What has no honest producer at all is either
    // field on a row that has not reached a terminal state — every writer sets
    // them in the same statement that writes a terminal status.
    if (!TERMINAL_AGENT_STATUSES.has(a.status)) {
      if (a.stopped_reason !== undefined) {
        error(
          "agent.stopped_reason_while_live",
          a.id,
          `agent ${a.id} is recorded ${a.status} but carries stopped_reason=${a.stopped_reason} — the same row claims it has not finished and that it is known why it stopped`
        );
      }
      if (a.result_contract !== undefined) {
        error(
          "agent.result_contract_while_live",
          a.id,
          `agent ${a.id} is recorded ${a.status} but carries result_contract=${a.result_contract} — a declared settle outcome on a row whose own status says it has not settled`
        );
      }
    }

    // A failover hop the writer could not have recorded. `recordRuntimeAttempt`
    // is idempotent on the last entry precisely so "a re-entry must not inflate
    // the history into evidence of a hop that never happened", and the field's
    // own contract is that "a second DISTINCT entry IS the failover record".
    // An ADJACENT duplicate is therefore structurally unproducible and
    // manufactures exactly the evidence that guard exists to prevent.
    // Non-adjacent repeats (A, B, A) are legitimate hop-backs and stay silent.
    if (a.runtime_attempts !== undefined) {
      const dupeAt = a.runtime_attempts.findIndex((id, i) => i > 0 && id === a.runtime_attempts![i - 1]);
      if (dupeAt > 0) {
        error(
          "agent.runtime_attempt_duplicated",
          a.id,
          `agent ${a.id} records runtime_attempts ${JSON.stringify(a.runtime_attempts)} with the same runtime repeated at positions ${dupeAt - 1} and ${dupeAt} — the writer collapses a repeated last entry, so this asserts a failover hop that no spawn path could have written`
        );
      }
    }

    // Model-selected execution (task 3) — narrow, local consistency check
    // for COMPLETE agents that carry a persisted `requested_model`:
    //   - the row MUST also carry a parseable observed `runtime_model` banner,
    //     or the selection's claim "executed under that model" is unsupported;
    //   - the two fields MUST match under runtimeModelsMatch() (the same
    //     rule the spawn classifier uses), or the row contradicts itself.
    // Failed and interrupted agents may legitimately lack observation —
    // spawn failure, timeout, cancellation, or unparsable output can prevent
    // banner capture — and a matching pair does NOT promote evidence above
    // `observed`; it cannot prove authentication, account ownership, provider
    // availability, billing, or attestation (design doc, "non-claims").
    if (a.requested_model !== undefined && a.status === "complete") {
      if (a.runtime_model === undefined) {
        error(
          "agent.requested_model_unobserved",
          a.id,
          `agent ${a.id} requested model ${a.requested_model} but the completed row carries no runtime_model — the selection's claim that this agent ran under that model is unsupported by the ledger's own records`
        );
      } else if (!runtimeModelsMatch(a.requested_model, a.runtime_model)) {
        error(
          "agent.requested_model_mismatch",
          a.id,
          `agent ${a.id} requested model ${a.requested_model} but the completed row observed runtime_model ${a.runtime_model} — the two fields disagree under the same runtimeModelsMatch() rule the spawn classifier uses`
        );
      }
    }

    // RESULT CONTRACT (release N+1, 2026-08-19 → enforce): `complete` is only honest when
    // paired with `result_contract === "ok"`. A `complete` row carrying anything else
    // (refused / blocked / artifact_missing / invalid / absent) is exactly the false
    // completion release N existed to surface — and release N+1 sealed in `src/index.ts`
    // (recordAttemptSettlement) and `src/lifecycle-execution.ts` (durable settlement).
    // Catching it here means a regressed writer cannot bank a `complete|absent` row
    // without the auditor screaming — a row written under N+1's settlement would never
    // reach this state, so the check is a regression guard, not a normal-case rule.
    // Pre-N+1 rows carrying this shape are LEGITIMATE HISTORY and must stay unflagged:
    // release N banked them on purpose so the adoption figure would be honest, and
    // rewriting them now would be a fabricated measurement. The check therefore
    // requires a `result_contract` to be PRESENT on a `complete` row, and to be `ok`.
    if (a.status === "complete" && a.result_contract !== undefined && a.result_contract !== "ok") {
      error(
        "agent.complete_with_non_ok_contract",
        a.id,
        `agent ${a.id} is recorded complete but carries result_contract=${a.result_contract} — release N+1 forbids this pairing (only result_contract=ok may bank complete)`
      );
    }
  }

  // --- capabilities ----------------------------------------------------------
  for (const [key, c] of Object.entries(data.capabilities)) {
    // A capability with no usable agent id is an ERROR, not a surprise: the row
    // asserts that some agent can do something while naming no agent, so nothing
    // can act on it and routing must skip it entirely. Reported specifically
    // because the generic unknown-agent warning below renders as "capability
    // registered for undefined", which diagnoses nothing. This is the shape a
    // pre-fix `register_capability` wrote when the snake_case wire payload was
    // passed to a camelCase input (key coerces to the string "undefined").
    // routeWork repairs a missing body agent_id from the record KEY, so verify
    // must judge the same normalized row it does. Reporting a hard error for a
    // row routing happily dispatches to would be a false alarm — and the
    // reverse (silence on a row routing drops) is the false-green this whole
    // section exists to end. One normalization, both readers.
    const effectiveId = isUsableAgentId(c?.agent_id) ? c.agent_id : key;
    if (!isUsableAgentId(effectiveId)) {
      error(
        "capability.missing_agent_id",
        key,
        `capability row "${key}" has no usable agent_id (${JSON.stringify(c?.agent_id)}) and its key is not usable either — it names no agent, so it cannot be routed to or acted on`
      );
      continue;
    }
    if (!isUsableAgentId(c?.agent_id)) {
      warning(
        "capability.key_mismatch",
        key,
        `capability row "${key}" has no usable agent_id in its body (${JSON.stringify(c?.agent_id)}); routing falls back to the key, but the row should be rewritten`
      );
    }
    // Same predicate routing applies. Without this, a row could be stored,
    // silently dropped by routeWork, and still reported ok — the three-way
    // disagreement between write, route and verify that an adversarial pass
    // found.
    if (!isRoutableCapability({ ...c, agent_id: effectiveId })) {
      error(
        "capability.unroutable",
        key,
        `capability "${c.agent_id}" is missing a usable role or skills (role=${JSON.stringify(c.role)}, skills=${JSON.stringify(c.skills)}) — routing will never offer it`
      );
      continue;
    }
    if (isUsableAgentId(c?.agent_id) && key !== c.agent_id) {
      warning(
        "capability.key_mismatch",
        key,
        `capability stored under key "${key}" but its agent_id is "${c.agent_id}" — one of the two is wrong`
      );
    }
    const capAgent = data.agents[effectiveId];
    if (!capAgent) {
      warning("capability.unknown_agent", effectiveId, `capability registered for ${effectiveId}, which this ledger has not registered as an agent`);
    } else if (
      // `fleet_id` is REQUIRED on a Capability and `_registerCapability` refuses a
      // blank one — but nothing ever compared it to anything. The dereference is
      // made for agents (`agent.orphan_fleet`), for messages
      // (`message.orphan_fleet`) and for fleet membership itself
      // (`fleetAgents`); the capability was the one record that carries a
      // fleet_id and never had it read. `register_capability` takes the fleet id
      // from its CALLER, not from the agent row it names, so the two are free to
      // disagree at the write and no reader has ever objected.
      //
      // Gated on BOTH sides being HELD — the agent, and the fleet the row
      // claims — so cross-attachment is removed BY CONSTRUCTION rather than by
      // judgement. When this ledger holds fleet A, holds fleet B, and holds an
      // agent whose own row says B, a capability saying A has no external
      // explanation left: the contradiction is entirely between records this
      // ledger vouches for. The unheld-fleet case is deliberately left silent
      // for the same reason `capability.unknown_agent`'s own `--explain` text
      // gives — a cross-attached fleet may legitimately advertise capabilities
      // this ledger cannot resolve.
      //
      // Warning, not error, and the severity is precedent rather than a hedge:
      // `capability.key_mismatch` — the other check in this block where two
      // copies of one identity disagree — warns. Nothing routes on this field
      // (`routeWork` scores capabilities globally and never scopes by fleet), so
      // the damage is not a dropped dispatch; it is that the ledger's answer to
      // "which fleet was this agent working in" depends on which row you read.
      //
      // Measured before it was written, both directions, exactly as the sender
      // check was: 0 of the operator's 443 live capability rows and 0 of the 78
      // corpus fixtures. 442 of those 443 name a fleet this ledger holds, so the
      // gate costs essentially no coverage on real data.
      typeof c.fleet_id === "string" &&
      c.fleet_id.length > 0 &&
      data.fleets[c.fleet_id] !== undefined &&
      capAgent.fleet_id !== c.fleet_id
    ) {
      warning(
        "capability.fleet_mismatch",
        key,
        `capability row "${key}" places agent ${effectiveId} in fleet ${JSON.stringify(c.fleet_id)}, but that agent's own row says fleet ${JSON.stringify(capAgent.fleet_id)} — this ledger holds both fleets and both rows, and they disagree about where the work happened`
      );
    }
  }

  // --- inboxes owned by nobody -------------------------------------------------
  // A message sent to a mistyped recipient is written into a phantom inbox for
  // an agent that does not exist: the send returns success with
  // `recipients: ["beta-typo"]`, the intended agent's inbox stays empty, and
  // nothing ever flagged it. A warning rather than an error, because a
  // cross-attached fleet can legitimately hold receipts for agents this ledger
  // never registered — but a queued, undeliverable message is worth seeing.
  for (const [ownerId, ids] of Object.entries(data.inboxes)) {
    if ((ids?.length ?? 0) === 0) continue;
    if (!data.agents[ownerId]) {
      warning(
        "inbox.unknown_agent",
        ownerId,
        `${ids.length} message(s) are queued for "${ownerId}", which this ledger has not registered as an agent — nothing will ever collect them (a mistyped recipient produces exactly this)`
      );
    }
  }

  const invalidMessageTimestamps = new Set<string>();
  for (const [key, msg] of Object.entries(data.messages)) {
    if (hasUsableId(msg) && key !== msg.id) {
      error(
        "message.key_mismatch",
        key,
        `message stored under key "${key}" but its body claims id "${msg.id}" — receipts join on the body id while inboxes join on the key, so a split identity makes the same message two different rows`
      );
    }
    if (!Number.isFinite(msg.timestamp)) {
      error("message.invalid_timestamp", msg.id, `message ${msg.id} has a missing or non-finite timestamp`);
      invalidMessageTimestamps.add(msg.id);
    }
  }

  // --- receipts ---------------------------------------------------------------
  const validatedAckReceipts = new Set<string>();
  for (const [key, r] of Object.entries(receipts)) {
    // Checked BEFORE the key comparison, because that comparison cannot see this
    // defect: it rebuilds the key with the same template, so a row written with
    // an undefined agent_id produces `<msg>:undefined:ack` on BOTH sides, the
    // strings match, and the row sails through to a mere warning. A receipt is
    // keyed `message_id:agent_id:action` — the key IS the idempotency
    // guarantee — so a blank component means the guarantee does not hold for
    // that row, whatever the strings say.
    if (!isUsableAgentId(r.agent_id) && r.agent_id !== BROADCAST) {
      error(
        "receipt.missing_agent_id",
        key,
        `receipt ${key} has no usable agent_id (${JSON.stringify(r.agent_id)}) — it records an action by nobody, and its idempotency key cannot be trusted`
      );
      continue;
    }
    if (typeof r.action !== "string" || r.action.trim().length === 0) {
      error(
        "receipt.missing_action",
        key,
        `receipt ${key} has no usable action (${JSON.stringify(r.action)}) — the key's action component is what distinguishes an ack from an annotation`
      );
      continue;
    }
    if (key !== `${r.message_id}:${r.agent_id}:${r.action}`) {
      error("receipt.key_mismatch", key, `receipt key ${key} disagrees with its fields (${r.message_id}:${r.agent_id}:${r.action}) — the idempotency guarantee is broken`);
      continue; // the row is untrustworthy; don't derive further findings from it
    }
    const msg = data.messages[r.message_id];
    if (!msg) {
      error("receipt.orphan_message", key, `receipt ${key} points at message ${r.message_id}, which this ledger does not hold`);
      continue;
    }
    if (invalidMessageTimestamps.has(msg.id)) {
      continue;
    }
    // "*" is the legacy-broadcast placeholder: the v1→v2 migration backfills
    // `${id}:*:ack` for an acknowledged broadcast whose recipients were never
    // captured (schema v1 predates the recipients field). Not an unknown agent.
    if (!data.agents[r.agent_id] && r.agent_id !== BROADCAST) {
      warning("receipt.unknown_agent", key, `receipt ${key} was written by ${r.agent_id}, which this ledger has not registered as an agent`);
    }
    // An ACK asserts "this message was delivered to me and I consumed it". From
    // an agent the message was never addressed to, that assertion is simply
    // false, and it is exactly the shape a forged audit entry takes: the writer
    // is a real agent, so the unknown-agent warning above stays silent. The
    // derived `acknowledged` flag is not fooled (it gates on messageRecipients),
    // which is why this went unnoticed — but get_receipts would report an
    // acknowledgement that never happened. Annotations (`seen`, votes, ...) are
    // legitimately written by third parties and are NOT restricted.
    if (r.action === "ack" && r.agent_id !== BROADCAST && !messageRecipients(msg).includes(r.agent_id)) {
      error(
        "receipt.non_recipient_ack",
        key,
        `${r.agent_id} acknowledged message ${msg.id}, which was addressed to ${JSON.stringify(messageRecipients(msg))} — an ack from a non-recipient asserts a delivery that never happened`
      );
    }
    if (!Number.isFinite(r.timestamp)) {
      error("receipt.invalid_timestamp", key, `receipt ${key} has a missing or non-finite timestamp`);
      continue;
    }
    if (r.timestamp < msg.timestamp) {
      error("receipt.before_message", key, `receipt ${key} is timestamped ${r.timestamp}, before its message (${msg.timestamp})`);
      continue;
    }
    if (
      r.action === "ack" &&
      (r.agent_id === BROADCAST || messageRecipients(msg).includes(r.agent_id))
    ) {
      validatedAckReceipts.add(key);
    }
  }

  // --- messages: the derived acknowledged flag -------------------------------
  for (const msg of Object.values(data.messages)) {
    const f = data.fleets[msg.fleet_id];
    if (f && msg.timestamp < f.created_at) {
      error("message.tampered_timestamp", msg.id, `message timestamp is before fleet creation`);
    }
    // Symmetric to `agent.orphan_fleet`, and warning for the same reason: a
    // cross-attached fleet can legitimately leave a message naming a fleet this
    // ledger never held. Silence was the odd one out — the timestamp check
    // above only runs when the fleet EXISTS, so a ghost fleet_id skipped every
    // fleet-scoped check without a word.
    if (!f) {
      warning(
        "message.orphan_fleet",
        msg.id,
        `message ${msg.id} references fleet ${JSON.stringify(msg.fleet_id)}, which this ledger does not hold`
      );
    }

    // The same comparison `receipt.unknown_agent`, `capability.unknown_agent`
    // and `inbox.unknown_agent` all make — the message was the one addressable
    // record that never made it. `data.agents` and the message's own address
    // list sat side by side and were never compared. An addressed recipient
    // that does not exist can never take delivery and can never write an ack,
    // so `acknowledged` can never derive true for that message: it is lost, and
    // lost silently, which is the failure this ledger exists to make loud.
    //
    // Gated on the fleet being HELD, which removes cross-attachment BY
    // CONSTRUCTION rather than by judgement: `message.orphan_fleet` above
    // already reports the foreign case, and its comment states why a ledger may
    // legitimately not hold a foreign fleet's parties.
    //
    // 🔴 SENDERS ARE DELIBERATELY NOT CHECKED, and this is a measurement, not
    // caution. On the operator's real ledger 44 of the 71 messages whose fleet
    // is held — 62% — carry a `from_agent_id` that is no agent row: `root` (18),
    // `orchestrator` (13), `root-codex` (10), and three others. External and
    // human senders writing into a held fleet are ordinary honest traffic, so
    // "the sender must be an agent" is not an invariant of honest ledgers and a
    // symmetric check here would be a false positive on two thirds of real
    // messages.
    //
    // Warning, not error: all three sibling checks warn on "this ledger has not
    // registered as an agent", and inventing a stricter rule here would be the
    // severity drift this file audits for. With both exemptions applied the
    // predicate fires on zero of the operator's 72 live messages and zero of
    // the 78 corpus fixtures.
    if (f) {
      const absent = messageRecipients(msg).filter(
        (r) => typeof r === "string" && r.length > 0 && r !== BROADCAST && !data.agents[r]
      );
      if (absent.length > 0) {
        warning(
          "message.unknown_recipient",
          msg.id,
          `message ${msg.id} is addressed to ${absent.map((r) => JSON.stringify(r)).join(", ")}, which this ledger has not registered as an agent — an addressed recipient that does not exist can never take delivery, so no ack for it can ever exist`
        );
      }
    }

    // `acknowledged` derives as "every addressed recipient holds an ack". Over
    // an empty address set `every` is vacuously true, so the flag could claim
    // acknowledgement backed by zero delivery evidence and the mismatch check
    // below could never fire. The write path refuses a broadcast with no
    // recipients outright, so this row cannot be produced honestly. Same
    // precedent as the empty fleet above: a vacuous "all done" is not a
    // finished claim.
    if (msg.acknowledged && messageRecipients(msg).length === 0) {
      error(
        "message.vacuous_ack",
        msg.id,
        `message ${msg.id} claims acknowledged with an empty recipient set — nobody was addressed, so the claim rests on no delivery evidence at all`
      );
      continue;
    }

    const derived = derivedAcknowledged(msg, validatedAckReceipts);
    if (msg.acknowledged && !derived) {
      error("message.ack_flag_mismatch", msg.id, `message ${msg.id} claims acknowledged, but not every addressed recipient holds an 'ack' receipt`);
    } else if (!msg.acknowledged && derived) {
      warning("message.ack_flag_mismatch", msg.id, `message ${msg.id} has an 'ack' receipt from every addressed recipient but acknowledged=false (understates; a write-path recompute was missed)`);
    }

  }

  // --- inboxes ------------------------------------------------------------------
  for (const [agentId, ids] of Object.entries(data.inboxes)) {
    for (const id of ids) {
      const msg = data.messages[id];
      if (!msg) {
        error("inbox.dangling_message", `${agentId}:${id}`, `inbox of ${agentId} holds message ${id}, which this ledger does not hold`);
        continue;
      }
      if (validatedAckReceipts.has(`${id}:${agentId}:ack`)) {
        error("inbox.acked_still_queued", `${agentId}:${id}`, `message ${id} is still in the inbox of ${agentId}, but ${agentId} holds an 'ack' receipt on it — ack consumes`);
      }
      // The dual of `receipt.non_recipient_ack`. That check catches a false
      // delivery claim made through a receipt; this one catches the same claim
      // made through the queue. Inbox membership asserts "queued for this
      // agent", addressing asserts who may receive — a non-recipient queue is a
      // contradiction between two rows both present here, not incompleteness.
      //
      // Legacy broadcasts are exempt: schema v1 predates the materialized
      // recipients field, so `messageRecipients` falls back to `["*"]` and no
      // real inbox owner appears in it. That is the same edge the v1→v2
      // migration backfills `${id}:*:ack` for. Without this exemption the check
      // would fire on every pre-v2 ledger that ever broadcast.
      const recipients = messageRecipients(msg);
      const isLegacyBroadcast = recipients.length === 1 && recipients[0] === BROADCAST;
      if (!isLegacyBroadcast && !recipients.includes(agentId)) {
        error(
          "inbox.non_recipient",
          `${agentId}:${id}`,
          `message ${id} is queued for ${agentId}, but it was addressed to ${JSON.stringify(recipients)} — a queue entry for a non-recipient asserts a delivery that was never addressed`
        );
      }
    }
  }

  // --- ratifications ---------------------------------------------------------
  for (const [ratKey, r] of Object.entries(ratifications)) {
    // Ratifications are keyed by proposal id on the write path. Receipts and
    // capabilities already refuse a key that disagrees with its body; this map
    // did not, and its own orphan check reads the BODY's message_id — so a
    // wrong key still resolved to a real proposal and the split stayed silent.
    if (typeof r?.message_id === "string" && r.message_id.length > 0 && ratKey !== r.message_id) {
      error(
        "ratification.key_mismatch",
        ratKey,
        `ratification stored under key "${ratKey}" but its body names proposal "${r.message_id}" — the council outcome and the proposal it belongs to are joined by whichever of the two a reader happens to use`
      );
    }
    // The open path refuses a quorum that is not a positive integer. Verify
    // checked only the upper bound, and the lower bound is the dangerous one:
    // with `quorum: 0` the tally's `approvalWeight >= quorum` is satisfied by
    // ZERO votes, so a `ratified` status recomputes to `ratified` and
    // `ratification.status_mismatch` never fires. The lie does not merely pass
    // as a warning — it becomes completely silent. Same family as
    // `message.vacuous_ack`: success by a comparison against an empty
    // threshold that the write path forbids outright.
    if (!Number.isInteger(r.quorum) || r.quorum < 1) {
      error(
        "ratification.invalid_quorum",
        r.message_id,
        `ratification ${r.message_id} records quorum ${JSON.stringify(r.quorum)}, which the open path forbids (a positive integer is required) — any quorum below 1 makes approval vacuous, so a terminal status recomputes as supported no matter how few ballots exist`
      );
    }
    // Config checks first — they need no proposal message, so an orphan
    // ratification still gets its weight/quorum findings reported.
    // Tiered councils: quorum reachability is a WEIGHT question when a weights
    // map exists (unlisted voters weigh 1), a head-count question otherwise.
    for (const [agentId, w] of Object.entries(r.weights ?? {})) {
      if (!r.voters.includes(agentId)) {
        error("ratification.weight_for_non_voter", `${r.message_id}:${agentId}`, `ratification ${r.message_id} assigns weight ${w} to ${agentId}, who is not among the eligible voters`);
      }
      if (!Number.isInteger(w) || w < 1 || w > MAX_VOTE_WEIGHT) {
        error("ratification.invalid_weight", `${r.message_id}:${agentId}`, `ratification ${r.message_id} assigns ${agentId} weight ${w} — weights must be integers in [1, ${MAX_VOTE_WEIGHT}]`);
      }
    }
    // Unique voters: a duplicated id is separately flagged below, and counting
    // it twice here would overstate reachability past the real ceiling.
    const uniqueVoters = [...new Set(r.voters)];
    const weightOf = (v: string): number =>
      r.weights !== undefined && Object.hasOwn(r.weights, v) ? r.weights[v]! : 1;
    const totalWeight = uniqueVoters.reduce((s, v) => s + weightOf(v), 0);
    if (totalWeight > MAX_TOTAL_WEIGHT) {
      error("ratification.total_weight_exceeded", r.message_id, `ratification ${r.message_id} carries total voting weight ${totalWeight}, beyond the ${MAX_TOTAL_WEIGHT} limit the open path enforces`);
    }
    if (r.quorum > totalWeight) {
      error("ratification.quorum_exceeds_voters", r.message_id, `ratification ${r.message_id} requires quorum ${r.quorum} but the total voting weight is ${totalWeight} — unreachable by construction`);
    }
    if (uniqueVoters.length !== r.voters.length) {
      error("ratification.duplicate_voters", r.message_id, `ratification ${r.message_id} lists a voter more than once — the tally counts each occurrence, so one agent could satisfy the quorum alone`);
    }
    if (!data.messages[r.message_id]) {
      error("ratification.orphan_proposal", r.message_id, `ratification references proposal message ${r.message_id}, which this ledger does not hold`);
      continue;
    }
    const outsideSignoffs = r.required_signoffs.filter((s) => !r.voters.includes(s));
    for (const s of outsideSignoffs) {
      error("ratification.signoff_not_voter", r.message_id, `required signoff ${s} on ${r.message_id} is not among the eligible voters`);
    }

    // Vote-receipt structure: parse every vote-like action; per agent check
    // seq uniqueness and contiguity (the append-only re-cast protocol), and
    // surface re-casts as informational warnings.
    const votesByAgent = new Map<string, { seq: number; bare: boolean; approve: boolean }[]>();
    for (const receipt of Object.values(receipts)) {
      if (receipt.message_id !== r.message_id) continue;
      const voteLike = /^(r-ack|r-decline)(:|$)/.test(receipt.action);
      const v = parseVoteAction(receipt.action);
      if (!v) {
        if (voteLike) {
          error("ratification.malformed_vote_action", `${r.message_id}:${receipt.agent_id}`, `receipt action ${receipt.action} on ${r.message_id} looks like a vote but is malformed — the tally will ignore it`);
        }
        continue;
      }
      if (!r.voters.includes(receipt.agent_id)) {
        warning("ratification.vote_from_non_voter", `${r.message_id}:${receipt.agent_id}`, `${receipt.agent_id} holds a ${receipt.action} receipt on ${r.message_id} but is not an eligible voter — the tally ignores it`);
        continue;
      }
      const list = votesByAgent.get(receipt.agent_id) ?? [];
      list.push({ seq: v.seq, bare: !receipt.action.includes(":"), approve: v.approve });
      votesByAgent.set(receipt.agent_id, list);
    }
    for (const [agentId, votes] of votesByAgent) {
      const bySeq = new Map<number, typeof votes>();
      for (const v of votes) {
        const arr = bySeq.get(v.seq) ?? [];
        arr.push(v);
        bySeq.set(v.seq, arr);
      }
      for (const [seq, arr] of bySeq) {
        if (arr.length > 1) {
          // Legacy exemption: BOTH bare polarities at seq 0 predate the
          // seq protocol and tally deterministically (timestamp, then
          // decline-wins). Anything else sharing a seq is corruption.
          const legacyPair = seq === 0 && arr.length === 2 && arr.every((x) => x.bare) && arr[0]!.approve !== arr[1]!.approve;
          if (!legacyPair) {
            error("ratification.duplicate_vote_seq", `${r.message_id}:${agentId}`, `${agentId} holds ${arr.length} vote receipts at seq ${seq} on ${r.message_id} — each re-cast must take a fresh sequence number`);
          }
        }
      }
      const seqs = new Set(votes.map((v) => v.seq));
      const maxSeq = Math.max(...seqs);
      if (maxSeq >= 1) {
        for (let i = 0; i <= maxSeq; i++) {
          if (!seqs.has(i)) {
            error("ratification.vote_seq_gap", `${r.message_id}:${agentId}`, `${agentId}'s vote sequence on ${r.message_id} jumps to ${maxSeq} without seq ${i} — casts are appended one at a time, so a gap means missing history`);
            break;
          }
        }
      }
      if (new Set(votes.map((v) => v.approve)).size === 2) {
        warning("ratification.vote_recast", `${r.message_id}:${agentId}`, `${agentId} changed their vote on ${r.message_id} — the highest-sequence cast is the effective one`);
      }
    }

    if (r.status !== "open") {
      // Recompute from the receipts that existed AT resolution. Votes cast
      // after a sticky terminal status are legitimate ledger content (pinned
      // by ratify.test.ts) and must not read as a mismatch.
      // Known narrow edge (documented): a post-resolution re-cast in the SAME
      // millisecond as resolved_at is indistinguishable from the deciding vote
      // and can flip this recompute — warning severity by design.
      const asOf = r.resolved_at ?? now;
      const receiptsAtResolution = Object.fromEntries(
        Object.entries(receipts).filter(([, rec]) => rec.timestamp <= asOf),
      );
      const recomputed = computeTally({ ...data, receipts: receiptsAtResolution }, { ...r, status: "open" }, asOf);
      if (recomputed.status !== r.status) {
        warning("ratification.status_mismatch", r.message_id, `ratification ${r.message_id} is recorded ${r.status}, but the receipts as of resolution recompute to ${recomputed.status}`);
      }
    }
  }

  // --- discussions -------------------------------------------------------
  // A discussion (src/discussion.ts) is a PURE derived view over the same
  // messages/receipts already in hand here — verify does not re-implement
  // any admission/authorization logic; it discovers each discussion's id,
  // calls the sealed `deriveDiscussion`, and passes its status + integrity
  // findings through (severity per DISCUSSION_ERROR_CODES above). The only
  // things verify computes itself are two cross-checks deriveDiscussion has
  // no reason to compute for its own callers (see below).
  //
  // Discovery: pre-collect correlation ids from ANY message whose payload
  // contains the discussion/v1 fragment — a cheap substring check BEFORE
  // parsing, not a root-shape/validity gate (cdx pass-1 fix: the previous
  // gate — parse + require turn===1 && reply_to===null — meant a tampered
  // or corrupted root (e.g. a `kind` value invalid_envelope can't even
  // parse) never satisfied it, so its correlation id was never enqueued,
  // `deriveDiscussion` was never called, and `no_valid_root` never fired —
  // a corrupted root silently hid its ENTIRE discussion family from
  // verification instead of tripping the one finding that exists to report
  // exactly that. The substring is intentionally loose on purpose — false
  // positives (a correlation id that isn't really a discussion, e.g. a plain
  // message whose payload happens to quote "discussion/v1" in prose) are
  // handled below by the `hasAnyEnvelope` gate, not by tightening discovery
  // itself.
  //
  // Cost profile (deliberate trade, not overlooked): this makes the
  // discussion pass roughly O(D * (M + R)) — D discovered ids, each re-
  // scanning messages/receipts via `deriveDiscussion` plus the raw-receipt
  // pass below — versus the single linear O(M + R) pass every other check
  // in this file gets away with. Audit tooling, not a hot path: verify runs
  // out-of-band over a snapshot, so trading some throughput for correctness
  // (never hiding a discussion family) is the right side of that trade here.
  const allMessages = Object.values(data.messages);
  const allReceipts = Object.values(receipts);
  const discussionIds = new Set<string>();
  for (const m of allMessages) {
    if (!m.correlation_id) continue;
    if (m.payload.includes('"discussion/v1"')) {
      discussionIds.add(m.correlation_id);
    }
  }

  for (const discussionId of discussionIds) {
    // cdx pass-2's false-positive probe: the substring pre-filter above can
    // enqueue an id that is not really a discussion at all — e.g. a plain
    // chat message whose payload happens to contain the quoted fragment
    // "discussion/v1" in an unrelated field (someone discussing the
    // protocol). With NO gate here, that id reaches `deriveDiscussion`,
    // which finds zero valid envelopes, returns status 'invalid' with a
    // `no_valid_root` finding, and this function would report that as a hard
    // ERROR — a false positive on ledger data that was never a discussion.
    //
    // Gate: only treat a missing root as genuine discussion corruption when
    // at least ONE message under this id parses as an ACTUAL discussion/v1
    // envelope — any shape, not necessarily root-shaped. That is real
    // evidence the id carries discussion traffic (e.g. the corrupted-root
    // fixture: its root doesn't parse, but msg-2/msg-3 do, so this gate
    // still holds and `no_valid_root` still reports as an error there). When
    // NO message parses as any envelope, there is no such evidence — per
    // cdx's explicit ruling, downgrade to a WARNING-level
    // `discussion.unparseable_candidate` instead of a hard error, and skip
    // the rest of this id's per-discussion processing (its only "finding"
    // would be discovery noise, not a real discussion defect). Warning, not
    // silence: staying silent here would just reintroduce a quieter cousin
    // of the pass-1 discovery-blindspot bug.
    let hasAnyEnvelope = false;
    for (const m of allMessages) {
      if (m.correlation_id !== discussionId) continue;
      const envelope = parseEnvelope(m.payload);
      if (envelope && envelope.$meshfleet === "discussion/v1") {
        hasAnyEnvelope = true;
        break;
      }
    }
    if (!hasAnyEnvelope) {
      warning(
        "discussion.unparseable_candidate",
        discussionId,
        `id '${discussionId}' matched the discussion discovery filter (a message payload contains "discussion/v1"), but no message under this id parses as an actual discussion/v1 envelope — likely coincidental, not a real discussion`
      );
      continue;
    }

    const derived = deriveDiscussion(discussionId, allMessages, allReceipts, now);

    // Aggregate overclaim: anything consuming `derived` at face value (its
    // transcript, attempts, turns_used) without also inspecting
    // integrity_findings would be trusting a discussion the module itself
    // marked unusable.
    if (derived.status === "invalid") {
      error(
        "discussion.derive_invalid",
        discussionId,
        `discussion ${discussionId} derives to status 'invalid' — its transcript/attempts/turns_used are not safe to present as usable`
      );
    }

    for (const finding of derived.integrity_findings) {
      const subject = finding.message_id ?? discussionId;
      const detail = `discussion ${discussionId}: ${finding.detail}`;
      if (DISCUSSION_ERROR_CODES.has(finding.code)) {
        error(`discussion.${finding.code}`, subject, detail);
      } else {
        warning(`discussion.${finding.code}`, subject, detail);
      }
    }

    // The two cross-checks below need a SHALLOW, independent recount of raw
    // 'reserved' wake receipts on this discussion's messages — using only
    // the exported action parser, no note/head/agent/timing validation (that
    // depth is deriveDiscussion's job, not verify's to redo). One pass
    // builds both: the distinct attempt_id set (budget check) and each
    // attempt's claimed head_message_id (reply-linkage check), per the
    // module's own "do not re-scan all messages per check" guidance.
    const rawReservedAttempts = new Set<string>();
    const reservedHeadByAttempt = new Map<string, string>();
    for (const r of allReceipts) {
      const msg = data.messages[r.message_id];
      if (!msg || msg.correlation_id !== discussionId) continue;
      const parsed = parseReceiptAction(r.action);
      if (!parsed) continue;
      if (parsed.kind !== "wake") continue;
      if (parsed.state !== "reserved") continue;
      rawReservedAttempts.add(parsed.attempt_id);
      if (!r.note) continue;
      try {
        const raw = JSON.parse(r.note) as unknown;
        if (typeof raw === "object" && raw !== null) {
          const noteObj = raw as Record<string, unknown>;
          if (typeof noteObj.head_message_id === "string") {
            reservedHeadByAttempt.set(parsed.attempt_id, noteObj.head_message_id);
          }
        }
      } catch {
        // Malformed JSON is already surfaced generically via the
        // discussion.malformed_receipt_note passthrough above.
      }
    }

    // Budget-accounting consistency: turns_used counts the root plus every
    // DISTINCT CANONICAL validated reservation (discussion.ts's own
    // invariant — see its header comment). Every validated attempt requires
    // a 'reserved' receipt in its own lifecycle (attempt_missing_reservation
    // excludes any that don't), so canonical reservations are always a
    // SUBSET of `rawReservedAttempts` in a correctly functioning derivation
    // — `canonical > raw` should be structurally unreachable; if it ever
    // fires, that is a serious derivation/ledger inconsistency (error,
    // overclaim: turns_used asserts more validated turns than there is even
    // raw receipt evidence for). `canonical < raw` is the common, expected
    // case whenever deeper validation excluded some raw reservations
    // (malformed note, wrong agent, wrong head, over budget, non-canonical)
    // — a warning, exactly like message.ack_flag_mismatch's understate
    // branch. Skipped entirely when `deriveDiscussion` never found a root
    // (invalidResult's turns_used=0 placeholder is not a real count).
    if (derived.root_message_id !== "") {
      const canonicalReservations = derived.turns_used - 1; // root itself needs no reservation
      if (canonicalReservations > rawReservedAttempts.size) {
        error(
          "discussion.budget_turns_mismatch",
          discussionId,
          `discussion ${discussionId} reports turns_used=${derived.turns_used} (${canonicalReservations} counted reservations), but only ${rawReservedAttempts.size} distinct attempt(s) hold a 'reserved' receipt at all on this discussion — turns_used overclaims`
        );
      } else if (canonicalReservations < rawReservedAttempts.size) {
        warning(
          "discussion.budget_turns_mismatch",
          discussionId,
          `discussion ${discussionId} reports turns_used=${derived.turns_used} (${canonicalReservations} counted reservations), but ${rawReservedAttempts.size} distinct attempt(s) hold a 'reserved' receipt — turns_used understates (some were excluded by deeper validation)`
        );
      }
    }

    // Reply-linkage cross-check — the local-trust-detectable slice of the
    // design doc's `payload_mutation`. A validated completed attempt's note
    // NAMES the reply message it produced (`reply_message_id`). Canonical
    // attempts admitted through the live walk already have this fact checked
    // (the walk only authorizes a candidate whose message id, turn, AND
    // attempt id all agree) — but a canonical attempt admitted via the
    // TAIL/dead-end path (`registerContiguousTail`: a trailing reservation,
    // or a completed attempt whose reply never even entered `valid` — see
    // the broadcast-smuggle fixture) never goes through that matching. This
    // closes that gap: for every canonical attempt with a reply_message_id,
    // confirm the named message exists and its OWN envelope agrees this
    // attempt produced it (same discussion, same attempt id, replying to
    // this attempt's own head).
    //
    // Honest limit: this proves the reply LINKAGE is self-consistent — it
    // cannot prove the named message's `body` is byte-identical to whatever
    // the acting agent actually sent. core.ts's Receipt has no content hash
    // bound at receipt-time, so a receipt cannot commit to a payload the way
    // it commits to an id; a genuine post-receipt body swap on an otherwise
    // correctly-linked message is NOT detectable by local trust alone and
    // would need a notary, or a hash bound into the receipt note at write
    // time. (The design doc's original `payload_mutation` assumed exactly
    // such a bound hash — a field that does not exist in the real schema;
    // resolved here by scoping the check to what local trust can actually
    // support.)
    //
    // Reviewer note (cdx pass-1, double-reporting): this can co-occur with
    // `discussion.unauthorized_reply` on the SAME underlying defect — e.g. a
    // retargeted reply produces both a lineage warning (this reply was never
    // authorized to advance the walk) and this hard error (the receipt's own
    // bookkeeping disagrees with the message it names). That is not
    // redundant double-counting: they assert different things (walk
    // admission vs. receipt/message self-consistency) at different severity,
    // and an operator seeing only one should not assume the other is
    // implied.
    for (const attempt of derived.attempts) {
      if (!attempt.reply_message_id) continue;
      const headId = reservedHeadByAttempt.get(attempt.attempt_id);
      const replyMsg = data.messages[attempt.reply_message_id];
      if (!replyMsg) {
        error(
          "discussion.reply_target_mismatch",
          attempt.reply_message_id,
          `discussion ${discussionId}: attempt '${attempt.attempt_id}' claims reply_message_id '${attempt.reply_message_id}', which this ledger does not hold`
        );
        continue;
      }
      const replyEnvelope = parseEnvelope(replyMsg.payload);
      const disagrees =
        !replyEnvelope ||
        replyEnvelope.discussion_id !== discussionId ||
        replyEnvelope.attempt_id !== attempt.attempt_id ||
        (headId !== undefined && replyEnvelope.reply_to !== headId);
      if (disagrees) {
        error(
          "discussion.reply_target_mismatch",
          attempt.reply_message_id,
          `discussion ${discussionId}: attempt '${attempt.attempt_id}' completed receipt claims reply_message_id '${attempt.reply_message_id}', but that message's own envelope does not agree it is this attempt's reply${headId ? ` to head '${headId}'` : ""}`
        );
      }
    }
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  return {
    ok: errors === 0,
    scope: VERIFY_SCOPE,
    errors,
    warnings: findings.length - errors,
    counts: {
      fleets: Object.keys(data.fleets).length,
      agents: Object.keys(data.agents).length,
      messages: Object.keys(data.messages).length,
      receipts: Object.keys(receipts).length,
      ratifications: Object.keys(ratifications).length,
    },
    findings,
  };
}

/** Verify the active ledger (lock-free snapshot read; never mutates). */
export function verifyLedger(now: number = Date.now()): VerifyReport {
  let snapshot;
  try { snapshot = readLifecycleSnapshot(); }
  catch (error) {
    // Preserve the historical fresh-install verifier behavior. The opt-in
    // lifecycle inspector remains strict and never creates an absent ledger.
    if (error instanceof Error && error.message === "ledger file not found") return verifyMeshData(readLedger(), now);
    throw error;
  }
  const core = verifyMeshData(snapshot.data, now);
  const findings = [...core.findings, ...verifyLifecycleSnapshot(snapshot, now)];
  const errors = findings.filter((finding) => finding.severity === "error").length;
  return { ...core, ok: errors === 0, errors, warnings: findings.length - errors, findings };
}

/**
 * Verify a specific ledger FILE — the zero-install audit path
 * (`agent-mesh inspect --verify backup.db`): repoint the db seam at `file`,
 * snapshot-verify it, then restore the configured ledger. Never mutates the
 * audited data; a missing path is rejected up front so SQLite can't silently
 * create (and then "verify") an empty ledger.
 */
export function verifyLedgerFile(file: string, now: number = Date.now()): VerifyReport {
  if (!existsSync(file)) throw new Error(`ledger file not found: ${file}`);
  // Dedicated READ-ONLY connection (db.readLedgerFile): the audit never touches
  // the global handle, the path config, or — critically — the audited file
  // itself. No WAL conversion, no schema creation, no meta writes.
  try {
    const snapshot = readLifecycleSnapshotFile(file);
    const core = verifyMeshData(snapshot.data, now);
    const findings = [...core.findings, ...verifyLifecycleSnapshot(snapshot, now)];
    const errors = findings.filter((finding) => finding.severity === "error").length;
    return { ...core, ok: errors === 0, errors, warnings: findings.length - errors, findings };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/file is not a database|not a database|SQLITE_NOTADB|malformed/i.test(detail)) {
      throw new Error(
        `not a valid SQLite ledger: ${file} — this looks like a JSON export or another file type; ` +
          `verify audits the .db ledger (JSON exports come FROM 'inspect --export', they aren't the ledger itself)`
      );
    }
    throw err;
  }
}
