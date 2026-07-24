// Child process for the concurrent-migrator race test. Announces readiness
// (an ack file the parent counts), then waits for the "go" file — a start
// barrier, so N children hit migrateJsonToSqlite as simultaneously as the OS
// allows. Without the ready-acks a slow child could still be booting when the
// parent releases the barrier, letting the race quietly run serially and the
// test pass without testing anything. Env (MESHFLEET_DB_FILE +
// MESHFLEET_DATA_FILE) is set by the spawning test — BOTH, per the isolation
// law. Prints the MigrationResult as JSON on stdout.
import { existsSync, writeFileSync } from "node:fs";

const goFile = process.argv[2];
if (!goFile) {
  console.error("usage: migrator-runner.mjs <go-file>");
  process.exit(2);
}

// Import BEFORE announcing ready, so module-load time is outside the race.
const { migrateJsonToSqlite } = await import("../../src/migrate.js");

writeFileSync(`${goFile}.ready.${process.pid}`, "ready");

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

const result = migrateJsonToSqlite();
console.log(JSON.stringify(result));
