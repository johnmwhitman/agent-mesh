#!/usr/bin/env node
// worktree-dog.mjs — stale worktree reaper (PRINT ONLY).
//
// Lists stale worktrees (merged into main OR no commit in 7 days) under:
//   routeplane-lanes/, solreign-trees/, sf-lanes/, .worktrees/,
//   agent-mesh/.worktrees/
//
// Prints prune commands only — never executes them. John decides whether
// to run the printed commands.
//
// Usage: scripts/worktree-dog.mjs [--stale-days N] [--repo <path>] [--json]
//   --stale-days N  stale threshold in days (default 7)
//   --repo <path>   repo root to scan worktrees from (default: cwd)
//   --json          emit JSON instead of human-readable text

import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { parseWorktreeList, classifyWorktree, buildPruneCommand, filterByDirs } from "./lib/worktree-dog.mjs";

function shFn(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || process.cwd(),
    encoding: "utf8",
    stdio: [opts.stdio || "ignore", "pipe", "pipe"],
  });
  return {
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    status: res.status === null ? (res.error ? 1 : 0) : res.status,
  };
}

function parseArgs(argv) {
  const out = { staleDays: 7, repo: null, json: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stale-days" && argv[i + 1]) out.staleDays = +argv[++i];
    else if (a === "--repo" && argv[i + 1]) out.repo = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return out;
}

function usage() {
  console.log("Usage: scripts/worktree-dog.mjs [--stale-days N] [--repo <path>] [--json]");
  console.log("");
  console.log("  --stale-days N  stale threshold in days (default 7)");
  console.log("  --repo <path>   repo root to scan worktrees from (default: cwd)");
  console.log("  --json          emit JSON instead of human-readable text");
  console.log("");
  console.log("Lists stale worktrees (merged into main OR no commit in N days).");
  console.log("PRINTS prune commands only — never executes them.");
}

// Default scan directories (relative to HOME/AI).
const DEFAULT_SCAN_DIRS = [
  "routeplane-lanes/",
  "solreign-trees/",
  "sf-lanes/",
  ".worktrees/",
  "agent-mesh/.worktrees/",
];

function isMergedIntoMain(repo, head) {
  // Check if the worktree's HEAD commit is an ancestor of origin/main.
  const r = shFn("git", ["-C", repo, "merge-base", "--is-ancestor", head, "origin/main"]);
  return r.status === 0;
}

function worktreeDaysAgo(repo, head) {
  const r = shFn("git", ["-C", repo, "log", "-1", "--format=%cI", head]);
  if (r.status !== 0) return null;
  const iso = r.stdout.trim();
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); return; }

  const repo = resolve(args.repo || process.cwd());
  const home = process.env.HOME || "";
  const aiRoot = join(home, "AI");

  // Expand default scan dirs to absolute paths.
  const scanDirs = DEFAULT_SCAN_DIRS.map((d) => join(aiRoot, d));

  console.log(`[worktree-dog] repo=${repo} staleDays=${args.staleDays}`);
  console.log(`[worktree-dog] scanning under: ${scanDirs.join(", ")}`);

  // Get all worktrees registered in the repo.
  const wtList = shFn("git", ["-C", repo, "worktree", "list", "--porcelain"]);
  if (wtList.status !== 0) {
    console.error(`[worktree-dog] ERROR: git worktree list failed: ${(wtList.stderr || "").trim()}`);
    process.exit(3);
  }

  const allEntries = parseWorktreeList(wtList.stdout);
  // Filter to entries under the scan directories. The main worktree is always
  // excluded (it's the repo root, not a stale tree).
  const filtered = filterByDirs(allEntries, scanDirs).filter((e) => e.path !== repo);

  console.log(`[worktree-dog] ${allEntries.length} total worktrees, ${filtered.length} under scan dirs`);

  const verdicts = [];
  for (const entry of filtered) {
    const merged = isMergedIntoMain(repo, entry.head);
    const daysAgo = worktreeDaysAgo(repo, entry.head);
    const verdict = classifyWorktree({
      entry,
      mergedIntoMain: merged,
      daysAgo,
      staleDays: args.staleDays,
    });
    verdicts.push(verdict);
  }

  // Sort: stale first (merged before stale-by-age), then by daysAgo descending.
  verdicts.sort((a, b) => {
    if (a.stale !== b.stale) return a.stale ? -1 : 1;
    if (a.merged !== b.merged) return a.merged ? -1 : 1;
    const ad = a.daysAgo ?? -1;
    const bd = b.daysAgo ?? -1;
    return bd - ad;
  });

  const stale = verdicts.filter((v) => v.stale);
  const active = verdicts.filter((v) => !v.stale);

  if (args.json) {
    const output = {
      repo,
      staleDays: args.staleDays,
      scanDirs,
      total: allEntries.length,
      scanned: filtered.length,
      staleCount: stale.length,
      activeCount: active.length,
      stale: stale.map((v) => ({
        path: v.entry.path,
        head: v.entry.head.slice(0, 7),
        branch: v.entry.branch,
        detached: v.entry.detached,
        reason: v.reason,
        daysAgo: v.daysAgo,
        merged: v.merged,
        pruneCommand: buildPruneCommand({ repoRoot: repo, worktreePath: v.entry.path }),
      })),
      active: active.map((v) => ({
        path: v.entry.path,
        head: v.entry.head.slice(0, 7),
        branch: v.entry.branch,
        daysAgo: v.daysAgo,
      })),
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Human-readable output.
  if (stale.length === 0) {
    console.log(`[worktree-dog] no stale worktrees found (scanned ${filtered.length})`);
    return;
  }

  console.log("");
  console.log(`=== STALE WORKTREES (${stale.length}) ===`);
  console.log("");
  for (const v of stale) {
    const branch = v.entry.branch ? v.entry.branch.replace("refs/heads/", "") : "(detached)";
    console.log(`  ${v.entry.path}`);
    console.log(`    branch: ${branch}  head: ${v.entry.head.slice(0, 7)}  days: ${v.daysAgo ?? "?"}  reason: ${v.reason}`);
  }

  console.log("");
  console.log("=== PRUNE COMMANDS (print only — John decides) ===");
  console.log("");
  for (const v of stale) {
    console.log(buildPruneCommand({ repoRoot: repo, worktreePath: v.entry.path }));
  }

  if (active.length > 0) {
    console.log("");
    console.log(`=== ACTIVE WORKTREES (${active.length}, not stale) ===`);
    console.log("");
    for (const v of active.slice(0, 20)) {
      const branch = v.entry.branch ? v.entry.branch.replace("refs/heads/", "") : "(detached)";
      console.log(`  ${v.entry.path} — ${branch} — ${v.daysAgo ?? "?"} days ago`);
    }
    if (active.length > 20) {
      console.log(`  ... and ${active.length - 20} more active worktrees`);
    }
  }
}

main();