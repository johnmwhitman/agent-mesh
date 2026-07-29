import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "bin", "routeplane-catalog.ts");
const LOOPBACK_ENDPOINT = "http://127.0.0.1:4356/v1/models";
const TEST_CATALOG = {
  object: "list",
  data: [
    { id: "z-model", object: "model", providers: ["zeta", "alpha"] },
    { id: "a-model", object: "model", providers: ["beta"] },
  ],
};

function withFetchPreload(run: (preload: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-routeplane-catalog-cli-"));
  const preload = join(dir, "routeplane-fetch-preload.mjs");
  writeFileSync(
    preload,
    `const payload = process.env.MESHFLEET_TEST_ROUTEPLANE_CATALOG_JSON;
if (payload !== undefined) {
  globalThis.fetch = async (input) => {
    if (String(input) !== ${JSON.stringify(LOOPBACK_ENDPOINT)}) {
      throw new Error("unexpected RoutePlane endpoint: " + String(input));
    }
    if (process.env.MESHFLEET_TEST_ROUTEPLANE_FETCH_MODE === "fail") {
      throw new Error("injected RoutePlane fetch failure");
    }
    return new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
  };
}
`,
  );
  try {
    run(preload);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args: string[], preload?: string, fetchMode = "success") {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      ...(preload === undefined ? [] : ["--import", pathToFileURL(preload).href]),
      CLI,
      ...args,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        MESHFLEET_TEST_ROUTEPLANE_CATALOG_JSON: JSON.stringify(TEST_CATALOG),
        MESHFLEET_TEST_ROUTEPLANE_FETCH_MODE: fetchMode,
      },
    },
  );
}

test("RoutePlane catalog CLI emits one valid snapshot JSON document", () => {
  withFetchPreload((preload) => {
    const result = runCli(["--ttl-ms", "1234", "--timeout-ms", "50"], preload);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const snapshot = JSON.parse(result.stdout);
    assert.equal(result.stdout, `${JSON.stringify(snapshot)}\n`);
    assert.equal(snapshot.version, "meshfleet.routeplane-model-snapshot.v1");
    assert.equal(snapshot.source.endpoint, LOOPBACK_ENDPOINT);
    assert.equal(snapshot.source.expires_at_ms - snapshot.source.fetched_at_ms, 1234);
    assert.deepEqual(snapshot.models, [
      { id: "a-model", providers: ["beta"] },
      { id: "z-model", providers: ["alpha", "zeta"] },
    ]);
  });
});

test("RoutePlane catalog CLI rejects every argument outside its closed flag grammar", () => {
  for (const args of [
    ["--unknown"],
    ["unexpected"],
    ["--ttl-ms"],
    ["--ttl-ms", "0"],
    ["--timeout-ms", "nope"],
    ["--ttl-ms", "1", "--ttl-ms", "2"],
  ]) {
    const result = runCli(args);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
    assert.match(result.stderr, /only accepts --ttl-ms and --timeout-ms/i, args.join(" "));
  }
});

test("RoutePlane catalog CLI reports fetch failures without a partial stdout snapshot", () => {
  withFetchPreload((preload) => {
    const result = runCli([], preload, "fail");

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Unable to fetch RoutePlane catalog/i);
  });
});

test("package exposes the RoutePlane catalog library and executable", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  assert.equal(pkg.exports["./routeplane-catalog"], "./dist/routeplane-catalog.js");
  assert.equal(pkg.bin["meshfleet-routeplane-catalog"], "dist/bin/routeplane-catalog.js");
});
