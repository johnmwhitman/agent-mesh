import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The README ships INSIDE the tarball, so a sentence about the registry rots in
 * the hands of the registry it describes. That is not hypothetical: 0.20.0 was
 * published carrying a README that said `Source version: 0.20.0 (npm publish
 * pending)` and `npm latest remains v0.18.0`. `npm install meshfleet` handed a
 * user 0.20.0 together with a document stating that 0.20.0 was unpublished and
 * that the newest published version was 0.18.0. No external comparison was
 * needed to see it — the package contradicted itself on the registry, in the
 * two lines a new reader reads first.
 *
 * Neither sentence was wrong when written. Both were true measurements of the
 * registry at a moment, hard-coded into a file that no release step updates:
 * `scripts/release.sh` publishes and verifies the tarball and never touches
 * README.md. The rot is structural, so a one-time correction does not close it.
 *
 * This guard therefore forbids the CLASS, not the two sentences: README.md may
 * not state what the registry currently serves. Linking to the registry is
 * fine — a link cannot go stale about its own contents.
 *
 * 🔴 What this guard CANNOT see. Stated so a green run is not read as more than
 * it is (this repo has been bitten three times by guards nobody asked that of):
 *  - It is a phrase-level denylist. A future sentence that asserts registry
 *    state in wording nobody has used yet passes cleanly. It catches
 *    RECURRENCE, not INVENTION.
 *  - It does not know whether `0.20.0` is the correct number. It only checks
 *    that README.md and package.json name the same one.
 *  - It governs README.md alone. ROADMAP.md carries this class of claim on
 *    purpose, as an explicitly dated measurement log that says so in the line
 *    itself; holding it to this rule would delete a true record.
 *  - Nothing here reaches the network, so nothing here can tell you the README
 *    is CURRENT — only that it does not make a claim that can silently stop
 *    being current.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");

test("README's stated source version is the version package.json will publish", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    version: string;
  };
  const stated = /\*\*Source version\*\*:\s*([0-9]+\.[0-9]+\.[0-9]+)/.exec(readme);
  assert.ok(
    stated,
    "README.md no longer carries a `**Source version**: X.Y.Z` line. If that line was " +
      "deliberately removed, delete this test with it; if it was reworded, update the pattern. " +
      "A guard that silently stops matching is the failure this repo keeps paying for.",
  );
  assert.equal(
    stated[1],
    pkg.version,
    `README.md says source version ${stated[1]}, package.json says ${pkg.version}`,
  );

  const proseClaims = Array.from(
    readme.matchAll(/\bsource is\s+([0-9]+\.[0-9]+\.[0-9]+)/gi),
    (match) => match[1],
  );
  for (const claim of proseClaims) {
    assert.equal(
      claim,
      pkg.version,
      `README.md prose says source is ${claim}, package.json says ${pkg.version}`,
    );
  }
});

test("README avoids standing release facts and states the bounded timeout contract", () => {
  // Every pattern here is a phrasing that has actually shipped false, or its
  // immediate sibling. Add to this list when a new one is caught in the wild —
  // that is the maintenance contract for a denylist.
  const forbidden: Array<{ pattern: RegExp; why: string }> = [
    {
      pattern: /npm\s+publish\s+pending/i,
      why: "publication status of the very tarball this README ships in",
    },
    {
      pattern: /npm\s+latest\s+(?:remains|is|stays)\s+`?v?[0-9]/i,
      why: "the registry's current dist-tag",
    },
    {
      pattern: /registry\s+latest\s+is\s+`?v?[0-9]/i,
      why: "the registry's current dist-tag",
    },
    {
      pattern: /latest\s+on\s+npm\s+is\s+`?v?[0-9]/i,
      why: "the registry's current dist-tag",
    },
    {
      pattern: /(?:not|never)\s+(?:yet\s+)?published\s+to\s+npm/i,
      why: "publication status stated as a standing fact",
    },
    {
      // Caught in the wild during this guard's own integration: main had rewritten the claim
      // into colon form (`**npm latest**: 0.20.0`) which none of the verb patterns matched —
      // the guard would have landed vacuously green beside the exact class it forbids.
      pattern: /npm\s+latest\s*\**\s*:\s*`?v?[0-9]/i,
      why: "the registry's current dist-tag (colon form)",
    },
    {
      pattern: /npm\s+latest\s+are\s+`?v?[0-9]/i,
      why: "the registry's current dist-tag (plural-verb form)",
    },
    {
      pattern: /newest\s+Git\s+tag\s+is\s+`?v?[0-9]/i,
      why: "the repository's current newest tag",
    },
    {
      pattern: /no\s+artificial\s+ceiling/i,
      why: "no timeout ceiling despite the bounded fleet-timeout contract",
    },
  ];

  const lines = readme.split("\n");
  const hits: string[] = [];
  for (const { pattern, why } of forbidden) {
    lines.forEach((line, i) => {
      if (pattern.test(line)) hits.push(`README.md:${i + 1} asserts ${why} — ${line.trim()}`);
    });
  }

  assert.deepEqual(
    hits,
    [],
    "README.md states release/runtime facts that can silently become false. Link to live " +
      "release state and describe the bounded timeout contract instead:\n" +
      hits.join("\n"),
  );

  assert.match(
    readme,
    /Meshfleet applies its own 30-minute safety timeout by default; operators can configure that default with `MESHFLEET_AGENT_TIMEOUT_MS` or override it per fleet with `set_fleet_timeout`, up to Node's `2,147,483,647` ms timer limit\./i,
    "README.md must retain the bounded runtime contract: exact default, supported overrides, and maximum",
  );
});
