import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sendMessage,
  writeReceipt,
  registerAgentInLedger,
  setEventLogPath,
  DEFAULT_EVENT_LOG,
} from "../dist/core.js";
import { tallyRatification } from "../dist/ratify.js";
import { setDbPath, closeDb, importSnapshot } from "../dist/db.js";

async function runBenchmark() {
  const dir = mkdtempSync(join(tmpdir(), "p2p-bench-"));
  setEventLogPath(join(dir, "events.log"));
  setDbPath(join(dir, "bench.db"));
  
  const fleetId = "f1";
  const numMessages = 100;
  
  // Setup
  importSnapshot({ 
    fleets: { [fleetId]: { id: fleetId, status: "running" } },
    agents: {
      a1: { id: "a1", fleet_id: fleetId, status: "running" },
      a2: { id: "a2", fleet_id: fleetId, status: "running" }
    },
    messages: {}, inboxes: { a2: [] }, capabilities: {}, receipts: {}, ratifications: {} 
  });

  console.log(`Running P2P benchmark: ${numMessages} concurrent dispatches...`);

  const t0 = performance.now();

  // 1. Dispatch
  const messages = [];
  for (let i = 0; i < numMessages; i++) {
    messages.push(sendMessage("a1", "a2", fleetId, "test", `payload-${i}`));
  }
  
  // 2. Receipt Generation
  for (let i = 0; i < numMessages; i++) {
    writeReceipt({
      message_id: `m${i}`,
      agent_id: "a2",
      action: "ack",
      timestamp: Date.now()
    });
  }

  // 3. Tally Quorum
  tallyRatification(fleetId);

  const t1 = performance.now();
  const totalMs = t1 - t0;
  const throughput = (numMessages / (totalMs / 1000)).toFixed(2);
  const latency = (totalMs / numMessages).toFixed(2);

  console.log(`\nResults:`);
  console.log(`Total Messages: ${numMessages}`);
  console.log(`Total Time: ${totalMs.toFixed(2)}ms`);
  console.log(`Throughput: ${throughput} msgs/sec`);
  console.log(`Latency: ${latency} ms/msg`);

  // Cleanup
  closeDb();
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}

runBenchmark().catch((err) => {
  console.error(err);
  process.exit(1);
});
