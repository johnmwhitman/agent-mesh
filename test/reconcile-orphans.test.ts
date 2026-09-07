/**
 * Unit tests for `reconcileOrphanedAgentsInFleet`.
 *
 * The chaos-durability test (`test/chaos-detached-exchange.test.ts`) pins the property
 * end-to-end against a real MCP server and a sleeping child. THIS file pins the function in
 * isolation — no spawned processes, no stdio transports — so a regression in the
 * reconciliation logic is caught in milliseconds, not minutes. The two layers are designed
 * to fail independently: the e2e test exercises the wiring, these unit tests exercise the
 * shape of each branch.
 *
 * Every test seeds its own temp ledger, writes a `RESULT_PATH` envelope to disk, and calls
 * `reconcileOrphanedAgentsInFleet` directly. The four cases are:
 *
 *   - `done` envelope → row sealed `complete`, fleet advances to complete.
 *   - `refused` envelope → row sealed `failed` with the envelope's reason.
 *   - pid still alive → row left alone (a real worker, not the chaos case).
 *   - durable fleet → function is a no-op (the durable lane owns its recovery).
 *
 * The fourth case exists because durable fleets have a `LifecycleExecutionCoordinator.recover()`
 * with its own lease authority; calling `reconcileOrphanedAgentsInFleet` on a durable fleet
 * would race the coordinator's own settle, so the function self-disables there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, withLedgerAndStorage } from "../src/db.js";
import {
  loadData,
  reconcileOrphanedAgentsInFleet,
} from "../src/core.js";
import { resultPathFor, RESULT_CONTRACT_SCHEMA } from "../src/result-contract.js";
import { withTempDb } from "./helpers/with-temp-db.js";

function writeEnvelope(agentId: string, attempt: number, payload: object): string {
  // Use the same path the orchestrator would have given the worker. resultPathFor is the
  // SINGLE source of truth for this naming, so a refactor of the path layout can never
  // silently desync the test from the system under test.
  const path = resultPathFor(agentId, attempt);
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

function seedAgent(opts: {
  agentId: string;
  fleetId: string;
  /** A pid that's been around long enough to be reasonably checkable on the test host. */
  pid?: number;
  /** Number to set on `runtime_attempts` — used as the attempt id for the envelope lookup. */
  attempts?: number;
}): void {
  // `withLedger` mutates the same store the function under test reads.  Use it directly
  // rather than going through `_registerAgent` so the seeded row carries exactly the
  // fields the orphan-reconciliation cares about (status="running", runtime_attempts length
  // the seed specified, optional pid).
  const seed = {
    fleets: {
      [opts.fleetId]: { id: opts.fleetId, status: "running" as const, created_at: Date.now() },
    },
    agents: {
      [opts.agentId]: {
        id: opts.agentId,
        fleet_id: opts.fleetId,
        role: "r",
        prompt: "p",
        status: "running" as const,
        started_at: Date.now(),
        ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
        ...(opts.attempts !== undefined ? { runtime_attempts: new Array(opts.attempts).fill("opencode-cli") } : {}),
      },
    },
    messages: {},
    inboxes: {},
    capabilities: {},
    receipts: {},
    ratifications: {},
    templates: {},
  };
  // Persist via withTempDb's `seed` so the SQLite shape stays consistent with the rest of
  // the suite — bypassing setDbPath here would leave the function under test reading an
  // empty database and reporting `reconciled: 0` for what is otherwise a clean failure.
  withTempDb(seed);
}

test("reconcile: a `done` envelope on a dead-pid agent seals `complete`", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "chaos-recon-done-"));
  try {
    const agentId = "agent-done";
    const fleetId = "fleet-done";
    seedAgent({ agentId, fleetId, pid: 999_999 /* almost certainly gone */, attempts: 1 });
    writeEnvelope(agentId, 1, {
      schema: RESULT_CONTRACT_SCHEMA,
      outcome: "done",
      summary: "pong-from-test",
    });
    const outcome = reconcileOrphanedAgentsInFleet(fleetId);
    assert.equal(outcome.reconciled, 1, "exactly one reconciliation happens for one envelope");
    assert.equal(outcome.unreadable, 0, "an envelope that parses is not unreadable");
    assert.equal(outcome.live, 0, "a dead pid is not a live worker");
    const agent = loadData().agents[agentId];
    assert.equal(agent.status, "complete");
    assert.equal(agent.output, "pong-from-test");
    assert.equal(agent.error, undefined);
    assert.equal(agent.result_contract, "ok");
    assert.ok(agent.completed_at !== undefined, "completion stamp is set");
    // Fleet completion MUST be projected in the same transaction — otherwise the fleet
    // would stay `running` forever.
    assert.equal(loadData().fleets[fleetId].status, "complete");
  } finally {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reconcile: a `refused` envelope on a dead-pid agent seals `failed` with the envelope's reason", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "chaos-recon-refused-"));
  try {
    const agentId = "agent-refused";
    const fleetId = "fleet-refused";
    seedAgent({ agentId, fleetId, pid: 999_998, attempts: 1 });
    writeEnvelope(agentId, 1, {
      schema: RESULT_CONTRACT_SCHEMA,
      outcome: "refused",
      summary: "model provider returned 402",
      reason: "Usage balance exhausted on the upstream account.",
    });
    const outcome = reconcileOrphanedAgentsInFleet(fleetId);
    assert.equal(outcome.reconciled, 1);
    const agent = loadData().agents[agentId];
    assert.equal(agent.status, "failed");
    assert.equal(agent.output, "model provider returned 402");
    assert.equal(agent.error, "Usage balance exhausted on the upstream account.");
    assert.equal(agent.result_contract, "refused");
  } finally {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reconcile: an alive pid is left alone (a real worker, not the chaos case)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "chaos-recon-live-"));
  try {
    const agentId = "agent-live";
    const fleetId = "fleet-live";
    // Use the test process's own pid — guaranteed alive for the duration of the test, and
    // a regular integer the liveness probe accepts.
    seedAgent({ agentId, fleetId, pid: process.pid, attempts: 1 });
    // No envelope written. Function must see the live pid, decide this is a running worker
    // NOT a chaos orphan, and do nothing.
    const outcome = reconcileOrphanedAgentsInFleet(fleetId);
    assert.equal(outcome.reconciled, 0, "live workers are not reconciled");
    assert.equal(outcome.live, 1, "an alive pid is reported as live");
    const agent = loadData().agents[agentId];
    assert.equal(agent.status, "running", "live worker keeps its running status");
    assert.equal(agent.completed_at, undefined, "live worker has no completion stamp");
  } finally {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reconcile: an `interrupted` row that recovers against an envelope IS promoted to `complete`", () => {
  // Rally Track A recovery case: the previous server's boot sweep flipped the agent to
  // `interrupted, stopped_reason: process_lost` before this code saw the envelope. A later
  // `collect_results` MUST reconcile the row to match the orphan's declared outcome —
  // otherwise the loss accounting stays wrong (the orphan completed but the next collect
  // reports the work lost).
  const tempDir = mkdtempSync(join(tmpdir(), "chaos-recon-promote-"));
  try {
    const agentId = "agent-promote";
    const fleetId = "fleet-promote";
    // Direct-seed, bypassing the seedAgent helper so we can put the row at status
    // "interrupted" up front — the recovery exactly reconciles that state.
    const seed = {
      fleets: { [fleetId]: { id: fleetId, status: "abandoned" as const, created_at: Date.now() } },
      agents: {
        [agentId]: {
          id: agentId,
          fleet_id: fleetId,
          role: "r",
          prompt: "p",
          status: "interrupted" as const,
          started_at: Date.now() - 1_000,
          completed_at: Date.now() - 500,
          // recoverInterruptedAgents sets this exact error string on the chaos path.
          error: "MCP server crashed before this agent completed. This agent cannot be resumed; attach a replacement to the fleet with attach_agent, or re-run the work with spawn_fleet.",
          stopped_reason: "process_lost" as const,
          runtime_attempts: ["opencode-cli"],
        },
      },
      messages: {},
      inboxes: {},
      capabilities: {},
      receipts: {},
      ratifications: {},
      templates: {},
    };
    withTempDb(seed);
    writeEnvelope(agentId, 1, {
      schema: RESULT_CONTRACT_SCHEMA,
      outcome: "done",
      summary: "PONG recovered",
    });
    const outcome = reconcileOrphanedAgentsInFleet(fleetId);
    assert.equal(outcome.reconciled, 1, "an interrupted row with an envelope IS reconciled");
    const agent = loadData().agents[agentId];
    assert.equal(agent.status, "complete", "interrupted + envelope → complete");
    assert.equal(agent.output, "PONG recovered");
    assert.equal(agent.result_contract, "ok");
    assert.equal(agent.error, undefined, "the crash-cascade error string is cleared when the envelope proves the work happened");
  } finally {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reconcile: a torn / unparseable envelope is left unreadable (no fabricated measurement)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "chaos-recon-torn-"));
  try {
    const agentId = "agent-torn";
    const fleetId = "fleet-torn";
    seedAgent({ agentId, fleetId, pid: 999_997, attempts: 1 });
    // Garbage bytes the parser would reject — the spec markers don't match, and the JSON
    // shape is missing fields. Recording an outcome we cannot verify is exactly what this
    // test pins against (design-adversarial comment in core.ts).
    writeEnvelope(agentId, 1, { totally_unrelated: true });
    const outcome = reconcileOrphanedAgentsInFleet(fleetId);
    assert.equal(outcome.reconciled, 0, "garbage envelopes do not reconcile");
    assert.equal(outcome.unreadable, 1, "garbage envelopes count as unreadable");
    const agent = loadData().agents[agentId];
    assert.equal(agent.status, "running", "an unreadable envelope does NOT seal the row");
    // This is the property the seat's loss accounting depends on: an agent whose envelope
    // is unreadable remains visible as `running` for the next reconciliation attempt, NOT
    // silently flipped to `failed`. A fabricated seal here would assign the worker an
    // outcome nobody observed.
  } finally {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reconcile: durable fleets are skipped (the coordinator owns them)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "chaos-recon-durable-"));
  try {
    const agentId = "agent-durable";
    const fleetId = "fleet-durable";
    seedAgent({ agentId, fleetId, pid: 999_996, attempts: 1 });
    // Mark the fleet durable in SQLite. The reconciliation function reads this column via
    // withLedgerAndStorage and self-disables; the agent row stays untouched.
    withLedgerAndStorage((_data, db) => {
      db.prepare("INSERT INTO fleets (id, data, lifecycle_mode) VALUES (?, '{}', 'durable') ON CONFLICT(id) DO UPDATE SET lifecycle_mode = excluded.lifecycle_mode")
        .run(fleetId);
    });
    // Even with an envelope on disk, durable fleets must NOT reconcile here. Their
    // LifecycleExecutionCoordinator recovers via a different mechanism that we wouldn't
    // want to race.
    writeEnvelope(agentId, 1, { schema: RESULT_CONTRACT_SCHEMA, outcome: "done", summary: "x" });
    const outcome = reconcileOrphanedAgentsInFleet(fleetId);
    assert.equal(outcome.reconciled, 0, "durable fleets are not touched");
    assert.equal(loadData().agents[agentId].status, "running");
  } finally {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
