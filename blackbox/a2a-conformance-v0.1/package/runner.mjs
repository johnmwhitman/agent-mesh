import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIRECTORY = dirname(PACKAGE_DIRECTORY);
const REPOSITORY_DIRECTORY = resolve(HARNESS_DIRECTORY, "../..");
const PACKAGE_NAME = "meshfleet";
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";
const OUTPUT_CAP_BYTES = 256 * 1024;
const KILL_GRACE_MS = 2_000;
const DIRECT_VERSION_REPORT_LIMIT = 32;
const TIMEOUTS = {
  pack: 60_000,
  install: 120_000,
  rebuild: 300_000,
  harness: 120_000
};
const EXPECTED_BINS = {
  "meshfleet": "dist/index.js",
  "agent-mesh": "dist/bin/inspect.js",
  "agent-mesh-dashboard": "dist/bin/dashboard.js"
};
const PREAMBLE = "Meshfleet packaged stdio catalog-boundary conformance v0.1";
const NONCLAIMS = [
  "This is not multi-client conformance or full A2A conformance.",
  "The runner uses npm only for local packing and an offline tarball install; it makes no network claim.",
  "Passing requires a local native build toolchain for the explicit better-sqlite3 rebuild and does not prove script-free runtime readiness or OS-level network blocking.",
  "Host PATH, npm cache, native headers, and native toolchain influence the rebuild; this is not a hermetic build.",
  "Transitive resolution is observed, not pinned or reproducible; consumers need their own lock policy.",
  "The inherited harness invokes only catalog, ping, get_health, and an unknown-tool canary; it invokes no provider-capable tool."
];

function issue(error) {
  return error instanceof Error ? error.message : String(error);
}

function isInside(parent, candidate) {
  const value = relative(parent, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function addCheck(checks, id, status, detail) {
  checks.push({ id, status, detail });
}

function boundedFailingChecks(checks) {
  if (!Array.isArray(checks)) return "[]";
  return JSON.stringify(checks
    .filter((check) => check?.status !== "pass")
    .slice(0, 16)
    .map((check) => ({
      id: String(check?.id ?? "unknown").slice(0, 160),
      status: String(check?.status ?? "unknown").slice(0, 32),
      detail: typeof check?.detail === "string"
        ? check.detail.slice(0, 512)
        : JSON.stringify(check?.detail ?? null).slice(0, 512)
    })));
}

function commandDetail(result) {
  return `code=${result.code ?? "null"} signal=${result.signal ?? "none"} timeout=${result.timedOut} truncated=${result.truncated} stdout_bytes=${result.stdoutBytes} stderr_bytes=${result.stderrBytes}`;
}

function safeWindowsCommandLine(command, args) {
  const values = [command, ...args];
  if (values.some((value) => typeof value !== "string" || /["%&|<>^!\r\n]/.test(value))) {
    throw new Error("Windows cmd invocation rejected an unsafe controlled argument");
  }
  return values.map((value) => `"${value}"`).join(" ");
}

function taskkill(pid, force) {
  try {
    const child = spawn("taskkill.exe", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore", windowsHide: true });
    const timeout = setTimeout(() => child.kill(), KILL_GRACE_MS);
    child.once("close", () => clearTimeout(timeout));
    child.unref();
  } catch {
    // Best effort only.
  }
}

function terminate(child, signal) {
  try {
    if (!Number.isInteger(child.pid) || child.pid <= 0) return;
    if (process.platform === "win32") {
      taskkill(child.pid, signal === "SIGKILL");
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    // The child may already have exited; cleanup is best effort.
  }
}

function run(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolveRun, rejectRun) => {
    let launchCommand = command;
    let launchArgs = args;
    if (process.platform === "win32" && command === NPM_COMMAND) {
      const comspec = env.ComSpec ?? env.COMSPEC;
      if (typeof comspec !== "string" || !isAbsolute(comspec)) {
        rejectRun(new Error("Windows npm launch requires an absolute controlled ComSpec path"));
        return;
      }
      launchCommand = comspec;
      launchArgs = ["/d", "/s", "/c", safeWindowsCommandLine(command, args)];
    }
    const child = spawn(launchCommand, launchArgs, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let killTimer;
    const collect = (which, chunk) => {
      const bytes = Buffer.byteLength(chunk);
      if (which === "stdout") stdoutBytes += bytes;
      else stderrBytes += bytes;
      const existing = which === "stdout" ? stdout : stderr;
      if (Buffer.byteLength(existing) >= OUTPUT_CAP_BYTES) {
        truncated = true;
        return;
      }
      const remaining = OUTPUT_CAP_BYTES - Buffer.byteLength(existing);
      const value = chunk.toString("utf8");
      const bounded = Buffer.byteLength(value) > remaining ? Buffer.from(value).subarray(0, remaining).toString("utf8") : value;
      if (Buffer.byteLength(value) > remaining) truncated = true;
      if (which === "stdout") stdout += bounded;
      else stderr += bounded;
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate(child, "SIGTERM");
      killTimer = setTimeout(() => terminate(child, "SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      rejectRun(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolveRun({ code, signal, stdout, stderr, stdoutBytes, stderrBytes, timedOut, truncated });
    });
  });
}

function selectedEnvironment(root, { scriptsEnabled, offline }) {
  const home = join(root, "npm-home");
  const userConfig = join(root, "npm-userconfig");
  const globalConfig = join(root, "npm-globalconfig");
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    TMPDIR: join(root, "tmp"),
    TMP: join(root, "tmp"),
    TEMP: join(root, "tmp"),
    npm_config_userconfig: userConfig,
    NPM_CONFIG_USERCONFIG: userConfig,
    npm_config_globalconfig: globalConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    npm_config_ignore_scripts: scriptsEnabled ? "false" : "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_build_from_source: "true"
  };
  const cache = process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE ?? (process.env.HOME ? join(process.env.HOME, ".npm") : undefined);
  if (cache) {
    environment.npm_config_cache = cache;
    environment.NPM_CONFIG_CACHE = cache;
  }
  if (offline) environment.npm_config_offline = "true";
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (systemRoot) environment.SystemRoot = systemRoot;
  for (const key of ["ComSpec", "PATHEXT"]) if (process.env[key]) environment[key] = process.env[key];
  return environment;
}

async function prepareEnvironment(root) {
  await Promise.all([
    mkdir(join(root, "pack"), { recursive: true }),
    mkdir(join(root, "consumer"), { recursive: true }),
    mkdir(join(root, "npm-home"), { recursive: true }),
    mkdir(join(root, "tmp"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(join(root, "npm-userconfig"), "", "utf8"),
    writeFile(join(root, "npm-globalconfig"), "", "utf8")
  ]);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function validateEntrypoints(packageRoot, packageJson) {
  if (packageJson?.main !== "dist/index.js") throw new Error("installed package main must map to dist/index.js");
  if (JSON.stringify(Object.keys(packageJson?.bin ?? {}).sort()) !== JSON.stringify(Object.keys(EXPECTED_BINS).sort())) {
    throw new Error("installed package bin names do not match the published mapping");
  }
  const resolvedRoot = await realpath(packageRoot);
  for (const [name, target] of Object.entries(EXPECTED_BINS)) {
    if (packageJson.bin?.[name] !== target) throw new Error(`installed package bin ${name} must map to ${target}`);
    const resolvedTarget = await realpath(join(packageRoot, target));
    if (!isInside(resolvedRoot, resolvedTarget) || resolvedTarget !== join(resolvedRoot, target)) {
      throw new Error(`installed package bin ${name} resolves outside its published package boundary`);
    }
  }
}

function boundedPath(value) {
  return typeof value === "string" ? value.slice(0, 512) : "<unresolved>";
}

function dependencyPathDetail(name, consumerRoot, entrypoint, candidate) {
  return `dependency=${name} consumer_root=${boundedPath(consumerRoot)} resolved_entry=${boundedPath(entrypoint)} candidate=${boundedPath(candidate)}`;
}

function sameStringMap(left, right) {
  const leftEntries = Object.entries(left ?? {}).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right ?? {}).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function derivedPackageName(lockPath) {
  const parts = String(lockPath).split(/[\\/]/);
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex === -1 || nodeModulesIndex === parts.length - 1) return null;
  const first = parts[nodeModulesIndex + 1];
  if (first.startsWith("@")) {
    const second = parts[nodeModulesIndex + 2];
    return second ? `${first}/${second}` : null;
  }
  return first;
}

function closureMismatchDetail(name, trustedEntry, observedEntry) {
  const trustedVersion = boundedPath(String(trustedEntry?.version ?? "<missing>"));
  const trustedIntegrity = boundedPath(String(trustedEntry?.integrity ?? "<missing>"));
  const observedVersion = boundedPath(String(observedEntry?.version ?? "<missing>"));
  const observedIntegrity = boundedPath(String(observedEntry?.integrity ?? "<missing>"));
  return `dependency=${name} trusted_version=${trustedVersion} trusted_integrity=${trustedIntegrity} observed_version=${observedVersion} observed_integrity=${observedIntegrity}`;
}

function observeConsumerClosure(trustedLock, consumerLock) {
  const evidence = {
    closure_match: false,
    consumer_lock_package_count: 0,
    representable_package_count: 0,
    matched_package_count: 0,
    differing_package_count: 0,
    differences: []
  };
  const consumerPackages = consumerLock?.packages;
  if (!consumerPackages || typeof consumerPackages !== "object") {
    evidence.differences.push({ kind: "consumer-lock-unavailable" });
    return evidence;
  }
  for (const [lockPath, entry] of Object.entries(consumerPackages)) {
    if (lockPath === "" || lockPath === `node_modules/${PACKAGE_NAME}`) continue;
    evidence.consumer_lock_package_count += 1;
    const name = derivedPackageName(lockPath);
    if (!name) continue;
    evidence.representable_package_count += 1;
    const trustedEntry = trustedLock.packages?.[`node_modules/${name}`];
    const integrityMatches = entry?.integrity === trustedEntry?.integrity;
    const versionMatches = entry?.version === trustedEntry?.version;
    const integrityComparable = entry?.integrity !== undefined || trustedEntry?.integrity !== undefined;
    if (trustedEntry && versionMatches && (!integrityComparable || integrityMatches)) {
      evidence.matched_package_count += 1;
      continue;
    }
    evidence.differing_package_count += 1;
    if (evidence.differences.length < 16) {
      evidence.differences.push({
        kind: trustedEntry ? "version-or-integrity-mismatch" : "unknown-package",
        detail: closureMismatchDetail(name, trustedEntry, entry)
      });
    }
  }
  evidence.closure_match = evidence.differing_package_count === 0;
  return evidence;
}

async function resolveConsumerDependencyPackage(installedRoot, consumerRoot, name) {
  const segments = typeof name === "string" ? name.split("/") : [];
  if (segments.length === 0 || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`invalid direct runtime dependency name; ${dependencyPathDetail(name, consumerRoot, undefined, undefined)}`);
  }
  const candidates = [
    join(installedRoot, "node_modules", ...segments, "package.json"),
    join(consumerRoot, "node_modules", ...segments, "package.json")
  ];
  const effectivePackages = new Map();
  for (const candidate of candidates) {
    let resolvedPackageJson;
    try {
      resolvedPackageJson = await realpath(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`unable to resolve deterministic dependency candidate: ${issue(error)}; ${dependencyPathDetail(name, consumerRoot, resolvedPackageJson, candidate)}`);
    }
    if (!isInside(consumerRoot, resolvedPackageJson)) {
      throw new Error(`deterministic dependency candidate escapes the fresh consumer root; ${dependencyPathDetail(name, consumerRoot, resolvedPackageJson, candidate)}`);
    }
    let packageJson;
    try {
      packageJson = await readJson(resolvedPackageJson);
    } catch (error) {
      throw new Error(`unable to read deterministic dependency candidate: ${issue(error)}; ${dependencyPathDetail(name, consumerRoot, resolvedPackageJson, candidate)}`);
    }
    if (packageJson?.name !== name) {
      throw new Error(`deterministic dependency candidate has a non-matching package name; ${dependencyPathDetail(name, consumerRoot, resolvedPackageJson, candidate)}`);
    }
    effectivePackages.set(dirname(resolvedPackageJson), packageJson);
  }
  if (effectivePackages.size === 0) {
    throw new Error(`no deterministic npm direct-dependency candidate exists; ${dependencyPathDetail(name, consumerRoot, undefined, candidates.join(","))}`);
  }
  if (effectivePackages.size !== 1) {
    throw new Error(`conflicting deterministic npm direct-dependency candidates exist; ${dependencyPathDetail(name, consumerRoot, undefined, [...effectivePackages.keys()].join(","))}`);
  }
  return [...effectivePackages.values()][0];
}

async function validateRuntimeDependencies(installedRoot, consumerRoot) {
  const trustedLock = await readJson(join(REPOSITORY_DIRECTORY, "package-lock.json"));
  const directDependencies = trustedLock?.packages?.[""]?.dependencies;
  if (!directDependencies || typeof directDependencies !== "object") throw new Error("trusted root package-lock has no direct runtime dependency map");
  if (!isAbsolute(consumerRoot) || !isAbsolute(installedRoot)) throw new Error("consumer and installed package roots must be absolute");
  const [resolvedConsumerRoot, resolvedInstalledRoot] = await Promise.all([
    realpath(consumerRoot),
    realpath(installedRoot)
  ]);
  if (!isInside(resolvedConsumerRoot, resolvedInstalledRoot)) throw new Error("installed package must remain contained by the fresh consumer root");
  const installedManifest = await readJson(join(resolvedInstalledRoot, "package.json"));
  if (!sameStringMap(installedManifest?.dependencies, directDependencies)) {
    throw new Error("installed artifact dependency spec map does not equal the trusted root lock direct dependency map");
  }
  const versions = {};
  for (const name of Object.keys(directDependencies).sort()) {
    const expected = trustedLock.packages?.[`node_modules/${name}`]?.version;
    if (typeof expected !== "string" || expected.length === 0) throw new Error(`trusted root package-lock lacks a concrete version for ${name}`);
    const installed = await resolveConsumerDependencyPackage(resolvedInstalledRoot, resolvedConsumerRoot, name);
    if (installed?.version !== expected) throw new Error(`installed runtime dependency ${name} version ${String(installed?.version)} does not equal trusted lock version ${expected}`);
    versions[name] = { locked: expected, installed: installed.version };
  }
  let closureEvidence;
  try {
    closureEvidence = observeConsumerClosure(trustedLock, await readJson(join(resolvedConsumerRoot, "package-lock.json")));
  } catch (error) {
    closureEvidence = {
      closure_match: false,
      consumer_lock_package_count: 0,
      representable_package_count: 0,
      matched_package_count: 0,
      differing_package_count: 1,
      differences: [{ kind: "consumer-lock-read-failed", detail: issue(error).slice(0, 512) }]
    };
  }
  return {
    direct_version_count: Object.keys(versions).length,
    direct_versions: Object.fromEntries(Object.entries(versions).slice(0, DIRECT_VERSION_REPORT_LIMIT)),
    ...closureEvidence
  };
}

async function localArtifactMetadata(tarball, packed) {
  const bytes = await readFile(tarball);
  return {
    tarball_sha256: createHash("sha256").update(bytes).digest("hex"),
    tarball_bytes: bytes.byteLength,
    npm_integrity: typeof packed?.integrity === "string" ? packed.integrity.slice(0, 256) : null,
    npm_shasum: typeof packed?.shasum === "string" ? packed.shasum.slice(0, 128) : null,
    integrity_status: "local npm pack metadata only; not independently pinned"
  };
}

async function main() {
  const checks = [];
  let root;
  let artifact = null;
  try {
    root = await mkdtemp(join(tmpdir(), "meshfleet-packaged-catalog-boundary-"));
    await prepareEnvironment(root);
    const packDirectory = join(root, "pack");
    const consumerDirectory = join(root, "consumer");
    const pack = await run(NPM_COMMAND, ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory], {
      cwd: REPOSITORY_DIRECTORY,
      env: selectedEnvironment(root, { scriptsEnabled: false, offline: false }),
      timeoutMs: TIMEOUTS.pack
    });
    if (pack.code !== 0 || pack.timedOut || pack.truncated) throw new Error(`local npm pack failed: ${commandDetail(pack)}; ${pack.stderr.trim() || pack.stdout.trim()}`);
    const packed = JSON.parse(pack.stdout);
    if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== "string") {
      throw new Error("local npm pack did not return exactly one tarball filename");
    }
    const packedPaths = Array.isArray(packed[0].files) ? packed[0].files.map((file) => typeof file === "string" ? file : file?.path) : [];
    if (!packedPaths.includes("dist/index.js")) throw new Error("local npm pack metadata does not include dist/index.js");
    const tarball = join(packDirectory, basename(packed[0].filename));
    if (!(await stat(tarball)).isFile()) throw new Error("local npm pack did not create its reported tarball");
    artifact = await localArtifactMetadata(tarball, packed[0]);
    addCheck(checks, "local-pack", "pass", "npm pack produced one local tarball with scripts ignored and dist/index.js listed in pack metadata");

    await writeFile(join(consumerDirectory, "package.json"), JSON.stringify({ private: true, name: "meshfleet-conformance-consumer", version: "0.0.0" }), "utf8");
    const install = await run(NPM_COMMAND, ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", tarball], {
      cwd: consumerDirectory,
      env: selectedEnvironment(root, { scriptsEnabled: false, offline: true }),
      timeoutMs: TIMEOUTS.install
    });
    if (install.code !== 0 || install.timedOut || install.truncated) throw new Error(`offline tarball install failed: ${commandDetail(install)}; ${install.stderr.trim() || install.stdout.trim()}`);
    addCheck(checks, "offline-consumer-install", "pass", "fresh consumer installed the local tarball offline with scripts, audit, and funding disabled");

    const rebuild = await run(NPM_COMMAND, ["rebuild", "better-sqlite3", "--offline", "--build-from-source", "--no-audit", "--no-fund", "--ignore-scripts=false"], {
      cwd: consumerDirectory,
      env: selectedEnvironment(root, { scriptsEnabled: true, offline: true }),
      timeoutMs: TIMEOUTS.rebuild
    });
    if (rebuild.code !== 0 || rebuild.timedOut || rebuild.truncated) throw new Error(`offline better-sqlite3 rebuild failed: ${commandDetail(rebuild)}; ${rebuild.stderr.trim() || rebuild.stdout.trim()}`);
    addCheck(checks, "offline-native-rebuild.better-sqlite3", "pass", "allowlisted better-sqlite3 rebuilt offline from source with scripts enabled only for this rebuild");

    const installedRoot = join(consumerDirectory, "node_modules", PACKAGE_NAME);
    const [resolvedConsumer, resolvedPackage, packageJson] = await Promise.all([
      realpath(consumerDirectory),
      realpath(installedRoot),
      readJson(join(installedRoot, "package.json"))
    ]);
    if (!isInside(resolvedConsumer, resolvedPackage) || packageJson?.name !== PACKAGE_NAME) {
      throw new Error("installed package identity or consumer containment check failed");
    }
    const installedEntrypoint = await realpath(join(installedRoot, "dist", "index.js"));
    if (!isInside(resolvedPackage, installedEntrypoint) || installedEntrypoint !== join(resolvedPackage, "dist", "index.js")) {
      throw new Error("executed server entrypoint is not the installed package dist/index.js");
    }
    await validateEntrypoints(installedRoot, packageJson);
    addCheck(checks, "installed-entrypoint-boundary", "pass", "published main and bin entrypoints resolve inside the installed package");
    const runtimeVersions = await validateRuntimeDependencies(installedRoot, resolvedConsumer);
    addCheck(checks, "runtime-dependency-evidence", "pass", runtimeVersions);

    const harness = await run(process.execPath, [join(HARNESS_DIRECTORY, "runner.mjs"), "--package-root", resolvedPackage, "--sdk-root", resolvedConsumer], {
      cwd: consumerDirectory,
      env: selectedEnvironment(root, { scriptsEnabled: false, offline: false }),
      timeoutMs: TIMEOUTS.harness
    });
    let inherited;
    try {
      inherited = JSON.parse(harness.stdout);
    } catch (error) {
      throw new Error(`inherited harness did not emit atomic JSON: ${issue(error)}; ${commandDetail(harness)}`);
    }
    if (harness.code !== 0 || harness.timedOut || harness.truncated || inherited?.passed !== true || !Array.isArray(inherited?.checks)) {
      throw new Error(`inherited catalog oracle failed: ${commandDetail(harness)}; ${harness.stderr.trim() || "passed=false"}; failing_checks=${boundedFailingChecks(inherited?.checks)}`);
    }
    addCheck(checks, "inherited-catalog-oracles", "pass", "installed package passed the pinned catalog, stable read-only, unknown-tool, and mutation oracles using the consumer MCP SDK");
    return { checks, observedCatalogSha256: inherited.observed_catalog_sha256, artifact };
  } catch (error) {
    addCheck(checks, "runner", "fail", issue(error));
    return { checks, observedCatalogSha256: null, artifact };
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
  }
}

const result = await main().catch((error) => ({ checks: [{ id: "runner.unhandled", status: "fail", detail: issue(error) }], observedCatalogSha256: null, artifact: null }));
const passed = result.checks.length > 0 && result.checks.every((check) => check.status === "pass");
process.stdout.write(`${JSON.stringify({ preamble: PREAMBLE, nonclaims: NONCLAIMS, observed_catalog_sha256: result.observedCatalogSha256, artifact: result.artifact, passed, checks: result.checks })}\n`);
if (!passed) process.exitCode = 1;
