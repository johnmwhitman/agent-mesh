export interface SpawnResultInput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  requestedAgent?: string;
}

export interface SpawnResultClassification {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  warning?: string;
}

const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const EXPLICIT_FALLBACK = /\bfall(?:ing)?\s+back\b|\bfallback\b/i;
const FATAL_PROVIDER_ERROR = /(?:ProviderModelNotFoundError|ProviderAuthError|AuthenticationError|RateLimitError|APIError|API\s+429\s+for\s+|invalid authentication credentials|insufficient balance)/i;

function runtimeBanner(stderr: string): { agent: string; model: string } | undefined {
  const plain = stderr.replace(ANSI_ESCAPE, "");
  const match = plain.match(/^\s*>\s*([^·]+?)\s*·\s*([^\s]+)\s*$/m);
  return match ? { agent: match[1].trim(), model: match[2] } : undefined;
}

export function classifySpawnResult(
  input: SpawnResultInput
): SpawnResultClassification {
  const receipt = { stdout: input.stdout, stderr: input.stderr };
  if (input.exitCode !== 0) {
    return { ...receipt, success: false, error: `Spawn failed with exit code ${input.exitCode}` };
  }
  if (input.stdout.trim() === "") {
    return { ...receipt, success: false, error: "Spawn exited without output (empty stdout)" };
  }
  if (EXPLICIT_FALLBACK.test(input.stderr.replace(ANSI_ESCAPE, ""))) {
    return { ...receipt, success: false, error: "Explicit OpenCode agent fallback detected" };
  }
  const banner = runtimeBanner(input.stderr);
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
  const providerErrors = input.stderr.split("\n").filter((line) => FATAL_PROVIDER_ERROR.test(line));
  const runtimeModelName = banner?.model.split("/").at(-1);
  const primaryError = providerErrors.find((line) => {
    const errorModel = line.match(/API\s+429\s+for\s+([^\s:]+)|\b([\w.-]+\/[\w.-]+)\b/i);
    const namedErrorModel = errorModel?.[1] ?? errorModel?.[2];
    return !banner || !namedErrorModel || namedErrorModel === banner.model || namedErrorModel === runtimeModelName;
  });
  if (primaryError) {
    return { ...receipt, success: false, error: `Fatal primary provider error: ${primaryError.trim()}` };
  }
  if (providerErrors.length > 0) {
    return { ...receipt, success: true, warning: `Auxiliary provider warning: ${providerErrors.join("\n")}` };
  }
  return { ...receipt, success: true };
}
