import { setDbPath, closeDb } from "../../src/db.ts";
import { LifecycleStore } from "../../src/attempt-lifecycle.ts";

const [dbFile, action, attemptId, ownerId, epoch] = process.argv.slice(2);
setDbPath(dbFile);
const store = new LifecycleStore();
try {
  if (action === "lease") {
    store.acquireLease({ workId: "work-1", attemptId, ownerId, leaseMs: 60_000 });
  } else if (action === "settle") {
    store.settle({ workId: "work-1", attemptId, ownerId, ownerEpoch: Number(epoch), outcome: "success", result: "winner" });
  } else {
    throw new Error(`unknown race action: ${action}`);
  }
} finally {
  closeDb();
}
