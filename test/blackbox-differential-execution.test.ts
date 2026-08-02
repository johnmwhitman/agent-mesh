/**
 * Every witness README documents `node differential.mjs` as the verification command, and until
 * this file NO CI job on ANY platform ever executed one. The repository's own law — a test that
 * does not run is indistinguishable from a test that passes — applied to the differentials
 * themselves: the cp1252 defect (#106) lived in five of them for as long as they existed, and
 * only a manual run could ever have found it. This suite runs the documented command for real.
 *
 * Costs, measured before writing (2026-08-02, one machine): all ten differentials total ~8.1s
 * (max: proposal-base-match ~3.0s). Acceptable against a ~104s suite.
 *
 * Platform honesty: the differentials invoke `python3` by literal name. Where `python3` is not
 * runnable this suite SKIPS — loudly, with the reason in the skip message, echoing the
 * platform-skip inventory in HANDOFF.md — rather than failing on a toolchain the witness never
 * claimed to provide, and rather than silently passing on work it never did. Whether a given CI
 * platform has `python3` is measured by that platform's own run, not predicted here.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// The exact name the differentials spawn. A `python` fallback would test a command path the
// differentials do not take; if a platform has only `python`, the honest result is a skip that
// says so, not a green produced by a different invocation.
const python3 = spawnSync("python3", ["--version"], { encoding: "utf8" });
const python3Available = python3.status === 0;
const skipReason =
  "python3 is not runnable on this platform; the differentials spawn it by literal name " +
  "and running a substitute would verify a command the READMEs do not document";

function discoveredDifferentials(): Array<{ witness: string; path: string; root: string }> {
  return readdirSync(join(repoRoot, "blackbox"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      witness: entry.name,
      root: join(repoRoot, "blackbox", entry.name),
      path: join(repoRoot, "blackbox", entry.name, "differential.mjs"),
    }))
    .filter((candidate) => {
      try {
        return readdirSync(candidate.root).includes("differential.mjs");
      } catch {
        return false;
      }
    });
}

const differentials = discoveredDifferentials();

test("CONTROL: discovery finds the differentials, so a skip or a pass is about real files", () => {
  // Without a floor, a rename of `blackbox/` or `differential.mjs` would turn every test below
  // into a vacuous green (or a vacuous skip). Ten existed when this floor was set.
  assert.ok(differentials.length >= 10, `expected >= 10 differentials, found ${differentials.length}`);
});

for (const { witness, path, root } of differentials) {
  test(`differential executes clean: ${witness}`, { skip: python3Available ? false : skipReason }, () => {
    const args = [path];
    if (witness === "a2a-two-host-coordinator-v0.1") {
      // The external anchor its argv contract requires, computed from the INDEX — the published
      // manifest is what is committed, and an anchor from the worktree could bless bytes nobody
      // will ever receive.
      const manifestRel = `blackbox/${witness}/manifest/v0.1/expected.json`;
      const indexed = execFileSync("git", ["show", `:${manifestRel}`], {
        cwd: repoRoot,
        maxBuffer: 1 << 28,
      });
      args.push("--manifest-sha256", createHash("sha256").update(indexed).digest("hex"));
    }
    // cwd = the witness root: several differentials resolve `runner.mjs` and corpus paths
    // relative to the working directory, and the READMEs' documented command is run from there.
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(
      result.status,
      0,
      `${witness} differential failed (status ${result.status}, signal ${result.signal}):\n` +
        `${result.stderr?.slice(0, 2000) ?? ""}`,
    );
  });
}
