/**
 * The corpus-transcript pin two witnesses publish is now actually compared to what they compute.
 *
 * `a2a-handoff-quorum` and `a2a-policy-replay` each publish `expected.corpus_transcript_sha256`.
 * It was recorded in the queue as "a digest NO code computes or compares — a digest nobody derives
 * can never be wrong or right". Half of that was wrong, and the half that was right is the half
 * that matters.
 *
 * A producer does exist: each witness's `differential.mjs` runs its JavaScript and Python runners,
 * asserts the two transcripts agree, and emits a digest of the parsed result. It emits it under the
 * key **`transcript_sha256`**, while the manifest publishes it as **`corpus_transcript_sha256`** —
 * so the producer and the published claim never met, and no test ran the producer anyway
 * (`differential.mjs` is a command documented in a README).
 *
 * Measured before writing this, which is what turned a removal into a wiring job: both published
 * pins REPRODUCE EXACTLY. They were true the whole time, and unverifiable the whole time.
 *
 * The producer is deliberately NOT renamed to match. `differential.mjs` appears in its own witness's
 * manifest file table, so editing it changes its bytes, which changes the digest the manifest
 * attests for it — the cascade that went red in #86 when a row was removed. The name mismatch is
 * mapped here and documented instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Tracked manifests that publish the pin — derived from the index, never a hardcoded list. */
function witnessesPublishingThePin(): { profile: string; manifest: string; pin: string }[] {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "blackbox"], {
    cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 26,
  }).split("\0").filter((p) => /manifest\/[^/]+\/expected\.json$/.test(p));

  const out: { profile: string; manifest: string; pin: string }[] = [];
  for (const rel of tracked) {
    let parsed: { expected?: Record<string, unknown> };
    try { parsed = JSON.parse(readFileSync(join(repoRoot, rel), "utf8")); } catch { continue; }
    const pin = parsed.expected?.corpus_transcript_sha256;
    if (typeof pin === "string") out.push({ profile: rel.split("/")[1], manifest: rel, pin });
  }
  return out;
}

test("CONTROL: the pin is actually published somewhere, so this file is not vacuous", () => {
  // Without this, renaming the key in both manifests would leave every assertion below trivially
  // true — the exact shape of a guard that passes because it found nothing to check.
  assert.ok(
    witnessesPublishingThePin().length >= 2,
    `expected at least 2 witnesses publishing corpus_transcript_sha256, found ${witnessesPublishingThePin().length}`,
  );
});

for (const { profile, manifest, pin } of witnessesPublishingThePin()) {
  test(`${profile}: the published corpus transcript pin matches what its differential computes`, () => {
    const differential = join(repoRoot, "blackbox", profile, "differential.mjs");
    assert.ok(existsSync(differential), `${profile} publishes the pin but has no differential.mjs to produce it`);

    // Runs the JS and Python runners and cross-checks them before digesting; a Python absence or a
    // JS/Python divergence surfaces here as a non-zero exit rather than as a silent skip.
    const stdout = execFileSync("node", [differential], {
      cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 26, timeout: 120_000,
    });
    const produced = JSON.parse(stdout) as { transcript_sha256?: string };

    // The name mismatch, mapped rather than "fixed": the producer says `transcript_sha256`, the
    // manifest says `corpus_transcript_sha256`. See the header for why the producer is left alone.
    assert.equal(
      produced.transcript_sha256,
      pin,
      `${manifest} publishes corpus_transcript_sha256 ${pin.slice(0, 12)}… but ${profile}/differential.mjs ` +
        `computes ${String(produced.transcript_sha256).slice(0, 12)}… — a published digest that does not ` +
        `match its producer attests the opposite of the truth`,
    );
  });
}
