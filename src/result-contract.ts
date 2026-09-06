/**
 * The result contract: a declared outcome an agent writes to a file, or a restricted runtime
 * returns in a schema-bound final-text envelope, so that `complete` stops being a claim
 * MeshFleet infers from a process exiting 0.
 *
 * WHAT THIS SOLVES. Three live agents were observed banking `complete` on 2026-08-05 having
 * delivered nothing: one whose entire output was `"I could not."`, one that spent 14,450
 * characters explaining why it could not do the work, and one that stated an intent and stopped.
 * Every existing guard let all three through, because each of them looks — byte for byte — like
 * an agent that answered.
 *
 * 🔴 OUTPUT LENGTH IS NOT PART OF THE FILE PREDICATE. The 14,450-character refusal is
 * the reason. Length correlates with effort only in the cases that were never the problem, and a
 * length floor would bank exactly that refusal while failing a correct one-line answer. Nor is
 * any keyword scan of the prose — "I could not" is a phrase an agent that DID the work can write
 * about a sub-step. The only thing read here is a structured file the agent chose to write.
 *
 * WHAT THIS DOES NOT SOLVE — say it plainly and keep it separate. This is not an anti-fabrication
 * gate. An agent can write a valid `done` envelope, name a file it did not meaningfully change,
 * or invent its summary. The contract buys a DECLARED outcome plus optional path existence; the
 * truth of the claim needs a different oracle (a reviewer, a test, an attestation). Marketing
 * this as a truth or quality gate would be the same overclaim it exists to prevent.
 *
 * ROLLOUT, deliberately staged. Release N observed: every runtime was taught the contract it can
 * actually satisfy (file-based for agentic runtimes, final-text for restricted runtimes), and the
 * observed status was recorded without changing banking. Release N+1 enforces: `ok` is the only
 * value that may bank `complete`; every non-`ok` value banks `failed`. The observation release
 * avoided mass false failures while prompts adopted the contract. Historical rows remain
 * forward-only: nothing is backfilled, because a value inferred for a run nobody observed is a
 * fabricated measurement.
 */

import { existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, isAbsolute, resolve as resolvePath } from "path";

/** Exact marker. A version bump is a new marker string; an unknown marker is unparseable. */
export const RESULT_CONTRACT_SCHEMA = "mf.agent.result/v1";
export const TEXT_RESULT_CONTRACT_SCHEMA = "mf.agent.text-result/v1";

/** The environment variable naming the file. Also inlined in the prompt — agents skip env. */
export const RESULT_PATH_ENV = "RESULT_PATH";

/** What the agent declares. `refused` = cannot/will not; `blocked` = missing input. Both honest. */
export type ResultContractOutcome = "done" | "refused" | "blocked";

/**
 * What MeshFleet observed. Recorded on the agent row for every terminal outcome.
 *
 * `ok` is the ONLY value that may bank `complete`. `absent` and
 * `invalid` are distinct on purpose: absent says the agent never learned the contract (a caller
 * or prompt problem), invalid says it tried and produced something unreadable (an agent problem).
 * Collapsing them would hide which of the two an adoption metric is actually measuring.
 */
export type ResultContractStatus =
  | "ok"
  | "refused"
  | "blocked"
  | "artifact_missing"
  | "invalid"
  | "absent";

/**
 * The prose every caller shows when a successful runtime exit is sealed `failed` because the
 * result contract says so. Mirrors {@link HOLLOW_SUCCESS_REASON}'s shape: a single bounded
 * sentence that names the sealed status, the recorded contract value, and the rule that decided
 * — so the row's `error` reads as a diagnosis and not a transcript.
 *
 * The contract value is interpolated (not the agent's stdout) because this string is the
 * `failureDetail` passed to `markAgentFinished(..., "failed", ..., failureDetail, ...)`, and
 * that path's success-carries-no-error guard forbids raw runtime text in the same region
 * (`src/index.ts` lines 393–397). The contract value is a one-token enum; the agent's prose is
 * not, and recording it would recreate the exact indistinguishability this release is closing.
 */
export const RESULT_CONTRACT_FAILURE_REASON = (
  status: ResultContractStatus,
): string =>
  `Runtime exited successfully but result_contract=${status}; sealed as failed because ` +
  `ok is the only value that may bank complete. Re-run with a valid envelope ` +
  `({"schema":"${RESULT_CONTRACT_SCHEMA}","outcome":"done","summary":"<one line>"}) to complete.`;

export interface AgentResultEnvelope {
  schema: string;
  outcome: ResultContractOutcome;
  summary: string;
  reason?: string;
  artifacts?: string[];
}

export type ParseResult =
  | { ok: true; envelope: AgentResultEnvelope }
  | { ok: false; reason: string };

const OUTCOMES: readonly string[] = ["done", "refused", "blocked"];

export type TextResultParse =
  | { ok: true; status: "ok" | "refused" | "blocked"; output: string }
  | { ok: false; reason: string };

/** Parse a declaration from a runtime that can return text but has no filesystem authority. */
export function parseAgentTextResultEnvelope(raw: string): TextResultParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not a single JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  const allowed = new Set(["schema", "outcome", "summary", "output", "reason"]);
  if (Object.keys(obj).some((key) => !allowed.has(key))) {
    return { ok: false, reason: "unknown field" };
  }
  if (obj.schema !== TEXT_RESULT_CONTRACT_SCHEMA) {
    return { ok: false, reason: "unknown schema marker" };
  }
  if (typeof obj.outcome !== "string" || !OUTCOMES.includes(obj.outcome)) {
    return { ok: false, reason: "outcome is not one of done|refused|blocked" };
  }
  if (typeof obj.summary !== "string" || obj.summary.trim() === "") {
    return { ok: false, reason: "summary is missing or empty" };
  }
  if (obj.outcome === "done") {
    if (typeof obj.output !== "string" || obj.output.trim() === "") {
      return { ok: false, reason: "done requires non-empty output" };
    }
    if (obj.reason !== undefined) return { ok: false, reason: "done must not carry a reason" };
    return { ok: true, status: "ok", output: obj.output };
  }
  if (typeof obj.reason !== "string" || obj.reason.trim() === "") {
    return { ok: false, reason: `${obj.outcome} requires a non-empty reason` };
  }
  if (obj.output !== undefined) {
    return { ok: false, reason: `${obj.outcome} must not carry output` };
  }
  return {
    ok: true,
    status: obj.outcome as "refused" | "blocked",
    // Restricted runtimes have no separate result file to preserve the triage explanation.
    // Keep both fields in the useful output that reaches the ledger and collect_results.
    output: `${obj.summary}\n\nReason: ${obj.reason}`,
  };
}

/**
 * Parse the envelope bytes. Pure: no filesystem, no clock, no environment.
 *
 * `typeof [] === "object"` — an array of the right-looking fields is NOT a single object, and
 * this repo has shipped a guard before that accepted one. Arrays and `null` are rejected first,
 * by construction, not by a later field check that happens to miss.
 */
export function parseAgentResultEnvelope(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not a single JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schema !== RESULT_CONTRACT_SCHEMA) return { ok: false, reason: "unknown schema marker" };
  if (typeof obj.outcome !== "string" || !OUTCOMES.includes(obj.outcome)) {
    return { ok: false, reason: "outcome is not one of done|refused|blocked" };
  }
  if (typeof obj.summary !== "string" || obj.summary.trim() === "") {
    return { ok: false, reason: "summary is missing or empty" };
  }
  const outcome = obj.outcome as ResultContractOutcome;
  if (outcome !== "done") {
    // A refusal without a reason is a refusal that cannot be triaged. Required, not advisory.
    if (typeof obj.reason !== "string" || obj.reason.trim() === "") {
      return { ok: false, reason: `${outcome} requires a non-empty reason` };
    }
  }
  let artifacts: string[] | undefined;
  if (obj.artifacts !== undefined) {
    if (!Array.isArray(obj.artifacts) || obj.artifacts.some((a) => typeof a !== "string" || a.trim() === "")) {
      return { ok: false, reason: "artifacts must be an array of non-empty strings" };
    }
    artifacts = obj.artifacts as string[];
  }
  return {
    ok: true,
    envelope: {
      schema: RESULT_CONTRACT_SCHEMA,
      outcome,
      summary: obj.summary,
      ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
      ...(artifacts ? { artifacts } : {}),
    },
  };
}

export interface EvaluateInput {
  /** The file's bytes, or undefined when the file did not exist. */
  raw: string | undefined;
  /** True when the spawn declared the agent must produce at least one artifact. */
  expectsArtifact?: boolean;
  /** Existence oracle, injected so the ladder is testable without touching a disk. */
  exists: (path: string) => boolean;
  /** Directory relative artifact paths resolve against — the child's cwd, not the server's. */
  cwd?: string;
}

/**
 * The outcome ladder. Pure — the caller supplies the bytes and an existence oracle.
 *
 * Only one row returns `ok`, and `ok` is the only row a later release will let bank `complete`.
 */
export function evaluateResultContract(input: EvaluateInput): ResultContractStatus {
  if (input.raw === undefined) return "absent";
  const parsed = parseAgentResultEnvelope(input.raw);
  if (!parsed.ok) return "invalid";
  const { outcome, artifacts } = parsed.envelope;
  if (outcome === "refused") return "refused";
  if (outcome === "blocked") return "blocked";
  if (input.expectsArtifact && (!artifacts || artifacts.length === 0)) return "artifact_missing";
  for (const artifact of artifacts ?? []) {
    const full = isAbsolute(artifact) ? artifact : resolvePath(input.cwd ?? process.cwd(), artifact);
    if (!input.exists(full)) return "artifact_missing";
  }
  return "ok";
}

/**
 * Read and evaluate. A missing file is `absent`; a file that cannot be read for any OTHER reason
 * is `invalid`, never `absent` — a permissions failure is not evidence the agent stayed silent,
 * and reporting it as one would credit the agent with a state nobody observed.
 */
export function readResultContract(
  path: string,
  options: { expectsArtifact?: boolean; cwd?: string } = {},
): ResultContractStatus {
  let raw: string | undefined;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") raw = undefined;
    else return "invalid";
  }
  return evaluateResultContract({ raw, expectsArtifact: options.expectsArtifact, exists: existsSync, cwd: options.cwd });
}

/**
 * The file this attempt's envelope is read from.
 *
 * Per ATTEMPT, not per agent. A retry that reused the path would read attempt 1's envelope and
 * credit attempt 2 with an outcome it never declared — the same silent inheritance the crash
 * journal work had to fix elsewhere. The attempt id is part of the name for exactly that reason.
 */
export function resultPathFor(agentId: string, attempt: string | number, dir: string = tmpdir()): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(dir, `meshfleet-result-${safe(agentId)}-${safe(String(attempt))}.json`);
}

/**
 * Appended to every agentic runtime prompt. Inlines the path because agents routinely never read env.
 *
 * States the consequence in the release that will enforce it, not the one that observes: a
 * preamble that says "this is currently ignored" teaches agents to ignore it.
 */
export function resultContractPreamble(resultPath: string, expectsArtifact = false): string {
  return [
    "",
    "---",
    "RESULT CONTRACT — MANDATORY. Before you stop, write ONE JSON file to this exact path:",
    resultPath,
    `It must be a single JSON object: {"schema":"${RESULT_CONTRACT_SCHEMA}","outcome":"done"|"refused"|"blocked","summary":"<one line>"}`,
    'Add "reason":"<why>" when the outcome is refused or blocked. Add "artifacts":["<path>",...] for files you produced.',
    // Only when the CALLER declared the expectation. Teaching it unconditionally would train
    // agents that produce no files to invent paths, which the existence check then fails —
    // manufacturing artifact_missing out of honest no-artifact work.
    ...(expectsArtifact
      ? ['This task REQUIRES artifacts: a "done" envelope that names no produced files is recorded as artifact_missing.']
      : []),
    "If you could not do the work, set outcome to refused or blocked with a real reason — do NOT claim done.",
    "A missing or invalid file means the run is banked as failed, not complete. Stdout is not the receipt.",
  ].join("\n");
}

/** The prompt actually handed to the runtime. Kept in one place so both spawn paths agree. */
export function withResultContract(prompt: string, resultPath: string, expectsArtifact = false): string {
  return `${prompt}\n${resultContractPreamble(resultPath, expectsArtifact)}\n`;
}

/** Teach a structured declaration to a runtime that has text output but no file authority. */
export function withTextResultContract(prompt: string): string {
  return [
    prompt,
    "",
    "---",
    "TEXT RESULT CONTRACT — MANDATORY.",
    "Your entire final response must be one JSON object with no code fence or surrounding prose.",
    `For completed work: {"schema":"${TEXT_RESULT_CONTRACT_SCHEMA}","outcome":"done","summary":"<one line>","output":"<the full useful answer>"}`,
    `For a refusal or blocker: {"schema":"${TEXT_RESULT_CONTRACT_SCHEMA}","outcome":"refused"|"blocked","summary":"<one line>","reason":"<why>"}`,
    "Output only the JSON object. Empty, prose-only, or malformed output is a failed run.",
    "",
  ].join("\n");
}
