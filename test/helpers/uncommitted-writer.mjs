// Holds an UNCOMMITTED insert on a db for <ms>, then commits. Used to pin the
// binding adoption re-check: the advisory check reads under a shared lock and
// cannot see these rows, so only the re-check inside BEGIN IMMEDIATE — which
// serializes behind this writer — can catch them. Signals via a file, not
// stdout: the loop is blocked while holding the lock, so a pipe never flushes.
import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";

const [dbFile, signalFile, holdMsRaw] = process.argv.slice(2);
const holdMs = Number(holdMsRaw ?? 1500);
const db = new Database(dbFile);
db.pragma("busy_timeout = 10000");
db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT INTO fleets (id, data) VALUES ('foreign-row', '{}')").run();
writeFileSync(signalFile, "holding");
const until = Date.now() + holdMs;
while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
db.exec("COMMIT");
db.close();
