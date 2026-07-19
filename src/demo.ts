/**
 * `agent-mesh demo` — a 60-second, host-free walkthrough (demo-ends-verified).
 *
 * No OpenCode, no MCP client, no network. Seeds a fixture fleet into a TEMP
 * ledger via the REAL library functions — the same code paths the MCP server
 * runs — narrates each step, and ends with a genuine `verifyLedger()` audit
 * printed through the real formatter. Nothing outside the temp dir is touched:
 * the db path, the MESHFLEET_DB_FILE env override, and the event log are all
 * pointed into a mkdtemp dir for the duration and restored afterwards.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BROADCAST,
  createFleet,
  registerAgentInLedger,
  sendMessage,
  ackMessage,
  writeReceipt,
  setEventLogPath,
  resolveEventLogFile,
  type Agent,
  type Ratification,
} from "./core.js";
import { openRatification, castVote, resolveRatification } from "./ratify.js";
import { setDbPath, closeDb, getDbPathOverride } from "./db.js";
import { verifyLedger, type VerifyReport } from "./verify.js";
import { formatVerifyReport } from "./inspector.js";

export interface DemoResult {
  /** The REAL verifier's report over the demo ledger. */
  report: VerifyReport;
  /** The formatted verify output the demo ends with (formatVerifyReport). */
  verifyLine: string;
  /** Terminal status of the demo council — "ratified" on a healthy run. */
  ratificationStatus: Ratification["status"] | null;
  /** The mkdtemp dir the demo ledger lived in (removed before returning). */
  tempDir: string;
  /** The demo ledger file (inside tempDir; gone by the time this returns). */
  dbFile: string;
}

const FLEET_ID = "demo-fleet";

function demoAgent(id: string, role: string): Agent {
  return {
    id,
    fleet_id: FLEET_ID,
    role,
    prompt: `You are the demo ${role}.`,
    status: "running",
    started_at: Date.now(),
  };
}

const short = (id: string): string => id.slice(0, 8);

/**
 * Run the walkthrough. Throws on any failed step (the CLI turns that into a
 * loud exit 1). `quiet: true` suppresses narration — used by tests, which
 * assert on the returned report rather than the prose.
 */
export function runDemo(opts: { quiet?: boolean } = {}): DemoResult {
  const say = opts.quiet
    ? (_line: string): void => {}
    : (line: string): void => {
        process.stdout.write(line + "\n");
      };

  // -- Isolation: point EVERYTHING at a throwaway temp dir -------------------
  // MESHFLEET_DB_FILE outranks setDbPath, so the env var is overridden too —
  // a user whose env pins their real ledger must still be untouched.
  // Capture the RAW override, not resolveDbFile(): the env var outranks
  // setDbPath, so resolving would bake the env value into the restore and lose
  // a hidden setDbPath target beneath it.
  const prevDbOverride = getDbPathOverride();
  const prevEventLog = resolveEventLogFile();
  const prevEnvDb = process.env.MESHFLEET_DB_FILE;
  const tempDir = mkdtempSync(join(tmpdir(), "agent-mesh-demo-"));
  const dbFile = join(tempDir, "demo-ledger.db");
  process.env.MESHFLEET_DB_FILE = dbFile;
  setDbPath(dbFile);
  setEventLogPath(join(tempDir, "demo-events.log"));

  try {
    // -- 1. Intro --------------------------------------------------------------
    say("agent-mesh demo — meshfleet in 60 seconds");
    say("  meshfleet coordinates parallel agent fleets: P2P messages, witnessed receipts, quorum councils — who saw this, who approved it, prove it.");
    say("  This demo seeds a throwaway fleet into a TEMP ledger and then audits it for real. Nothing outside this temp dir is touched:");
    say(`  ${tempDir}`);
    say("");

    // -- 2. Seed: fleet + agents ----------------------------------------------
    const fleet = createFleet(FLEET_ID);
    say(`[1/6] Fleet "${fleet.id}" created (status: ${fleet.status}).`);

    const roles = ["reviewer", "tester", "scribe"] as const;
    for (const role of roles) registerAgentInLedger(demoAgent(role, role));
    say(`[2/6] Registered 3 agents: ${roles.join(", ")}.`);

    // -- Handoff reviewer -> tester, acked ------------------------------------
    const handoff = sendMessage(
      "reviewer",
      "tester",
      FLEET_ID,
      "handoff",
      "Diff reviewed clean — please run the suite."
    );
    if (!ackMessage("tester", handoff.messageId)) {
      throw new Error(`demo handoff ${handoff.messageId} could not be acked`);
    }
    say(`[3/6] Handoff reviewer → tester (msg ${short(handoff.messageId)}); tester ACKed.`);
    say(`      receipt ${short(handoff.messageId)}:tester:ack — consumed from the inbox, witnessed in the ledger.`);

    // -- Broadcast with one ack + one witnessed 'seen' -------------------------
    const broadcast = sendMessage(
      "reviewer",
      BROADCAST,
      FLEET_ID,
      "result",
      "Suite green across the fleet."
    );
    if (!ackMessage("tester", broadcast.messageId)) {
      throw new Error(`demo broadcast ${broadcast.messageId} could not be acked`);
    }
    const seen = writeReceipt("scribe", broadcast.messageId, "seen", "logged for the record");
    if (!seen) throw new Error(`demo broadcast ${broadcast.messageId} rejected scribe's 'seen' receipt`);
    say(`[4/6] Broadcast reviewer → * (msg ${short(broadcast.messageId)}) reached ${broadcast.recipients.join(", ")}.`);
    say(`      tester ACKed; scribe wrote a '${seen.action}' receipt — witnessed without consuming.`);

    // -- Council: proposal, weighted votes, one honest re-cast, resolve --------
    const proposalId = openRatification({
      proposer: "reviewer",
      fleetId: FLEET_ID,
      subject: "Ship the demo build",
      quorum: 3,
      weights: { tester: 2, scribe: 1 },
    });
    say(`[5/6] Council opened by reviewer: "Ship the demo build" (proposal ${short(proposalId)}, quorum 3, weights tester=2 scribe=1).`);

    castVote("tester", proposalId, false, "flaky test, holding the line");
    say("      tester voted REJECT (r-decline).");
    castVote("scribe", proposalId, true, "docs are ready");
    say("      scribe voted APPROVE (r-ack) — tally 1/3, still short.");
    castVote("tester", proposalId, true, "flake fixed — changing my vote");
    say("      tester RE-CAST to APPROVE (r-ack:1) — history is append-only; the latest cast wins, the reversal stays on the record.");

    const status = resolveRatification(proposalId);
    if (status !== "ratified") {
      throw new Error(`demo council resolved to ${String(status)}, expected "ratified"`);
    }
    say(`      Resolved: RATIFIED (approval weight 3/3).`);
    say("");

    // -- 3. Finale: the REAL verifier ------------------------------------------
    say("[6/6] Auditing the demo ledger with the real verifier (the same code behind `agent-mesh inspect --verify`):");
    say("");
    const report = verifyLedger();
    const verifyLine = formatVerifyReport(report);
    say(verifyLine);
    if (!report.ok) {
      throw new Error(`demo ledger failed verification: ${report.errors} error(s)`);
    }
    say("");
    say("Next steps:");
    say('  1. Wire the MCP server into your client: add meshfleet ("command": "npx", "args": ["meshfleet"]) to your mcp.json.');
    say("  2. Audit your own ledger any time: npx agent-mesh inspect --verify");
    say("  3. Full tour and spec: README.md — https://meshfleet.app");

    return { report, verifyLine, ratificationStatus: status, tempDir, dbFile };
  } finally {
    // -- 4. Cleanup: close, restore every path, delete the temp dir ------------
    closeDb();
    if (prevEnvDb === undefined) delete process.env.MESHFLEET_DB_FILE;
    else process.env.MESHFLEET_DB_FILE = prevEnvDb;
    if (prevDbOverride !== null) setDbPath(prevDbOverride);
    setEventLogPath(prevEventLog);
    rmSync(tempDir, { recursive: true, force: true });
  }
}
