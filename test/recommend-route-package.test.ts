import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as publicRouteApi from "../src/recommend-route.js";
import {
  assertRecommendRouteTask,
  assertRouteCandidates,
  recommendRoute,
  type RecommendRouteCandidate,
  type RecommendRouteInput,
  type RecommendRouteResult,
  type RouteCandidateValidationOptions,
  type RouteCoordination,
  type RouteLocality,
  type RoutePrivacy,
  type RecommendRouteTask,
} from "../src/recommend-route.js";
import { assertRouteCandidates as assertCanonicalRouteCandidates } from "../src/route-candidate-validation.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IS_WINDOWS = process.platform === "win32";
const NPM = IS_WINDOWS ? "npm.cmd" : "npm";

const task: RecommendRouteTask = {
  required_capabilities: ["code"],
  privacy: "network_ok" as RoutePrivacy,
  locality: "same_fleet" as RouteLocality,
  coordination: "solo" as RouteCoordination,
};

const candidate: RecommendRouteCandidate = {
  candidate_id: "local-code",
  capabilities: ["code"],
  privacy: "local_only",
  locality: "same_host",
  coordination_modes: ["solo"],
  budget: { measured: false },
};

test("recommend-route package exposes only the pure evaluator, validators, and public types", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    exports: Record<string, string>;
  };
  assert.equal(pkg.exports["./recommend-route"], "./dist/recommend-route.js");
  assert.deepEqual(Object.keys(publicRouteApi).sort(), [
    "assertRecommendRouteTask",
    "assertRouteCandidates",
    "recommendRoute",
  ]);
  assert.doesNotMatch(
    readFileSync(join(ROOT, "src", "index.ts"), "utf8"),
    /export\s*\{[^}]*\b(?:recommendRoute|assertRecommendRouteTask|assertRouteCandidates)\b/,
    "the MCP root entrypoint must not become a package-library re-export",
  );

  const options: RouteCandidateValidationOptions = {
    errorPrefix: "public_route",
    path: "candidates",
  };
  assert.doesNotThrow(() => assertRecommendRouteTask(task));
  assert.doesNotThrow(() => assertRouteCandidates([candidate], options));

  const input: RecommendRouteInput = { task, candidates: [candidate] };
  const before = JSON.stringify(input);
  const result: RecommendRouteResult = recommendRoute(input);
  assert.equal(JSON.stringify(input), before, "advisory evaluation must not mutate caller evidence");
  assert.equal(result.advisory, true);
  assert.deepEqual(result.effects, {
    persisted: false,
    executed: false,
    authorized: false,
    woke_agents: false,
    contacted_providers: false,
  });
  assert.deepEqual(result.ranked.map(({ candidate_id }) => candidate_id), ["local-code"]);
});

test("recommend-route package validator preserves canonical rejection behavior", () => {
  const malformed = [{ ...candidate, provider: "forbidden" }];
  const options: RouteCandidateValidationOptions = {
    errorPrefix: "public_route",
    path: "candidates",
  };
  const rejection = (validate: (value: unknown, options: RouteCandidateValidationOptions) => void): string => {
    try {
      validate(malformed, options);
      assert.fail("expected validator rejection");
    } catch (error) {
      return (error as Error).message;
    }
  };

  assert.equal(
    rejection(assertRouteCandidates),
    rejection(assertCanonicalRouteCandidates),
  );
  assert.throws(
    () => recommendRoute({ task, candidates: malformed as RecommendRouteCandidate[] }),
    /recommend_route: 'candidates\[0\]\.provider' is not allowed/,
  );
});

test("packed recommend-route consumer imports, evaluates, and rejects without MCP changes", {
  timeout: 30_000,
}, () => {
  const temp = mkdtempSync(join(tmpdir(), "meshfleet-recommend-route-consumer-"));
  try {
    const build = spawnSync(NPM, ["run", "build"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, npm_config_update_notifier: "false" },
      shell: IS_WINDOWS,
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);

    const pack = spawnSync(NPM, ["pack", "--json", "--pack-destination", temp], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, npm_config_update_notifier: "false" },
      shell: IS_WINDOWS,
    });
    assert.equal(pack.status, 0, pack.stderr || pack.stdout);
    const packed = JSON.parse(pack.stdout) as Array<{ filename: string }>;
    assert.equal(packed.length, 1);
    const tarball = join(temp, packed[0]!.filename);
    assert.equal(existsSync(tarball), true);

    const consumer = join(temp, "consumer");
    mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), '{"name":"offline-consumer","private":true}\n');
    const install = spawnSync(
      NPM,
      [
        "install",
        "--prefer-offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--no-save",
        tarball,
      ],
      {
        cwd: consumer,
        encoding: "utf8",
        env: { ...process.env, npm_config_update_notifier: "false" },
        shell: IS_WINDOWS,
      },
    );
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const consumerCheck = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import("meshfleet/recommend-route").then((api) => {
          const input = {
            task: { required_capabilities: ["code"], privacy: "network_ok", locality: "same_fleet" },
            candidates: [{ candidate_id: "local-code", capabilities: ["code"], privacy: "local_only", locality: "same_host", budget: { measured: false } }]
          };
          const before = JSON.stringify(input);
          const result = api.recommendRoute(input);
          if (JSON.stringify(input) !== before || result.advisory !== true || Object.values(result.effects).some(Boolean) || result.ranked[0]?.candidate_id !== "local-code" || JSON.stringify(Object.keys(api).sort()) !== JSON.stringify(["assertRecommendRouteTask", "assertRouteCandidates", "recommendRoute"])) process.exit(1);
          try { api.assertRouteCandidates([{ ...input.candidates[0], provider: "forbidden" }], { errorPrefix: "consumer", path: "candidates" }); process.exit(1); }
          catch (error) { if (!(error instanceof Error) || error.message !== "consumer: 'candidates[0].provider' is not allowed") process.exit(1); }
        })`,
      ],
      { cwd: consumer, encoding: "utf8", env: {} },
    );
    assert.equal(consumerCheck.status, 0, consumerCheck.stderr);
    assert.equal(consumerCheck.stdout, "");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
