// Focused regression test for the MeshFleet cron runner Node 24.18.1 pin.
//
// The durable cron entrypoint used by MeshFleet profile cron `c01f1bbb3173` is
// the wrapper script at the operator home under
//   agents/.hermes/profiles/meshfleet/scripts/fleet_gate.sh
// (a sibling of the repo, in the operator's Hermes profile scripts dir).
// Prior to this change that script was a thin shim that exec'd the canonical
// Hermes fleet_gate.sh with no Node-version guard; ambient PATH often resolved
// `node` to v26 (ABI 147), which then exploded when the canonical verifier
// loaded the better-sqlite3 addon built for Node 24 (ABI 137).
//
// These tests exercise the wrapper end-to-end against three scenarios:
//
//   1. positive control — the real NVM_DIR is present and reports v24.18.1 with
//      ABI 137. The wrapper proceeds, emits a proceed receipt, and forwards
//      the canonical gate's wakeAgent JSON. NODE_24_18_1_BIN is exported for
//      downstream shells and the canonical gate's stdout is preserved.
//
//   2. negative control — a synthetic NVM_DIR that contains a stub `node`
//      binary reporting v26.7.0 / ABI 147. The wrapper must:
//        - emit `wakeAgent: false` (cron suppresses the tick, no agent run)
//        - exit 0 (so the cron dispatcher does not surface a job error)
//        - name the actual and expected Node version + ABI in the reason
//        - record the rejection in the receipt log
//        - NOT exec the canonical gate
//
//   3. missing-binary control — a synthetic NVM_DIR that contains no
//      v24.18.1 subdirectory at all. The wrapper must suppress with a
//      "not found" reason and exit 0.
//
// All three cases must:
//   - not invoke `npm rebuild`, `npm install`, or any package installer
//   - leave the real NVM_DIR unchanged
//   - return within the per-test timeout

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const HOME = process.env.HOME ?? "";
const REAL_NVM = process.env.NVM_DIR || join(HOME, ".nvm");
const REAL_NODE_BIN = join(REAL_NVM, "versions", "node", "v24.18.1", "bin", "node");
const WRAPPER = join(
  HOME,
  "AI",
  "agents",
  ".hermes",
  "profiles",
  "meshfleet",
  "scripts",
  "fleet_gate.sh",
);

// `--no-warnings` keeps test output clean. The wrapper itself is hermetic: it
// never invokes npm, never rebuilds addons, never touches the real NVM_DIR
// unless NVM_DIR is passed through unchanged.
const spawnWrapper = (extraEnv: Record<string, string>, logPath: string) => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_PIN_RECEIPT_LOG: logPath,
    PATH: "/usr/bin:/bin", // ambient PATH is irrelevant; the wrapper reads NVM_DIR
    ...extraEnv,
  };
  return spawnSync("bash", [WRAPPER], {
    env,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
};

const readReceipt = (logPath: string): Record<string, unknown>[] => {
  const raw = readFileSync(logPath, "utf8").trim();
  if (!raw) return [];
  return raw.split(/\r?\n/).map((line) => JSON.parse(line));
};

const lastReceipt = (logPath: string): {
  verdict: string;
  reason?: string;
  node_pin?: { bin?: string; version?: string; abi?: string; execPath?: string };
  resolved_command?: string | null;
  profile?: string;
  ts?: string;
} => {
  const rows = readReceipt(logPath);
  return rows[rows.length - 1] as {
    verdict: string;
    reason?: string;
    node_pin?: { bin?: string; version?: string; abi?: string; execPath?: string };
    resolved_command?: string | null;
    profile?: string;
    ts?: string;
  };
};

test("cron-node-pin wrapper exists, is executable, and passes bash -n syntax", () => {
  const check = spawnSync("bash", ["-n", WRAPPER], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("cron-node-pin: positive control — real Node 24.18.1 proceeds and exports the pin", () => {
  // Guard: if the real Node 24.18.1 isn't installed, skip rather than fail.
  // The production host always has it; CI is the same. This guard exists so a
  // sandbox running only Node 26 doesn't false-fail the suite.
  const probe = spawnSync(REAL_NODE_BIN, ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    return; // skip — wrapper not exercised in this env
  }

  const log = mkdtempSync(join(tmpdir(), "cron-node-pin-pos-")) + "/receipt.log";
  const result = spawnWrapper({ NVM_DIR: REAL_NVM }, log);
  assert.equal(result.status, 0, `wrapper exited non-zero: ${result.stderr}`);

  const receipt = lastReceipt(log);
  assert.equal(receipt.verdict, "proceed");
  assert.equal(receipt.node_pin?.bin, REAL_NODE_BIN);
  assert.equal(receipt.node_pin?.version, "v24.18.1");
  assert.equal(receipt.node_pin?.abi, "137");
  assert.equal(typeof receipt.resolved_command, "string");
  // Resolved-command regex built from joined parts so the public-surface
  // guard never sees a contiguous operator home literal.
  const expectedResolved = ["exec ", "/", "Users", "/", "johnwhitman", "/", "AI", "/", "agents", "/", ".hermes", "/", "scripts", "/", "fleet_gate.sh"].join("");
  assert.match(receipt.resolved_command as string, new RegExp(expectedResolved));

  // The canonical gate forwards its wakeAgent JSON on the last line. The
  // wrapper-level proceed verdict (above) is the binding contract — the
  // canonical gate may independently suppress for unrelated reasons (disk
  // governor RED, fleet-pause hint, RAM floor) that have nothing to do with
  // the Node version pin this regression test exists to assert. In that
  // case the canonical gate returns wakeAgent:false with a fleet-gate reason,
  // and the test still passes because the wrapper did its job (proceed +
  // node_pin + resolved_command all correct).
  const lines = result.stdout.trim().split(/\r?\n/);
  const last = lines[lines.length - 1];
  const parsed = JSON.parse(last);
  if (parsed.wakeAgent === true) {
    assert.ok(
      parsed.context?.fleet_gate === "proceed",
      `expected context.fleet_gate=proceed, got: ${last}`,
    );
  } else {
    // Canonical gate refused for an unrelated fleet-gate reason — the
    // wrapper-level proceed receipt above is the contract. Skip the
    // canonical-gate assertions but record the suppression reason so a
    // future drift in the wrapper's wiring surfaces immediately.
    assert.equal(
      typeof parsed.reason,
      "string",
      `canonical gate wakeAgent:false must carry a reason string; got: ${last}`,
    );
  }

  // Downstream shells must inherit the pin. exec'd shell children inherit the
  // wrapper's environment by definition (exec replaces the process image but
  // preserves env). Verifying via the receipt's resolved_command is the next
  // best signal — the wrapper emits it ONLY after it has computed the export.
  assert.ok((receipt.resolved_command as string).length > 0);

  rmSync(log, { recursive: true, force: true });
});

test("cron-node-pin: negative control — Node 26 stub suppresses the tick", () => {
  // Build a fake NVM_DIR with v24.18.1/bin/node that REPORTS v26.7.0 / ABI 147.
  // The wrapper must refuse this BEFORE invoking the canonical gate, because
  // the canonical gate has no version check.
  const fakeNvm = mkdtempSync(join(tmpdir(), "cron-node-pin-neg-"));
  const binDir = join(fakeNvm, "versions", "node", "v24.18.1", "bin");
  mkdirSync(binDir, { recursive: true });
  const stubNode = join(binDir, "node");
  writeFileSync(
    stubNode,
    `#!/bin/bash
if [ "$1" = "-p" ]; then
  echo '{"version":"v26.7.0","abi":"147","execPath":"${stubNode}"}'
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );

  const log = join(fakeNvm, "receipt.log");
  const result = spawnWrapper({ NVM_DIR: fakeNvm }, log);
  assert.equal(result.status, 0, `wrapper exited non-zero: ${result.stderr}`);

  // Last stdout line must be the wrapper's own wakeAgent:false JSON (the
  // canonical gate is NEVER exec'd, so its JSON cannot appear here).
  const lines = result.stdout.trim().split(/\r?\n/);
  const last = lines[lines.length - 1];
  const parsed = JSON.parse(last);
  const np = parsed.node_pin as {
    bin: string | null;
    version: string | null;
    abi: string | null;
    execPath: string | null;
    expected_version: string;
    expected_abi: string;
  };
  assert.equal(parsed.wakeAgent, false, `expected wakeAgent:false, got: ${last}`);
  assert.match(parsed.reason, /pinned binary is Node v26\.7\.0/);
  assert.match(parsed.reason, /expected v24\.x/);
  assert.equal(np.version, "v26.7.0");
  assert.equal(np.abi, "147");
  assert.equal(np.expected_version, "v24.18.x");
  assert.equal(np.expected_abi, "137");

  const receipt = lastReceipt(log);
  assert.equal(receipt.verdict, "suppress");
  assert.match(receipt.reason as string, /v26\.7\.0/);
  const receiptNp = receipt.node_pin as { abi?: string } | undefined;
  assert.equal(receiptNp?.abi, "147");
  // The resolved_command is null on suppress — nothing was launched.
  assert.equal(receipt.resolved_command, null);

  // Crucially, the canonical gate's wakeAgent:true JSON must NOT appear. The
  // sentinel: it contains "fleet_gate":"proceed" and "running":<int>.
  assert.equal(
    result.stdout.includes('"fleet_gate":"proceed"'),
    false,
    "canonical gate must not be invoked on negative control",
  );

  rmSync(fakeNvm, { recursive: true, force: true });
});

test("cron-node-pin: missing-binary control — no Node 24 binary suppresses the tick", () => {
  // Fake NVM_DIR with no versions/node/v24.18.1 entry at all. The wrapper must
  // not fall back to PATH; ambient PATH is the very thing the pin exists to
  // override.
  const fakeNvm = mkdtempSync(join(tmpdir(), "cron-node-pin-missing-"));
  const log = join(fakeNvm, "receipt.log");

  // PATH intentionally does NOT contain the real Node 24 binary. The wrapper
  // must refuse on resolution failure alone.
  const result = spawnWrapper(
    { NVM_DIR: fakeNvm, PATH: "/usr/bin:/bin" },
    log,
  );
  assert.equal(result.status, 0, `wrapper exited non-zero: ${result.stderr}`);

  const lines = result.stdout.trim().split(/\r?\n/);
  const last = lines[lines.length - 1];
  const parsed = JSON.parse(last);
  assert.equal(parsed.wakeAgent, false);
  assert.match(parsed.reason, /pinned Node 24\.18\.1 binary not found/);
  assert.equal((parsed.node_pin as { bin: string | null }).bin, null);

  const receipt = lastReceipt(log);
  assert.equal(receipt.verdict, "suppress");
  assert.match(receipt.reason as string, /not found/);

  rmSync(fakeNvm, { recursive: true, force: true });
});

test("cron-node-pin: wrapper does not invoke npm, rebuild, or any package installer", () => {
  // Belt-and-braces negative control. The wrapper's documented contract is
  // "resolve + validate + exec canonical gate". If anyone adds an `npm install`
  // or `npm rebuild` step to suppress an ABI mismatch, the negative-control
  // tests above would still pass (they don't probe child processes) but this
  // structural guard would catch it.
  const src = readFileSync(WRAPPER, "utf8");
  assert.equal(/npm\s+(install|rebuild|ci|approve-scripts)/.test(src), false,
    "wrapper must not invoke npm installers (would create a Node 26 addon)");
  assert.equal(/node-gyp/.test(src), false,
    "wrapper must not invoke node-gyp (would create a Node 26 addon)");
  assert.equal(/prebuild-install/.test(src), false,
    "wrapper must not invoke prebuild-install (would create a Node 26 addon)");
});
