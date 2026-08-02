/**
 * The handoff-quorum and policy-replay manifests publish a digest of each
 * JavaScript corpus runner's complete canonical output. The runners already
 * produce that output, but the pins used to be consumed by no CI-executed
 * check: replacing one with another well-formed SHA-256 left the suite green.
 *
 * Witness discovery deliberately uses the paired JavaScript/Python corpus
 * command receipts, not `corpus_transcript_sha256`. Removing the pin must make
 * a known witness fail, never make it disappear from the sweep.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type TranscriptManifest = {
  profile?: unknown;
  expected?: { corpus_transcript_sha256?: unknown };
  command_receipts?: {
    javascript_corpus?: unknown;
    python_corpus?: unknown;
  };
};

type TranscriptWitness = {
  manifestRel: string;
  profileDir: string;
  manifest: TranscriptManifest;
};

function trackedManifestPaths(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", "blackbox"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  })
    .split("\0")
    .filter((path) => /manifest\/[^/]+\/expected\.json$/.test(path))
    .sort();
}

function transcriptWitnesses(): TranscriptWitness[] {
  return trackedManifestPaths().flatMap((manifestRel) => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, manifestRel), "utf8")) as TranscriptManifest;
    if (manifest.command_receipts?.javascript_corpus === undefined) return [];
    if (manifest.command_receipts?.python_corpus === undefined) return [];
    return [{
      manifestRel,
      profileDir: manifestRel.replace(/\/manifest\/[^/]+\/expected\.json$/, ""),
      manifest,
    }];
  });
}

test("CONTROL: every paired corpus witness is reached independently of its transcript pin", () => {
  assert.deepEqual(
    transcriptWitnesses().map(({ manifestRel }) => manifestRel),
    [
      "blackbox/a2a-handoff-quorum-v0.1/manifest/v0.1/expected.json",
      "blackbox/a2a-policy-replay-v0.1/manifest/v0.1/expected.json",
    ],
  );
});

test("every published corpus transcript pin matches the complete canonical runner output", async () => {
  for (const { manifestRel, profileDir, manifest } of transcriptWitnesses()) {
    const stdout = execFileSync(process.execPath, [join(repoRoot, profileDir, "runner.mjs")], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const output = JSON.parse(stdout) as { ok?: unknown; profile?: unknown };
    const evaluator = await import(pathToFileURL(join(repoRoot, profileDir, "evaluator.mjs")).href) as {
      canonical(value: unknown): string;
    };
    const canonicalOutput = evaluator.canonical(output);
    const actualDigest = createHash("sha256").update(canonicalOutput).digest("hex");

    assert.equal(output.ok, true, `${manifestRel}: runner did not report ok`);
    assert.equal(output.profile, manifest.profile, `${manifestRel}: runner profile drifted from manifest`);
    assert.equal(canonicalOutput, stdout.trim(), `${manifestRel}: runner output is not canonical`);

    const expected = manifest.expected?.corpus_transcript_sha256;
    assert.equal(typeof expected, "string", `${manifestRel}: missing corpus_transcript_sha256`);
    assert.equal(
      actualDigest,
      expected,
      `${manifestRel}: corpus_transcript_sha256 does not attest the complete runner output`,
    );
  }
});
