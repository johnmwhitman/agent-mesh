import { setTimeout as sleep } from "node:timers/promises";
import { writeReceipt, setEventLogPath } from "../../src/core.js";
import { setDbPath } from "../../src/db.js";

const [agentId, messageId, eventLogFile] = process.argv.slice(2);

if (!agentId || !messageId || !eventLogFile) {
  process.stderr.write("usage: chaos-durability-child.ts <agentId> <messageId> <eventLogPath>\n");
  process.exit(1);
}

const dbFile = process.env.MESHFLEET_DB_FILE;
if (!dbFile) {
  process.stderr.write("MESHFLEET_DB_FILE must be set for the chaos helper\n");
  process.exit(1);
}

setDbPath(dbFile);
setEventLogPath(eventLogFile);

let i = 0;

for (;;) {
  const action = `chaos-${i++}-${Date.now()}-${process.pid}`;
  const receipt = writeReceipt(agentId, messageId, action);
  if (receipt) {
    process.stdout.write(`${receipt.message_id}:${receipt.agent_id}:${receipt.action}\n`);
  }
  await sleep(1);
}
