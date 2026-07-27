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
