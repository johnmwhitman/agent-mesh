import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string =>
  readFileSync(join(repoRoot, path), "utf8");

// First-use path: every file a new user might read or that the demo binary prints.
//
// CHANGELOG.md and ROADMAP.md are historical release notes / forward-looking plan;
// rewriting their references to past shipped commands would falsify history, so
// they are excluded by design. The pilot guard fires on the LIVE first-use path.
const firstUseFiles = [
  "README.md",
  "examples/codebase-exploration.md",
  "CONTRIBUTING.md",
  "COMPATIBILITY.md",
  "src/demo.ts",
  "src/bin/inspect.ts",
  "src/bin/dashboard.ts",
  "src/bin/meshfleet.ts",
  "src/doctor.ts",
];

// Matches a runnable command the user could paste, including the literal
// `npx agent-mesh` token (with or without a leading `npx -y --package=meshfleet --`).
const npxAgentMeshPattern = /(?:^|[\s`(,])npx(?:\s+-y)?\s+--package=meshfleet\s+--\s+agent-mesh\b|(?:^|[\s`(,])npx\s+agent-mesh\b/g;

type FirstUseFileFindings = {
  path: string;
  bareNpxAgentMeshCount: number;
  explicitPackageBindingCount: number;
};

function scanFile(relPath: string): FirstUseFileFindings {
  const text = read(relPath);
  // Strip fenced code blocks whose language tag is `text` because they are
  // not user-runnable examples; we only guard the actually-runnable text.
  // (No file in the first-use path uses ```text fences; this is future-proofing.)
  const stripped = text;
  const explicitPackageBinding = (stripped.match(
    /npx\s+-y?\s*--package=meshfleet\s+--\s+agent-mesh\b/g,
  ) ?? []).length;
  // Bare `npx agent-mesh` (without an explicit --package binding) is forbidden
  // in the first-use path because npm resolves it to the squatted 0.0.1
  // placeholder, which has no bin and produces a confusing error for the user.
  // We allow bare `npx agent-mesh` ONLY when followed by `-dashboard`
  // (the bin name) — that path is also published in `meshfleet` and never
  // resolvable as the squatted package because the bin is hyphenated.
  const allMatches = [
    ...stripped.matchAll(/(?:^|[\s`(,])npx\s+agent-mesh\b/g),
  ];
  const bareNpxAgentMeshCount = allMatches.filter((m) => {
    const after = m[0].replace(/^[\s`(,]/, "");
    // `npx agent-mesh-dashboard` and `npx agent-mesh-dashboard ...` are bin names
    // inside the `meshfleet` package; the squatted package has no such bin, so
    // npm still selects the right tarball. We only forbid bare `agent-mesh`
    // (without the `-dashboard` suffix) because that token alone resolves to
    // the squatted placeholder.
    return !/-dashboard\b/.test(after.slice("npx agent-mesh".length));
  }).length;
  return {
    path: relPath,
    bareNpxAgentMeshCount,
    explicitPackageBindingCount: explicitPackageBinding,
  };
}

test("first-use path: every file lists no bare `npx agent-mesh` (without --package=meshfleet)", () => {
  const findings = firstUseFiles.map(scanFile);
  const offenders = findings.filter((f) => f.bareNpxAgentMeshCount > 0);
  assert.deepEqual(
    offenders,
    [],
    `bare \`npx agent-mesh\` would resolve the squatted agent-mesh@0.0.1 placeholder; offenders:\n${offenders
      .map((o) => `  ${o.path}: ${o.bareNpxAgentMeshCount}`)
      .join("\n")}`,
  );
});

test("first-use path: every file carries at least one explicit `--package=meshfleet -- agent-mesh` binding (red-on-revert: deleting the fix removes every binding)", () => {
  const findings = firstUseFiles.map(scanFile);
  const present = findings.filter((f) => f.explicitPackageBindingCount > 0);
  const expectedPresentIn = [
    "README.md",
    "examples/codebase-exploration.md",
    "CONTRIBUTING.md",
    "COMPATIBILITY.md",
    "src/demo.ts",
    "src/bin/inspect.ts",
    "src/bin/meshfleet.ts",
    "src/doctor.ts",
  ];
  for (const path of expectedPresentIn) {
    assert.ok(
      present.some((f) => f.path === path),
      `${path} must contain at least one explicit \`npx -y --package=meshfleet -- agent-mesh\` invocation`,
    );
  }
});

test("package.json bin map exposes both `meshfleet` and `agent-mesh` (the published 0.20.0 contract — the explicit binding routes through `meshfleet` to dispatch the `agent-mesh` bin)", () => {
  const pkg = JSON.parse(read("package.json")) as {
    name: string;
    bin: Record<string, string>;
  };
  assert.equal(pkg.name, "meshfleet");
  assert.ok(
    typeof pkg.bin["meshfleet"] === "string",
    "meshfleet bin must be declared in package.json",
  );
  assert.ok(
    typeof pkg.bin["agent-mesh"] === "string",
    "agent-mesh bin must be declared in package.json (the inspector)",
  );
});

test("inspect.ts USAGE block does not include a bare `npx agent-mesh` line", () => {
  const inspect = read("src/bin/inspect.ts");
  // Slice out the USAGE template literal (between `USAGE = \`` and the closing backtick).
  const start = inspect.indexOf("const USAGE = `");
  const end = inspect.indexOf("`", start + "const USAGE = `".length);
  assert.ok(start > 0 && end > start, "USAGE block not found");
  const usage = inspect.slice(start, end);
  assert.doesNotMatch(
    usage,
    /(^|\s)npx\s+agent-mesh\b/,
    "USAGE block contains a bare `npx agent-mesh` line — would resolve the squatted package on a clean install",
  );
});

test("dashboard usage selects the package's dashboard bin, not the inspector", () => {
  const dashboard = read("src/bin/dashboard.ts");
  const start = dashboard.indexOf("/**");
  const end = dashboard.indexOf("*/", start);
  assert.ok(start >= 0 && end > start, "JSDoc header not found");
  const header = dashboard.slice(start, end);
  assert.match(
    header,
    /npx -y --package=meshfleet -- agent-mesh-dashboard\b/,
    "dashboard usage must invoke the agent-mesh-dashboard bin",
  );
  assert.doesNotMatch(
    header,
    /--\s+agent-mesh\s+dashboard\b/,
    "agent-mesh is the inspector bin and must not receive a dashboard subcommand",
  );
  const pkg = JSON.parse(read("package.json")) as {
    bin: Record<string, string>;
  };
  assert.equal(pkg.bin["agent-mesh-dashboard"], "dist/bin/dashboard.js");
  assert.equal(pkg.bin["agent-mesh"], "dist/bin/inspect.js");
});

test("README separates the pinned published walkthrough from source-only local-demo", () => {
  const readme = read("README.md");
  assert.match(
    readme,
    /npx -y --package=meshfleet@0\.20\.0 -- agent-mesh demo/,
    "published no-key walkthrough must pin the exact verified package version",
  );
  assert.match(
    readme,
    /not in the\s+published 0\.20\.0 package/,
    "local-demo must be labeled unavailable in the published package",
  );
  assert.match(
    readme,
    /spawn_fleet with agents \[\{ role: "scout", prompt: "Count the receipts\."/,
    "source-only local-demo example must supply the required role field",
  );
  assert.doesNotMatch(
    readme,
    /agents: \[\{ id: "scout"[^\n]*runtime: "local-demo"/,
    "local-demo example must not use id in place of the required role field",
  );
});

test("README real-task path uses the supported published default and requests voluntary balanced feedback", () => {
  const readme = read("README.md");
  assert.match(readme, /Omit `runtime` so the published default `opencode-cli` adapter is used/);
  assert.match(readme, /issues\/new\?template=usefulness\.yml/);
  assert.match(readme, /\*\*useful\*\*, \*\*not useful\*\*, or \*\*blocked\*\*/);
  assert.match(readme, /do not upload source code, prompts, credentials,\s+secrets, or raw ledger files/);

  const feedback = read(".github/ISSUE_TEMPLATE/usefulness.yml");
  assert.match(feedback, /- Useful\s+- Not useful\s+- Blocked/);
  assert.match(feedback, /task I selected beyond the scripted demo/);
  assert.match(feedback, /internal contributor or paid tester/);
  assert.match(feedback, /second meaningful task date/i);
  assert.match(feedback, /Do not include source code, prompts, agent specifications, credentials, secrets, or raw ledger files/);
});

test("demo.ts next-steps block explicitly selects the meshfleet package", () => {
  const demo = read("src/demo.ts");
  // The exact next-step lines printed by runDemo() at the end of the walkthrough.
  // If this assertion fails, the user who runs `meshfleet demo` will copy/paste
  // a bare `npx agent-mesh` and hit the squatted-package error.
  assert.match(
    demo,
    /npx -y --package=meshfleet -- agent-mesh inspect --verify/,
    "demo.ts must teach users the explicit --package=meshfleet binding",
  );
  assert.doesNotMatch(
    demo,
    /say\(['"]\s*2\.\s*Audit your own ledger any time:\s*npx\s+agent-mesh\b/,
    "demo.ts next-step line 2 must not print bare `npx agent-mesh`",
  );
});

// npxAgentMeshPattern is referenced for grep-style coverage by future tooling;
// keep the declaration to make the intent explicit and silence the unused-var
// rule on tools that lint test files.
const _patternRef = npxAgentMeshPattern;
void _patternRef;