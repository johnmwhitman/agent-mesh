import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  engines?: { node?: string };
};

function inlineNodeMatrix(workflow: string): number[] {
  const lines = workflow.split(/\r?\n/);
  const matrixIndex = lines.findIndex((line) => /^\s+matrix:\s*$/.test(line));
  assert.notEqual(matrixIndex, -1, "workflow must define a strategy matrix");

  const matrixIndent = lines[matrixIndex].search(/\S/);
  for (const line of lines.slice(matrixIndex + 1)) {
    const indent = line.search(/\S/);
    if (indent !== -1 && indent <= matrixIndent) break;
    const match = line.match(/^\s+node:\s*\[([^\]]+)]\s*$/);
    if (match) return match[1].split(",").map((value) => Number(value.trim()));
  }

  assert.fail("workflow strategy matrix must declare an inline Node version list");
}

function actionRefs(workflow: string): string[] {
  return workflow.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*-\s+uses:\s+(actions\/(?:checkout|setup-node)@\S+)/);
    return match ? [match[1]] : [];
  });
}

function runCommands(workflow: string): string[] {
  const lines = workflow.split(/\r?\n/);
  const commands: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)-?\s*run:\s*(.*)$/);
    if (!match) continue;

    const [, whitespace, value] = match;
    if (value !== "|" && value !== ">" && value !== "|-" && value !== ">-") {
      commands.push(value);
      continue;
    }

    const indent = whitespace.length;
    const block: string[] = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      const nextIndent = next.search(/\S/);
      if (nextIndent !== -1 && nextIndent <= indent) break;
      block.push(next.trim());
      index += 1;
    }
    commands.push(block.join("\n"));
  }

  return commands;
}

function assertReproducibleCiWorkflow(workflow: string, release: string): void {
  const ciActions = actionRefs(workflow);
  const releaseActions = [...new Set(actionRefs(release))];

  assert.deepEqual(
    ciActions,
    [
      "actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8",
      "actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444",
    ],
    "CI actions must use immutable reviewed revisions",
  );
  assert.deepEqual(
    ciActions,
    releaseActions,
    "CI actions must use the same immutable revisions as tagged release",
  );
  assert.ok(
    runCommands(workflow).some((command) => command.trim() === "npm ci"),
    "CI must install exactly from package-lock.json",
  );
  assert.ok(
    runCommands(workflow).every((command) => !/\bnpm\s+install\b/.test(command)),
    "CI must not resolve a new dependency graph",
  );
}

test("the operational Node default is pinned to the verified Node 24 canary", () => {
  const declared = readFileSync(".nvmrc", "utf8");

  assert.equal(
    declared.replace(/\r\n/g, "\n"),
    "24.18.1\n",
    ".nvmrc must pin the exact Node 24 release verified by the local compatibility canary",
  );
  assert.equal(
    packageJson.engines?.node,
    ">=20",
    "the Node 24 developer default must not narrow the supported Node 20+ package contract",
  );
});

test("CI and tagged release verification both exercise the operational Node major", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const release = readFileSync(".github/workflows/release.yml", "utf8");

  assert.deepEqual(inlineNodeMatrix(ci), [20, 22, 24]);
  assert.deepEqual(inlineNodeMatrix(release), [20, 22, 24]);
});

test("a commented Node list cannot satisfy the workflow matrix guard", () => {
  assert.throws(() => inlineNodeMatrix("strategy:\n  matrix:\n    # node: [20, 22, 24]\n    os: [ubuntu]\n"));
});

test("CI installs the committed lockfile under immutable release-matched actions", () => {
  assertReproducibleCiWorkflow(
    readFileSync(".github/workflows/ci.yml", "utf8"),
    readFileSync(".github/workflows/release.yml", "utf8"),
  );
});

test("floating actions, release drift, and dependency resolution cannot satisfy the guard", () => {
  const release = [
    "steps:",
    "  - uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8",
    "  - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444",
  ].join("\n");
  const floating = release.replaceAll(/@[0-9a-f]{40}/g, "@v5") + "\n  - run: npm ci";
  const ci = release + "\n  - run: npm ci";
  const releaseDrift = release.replace("a0853c24544627f65ddf259abe73b1d18a591444", "1111111111111111111111111111111111111111");
  const installBypasses = [
    "  - run: npm install --legacy-peer-deps",
    "  - run: npm ci && npm install",
    "  - run: |\n      npm install\n      npm test",
  ];

  assert.throws(() => assertReproducibleCiWorkflow(floating, release));
  assert.throws(() => assertReproducibleCiWorkflow(ci, releaseDrift));
  for (const bypass of installBypasses) {
    assert.throws(() => assertReproducibleCiWorkflow(`${release}\n${bypass}\n  - run: npm ci`, release));
  }
});
