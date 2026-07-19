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

const EXPLICIT_AGENT_FALLBACK = /(?:agent[^\n]*\bfall(?:ing)?\s+back\b|\bfallback\b[^\n]*agent)/i;
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const FATAL_PROVIDER_ERROR = /(?:ProviderModelNotFoundError|ProviderAuthError|AuthenticationError|RateLimitError|APIError|API\s+429\s+for\s+|invalid authentication credentials|insufficient balance)/i;

function runtimeBanner(stderr: string): { agent: string; model: string } | undefined {
  const plain = stderr.replace(ANSI_ESCAPE, "");
  const match = plain.match(/^\s*>\s*([^\s·]+)\s*·\s*([^\s]+)\s*$/m);
  return match ? { agent: match[1], model: match[2] } : undefined;
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
  if (EXPLICIT_AGENT_FALLBACK.test(input.stderr)) {
    return { ...receipt, success: false, error: "Explicit OpenCode agent fallback detected" };
  }
  const banner = runtimeBanner(input.stderr);
  if (input.requestedAgent && banner && banner.agent !== input.requestedAgent) {
    return {
      ...receipt,
      success: false,
      error: `Requested agent ${input.requestedAgent} but runtime agent ${banner.agent} executed`,
    };
  }
  const providerError = input.stderr.split("\n").find((line) => FATAL_PROVIDER_ERROR.test(line));
  const runtimeModelName = banner?.model.split("/").at(-1);
  const errorModel = providerError?.match(/API\s+429\s+for\s+([^\s:]+)|\b([\w.-]+\/[\w.-]+)\b/i);
  const namedErrorModel = errorModel?.[1] ?? errorModel?.[2];
  if (providerError && (
    !banner ||
    !namedErrorModel ||
    namedErrorModel === banner.model ||
    namedErrorModel === runtimeModelName
  )) {
    return { ...receipt, success: false, error: `Fatal primary provider error: ${providerError.trim()}` };
  }
  if (providerError) {
    return { ...receipt, success: true, warning: `Auxiliary provider warning: ${providerError.trim()}` };
  }
  return { ...receipt, success: true };
}
