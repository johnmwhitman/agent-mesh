// Native-addon ABI preflight for the canonical MeshFleet verification path.
//
// The MeshFleet canonical verifier (`npm run typecheck` / `npm run build` /
// `npm test`) executes against the SQLite ledger via `better-sqlite3`, whose
// prebuilt native addon is compiled for a SPECIFIC Node `NODE_MODULE_VERSION`
// (ABI). The installed addon in this repo is built against ABI 137, which is
// the `NODE_MODULE_VERSION` Node 24 reports. When the ambient `node` resolves
// to a different runtime (e.g. Node 26 reports ABI 147), `require("better-sqlite3")`
// throws with the message:
//
//   The module '.../better_sqlite3.node' was compiled against a different Node.js
//   version using NODE_MODULE_VERSION 137. This version of Node.js requires
//   NODE_MODULE_VERSION 147. Please try re-compiling or re-installing ...
//
// The suite then explodes partway through — every test that touches the ledger
// fails with the same opaque mismatch and the operator is invited to "fix" a
// passing test file. The cost of that diagnosis is real and was paid once on
// cron c01f1bbb3173.
//
// This preflight is the cheap detector: report the runtime, verify the ABI
// matches the addon, and refuse to launch the suite if either drifts. It is
// the third gate (after the ledger-env preflight and the focused-class
// allowlist check) that the runner enforces before any test discovery.
//
// Constants — keep these aligned with .nvmrc and the addon in node_modules.
// `EXPECTED_ABI` is the NODE_MODULE_VERSION reported by `process.versions.modules`
// for the Node 24 line. `EXPECTED_NODE_MAJOR` is the major version accepted;
// `EXPECTED_NODE_MINOR` is the floor. Patch versions (24.18.0, 24.18.1, 24.18.x)
// are interchangeable so long as `process.versions.modules === EXPECTED_ABI`.
export const EXPECTED_NODE_MAJOR = 24;
export const EXPECTED_NODE_MINOR = 18;
export const EXPECTED_ABI = 137;
export const EXPECTED_ABI_SOURCE = "Node 24.x (per agent-mesh/.nvmrc → 24.18.1)";

// Addon module name. Centralised so the probe and the refusal text agree.
export const ADDON_MODULE = "better-sqlite3";

// The preflight is imported from an ESM script (`scripts/run-tests.mjs` is
// `"type": "module"` per package.json), but the addon is a CommonJS N-API
// module. Use `createRequire` from `node:module` so the probe works the same
// way it does in the rest of the agent-mesh runtime (which loads the addon via
// CommonJS `require` — see src/db.ts and the `import Database from
// "better-sqlite3"` TypeScript emit).
import { createRequire } from "node:module";
const localRequire = createRequire(import.meta.url);
const path = localRequire("node:path");

/**
 * Inspect the current process's runtime.
 *
 * Returns the four fields the cron runner also captures in its JSONL receipt
 * (see profiles/meshfleet/scripts/fleet_gate.sh) — same names, same order so
 * the two receipts can be diffed directly. A missing field is reported as
 * `null` rather than throwing; the runner that consumes this map decides
 * whether a missing ABI is itself a refusal.
 */
export function inspectRuntime() {
  return {
    version: typeof process.version === "string" ? process.version : null,
    execPath: typeof process.execPath === "string" ? process.execPath : null,
    abi:
      process.versions && typeof process.versions.modules === "number"
        ? process.versions.modules
        : process.versions && typeof process.versions.modules === "string"
          ? Number(process.versions.modules)
          : null,
    modules:
      process.versions && typeof process.versions.modules !== "undefined"
        ? String(process.versions.modules)
        : null,
  };
}

/**
 * Parse a `process.version` string of the form "vMAJOR.MINOR.PATCH[-suffix]"
 * into its parts. Returns `null` for anything that does not look like a
 * `v` + digits + dot + digits + dot + digits string — including the empty
 * string, which `process.version` should never be, but the runner refuses on
 * regardless.
 */
export function parseNodeVersion(version) {
  if (typeof version !== "string") return null;
  const m = /^v(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(version);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    raw: version,
  };
}

/**
 * Probe `better-sqlite3` by requiring it and opening an in-memory database,
 * running a trivial `SELECT 1`. This is the exact failure surface of the
 * original regression: `require()` throws on a NODE_MODULE_VERSION mismatch;
 * the runtime never reaches the SQL statement.
 *
 * The probe is read-only against an in-memory connection and is closed
 * immediately. It must not invoke any package installer or compile the addon
 * against the current runtime — doing so would silently create a Node 26
 * addon and mask the very mismatch this preflight exists to detect. The
 * `lib_file_does_not_invoke_any_package_installer` test in
 * `test/abi-preflight.test.ts` is the structural guard.
 *
 * Returns `{ loaded: true, version, sqliteVersion }` on success, or
 * `{ loaded: false, error }` where `error` is a string safe to print.
 */
export function probeAddon(moduleName = ADDON_MODULE) {
  try {
    // `require` rather than dynamic `import` because the addon's native binding
    // is a CommonJS N-API module that does not support ESM loader resolution on
    // every Node line; `require()` is the lowest-common-denominator loader and
    // is what the rest of the agent-mesh runtime uses (see src/db.ts).
    const mod = localRequire(moduleName);
    if (typeof mod !== "function" && (!mod || typeof mod.Database !== "function")) {
      return { loaded: false, error: `module ${moduleName} did not export a Database constructor` };
    }
    const Database = typeof mod === "function" ? mod : mod.Database;
    const db = new Database(":memory:");
    const sqliteVersion =
      typeof db.prepare === "function" ? db.prepare("select sqlite_version() as v").get()?.v : null;
    db.close();
    // best-effort: expose the package version if Node exposes it.
    let pkgVersion = null;
    try {
      // The addon module itself is in node_modules/<name>/build/Release/<name>.node;
      // require.resolve from there returns the .node file path, not the package
      // root. Walk up to package.json instead.
      const addonPath = localRequire.resolve(moduleName);
      // addonPath ends with `<name>/build/Release/<name>.node`. We need the
      // package root (one level above `build`). Use `path.dirname` repeatedly.
      let pkgDir = path.dirname(addonPath);
      // walk up until the directory contains package.json, or we run out.
      for (let depth = 0; depth < 6 && pkgDir && pkgDir !== path.dirname(pkgDir); depth += 1) {
        const candidate = path.join(pkgDir, "package.json");
        try {
          const pkg = localRequire(candidate);
          pkgVersion = pkg.version;
          break;
        } catch {
          pkgDir = path.dirname(pkgDir);
        }
      }
    } catch {
      pkgVersion = null;
    }
    return { loaded: true, version: pkgVersion, sqliteVersion };
  } catch (err) {
    return {
      loaded: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Compare the inspected runtime with the expected ABI.
 *
 * Returns `null` when the runtime is acceptable (Node 24.x with ABI 137) AND
 * the addon loads cleanly. Otherwise returns a structured failure record with
 * one of:
 *   - `kind: "no_runtime"` — process.version / abi were not strings/numbers
 *     that could be inspected. This is a programmer error, not a node-version
 *     drift, but the runner refuses the same way for both because neither is
 *     a state the suite can safely execute in.
 *   - `kind: "wrong_major"` — Node major differs from 24.
 *   - `kind: "wrong_minor"` — Node is on 24 but the minor is below 18 (the
 *     floor under which the addon is verified). Reported distinctly so the
 *     operator sees whether to bump up or to bump down.
 *   - `kind: "wrong_abi"` — Node 24.x major+minor check passed, but
 *     `process.versions.modules` is not 137. The addon's `require()` will
 *     explode. This is the original regression: same major+minor patch,
 *     rebuild under a different ABI.
 *   - `kind: "addon_load_failed"` — runtime checks passed, but `require()` of
 *     `better-sqlite3` threw. The message is preserved verbatim so the
 *     operator can grep it.
 *
 * The runner that calls this function is responsible for printing the
 * refusal via `abiRefusal(...)` and exiting; this function does not print
 * anything and does not exit.
 */
export function findAbiMismatch(opts = {}) {
  const runtime = opts.runtime ?? inspectRuntime();
  const addon = opts.addon ?? probeAddon(opts.moduleName ?? ADDON_MODULE);

  if (runtime.version === null || runtime.abi === null) {
    return {
      kind: "no_runtime",
      runtime,
      addon,
      message: "process.version / process.versions.modules were not inspectable",
    };
  }

  const parsed = parseNodeVersion(runtime.version);
  if (parsed === null) {
    return {
      kind: "no_runtime",
      runtime,
      addon,
      message: `process.version '${runtime.version}' is not a parseable vMAJOR.MINOR.PATCH string`,
    };
  }

  if (parsed.major !== EXPECTED_NODE_MAJOR) {
    return {
      kind: "wrong_major",
      runtime,
      parsed,
      addon,
      message: `running under Node ${runtime.version}; expected ${EXPECTED_NODE_MAJOR}.x`,
    };
  }

  if (parsed.minor < EXPECTED_NODE_MINOR) {
    return {
      kind: "wrong_minor",
      runtime,
      parsed,
      addon,
      message: `running under Node ${runtime.version}; expected >= ${EXPECTED_NODE_MAJOR}.${EXPECTED_NODE_MINOR}`,
    };
  }

  if (runtime.abi !== EXPECTED_ABI) {
    return {
      kind: "wrong_abi",
      runtime,
      parsed,
      addon,
      message:
        `running under Node ${runtime.version} (ABI ${runtime.abi}); ` +
        `addon at node_modules/${ADDON_MODULE}/build/Release/ is built for ABI ${EXPECTED_ABI}`,
    };
  }

  if (!addon.loaded) {
    return {
      kind: "addon_load_failed",
      runtime,
      parsed,
      addon,
      message: `runtime matches ABI ${EXPECTED_ABI} but require('${ADDON_MODULE}') threw: ${addon.error}`,
    };
  }

  return null;
}

/**
 * The refusal text. Concise, actionable, names the current and expected values,
 * and points at the pinned Node 24 runner — NOT at rebuilding the addon under
 * the current runtime. A preflight that recommends a rebuild is the failure
 * mode this preflight exists to prevent: an addon rebuilt under Node 26 would
 * mask the drift until the next runtime swap, and "drift" would no longer be
 * detectable.
 *
 * This string is what the operator reads on a regression. It is deliberately
 * terse: the cron wrapper has a longer narrative for cron-only operators; the
 * canonical verifier is a developer tool and the developer needs the four
 * facts plus one command.
 */
export function abiRefusal(failure) {
  const r = failure.runtime;
  const expectedVersion = `v${EXPECTED_NODE_MAJOR}.${EXPECTED_NODE_MINOR}.x`;
  const lines = [
    "",
    "Refusing to run the MeshFleet canonical verifier: native-addon ABI mismatch.",
    "",
    `  current node : ${r.version ?? "(unknown)"}`,
    `  current abi  : ${r.modules ?? "(unknown)"}`,
    `  current bin  : ${r.execPath ?? "(unknown)"}`,
    `  expected     : Node ${expectedVersion} (ABI ${EXPECTED_ABI}, ${EXPECTED_ABI_SOURCE})`,
    `  addon        : node_modules/${ADDON_MODULE}/build/Release/${ADDON_MODULE.replace(/-/g, "_")}.node`,
    "",
    `  cause        : ${failure.message}`,
  ];

  if (failure.kind === "addon_load_failed" && failure.addon && failure.addon.error) {
    lines.push(`  addon error  : ${failure.addon.error.split("\n")[0]}`);
  }

  lines.push(
    "",
    "Use the repo-pinned Node 24 runner. Do NOT recompile the addon under the current",
    "runtime — that would mask the drift and is the failure mode this preflight exists",
    "to detect. The canonical commands are:",
    "",
    "  POSIX:",
    `    export PATH="$HOME/.nvm/versions/node/v${EXPECTED_NODE_MAJOR}.18.1/bin:$PATH"`,
    "    node --version   # expect v24.18.x",
    "    npm test",
    "",
    "  PowerShell:",
    `    $env:Path = "$HOME/.nvm/versions/node/v${EXPECTED_NODE_MAJOR}.18.1/bin;$env:Path"`,
    "    node --version   # expect v24.18.x",
    "    npm test",
    "",
    "The .nvmrc in the repo root declares v24.18.1. The MeshFleet cron runner pins the",
    "same binary via profiles/meshfleet/scripts/fleet_gate.sh.",
    "",
  );

  return lines.join("\n");
}

/**
 * One-line success receipt. Print this on stdout when the preflight passes; the
 * `npm run preflight` lifecycle hook uses the absence of this line as the
 * "everything is fine" signal (the refusal text above is what the operator
 * reads on a regression).
 *
 * The receipt is deliberately a single line so the cron-tier JSONL logs and the
 * canonical-tier lifecycle logs share the same shape (see
 * profiles/meshfleet/scripts/node-pin.log for the cron side).
 */
export function abiSuccessReceipt(runtime, addon) {
  return JSON.stringify({
    preflight: "abi",
    pass: true,
    node_version: runtime.version,
    node_abi: runtime.modules,
    node_execPath: runtime.execPath,
    addon_module: ADDON_MODULE,
    addon_version: addon.version ?? null,
    addon_sqlite_version: addon.sqliteVersion ?? null,
    expected_node: `v${EXPECTED_NODE_MAJOR}.${EXPECTED_NODE_MINOR}.x`,
    expected_abi: String(EXPECTED_ABI),
  });
}

/**
 * Standalone CLI entry point. The `npm run preflight` lifecycle hook runs this
 * file directly (`node scripts/lib/abi-preflight.mjs --gate`); it must succeed
 * or fail on its own without depending on `scripts/run-tests.mjs` being
 * imported.
 *
 * Flags:
 *   --gate   Exit 1 on mismatch, 0 on pass. Default behaviour when invoked as
 *            a lifecycle hook.
 *
 * The check is intentionally deterministic: no network, no install, no env
 * mutation. Both stdout (success receipt) and stderr (refusal) are plain text.
 */
export function main(argv) {
  const args = Array.isArray(argv) ? argv : [];
  if (!args.includes("--gate")) {
    process.stderr.write(
      `abi-preflight: usage: node scripts/lib/abi-preflight.mjs --gate\n` +
        `(this script is the canonical verifier's runtime gate; import the helpers\n` +
        `from "./lib/abi-preflight.mjs" instead of exec'ing it directly.)\n`,
    );
    process.exit(2);
  }

  const failure = findAbiMismatch();
  if (failure !== null) {
    process.stderr.write(abiRefusal(failure));
    process.exit(1);
  }

  const runtime = inspectRuntime();
  const addon = probeAddon();
  process.stdout.write(abiSuccessReceipt(runtime, addon) + "\n");
  process.exit(0);
}

// `import.meta.url` resolves to `file://...` under ESM; Node sets
// `process.argv[1]` to the entry-point file. Detect direct invocation by
// comparing the entry script path to the URL-derived path.
const isCli =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  import.meta.url === new URL("file://" + process.argv[1]).href;

if (isCli) {
  main(process.argv.slice(2));
}
