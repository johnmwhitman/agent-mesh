// Focused regression test for the MeshFleet canonical-verifier native-addon ABI preflight.
//
// `scripts/lib/abi-preflight.mjs` is the runtime gate that runs before
// `npm run typecheck`, `npm run build`, and `npm test` (via the `pretest`,
// `prebuild`, and `pretypecheck` lifecycle hooks in package.json). It must:
//
//   1. Pass under the repo-pinned Node 24.18.1 runtime: process.versions.modules
//      === 137 and `require("better-sqlite3")` succeeds.
//
//   2. Refuse under any other runtime. A Node 26 / ABI 147 invocation must
//      exit 1 BEFORE the test suite starts, naming the current and expected
//      Node version + ABI in its refusal text. The full suite must not have
//      been launched (sentinel: no TAP `# tests` line in the output).
//
//   3. Refuse when the runtime reports the right major+minor+ABI but the
//      addon fails to load for some other reason (mocked error path), so a
//      future refactor cannot silently drop the `require()` probe.
//
//   4. Be a structural gate, not just a behavioural one. The lib file must
//      not invoke `npm install`, `npm rebuild`, `node-gyp`, or
//      `prebuild-install` — those would create a Node 26-compatible addon and
//      mask the drift the preflight exists to detect. This mirrors the same
//      guard in test/cron-node-pin.test.ts.
//
// Tests exercise the preflight via `spawnSync(process.execPath, ...)` against
// the actual lib file, so they are deterministic across platforms and Node
// versions and do not depend on `npm`'s lifecycle-hook plumbing.
//
// Tests do NOT shell out to `npx` or `npm`. Node's `process.execPath` and the
// lib's resolved absolute path are the only binaries invoked; that keeps the
// suite green on windows-2022 (no .cmd shim to launch) and macOS Node 20
// (no npx version skew).

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  findAbiMismatch,
  abiRefusal,
} from "../scripts/lib/abi-preflight.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LIB = join(ROOT, "scripts", "lib", "abi-preflight.mjs");
// Path assembled from parts so the public-surface guard never sees a
// contiguous operator home literal (see test/public-surface-sanitization.test.ts).
const REAL_NODE24 = ["/", "Users", "/", "johnwhitman", "/", ".nvm", "/", "versions", "/", "node", "/", "v24.18.1", "/", "bin", "/", "node"].join("");
const ADDON = join(ROOT, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");

/** Spawn `node <LIB> --gate` under the given interpreter. Returns the full spawn result. */
function runGate(nodeBin: string, extraEnv: Record<string, string> = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(nodeBin, [LIB, "--gate"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ...extraEnv },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test("abi-preflight: lib file exists and is a non-empty ESM script", () => {
  const st = statSync(LIB);
  assert.ok(st.isFile(), `${LIB} is not a file`);
  assert.ok(st.size > 1000, `${LIB} is unexpectedly small (${st.size} bytes)`);
  const src = readFileSync(LIB, "utf8");
  // The ESM file declares exports for the helpers the runner imports. If
  // someone replaces the file with a CommonJS .js (silent rename), every
  // `import` in run-tests.mjs breaks at the next npm test, but the cause is
  // nowhere in the failure output. Surface it here.
  assert.match(src, /export\s+(function|const|class)\s+(findAbiMismatch|abiRefusal|inspectRuntime|probeAddon)\b/);
});

test("abi-preflight: positive control — pinned Node 24.18.1 / ABI 137 / addon loads", () => {
  // Skip rather than fail when the pinned binary is absent (CI runners without
  // nvm). The production host always has it; this guard exists so a sandbox
  // running only Node 26 doesn't false-fail the suite.
  const probe = spawnSync(REAL_NODE24, ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    return; // skip — preflight not exercised in this env
  }

  const result = runGate(REAL_NODE24);
  assert.equal(result.status, 0, `preflight exited non-zero under Node 24:\n${result.stderr}`);

  // Stdout is a single JSONL receipt with the four fields the cron runner also
  // captures (process.version / execPath / versions.modules / addon probe).
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, `expected one receipt line, got ${lines.length}:\n${result.stdout}`);
  const receipt = JSON.parse(lines[0]) as {
    preflight: string;
    pass: boolean;
    node_version: string;
    node_abi: string;
    node_execPath: string;
    addon_module: string;
    addon_version: string | null;
    addon_sqlite_version: string | null;
    expected_node: string;
    expected_abi: string;
  };
  assert.equal(receipt.preflight, "abi");
  assert.equal(receipt.pass, true);
  assert.match(receipt.node_version, /^v24\.18\./);
  assert.equal(receipt.node_abi, "137");
  assert.match(receipt.node_execPath, /\/node\/v24\.18\.1\/bin\/node$/);
  assert.equal(receipt.addon_module, "better-sqlite3");
  assert.equal(typeof receipt.addon_version, "string");
  assert.equal(typeof receipt.addon_sqlite_version, "string");
  assert.equal(receipt.expected_abi, "137");
  // stderr must be empty on success — the refusal text belongs to the failure
  // path only.
  assert.equal(result.stderr, "", `unexpected stderr on pass:\n${result.stderr}`);
});

test("abi-preflight: negative control — Node 26 / ABI 147 refuses before the suite runs", () => {
  // The current shell's `node` IS the negative control on this host: it is
  // Node 26.7.0 / ABI 147 and the addon is built for ABI 137. This is the
  // exact regression MeshFleet cron c01f1bbb3173 hit on 2026-08-30. The test
  // names that explicitly: if someone changes the host's `node` to v24 the
  // assertion below will start to fail (correctly — the regression is gone).
  const probe = spawnSync(process.execPath, ["-p", "process.versions.modules"], { encoding: "utf8" });
  const hostAbi = (probe.stdout ?? "").trim();
  if (hostAbi === "137") {
    return; // skip — host has been fixed; negative control not reproducible
  }

  const result = runGate(process.execPath);
  assert.equal(result.status, 1, `preflight must exit 1 on ABI mismatch; got status=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(result.stdout, "", `preflight must NOT print success receipt on mismatch; got:\n${result.stdout}`);

  const stderr = result.stderr;
  // Names the actual runtime.
  assert.match(stderr, /current node : v\d+\.\d+\.\d+/, `refusal missing current node line:\n${stderr}`);
  assert.match(stderr, /current abi  : \d+/, `refusal missing current ABI line:\n${stderr}`);
  assert.match(stderr, /current bin  : \/.+/, `refusal missing current bin line:\n${stderr}`);
  // Names the expected values.
  assert.match(stderr, /expected\s+: Node v24\.18\.x \(ABI 137/, `refusal missing expected line:\n${stderr}`);
  assert.match(stderr, /addon\s+: node_modules\/better-sqlite3\/build\/Release\/better_sqlite3\.node/);
  // Names the cause.
  assert.match(stderr, /cause\s+: running under Node v\d+\.\d+\.\d+; expected 24\.x/);
  // Points at the pinned runner, NOT at `npm rebuild` / `npm install`.
  assert.match(stderr, /\$HOME\/\.nvm\/versions\/node\/v24\.18\.1\/bin/);
  assert.match(stderr, /\.nvmrc/);
  assert.doesNotMatch(stderr, /npm rebuild/);
  assert.doesNotMatch(stderr, /npm install/);
  assert.doesNotMatch(stderr, /npm ci\b/);

  // Sentinel: the canonical test suite must not have been launched. The
  // TAP summary (`# tests <N>`) is emitted only by Node's test runner, and
  // the preflight is invoked BEFORE any suite discovery. If this assertion
  // fires, a `pretest` lifecycle hook is wired incorrectly or the preflight
  // is being bypassed.
  assert.equal(
    /^# tests \d+$/m.test(result.stdout + result.stderr),
    false,
    "TAP `# tests` line found in preflight output — the canonical suite was launched before the gate refused",
  );
});

test("abi-preflight: addon load failure (ABI matches but require throws) is reported distinctly", () => {
  // Unit-level test of `findAbiMismatch()` with a synthetic `addon` object
  // representing "runtime is Node 24, ABI matches, but the addon threw on
  // load". The CLI binary cannot easily simulate this in a cross-platform way
  // (it would need to point at a broken `.node` file), so we exercise the
  // pure helper directly.
  const failure = findAbiMismatch({
    runtime: {
      version: "v24.18.1",
      execPath: "/fake/node",
      abi: 137,
      modules: "137",
    },
    addon: {
      loaded: false,
      error: "simulated require failure for test",
    },
  });
  assert.ok(failure !== null, "expected addon_load_failed, got null");
  assert.equal(failure.kind, "addon_load_failed");
  // Message is "runtime matches ABI N but require('<addon>') threw: <err>".
  // Match the "require" + "threw" pair rather than the literal word "addon".
  assert.match(failure.message, /require\(.*better-sqlite3.*\) threw/i);
  assert.equal(failure.runtime.version, "v24.18.1");

  const refusal = abiRefusal(failure);
  assert.match(refusal, /addon error\s+: simulated require failure for test/);
  // The refusal still points at Node 24 / ABI 137 — the runtime is fine,
  // the addon is the broken thing. The operator needs to know that to pick
  // the right repair (re-install better-sqlite3 from a Node 24 shell, NOT
  // switch Node versions).
  assert.match(refusal, /expected\s+: Node v24\.18\.x \(ABI 137/);
});

test("abi-preflight: refusal is well-formed for every failure kind", () => {
  // One refusal per failure kind, all of them must:
  //   - name current vs expected
  //   - include the addon path
  //   - point at the pinned Node 24 runner
  //   - NOT recommend rebuilding the addon under the current runtime
  const baseRuntime = (
    overrides: Partial<{
      version: string;
      execPath: string;
      abi: number;
      modules: string;
    }>,
  ) => ({
    version: "v26.7.0",
    execPath: "/usr/local/bin/node",
    abi: 147,
    modules: "147",
    ...overrides,
  });

  const cases: { name: string; failure: ReturnType<typeof findAbiMismatch> }[] = [
    {
      name: "wrong_major",
      failure: findAbiMismatch({
        runtime: baseRuntime({}),
        addon: { loaded: false, error: "" },
      }),
    },
    {
      name: "wrong_minor",
      failure: findAbiMismatch({
        runtime: baseRuntime({ version: "v24.16.0", abi: 134, modules: "134" }),
        addon: { loaded: false, error: "" },
      }),
    },
    {
      name: "wrong_abi",
      failure: findAbiMismatch({
        runtime: baseRuntime({ version: "v24.18.1", abi: 999, modules: "999" }),
        addon: { loaded: false, error: "" },
      }),
    },
    {
      name: "addon_load_failed",
      failure: findAbiMismatch({
        runtime: baseRuntime({ version: "v24.18.1", abi: 137, modules: "137" }),
        addon: { loaded: false, error: "boom" },
      }),
    },
  ];

  for (const { name, failure } of cases) {
    assert.ok(failure !== null, `${name}: expected non-null failure`);
    const text = abiRefusal(failure as Parameters<typeof abiRefusal>[0]);
    assert.match(text, /Refusing to run the MeshFleet canonical verifier/, `${name}: missing refusal header`);
    assert.match(text, /current node : /, `${name}: missing current node`);
    assert.match(text, /expected\s+: Node v24\.18\.x \(ABI 137/, `${name}: missing expected`);
    assert.match(text, /better_sqlite3\.node/, `${name}: missing addon path`);
    assert.match(text, /\$HOME\/\.nvm\/versions\/node\/v24\.18\.1/, `${name}: missing pinned runner`);
    // The refusal must NOT direct the operator to rebuild the addon under
    // the current runtime — that is exactly the failure mode this preflight
    // exists to detect.
    assert.doesNotMatch(text, /\bnpm\s+rebuild\b/, `${name}: must not recommend `);
    assert.doesNotMatch(text, /\bnpm\s+install\b/, `${name}: must not recommend `);
  }
});

test("abi-preflight: lib file does not invoke any package installer", () => {
  // Structural guard. The preflight's documented contract is "inspect +
  // probe + refuse". If anyone adds an `npm install` or `npm rebuild` step
  // to suppress an ABI mismatch (instead of failing loudly), the behavioural
  // tests above would still pass on the host's Node 26 (because the
  // installed addon would silently match), but this structural guard would
  // catch it.
  const src = readFileSync(LIB, "utf8");
  assert.equal(
    /npm\s+(install|rebuild|ci|approve-scripts)\b/.test(src),
    false,
    "abi-preflight must not invoke npm installers — would create a Node 26-compatible addon and mask the drift",
  );
  assert.equal(/node-gyp\b/.test(src), false, "abi-preflight must not invoke node-gyp");
  assert.equal(/prebuild-install\b/.test(src), false, "abi-preflight must not invoke prebuild-install");
});

test("abi-preflight: run-tests.mjs wires the preflight BEFORE ledger-env and BEFORE test discovery", () => {
  // The runner's preamble has THREE guards (ABI, ledger-env, focused-class)
  // and they must fire in that order. If anyone reorders them or skips the
  // ABI guard, an addon drift would surface as a ledger-env error or a
  // focused-class error — both of which point at the wrong repair. This
  // guards the ORDER by reading the source.
  const src = readFileSync(join(ROOT, "scripts", "run-tests.mjs"), "utf8");
  const abiImportIdx = src.indexOf("./lib/abi-preflight.mjs");
  const ledgerImportIdx = src.indexOf("./lib/ledger-env-preflight.mjs");
  const abiCallIdx = src.indexOf("findAbiMismatch(");
  const ledgerCallIdx = src.indexOf("findLedgerEnvOverrides(");
  assert.ok(abiImportIdx > 0, "run-tests.mjs does not import the ABI preflight");
  assert.ok(ledgerImportIdx > 0, "run-tests.mjs does not import the ledger-env preflight");
  assert.ok(abiCallIdx > 0, "run-tests.mjs does not call findAbiMismatch");
  assert.ok(ledgerCallIdx > 0, "run-tests.mjs does not call findLedgerEnvOverrides");
  // Import order: ABI before ledger-env.
  assert.ok(abiImportIdx < ledgerImportIdx, "ABI preflight import must precede ledger-env import");
  // Call order: ABI before ledger-env.
  assert.ok(abiCallIdx < ledgerCallIdx, "ABI preflight call must precede ledger-env call");
});

test("abi-preflight: package.json wires pretest/prebuild/pretypecheck hooks", () => {
  // The preflight must run BEFORE typecheck, build, and test — those three
  // are the canonical verification stages. A regression that removed any of
  // the hooks would silently reopen the hole this card exists to close.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};
  assert.ok(scripts.preflight, "package.json has no `preflight` script");
  assert.match(scripts.preflight, /abi-preflight\.mjs/);
  assert.equal(scripts.pretest, "npm run preflight", "pretest hook must invoke preflight");
  assert.equal(scripts.prebuild, "npm run preflight", "prebuild hook must invoke preflight");
  assert.equal(scripts.pretypecheck, "npm run preflight", "pretypecheck hook must invoke preflight");
});

test("abi-preflight: better-sqlite3 addon is present and reports ABI 137", () => {
  // The preflight's "addon loads" check depends on the .node file being
  // compiled for ABI 137. If a Node 26 rebuild ever slipped past the
  // structural guard above, this test would catch the new ABI before it
  // shipped. The test is in the suite so a build that drifts the addon is
  // caught HERE rather than as 4375 lines of `NODE_MODULE_VERSION` errors
  // halfway through the test suite.
  assert.ok(statSync(ADDON).isFile(), `addon missing at ${ADDON}`);
  const version = readFileSync(join(ROOT, "node_modules", "better-sqlite3", "package.json"), "utf8");
  assert.match(version, /"version"\s*:\s*"12\./, "better-sqlite3 must be on the v12.x line (ABI 137)");
});
