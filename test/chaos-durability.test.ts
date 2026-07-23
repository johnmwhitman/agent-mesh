import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import Database from "better-sqlite3";
import { readLedger, withLedger, closeDb } from "../src/db.js";
import { verifyMeshData } from "../src/verify.js";
import { withTempDb } from "./helpers/with-temp-db.js";

const here = dirname(fileURLToPath(import.meta.url));
const CHILD_SCRIPT = join(here, "helpers", "chaos-durability-child.ts");
const CHAOS_AGENTS = ["storm-a", "storm-b", "storm-c", "storm-d"] as const;
const CHAOS_MESSAGE = "chaos-message";
const CYCLES = 10;
const MIN_KILL_DELAY_MS = 50;
const MAX_KILL_DELAY_MS = 200;

type Ran = () => number;

function makeRng(seed: number): Ran {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
}

function randRange(rng: Ran, min: number, max: number): number {
  return min + (rng() % (max - min + 1));
}

function runTest(
  name: string,
  fn: () => void | Promise<void>,
): void {
  if (process.platform === "win32") {
    test(name, { skip: "POSIX signals are required" }, () => {});
    return;
  }
  test(name, fn);
}

function withStormSeed() {
  return withTempDb({
    fleets: { chaos: { id: "chaos", status: "running", created_at: 1 } },
    agents: Object.fromEntries(
      CHAOS_AGENTS.map((agentId) => [
        agentId,
        {
          id: agentId,
          fleet_id: "chaos",
          role: "worker",
          prompt: "chaos",
          status: "running",
        },
      ]),
    ) as Record<string, {
      id: string;
      fleet_id: string;
      prompt: string;
      role: string;
      status: "running";
    }>,
    messages: {
      [CHAOS_MESSAGE]: {
        id: CHAOS_MESSAGE,
        from_agent_id: CHAOS_AGENTS[0],
        to_agent_id: CHAOS_AGENTS[1],
        fleet_id: "chaos",
        type: "handoff",
        payload: "chaos storm",
        timestamp: 1,
        acknowledged: false,
      },
    },
    inboxes: {
      [CHAOS_AGENTS[0]]: [],
      [CHAOS_AGENTS[1]]: [CHAOS_MESSAGE],
      [CHAOS_AGENTS[2]]: [],
      [CHAOS_AGENTS[3]]: [],
    },
  });
}

function spawnChild(agentId: string, dbFile: string, eventLog: string): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ["--import", "tsx", CHILD_SCRIPT, agentId, CHAOS_MESSAGE, eventLog],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MESHFLEET_DB_FILE: dbFile },
    },
  );
}

function collectIds(proc: ChildProcessWithoutNullStreams, sink: Set<string>): void {
  let buffer = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const id = line.trim();
      if (id) sink.add(id);
    }
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}

async function killAll(children: ChildProcessWithoutNullStreams[]): Promise<void> {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode === null) child.kill("SIGKILL");
      await waitForExit(child);
    }),
  );
}

async function runCheckpoint(dbFile: string): Promise<void> {
  const reader = new Database(dbFile, { readonly: true, fileMustExist: true });
  reader.prepare("SELECT 1").get();
  reader.close();

  const db = new Database(dbFile);
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        db.pragma("wal_checkpoint(FULL)");
        return;
      } catch (err) {
        if (
          (err as NodeJS.ErrnoException).code !== "SQLITE_BUSY"
          && (err as NodeJS.ErrnoException).code !== "SQLITE_LOCKED"
          && (err as NodeJS.ErrnoException).code !== "SQLITE_INTERRUPT"
        ) throw err;
        await sleep(10);
      }
    }
    throw new Error("wal_checkpoint failed repeatedly under storm load");
  } finally {
    db.close();
  }
}

async function runChaosStorm(options: { checkpoint: boolean }): Promise<{
  dbFile: string;
  committed: Set<string>;
  cleanup: () => void;
}> {
  const seed = withStormSeed();
  const dbFile = seed.dbFile;
  const eventLog = join(seed.dir, "events.log");
  const rng = makeRng(0x4cc5ce1);
  const committed = new Set<string>();

  const children = CHAOS_AGENTS.map((agentId) => {
    const child = spawnChild(agentId, dbFile, eventLog);
    collectIds(child, committed);
    return child;
  });

  try {
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      await sleep(randRange(rng, MIN_KILL_DELAY_MS, MAX_KILL_DELAY_MS));
      const index = randRange(rng, 0, CHAOS_AGENTS.length - 1);
      const victim = children[index];
      if (victim.exitCode === null) {
        victim.kill("SIGKILL");
        await waitForExit(victim);
      }
      children[index] = spawnChild(CHAOS_AGENTS[index], dbFile, eventLog);
      collectIds(children[index], committed);
      if (options.checkpoint) await runCheckpoint(dbFile);
    }
    await sleep(250);
  } finally {
    await killAll(children);
    closeDb();
  }

  return {
    dbFile,
    committed,
    cleanup: () => {
      seed.cleanup();
    },
  };
}

runTest("LH-39: SIGKILL mid-write storm never loses committed receipts", async () => {
  const { committed, cleanup } = await runChaosStorm({ checkpoint: false });
  const data = readLedger();
  for (const id of committed) {
    assert.ok(data.receipts?.[id], `committed receipt missing after storm: ${id}`);
  }
  const report = verifyMeshData(data);
  assert.equal(report.ok, true);
  assert.equal(report.errors, 0);
  closeDb();
  cleanup();
});

runTest("LH-39: kill during checkpoint preserves committed writes", async () => {
  const { committed, cleanup } = await runChaosStorm({ checkpoint: true });
  const data = readLedger();
  for (const id of committed) {
    assert.ok(data.receipts?.[id], `committed receipt missing after checkpoint storm: ${id}`);
  }
  const report = verifyMeshData(data);
  assert.equal(report.ok, true);
  assert.equal(report.errors, 0);
  closeDb();
  cleanup();
});

runTest("LH-39: post-storm recovery can take a fresh withLedger write", async () => {
  const { cleanup } = await runChaosStorm({ checkpoint: false });
  const data = readLedger();
  const messageId = `recovery-open-${Date.now()}`;
  closeDb();
  withLedger((d) => {
    d.messages[messageId] = {
      id: messageId,
      from_agent_id: CHAOS_AGENTS[0],
      to_agent_id: CHAOS_AGENTS[1],
      fleet_id: "chaos",
      type: "handoff",
      payload: "recovery-open probe",
      timestamp: Date.now(),
      acknowledged: false,
    };
    d.inboxes[CHAOS_AGENTS[1]].push(messageId);
    d.inboxes[CHAOS_AGENTS[1]] = [...new Set(d.inboxes[CHAOS_AGENTS[1]])];
  });
  const reopened = readLedger();
  assert.ok(reopened.messages[messageId], "withLedger write should succeed after crash storm");

  closeDb();
  cleanup();
});
