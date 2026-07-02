// Cross-platform test launcher.
// `node --test test/*.test.ts` relies on shell glob expansion (absent in
// PowerShell) or the runner's native glob (Node >= 21 only). This script
// expands the file list itself so the suite runs on Node 18/20/22 across
// Linux, macOS, and Windows.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const testDir = "test";
const files = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => join(testDir, f));

if (files.length === 0) {
  console.error("No test files found in", testDir);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "--test-concurrency=1", ...files],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
