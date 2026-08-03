export interface SpawnResultInput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  requestedAgent?: string;
  requestedModel?: string;
}

export interface SpawnResultClassification {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  warning?: string;
  runtime_agent?: string;
  runtime_model?: string;
}

const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
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
    return { ...receipt, success: false, error: `Spawn failed with exit code ${input.exitCode}` };
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
