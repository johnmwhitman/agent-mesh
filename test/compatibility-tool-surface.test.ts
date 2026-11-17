import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string => readFileSync(join(repoRoot, path), "utf8");

const indexSource = read("src/index.ts");
const compatibility = read("COMPATIBILITY.md");

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Same parse public-contract-parity.test.ts uses: derived from src/index.ts, so a new tool
// registration fails this guard until COMPATIBILITY.md's version history names it.
const registeredToolNames = Array.from(
  new Set(Array.from(indexSource.matchAll(/toolHandlers\["([^"]+)"\]\s*=/g), (match) => match[1])),
);

// The Tools column is the second cell of each row of the "## MCP tool surface" table. Names that
// appear only in the notes column (third cell) do not count.
const toolsColumn = (): string => {
  const afterHeading = compatibility.split("## MCP tool surface")[1];
  assert.ok(afterHeading !== undefined, "COMPATIBILITY.md has no '## MCP tool surface' section");
  const section = afterHeading.split("\n## ")[0];
  return section
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| Version"))
    .map((line) => line.split("|")[2] ?? "")
    .join(" ");
};

test("the tool-surface derivations are non-vacuous", () => {
  assert.ok(
    registeredToolNames.length > 0,
    "tool-handler parse matched nothing in src/index.ts — the derivation, not the document, is broken",
  );
  assert.ok(toolsColumn().trim().length > 0, "the MCP tool surface table has an empty Tools column");
});

test("every registered MCP tool is named in the COMPATIBILITY.md Tools column", () => {
  const column = toolsColumn();
  const missing = registeredToolNames.filter(
    (name) => !new RegExp(`(?<![a-z_0-9])${escapeRegExp(name)}(?![a-z_0-9])`).test(column),
  );
  assert.deepEqual(
    missing,
    [],
    `registered in src/index.ts but missing from the COMPATIBILITY.md MCP tool surface Tools column: ${missing.join(", ")}`,
  );
});

// A row that says "(no new tools" for a version range must not cover a version in which another
// row lists tools: a reader of the table must not be told two opposite things.
type VersionRange = { lo: number[]; hi: number[] };
const parseVersion = (text: string, open: number): number[] =>
  text.split(".").map((part) => (part === "x" ? open : Number(part)));
const compareVersions = (a: number[], b: number[]): number => {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
};
const parseRange = (cell: string): VersionRange | null => {
  const match = cell.trim().match(/^(\d+\.\d+\.\d+)(?:\s*[–-]\s*(\d+\.\d+\.(?:\d+|x)))?$/);
  if (match === null) return null;
  return { lo: parseVersion(match[1], 0), hi: parseVersion(match[2] ?? match[1], Number.MAX_SAFE_INTEGER) };
};

test("no 'no new tools' row covers a version that another row lists tools for", () => {
  const afterHeading = compatibility.split("## MCP tool surface")[1] ?? "";
  const rows = afterHeading
    .split("\n## ")[0]
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| Version"))
    .map((line) => line.split("|").map((cell) => cell.trim()));
  const parsed = rows.map((cells) => ({ range: parseRange(cells[1] ?? ""), tools: cells[2] ?? "" }));
  assert.ok(parsed.every((row) => row.range !== null), "a table row has an unparseable Version cell");
  const noNew = parsed.filter((row) => row.tools.startsWith("(no new tools"));
  const withTools = parsed.filter((row) => row.tools.startsWith("+") || !row.tools.startsWith("("));
  assert.ok(noNew.length > 0 && withTools.length > 0, "table split into no-new and tools rows came out empty");
  for (const quiet of noNew) {
    for (const added of withTools) {
      const overlaps =
        compareVersions(added.range!.lo, quiet.range!.hi) <= 0 && compareVersions(added.range!.hi, quiet.range!.lo) >= 0;
      assert.equal(overlaps, false, `'(no new tools' row ${JSON.stringify(quiet.range)} overlaps a row that lists tools: ${added.tools}`);
    }
  }
});
