/**
 * `scripts/generate-corpus.ts` is step 1 of a two-step regeneration and rewrites
 * manifest.json from its own vector list alone. Every vector authored by step 2
 * (`scripts/generate-discussion-corpus.mjs`) is dropped from the manifest, while its
 * fixture file stays on disk. Measured on 2026-07-31 against the committed corpus:
 * running step 1 by itself took the manifest from 76 vectors to 64, printed
 * "all authored invariants hold", and exited 0.
 *
 * The suite did catch the damage — as `published README corpus and check counts
 * match generated and source truth`, reported as a count drift. That is the danger:
 * the obvious repair for a count drift is to write the smaller number into the
 * README, which publishes a corpus with the entire discussion family deleted and a
 * README that truthfully describes the wreckage. So what is under test here is not
 * that the corpus can be damaged — it is that the damage NAMES ITSELF and the exit
 * code stops being 0.
 *
 * Every case runs the real script against a throwaway `MESHFLEET_CORPUS_OUT`.
 * Regenerating the real corpus for a test would be the exact accident this guard
 * exists to report, so it is never done here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "generate-corpus.ts");
const REAL_MANIFEST = join(ROOT, "test", "fixtures", "corpus", "manifest.json");

function runGenerator(outDir: string) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, MESHFLEET_CORPUS_OUT: outDir },
  });
}

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "meshfleet-corpus-guard-"));
}

test("step 1 alone names every vector it drops from the committed manifest, and exits non-zero", () => {
  const out = sandbox();
  // The real committed manifest, so this asserts against the corpus that actually ships
  // rather than a synthetic stand-in. No fixture files: the outgoing manifest alone must
  // be enough to notice.
  copyFileSync(REAL_MANIFEST, join(out, "manifest.json"));
  const committed = JSON.parse(readFileSync(REAL_MANIFEST, "utf-8"));
  const foreign: string[] = committed.vectors
    .map((v: any) => v.id)
    .filter((id: string) => id.startsWith("discussion"));

  assert.ok(
    foreign.length > 0,
    "the committed corpus no longer contains vectors authored outside generate-corpus.ts; " +
      "if step 2 was retired, retire this guard deliberately rather than letting it pass vacuously",
  );

  const r = runGenerator(out);

  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  for (const id of foreign) {
    assert.ok(r.stderr.includes(id), `dropped vector ${id} is not named in stderr:\n${r.stderr}`);
  }
  // The success line is the sentence that made the original failure silent.
  assert.ok(!r.stdout.includes("all authored invariants hold"), "reported success while the corpus was incomplete");
  // Naming the drop is not enough if the reader still reaches for the README.
  assert.match(r.stderr, /do NOT\s*\n?.*edit the README counts/s);
  assert.ok(
    r.stderr.includes("node scripts/generate-discussion-corpus.mjs"),
    "the recovery command is not in the message",
  );
  assert.ok(r.stderr.includes("npm run build"), "step 2 imports dist/verify.js; the build must be part of the recovery");
});

test("a fixture on disk is enough on its own — the guard does not go quiet on a second run", () => {
  // After step 1 has run once, the manifest no longer names the dropped vectors. Their
  // fixture files remain. A guard that read only the outgoing manifest would report the
  // damage once and be silent every run after, which is the same silence with extra steps.
  const out = sandbox();
  writeFileSync(join(out, "discussion-orphaned-fixture.json"), "{}\n");

  const r = runGenerator(out);

  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstderr:\n${r.stderr}`);
  assert.ok(r.stderr.includes("discussion-orphaned-fixture"), `not named in stderr:\n${r.stderr}`);
});

test("control: with nothing foreign present the generator still succeeds and reports success", () => {
  // Without this the suite cannot tell a working guard from one that fails on everything.
  const out = sandbox();

  const r = runGenerator(out);

  assert.equal(r.status, 0, `expected exit 0 on a clean regeneration, got ${r.status}\nstderr:\n${r.stderr}`);
  assert.ok(r.stdout.includes("all authored invariants hold"), `stdout:\n${r.stdout}`);
  assert.ok(!r.stderr.includes("NOT AUTHORED BY THIS SCRIPT"), `guard fired with nothing to find:\n${r.stderr}`);
  // It wrote a real corpus, just not the committed one.
  const written = JSON.parse(readFileSync(join(out, "manifest.json"), "utf-8"));
  assert.ok(written.vectors.length > 0);
});

test("baseline.json and manifest.json are never themselves counted as dropped vectors", () => {
  // Both live in the corpus directory and both end in .json. Counting either as a vector
  // would make the guard fire on every clean run, and a guard that is red on arrival gets
  // an allowlist rather than a fix.
  const out = sandbox();
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "baseline.json"), "{}\n");
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ vectors: [] }) + "\n");

  const r = runGenerator(out);

  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr:\n${r.stderr}`);
  assert.ok(!r.stderr.includes("baseline"), `baseline.json was treated as a vector:\n${r.stderr}`);
});
