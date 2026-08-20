#!/usr/bin/env node
// Claims lens: pull every "tool name" from src/index.ts's tool list, plus the
// tools-list response bytes themselves, and compare to every numeric/word claim
// in README.md, HANDOFF.md, and CHANGELOG.md. This is read-only: it does not
// spawn the server, it just extracts from the source. The companion test
// (test/public-claims-guard.test.ts) runs the same comparison so the audit is
// not a one-shot artifact.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const srcIndex = readFileSync(resolve(repoRoot, "src/index.ts"), "utf8");
const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");
const handoff = readFileSync(resolve(repoRoot, "HANDOFF.md"), "utf8");
const changelog = readFileSync(resolve(repoRoot, "CHANGELOG.md"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

// 1) Extract every MCP tool name from the canonical tools/list array.
//    The source has exactly one `tools: [` block followed by `].filter(...)`
//    inside the ListToolsRequestSchema handler. Each member has `name: "<x>"`
//    (or `name: '<x>'` in test fixtures). We extract ALL `name: "..."` matches
//    inside that block. The block is the one whose enclosing setRequestHandler
//    call responds to ListToolsRequestSchema, so the trailing `].filter` is
//    unambiguous.
const toolsBlock = srcIndex.match(/tools:\s*\[([\s\S]*?)\]\s*\.filter\(/);
if (!toolsBlock) {
  console.error("ERROR: could not locate the canonical tools:[ ... ].filter(...) block in src/index.ts");
  process.exit(2);
}
const inner = toolsBlock[1];
// Allow any of: name: "x", name: 'x', with optional surrounding whitespace.
// Restrict the tool name itself to MCP-legal characters (lowercase, digits,
// underscore, period) to avoid false matches in long string literals.
const nameMatches = [...inner.matchAll(/name:\s*["']([a-z0-9_.]+)["']/g)].map((m) => m[1]);
const toolCount = nameMatches.length;
const toolSet = new Set(nameMatches);
if (toolSet.size !== toolCount) {
  console.error(
    `ERROR: ${toolCount} name: matches but ${toolSet.size} unique names — likely a duplicate or a tool name that should be uniqued. List: ${nameMatches.join(", ")}`
  );
  process.exit(2);
}

// 2) Extract every "Source version" / "<n> MCP tools" / "<n>/<n> tests" claim
//    from README, HANDOFF, and CHANGELOG. Each match is recorded with its
//    source file, line, and the exact claim string so a human can re-read.
const claims = [];

function linesOf(text) {
  return text.split("\n");
}

function scan(file, text, patterns) {
  const ls = linesOf(text);
  for (const { re, label, kind } of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const idx = text.indexOf(m[0]);
    let upTo = 0;
    let lineNo = 1;
    for (const ln of ls) {
      upTo += ln.length + 1;
      if (upTo > idx) break;
      lineNo++;
    }
    claims.push({ file, line: lineNo, label, kind, value: m[0] });
  }
}

scan("README.md", readme, [
  { re: /Source version\*\*:\s*([0-9]+\.[0-9]+\.[0-9]+)/, label: "readme source version", kind: "version" },
  { re: /##\s*([0-9]+)\s+MCP tools/, label: "readme tool count", kind: "tool_count" },
  { re: /\*\*MCP surface:\*\*\s*\*\*([0-9]+)\s+MCP tools\*\*/, label: "handoff tool count", kind: "tool_count" },
]);
scan("HANDOFF.md", handoff, [
  { re: /Source version:\*\*\s*`?([0-9]+\.[0-9]+\.[0-9]+)`?/, label: "handoff source version", kind: "version" },
  { re: /\*\*MCP surface:\*\*\s*\*\*([0-9]+)\s+MCP tools\*\*/, label: "handoff tool count", kind: "tool_count" },
  { re: /\*\*current suite contract:\*\*\s*\*\*([0-9]+)\/([0-9]+)\*\*\s*tests collected/, label: "handoff suite contract", kind: "test_count" },
]);
scan("CHANGELOG.md", changelog, [
  { re: /##\s*\[([0-9]+\.[0-9]+\.[0-9]+)\]/, label: "changelog top version", kind: "version" },
]);

// 3) Compare.
const errors = [];
const packageVersion = pkg.version;

for (const c of claims) {
  if (c.kind === "version") {
    if (c.value.includes(packageVersion)) continue;
    if (c.file === "CHANGELOG.md" && c.label === "changelog top version") {
      // CHANGELOG top is the latest released version, not the in-tree version
      // during development. If package.json is ahead, that's expected and not
      // a lie — but if CHANGELOG top is NEWER than package.json, that IS one.
      if (compareSemver(c.value.match(/[0-9]+\.[0-9]+\.[0-9]+/)[0], packageVersion) > 0) {
        errors.push(`${c.file}:${c.line}  ${c.label}  claims ${c.value} but package.json is ${packageVersion} (CHANGELOG ahead of tree)`);
      }
      continue;
    }
    errors.push(`${c.file}:${c.line}  ${c.label}  claims ${c.value} but package.json is ${packageVersion}`);
  } else if (c.kind === "tool_count") {
    const m = c.value.match(/([0-9]+)/);
    const claimed = m ? parseInt(m[1], 10) : NaN;
    if (claimed !== toolCount) {
      errors.push(`${c.file}:${c.line}  ${c.label}  claims ${claimed} MCP tools but src/index.ts registers ${toolCount}`);
    }
  } else if (c.kind === "test_count") {
    // Test count is verified by the live run, not from source; this audit only
    // records the claim so a reader can re-check. The companion guard test
    // runs the suite and compares.
    // (We still print the claim for traceability.)
  }
}

// 4) Print a machine-readable summary.
const summary = {
  packageVersion,
  toolCount,
  toolNames: nameMatches,
  claims,
  errors,
  ok: errors.length === 0,
};
console.log(JSON.stringify(summary, null, 2));
process.exit(errors.length === 0 ? 0 : 1);

function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}
