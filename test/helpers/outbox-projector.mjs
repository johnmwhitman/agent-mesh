import { writeFileSync } from "node:fs";
import { setDbPath } from "../../src/db.ts";
import { setEventLogPath } from "../../src/core.ts";
import { projectLifecycleOutbox } from "../../src/lifecycle-execution.ts";

const [dbFile, eventLogFile, markerFile] = process.argv.slice(2);
setDbPath(dbFile);
setEventLogPath(eventLogFile);
writeFileSync(markerFile, "attempting");
// This synthetic time is beyond the former lease-style claim timeout. SQLite's
// writer transaction, not time, is now the serialization boundary.
projectLifecycleOutbox("post-timeout-reclaimer", Date.now() + 31_000);
