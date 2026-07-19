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
const NO_CREDENTIALS = /(?:no claude code credentials found|claude code credentials are unavailable or expired)/i;
const PROVIDER_DIAGNOSTIC = /(?:ProviderModelNotFoundError|ProviderAuthError|AuthenticationError|RateLimitError|APIError|API\s+429\s+for\s+|invalid authentication credentials|insufficient balance)/i;

interface DiagnosticAttribution {
  model?: string;
  provider?: string;
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
    return attribution.model === runtimeModel || attribution.model === runtimeModelName;
  }
  if (attribution.provider) return attribution.provider === runtimeProvider;
  return true;
}

export function classifySpawnResult(
  input: SpawnResultInput
): SpawnResultClassification {
  const receipt = { stdout: input.stdout, stderr: input.stderr };
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
