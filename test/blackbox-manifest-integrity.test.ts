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
 * The first three assertions are cheap on purpose: they verify that the manifest is readable and
 * that no entry has lost its binding. That weaker property is the one that was false.
 *
 * 🔴 The paragraph that stood here claimed "the per-witness digest tests do that for the two
 * witnesses they cover". That was WRONG, and measuring it is what produced the checks below: only
 * three files in `test/` name `blackbox` at all, and this is the only one that reads a manifest.
 * NO test anywhere compared a declared file digest against the bytes it names. The consequence was
 * live on `main`: FIVE manifests attested content that had not existed since `1f101f9` (#66), which
 * replaced private worktree paths with placeholders in nine `evidence/acceptance-20260727.json`
 * files and updated only TWO of the seven manifests that bind them. Each of the five declared
 * digests is byte-exact against that file at `1f101f9~1` and wrong against every commit since — so
 * the manifests were correct when written and quietly stopped being true, which is the failure a
 * digest exists to make impossible. Repaired in this commit by re-deriving from the published
 * bytes; the pre-redaction digests are recoverable from `1f101f9~1` and named in its message.
 *
 * FP-tested before the checks were written, across all 104 entries in the 8 manifests that carry a
 * file table: 98 already matched, 5 were the stale entry above, and 1 names a path that is not
 * tracked. That last one is NOT repaired here and the reason is measured, not assumed:
 * `a2a-handoff-quorum` binds `python/__pycache__/evaluator.cpython-314.pyc` — gitignored, so absent
 * from every clean clone — in the slot where all seven of its siblings bind their evidence file,
 * and three of those siblings' evidence records say `__pycache__` was deliberately "excluded from
 * manifest and commit". It looks like a generator that swept a dirty tree. But that manifest is
 * itself attested: its own evidence file carries a `source_manifest` digest that MATCHES it today,
 * so editing it is a two-file provenance mutation and a decision, not a repair. Pinned below at
 * exactly one, and queued.
 *
 * DO NOT RE-DERIVE — measured and settled: `expected.corpus_sha256` in `a2a-handoff-quorum` and
 * `a2a-policy-replay` disagrees with those same manifests' file-table digest for
 * `corpus/v0.1/cases.json`. That is NOT a defect and there is nothing to fix. Their runners hash a
 * canonical form of the parsed corpus (`digest(corpus)`), not the raw bytes, while `a2a-discussion`
 * and `a2a-lifecycle-terminal` hash the text (`sha256(corpus_text)`) and so agree with their files.
 * Confirmed by running the witness: `node blackbox/a2a-policy-replay-v0.1/runner.mjs` reproduces
 * `7672d111…` exactly. Both cases.json files have one commit each and have never been edited. So
 * these tests deliberately check file tables and `source_manifest`, and leave `corpus_sha256` to
 * the runner that defines it.
 *
 * (#84's own FP-test, unchanged and still true of the three assertions it added: 1 of 11 tracked
 * manifests failed and it was repaired in that commit. Three others — discussion,
 * lifecycle-terminal, two-host-coordinator — use a shape with no `files` array at all, which is
 * legitimate, so a missing array is not a finding here. A guard that demanded one would have been
 * red on arrival for three correct files, and the fix reached for then is an allowlist.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function trackedPaths(pathspec: string): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", pathspec], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  return out.split("\0").filter(Boolean);
}

/** Tracked manifests only — an untracked scratch file is not part of the published surface. */
function trackedManifests(): string[] {
  return trackedPaths("blackbox").filter((p) => /manifest\/[^/]+\/expected\.json$/.test(p));
}

type Row = { manifest: string; index: number; repoPath: string; tracked: boolean; entry: Record<string, unknown> };

/**
 * Every file-table entry across every tracked manifest, resolved against the TRACKED set rather
 * than the filesystem. Resolving against the filesystem would let an untracked local build
 * artifact satisfy an entry on the maintainer's machine and fail in a clean clone — which is the
 * precise shape of the one defect this sweep found and could not repair.
 */
function fileTableEntries(): Row[] {
  const tracked = new Set(trackedPaths("blackbox"));
  const rows: Row[] = [];
  for (const rel of trackedManifests()) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as Record<string, unknown>;
    } catch {
      continue; // reported by the parse test; do not double-count
    }
    const entries = (parsed.files ?? parsed.artifacts) as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(entries)) continue;
    const witnessRoot = rel.split("/manifest/")[0];
    entries.forEach((entry, index) => {
      if (typeof entry?.path !== "string") return; // the missing-binding test owns this
      const repoPath = `${witnessRoot}/${entry.path}`;
      rows.push({ manifest: rel, index, repoPath, tracked: tracked.has(repoPath), entry });
    });
  }
  return rows;
}

function sha256Of(repoPath: string): { sha256: string; bytes: number } {
  const bytes = readFileSync(join(repoRoot, repoPath));
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
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

test("every manifest digest matches the bytes it names", () => {
  const findings: string[] = [];
  for (const row of fileTableEntries()) {
    if (!row.tracked) continue; // pinned and counted by the test below
    const actual = sha256Of(row.repoPath);
    const declaredSha = row.entry.sha256;
    const declaredBytes = row.entry.bytes;
    if (typeof declaredSha === "string" && declaredSha !== actual.sha256) {
      findings.push(`${row.repoPath}: manifest says ${declaredSha.slice(0, 16)}…, file is ${actual.sha256.slice(0, 16)}…`);
    }
    if (typeof declaredBytes === "number" && declaredBytes !== actual.bytes) {
      findings.push(`${row.repoPath}: manifest says ${declaredBytes} bytes, file is ${actual.bytes}`);
    }
  }
  assert.deepEqual(findings, [], "a digest that does not match its file attests nothing, and says the opposite");
});

test("CONTROL: the digest sweep actually hashed the file tables, so it cannot pass by resolving nothing", () => {
  // Without this, a witnessRoot/path-join mistake would skip every entry and report a clean sweep.
  // That is not hypothetical here: the sibling scanner shipped one night earlier had to grow two
  // refusals for exactly this, and #84's own count check was inert on 5 of 11 manifests until a
  // mutation exposed it. 100 is a floor under the 103 tracked entries present when this was
  // written, low enough to survive a witness being retired and high enough that a resolution bug
  // cannot hide beneath it.
  const hashed = fileTableEntries().filter((r) => r.tracked).length;
  assert.ok(hashed >= 100, `expected the manifest file tables to resolve, hashed only ${hashed} entries`);
});

test("no manifest entry names a path outside the tracked tree, beyond the one pinned defect", () => {
  // A digest bound to a path a reader cannot obtain is unfalsifiable by construction. Exactly one
  // exists (see the header): a2a-handoff-quorum binds a gitignored __pycache__ artifact. It is
  // pinned at ONE rather than allowlisted by name so the number can only be driven DOWN — and this
  // test is meant to go red on whoever fixes it, which is the point: repairing that manifest also
  // invalidates the source_manifest digest in its own evidence file, so it is a decision to record.
  const unresolvable = fileTableEntries().filter((r) => !r.tracked).map((r) => r.repoPath);
  assert.equal(
    unresolvable.length,
    1,
    `expected exactly the one known unresolvable entry, found ${unresolvable.length}: ${unresolvable.join(", ")} — if you repaired it, lower this pin to 0`,
  );
});

test("a source_manifest digest matches the manifest it names", () => {
  // The second-order binding: an evidence file that attests the manifest above it. This is the
  // layer that decided the pinned defect above cannot be silently edited, so it is worth a guard.
  const findings: string[] = [];
  let checked = 0;
  for (const rel of trackedPaths("blackbox").filter((p) => p.endsWith(".json"))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(repoRoot, rel), "utf8"));
    } catch {
      continue;
    }
    const sm = (parsed as Record<string, unknown> | null)?.source_manifest as Record<string, unknown> | undefined;
    if (!sm || typeof sm.path !== "string" || typeof sm.sha256 !== "string") continue;
    const witnessRoot = rel.split("/evidence/")[0];
    const target = `${witnessRoot}/${sm.path}`;
    checked += 1;
    const actual = sha256Of(target);
    if (actual.sha256 !== sm.sha256) {
      findings.push(`${rel} attests ${target} as ${sm.sha256.slice(0, 16)}…, file is ${actual.sha256.slice(0, 16)}…`);
    }
    if (typeof sm.bytes === "number" && sm.bytes !== actual.bytes) {
      findings.push(`${rel} attests ${target} as ${sm.bytes} bytes, file is ${actual.bytes}`);
    }
  }
  assert.deepEqual(findings, [], "an evidence file that misattests its own manifest is the audit failing at the outer layer");
  assert.ok(checked >= 1, "CONTROL: found no source_manifest block at all, so this test proved nothing");
});
