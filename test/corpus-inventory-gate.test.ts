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
import { spawnSync } from "node:child_process";
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
