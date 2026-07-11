/**
 * Child process for the withLedger/SQLite concurrency proof.
 * Hammers withLedger to add unique receipts. Two of these against the same DB
 * must lose nothing — SQLite's BEGIN IMMEDIATE serializes writers.
 *
 * Usage: MESHFLEET_DB_FILE=<path> tsx withledger-writer.mjs <agentId> <count>
 */
import { withLedger } from "../../src/db.js";

const [agentId, countStr] = process.argv.slice(2);
const count = Number(countStr);

for (let i = 0; i < count; i++) {
  withLedger((d) => {
    if (!d.receipts) d.receipts = {};
    const key = `m1:${agentId}:vote-${i}`;
    d.receipts[key] = {
      message_id: "m1",
      agent_id: agentId,
      action: `vote-${i}`,
      timestamp: i,
    };
  });
}
