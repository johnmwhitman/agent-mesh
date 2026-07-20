import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("package exports preserve intended entrypoints and deny internal durable seams", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    main: string;
    bin: Record<string, string>;
    exports: Record<string, string>;
  };
  assert.equal(pkg.main, "dist/index.js");
  assert.deepEqual(pkg.bin, {
    meshfleet: "dist/index.js",
    "agent-mesh": "dist/bin/inspect.js",
    "agent-mesh-dashboard": "dist/bin/dashboard.js",
  });
  assert.deepEqual(pkg.exports, {
    ".": "./dist/index.js",
    "./package.json": "./package.json",
    "./bin/inspect": "./dist/bin/inspect.js",
    "./bin/dashboard": "./dist/bin/dashboard.js",
  });

  for (const specifier of ["meshfleet", "meshfleet/package.json", "meshfleet/bin/inspect", "meshfleet/bin/dashboard"]) {
    assert.doesNotThrow(() => import.meta.resolve(specifier));
  }
  for (const specifier of [
    "meshfleet/a2a/durable-acceptance",
    "meshfleet/dist/a2a/durable-acceptance.js",
    "meshfleet/db",
    "meshfleet/src/a2a/durable-acceptance.js",
  ]) {
    assert.throws(() => import.meta.resolve(specifier), (error: unknown) => (error as NodeJS.ErrnoException).code === "ERR_PACKAGE_PATH_NOT_EXPORTED");
  }

  const rootSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.equal(rootSource.includes("recordDurableAcceptance"), false);
  assert.equal(rootSource.includes("send_a2a"), false);
});
