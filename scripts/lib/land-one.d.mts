// Type declarations for scripts/lib/land-one.mjs.
// Mirrors the JSDoc typedefs in the .mjs so tsc (with the lane's strict settings)
// accepts the import from test/land-one.test.ts without implicit-any errors.

export type { Candidate, GitShell } from "./merge-train.mjs";

export function pickOldestVerified(args: {
  git: import("./merge-train.mjs").GitShell;
  trainBranch: string;
  onlyNames?: string[] | null;
}): {
  candidate: import("./merge-train.mjs").Candidate | null;
  allCandidates: import("./merge-train.mjs").Candidate[];
  reason?: string;
};

export function oldestByDate(
  clean: import("./merge-train.mjs").Candidate[],
  tipDate: (sha: string) => string,
): import("./merge-train.mjs").Candidate;

export function buildFixCardBody(args: {
  branch: string;
  sha: string;
  repo: string;
  reason: string;
  logPath?: string;
}): string;

export function buildLandCommand(args: {
  branch: string;
  repo: string;
}): string;

export function detectVerifierCommand(args: {
  repo: string;
  hasTypecheck: boolean;
  hasBuild: boolean;
  hasTest: boolean;
}): string | null;