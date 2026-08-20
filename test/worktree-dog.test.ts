// worktree-dog unit tests.
//
// These tests cover parseWorktreeList, classifyWorktree, buildPruneCommand,
// and filterByDirs from scripts/lib/worktree-dog.mjs. They use sample
// `git worktree list --porcelain` output, so no real git is spawned.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseWorktreeList, classifyWorktree, buildPruneCommand, filterByDirs } from "../scripts/lib/worktree-dog.mjs";

const SAMPLE_PORCELAIN = `worktree /Users/john/AI/agent-mesh
HEAD 50277ed169751836b329c4e8c5eceab36e2294fb
branch refs/heads/feat/d2.1-receipt-timeline

worktree /Users/john/AI/.worktrees/agent-mesh-4c1-exhaustive-20260817
HEAD cd3cdc25891f95593672c742643a1eaa0f0c22c9
branch refs/heads/feat/4c1-exhaustive-profile-gates-20260817

worktree /tmp/mf-c571928-fGneW
HEAD c571928322a8628c01f7d2804fcaa2eb3dd80802
detached
`;

test("parseWorktreeList: parses multiple worktree entries", () => {
  const entries = parseWorktreeList(SAMPLE_PORCELAIN);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].path, "/Users/john/AI/agent-mesh");
  assert.equal(entries[0].branch, "refs/heads/feat/d2.1-receipt-timeline");
  assert.equal(entries[0].detached, false);
  assert.equal(entries[1].path, "/Users/john/AI/.worktrees/agent-mesh-4c1-exhaustive-20260817");
  assert.equal(entries[2].detached, true);
  assert.equal(entries[2].branch, null);
});

test("parseWorktreeList: empty input returns empty array", () => {
  assert.deepEqual(parseWorktreeList(""), []);
  assert.deepEqual(parseWorktreeList("   \n  "), []);
});

test("classifyWorktree: merged into main is stale", () => {
  const verdict = classifyWorktree({
    entry: { path: "/x", head: "abc123", branch: "refs/heads/feat/merged", detached: false },
    mergedIntoMain: true,
    daysAgo: 1,
    staleDays: 7,
  });
  assert.ok(verdict.stale);
  assert.ok(verdict.reason.includes("merged into main"));
  assert.equal(verdict.merged, true);
});

test("classifyWorktree: old commit is stale", () => {
  const verdict = classifyWorktree({
    entry: { path: "/x", head: "abc123", branch: null, detached: true },
    mergedIntoMain: false,
    daysAgo: 10,
    staleDays: 7,
  });
  assert.ok(verdict.stale);
  assert.ok(verdict.reason.includes("no commit in 10 days"));
});

test("classifyWorktree: both merged and old lists both reasons", () => {
  const verdict = classifyWorktree({
    entry: { path: "/x", head: "abc123", branch: "refs/heads/feat/old", detached: false },
    mergedIntoMain: true,
    daysAgo: 30,
    staleDays: 7,
  });
  assert.ok(verdict.stale);
  assert.ok(verdict.reason.includes("merged into main"));
  assert.ok(verdict.reason.includes("no commit in 30 days"));
});

test("classifyWorktree: recent and unmerged is active", () => {
  const verdict = classifyWorktree({
    entry: { path: "/x", head: "abc123", branch: "refs/heads/feat/active", detached: false },
    mergedIntoMain: false,
    daysAgo: 2,
    staleDays: 7,
  });
  assert.ok(!verdict.stale);
  assert.equal(verdict.reason, "active");
});

test("classifyWorktree: exactly at staleDays boundary is stale", () => {
  const verdict = classifyWorktree({
    entry: { path: "/x", head: "abc123", branch: null, detached: true },
    mergedIntoMain: false,
    daysAgo: 7,
    staleDays: 7,
  });
  assert.ok(verdict.stale, "daysAgo == staleDays should be stale (>=)");
});

test("classifyWorktree: null daysAgo with not-merged is active", () => {
  const verdict = classifyWorktree({
    entry: { path: "/x", head: "abc123", branch: null, detached: true },
    mergedIntoMain: false,
    daysAgo: null,
    staleDays: 7,
  });
  assert.ok(!verdict.stale);
});

test("buildPruneCommand: produces git worktree remove --force command", () => {
  const cmd = buildPruneCommand({ repoRoot: "/path/to/repo", worktreePath: "/path/to/wt" });
  assert.ok(cmd.includes("git -C /path/to/repo"));
  assert.ok(cmd.includes("worktree remove --force"));
  assert.ok(cmd.includes("/path/to/wt"));
});

test("filterByDirs: filters entries by directory prefix", () => {
  const entries = [
    { path: "/Users/john/AI/.worktrees/agent-mesh-foo", head: "abc", branch: null, detached: false },
    { path: "/Users/john/AI/agent-mesh/.worktrees/bar", head: "def", branch: null, detached: false },
    { path: "/Users/john/AI/routeplane-lanes/baz", head: "ghi", branch: null, detached: false },
    { path: "/Users/john/some-other-dir", head: "jkl", branch: null, detached: false },
  ];
  const dirs = ["/Users/john/AI/.worktrees/", "/Users/john/AI/routeplane-lanes/"];
  const filtered = filterByDirs(entries, dirs);
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].path, "/Users/john/AI/.worktrees/agent-mesh-foo");
  assert.equal(filtered[1].path, "/Users/john/AI/routeplane-lanes/baz");
});

test("filterByDirs: empty dirs returns all entries", () => {
  const entries = [
    { path: "/x", head: "a", branch: null, detached: false },
    { path: "/y", head: "b", branch: null, detached: false },
  ];
  assert.equal(filterByDirs(entries, []).length, 2);
  assert.equal(filterByDirs(entries, []).length, 2);
});