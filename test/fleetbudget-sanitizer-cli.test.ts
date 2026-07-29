import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { FleetBudgetSanitizerError } from "../src/fleetbudget-sanitizer.js";
import { readBoundedFleetBudgetInput } from "../src/bin/fleetbudget-sanitize.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "bin", "fleetbudget-sanitize.ts");
const IS_WINDOWS = process.platform === "win32";
const NPM = IS_WINDOWS ? "npm.cmd" : "npm";
const COLLECTION_MS = Date.parse("2023-11-14T22:13:20.000Z");
const VALID_ARGS = [
  "--collection-start-ms",
  String(COLLECTION_MS),
  "--collection-finish-ms",
  String(COLLECTION_MS),
  "--now-ms",
  String(COLLECTION_MS),
];
const ROUTE_KEYS = [
  "agentic-build",
  "breadth",
  "bulk",
  "design",
  "judgment",
  "media-audio",
  "media-image",
  "media-video",
  "research",
  "verdict",
] as const;

function rawReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generated: "2023-11-14T22:13:20+00:00",
    lanes: [{
      lane: "grok-build",
      measured: true,
      used: 1,
      total: 2,
      unit: "requests",
      utilization: 50,
      state: "OK",
      note: "",
      detail: "",
    }],
    routes: Object.fromEntries(
      ROUTE_KEYS.map((key) => [key, key === "bulk" ? "grok-build" : null]),
    ),
    ...overrides,
  };
}

function reportText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(rawReport(overrides));
}

function runCli(args: string[], stdin = reportText()) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", CLI, ...args],
    {
      cwd: ROOT,
      input: stdin,
      encoding: "utf8",
      env: {},
    },
  );
}

function replaceFlagValue(
  flag: string,
  value: string,
  args = VALID_ARGS,
): string[] {
  const replaced = [...args];
  const index = replaced.indexOf(flag);
  assert.notEqual(index, -1);
  replaced[index + 1] = value;
  return replaced;
}

test("CLI emits exactly one compact windowless snapshot JSON line", () => {
  const result = runCli([...VALID_ARGS, "--ttl-ms", "600000"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const snapshot = JSON.parse(result.stdout);
  assert.equal(result.stdout, `${JSON.stringify(snapshot)}\n`);
  assert.deepEqual(snapshot, {
    version: "meshfleet.fleetbudget-snapshot.v1",
    observed_at_ms: COLLECTION_MS,
    expires_at_ms: COLLECTION_MS + 600_000,
    lanes: [{
      lane_id: "grok-build",
      measured: true,
      used: 1,
      total: 2,
      unit: "requests",
    }],
  });
});

test("CLI rejects every argv outside the closed separate-token grammar with exit 2", () => {
  const invalidArgv: string[][] = [
    [],
    VALID_ARGS.slice(2),
    [...VALID_ARGS.slice(0, 2), ...VALID_ARGS.slice(4)],
    VALID_ARGS.slice(0, 4),
    VALID_ARGS.slice(0, 2),
    ["--collection-start-ms"],
    [...VALID_ARGS.slice(0, 4), "--now-ms"],
    [...VALID_ARGS, "--unknown", "1"],
    [...VALID_ARGS, "positional"],
    [...VALID_ARGS, "--"],
    [...VALID_ARGS, "--help"],
    [...VALID_ARGS, "--version"],
    [`--collection-start-ms=${COLLECTION_MS}`, ...VALID_ARGS.slice(2)],
    [...VALID_ARGS, "--collection-start-ms", String(COLLECTION_MS)],
    [...VALID_ARGS, "--collection-finish-ms", String(COLLECTION_MS)],
    [...VALID_ARGS, "--now-ms", String(COLLECTION_MS)],
    [...VALID_ARGS, "--ttl-ms", "1", "--ttl-ms", "2"],
    [...VALID_ARGS, "--ttl-ms"],
  ];
  for (const token of ["-1", "+1", "01", "1.0", "1e3", "0x10", " 1", "1 "]) {
    invalidArgv.push(replaceFlagValue("--collection-start-ms", token));
  }
  invalidArgv.push(
    replaceFlagValue("--collection-start-ms", "9007199254740992"),
    [...VALID_ARGS, "--ttl-ms", "0"],
    [...VALID_ARGS, "--ttl-ms", "-1"],
    [...VALID_ARGS, "--ttl-ms", "+1"],
    [...VALID_ARGS, "--ttl-ms", "01"],
    [...VALID_ARGS, "--ttl-ms", "1.0"],
    [...VALID_ARGS, "--ttl-ms", "1e3"],
    [...VALID_ARGS, "--ttl-ms", "600001"],
    [...VALID_ARGS, "--ttl-ms", "9007199254740992"],
  );

  for (const args of invalidArgv) {
    const result = runCli(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
    assert.equal(
      result.stderr,
      '{"error":{"code":"invalid_input"}}\n',
      args.join(" "),
    );
  }
});

test("CLI distinguishes valid-argv sanitizer failures with exit 1 and redacted JSON", () => {
  const zeroTimestamps = runCli([
    "--collection-start-ms",
    "0",
    "--collection-finish-ms",
    "0",
    "--now-ms",
    "0",
  ]);
  assert.equal(zeroTimestamps.status, 1);
  assert.equal(zeroTimestamps.stdout, "");
  assert.equal(zeroTimestamps.stderr, '{"error":{"code":"future_report"}}\n');

  const invalidInterval = runCli([
    "--collection-start-ms",
    String(COLLECTION_MS + 1),
    "--collection-finish-ms",
    String(COLLECTION_MS),
    "--now-ms",
    String(COLLECTION_MS + 1),
  ]);
  assert.equal(invalidInterval.status, 1);
  assert.equal(invalidInterval.stdout, "");
  assert.equal(
    invalidInterval.stderr,
    '{"error":{"code":"invalid_input","path":"input.collection_finished_at_ms"}}\n',
  );

  const secret = "AKIA-SECRET-PROMPT";
  const invalidReport = runCli(
    VALID_ARGS,
    reportText({ [secret]: "must not leak" }),
  );
  assert.equal(invalidReport.status, 1);
  assert.equal(invalidReport.stdout, "");
  assert.equal(
    invalidReport.stderr,
    '{"error":{"code":"report_schema_drift","path":"report.<unknown-member>"}}\n',
  );
  assert.doesNotMatch(invalidReport.stderr, /AKIA|SECRET|PROMPT/i);

  const empty = runCli(VALID_ARGS, "");
  assert.equal(empty.status, 1);
  assert.equal(empty.stdout, "");
  assert.equal(empty.stderr, '{"error":{"code":"invalid_json"}}\n');
});

test("bounded reader returns exactly 1 MiB and stops at byte 1,048,577", async () => {
  const exact = await readBoundedFleetBudgetInput(
    Readable.from([Buffer.alloc(1_048_576, 0x20)]),
  );
  assert.equal(exact.byteLength, 1_048_576);

  let pulls = 0;
  async function* oversized(): AsyncGenerator<Uint8Array> {
    pulls += 1;
    yield Buffer.alloc(1_048_576, 0x20);
    pulls += 1;
    yield Buffer.from([0x20]);
    pulls += 1;
    yield Buffer.from("must-not-be-read");
  }
  await assert.rejects(
    () => readBoundedFleetBudgetInput(oversized()),
    (error: unknown) => {
      assert.ok(error instanceof FleetBudgetSanitizerError);
      assert.equal(error.code, "input_too_large");
      assert.equal(error.path, "input.report_bytes");
      return true;
    },
  );
  assert.equal(pulls, 2);
});

test("bounded reader maps an injected stream failure to value-free input_read_failed", async () => {
  const secret = "AKIA-SECRET underlying stream failure";
  async function* failed(): AsyncGenerator<Uint8Array> {
    yield Buffer.from("{}");
    throw new Error(secret);
  }
  await assert.rejects(
    () => readBoundedFleetBudgetInput(failed()),
    (error: unknown) => {
      assert.ok(error instanceof FleetBudgetSanitizerError);
      assert.equal(error.code, "input_read_failed");
      assert.equal(error.path, undefined);
      assert.equal(error.message, "fleetbudget sanitizer rejected input_read_failed");
      assert.doesNotMatch(error.message, /AKIA|SECRET|stream failure/i);
      return true;
    },
  );
});

test("CLI passes exactly 1 MiB to the API and rejects 1 MiB plus one before decoding", () => {
  const compact = reportText();
  const exact = compact + " ".repeat(1_048_576 - Buffer.byteLength(compact));
  const accepted = runCli(VALID_ARGS, exact);
  assert.equal(Buffer.byteLength(exact), 1_048_576);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stderr, "");

  const rejected = runCli(VALID_ARGS, `${exact} `);
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, "");
  assert.equal(
    rejected.stderr,
    '{"error":{"code":"input_too_large","path":"input.report_bytes"}}\n',
  );
});

test("package exposes the sanitizer subpath and installed executable without forbidden CLI effects", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(
    pkg.exports["./fleetbudget-sanitizer"],
    "./dist/fleetbudget-sanitizer.js",
  );
  assert.equal(
    pkg.bin["meshfleet-fleetbudget-sanitize"],
    "dist/bin/fleetbudget-sanitize.js",
  );

  const source = readFileSync(CLI, "utf8");
  assert.match(source, /^#!\/usr\/bin\/env node\n/);
  assert.doesNotMatch(
    source,
    /node:child_process|node:fs|process\.env|fetch\s*\(|fleetbudget\s+--json/i,
  );
});

test("packed tarball installs offline and executes its installed stdin binary", {
  timeout: 30_000,
}, () => {
  const temp = mkdtempSync(join(tmpdir(), "meshfleet-fleetbudget-consumer-"));
  try {
    const build = spawnSync(NPM, ["run", "build"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, npm_config_update_notifier: "false" },
      shell: IS_WINDOWS,
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);

    const pack = spawnSync(
      NPM,
      ["pack", "--json", "--pack-destination", temp],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, npm_config_update_notifier: "false" },
        shell: IS_WINDOWS,
      },
    );
    assert.equal(pack.status, 0, pack.stderr || pack.stdout);
    const packed = JSON.parse(pack.stdout) as Array<{ filename: string }>;
    assert.equal(packed.length, 1);
    const tarball = join(temp, packed[0]!.filename);
    assert.equal(existsSync(tarball), true);

    const consumer = join(temp, "consumer");
    const packageJson = join(consumer, "package.json");
    mkdirSync(consumer);
    writeFileSync(packageJson, '{"name":"offline-consumer","private":true}\n');
    const install = spawnSync(
      NPM,
      [
        "install",
        "--offline",
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

    const imported = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "import('meshfleet/fleetbudget-sanitizer').then((module) => {" +
          "if (typeof module.sanitizeFleetBudgetReport !== 'function') process.exit(1)" +
          "})",
      ],
      {
        cwd: consumer,
        encoding: "utf8",
        env: {},
      },
    );
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, "");

    const executable = join(
      consumer,
      "node_modules",
      ".bin",
      IS_WINDOWS
        ? "meshfleet-fleetbudget-sanitize.cmd"
        : "meshfleet-fleetbudget-sanitize",
    );
    assert.equal(existsSync(executable), true);
    if (!IS_WINDOWS) {
      assert.notEqual(
        statSync(executable).mode & 0o111,
        0,
        "installed bin must retain an executable mode",
      );
    }
    const executed = spawnSync(executable, VALID_ARGS, {
      cwd: consumer,
      input: reportText(),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        ...(IS_WINDOWS
          ? {
              PATHEXT: process.env.PATHEXT ?? "",
              SystemRoot: process.env.SystemRoot ?? "",
            }
          : {}),
      },
      // Windows npm bins are .cmd shims. Since Node's CVE-2024-27980
      // hardening they must be launched through cmd.exe rather than as native
      // executables; POSIX continues to execute the installed symlink directly.
      shell: IS_WINDOWS,
    });
    assert.equal(executed.status, 0, executed.stderr);
    assert.equal(executed.stderr, "");
    const snapshot = JSON.parse(executed.stdout);
    assert.equal(executed.stdout, `${JSON.stringify(snapshot)}\n`);
    assert.equal(snapshot.version, "meshfleet.fleetbudget-snapshot.v1");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
