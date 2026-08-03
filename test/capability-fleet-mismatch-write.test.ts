/**
 * `register_capability` refuses a row that would contradict its agent's own fleet.
 *
 * The verifier check `capability.fleet_mismatch` shipped in #87 and reports this AFTER the fact —
 * which is what an audit is for, since no writer change can reach rows a ledger already holds. But
 * nothing objected at the WRITE. An operator using `fleet_id` as a logical label rather than the
 * technical fleet got a clean success and a ledger the auditor would warn about forever, with no
 * signal at the moment they created it.
 *
 * That silence was the half nobody had closed, and it is the reason this exists: the objection
 * raised against #87 — "the check invents a constraint the data was never written to honor" — is
 * answered by making the write path honor it, rather than by arguing about the check.
 *
 * The gate is the verifier's, character for character. Agent HELD, named fleet HELD, and they
 * differ. Anything else is the legitimate cross-attachment case and is accepted exactly as before,
 * which the three acceptance tests below pin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { _registerCapability, type MeshData } from "../src/core.js";

function ledger(): MeshData {
  return {
    fleets: {
      f1: { id: "f1", status: "running", created_at: 100 },
      f2: { id: "f2", status: "running", created_at: 100 },
    },
    agents: {
      a1: { id: "a1", fleet_id: "f1", role: "worker", prompt: "p", status: "running" },
    },
    messages: {},
    inboxes: {},
    capabilities: {},
    receipts: {},
    ratifications: {},
    templates: {},
  };
}

const cap = (fleetId: string, agentId = "a1") => ({
  agentId, fleetId, role: "worker", skills: ["x"],
});

test("a capability naming a HELD fleet its agent contradicts is refused at the write", () => {
  const data = ledger();
  assert.throws(
    () => _registerCapability(data, cap("f2")),
    /is registered in fleet "f1".*names fleet "f2"/s,
    "the refusal must name both fleets so the caller can see which one is wrong",
  );
  assert.deepEqual(data.capabilities, {}, "a refused write must leave no row behind");
});

test("ACCEPTED: a capability agreeing with its agent's fleet", () => {
  const data = ledger();
  _registerCapability(data, cap("f1"));
  assert.equal(data.capabilities.a1?.fleet_id, "f1");
});

test("ACCEPTED: a capability naming a fleet this ledger does not hold", () => {
  // The cross-attachment exemption. A foreign fleet advertising capabilities this ledger cannot
  // resolve is benign, and it is the whole reason the verifier's check is gated rather than
  // symmetric. The writer must not be stricter than the auditor, or it would refuse rows the
  // audit deliberately tolerates.
  const data = ledger();
  _registerCapability(data, cap("fleet-this-ledger-never-held"));
  assert.equal(data.capabilities.a1?.fleet_id, "fleet-this-ledger-never-held");
});

test("ACCEPTED: a capability for an agent this ledger has not registered", () => {
  // `capability.unknown_agent` already covers this and is only a warning. Refusing here would
  // reject the legitimate register-then-attach ordering.
  const data = ledger();
  _registerCapability(data, cap("f2", "never-registered"));
  assert.equal(data.capabilities["never-registered"]?.fleet_id, "f2");
});

test("CONTROL: the refusal is about the CONTRADICTION, not about f2 being unusable", () => {
  // Without this, the first test would pass just as well if the writer had started rejecting
  // every reference to f2 for some unrelated reason.
  const data = ledger();
  data.agents.a2 = { id: "a2", fleet_id: "f2", role: "worker", prompt: "p", status: "running" };
  _registerCapability(data, cap("f2", "a2"));
  assert.equal(data.capabilities.a2?.fleet_id, "f2", "an agent that really is in f2 may advertise f2");
});
