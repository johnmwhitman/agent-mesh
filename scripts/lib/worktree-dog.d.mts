// Type declarations for scripts/lib/worktree-dog.mjs.

export type WorktreeEntry = {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
};

export type StaleVerdict = {
  entry: WorktreeEntry;
  stale: boolean;
  reason: string;
  daysAgo: number | null;
  merged: boolean;
};

export function parseWorktreeList(porcelain: string): WorktreeEntry[];

export function classifyWorktree(args: {
  entry: WorktreeEntry;
  mergedIntoMain: boolean;
  daysAgo: number | null;
  staleDays: number;
}): StaleVerdict;

export function buildPruneCommand(args: {
  repoRoot: string;
  worktreePath: string;
}): string;

export function filterByDirs(entries: WorktreeEntry[], dirs: string[]): WorktreeEntry[];