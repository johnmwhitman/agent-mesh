/**
 * The auditor's overclaim blind spot.
 *
 * `verifyMeshData` is a pure function over a snapshot, so every case here is
 * built inline — no ledger is opened and nothing can touch a real profile.
 *
 * The gap these pin: before this suite, the fleet lattice was audited in ONE
 * direction only. `fleet.unreconciled_status` fires when a fleet UNDERCLAIMS
 * (still `running` while its agents have all finished) — a stale projection,
 * correctly a warning. Nothing looked at the OVERCLAIM direction, where a fleet
 * is SEALED `complete` while an agent is still live. `core.ts` argues the point
 * itself, in the comment that justifies the `abandoned` status: `complete`
 * "claims work that never happened". The ledger could commit precisely that
 * forgery and `verify_ledger` returned `ok: true` with no finding at all.
 *
 * Four sibling holes of the same class are pinned alongside it. Each was
 * confirmed by running the auditor before the fix existed — all five returned
 * `ok: true` with ZERO findings, not even a warning.
 *
 * The two exemptions below are the false positives this suite is built to
 * avoid, and each has a control test proving the exemption still holds:
 *   - `abandoned` is NOT sealed. `attach_agent` reopens such a fleet and
 *     injects a live replacement agent, so `abandoned` + a running agent is a
 *     legitimate transient state, not a forgery.
 *   - A legacy broadcast carries no materialized recipient list, so
 *     `messageRecipients` falls back to `["*"]`. Its inbox owners are
 *     legitimately absent from that set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyMeshData } from "../src/verify.js";
import type { MeshData } from "../src/core.js";

const EMPTY: MeshData = {
  fleets: {},
  agents: {},
  messages: {},
  inboxes: {},
  capabilities: {},
  receipts: {},
  ratifications: {},
  templates: {},
};

const mesh = (over: Partial<MeshData>): MeshData => ({ ...EMPTY, ...over });

function checks(data: MeshData, severity: "error" | "warning"): string[] {
  return verifyMeshData(data)
    .findings.filter((f) => f.severity === severity)
    .map((f) => f.check);
}

const fleet = (id: string, status: MeshData["fleets"][string]["status"], created_at = 1000) =>
  ({ id, status, created_at, objective: "o", agent_ids: [] }) as MeshData["fleets"][string];

const agent = (id: string, fleet_id: string, status: MeshData["agents"][string]["status"]) =>
  ({ id, fleet_id, status, role: "r", prompt: "p" }) as MeshData["agents"][string];

// --- 1. a sealed fleet that outran its own agents ---------------------------

test("a fleet sealed complete while an agent is still running is an error", () => {
  const data = mesh({
    fleets: { F: fleet("F", "complete") },
    agents: { A: agent("A", "F", "running") },
  });
  assert.ok(
    checks(data, "error").includes("fleet.sealed_with_live_agents"),
    "a fleet claiming completion over a live agent asserts work that never happened"
  );
  assert.equal(verifyMeshData(data).ok, false);
});

test("a fleet sealed failed while an agent is pending is an error", () => {
  const data = mesh({
    fleets: { F: fleet("F", "failed") },
    agents: { A: agent("A", "F", "complete"), B: agent("B", "F", "pending") },
  });
  assert.ok(checks(data, "error").includes("fleet.sealed_with_live_agents"));
});

test("CONTROL: an abandoned fleet with a live agent is NOT flagged — attach_agent reopens it", () => {
  const data = mesh({
    fleets: { F: fleet("F", "abandoned") },
    agents: {
      dead: agent("dead", "F", "interrupted"),
      replacement: agent("replacement", "F", "running"),
    },
  });
  assert.ok(
    !checks(data, "error").includes("fleet.sealed_with_live_agents"),
    "abandoned is deliberately not sealed; flagging it would break the only recovery path"
  );
});

test("CONTROL: a sealed fleet whose agents are all terminal is clean", () => {
  const data = mesh({
    fleets: { F: fleet("F", "complete") },
    agents: { A: agent("A", "F", "complete") },
  });
  assert.equal(verifyMeshData(data).ok, true);
});

// --- 2. map key disagreeing with the body it stores -------------------------

test("a message stored under a key that disagrees with its own id is an error", () => {
  const data = mesh({
    fleets: { F: fleet("F", "complete") },
    messages: {
      "m-public": {
        id: "m-secret",
        fleet_id: "F",
        timestamp: 2000,
        from: "A",
        recipients: ["B"],
        acknowledged: false,
        payload: "p",
      } as MeshData["messages"][string],
    },
  });
  assert.ok(
    checks(data, "error").includes("message.key_mismatch"),
    "receipts and capabilities already enforce key/id agreement; messages are the other half of the same join graph"
  );
});

test("an agent stored under a key that disagrees with its own id is an error", () => {
  const data = mesh({
    fleets: { F: fleet("F", "running") },
    agents: { "a-public": { ...agent("a-secret", "F", "running") } },
  });
  assert.ok(checks(data, "error").includes("agent.key_mismatch"));
});

test("a fleet stored under a key that disagrees with its own id is an error", () => {
  const data = mesh({ fleets: { "f-public": fleet("f-secret", "running") } });
  assert.ok(checks(data, "error").includes("fleet.key_mismatch"));
});

// --- 3. an inbox holding mail its owner was never addressed ----------------

test("an inbox holding a message its owner was never addressed is an error", () => {
  const data = mesh({
    fleets: { F: fleet("F", "complete") },
    agents: { A: agent("A", "F", "complete"), B: agent("B", "F", "complete") },
    messages: {
      M: {
        id: "M",
        fleet_id: "F",
        timestamp: 2000,
        from: "A",
        recipients: ["A"],
        acknowledged: false,
        payload: "p",
      } as MeshData["messages"][string],
    },
    inboxes: { A: [], B: ["M"] },
  });
  assert.ok(
    checks(data, "error").includes("inbox.non_recipient"),
    "the dual of receipt.non_recipient_ack — a false delivery claim made through the queue instead of a receipt"
  );
});

test("CONTROL: a legacy broadcast in a non-recipient's inbox is NOT flagged", () => {
  // Schema v1 predates the materialized recipients field, so messageRecipients
  // falls back to ["*"]. Its inbox owners are legitimately not in that set —
  // the same edge the v1→v2 migration backfills `${id}:*:ack` for.
  const data = mesh({
    fleets: { F: fleet("F", "complete") },
    agents: { A: agent("A", "F", "complete"), B: agent("B", "F", "complete") },
    messages: {
      M: {
        id: "M",
        fleet_id: "F",
        timestamp: 2000,
        from: "A",
        to_agent_id: "*",
        acknowledged: false,
        payload: "p",
      } as unknown as MeshData["messages"][string],
    },
    inboxes: { B: ["M"] },
  });
  assert.ok(
    !checks(data, "error").includes("inbox.non_recipient"),
    "a legacy broadcast has no materialized recipient list; flagging it would fail every pre-v2 ledger"
  );
});

// --- 4. a message naming a fleet the ledger does not hold ------------------

test("a message whose fleet_id names no fleet is a warning, matching agent.orphan_fleet", () => {
  const data = mesh({
    messages: {
      M: {
        id: "M",
        fleet_id: "ghost",
        timestamp: 5000,
        from: "A",
        recipients: ["B"],
        acknowledged: false,
        payload: "p",
      } as MeshData["messages"][string],
    },
  });
  assert.ok(checks(data, "warning").includes("message.orphan_fleet"));
});

// --- 5. acknowledged as a vacuous truth ------------------------------------

test("acknowledged:true over an empty recipient set is an error, not a vacuous pass", () => {
  // `every` over [] is true, so the derived-acknowledged check could never fire.
  // The write path refuses a broadcast with no recipients outright, so this row
  // cannot be produced honestly.
  const data = mesh({
    fleets: { F: fleet("F", "complete") },
    messages: {
      M: {
        id: "M",
        fleet_id: "F",
        timestamp: 2000,
        from: "A",
        recipients: [],
        acknowledged: true,
        payload: "p",
      } as MeshData["messages"][string],
    },
  });
  assert.ok(
    checks(data, "error").includes("message.vacuous_ack"),
    "the empty-fleet precedent: a vacuous 'all done' is not a finished claim"
  );
});

test("CONTROL: acknowledged:false over an empty recipient set is not flagged", () => {
  const data = mesh({
    fleets: { F: fleet("F", "complete") },
    messages: {
      M: {
        id: "M",
        fleet_id: "F",
        timestamp: 2000,
        from: "A",
        recipients: [],
        acknowledged: false,
        payload: "p",
      } as MeshData["messages"][string],
    },
  });
  assert.ok(!checks(data, "error").includes("message.vacuous_ack"));
});

// --- 6. a sealed fleet whose outcome is not the one its agents support ------
//
// Found by an adversarial lane pointed at the fix above, and it is the sharper
// half of the same defect: `fleet.sealed_with_live_agents` only fires while an
// agent is still LIVE, so a fleet sealed `complete` over a `failed` agent —
// every agent terminal, nothing running — walked straight past it. That is the
// ledger claiming success over work its own rows say failed.

test("a fleet sealed complete over a failed agent is an error", () => {
  const data = mesh({
    fleets: { F: fleet("F", "complete") },
    agents: { A: agent("A", "F", "failed") },
  });
  assert.ok(
    checks(data, "error").includes("fleet.sealed_lattice_mismatch"),
    "all agents are terminal, so the live-agent check is silent — this is where the sharper forgery hides"
  );
});

test("a fleet sealed complete over an interrupted agent is an error (lattice says abandoned)", () => {
  const data = mesh({
    fleets: { F: fleet("F", "complete") },
    agents: { A: agent("A", "F", "interrupted") },
  });
  assert.ok(checks(data, "error").includes("fleet.sealed_lattice_mismatch"));
});

test("a fleet sealed FAILED over agents that all completed is a WARNING, not an error", () => {
  // The understating direction: it asserts an error that never occurred, which
  // is false but claims less than the rows support. Same split the
  // ack_flag_mismatch pair already makes. A real ledger carries exactly this
  // shape from an older build's lattice, and reporting it as an error would
  // put a hard failure on a legacy artifact that overclaims nothing.
  const data = mesh({
    fleets: { F: fleet("F", "failed") },
    agents: { A: agent("A", "F", "complete"), B: agent("B", "F", "complete") },
  });
  assert.ok(checks(data, "warning").includes("fleet.sealed_lattice_mismatch"));
  assert.ok(!checks(data, "error").includes("fleet.sealed_lattice_mismatch"));
});

test("CONTROL: a fleet sealed failed over a failed agent is the supported outcome", () => {
  const data = mesh({
    fleets: { F: fleet("F", "failed") },
    agents: { A: agent("A", "F", "failed"), B: agent("B", "F", "complete") },
  });
  assert.ok(!checks(data, "error").includes("fleet.sealed_lattice_mismatch"));
});

// --- 7. an agent row that is both finished and not ------------------------

test("an agent recorded running while carrying completed_at is an error", () => {
  const data = mesh({
    fleets: { F: fleet("F", "running", 500) },
    agents: {
      A: { ...agent("A", "F", "running"), started_at: 1000, completed_at: 2000 } as MeshData["agents"][string],
    },
  });
  assert.ok(checks(data, "error").includes("agent.completed_while_live"));
});

test("CONTROL: a complete agent carrying completed_at is clean", () => {
  const data = mesh({
    fleets: { F: fleet("F", "complete", 500) },
    agents: {
      A: { ...agent("A", "F", "complete"), started_at: 1000, completed_at: 2000 } as MeshData["agents"][string],
    },
  });
  assert.ok(!checks(data, "error").includes("agent.completed_while_live"));
});

// --- 8. ratification identity and a vacuous threshold ---------------------

const ratScaffold = (): Partial<MeshData> => ({
  fleets: { f1: fleet("f1", "running", 500) },
  agents: { a1: agent("a1", "f1", "running"), a2: agent("a2", "f1", "running") },
  messages: {
    p1: {
      id: "p1",
      from_agent_id: "a1",
      to_agent_id: "*",
      fleet_id: "f1",
      type: "question",
      payload: "x",
      timestamp: 1000,
      acknowledged: false,
      recipients: ["a2"],
    } as unknown as MeshData["messages"][string],
  },
});

test("a ratification whose key disagrees with the proposal in its body is an error", () => {
  const data = mesh({
    ...ratScaffold(),
    ratifications: {
      "p-public": {
        message_id: "p1",
        proposer: "a1",
        fleet_id: "f1",
        subject: "s",
        quorum: 1,
        voters: ["a2"],
        required_signoffs: [],
        opened_at: 1000,
        silence_policy: "abstain",
        status: "open",
      } as unknown as MeshData["ratifications"][string],
    },
  });
  assert.ok(checks(data, "error").includes("ratification.key_mismatch"));
});

test("quorum 0 is an error — it makes a terminal status recompute as supported over zero ballots", () => {
  // The dangerous shape: with quorum 0 the tally's `approvalWeight >= quorum`
  // is satisfied by NO votes, so `ratified` recomputes to `ratified` and
  // ratification.status_mismatch stays silent. The lie does not merely pass as
  // a warning; it produces no finding at all.
  const data = mesh({
    ...ratScaffold(),
    ratifications: {
      p1: {
        message_id: "p1",
        proposer: "a1",
        fleet_id: "f1",
        subject: "s",
        quorum: 0,
        voters: ["a2"],
        required_signoffs: [],
        opened_at: 1000,
        silence_policy: "abstain",
        status: "ratified",
        resolved_at: 3000,
      } as unknown as MeshData["ratifications"][string],
    },
  });
  assert.ok(checks(data, "error").includes("ratification.invalid_quorum"));
  assert.equal(verifyMeshData(data).ok, false);
});

test("CONTROL: quorum 1 over one voter is not flagged", () => {
  const data = mesh({
    ...ratScaffold(),
    ratifications: {
      p1: {
        message_id: "p1",
        proposer: "a1",
        fleet_id: "f1",
        subject: "s",
        quorum: 1,
        voters: ["a2"],
        required_signoffs: [],
        opened_at: 1000,
        silence_policy: "abstain",
        status: "open",
      } as unknown as MeshData["ratifications"][string],
    },
  });
  assert.ok(!checks(data, "error").includes("ratification.invalid_quorum"));
});

// --- 6. a message addressed to an agent this ledger does not hold -----------
//
// Same class as the sealed-fleet hole above: the auditor HOLDS both records and
// never compares them. `data.agents` and the message's recipient set sit side by
// side, and `receipt.unknown_agent`, `capability.unknown_agent` and
// `inbox.unknown_agent` all make exactly this comparison — the message itself was
// the one addressable record with no such check. A message addressed to a
// non-existent member of a fleet this ledger fully holds can never be delivered,
// can never draw an ack, and so `acknowledged` can never derive true: it is lost,
// silently, which is priority #1.
//
// 🔴 SCOPE IS DELIBERATE AND MEASURED — the two exemptions are not conservatism,
// they are false positives observed on the operator's real ledger (72 messages,
// 880 agents), read-only, before this check was written:
//
//   - SENDERS ARE NOT CHECKED. 44 of the 71 messages whose fleet the ledger holds
//     (62%) carry a `from_agent_id` that is not an agent row: `root` (18),
//     `orchestrator` (13), `root-codex` (10), `codex-release-lead`,
//     `coordination-reviewer`, `overwatch-orchestrator`. External and human
//     senders writing into a held fleet are ordinary, honest traffic. A symmetric
//     sender check would fire on nearly two thirds of real messages, which makes
//     "the sender must be an agent" not an invariant of honest ledgers at all.
//   - MESSAGES WHOSE FLEET IS NOT HELD ARE SKIPPED. That is the cross-attached
//     case `message.orphan_fleet` already reports, and its comment states the
//     reason: a ledger may legitimately not hold a foreign fleet. Requiring the
//     fleet to be held removes cross-attachment by construction, so what is left
//     cannot be explained away by it. The single real instance on the operator's
//     ledger is exactly this case and is already reported twice
//     (`message.orphan_fleet` + `inbox.unknown_agent`); a third finding on that
//     row would be noise, not detection.
//
// With both exemptions applied the predicate fires on ZERO of the operator's 72
// live messages and ZERO of the 78 corpus fixtures.
//
// WARNING, not error, and the severity is the sibling checks' precedent, not a
// hedge: all three of `receipt.unknown_agent`, `capability.unknown_agent` and
// `inbox.unknown_agent` warn on "this ledger has not registered as an agent".
// Inventing a stricter rule here on thinner evidence than they had would be
// exactly the drift this repo audits for.

const msgScaffold = (): Partial<MeshData> => ({
  fleets: { F: fleet("F", "complete") },
  agents: { a1: agent("a1", "F", "complete"), a2: agent("a2", "F", "complete") },
});

const message = (over: Record<string, unknown>) =>
  ({
    id: "m1",
    from_agent_id: "a1",
    to_agent_id: "a2",
    fleet_id: "F",
    type: "handoff",
    payload: "p",
    timestamp: 2000,
    acknowledged: false,
    ...over,
  }) as unknown as MeshData["messages"][string];

test("a message addressed to an agent absent from a held fleet is flagged", () => {
  const data = mesh({
    ...msgScaffold(),
    messages: { m1: message({ to_agent_id: "a-ghost" }) },
  });
  assert.ok(
    checks(data, "warning").includes("message.unknown_recipient"),
    "a message addressed to a non-existent agent can never be delivered or acked — nothing else in the auditor looks at this"
  );
});

test("a broadcast whose materialized recipient list names an absent agent is flagged", () => {
  const data = mesh({
    ...msgScaffold(),
    messages: { m1: message({ to_agent_id: "*", recipients: ["a2", "a-ghost"] }) },
  });
  assert.ok(checks(data, "warning").includes("message.unknown_recipient"));
});

test("two absent recipients on one message produce ONE finding, naming both", () => {
  const data = mesh({
    ...msgScaffold(),
    messages: { m1: message({ to_agent_id: "*", recipients: ["ghost-a", "ghost-b"] }) },
  });
  const hits = verifyMeshData(data).findings.filter((f) => f.check === "message.unknown_recipient");
  assert.equal(hits.length, 1, "one message is one finding; per-recipient findings would bury a real ledger in duplicates");
  assert.equal(hits[0].subject, "m1", "the subject is the message — that is the row an operator has to go look at");
  assert.match(hits[0].detail, /ghost-a/);
  assert.match(hits[0].detail, /ghost-b/, "a finding that names only the first absent recipient hides the rest");
});

test("CONTROL: an unknown SENDER is not flagged — 62% of the operator's real messages have one", () => {
  const data = mesh({
    ...msgScaffold(),
    messages: { m1: message({ from_agent_id: "root", to_agent_id: "a2" }) },
  });
  assert.deepEqual(
    verifyMeshData(data).findings.filter((f) => f.check === "message.unknown_recipient"),
    [],
    "`root`/`orchestrator` senders are ordinary honest traffic; flagging them fires on 44 of 71 real messages"
  );
});

test("CONTROL: a message whose fleet this ledger does not hold is left to message.orphan_fleet", () => {
  const data = mesh({
    ...msgScaffold(),
    messages: { m1: message({ fleet_id: "F-foreign", to_agent_id: "a-ghost" }) },
  });
  const found = verifyMeshData(data).findings.map((f) => f.check);
  assert.ok(found.includes("message.orphan_fleet"), "the cross-attach case is already reported");
  assert.ok(
    !found.includes("message.unknown_recipient"),
    "cross-attachment legitimately leaves parties out of this ledger — a second finding here would be noise"
  );
});

test("CONTROL: the '*' broadcast placeholder is not an unknown agent", () => {
  const data = mesh({
    ...msgScaffold(),
    messages: { m1: message({ to_agent_id: "*", recipients: ["a1", "a2"] }) },
  });
  assert.ok(!checks(data, "warning").includes("message.unknown_recipient"));
});

test("CONTROL: a legacy broadcast with no recipients list is not flagged", () => {
  // schema v1 predates `recipients`, so `messageRecipients` falls back to ["*"].
  // The same fallback the receipt checks exempt by name.
  const data = mesh({
    ...msgScaffold(),
    messages: { m1: message({ to_agent_id: "*" }) },
  });
  assert.ok(!checks(data, "warning").includes("message.unknown_recipient"));
});

test("CONTROL: an ordinary message between two held agents is clean", () => {
  const data = mesh({ ...msgScaffold(), messages: { m1: message({}) } });
  assert.equal(verifyMeshData(data).ok, true);
  assert.deepEqual(verifyMeshData(data).findings, []);
});
