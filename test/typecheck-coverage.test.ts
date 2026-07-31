/**
 * The verifier's first stage is named "typecheck". It did not typecheck `scripts/`.
 *
 * `tsconfig.json` is the BUILD config: `include` is `src/**\/*` and `rootDir` is `./src`. The
 * typecheck stage pointed at that same config, so every `.ts` file outside `src/` was invisible
 * to it — and tests run under `tsx`, which strips types without checking them. Measured on
 * 039f5d2: a blatant `const q: number = "definitely not a number"` appended to
 * `scripts/generate-corpus.ts` left `tsc --noEmit` at exit 0 reporting zero errors, and
 * `--listFiles` showed tsc never loaded the file at all. The same planted error in a test file
 * was equally invisible to BOTH stages.
 *
 * That matters here more than it would elsewhere, because this repo's guards increasingly live
 * in `scripts/`: the test runner itself, the corpus generator, the ledger-env preflight. A stage
 * named "typecheck" implied it had checked them.
 *
 * These tests pin COVERAGE, not config prose — the failure mode is someone narrowing `include`
 * back to `src` and silently reopening the hole, which a config-shape assertion would miss the
 * moment it was worded differently. `--listFiles` is what tsc actually loaded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = join(__dirname, "..");
const CHECK_CONFIG = "tsconfig.check.json";

function tscListFiles(): string[] {
  // Run the compiler under THIS interpreter rather than shelling out to `npx`.
  //
  // `spawnSync("npx", …)` failed on four CI legs and passed on the other five, by two DIFFERENT
  // mechanisms — which is why fixing only the obvious one would have left a leg red:
  //   · windows-2022, all three Node versions: `npx` is `npx.cmd`, a batch script. spawnSync goes
  //     straight to CreateProcess, which cannot launch a .cmd, so the spawn dies before tsc runs.
  //     `shell: true` fixes that one and re-introduces shell quoting on every argument.
  //   · macOS Node 20: there is no .cmd on macOS, so the shell theory cannot explain it. Node 20
  //     ships npm 9, whose `npx` resolves a local binary differently from npm 10.8+ on Node 22/24.
  //
  // Both vanish when nothing has to RESOLVE anything: require.resolve locates the compiler through
  // ordinary module resolution, and process.execPath is the interpreter already running. No PATH
  // lookup, no shell, no .cmd, no npm version anywhere in the path. This is the same shape
  // run-tests-ledger-env-preflight.test.ts uses, and that file is green on all nine legs.
  const result = spawnSync(
    process.execPath,
    [require.resolve("typescript/bin/tsc"), "-p", CHECK_CONFIG, "--listFiles", "--noEmit"],
    { cwd: ROOT, encoding: "utf8", timeout: 120_000 },
  );
  assert.notEqual(result.status, null, `tsc did not run: ${result.error?.message ?? "timeout"}`);
  return `${result.stdout}`.split("\n").map((l) => l.trim()).filter(Boolean);
}

test("the typecheck stage actually loads scripts/ — the directory it used to skip", () => {
  const loaded = tscListFiles().filter((f) => !f.includes("node_modules"));

  const scripts = loaded.filter((f) => f.startsWith(join(ROOT, "scripts")));
  assert.ok(
    scripts.some((f) => f.endsWith("generate-corpus.ts")),
    `tsc never loaded scripts/generate-corpus.ts. Loaded ${scripts.length} file(s) under scripts/. ` +
      `The typecheck stage is not checking scripts/ — restore "scripts/**/*" in ${CHECK_CONFIG}.`,
  );

  // src/ must not have been traded away for scripts/.
  assert.ok(
    loaded.some((f) => f.startsWith(join(ROOT, "src"))),
    `tsc loaded no files under src/. ${CHECK_CONFIG} must cover src/ as well as scripts/.`,
  );
});

test("npm run typecheck uses the wider config, not the build config", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const typecheck = pkg.scripts?.typecheck;
  assert.ok(typecheck, "package.json has no typecheck script");
  assert.ok(
    typecheck.includes(CHECK_CONFIG),
    `npm run typecheck is "${typecheck}", which does not use ${CHECK_CONFIG}. ` +
      `Pointing it back at tsconfig.json silently stops checking scripts/.`,
  );
});

test("the typecheck config cannot change what npm run build emits", () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, CHECK_CONFIG), "utf8")) as {
    compilerOptions?: { noEmit?: boolean };
  };
  assert.equal(
    cfg.compilerOptions?.noEmit,
    true,
    `${CHECK_CONFIG} must be noEmit. It widens rootDir past ./src, so if it ever emitted it ` +
      `would change the published tarball's layout.`,
  );

  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.ok(
    !(pkg.scripts?.build ?? "").includes(CHECK_CONFIG),
    `npm run build must keep using tsconfig.json; building with ${CHECK_CONFIG} would change ` +
      `what ships.`,
  );
});
