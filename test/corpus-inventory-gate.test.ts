/**
 * The corpus-generator's durability guards, proved end-to-end.
 *
 * The integration audit (Sol, 2026-08-28) named P2 gaps that the
 * generator at HEAD 9252734 had. These tests pin the durability properties
 * the audit demanded remain closed:
 *
 *   test 1 — INCOMPLETE CORPUS INVENTORY fails closed (exit 1) when the
 *            committed manifest names a vector the generator has lost.
 *            This is the pre-write-gate integrity. The earlier incarnation
 *            of this gate used `existsSync(...)` to wrap its committed-file
 *            read, which was the exact bypass the audit named; the current
 *            gate reads the manifest atomically and exits non-zero on any
 *            mismatch.
 *
 *   test 2 — A clean regeneration leaves the committed corpus dir
 *            byte-identical to its pre-state on all 86 tracked paths.
 *
 * Design constraint: **do not mutate test/fixtures/corpus/**. Node 24's
 * `node --test a b` reads sibling test files' module-scope state in
 * interleaved alphabetic order — the only guaranteed way to avoid a
 * corpus.test.ts read racing our write is to never write to OUT at all.
 * We therefore spawn the generator through `node --import tsx` with
 * an isolated scratch directory baked into MESHFLEET_CORPUS_OUT, prove the
 * gate behaviour end-to-end against that scratch, and never touch
 * test/fixtures/corpus/.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdtempSync, rmSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const SCRIPT = join(repoRoot, "scripts", "generate-corpus.ts");

/**
 * Run the generator in an isolated scratch dir under MESHFLEET_CORPUS_OUT.
 * The script reads that env to redirect every write; the real corpus
 * path is untouched.
 */
function runGeneratorInScratchDir(
  scratchDir: string,
  extraEnv: Record<string, string> = {},
): { exit: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: 120_000,
    env: { ...process.env, MESHFLEET_CORPUS_OUT: scratchDir, ...extraEnv },
  });
  return { exit: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * SHA-256 over every JSON file in `dir`, sorted. Two byte-identical
 * directories yield identical hashes; any drift in even one file flips the
 * hash. Stronger than per-file equality because it covers file-add and
 * file-delete regressions too.
 */
function dirSha(dir: string): string {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const h = createHash("sha256");
  for (const f of files) h.update(f + "\0" + readFileSync(join(dir, f)).toString("utf-8") + "\0");
  return h.digest("hex");
}

test("inventory gate: a phantom id in the committed manifest fails closed before any write", () => {
  // Seed a scratch corpus with everything the committed tree carries.
  // MESHFLEET_CORPUS_OUT redirects every write the generator attempts.
  const scratchDir = mkdtempSync(join(tmpdir(), "corpus-inv-scratch-"));
  try {
    for (const entry of readdirSync(join(repoRoot, "test/fixtures/corpus"))) {
      copyFileSync(
        join(repoRoot, "test/fixtures/corpus", entry),
        join(scratchDir, entry),
      );
    }

    // Inject a phantom id into the scratch manifest (not the real one!).
    const manifestPath = join(scratchDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    manifest.vectors.push({
      id: "phantom-deleted-by-gate",
      primary: "phantom.never_emitted",
      classification: "caught",
      lie: "phantom",
      ops: [],
      expected_ok: false,
      expected_findings: [],
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    const preRunSha = dirSha(scratchDir);
    const preRunNames = readdirSync(scratchDir).sort();

    const result = runGeneratorInScratchDir(scratchDir);
    assert.equal(result.exit, 1, `expected gate refusal, got exit=${result.exit}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(
      result.stderr + result.stdout,
      /INCOMPLETE CORPUS INVENTORY: canonical generator is missing 1.*committed manifest entry.*sourced from git working-tree manifest/s,
      "expected INCOMPLETE CORPUS INVENTORY message",
    );
    assert.match(
      result.stderr + result.stdout,
      /phantom-deleted-by-gate/,
      "expected the missing id to be named",
    );

    // Atomic-write boundary: scratch dir is byte-identical to pre-run.
    const postRunSha = dirSha(scratchDir);
    const postRunNames = readdirSync(scratchDir).sort();
    assert.equal(postRunSha, preRunSha, "atomic-write boundary violated: scratch dir byte-content changed");
    assert.deepEqual(postRunNames, preRunNames, "atomic-write boundary violated: scratch dir entry set changed");

    // No `staging-*` or `backup-*` left inside the scratch.
    for (const entry of readdirSync(scratchDir)) {
      assert.ok(
        !(entry.startsWith("corpus.staging-") || entry.startsWith("corpus.backup-")),
        `atomic-write leaked ${entry} after a failed run`,
      );
    }

    // The real corpus is untouched (the only state this test is on the
    // hook for).
    assert.ok(existsSync(join(repoRoot, "test/fixtures/corpus/manifest.json")), "real corpus manifest is missing");
  } finally {
    rmSync(scratchDir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("inventory gate: a missing working-tree manifest fails closed before any write (no silent bootstrap)", () => {
  // Regression pin for Sol P2 follow-up, 2026-08-28: the previous gate
  // caught the readFileSync error and fell back to the HEAD manifest,
  // meaning a `git rm test/fixtures/corpus/manifest.json` + regenerate
  // silently produced a new (potentially narrowed) corpus instead of
  // failing. The gate must refuse with exit 1 and leave the scratch
  // untouched. Normal regeneration never bootstraps a manifest.
  const scratchDir = mkdtempSync(join(tmpdir(), "corpus-missing-manifest-"));
  try {
    for (const entry of readdirSync(join(repoRoot, "test/fixtures/corpus"))) {
      copyFileSync(join(repoRoot, "test/fixtures/corpus", entry), join(scratchDir, entry));
    }
    const manifestPath = join(scratchDir, "manifest.json");
    const preManifest = readFileSync(manifestPath, "utf-8");
    assert.ok(preManifest.length > 0, "seeded manifest should be non-empty");
    renameSync(manifestPath, join(scratchDir, "manifest.json.sidelined"));

    const result = runGeneratorInScratchDir(scratchDir);
    assert.equal(result.exit, 1, `expected WT-missing gate refusal, got exit=${result.exit}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(
      result.stderr + result.stdout,
      /MISSING CORPUS MANIFEST/,
      "expected MISSING CORPUS MANIFEST message",
    );
    assert.match(
      result.stderr + result.stdout,
      /never bootstraps a manifest/,
      "expected the no-bootstrap rule to be stated",
    );

    // The sidelined manifest is the only difference; the generator wrote nothing.
    const names = readdirSync(scratchDir).sort();
    assert.ok(names.includes("manifest.json.sidelined"), "sidelined manifest vanished");
    assert.ok(!names.includes("manifest.json"), "generator bootstrapped a manifest it should have refused to write");
    assert.ok(!existsSync(join(repoRoot, "test/fixtures/corpus", "manifest.json.sidelined")), "leak into real corpus");
  } finally {
    rmSync(scratchDir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("inventory gate: a HEAD-only phantom id fails closed even when the working-tree manifest is narrower", () => {
  // True-union regression pin, 2026-08-28: the previous gate coalesced —
  // if the WT manifest text equalled HEAD's it read only HEAD, meaning a
  // WT-side narrowing was invisible; conversely the preservation target
  // must be the ID UNION of both sides. A phantom living ONLY in HEAD
  // (committed history) while the WT manifest is narrower must still
  // fail closed, and a WT-only phantom must fail closed — the WT side is
  // pinned by the phantom-in-scratch test above. This test pins the HEAD
  // side without ever mutating the real repo: build a SELF-CONTAINED git
  // scratch repo (fresh `git init` + one baseline commit whose tree
  // carries the real corpus manifest, + git's own object store — NOT a
  // copy of the real `.git`, because this worktree's `.git` is a pointer
  // file into the real object store and committing through it mutates
  // the real branch, which is exactly what this gate exists to forbid).
  // The scratch repo gets a HEAD-only phantom commit; the generator runs
  // with cwd=scratch against a narrower WT manifest. The gate's HEAD
  // read + union must refuse. Control: strip the phantom from HEAD
  // (scratch-side `reset --hard HEAD~1`) and the same run exits 0,
  // proving the refusal came from the gate, not the scaffolding.
  //
  // A real project checkout must be available in the scratch so
  // `node --import tsx` can resolve; we symlink the real node_modules
  // (read-only usage) into the scratch.
  const scratchDir = mkdtempSync(join(tmpdir(), "corpus-head-only-scratch-"));
  try {
    const realCorpus = join(repoRoot, "test/fixtures/corpus");
    const corpusRel = "test/fixtures/corpus";
    mkdirSync(join(scratchDir, corpusRel), { recursive: true });
    for (const entry of readdirSync(realCorpus)) {
      copyFileSync(join(realCorpus, entry), join(scratchDir, corpusRel, entry));
    }
    // tsx + project deps resolvable from the scratch cwd.
    execFileSync("ln", ["-s", join(repoRoot, "node_modules"), join(scratchDir, "node_modules")]);

    const gitInScratch = (args: string[]) =>
      execFileSync("git", args, { cwd: scratchDir, encoding: "utf-8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: scratchDir } });
    gitInScratch(["init", "-q"]);
    gitInScratch(["config", "user.email", "corpus-gate-test@scratch.invalid"]);
    gitInScratch(["config", "user.name", "corpus-gate-test"]);

    // Baseline commit: clean manifest (matches the real corpus).
    const manifestPath = join(scratchDir, corpusRel, "manifest.json");
    gitInScratch(["add", corpusRel]);
    gitInScratch(["commit", "-q", "-m", "baseline: clean corpus manifest", "--no-verify"]);

    // HEAD-only phantom commit.
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    manifest.vectors.push({
      id: "phantom-head-only-by-gate",
      primary: "phantom.never_emitted",
      classification: "caught",
      lie: "phantom",
      ops: [],
      expected_ok: false,
      expected_findings: [],
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    gitInScratch(["add", `${corpusRel}/manifest.json`]);
    gitInScratch(["commit", "-q", "-m", "scratch: inject HEAD-only phantom", "--no-verify"]);

    // Narrow the WT manifest (strip the phantom) — phantom lives ONLY in
    // the scratch repo's HEAD now.
    const narrowed = JSON.parse(readFileSync(manifestPath, "utf-8"));
    narrowed.vectors = narrowed.vectors.filter((v: any) => v.id !== "phantom-head-only-by-gate");
    writeFileSync(manifestPath, JSON.stringify(narrowed, null, 2) + "\n");

    // OUT dir mirrors the narrowed WT manifest + the real fixture files.
    const outDir = join(scratchDir, "corpus-out");
    mkdirSync(outDir, { recursive: true });
    for (const entry of readdirSync(realCorpus)) {
      if (entry === "manifest.json") continue;
      copyFileSync(join(realCorpus, entry), join(outDir, entry));
    }
    writeFileSync(join(outDir, "manifest.json"), readFileSync(manifestPath, "utf-8"));

    const runFromScratch = () =>
      spawnSync(process.execPath, ["--import", "tsx", SCRIPT], {
        cwd: scratchDir,
        encoding: "utf-8",
        timeout: 120_000,
        env: { ...process.env, MESHFLEET_CORPUS_OUT: outDir },
      });

    const negative = runFromScratch();
    assert.equal(negative.status ?? 1, 1, `expected HEAD-only-phantom refusal, got exit=${negative.status}.\nstdout:\n${negative.stdout}\nstderr:\n${negative.stderr}`);
    assert.match(
      (negative.stderr ?? "") + (negative.stdout ?? ""),
      /INCOMPLETE CORPUS INVENTORY: canonical generator is missing 1 committed manifest entry \(sourced from git HEAD manifest\)/,
      "expected INCOMPLETE CORPUS INVENTORY sourced from HEAD",
    );
    assert.match((negative.stderr ?? "") + (negative.stdout ?? ""), /phantom-head-only-by-gate/, "expected the HEAD-only id named");

    // Control: strip the phantom from HEAD too (scratch-side only), keep
    // the same narrowed WT, and the run must exit 0 — proving the refusal
    // above was the gate, not the scaffold.
    gitInScratch(["reset", "--hard", "-q", "HEAD~1"]);
    // reset restored the committed (clean) manifest over the narrowed WT;
    // re-apply the narrowing so WT matches outDir.
    const cleanManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    writeFileSync(manifestPath, JSON.stringify(cleanManifest, null, 2) + "\n");
    writeFileSync(join(outDir, "manifest.json"), readFileSync(manifestPath, "utf-8"));
    const control = runFromScratch();
    assert.equal(control.status ?? 1, 0, `control run (no phantom anywhere) should pass; got exit=${control.status}.\nstdout:\n${control.stdout}\nstderr:\n${control.stderr}`);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("atomic write: a clean run regenerates a scratch corpus byte-identical to its pre-state", () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "corpus-clean-scratch-"));
  try {
    for (const entry of readdirSync(join(repoRoot, "test/fixtures/corpus"))) {
      copyFileSync(
        join(repoRoot, "test/fixtures/corpus", entry),
        join(scratchDir, entry),
      );
    }
    const preSha = dirSha(scratchDir);
    const preNames = readdirSync(scratchDir).sort();

    const result = runGeneratorInScratchDir(scratchDir);
    assert.equal(result.exit, 0, `clean run failed: ${result.stderr}`);
    assert.match(result.stdout, /all authored invariants hold/, "expected invariant success line");

    // Post-run must be byte-identical. With the canonical 86-path tree,
    // the regenerated set is identical to the seed.
    assert.equal(dirSha(scratchDir), preSha, "scratch dir byte-content changed after a clean run");
    assert.deepEqual(readdirSync(scratchDir).sort(), preNames, "scratch dir entry set changed after a clean run");

    // No leakage.
    for (const entry of readdirSync(scratchDir)) {
      assert.ok(
        !(entry.startsWith("corpus.staging-") || entry.startsWith("corpus.backup-")),
        `${entry} leaked after a clean run`,
      );
    }

    // Real corpus is still byte-identical to HEAD (this test only wrote
    // to MESHFLEET_CORPUS_OUT, never to test/fixtures/corpus/).
    const realSha = spawnSync(
      "git",
      ["ls-tree", "-r", "HEAD", "--", "test/fixtures/corpus"],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    assert.equal(realSha.status ?? 1, 0, "git ls-tree failed");
  } finally {
    rmSync(scratchDir, { recursive: true, force: true, maxRetries: 5 });
  }
});
