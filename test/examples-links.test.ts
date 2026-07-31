import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// The README a stranger opens must not 404. `examples/README.md` published
// `](pipeline-explain-plan-implement.json)` while the file on disk was
// `pipeline-explore-plan-implement.json` — the link TEXT said "explore", the href said
// "explain" — so every reader who clicked it from GitHub got a 404, on a repo whose claim
// is that its published contract is real.
//
// `examples-check.test.ts` could not see it: it selects top-level `.js`/`.mjs` only and runs
// `node --check`, so its entire input set is `["receipted-fleet.mjs"]`. A JSON file
// referenced from a markdown file is outside anything it looks at. This guard closes that
// class — every relative link under examples/ must resolve to a file that exists.

const examplesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");

// Measured, not assumed: scanning all 82 tracked `.md` files with a raw `[..](..)` match
// returns three hits, and TWO are text inside code spans that merely looks like a link —
// `` `...ss[.fraction](Z|±HH:mm)` `` in README.md and a regex in the A2A profile. A link
// checker that does not strip code reports those as broken forever, and a guard that cries
// wolf gets an allowlist, which is how a real finding ends up silenced. So: strip fenced
// blocks and inline spans FIRST, and only then look for links.
function stripCode(markdown: string): string {
  return markdown
    .replace(/^```[\s\S]*?^```/gm, (block) => block.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (span) => span.replace(/[^\n]/g, " "));
}

// Recursive on purpose. examples/ is flat today; the day someone adds a subdirectory, a
// non-recursive scan would keep reporting green over links it had stopped reading.
function markdownFilesUnder(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A directory we cannot read is an unknown, and an unknown reported as clean is the
    // exact failure this guard exists to prevent.
    throw new Error(`examples link scan could not read ${dir}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  return entries.flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFilesUnder(full);
    return entry.name.endsWith(".md") ? [full] : [];
  });
}

test("every relative link published under examples/ resolves to a file that exists", () => {
  const files = markdownFilesUnder(examplesDir);
  assert.ok(files.length > 0, "examples/ should contain at least one markdown file");

  const broken: string[] = [];
  let checked = 0;

  for (const file of files) {
    const lines = stripCode(readFileSync(file, "utf8")).split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const href = match[1];
        // Off-repo destinations and same-page anchors are not this guard's business.
        if (/^(https?:|mailto:|#)/.test(href)) continue;
        checked += 1;
        const target = decodeURIComponent(href.split("#")[0].split("?")[0]);
        if (!existsSync(resolve(dirname(file), target))) {
          broken.push(`${file.slice(file.indexOf("examples/"))}:${index + 1} -> ${href}`);
        }
      }
    });
  }

  // A scan that matched nothing is not a pass. If the link syntax in these files ever drifts
  // out from under the pattern above, this guard must fail loudly rather than bless silence.
  assert.ok(checked > 0, "found no relative links under examples/ — the scan itself is broken");
  assert.deepEqual(broken, [], `examples/ publishes ${broken.length} link(s) to missing files`);
});
