import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Examples that cannot rot (LH-67, minimal form): the full receipted-fleet
// example needs a live opencode + model calls, so CI can't EXECUTE it — but
// every example must at least parse under the shipped Node floor, so a
// refactor can never silently break the first file an evaluator opens.

const examplesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");

test("every example parses (node --check)", () => {
  const files = readdirSync(examplesDir).filter((f) => f.endsWith(".mjs") || f.endsWith(".js"));
  assert.ok(files.length > 0, "examples/ should contain at least one runnable example");
  for (const f of files) {
    execFileSync(process.execPath, ["--check", join(examplesDir, f)], { stdio: "pipe" });
  }
});
