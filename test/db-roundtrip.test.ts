import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
  setDbPath,
  closeDb,
  withLedger,
  readLedger,
  readLedgerFile,
  importSnapshot,
} from "../src/db.js";
import type { MeshData, Fleet, Agent, Message, Capability, Receipt, Ratification } from "../src/core.js";

function makeScopedTempDb(): { dir: string; dbFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-roundtrip-"));
  const dbFile = join(dir, "ledger.db");
  setDbPath(dbFile);
  return {
    dir,
    dbFile,
    cleanup: () => {
      closeDb();
      setDbPath(null);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

test("db round-trip: write then read-back equality across all collections in a temp dir", () => {
  const scoped = makeScopedTempDb();
  try {
    const fleet: Fleet = {
      id: "f1",
      status: "running",
      created_at: 1000,
      timeout_ms: 60000,
    };

    const agent: Agent = {
      id: "a1",
      fleet_id: "f1",
      role: "engineer",
      prompt: "build feature",
      status: "running",
      started_at: 1005,
      runtime_attempts: ["runtime-a"],
      spawn_attempt: 1,
    };

    const message: Message = {
      id: "m1",
      from_agent_id: "a1",
      to_agent_id: "a2",
      fleet_id: "f1",
      type: "handoff",
      payload: '{"task":"review"}',
      timestamp: 1010,
      acknowledged: false,
      recipients: ["a2"],
    };

    const capability: Capability = {
      agent_id: "a1",
      fleet_id: "f1",
      role: "engineer",
      skills: ["typescript", "testing"],
      registered_at: 1002,
    };

    const receipt: Receipt = {
      message_id: "m1",
      agent_id: "a2",
      action: "ack",
      timestamp: 1020,
      note: "verified",
    };

    const ratification: Ratification = {
      message_id: "m1",
      proposer: "a1",
      fleet_id: "f1",
      subject: "deploy v1",
      quorum: 1,
      voters: ["a2"],
      required_signoffs: ["a2"],
      opened_at: 1015,
      silence_policy: "abstain",
      status: "open",
    };

    const template = {
      name: "worker-template",
      version: 1,
      agents: [{ role: "engineer" }],
    };

    // 1. Write data via withLedger into the scoped database
    withLedger((data) => {
      data.fleets[fleet.id] = fleet;
      data.agents[agent.id] = agent;
      data.messages[message.id] = message;
      data.inboxes[agent.id] = [message.id];
      data.capabilities[capability.agent_id] = capability;
      if (!data.receipts) data.receipts = {};
      data.receipts[`${receipt.message_id}:${receipt.agent_id}:${receipt.action}`] = receipt;
      if (!data.ratifications) data.ratifications = {};
      data.ratifications[ratification.message_id] = ratification;
      if (!data.templates) data.templates = {};
      data.templates["worker@v1"] = template;
    });

    // 2. Read back using readLedger on the active handle and verify equality
    const readBack = readLedger();
    assert.deepEqual(readBack.fleets[fleet.id], fleet);
    assert.deepEqual(readBack.agents[agent.id], agent);
    assert.deepEqual(readBack.messages[message.id], message);
    assert.deepEqual(readBack.inboxes[agent.id], [message.id]);
    assert.deepEqual(readBack.capabilities[capability.agent_id], capability);
    assert.deepEqual(
      readBack.receipts?.[`${receipt.message_id}:${receipt.agent_id}:${receipt.action}`],
      receipt
    );
    assert.deepEqual(readBack.ratifications?.[ratification.message_id], ratification);
    assert.deepEqual(readBack.templates?.["worker@v1"], template);

    // 3. Read back using readLedgerFile (cold audit connection) and verify equality
    const fileReadBack = readLedgerFile(scoped.dbFile);
    assert.deepEqual(fileReadBack.fleets, readBack.fleets);
    assert.deepEqual(fileReadBack.agents, readBack.agents);
    assert.deepEqual(fileReadBack.messages, readBack.messages);
    assert.deepEqual(fileReadBack.inboxes, readBack.inboxes);
    assert.deepEqual(fileReadBack.capabilities, readBack.capabilities);
    assert.deepEqual(fileReadBack.receipts, readBack.receipts);
    assert.deepEqual(fileReadBack.ratifications, readBack.ratifications);
    assert.deepEqual(fileReadBack.templates, readBack.templates);

    // 4. Reopen database from disk and assert durability and round-trip equality
    closeDb();
    const reopened = readLedger();
    assert.deepEqual(reopened, readBack);
  } finally {
    scoped.cleanup();
  }
});

test("db round-trip: importSnapshot then read-back equality", () => {
  const scoped = makeScopedTempDb();
  try {
    const snapshot: MeshData = {
      fleets: {
        f2: { id: "f2", status: "complete", created_at: 2000, completed_at: 3000 },
      },
      agents: {
        a2: { id: "a2", fleet_id: "f2", role: "reviewer", prompt: "audit", status: "complete" },
      },
      messages: {
        m2: {
          id: "m2",
          from_agent_id: "a2",
          to_agent_id: "a1",
          fleet_id: "f2",
          type: "result",
          payload: "done",
          timestamp: 2500,
          acknowledged: true,
        },
      },
      inboxes: { a2: [] },
      capabilities: {},
      receipts: {
        "m2:a1:ack": { message_id: "m2", agent_id: "a1", action: "ack", timestamp: 2600 },
      },
      ratifications: {},
      templates: {},
    };

    importSnapshot(snapshot);

    const readBack = readLedger();
    assert.deepEqual(readBack, snapshot);

    closeDb();
    const reopened = readLedger();
    assert.deepEqual(reopened, snapshot);
  } finally {
    scoped.cleanup();
  }
});

test("db round-trip: corrupt or partial final line in table is reported or tolerated, not silently dropped", () => {
  const scoped = makeScopedTempDb();
  try {
    // Populate valid entries first
    withLedger((data) => {
      data.fleets["f1"] = { id: "f1", status: "running", created_at: 1000 };
      data.agents["a1"] = { id: "a1", fleet_id: "f1", role: "worker", prompt: "work", status: "running" };
    });

    closeDb();

    // Directly corrupt the final row / line of data in the SQLite database table
    const directDb = new Database(scoped.dbFile);
    directDb.prepare("INSERT INTO fleets (id, data) VALUES (?, ?)").run("f_corrupt", '{"id":"f_corrupt", "status":'); // partial/truncated JSON line
    directDb.close();

    // Reopen via src/db.ts: reading corrupt row must report/throw error, NOT silently drop or pretend it does not exist
    let thrownError: unknown = null;
    try {
      readLedger();
    } catch (err) {
      thrownError = err;
    }

    assert.ok(
      thrownError instanceof SyntaxError || (thrownError instanceof Error && /JSON/i.test(thrownError.message)),
      `expected corrupt/partial line to be reported via SyntaxError, got: ${thrownError}`
    );

    // Also verify readLedgerFile reports the error rather than silently dropping
    let auditError: unknown = null;
    try {
      readLedgerFile(scoped.dbFile);
    } catch (err) {
      auditError = err;
    }

    assert.ok(
      auditError instanceof SyntaxError || (auditError instanceof Error && /JSON/i.test(auditError.message)),
      `expected readLedgerFile to report corrupt line, got: ${auditError}`
    );
  } finally {
    scoped.cleanup();
  }
});
