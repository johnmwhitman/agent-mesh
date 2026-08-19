// Pure library for the merge-train script. Keeping `pickCandidates` in a
// separate file makes it unit-testable without spawning the full
// scripts/merge-train.mjs (which writes a report file based on `process.cwd()`
// and runs the canonical verifier on `--apply`). The CLI is a thin shim in
// scripts/merge-train.mjs.

import { spawnSync } from "node:child_process";

/**
 * @typedef {{ stdout: string; stderr: string; status: number; error?: Error }} ShellResult
 */

/**
 * @typedef {{
 *   originMain: () => string,
 *   listBranches: () => Array<{ name: string; sha: string }>,
 *   tipSubject: (sha: string) => string,
 *   tipAuthor: (sha: string) => string,
 *   isAheadOfMain: (sha: string) => boolean,
 *   mergeTreeClean: (sha: string) => { clean: true } | { clean: false; reason: string },
 *   diffstat: (sha: string) => string,
 *   filesChanged: (sha: string) => string[],
 *   aheadCount: (sha: string) => number,
 *   isAncestor: (a: string, b: string) => boolean,
 * }} GitShell
 */

/**
 * @typedef {{
 *   name: string,
 *   sha: string,
 *   subject: string,
 *   aheadCount: number,
 *   kind: "verified" | "unverified",
 *   author?: string,
 *   files?: string[],
 *   diffstat?: string,
 *   mergeTree: { clean: true } | { clean: false; reason: string },
 * }} Candidate
 */

/** @type {(cmd: string, args: string[], opts?: { env?: Record<string, string|undefined>; cwd?: string }) => ShellResult} */
function shFn(cmd, args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || process.cwd(),
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    status: res.status === null ? (res.error ? 1 : 0) : res.status,
    error: res.error,
  };
}

/** @type {(sh: (cmd: string, args: string[], opts?: any) => ShellResult) => GitShell} */
function makeShell(sh) {
  // The function shape `(cmd, args, opts?) -> { stdout, stderr, status }` (matches
  // what scripts/merge-train.mjs builds). No dependency on child_process so this
  // is also unit-testable with a mock.
  return {
    originMain: () => sh("git", ["rev-parse", "origin/main"]).stdout.trim(),
    listBranches() {
      const r = sh("git", ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"]);
      if (r.status !== 0) return [];
      return r.stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const i = l.indexOf(" ");
          return { name: l.slice(0, i), sha: l.slice(i + 1) };
        });
    },
    tipSubject: (sha) => sh("git", ["log", "-1", "--format=%s", sha]).stdout.trim(),
    tipAuthor: (sha) => sh("git", ["log", "-1", "--format=%an <%ae>", sha]).stdout.trim(),
    isAheadOfMain(sha) {
      const om = this.originMain();
      if (sha === om) return false;
      return sh("git", ["merge-base", "--is-ancestor", "origin/main", sha]).status === 0;
    },
    mergeTreeClean(sha) {
      const r = sh("git", ["merge-tree", "origin/main", sha]);
      if (r.status !== 0) return { clean: false, reason: `merge-tree exit ${r.status}` };
      if (r.stdout.includes("<<<<<<<")) return { clean: false, reason: "merge-tree reports textual conflict markers" };
      return { clean: true };
    },
    diffstat: (sha) => sh("git", ["diff", "--stat", "origin/main", sha]).stdout.trim(),
    filesChanged(sha) {
      const r = sh("git", ["diff", "--name-only", "origin/main", sha]);
      if (r.status !== 0) return [];
      return r.stdout.trim().split("\n").filter(Boolean);
    },
    aheadCount: (sha) => +sh("git", ["rev-list", "--count", `origin/main..${sha}`]).stdout.trim(),
    isAncestor: (a, b) => sh("git", ["merge-base", "--is-ancestor", a, b]).status === 0,
  };
}

/**
 * @param {{ trainBranch: string, onlyNames: string[] | null, git: GitShell }} args
 * @returns {Candidate[]}
 */
export function pickCandidates({ trainBranch, onlyNames, git }) {
  const branches = git.listBranches();
  const allAhead = [];
  for (const b of branches) {
    if (b.name === trainBranch) continue;
    if (onlyNames && !onlyNames.includes(b.name)) continue;
    if (!git.isAheadOfMain(b.sha)) continue;
    const subject = git.tipSubject(b.sha);
    const aheadCount = Number.isFinite(git.aheadCount(b.sha)) ? git.aheadCount(b.sha) : 0;
    allAhead.push({
      name: b.name,
      sha: b.sha,
      subject,
      aheadCount,
      kind: subject.startsWith("VERIFIED:") ? "verified" : "unverified",
    });
  }

  // For each pair, mark the smaller one redundant iff a VERIFIED superset exists.
  // If only an unverified superset exists, the verified smaller one stays — the
  // unverified superset will be reported as a leftover with a different reason.
  const redundant = new Set();
  for (const a of allAhead) {
    if (redundant.has(a.name)) continue;
    let hasVerifiedSuperset = false;
    for (const c of allAhead) {
      if (c.sha === a.sha) continue;
      if (c.kind !== "verified") continue;
      if (git.isAncestor(a.sha, c.sha)) {
        hasVerifiedSuperset = true;
        break;
      }
    }
    if (hasVerifiedSuperset) redundant.add(a.name);
  }

  // Survivors: those that weren't marked redundant AND carry a VERIFIED claim.
  const survivors = allAhead.filter((c) => !redundant.has(c.name) && c.kind === "verified");

  const out = [];
  for (const c of survivors) {
    const clean = git.mergeTreeClean(c.sha);
    out.push({
      ...c,
      author: git.tipAuthor(c.sha),
      files: git.filesChanged(c.sha),
      diffstat: git.diffstat(c.sha),
      mergeTree: clean,
    });
  }
  out.sort((a, b) => a.subject.localeCompare(b.subject));

  for (const c of allAhead) {
    if (survivors.includes(c)) continue;
    let reason;
    if (redundant.has(c.name)) {
      reason = "strict ancestor of a larger verified branch on the train (work is included in the superset's --no-ff merge)";
    } else {
      reason = "tip subject does not begin with 'VERIFIED:' (spec gate)";
    }
    out.push({
      ...c,
      author: git.tipAuthor(c.sha),
      files: git.filesChanged(c.sha),
      diffstat: git.diffstat(c.sha),
      mergeTree: { clean: false, reason },
    });
  }
  return out;
}

/** @type {() => GitShell} */
export function makeShellFromSpawn() {
  return makeShell(shFn);
}

/**
 * Classify a branch's last-activity age into a staleness bucket.
 * Bands scale proportionally to `staleDays` so a tighter threshold tightens
 * the bands. Naive UTC-day math — git tip dates are ISO 8601 with timezone,
 * and the rounding matters for index-of-arrival comparisons.
 *
 * @param {number} days calendar days since tip commit (Infinity = no parse)
 * @param {number} staleDays fresh-band ceiling in days (default 30)
 * @returns {"fresh"|"stale"|"suspect"|"dead"}
 */
export function classifyStaleness(days, staleDays = 30) {
  if (!Number.isFinite(days)) return "dead";
  const sd = Math.max(1, staleDays | 0);
  if (days <= sd) return "fresh";
  if (days <= sd * 6) return "stale";
  if (days <= sd * 12) return "suspect";
  return "dead";
}

export { makeShell };
