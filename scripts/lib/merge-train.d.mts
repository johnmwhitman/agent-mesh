// Type declarations for scripts/lib/merge-train.mjs.
//
// The `.mjs` is runnable as plain ESM by Node (typed via JSDoc in-source), but
// the test file imports it from TypeScript-land. Without this declaration
// file, `tsc` (with the lane's strict settings) refuses the import as implicit
// `any`. The declaration mirrors the JSDoc typedefs in the .mjs so both surfaces
// agree.

export type ShellResult = {
  stdout: string;
  stderr: string;
  status: number;
  error?: Error;
};

export type MergeTreeVerdict =
  | { clean: true }
  | { clean: false; reason: string };

export type GitShell = {
  originMain: () => string;
  listBranches: () => Array<{ name: string; sha: string }>;
  tipSubject: (sha: string) => string;
  tipAuthor: (sha: string) => string;
  isAheadOfMain: (sha: string) => boolean;
  mergeTreeClean: (sha: string) => MergeTreeVerdict;
  diffstat: (sha: string) => string;
  filesChanged: (sha: string) => string[];
  aheadCount: (sha: string) => number;
  isAncestor: (a: string, b: string) => boolean;
};

export type Candidate = {
  name: string;
  sha: string;
  subject: string;
  aheadCount: number;
  kind: "verified" | "unverified";
  author?: string;
  files?: string[];
  diffstat?: string;
  mergeTree: MergeTreeVerdict;
};

export function pickCandidates(args: {
  trainBranch: string;
  onlyNames: string[] | null;
  git: GitShell;
}): Candidate[];

export function makeShell(
  sh: (cmd: string, args: string[], opts?: any) => ShellResult,
): GitShell;

export function makeShellFromSpawn(): GitShell;
