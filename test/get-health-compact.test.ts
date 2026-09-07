/**
 * get_health — backward-compatible default + opt-in summary verbosity + dedicated
 * get_build_identity diagnostic.
 *
 * Acceptance for the rally's single efficiency deliverable:
 *
 *   1. BACKWARD COMPATIBILITY — the default `get_health` (no `verbosity` arg)
 *      MUST return the same shape as the prior version: the per-entrypoint
 *      `build_identity.entrypoints` map IS populated. Internal callers and
 *      external integrators that read `entrypoints` inline keep working
 *      without any change. The entrypoint count belongs to the runtime
 *      manifest; the public API description does NOT hardcode it.
 *
 *   2. OPT-IN SUMMARY — callers that pass `verbosity: "summary"` get a
 *      smaller payload where `build_identity.entrypoints` is omitted, while
 *      every other `build_identity` field is preserved verbatim
 *      (`entrypoint_count`, `entrypoints_match_runtime`, `manifest_path`,
 *      `status`, `source_commit`, `package_*`). Use this from routine
 *      first-use / consumer probes where the inline hash table is unneeded.
 *
 *   3. SERVER-SIDE INTEGRITY IS UNCHANGED — `readBuildIdentity()` still
 *      re-hashes every listed `dist/` file on every call, regardless of the
 *      caller's verbosity choice. `entrypoints_match_runtime` and `status`
 *      surface the same way they did before.
 *
 *   4. DEDICATED DIAGNOSTIC — `get_build_identity` is a dedicated MCP tool
 *      that returns the full BuildIdentityReport including the entrypoints
 *      map. Same data as `get_health()` with no verbosity arg, exposed under
 *      a distinct name so operators / CI / drift checks can call it without
 *      remembering the verbosity enum.
 *
 *   5. UNKNOWN VERBOSITY IS REJECTED — a misspelled verbosity that silently
 *      fell back to "full" would still cross the wire with a payload the
 *      caller did not ask for. The handler surfaces an error naming the
 *      field and the bad value.
 *
 * These tests run against the COMPILED dist/ via subprocess (the same
 * pattern as test/build-manifest.test.ts), not via tsx — so we exercise
 * the production shape. src/ via tsx returns `status: 'absent'` because
 * there is no manifest next to the .ts source, which is not the shape we
 * are validating.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, copyFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");

interface SubprocessCall {
  readonly cwd: string;
  readonly sourceModule: string;
}

interface CallOpts {
  /** MCP-style: when true, run via the actual index.js handler. */
  viaHandler?: boolean;
  verbosity?: string;
}

/** Spawn a subprocess that imports from a copy of dist/ and returns the parsed JSON. */
function callHealth(c: SubprocessCall, opts: CallOpts = {}): unknown {
  let source: string;
  if (opts.viaHandler) {
    // Drive the real MCP handler with a JSON-RPC envelope. The handler must
    // accept the verbosity arg and emit the same shape as the prior default
    // when no arg is supplied.
    const rpc = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "get_health",
        arguments: opts.verbosity === undefined ? {} : { verbosity: opts.verbosity },
      },
    };
    source = `
      import { handleStdioRequest } from '${join(c.sourceModule.replace(/\/health\.js$/, ""))}/index.js';
      process.stdin.on('data', () => {});
      // Direct invocation: feed a JSON-RPC envelope, capture the response.
      const rpc = ${JSON.stringify(rpc)};
      const resp = await handleStdioRequest(rpc);
      console.log(JSON.stringify(resp.result ?? resp));
    `;
  } else {
    source = opts.verbosity
      ? `import {getHealth} from '${c.sourceModule}'; console.log(JSON.stringify(getHealth({verbosity: ${JSON.stringify(opts.verbosity)}})));`
      : `import {getHealth} from '${c.sourceModule}'; console.log(JSON.stringify(getHealth()));`;
  }
  const stdout = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    {
      cwd: c.cwd,
      encoding: "utf-8",
      timeout: 15_000,
      env: {
        ...process.env,
        MESHFLEET_DB_FILE: join(c.cwd, "ledger.db"),
        MESHFLEET_DATA_FILE: join(c.cwd, "data.json"),
        MESHFLEET_EVENT_LOG_FILE: join(c.cwd, "events.jsonl"),
      },
    },
  );
  return JSON.parse(stdout);
}

function withCopiedDist<T>(fn: (ctx: SubprocessCall) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "meshfleet-health-compact-"));
  try {
    // Copy dist/ from repoRoot — the actual production runtime.
    cpSync(join(repoRoot, "dist"), join(dir, "dist"), { recursive: true });
    copyFileSync(join(repoRoot, "package.json"), join(dir, "package.json"));
    symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "junction");
    return fn({ cwd: dir, sourceModule: "./dist/health.js" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------
// 1. server-side integrity: readBuildIdentity is unchanged
// --------------------------------------------------------------------

test("readBuildIdentity still re-hashes every dist/ entrypoint on each call (server-side integrity unchanged)", () => {
  withCopiedDist((ctx) => {
    const source = `import {readBuildIdentity} from '${ctx.sourceModule}'; console.log(JSON.stringify(readBuildIdentity()));`;
    const result = JSON.parse(execFileSync(process.execPath,
      ["--input-type=module", "-e", source], {
        cwd: ctx.cwd, encoding: "utf-8", timeout: 15_000,
        env: { ...process.env, MESHFLEET_DB_FILE: join(ctx.cwd, "ledger.db"),
          MESHFLEET_DATA_FILE: join(ctx.cwd, "data.json"), MESHFLEET_EVENT_LOG_FILE: join(ctx.cwd, "events.jsonl") },
      })) as Record<string, unknown>;
    assert.equal(result.status, "ok", "fresh build manifest must be ok");
    assert.equal(result.entrypoints_match_runtime, true);
    assert.ok(typeof result.entrypoint_count === "number" && (result.entrypoint_count as number) > 0);
    const entrypoints = result.entrypoints as Record<string, string>;
    assert.ok(entrypoints && typeof entrypoints === "object");
    assert.equal(
      Object.keys(entrypoints).length,
      result.entrypoint_count,
      "entrypoint_count must match the actual map size — no skipped rehash",
    );
  });
});

// --------------------------------------------------------------------
// 2. backward-compat default: get_health with no args STILL returns the
//    per-entrypoint entrypoints map. No silent breakage.
// --------------------------------------------------------------------

test("get_health default (no args) preserves the prior shape — entrypoints map is populated", () => {
  withCopiedDist((ctx) => {
    const report = callHealth(ctx) as Record<string, unknown>;
    const bi = report.build_identity as Record<string, unknown>;
    // BACKWARD COMPATIBILITY: the per-entrypoint map MUST cross the wire
    // when the caller does not ask for the compact shape.
    assert.ok(
      bi.entrypoints && typeof bi.entrypoints === "object",
      "default get_health must populate build_identity.entrypoints (backward-compat)",
    );
    assert.ok(
      typeof bi.entrypoint_count === "number" &&
      Object.keys(bi.entrypoints as Record<string, string>).length === bi.entrypoint_count,
      "every entrypoints key must be present (no projection dropping them by default)",
    );
    assert.equal(bi.status, "ok");
    assert.equal(report.status, "ok");
  });
});

// --------------------------------------------------------------------
// 3. opt-in summary: explicit verbosity="summary" omits the entrypoints map
//    while preserving every other identity field.
// --------------------------------------------------------------------

test("get_health verbosity=summary omits the entrypoints map but preserves every other identity field", () => {
  withCopiedDist((ctx) => {
    const report = callHealth(ctx, { verbosity: "summary" }) as Record<string, unknown>;
    const bi = report.build_identity as Record<string, unknown>;
    assert.equal(
      bi.entrypoints,
      undefined,
      "verbosity=summary must omit build_identity.entrypoints",
    );
    assert.ok(typeof bi.entrypoint_count === "number");
    assert.ok(typeof bi.entrypoints_match_runtime === "boolean");
    assert.ok(typeof bi.manifest_path === "string");
    assert.ok(typeof bi.source_commit === "string");
    assert.equal(bi.status, "ok");
    assert.equal(report.status, "ok");
  });
});

// --------------------------------------------------------------------
// 4. explicit verbosity="full" returns the same map as the default.
// --------------------------------------------------------------------

test("get_health verbosity=full returns the same shape and entrypoint map as the default", () => {
  withCopiedDist((ctx) => {
    const def = callHealth(ctx) as Record<string, unknown>;
    const full = callHealth(ctx, { verbosity: "full" }) as Record<string, unknown>;
    const defBi = def.build_identity as Record<string, unknown>;
    const fullBi = full.build_identity as Record<string, unknown>;
    assert.ok(
      defBi.entrypoints && typeof defBi.entrypoints === "object",
      "default must populate entrypoints (backward-compat)",
    );
    assert.ok(
      fullBi.entrypoints && typeof fullBi.entrypoints === "object",
      "verbosity=full must populate entrypoints",
    );
    // Same identity fields.
    assert.equal(fullBi.status, defBi.status);
    assert.equal(fullBi.entrypoint_count, defBi.entrypoint_count);
    assert.equal(fullBi.entrypoints_match_runtime, defBi.entrypoints_match_runtime);
    assert.equal(fullBi.manifest_path, defBi.manifest_path);
    assert.equal(fullBi.package_name, defBi.package_name);
    assert.equal(fullBi.package_version, defBi.package_version);
    assert.equal(fullBi.source_commit, defBi.source_commit);
    assert.equal(full.status, def.status);
    const fullKeys = Object.keys(fullBi.entrypoints as Record<string, string>);
    assert.equal(fullKeys.length, fullBi.entrypoint_count);
    assert.ok(fullKeys.every((k) => k.endsWith(".js")));
    assert.ok(fullKeys.includes("index.js"));
    assert.ok(fullKeys.includes("bin/meshfleet.js"));
  });
});

// --------------------------------------------------------------------
// 5. explicit diagnostic: get_build_identity returns the full map
// --------------------------------------------------------------------

test("getBuildIdentity() returns the full BuildIdentityReport including the entrypoints map", () => {
  withCopiedDist((ctx) => {
    const source = `import {getBuildIdentity} from '${ctx.sourceModule}'; console.log(JSON.stringify(getBuildIdentity()));`;
    const identity = JSON.parse(execFileSync(process.execPath,
      ["--input-type=module", "-e", source], {
        cwd: ctx.cwd, encoding: "utf-8", timeout: 15_000,
        env: { ...process.env, MESHFLEET_DB_FILE: join(ctx.cwd, "ledger.db"),
          MESHFLEET_DATA_FILE: join(ctx.cwd, "data.json"), MESHFLEET_EVENT_LOG_FILE: join(ctx.cwd, "events.jsonl") },
      })) as Record<string, unknown>;
    assert.equal(identity.status, "ok");
    const entrypoints = identity.entrypoints as Record<string, string>;
    assert.ok(entrypoints && typeof entrypoints === "object");
    assert.equal(
      Object.keys(entrypoints).length,
      identity.entrypoint_count,
    );
    for (const [rel, hash] of Object.entries(entrypoints)) {
      assert.ok(/^[0-9a-f]{64}$/.test(hash), `hash for ${rel} must be a 64-char hex SHA-256, got ${hash}`);
      assert.ok(rel.endsWith(".js"));
    }
  });
});

// --------------------------------------------------------------------
// 6. byte measurement: opt-in summary is materially smaller than the
//    default full payload (same build state).
// --------------------------------------------------------------------

test("summary get_health payload is materially smaller than the default payload (same build state)", () => {
  withCopiedDist((ctx) => {
    const summaryBytes = JSON.stringify(callHealth(ctx, { verbosity: "summary" })).length;
    const defaultBytes = JSON.stringify(callHealth(ctx)).length;
    // The summary payload must be substantially smaller — the only field we
    // dropped is the entrypoints map. Hard lower bound: at least 10x.
    assert.ok(
      summaryBytes < defaultBytes / 10,
      `summary=${summaryBytes} must be at least 10x smaller than default=${defaultBytes}`,
    );
    assert.ok(summaryBytes < 4096, `summary=${summaryBytes} must be < 4kB`);
    assert.ok(defaultBytes > 10000, `default=${defaultBytes} must reflect the entrypoints map being present`);
  });
});

// --------------------------------------------------------------------
// 7. invalid verbosity is rejected (not silently coerced).
// --------------------------------------------------------------------

test("get_health rejects unknown verbosity values", () => {
  withCopiedDist((ctx) => {
    const source = `import {getHealth} from '${ctx.sourceModule}'; console.log(JSON.stringify(getHealth({verbosity: "everything"})));`;
    let thrown: unknown = null;
    try {
      execFileSync(process.execPath, ["--input-type=module", "-e", source], {
        cwd: ctx.cwd, encoding: "utf-8", timeout: 15_000,
        env: { ...process.env, MESHFLEET_DB_FILE: join(ctx.cwd, "ledger.db"),
          MESHFLEET_DATA_FILE: join(ctx.cwd, "data.json"), MESHFLEET_EVENT_LOG_FILE: join(ctx.cwd, "events.jsonl") },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, "an unknown verbosity must surface as an error");
    const stderr = (thrown as { stderr?: Buffer | string }).stderr;
    const stderrText = stderr
      ? (typeof stderr === "string" ? stderr : stderr.toString("utf-8"))
      : "";
    assert.ok(
      /verbosity/i.test(stderrText),
      `error must mention verbosity, got: ${stderrText.slice(0, 200)}`,
    );
  });
});
