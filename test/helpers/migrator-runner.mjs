// Child process for the concurrent-migrator race test. Waits for a "go" file
// (a start barrier, so N children hit migrateJsonToSqlite as simultaneously as
// the OS allows), runs the migrator once, and prints its MigrationResult as
// JSON on stdout. Env (MESHFLEET_DB_FILE + MESHFLEET_DATA_FILE) is set by the
// spawning test — BOTH, per the isolation law.
import { existsSync } from "node:fs";

const goFile = process.argv[2];
if (!goFile) {
  console.error("usage: migrator-runner.mjs <go-file>");
  process.exit(2);
}

const deadline = Date.now() + 10_000;
while (!existsSync(goFile)) {
  if (Date.now() > deadline) {
    console.error("migrator-runner: go-file never appeared");
    process.exit(3);
  }
  // Tight-ish spin keeps the start skew between children in the microsecond
  // range, which is the point of the barrier.
  await new Promise((r) => setTimeout(r, 1));
}

const { migrateJsonToSqlite } = await import("../../src/migrate.js");
const result = migrateJsonToSqlite();
console.log(JSON.stringify(result));
