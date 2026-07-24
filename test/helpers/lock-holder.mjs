// Holds BEGIN IMMEDIATE on the given db for <ms>, creating the db (schema'd
// via getDb) first. Used by the long-contender test: a peer whose import
// outlives the 5s busy_timeout. Signals via a FILE written synchronously
// inside the transaction — console.log to a pipe would not flush while
// Atomics.wait blocks the event loop, so a stdout signal arrives only after
// the lock is already released (observed: the parent then waits on nothing).
import { writeFileSync } from "node:fs";
import { setDbPath, withImmediateTransaction, closeDb } from "../../src/db.js";

const dbFile = process.argv[2];
const signalFile = process.argv[3];
const holdMs = Number(process.argv[4] ?? 6000);
setDbPath(dbFile);
withImmediateTransaction(() => {
  writeFileSync(signalFile, "holding"); // sync — flushes even with the loop blocked
  const until = Date.now() + holdMs;
  while (Date.now() < until) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
});
closeDb();
