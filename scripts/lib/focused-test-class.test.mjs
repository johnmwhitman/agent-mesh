import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FOCUSED_TEST_ALLOWLIST,
  classifyTestRun,
  focusedNodeArgs,
} from "./focused-test-class.mjs";

const MODEL_TEST = "editors/vscode/src/model.test.ts";

test("no class argument selects the canonical full suite", () => {
  assert.deepEqual(classifyTestRun([]), { testClass: "full", files: [] });
});

test("explicit full class selects the canonical full suite", () => {
  assert.deepEqual(classifyTestRun(["--class=full"]), { testClass: "full", files: [] });
});

test("focused class accepts only explicitly allowlisted files", () => {
  assert.deepEqual(classifyTestRun(["--class=focused", MODEL_TEST]), {
    testClass: "focused",
    files: [MODEL_TEST],
  });
  assert.deepEqual([...FOCUSED_TEST_ALLOWLIST], [MODEL_TEST]);
});

test("focused class fails closed when no file is selected", () => {
  assert.throws(
    () => classifyTestRun(["--class=focused"]),
    /requires at least one allowlisted test path/,
  );
});

test("focused class fails closed for files outside the allowlist", () => {
  assert.throws(
    () => classifyTestRun(["--class=focused", "test/recommend-route.test.ts"]),
    /restricted to the safe-class allowlist/,
  );
});

test("unknown runner arguments fail closed instead of silently running full", () => {
  assert.throws(() => classifyTestRun(["--class=fast"]), /unknown test class/);
  assert.throws(() => classifyTestRun([MODEL_TEST]), /unknown run-tests argument/);
  assert.throws(
    () => classifyTestRun(["--class=full", MODEL_TEST]),
    /does not accept test paths/,
  );
});

test("focused node arguments run selected tests directly without a summary reporter", () => {
  const args = focusedNodeArgs([MODEL_TEST]);
  assert.deepEqual(args, [
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "--",
    MODEL_TEST,
  ]);
  assert.equal(args.some((arg) => arg.includes("test-reporter")), false);
  assert.equal(args.some((arg) => arg.includes("meshfleet-suite-summary")), false);
});
