/**
 * A child instance must not run startup recovery on the shared ledger.
 *
 * When a spawned agent runs its own `opencode` session, that session boots ITS
 * OWN agent-mesh MCP server against the SAME ledger as the parent. If the child
 * ran startup recovery it would see the parent's genuinely-live agents as
 * crashed work and flip them to `interrupted`. That is not hypothetical: on
 * 2026-07-02 it wrongly interrupted 31 of 52 agents, and `AGENT_MESH_CHILD=1`
 * (src/index.ts) is the guard added in response.
 *
 * Until now nothing tested it. `recovery.test.ts` covers the recovery function
 * itself and `mcp-stdio.test.ts` boots with `AGENT_MESH_CHILD=1` but only
 * asserts the tool list, so the one thing child mode exists to NOT do was
 * unpinned. The only artifact that gestured at this property was
 * `scripts/validate-gates.mjs`, which required a live `opencode` and real model
 * calls, had been broken since the 0.12.0 SQLite migration, and was referenced
 * by no workflow — a safety net that had not existed for thirteen releases.
 *
 * The parent leg is the control. Asserting only that a child leaves the agent
 * alone would pass just as happily if recovery were broken outright, or if the
 * seed never qualified for recovery in the first place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setDbPath, closeDb, readLedger, importSnapshot } from "../src/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "..", "src", "index.ts");

/** A running agent with no recorded pid — recovery's definition of crashed work. */
function seedRunningAgent(): void {
  importSnapshot({
    fleets: { f1: { id: "f1", status: "running", created_at: 1 } },
    agents: {
      a1: { id: "a1", fleet_id: "f1", role: "worker", prompt: "p", status: "running", started_at: 1 },
    },
    messages: {},
    inboxes: {},
    capabilities: {},
    receipts: {},
    ratifications: {},
    templates: {},
  });
}

/**
 * Boot the real MCP server against `dbFile`, wait for its startup banner on
 * stderr, then stop it. Returns the banner so the caller can confirm which mode
 * actually booted rather than assuming the env var took effect.
 */
function bootServer(dbFile: string, dir: string, asChild: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      // All THREE isolation vars. MESHFLEET_DB_FILE alone is not isolation: the
      // migrator reads the JSON ledger, and an undeclared data file makes it
      // refuse (loudly) rather than proceed. The event log needs its own
      // redirect because a spawned child inherits environment, not module state.
      MESHFLEET_DB_FILE: dbFile,
      MESHFLEET_DATA_FILE: join(dir, "ledger.json"),
      MESHFLEET_EVENT_LOG_FILE: join(dir, "events.log"),
      MESHFLEET_RATIFY_SWEEP_MS: "0", // no competing sweeper timer in a test
      // An explicit unusual port, NOT 0: `ssePort()` accepts only `v > 0`, so 0
      // silently falls back to the default 13579 — which a developer's real
      // running instance is likely to already hold. The parent leg tolerates a
      // bind failure either way (it logs and still announces startup), but the
      // test should not reach for a port that belongs to something else.
      MESHFLEET_SSE_PORT: "13991",
    };
    if (asChild) env.AGENT_MESH_CHILD = "1";
    else delete env.AGENT_MESH_CHILD; // never inherit it from the outer runner

    // `process.execPath --import tsx` rather than npx: on Windows spawn("npx")
    // is ENOENT, and this matches how the suite itself runs.
    const p = spawn(process.execPath, ["--import", "tsx", SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    let stderr = "";
    const done = (fn: () => void): void => {
      clearTimeout(timer);
      p.kill();
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error(`server did not announce startup in 30s. stderr:\n${stderr}`))),
      30_000
    );

    p.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
      if (stderr.includes("started")) {
        // The banner is written after startup recovery has run (or been
        // skipped), so it is a safe point to stop and inspect the ledger.
        done(() => resolve(stderr));
      }
    });
    p.on("error", (err) => done(() => reject(err)));
    p.on("exit", (code) => {
      if (!stderr.includes("started")) {
        done(() => reject(new Error(`server exited ${code} before starting. stderr:\n${stderr}`)));
      }
    });
  });
}

function statusOf(dbFile: string, agentId: string): string | undefined {
  setDbPath(dbFile);
  try {
    return readLedger().agents[agentId]?.status;
  } finally {
    closeDb();
  }
}

test("a CHILD instance leaves the parent's running agents alone; a PARENT instance recovers them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-child-guard-"));
  const dbFile = join(dir, "ledger.db");
  try {
    setDbPath(dbFile);
    seedRunningAgent();
    closeDb(); // release the WAL sidecars before another process opens the file
    assert.equal(statusOf(dbFile, "a1"), "running", "seed did not take");

    // --- child leg: recovery must be SKIPPED -------------------------------
    const childBanner = await bootServer(dbFile, dir, true);
    assert.match(
      childBanner,
      /child mode/,
      "the child leg did not actually boot in child mode, so it proves nothing"
    );
    assert.equal(
      statusOf(dbFile, "a1"),
      "running",
      "a child instance ran startup recovery and flipped the parent's live agent to interrupted — this is the 2026-07-02 incident"
    );

    // --- parent leg (control): recovery must RUN ---------------------------
    // Without this the assertion above would pass even if recovery were broken
    // outright, or if the seeded agent never qualified for recovery at all.
    const parentBanner = await bootServer(dbFile, dir, false);
    assert.doesNotMatch(parentBanner, /child mode/, "the control leg booted in child mode");
    assert.equal(
      statusOf(dbFile, "a1"),
      "interrupted",
      "a parent instance did NOT recover a crashed agent — recovery is broken, which would also make the child assertion above vacuous"
    );
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});
