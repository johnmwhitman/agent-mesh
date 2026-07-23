import { recordDurableAcceptance } from "../../src/a2a/durable-acceptance.js";
import { closeDb, setDbPath } from "../../src/db.js";

const [dbFile, encodedInput, encodedNow] = process.argv.slice(2);
if (!dbFile || !encodedInput || !encodedNow) throw new Error("usage: a2a-acceptance-writer DB INPUT_JSON NOW");

try {
  setDbPath(dbFile);
  const result = recordDurableAcceptance(JSON.parse(encodedInput), { now: () => Number(encodedNow) });
  process.stdout.write(JSON.stringify(result));
} finally {
  closeDb();
}
