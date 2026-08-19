#!/usr/bin/env node
// land-one.mjs — Refinery-lite (DRY-RUN ONLY).
//
// Picks the single oldest VERIFIED green branch per merge-train dossier,
// rebases it onto origin/main in a throwaway worktree, runs the repo's
// verifier, and either:
//   GREEN → prints the exact one-line command John would run to land it.
//   RED   → emits a kanban-ready 'fix' card body (not a human-inbox item).
//
// John ratifies before any real landing. This script never merges, pushes,
// or mutates the repo's main branch. The throwaway worktree is cleaned up
// on exit.
//
// Usage: scripts/land-one.mjs <repo> [--branch <name>] [--verbose]
//   <repo>           absolute path to the repo (required)
//   --branch <name>  restrict to a specific branch
//   --verbose        print full verifier output

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pickCandidates, makeShell } from "./lib/merge-train.mjs";
import { pickOldestVerified, oldestByDate, buildFixCardBody, buildLandCommand, detectVerifierCommand } from "./lib/land-one.mjs";

function shFn(cmd, args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || process.cwd(),
    env,
    encoding: "utf8",
    stdio: [opts.stdio || "ignore", "pipe", "pipe"],
  });
  return {
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    status: res.status === null ? (res.error ? 1 : 0) : res.status,
    error: res.error,
  };
}

function parseArgs(argv) {
  const out = { repo: null, branch: null, verbose: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--branch" && argv[i + 1]) out.branch = argv[++i];
    else if (a === "--verbose") out.verbose = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (!out.repo && !a.startsWith("-")) out.repo = a;
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return out;
}

function usage() {
  console.log("Usage: scripts/land-one.mjs <repo> [--branch <name>] [--verbose]");
  console.log("");
  console.log("  <repo>           absolute path to the repo (required)");
  console.log("  --branch <name>  restrict to a specific branch");
  console.log("  --verbose        print full verifier output");
  console.log("");
  console.log("DRY-RUN ONLY: never lands, pushes, or mutates main. Prints the land command or a fix card body.");
}

const TODAY = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const TRAIN_BRANCH = `land-one/${TODAY}`;

function resolveNodeBinary() {
  if (process.env.NODE_24_18_1_BIN) return process.env.NODE_24_18_1_BIN;
  const nvmRoot = process.env.NVM_DIR || join(process.env.HOME || "", ".nvm");
  return join(nvmRoot, "versions", "node", "v24.18.1", "bin", "node");
}

function tipDate(repo, sha) {
  return shFn("git", ["-C", repo, "log", "-1", "--format=%cI", sha]).stdout.trim();
}

function hasNpmScript(repo, script) {
  try {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    return !!(pkg.scripts && pkg.scripts[script]);
  } catch {
    return false;
  }
}

function runVerifierInWorktree(worktreePath, verbose) {
  const nodeBin = resolveNodeBinary();
  if (!existsSync(nodeBin)) {
    return { ok: false, reason: `pinned Node 24.18.1 binary missing at ${nodeBin}` };
  }
  const env = {
    ...process.env,
    MESHFLEET_EVENT_LOG_FILE: join(worktreePath, "verify-events.log"),
    PATH: `${dirname(nodeBin)}:${process.env.PATH || ""}`,
  };
  delete env.MESHFLEET_DATA_FILE;

  const tc = shFn("npm", ["run", "typecheck"], { cwd: worktreePath, env, stdio: verbose ? "inherit" : undefined });
  if (tc.status !== 0) return { ok: false, reason: `typecheck exit ${tc.status}`, logPath: join(worktreePath, "typecheck.log") };

  const bd = shFn("npm", ["run", "build"], { cwd: worktreePath, env, stdio: verbose ? "inherit" : undefined });
  if (bd.status !== 0) return { ok: false, reason: `build exit ${bd.status}`, logPath: join(worktreePath, "build.log") };

  const ts = shFn(nodeBin, ["scripts/run-tests.mjs"], { cwd: worktreePath, env, stdio: verbose ? "inherit" : undefined });
  const measured = (ts.stdout || "").match(/# tests (\d+)/)?.[1] || "?";
  if (ts.status !== 0) {
    // Extract first few failure descriptions
    const fails = (ts.stdout || "").split("\n").filter((l) => l.startsWith("not ok ")).slice(0, 5);
    const failSummary = fails.length > 0 ? fails.join("; ") : `run-tests exit ${ts.status}`;
    return { ok: false, reason: `run-tests RED: ${failSummary}`, logPath: join(worktreePath, "test.log"), measured };
  }
  return { ok: true, measured };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); return; }
  if (!args.repo) {
    console.error("ERROR: <repo> is required (absolute path to the repo)");
    usage();
    process.exit(2);
  }

  const repo = resolve(args.repo);
  if (!existsSync(repo)) {
    console.error(`ERROR: repo path does not exist: ${repo}`);
    process.exit(3);
  }
  if (!existsSync(join(repo, ".git"))) {
    console.error(`ERROR: not a git repo: ${repo}`);
    process.exit(3);
  }

  console.log(`[land-one] repo=${repo} mode=DRY-RUN`);

  // Build a GitShell anchored at the repo.
  const sh = (cmd, cmdArgs, opts = {}) => {
    const env = { ...process.env, ...(opts.env || {}) };
    const res = spawnSync(cmd, cmdArgs, {
      cwd: opts.cwd || repo,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      stdout: res.stdout || "",
      stderr: res.stderr || "",
      status: res.status === null ? (res.error ? 1 : 0) : res.status,
    };
  };
  const git = makeShell(sh);

  // Pick candidates.
  const onlyNames = args.branch ? [args.branch] : null;
  const { candidate, allCandidates, reason } = pickOldestVerified({
    git,
    trainBranch: TRAIN_BRANCH,
    onlyNames,
  });

  if (!candidate) {
    console.log(`[land-one] no clean VERIFIED candidate: ${reason}`);
    console.log(`[land-one] all candidates scanned: ${allCandidates.length}`);
    for (const c of allCandidates) {
      const status = c.mergeTree.clean ? "clean" : `leftover (${c.mergeTree.reason})`;
      console.log(`  ${c.name} — ${c.kind} — ${status}`);
    }
    process.exit(0);
  }

  // Re-sort clean candidates by actual commit date (oldest first).
  const cleanVerified = allCandidates.filter((c) => c.mergeTree.clean && c.kind === "verified");
  const oldest = oldestByDate(cleanVerified, (sha) => tipDate(repo, sha));

  console.log(`[land-one] picked oldest: ${oldest.name} (${oldest.sha.slice(0, 7)}) — ${oldest.subject}`);
  console.log(`[land-one] ahead of origin/main by ${oldest.aheadCount} commit(s)`);

  // Detect verifier command for the repo.
  const verifierCmd = detectVerifierCommand({
    repo,
    hasTypecheck: hasNpmScript(repo, "typecheck"),
    hasBuild: hasNpmScript(repo, "build"),
    hasTest: hasNpmScript(repo, "test"),
  });
  if (!verifierCmd) {
    console.log(`[land-one] WARNING: no npm typecheck/build/test scripts found; skipping verifier run`);
    console.log(`[land-one] would print land command (unverified):`);
    console.log(`  ${buildLandCommand({ branch: oldest.name, repo })}`);
    process.exit(0);
  }
  console.log(`[land-one] verifier: ${verifierCmd}`);

  // Create a throwaway worktree off origin/main.
  const worktreeDir = mkdtempSync(join(tmpdir(), `land-one-${TODAY}-`));
  const worktreePath = join(worktreeDir, "wt");
  console.log(`[land-one] creating throwaway worktree at ${worktreePath}`);

  const wtAdd = shFn("git", [
    "-C", repo, "worktree", "add", "--detach",
    worktreePath, "origin/main",
  ]);
  if (wtAdd.status !== 0) {
    console.error(`[land-one] ERROR: worktree add failed: ${(wtAdd.stderr || wtAdd.stdout || "").trim()}`);
    try { rmSync(worktreeDir, { recursive: true, force: true }); } catch {}
    process.exit(4);
  }

  let cleanupDone = false;
  function cleanupWorktree() {
    if (cleanupDone) return;
    cleanupDone = true;
    try {
      shFn("git", ["-C", repo, "worktree", "remove", "--force", worktreePath]);
    } catch {}
    try { rmSync(worktreeDir, { recursive: true, force: true }); } catch {}
  }

  // worktree add with --detach already checks out origin/main.
  // Now detach to the candidate branch tip and rebase onto origin/main.
  // Since the branch may already be checked out in another worktree, we
  // can't `git rebase origin/main <branch>` directly. Instead, we create a
  // detached HEAD at the branch tip and rebase that onto origin/main.
  console.log(`[land-one] rebasing ${oldest.name} onto origin/main...`);
  const checkout = shFn("git", ["-C", worktreePath, "checkout", "--detach", oldest.sha]);
  if (checkout.status !== 0) {
    console.log(`[land-one] CHECKOUT FAILED — cannot detach to ${oldest.sha.slice(0, 7)}`);
    console.log(`[land-one] output: ${(checkout.stderr || checkout.stdout || "").trim().split("\n").slice(0, 3).join(" | ")}`);
    cleanupWorktree();
    process.exit(5);
  }
  const rebase = shFn("git", ["-C", worktreePath, "rebase", "origin/main"]);
  if (rebase.status !== 0) {
    console.log(`[land-one] REBASE CONFLICT — branch does not rebase cleanly onto origin/main`);
    console.log(`[land-one] rebase output: ${(rebase.stderr || rebase.stdout || "").trim().split("\n").slice(0, 5).join(" | ")}`);
    shFn("git", ["-C", worktreePath, "rebase", "--abort"]);
    // Emit fix card body.
    const fixBody = buildFixCardBody({
      branch: oldest.name,
      sha: oldest.sha,
      repo,
      reason: `rebase conflict onto origin/main — ${(rebase.stderr || "").trim().split("\n")[0] || "see output"}`,
    });
    console.log("");
    console.log("=== FIX CARD BODY (kanban-ready) ===");
    console.log(fixBody);
    console.log("=== END FIX CARD BODY ===");
    cleanupWorktree();
    process.exit(0);
  }

  // Install deps if needed (node_modules might not exist in worktree).
  if (existsSync(join(repo, "package.json")) && !existsSync(join(worktreePath, "node_modules"))) {
    console.log(`[land-one] installing dependencies in worktree...`);
    const npmInstall = shFn("npm", ["install", "--no-audit", "--no-fund"], { cwd: worktreePath, stdio: "pipe" });
    if (npmInstall.status !== 0) {
      console.log(`[land-one] npm install failed: ${(npmInstall.stderr || npmInstall.stdout || "").trim().split("\n").slice(0, 3).join(" | ")}`);
      // Try to proceed anyway — some tests may not need all deps
    }
  }

  // Run the verifier in the worktree.
  console.log(`[land-one] running verifier in worktree...`);
  const verify = runVerifierInWorktree(worktreePath, args.verbose);

  if (verify.ok) {
    console.log(`[land-one] verifier GREEN — ${verify.measured} tests`);
    console.log("");
    console.log("=== LAND COMMAND (John ratifies before running) ===");
    console.log(`  ${buildLandCommand({ branch: oldest.name, repo })}`);
    console.log("=== END LAND COMMAND ===");
    console.log("");
    console.log(`[land-one] DRY-RUN complete. Branch ${oldest.name} is green on origin/main.`);
    console.log(`[land-one] John runs the command above to land it. No push, no merge performed by this script.`);
  } else {
    console.log(`[land-one] verifier RED — ${verify.reason}`);
    const fixBody = buildFixCardBody({
      branch: oldest.name,
      sha: oldest.sha,
      repo,
      reason: verify.reason,
      logPath: verify.logPath,
    });
    console.log("");
    console.log("=== FIX CARD BODY (kanban-ready) ===");
    console.log(fixBody);
    console.log("=== END FIX CARD BODY ===");
  }

  cleanupWorktree();
  console.log(`[land-one] throwaway worktree cleaned up`);
}

main();