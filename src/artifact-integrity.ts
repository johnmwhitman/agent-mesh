/**
 * Artifact-integrity check.
 *
 * Gate #4 of `t_db8af59c` (2026-08-26): the wrapper-level success signal
 * (process exit code 0 + `complete` status) is not sufficient evidence that
 * a fleet actually produced the work it was spawned for. The 21+ hour fleet
 * zombie the conductor hand-off named was an extreme case — but the same
 * class of defect ("Fleet OK + 0 outputs") covers any agent that exits 0
 * having produced an empty or stale file. This module computes a
 * per-agent integrity verdict the orchestrator can consult independently of
 * the wrapper's exit code.
 *
 * The verdict has THREE states:
 *   - `consistent` — the agent's declared artifacts all exist, are non-empty,
 *     and were modified at or after the agent's `started_at`. The work is
 *     real and recent.
 *   - `inconsistent` — at least one declared artifact is missing, empty, or
 *     older than the agent's `started_at`. The orchestrator can decide what
 *     to do with this; the result is surfaced so it does not have to re-derive.
 *   - `unverifiable` — the agent row does not carry enough information to
 *     decide (no `started_at`, no declared artifacts, or no envelope on disk).
 *     This is NOT the same as `consistent`; an unverifiable row is one a
 *     human must look at.
 *
 * Pure: the caller injects the existence / mtime / size oracle so the same
 * module can be exercised against a stub in unit tests without touching the
 * real filesystem. The production caller in `collect_results` plugs in
 * `fs.statSync`-based implementations.
 */
import type { Agent } from "./core.js";

export type ArtifactIntegrity = "consistent" | "inconsistent" | "unverifiable";

export interface IntegrityViolation {
  /** Path the agent declared but the oracle rejected. */
  artifact: string;
  /** What was wrong: missing, empty, or pre-start mtime. */
  reason: "missing" | "empty" | "stale";
}

export interface ArtifactIntegrityReport {
  verdict: ArtifactIntegrity;
  violations: IntegrityViolation[];
  /** Number of declared artifacts inspected. `0` when the agent declared none. */
  inspected: number;
}

export interface ArtifactIntegrityOracle {
  /** Return stat-like info, or null when the path is missing. */
  inspect: (path: string) => { size: number; mtimeMs: number } | null;
}

/**
 * Walk the agent's declared artifacts and verdict each. Pure — the caller
 * supplies the filesystem oracle.
 *
 * The agent's declared artifacts come from `result_contract`: when the
 * envelope is `ok` (or `artifact_missing` etc.), the resolved artifact
 * paths are the ones the agent claimed it produced. We do NOT re-read the
 * envelope here — that is `readResultContract`'s job, and this module
 * composes with it. The caller passes in the already-resolved artifact
 * paths; we only stat them.
 *
 * "Stale" means the artifact's mtime is BEFORE the agent's `started_at`.
 * That is the "pre-existing file with the agent's claimed path" failure
 * mode — an agent that points at a file it never modified. A file
 * modified in the same millisecond as `started_at` is treated as
 * consistent (>= comparison) so an agent that finished its first
 * observable write before the spawn finished settling is not punished.
 */
export function computeArtifactIntegrity(
  agent: Agent,
  declaredArtifacts: readonly string[] | undefined,
  oracle: ArtifactIntegrityOracle,
): ArtifactIntegrityReport {
  if (!declaredArtifacts || declaredArtifacts.length === 0) {
    return { verdict: "unverifiable", violations: [], inspected: 0 };
  }
  const startedAt = agent.started_at;
  if (startedAt === undefined) {
    return { verdict: "unverifiable", violations: [], inspected: declaredArtifacts.length };
  }
  const violations: IntegrityViolation[] = [];
  for (const artifact of declaredArtifacts) {
    const stat = oracle.inspect(artifact);
    if (stat === null) {
      violations.push({ artifact, reason: "missing" });
      continue;
    }
    if (stat.size <= 0) {
      violations.push({ artifact, reason: "empty" });
      continue;
    }
    if (stat.mtimeMs < startedAt) {
      violations.push({ artifact, reason: "stale" });
      continue;
    }
  }
  return {
    verdict: violations.length === 0 ? "consistent" : "inconsistent",
    violations,
    inspected: declaredArtifacts.length,
  };
}
