/**
 * Every blackbox digest manifest must PARSE, and every file entry must still bind a hash to a path.
 *
 * `blackbox/a2a-effect-key-collapse-v0.1/manifest/v0.1/expected.json` sat on `main` for five days
 * as invalid JSON. `ec946fc` was updating HANDOFF.md's `sha256` after the file changed, and
 * whatever performed the edit deleted the `"path"` and `"bytes"` lines while writing the new hash:
 *
 *     {
 *       ,
 *       "sha256": "0d2957d6..."
 *     },
 *
 * So the manifest carried a digest bound to NOTHING — the one thing a digest manifest exists to
 * prevent — in a repository whose claim is "Your agents did the work. Prove it." The full suite was
 * green the entire time, because nothing reads these files. That is the shape this repo has been
 * bitten by three times already: a guard that cannot see the thing it is named for.
 *
 * These assertions are cheap on purpose. They do not verify that a hash MATCHES its file — the
 * per-witness digest tests do that for the two witnesses they cover — they verify the far weaker
 * property that the manifest is readable and that no entry has lost its binding. That weaker
 * property is the one that was false.
 *
 * FP-tested before being written: 1 of 11 tracked manifests failed, and it is the one repaired in
 * this commit. Three others (discussion, lifecycle-terminal, two-host-coordinator) use a different
 * shape with no `files` array at all, which is legitimate — so a missing array is not a finding
 * here. A guard that demanded one would have been red on arrival for three correct files, and the
 * fix reached for then is an allowlist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Tracked manifests only — an untracked scratch file is not part of the published surface. */
function trackedManifests(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", "blackbox"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  return out.split("\0").filter((p) => /manifest\/[^/]+\/expected\.json$/.test(p));
}

test("every tracked blackbox manifest is parseable JSON", () => {
  const broken: string[] = [];
  for (const rel of trackedManifests()) {
    try {
      JSON.parse(readFileSync(join(repoRoot, rel), "utf8"));
    } catch (error) {
      broken.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.deepEqual(broken, [], "a manifest that cannot be parsed cannot be checked by anything");
});

test("CONTROL: there are manifests to check, so an empty sweep cannot pass silently", () => {
  // Without this, a typo in the path filter would make every assertion above vacuously true — the
  // exact failure mode of the flat test runner that never ran `test/config/`.
  assert.ok(trackedManifests().length >= 10, `expected the witness manifests, found ${trackedManifests().length}`);
});

test("no manifest entry binds a digest to nothing", () => {
  const findings: string[] = [];
  for (const rel of trackedManifests()) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as Record<string, unknown>;
    } catch {
      continue; // reported by the parse test; do not double-count
    }
    // `files` and `artifacts` are the two shapes in use. Absence of both is legitimate — several
    // witnesses publish corpus/contract digests instead of a file table.
    const entries = (parsed.files ?? parsed.artifacts) as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, i) => {
      for (const field of ["path", "bytes", "sha256"]) {
        if (entry[field] === undefined) findings.push(`${rel}[${i}]: missing ${field}`);
      }
    });
    // A declared count that disagrees with the array is the same defect one step later: an entry
    // was dropped rather than emptied, and nothing would say so.
    //
    // BOTH spellings, because checking only `file_count` was inert on exactly the manifests that
    // use `artifacts`. Measured by mutation: deleting an entry from `a2a-capability-compat-v0.1`
    // (which declares `artifact_count`) left this test GREEN until the second name was added.
    // Six of eleven manifests declare no count at all, which is why a missing one is not a finding.
    for (const countField of ["file_count", "artifact_count"]) {
      const declared = parsed[countField];
      if (typeof declared === "number" && declared !== entries.length) {
        findings.push(`${rel}: ${countField} ${declared} but ${entries.length} entries`);
      }
    }
  }
  assert.deepEqual(findings, [], "a digest with no path proves nothing about any file");
});
