const FOCUSED_ALLOWLIST_POLICY = "docs/ops/FOCUSED-TEST-ALLOWLIST.md";

export const FOCUSED_TEST_ALLOWLIST = Object.freeze([
  "editors/vscode/src/model.test.ts",
]);

const focusedTestAllowlist = new Set(FOCUSED_TEST_ALLOWLIST);

function focusedClassError(message) {
  return new Error(
    `${message}\n` +
      `  see ${FOCUSED_ALLOWLIST_POLICY} for the policy and add path\n` +
      "  hint: re-run without --class=focused to run the full canonical suite under the lease",
  );
}

export function classifyTestRun(args) {
  if (args.length === 0) return { testClass: "full", files: [] };

  const [classArg, ...files] = args;
  if (!classArg.startsWith("--class=")) {
    throw new Error(`error: unknown run-tests argument: ${classArg}`);
  }

  const testClass = classArg.slice("--class=".length);
  if (testClass === "full") {
    if (files.length > 0) {
      throw new Error("error: --class=full does not accept test paths");
    }
    return { testClass, files: [] };
  }

  if (testClass !== "focused") {
    throw new Error(`error: unknown test class: ${testClass}`);
  }
  if (files.length === 0) {
    throw focusedClassError("error: --class=focused requires at least one allowlisted test path");
  }

  const rejected = files.filter((file) => !focusedTestAllowlist.has(file));
  if (rejected.length > 0) {
    throw focusedClassError(
      "error: --class=focused is restricted to the safe-class allowlist" +
        `\n  rejected: ${rejected.join(", ")}`,
    );
  }

  return { testClass, files };
}

export function focusedNodeArgs(files) {
  return [
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "--",
    ...files,
  ];
}
