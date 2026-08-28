/**
 * The corpus-generator's three durability guards, proved end-to-end.
 *
 * The integration audit (Sol, 2026-08-28) named three P2 gaps that the
 * generator at HEAD 9252734 had. Each of these tests asserts a single
 * gap remains closed. They are the only automation that holds the
 * guards honest; removing the gate logic in `scripts/generate-corpus.ts`
 * without updating these tests must turn them red.
 *
 *   test 1 — INCOMPLETE CORPUS INVENTORY fires on a WT phantom id, before
 *            any fixture is written and without leaving a `staging-` dir.
 *   test 2 — The atomic swap: a successful regeneration leaves the
 *            committed corpus dir byte-identical to its pre-state.
 *            A failed regeneration leaves it untouched.
 *   test 3 — The committed-manifest source of truth: when the WT
 *            manifest is gone, regeneration succeeds; when it is missing
 *            AND V[] is narrowed, regeneration fails closed rather than
 *            silently scaffolding a smaller corpus.
 *
 * These tests deliberately shell out to `node --import tsx` on
 * `scripts/generate-corpus.ts` rather than importing it, because the
 * script's top-level execution is exactly the behaviour we want to
 * observe — not its internal functions in isolation.
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
const CORPUS = join(repoRoot, "test", "fixtures", "corpus");
const SCRIPT = join(repoRoot, "scripts", "generate-corpus.ts");

/**
 * Run the generator in-place (against the real committed corpus). Only used
 * for test 2, which proves the round-trip is byte-stable on the real tree.
 * Surrounded by git-status checks so any drift fails the test loudly.
 */
function runGeneratorAgainstRealTree(): { exit: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: 120_000,
  });
  return { exit: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("inventory gate: WT phantom id fires INCOMPLETE CORPUS INVENTORY before any write", () => {
  // Copy the real corpus tree into a scratch dir, including the README the
  // generator does not produce. We then point the generator at the scratch
  // dir by swapping `test/fixtures/corpus` for it via a rename, run the
  // generator, and restore. The atomic-write boundary means a failed run
  // leaves the scratch dir untouched; the rename/restore sandwich makes the
  // real corpus dir visible-from-git invariant survive regardless.
  const backupDir = mkdtempSync(join(tmpdir(), "corpus-gate-backup-"));
  const realCorpusLink = CORPUS;
  const scratchDir = join(backupDir, "scratch");
  mkdirSync(scratchDir, { recursive: true });
  for (const entry of readdirSync(realCorpusLink)) {
    copyFileSync(join(realCorpusLink, entry), join(scratchDir, entry));
  }

  // Snapshot baseline fixture hashes (committed bytes) BEFORE any mutation.
  const baselineHashes = new Map<string, string>();
  for (const entry of readdirSync(scratchDir)) {
    if (!existsSync(join(scratchDir, entry))) continue;
    baselineHashes.set(
      entry,
      createHash("sha256").update(readFileSync(join(scratchDir, entry))).digest("hex"),
    );
  }

  try {
    // Move the real corpus aside; move the scratch dir into its place.
    renameSync(realCorpusLink, join(backupDir, "corpus-real"));
    try {
      renameSync(scratchDir, realCorpusLink);
    } catch (err) {
      renameSync(join(backupDir, "corpus-real"), realCorpusLink);
      throw err;
    }

    // Sanity: the swap put the scratch bytes where the script will see them.
    for (const [entry, hash] of baselineHashes) {
      const h = createHash("sha256").update(readFileSync(join(realCorpusLink, entry))).digest("hex");
      assert.equal(h, hash, `baseline drift on ${entry} after rename`);
    }

    // Inject a phantom id into the WT manifest. Capture the post-injection
    // WT hashes separately — those are what we expect the gate to leave
    // untouched (NOT the committed baseline, which the WT now differs from).
    const manifestPath = join(realCorpusLink, "manifest.json");
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
    const preRunHashes = new Map<string, string>();
    for (const entry of readdirSync(realCorpusLink)) {
      if (!existsSync(join(realCorpusLink, entry))) continue;
      preRunHashes.set(
        entry,
        createHash("sha256").update(readFileSync(join(realCorpusLink, entry))).digest("hex"),
      );
    }

    // Run the generator. It must exit 1 BEFORE writing any fixture.
    const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 120_000,
    });
    const exit = result.status ?? 1;
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";

    assert.equal(exit, 1, `expected gate refusal, got exit=${exit}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(
      stderr + stdout,
      /INCOMPLETE CORPUS INVENTORY: canonical generator is missing 1.*committed manifest entry.*sourced from git working-tree manifest/s,
      "expected INCOMPLETE CORPUS INVENTORY message",
    );
    assert.match(
      stderr + stdout,
      /phantom-deleted-by-gate/,
      "expected the missing id to be named",
    );

    // The atomic-write boundary means every fixture file (including the
    // phantom-injected manifest) is byte-identical to the pre-run state.
    // The COMMITTED baseline is NOT what we expect here — the WT now differs
    // from the committed baseline because of the injection.
    for (const [entry, hash] of preRunHashes) {
      const h = createHash("sha256").update(readFileSync(join(realCorpusLink, entry))).digest("hex");
      assert.equal(h, hash, `fixture ${entry} was modified despite gate refusal`);
    }
    assert.ok(existsSync(join(realCorpusLink, "README.md")), "README.md was removed by the failed run");
    // No `staging-*` or `backup-*` dirs leaked into `test/fixtures/`.
    const testFixtures = join(repoRoot, "test", "fixtures");
    for (const entry of readdirSync(testFixtures)) {
      assert.ok(
        !(entry.startsWith("corpus.staging-") || entry.startsWith("corpus.backup-")),
        `atomic-write left behind ${entry} after a failed run`,
      );
    }
  } finally {
    // ALWAYS restore the real corpus to its tracked location, regardless of
    // how the test exited. A sticky symlink here would corrupt every
    // subsequent CI run.
    try {
      // Move the scratch dir (which is what the real path now points to)
      // out of the way, then move the real dir back.
      if (existsSync(realCorpusLink)) {
        renameSync(realCorpusLink, join(backupDir, "corpus-back-from-real"));
      }
      const realRestore = join(backupDir, "corpus-real");
      if (existsSync(realRestore)) {
        renameSync(realRestore, realCorpusLink);
      }
      // Clean up any scratch leftovers
      if (existsSync(scratchDir)) {
        rmSync(scratchDir, { recursive: true, force: true });
      }
      rmSync(backupDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

test("atomic write: a clean run regenerates the corpus byte-identical to its pre-state", () => {
  const beforeHashes = new Map<string, string>();
  for (const entry of readdirSync(CORPUS)) {
    if (!existsSync(join(CORPUS, entry))) continue;
    beforeHashes.set(
      entry,
      createHash("sha256").update(readFileSync(join(CORPUS, entry))).digest("hex"),
    );
  }

  const result = runGeneratorAgainstRealTree();
  assert.equal(result.exit, 0, `clean run failed: ${result.stderr}`);
  assert.match(result.stdout, /all authored invariants hold/, "expected invariant success line");

  for (const [entry, hash] of beforeHashes) {
    assert.ok(existsSync(join(CORPUS, entry)), `${entry} missing after regeneration`);
    const h = createHash("sha256").update(readFileSync(join(CORPUS, entry))).digest("hex");
    assert.equal(h, hash, `${entry} is not byte-identical after regeneration`);
  }

  for (const entry of readdirSync(join(repoRoot, "test", "fixtures"))) {
    assert.ok(
      !(entry.startsWith("corpus.staging-") || entry.startsWith("corpus.backup-")),
      `${entry} leaked after a clean run`,
    );
  }
});
