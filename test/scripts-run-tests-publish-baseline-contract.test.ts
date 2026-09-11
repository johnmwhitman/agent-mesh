import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// scripts-run-tests-publish-baseline-contract.test.ts
//
// pins scripts/run-tests.mjs's "publish-baseline contract" — the four contract
// surfaces that keep `npm test` honest about the measured-vs-published relation.
//
//   (TAP anchors)         lines 192-195: `^# tests N$` / `^# pass N$` / `^# fail N$` / `^# skipped N$`
//                          so a missing/unparsable TAP summary exits 1 loudly.
//   (HANDOFF regex)       line  218:    `\*\*(\d+)\/(\d+)\*\* tests`
//                          so the published baseline is REQUIRED to be `**N/N**` form.
//   (fail-fast invariant) line  229:    `measuredFail !== 0` exits 1 BEFORE the published compare.
//                          so a failing suite does NOT also report a stale baseline.
//   (stale-baseline guard) line 234:    `Number(published[1]) !== measuredTotal || Number(published[2]) !== measuredTotal`
//                          so the published figure is checked against the measured total —
//                          AND both halves of the slash (N/N) are checked, not just one.
//
// The runner-script publish-baseline contract is the durable counterpart to
// the cycle-852 db.ts:505 CURRENT_STORAGE_SCHEMA_VERSION literal pin:
//   - cycle-852 pins the BUILD side (the published constant value)
//   - this file  pins the RUNNER side (the 4-line TAP parse + HANDOFF regex +
//              fail-fast placement + stale-baseline refusal)
//
// Together they bound both halves of "do not silently drift the
// measured-vs-published relation" — the exact failure class that motivates
// HANDOFF.md's `**N/N** tests` clause to exist (the document-rotation
// false-green documented at the top of this file's source).
//
// RED-on-revert (manually proven during the cycle):
//   patch  `^# tests (\d+)$`  -> `^# tests (\d+)`     flips T1 to red (loose matcher)
//   patch  `\*\*/.*tests`     -> `\*\*(.+)/(.+)\*\* tests`  flips T2 to red (regex widens)
//   patch  line 245 placement -> moves after stale compare       flips T4 to red (no fail-fast)
//   patch  `!==` lines        -> `===`              flips T4 to red (inequality inverts)

const RUNNER = resolve(
  process.cwd(),
  "scripts",
  "run-tests.mjs",
);

function readRunner(): string {
  return readFileSync(RUNNER, "utf8");
}

function lineOf(src: string, needle: string): number {
  const idx = src.indexOf(needle);
  assert.notEqual(idx, -1, `runner must contain literal: ${needle}`);
  return src.slice(0, idx).split("\n").length;
}

test("scripts-run-tests-publish-baseline: TAP anchors are the 4 documented regexes at L192-195", () => {
  const src = readRunner();
  // The four TAP anchors must exist in the runner script in their m-flagged
  // exact form (^...$) so a malformed summary exits 1 loudly.
  const testsAnchor = src.match(/summary\.match\(\/\^# tests \(\\d\+\)\$\/m\)/);
  const passAnchor = src.match(/summary\.match\(\/\^# pass \(\\d\+\)\$\/m\)/);
  const failAnchor = src.match(/summary\.match\(\/\^# fail \(\\d\+\)\$\/m\)/);
  const skippedAnchor = src.match(/summary\.match\(\/\^# skipped \(\\d\+\)\$\/m\)/);
  assert.ok(testsAnchor, "TAP anchor `^# tests N$` (m-flagged) must be present at L192");
  assert.ok(passAnchor, "TAP anchor `^# pass N$` (m-flagged) must be present at L193");
  assert.ok(failAnchor, "TAP anchor `^# fail N$` (m-flagged) must be present at L194");
  assert.ok(skippedAnchor, "TAP anchor `^# skipped N$` (m-flagged) must be present at L195");

  // Line positions of the four anchors must be 192, 193, 194, 195 (contiguous
  // block). A future contributor who reorders them is breaking the contract.
  assert.equal(
    lineOf(src, 'match(/^# tests (\\d+)$/m)'),
    192,
    "`^# tests` anchor must stay at L192",
  );
  assert.equal(
    lineOf(src, 'match(/^# pass (\\d+)$/m)'),
    193,
    "`^# pass` anchor must stay at L193",
  );
  assert.equal(
    lineOf(src, 'match(/^# fail (\\d+)$/m)'),
    194,
    "`^# fail` anchor must stay at L194",
  );
  assert.equal(
    lineOf(src, 'match(/^# skipped (\\d+)$/m)'),
    195,
    "`^# skipped` anchor must stay at L195",
  );

  // Belt-and-braces: the guard that uses these four matches must require ALL
  // FOUR to be present (the AND-chain). A version that tolerates a missing
  // anchor and defaults is the silent-green class this guard exists to prevent.
  assert.ok(
    /if \(!testsMatch \|\| !passMatch \|\| !failMatch \|\| !skippedMatch\)/.test(src),
    "TAP-summary guard at L215 must AND-chain all four matchers",
  );
});

test("scripts-run-tests-publish-baseline: HANDOFF regex enforces `**N/N** tests` canonical form at L218", () => {
  const src = readRunner();
  // The published-baseline regex must be `\*\*(\d+)\/(\d+)\*\* tests` —
  // tight digit-anchored match on BOTH halves of the slash.
  // A regex like `\*\*(.+)/(.+)\*\* tests` would silently accept prose.
  // The source bytes (single-backslash escape) contain the substring
  //     handoff.match(/\*\*(\d+)\/(\d+)\*\* tests/)
  // so we substring-match the JS source directly — no regex-of-regex complexity.
  const canonicalSubstring =
    'handoff.match(/\\*\\*(\\d+)\\/(\\d+)\\*\\* tests/)';
  assert.ok(
    src.includes(canonicalSubstring),
    `HANDOFF regex \`\\*\\*(\\d+)\\/(\\d+)\\*\\* tests\` must be present ` +
      `(missing canonical substring: ${canonicalSubstring})`,
  );

  // Line position pin (L218 in the published-file at origin/main).
  assert.equal(
    lineOf(src, "const published = handoff.match(/\\*\\*(\\d+)\\/(\\d+)\\*\\* tests/);"),
    218,
    "HANDOFF publish-regex literal must stay at L218",
  );

  // Belt-and-braces: the guard that uses this regex must print the canonical
  // "publish that figure" message when the regex misses — that message is the
  // operator-visible directive; if a future rewrite changes the wording the
  // harness may silently accept non-canonical baselines elsewhere.
  assert.ok(
    /HANDOFF\.md publishes no/.test(src) &&
      /N\/N/.test(src) &&
      /tests/.test(src) &&
      /baseline/.test(src),
    "empty-publish error message must keep the literal `**N/N** tests` baseline wording",
  );

  // And the guard must exit 1 when the regex misses (not silently green).
  const block = src.slice(
    src.indexOf("if (!published) {"),
    src.indexOf("if (!published) {") + 600,
  );
  assert.ok(
    /process\.exit\(1\)/.test(block),
    "empty-publish branch must exit 1 (silent green is the failure mode this guard prevents)",
  );
});

test("scripts-run-tests-publish-baseline: fail-fast invariant at L229 — measuredFail gates the published compare", () => {
  const src = readRunner();
  // The fail-fast invariant requires: if the suite reports failures,
  // exit 1 BEFORE the published-baseline comparison runs. The order
  // matters — a failing suite must NOT also complain that HANDOFF.md
  // is stale. Two errors would bury the first.
  assert.equal(
    lineOf(src, "if (measuredFail !== 0) {"),
    229,
    "fail-fast invariant `if (measuredFail !== 0)` must stay at L229",
  );

  // The stale-baseline guard must come AFTER the fail-fast (i.e. at a
  // strictly later line). If a future rewrite moves the stale-baseline
  // guard to before line 229, a failing suite would still surface the
  // stale-baseline error — the bug-burying class this guard prevents.
  const failFastLine = src.slice(0).split("\n").findIndex((l) => l.includes("if (measuredFail !== 0) {"));
  const staleLine = src
    .split("\n")
    .findIndex((l) =>
      l.includes("Number(published[1]) !== measuredTotal || Number(published[2]) !== measuredTotal"),
    );
  assert.ok(failFastLine >= 0, "fail-fast `if (measuredFail !== 0)` must exist");
  assert.ok(staleLine >= 0, "stale-baseline guard must exist");
  assert.ok(
    failFastLine < staleLine,
    `fail-fast (L${failFastLine + 1}) MUST precede stale-baseline guard (L${staleLine + 1}); ` +
      "a failing suite must not also report a stale baseline",
  );

  // The fail-fast branch must `process.exit(1)` (not silently green).
  const block = src.slice(
    src.indexOf("if (measuredFail !== 0) {"),
    src.indexOf("if (measuredFail !== 0) {") + 400,
  );
  assert.ok(
    /process\.exit\(1\)/.test(block),
    "fail-fast branch must exit 1 (never silently green on a failing suite)",
  );

  // The error message must include the measured-fail count so the operator
  // sees the real cause. A bare `process.exit(1)` with no count would bury
  // the failure inside the stale-baseline error.
  assert.ok(
    /The suite reported \$\{measuredFail\} failing/.test(src),
    "fail-fast message must include `${measuredFail}` so the operator sees the count",
  );
});

test("scripts-run-tests-publish-baseline: stale-baseline guard at L234 — both N/N halves checked against measuredTotal", () => {
  const src = readRunner();
  // The stale-baseline guard must compare BOTH halves of `**N/N**` to
  // measuredTotal. A guard that checks only `published[1]` would let
  // HANDOFF.md drift to `**1809/1810**` silently through CI.
  const guard = /Number\(published\[1\]\) !== measuredTotal \|\| Number\(published\[2\]\) !== measuredTotal/;
  assert.ok(guard.test(src), "stale-baseline guard must check BOTH published[1] AND published[2]");

  // Line position pin (L234 in the published-file at origin/main).
  assert.equal(
    lineOf(
      src,
      "if (Number(published[1]) !== measuredTotal || Number(published[2]) !== measuredTotal) {",
    ),
    234,
    "stale-baseline guard line must stay at L234",
  );

  // Belt-and-braces: the guard's error message MUST echo the published
  // figure and the measured figure in the canonical form. The directive
  // text "Never adjust the measurement to match the document" is the
  // operator-visible constraint — flipping it to "adjust the document to
  // match the measurement" would invert the failure-prevention direction.
  const block = src.slice(
    src.indexOf("if (Number(published[1]) !== measuredTotal"),
    src.indexOf("if (Number(published[1]) !== measuredTotal") + 600,
  );
  assert.ok(
    /HANDOFF\.md publishes: \*\*\$\{published\[1\]\}\/\$\{published\[2\]\}\*\* tests/.test(block),
    "stale message must echo the published N/N figure",
  );
  assert.ok(
    /This run measured:    \$\{measured\}/.test(block),
    "stale message must echo the measured line",
  );
  assert.ok(
    /Never adjust the measurement to match the/.test(src),
    "operator-visible direction-constraint must be present in the stale message",
  );
  assert.ok(
    /process\.exit\(1\)/.test(block),
    "stale-baseline branch must exit 1",
  );
});
