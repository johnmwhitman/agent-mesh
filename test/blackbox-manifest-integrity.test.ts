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
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function trackedBlackboxPaths(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", "blackbox"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  return out.split("\0").filter(Boolean);
}

/**
 * Tracked manifests only — an untracked scratch file is not part of the published surface.
 *
 * TWO path shapes are in use and the second was invisible until 2026-08-01. Ten profiles version
 * their manifest at `manifest/<version>/expected.json`; `a2a-conformance-v0.1` publishes a single
 * unversioned `manifest.json` at its profile root. The original filter knew only the first shape,
 * so it reached 11 of the 12 tracked manifests and the twelfth — which pins a catalog digest — was
 * checked by nothing here.
 */
function trackedManifests(): string[] {
  return trackedBlackboxPaths().filter(
    (p) => /manifest\/[^/]+\/expected\.json$/.test(p) || /^blackbox\/[^/]+\/manifest\.json$/.test(p),
  );
}

/** `blackbox/<profile>/...` → the profile directory names, derived from the index, not from a list. */
function trackedProfiles(): string[] {
  return [...new Set(trackedBlackboxPaths().map((p) => p.split("/")[1]).filter(Boolean))].sort();
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

test("CONTROL: every blackbox profile has a manifest this file can reach", () => {
  // 🔑 A COUNT FLOOR IS NOT A COMPLETENESS CHECK, and this repo paid to learn it. The floor above
  // read `>= 10` while the filter reached 11 of 12 manifests: the floor passed, and the manifest it
  // could not see stayed unchecked for as long as it existed. A floor can only catch the filter
  // matching *too little in total* — never the filter missing a particular member.
  //
  // So this control asks the question from the other side, on a predicate the enumerator does not
  // use: profile directories come from the index, and every profile must contribute at least one
  // reachable manifest. Re-narrowing `trackedManifests()` to either single path shape fires this,
  // and it fires by NAMING the profile that went dark. Measured on `a8ec462` before the widening:
  // 12 profiles, and `a2a-conformance-v0.1` had zero.
  //
  // Its limit, stated rather than implied: a profile that publishes its manifest under some THIRD
  // path shape is still invisible here, because "has a manifest" is only ever asked of profiles the
  // enumerator already reaches. What this catches is a profile going dark — not a shape never seen.
  const reachable = new Set(trackedManifests().map((p) => p.split("/")[1]));
  const profiles = trackedProfiles();
  assert.ok(profiles.length >= 10, `CONTROL: found ${profiles.length} profiles, so this proved nothing`);
  assert.deepEqual(
    profiles.filter((d) => !reachable.has(d)),
    [],
    "a blackbox profile whose manifest this file cannot enumerate is unchecked by every test here",
  );
});

test("a digest a manifest publishes is a well-formed digest", () => {
  // The test below this one checks file TABLES. Three manifests have none: they pin a digest at the
  // top level instead (`corpus_sha256`, `contract_sha256`, `expected_catalog_sha256`) and the table
  // loop skips them entirely. Widening the enumeration without this would have reached
  // `a2a-conformance-v0.1/manifest.json` and asserted NOTHING about it, which reads as coverage.
  //
  // Deliberately the same weak property as the rest of this file: that the binding is intact and
  // well formed, NOT that the hash matches its bytes. `expected_catalog_sha256` is compared against
  // an observed catalog by `blackbox/a2a-conformance-v0.1/runner.mjs:381`, which no test root and no
  // workflow runs — so a malformed pin fails at nothing that CI executes.
  //
  // FP-tested before it was written: 4 keys across 3 of the 12 manifests, all well formed on
  // `a8ec462`. Lowercase is required because the runner that consumes it requires lowercase
  // (`runner.mjs:103`, `/^[a-f0-9]{64}$/`) — an uppercase pin would never match a digest it derives.
  const findings: string[] = [];
  let examinedWithoutTable = 0;
  for (const rel of trackedManifests()) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as Record<string, unknown>;
    } catch {
      continue; // reported by the parse test; do not double-count
    }
    const digestKeys = Object.keys(parsed).filter(
      (k) => (k === "sha256" || k.endsWith("_sha256")) && typeof parsed[k] === "string",
    );
    const hasTable = Array.isArray(parsed.files) || Array.isArray(parsed.artifacts);
    if (!hasTable && digestKeys.length > 0) examinedWithoutTable += 1;
    for (const key of digestKeys) {
      if (!/^[a-f0-9]{64}$/.test(parsed[key] as string)) {
        findings.push(`${rel}: ${key} is not a lowercase SHA-256 digest`);
      }
    }
  }
  // Without this the whole test is inert the moment the key predicate stops matching anything —
  // and an inert test is indistinguishable from a passing one. It pins the CLASS this test exists
  // for (a manifest with no file table), not a count and not a path.
  assert.ok(
    examinedWithoutTable > 0,
    "CONTROL: examined no table-less manifest, so this test checked nothing it was written for",
  );
  assert.deepEqual(findings, [], "a malformed digest binds nothing, whatever it is written next to");
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

/**
 * Read a tracked file's bytes from the INDEX, not the worktree.
 *
 * The published artifact is what is committed. `public-surface-sanitization.test.ts` already reads
 * the index for the same reason, and its own tests are named for it: "a sanitized worktree cannot
 * hide staged forbidden content." A digest check that trusted the worktree could be satisfied by a
 * file nobody will ever receive.
 */
function indexedBytes(rel: string): Buffer | undefined {
  try {
    return execFileSync("git", ["show", `:${rel}`], { cwd: repoRoot, maxBuffer: 1 << 28 });
  } catch {
    return undefined; // not in the index: the manifest attests a file the repo does not publish
  }
}

test("every manifest digest matches the bytes it names", () => {
  // 🔴 THIS IS THE PROPERTY THE REST OF THIS FILE DELIBERATELY DID NOT CHECK, and five manifests
  // were wrong the whole time. Measured on `37c2503`: of 103 file rows across 12 manifests, FIVE
  // declared bytes and a sha256 that no longer matched their file, and one named
  // `python/__pycache__/evaluator.cpython-314.pyc` — never tracked, matched by `.gitignore:23`, so
  // no one who clones this repository could obtain it or verify that row at all.
  //
  // A missing binding (the defect #84 repaired) is a manifest that says nothing. A stale binding is
  // worse: it says something specific and false, and it is the exact failure this product exists to
  // prevent — an audit surface reporting fine about content that contradicts it.
  //
  // The five drifted because PR #66 sanitized the evidence files and did not restamp the manifests
  // that attest them. Nothing connected the two, which is why this test is a sweep over the index
  // rather than a per-witness assertion: a per-witness check is exactly what was already there for
  // two of the twelve, and it did not generalise on its own.
  const findings: string[] = [];
  let rowsChecked = 0;
  for (const rel of trackedManifests()) {
    const profileDir = rel.replace(/\/manifest\/[^/]+\/expected\.json$|\/manifest\.json$/, "");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as Record<string, unknown>;
    } catch {
      continue; // reported by the parse test; do not double-count
    }
    const entries = (parsed.files ?? parsed.artifacts) as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry.path !== "string" || typeof entry.sha256 !== "string") continue;
      const target = `${profileDir}/${entry.path}`;
      const bytes = indexedBytes(target);
      if (bytes === undefined) {
        findings.push(`${rel}: attests ${entry.path}, which is not in the index`);
        continue;
      }
      rowsChecked += 1;
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== entry.sha256) {
        findings.push(`${rel}: ${entry.path} sha256 ${entry.sha256.slice(0, 12)}… but bytes hash ${actual.slice(0, 12)}…`);
      }
      if (typeof entry.bytes === "number" && entry.bytes !== bytes.length) {
        findings.push(`${rel}: ${entry.path} declares ${entry.bytes} bytes, index holds ${bytes.length}`);
      }
    }
  }
  // Not a count FLOOR — a floor is what let a filter reach 11 of 12 and pass. This asserts the
  // sweep did real work, and the completeness control above independently asserts it reached every
  // profile. Both are needed: this one cannot see a missing member, and that one cannot see a
  // member reached but never hashed.
  assert.ok(rowsChecked > 0, "CONTROL: no manifest row was hashed, so this test proved nothing");
  assert.deepEqual(findings, [], "a digest that does not match its bytes attests the opposite of the truth");
});
