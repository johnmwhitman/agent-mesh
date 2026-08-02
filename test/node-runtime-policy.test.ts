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
