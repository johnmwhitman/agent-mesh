export interface SpawnResultInput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  requestedAgent?: string;
  requestedModel?: string;
}

/**
 * Which side a non-zero exit points at, for the ONE decision a caller has to make:
 * try somewhere else, or fix the call.
 *
 * 🔴 This is NOT a second oracle for `hasProviderRefusalSignal`. That predicate answers
 * "did the provider REFUSE?" and drives failover; this answers "whose fault does the text
 * read as?" and drives what an operator is told. The refusal branch below DELEGATES to
 * that predicate rather than re-matching it, so the two cannot drift.
 */
export type SpawnFailureKind = "upstream" | "caller" | "unknown";

export interface SpawnResultClassification {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  warning?: string;
  runtime_agent?: string;
  runtime_model?: string;
  /** Only set when the spawn failed at the process level (non-zero exit). */
  failure_kind?: SpawnFailureKind;
}

const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
/**
 * The request named something the provider cannot serve — retrying elsewhere with the SAME
 * spec will fail the same way, so the caller has to change the call. Deliberately narrow:
 * only phrasings that name the requested model/agent as the thing at fault.
 */
const CALLER_FAULT = /(?:ProviderModelNotFoundError|cannot be routed|unknown (?:model|agent)|no such (?:model|agent))/i;
/**
 * The provider's own machinery failed — the same call may well succeed on another provider,
 * or later. Narrow on purpose: a generic /error/ would swallow real work failures and tell
 * an operator to go spend another subscription's quota on a bug that will reproduce.
 *
 * Measured 2026-08-01 against the live opencode-go outage, whose entire stderr was
 * `Error: {"name":"UnknownError","data":{"message":"Unexpected server error...","ref":"err_..."}}`
 * — the failure that cost a second dispatch to diagnose, because the classifier discarded it.
 */
const UPSTREAM_FAULT = /(?:UnknownError|Unexpected server error|internal server error|service unavailable|upstream timeout|bad gateway)/i;
/**
 * A line that plausibly states WHY something failed. Used only to decide whether a line is
 * worth quoting as the cause — never to decide fault, and never to decide failover.
 */
const FAILURE_LINE = /(?:error|failed|failure|refus|denied|forbidden|unauthor|cannot|can't|unable|timed? out|exhaust|invalid|not found)/i;
const EXPLICIT_FALLBACK = /\bfall(?:ing)?\s+back\b|\bfallback\b/i;
const NO_CREDENTIALS = /(?:no claude code credentials found|claude code credentials are unavailable or expired)/i;
const PROVIDER_DIAGNOSTIC = /(?:ProviderModelNotFoundError|ProviderAuthError|AuthenticationError|RateLimitError|APIError|API\s+429\s+for\s+|invalid authentication credentials|insufficient balance)/i;

/**
 * Does this failure text carry a signal that the PROVIDER refused, rather than that the work went
 * wrong?
 *
 * Reuses the two patterns above verbatim — no second copy, no widened set. A parallel matcher here
 * would be a weaker second oracle for the same question, and the two would drift the first time
 * one of them was tuned.
 *
 * Measured 2026-08-01 against the real outage detail (grok returning `API 429 for ...` plus
 * `Forbidden: You have run out of credits`): true. Against `Spawn failed with exit code 1`, a
 * malformed Kimi frame, an empty-stdout failure and a timeout: false. That is the discrimination
 * this is for — a provider refusing is worth trying elsewhere, a prompt that breaks the work is
 * not, and spending another subscription's quota to re-learn the same bug is the amplification a
 * caller cannot see.
 *
 * 🔴 It is a SIGNAL, not a proof, and it is deliberately not widened to close these gaps:
 *   - the credits sentence ALONE does not match; the observed detail matched on its `API 429 for`
 *     line, and a future refusal phrased without one would read as a work failure.
 *   - `Kimi process failed to start` does not match, so an unusable Kimi binary does not fail over.
 * Both are stated rather than patched, because the failure of a broad pattern is to fire on real
 * work failures — and a false positive here spends real money on a hop that cannot help.
 */
export function hasProviderRefusalSignal(text: string): boolean {
  return PROVIDER_DIAGNOSTIC.test(text) || NO_CREDENTIALS.test(text);
}

/**
 * Recover a one-line cause from a child's stderr.
 *
 * Why this exists: a non-zero exit used to be reported as nothing but
 * `Spawn failed with exit code 1`, while the child's stderr held the real reason. On
 * 2026-08-01 three fleets died that way and the operator had to dispatch a SECOND fleet on
 * a different model purely to learn whether the provider was down or the selector was
 * wrong — a question the discarded text answered outright.
 *
 * The text is already ANSI-stripped by the caller. Structured `{"message":..,"ref":..}`
 * bodies are preferred because the ref is the only handle anyone has on an opaque upstream
 * failure; otherwise the first meaningful line is used. Capped, because this lands in a
 * summary field and an unbounded stack trace there is its own kind of unreadable.
 */
export function summarizeFailureText(plainText: string): string | undefined {
  const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(plainText)?.[1];
  const ref = /"ref"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(plainText)?.[1];
  if (message) return truncate(ref ? `${message} (ref ${ref})` : message);

  // Only speak when the text actually carries a failure. Returning the first non-empty line
  // was wrong and an existing test caught it: on a banner-only stderr it presented
  // `> oracle · anthropic/claude-sonnet-4` — the RUNTIME BANNER — as the cause of the
  // failure. Announcing a confident wrong reason is worse than the bare exit code, so with
  // no recognisable signal this returns undefined and the message is left exactly as it was.
  const line = plainText
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith(">") && FAILURE_LINE.test(l));
  return line ? truncate(line) : undefined;
}

function truncate(text: string, limit = 300): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * Attribute a process-level failure. See {@link SpawnFailureKind} — the refusal case
 * delegates to {@link hasProviderRefusalSignal} instead of re-matching it, so this cannot
 * drift from the predicate that drives failover.
 *
 * `unknown` is the honest default and is expected to be common: most non-zero exits are
 * ordinary work failures, and guessing a side for them would be worse than saying so.
 */
export function classifyFailureKind(plainText: string): SpawnFailureKind {
  if (CALLER_FAULT.test(plainText)) return "caller";
  if (UPSTREAM_FAULT.test(plainText) || hasProviderRefusalSignal(plainText)) return "upstream";
  return "unknown";
}

interface DiagnosticAttribution {
  model?: string;
  provider?: string;
}

/**
 * Match exact runtime model IDs or IDs that differ only by one provider prefix.
 * Provider stripping is symmetric and removes only the first path segment, so
 * multi-segment model names stay intact. Spawn classification and verification
 * share this rule to keep runtime evidence interpretation consistent.
 */
export function runtimeModelsMatch(expected?: string, observed?: string): boolean {
  if (!expected || !observed) return false;
  const expectedValue = expected.toLowerCase();
  const observedValue = observed.toLowerCase();
  if (expectedValue === observedValue) return true;

  const withoutProvider = (value: string): string | undefined => {
    const separator = value.indexOf("/");
    return separator > 0 && separator < value.length - 1
      ? value.slice(separator + 1)
      : undefined;
  };

  return (
    withoutProvider(expectedValue) === observedValue ||
    withoutProvider(observedValue) === expectedValue
  );
}

function runtimeBanner(stderr: string): { agent: string; model: string } | undefined {
  const plain = stderr.replace(ANSI_ESCAPE, "");
  const match = plain.match(/^\s*>\s*([^·]+?)\s*·\s*([^\s]+)\s*$/m);
  return match ? { agent: match[1].trim(), model: match[2] } : undefined;
}

function diagnosticAttribution(line: string): DiagnosticAttribution {
  const apiModel = line.match(/API\s+429\s+for\s+([^\s:]+)/i)?.[1];
  const missingModel = line.match(
    /\bProviderModelNotFoundError:\s*([a-z0-9][\w.-]*\/[a-z0-9][\w.-]*)\b/i
  )?.[1];
  const model = (apiModel ?? missingModel)?.replace(/[.,;]+$/, "").toLowerCase();
  if (model) return { model };

  if (/opencode-claude-auth/i.test(line) || NO_CREDENTIALS.test(line)) {
    return { provider: "anthropic" };
  }
  return {};
}

function isRuntimeDiagnostic(
  attribution: DiagnosticAttribution,
  banner: { agent: string; model: string } | undefined
): boolean {
  if (!banner) return true;
  const runtimeModel = banner.model.toLowerCase();
  let [runtimeProvider, runtimeModelName] = runtimeModel.includes("/")
    ? runtimeModel.split("/", 2)
    : [undefined, runtimeModel];
  if (!runtimeProvider && runtimeModelName.startsWith("claude-")) {
    runtimeProvider = "anthropic";
  }

  if (attribution.model) {
    return runtimeModelsMatch(attribution.model, runtimeModel) || attribution.model === runtimeModelName;
  }
  if (attribution.provider) return attribution.provider === runtimeProvider;
  return true;
}

export function classifySpawnResult(
  input: SpawnResultInput
): SpawnResultClassification {
  const banner = runtimeBanner(input.stderr);
  const runtimeMeta = banner ? { runtime_agent: banner.agent, runtime_model: banner.model } : {};
  const receipt = { stdout: input.stdout, stderr: input.stderr, ...runtimeMeta };
  const plainStderr = input.stderr.replace(ANSI_ESCAPE, "");
  if (input.exitCode !== 0) {
    // The cause was already computed one line above and then discarded. Keeping it does not
    // change what failover sees — that reads the raw stderr, which always held this text.
    const cause = summarizeFailureText(plainStderr);
    return {
      ...receipt,
      success: false,
      error: cause
        ? `Spawn failed with exit code ${input.exitCode}: ${cause}`
        : `Spawn failed with exit code ${input.exitCode}`,
      failure_kind: classifyFailureKind(plainStderr),
    };
  }
  if (input.stdout.trim() === "") {
    return { ...receipt, success: false, error: "Spawn exited without output (empty stdout)" };
  }
  if (EXPLICIT_FALLBACK.test(plainStderr)) {
    return { ...receipt, success: false, error: "Explicit OpenCode agent fallback detected" };
  }
  if (input.requestedAgent && !banner) {
    return { ...receipt, success: false, error: "Requested agent but runtime agent banner is missing or unparsable" };
  }
  if (input.requestedAgent && banner && banner.agent !== input.requestedAgent) {
    return {
      ...receipt,
      success: false,
      error: `Requested agent ${input.requestedAgent} but runtime agent ${banner.agent} executed`,
    };
  }
  if (input.requestedModel !== undefined && !banner) {
    return {
      ...receipt,
      success: false,
      error: "Requested model but runtime model banner is missing or unparsable",
    };
  }
  if (
    input.requestedModel !== undefined &&
    banner &&
    !runtimeModelsMatch(input.requestedModel, banner.model)
  ) {
    return {
      ...receipt,
      success: false,
      error: `Requested model ${input.requestedModel} but runtime model banner reported ${banner.model}`,
    };
  }
  const diagnostics = plainStderr
    .split("\n")
    .filter((line) => /^\s*Error:/i.test(line) || NO_CREDENTIALS.test(line) || PROVIDER_DIAGNOSTIC.test(line));
  const primaryError = diagnostics.find((line) =>
    isRuntimeDiagnostic(diagnosticAttribution(line), banner)
  );
  if (primaryError) {
    return { ...receipt, success: false, error: `Fatal primary provider error: ${primaryError.trim()}` };
  }
  if (diagnostics.length > 0) {
    return { ...receipt, success: true, warning: `Auxiliary provider warning: ${diagnostics.join("\n")}` };
  }
  return { ...receipt, success: true };
}
