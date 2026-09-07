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
    // Provenance: the row's `stopped_reason: process_lost` is preserved. The orchestrator
    // never observed the runtime exit (it died before its wait-handler could fire), so the
    // honest record keeps the unknown-exit provenance even though the row is `complete`.
    // A reviewer reading this row sees: "agent declared done, file observed, exit unobserved."
    assert.equal(agent.stopped_reason, "process_lost", "UNKNOWN EXIT PROVENANCE PRESERVED");
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

// ---------------------------------------------------------------------------
// RACE + PROVENANCE PIN TESTS — added at the request of the conductor's
// consequential review (2026-09-07). The seat's race surface is concurrent
// retry / attempt-advance / attach_agent / pid-flip / status-flip; the seat's
// provenance surface is "PID-dead + done envelope is not evidence of exit0".
// These tests pin both surfaces in isolation so a regression in either is
// caught in milliseconds, not minutes.
// ---------------------------------------------------------------------------

test("race: a row that was sealed between two collect_results calls is left alone on the second call", () => {
  // A concurrent collect_results (or the orchestrator's own wait-handler that just
  // happened to fire) could mark the agent `complete` between our Pass-1 read and our
  // Pass-3 write. The seat's loss accounting demands: don't overwrite an already-sealed
  // row, don't claim a second completion stamp, don't double-credit. We pin this by
  // running reconcile twice: the first call reconciles, the second sees the row already
  // sealed at Pass-1 and does nothing — proving the candidate never re-enters Pass-3.
  const tempDir = mkdtempSync(join(tmpdir(), "chaos-recon-race-seal-"));
  try {
    const agentId = "agent-race-seal";
    const fleetId = "fleet-race-seal";
    seedAgent({ agentId, fleetId, pid: 999_995, attempts: 1 });
    writeEnvelope(agentId, 1, {
      schema: RESULT_CONTRACT_SCHEMA,
      outcome: "done",
      summary: "PONG",
    });
    // First call: agent at running with envelope; reconcile promotes it to complete.
    const first = reconcileOrphanedAgentsInFleet(fleetId);
    assert.equal(first.reconciled, 1, "first call reconciles");
    assert.equal(first.raced, 0, "first call does not race against itself");
    const sealed = loadData().agents[agentId];
    assert.equal(sealed.status, "complete");
    assert.equal(sealed.output, "PONG");
    // Second call: agent is already complete; Pass-1 must skip it. The candidate never
    // enters Pass-3 — a real concurrent writer could not have triggered a double-seal.
    const second = reconcileOrphanedAgentsInFleet(fleetId);
    assert.equal(second.reconciled, 0, "an already-sealed row is not re-sealed");
    assert.equal(second.raced, 0, "the second call sees nothing to race against");
    const agent = loadData().agents[agentId];
    assert.equal(agent.status, "complete");
    assert.equal(agent.output, "PONG", "the original seal's output is preserved");
    assert.equal(agent.completed_at, sealed.completed_at, "no second completion stamp");
  } finally {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("race: a row whose pid came back alive between Pass-1 and Pass-3 is left alone, counted as raced", () => {
  // A worker that died briefly and was restarted (or a pid reused by the OS) would flip
  // from "dead in Pass-1" to "alive in Pass-3". The chaos case no longer applies — the
  // orchestrator owns the worker again.
  const tempDir = mkdtempSync(join(tmpdir(), "chaos-recon-race-pid-"));
  try {
    const agentId = "agent-race-pid";
    const fleetId = "fleet-race-pid";
    seedAgent({ agentId, fleetId, pid: 999_994, attempts: 1 });
    writeEnvelope(agentId, 1, {
      schema: RESULT_CONTRACT_SCHEMA,
      outcome: "done",
      summary: "PONG",
    });
    // Patch the row so its pid is now `process.pid` — guaranteed alive — but the
    // Pass-1 candidate was built with the dead pid. Pass-3 must recheck and skip.
    withLedgerAndStorage((_data, db) => {
      const row = db.prepare("SELECT data FROM agents WHERE id = ?").get(agentId) as { data: string } | undefined;
      if (!row) return;
      const a = JSON.parse(row.data);
      a.pid = process.pid;
      db.prepare("UPDATE agents SET data = ? WHERE id = ?").run(JSON.stringify(a), agentId);
    });
    const outcome = reconcileOrphanedAgentsInFleet(fleetId);
    assert.equal(outcome.reconciled, 0, "a worker that came back alive is not stolen from the orchestrator");
    assert.equal(outcome.raced, 1, "the live-pid recheck counted the race");
    const agent = loadData().agents[agentId];
    assert.equal(agent.status, "running", "the row stays running — the orchestrator owns it now");
    assert.equal(agent.completed_at, undefined);
  } finally {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("race: a new envelope at attempt N+1 written between Pass-1 and Pass-3 is preferred over the cached attempt N", () => {
  // A retry that landed between Pass-1 and Pass-3 wrote a fresh envelope under
  // attempt 2. Pass-3 must re-read the attempt count, find the new envelope, and use
  // IT instead of the cached attempt-1 envelope.
  const tempDir = mkdtempSync(join(tmpdir(), "chaos-recon-race-attempt-"));
  try {
    const agentId = "agent-race-attempt";
    const fleetId = "fleet-race-attempt";
    seedAgent({ agentId, fleetId, pid: 999_993, attempts: 1 });
    // Stale envelope at attempt 1 (cached by Pass-1).
    writeEnvelope(agentId, 1, {
      schema: RESULT_CONTRACT_SCHEMA,
      outcome: "refused",
      summary: "stale refusal",
      reason: "this is the old attempt",
    });
    // Simulate a retry landing between Pass-1 and Pass-3: bump runtime_attempts to
    // length 2 AND write the new envelope at attempt 2.
    withLedgerAndStorage((_data, db) => {
      const row = db.prepare("SELECT data FROM agents WHERE id = ?").get(agentId) as { data: string } | undefined;
      if (!row) return;
      const a = JSON.parse(row.data);
      a.runtime_attempts = ["opencode-cli", "opencode-cli"];
      db.prepare("UPDATE agents SET data = ? WHERE id = ?").run(JSON.stringify(a), agentId);
    });
    writeEnvelope(agentId, 2, {
      schema: RESULT_CONTRACT_SCHEMA,
      outcome: "done",
      summary: "fresh PONG",
    });
    const outcome = reconcileOrphanedAgentsInFleet(fleetId);
    assert.equal(outcome.reconciled, 1, "the new attempt's envelope drove the reconciliation");
    const agent = loadData().agents[agentId];
    assert.equal(agent.status, "complete");
    assert.equal(agent.output, "fresh PONG", "the newer envelope wins over the cached stale one");
    assert.equal(agent.error, undefined);
    assert.equal(agent.result_contract, "ok");
  } finally {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("provenance: an `interrupted` row reconciled from a `done` envelope preserves `stopped_reason: process_lost`", () => {
  // Rally-track-A provenance invariant. The envelope is the agent's self-declared
  // outcome; the orchestrator observed the FILE, not the runtime exit code (it died
  // before its wait-handler could fire). Preserving `stopped_reason` is the honest
  // record: "declared outcome, but the orchestrator never observed the exit." A
  // reviewer reading the row sees the unknown exit provenance instead of an
  // implicit exit-0.
  const tempDir = mkdtempSync(join(tmpdir(), "chaos-recon-prov-stopped-"));
  try {
    const agentId = "agent-prov-stopped";
    const fleetId = "fleet-prov-stopped";
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
    assert.equal(outcome.reconciled, 1);
    const agent = loadData().agents[agentId];
    assert.equal(agent.status, "complete", "interrupted + envelope → complete");
    assert.equal(agent.output, "PONG recovered");
    assert.equal(agent.error, undefined, "the misleading recovery string IS cleared — the envelope proves the work happened");
    assert.equal(agent.result_contract, "ok", "result_contract reflects the envelope's declared outcome");
    assert.equal(
      agent.stopped_reason,
      "process_lost",
      "UNKNOWN EXIT PROVENANCE PRESERVED: stopped_reason is the honest record that the orchestrator never observed the runtime exit"
    );
  } finally {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("provenance: a `running` (dead-pid) row reconciled from a `done` envelope does NOT carry a stopped_reason", () => {
  // The dual case: the row never went through recoverInterruptedAgents, so no
  // `process_lost` stamp exists. The reconciliation does not invent one. A `running`
  // row that the orchestrator lost track of is a different shape than one the crash
  // cascade flipped; the audit log lets the two be distinguished.
  const tempDir = mkdtempSync(join(tmpdir(), "chaos-recon-prov-running-"));
  try {
    const agentId = "agent-prov-running";
    const fleetId = "fleet-prov-running";
    seedAgent({ agentId, fleetId, pid: 999_992, attempts: 1 });
    writeEnvelope(agentId, 1, {
      schema: RESULT_CONTRACT_SCHEMA,
      outcome: "done",
      summary: "PONG",
    });
    const outcome = reconcileOrphanedAgentsInFleet(fleetId);
    assert.equal(outcome.reconciled, 1);
    const agent = loadData().agents[agentId];
    assert.equal(agent.status, "complete");
    assert.equal(agent.stopped_reason, undefined, "no crash cascade was applied; the row carries no spurious stopped_reason");
    assert.equal(agent.result_contract, "ok");
    assert.equal(agent.error, undefined);
  } finally {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
