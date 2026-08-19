// Pure library for worktree-dog.mjs — the "worktree dog" that lists stale
// worktrees and emits prune commands (print only, never executes).
//
// A worktree is "stale" if:
//   (a) its branch tip has been merged into main, OR
//   (b) its last commit is older than `staleDays` (default 7).
//
// The library functions are unit-testable without spawning git.

/**
 * @typedef {{
 *   path: string,
 *   head: string,
 *   branch: string | null,
 *   detached: boolean,
 * }} WorktreeEntry
 */

/**
 * @typedef {{
 *   entry: WorktreeEntry,
 *   stale: boolean,
 *   reason: string,
 *   daysAgo: number | null,
 *   merged: boolean,
 * }} StaleVerdict
 */

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 *
 * @param {string} porcelain - raw `git worktree list --porcelain` output
 * @returns {WorktreeEntry[]}
 */
export function parseWorktreeList(porcelain) {
  const entries = [];
  const blocks = porcelain.split("\n\n").filter((b) => b.trim());
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    let entry = { path: "", head: "", branch: null, detached: false };
    for (const line of lines) {
      if (line.startsWith("worktree ")) entry.path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) entry.head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) entry.branch = line.slice("branch ".length);
      else if (line === "detached") entry.detached = true;
    }
    if (entry.path) entries.push(entry);
  }
  return entries;
}

/**
 * Classify a single worktree as stale or not.
 *
 * @param {{
 *   entry: WorktreeEntry,
 *   mergedIntoMain: boolean,
 *   daysAgo: number | null,
 *   staleDays: number,
 * }} args
 * @returns {StaleVerdict}
 */
export function classifyWorktree({ entry, mergedIntoMain, daysAgo, staleDays }) {
  const reasons = [];
  if (mergedIntoMain) reasons.push("merged into main");
  if (daysAgo !== null && daysAgo >= staleDays) reasons.push(`no commit in ${daysAgo} days (>= ${staleDays})`);
  const stale = reasons.length > 0;
  return {
    entry,
    stale,
    reason: stale ? reasons.join("; ") : "active",
    daysAgo,
    merged: mergedIntoMain,
  };
}

/**
 * Build the prune command for a stale worktree (print only — never executed).
 *
 * @param {{ repoRoot: string, worktreePath: string }} args
 * @returns {string}
 */
export function buildPruneCommand({ repoRoot, worktreePath }) {
  return `git -C ${repoRoot} worktree remove --force ${worktreePath}`;
}

/**
 * Filter worktree entries by whether their path starts with any of the given
 * directory prefixes. Used to restrict the scan to the configured directories.
 *
 * @param {WorktreeEntry[]} entries
 * @param {string[]} dirs - directory prefixes to match
 * @returns {WorktreeEntry[]}
 */
export function filterByDirs(entries, dirs) {
  if (!dirs || dirs.length === 0) return entries;
  return entries.filter((e) => dirs.some((d) => e.path.startsWith(d)));
}