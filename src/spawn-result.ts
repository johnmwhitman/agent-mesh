export interface SpawnResultInput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  requestedAgent?: string;
  requestedModel?: string;
  /**
   * Independently observed runtime model (e.g. from the child runtime's own
   * persisted evidence, joined by the runtime-emitted session id). This is
   * NEVER the requested/argv value relabelled: callers must only supply a
   * value the runtime itself attested. When present it satisfies the same
   * fail-closed contract as the stderr banner; when absent the banner rules
   * apply unchanged.
   */
  runtimeModel?: string;
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

// Parse a single logfmt line into a Map of key → value(s). Returns null when the
// line has no logfmt key=value tokens at all. Duplicate keys are collected — the
// caller decides whether duplicates are acceptable for a given field.

type ModernRuntimeResult =
  | { agent: string; model: string }
  | { conflict: true; selections: Array<{ agent: string; model: string }> }
  | { malformed: true }
  | undefined;

function parseLogfmt(line: string): Map<string, string[]> | null {
  const fields = new Map<string, string[]>();
  // Match key=value (value may be quoted). The key must be preceded by start or
  // whitespace so embedded dotted prefixes (foo.level) do not collide.
  const re = /(?:^|\s)([a-zA-Z][a-zA-Z0-9_.-]*)=("(?:[^"\\]|\\.)*"|[^\s]+)/g;
  let match: RegExpExecArray | null;
  let found = false;
  while ((match = re.exec(line)) !== null) {
    found = true;
    const key = match[1];
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    const existing = fields.get(key);
    if (existing) existing.push(value);
    else fields.set(key, [value]);
  }
  return found ? fields : null;
}

// The fields that a complete authoritative primary INFO record must carry, each
// exactly once. Missing or duplicate values in any of these make the record
// malformed rather than ignorable.
const REQUIRED_FIELDS = ["level", "message", "small", "mode", "providerID", "modelID", "agent"] as const;

function modernRuntimeSelection(stderr: string): ModernRuntimeResult {
  const selections: Array<{ agent: string; model: string }> = [];
  let sawMalformedPrimary = false;
  for (const line of stderr.replace(ANSI_ESCAPE, "").split("\n")) {
    const fields = parseLogfmt(line);
    if (!fields) continue;
    // Only lines carrying `message` are runtime-selection records.
    const messageValues = fields.get("message");
    if (!messageValues) continue;
    // The message must be exactly `stream` or quoted `llm runtime selected`.
    if (!messageValues.every((m) => m === "stream" || m === "llm runtime selected")) {
      // A message field with an unrelated value is not a runtime record — ignore.
      continue;
    }
    // A modern candidate is a runtime-selection message that also carries at
    // least one runtime-selection discriminator (small, mode, providerID,
    // modelID, agent). A line carrying only level + message=stream is generic
    // log noise, not a runtime-selection candidate — level alone is not a
    // discriminator. Ignore such lines rather than treating them as malformed.
    const hasRuntimeDiscriminator =
      fields.has("small") ||
      fields.has("mode") ||
      fields.has("providerID") ||
      fields.has("modelID") ||
      fields.has("agent");
    if (!hasRuntimeDiscriminator) continue;
    // Once we identify a candidate, the `small` field is the key discriminator:
    //   - unique small=true  → auxiliary/title-generation, ignored (not primary)
    //   - unique small=false → primary record, all required fields must be
    //                          present and unique or it is malformed
    //   - absent, duplicated, or invalid small value → malformed
    const smallValues = fields.get("small");
    if (!smallValues || smallValues.length === 0) {
      // No small field at all — this is a candidate that failed to declare its
      // dispatch type. Missing small is malformed, not ignorable.
      sawMalformedPrimary = true;
      continue;
    }
    if (smallValues.length > 1) {
      // Duplicate small fields — malformed.
      sawMalformedPrimary = true;
      continue;
    }
    const smallValue = smallValues[0];
    if (smallValue !== "true" && smallValue !== "false") {
      // Invalid small value — malformed.
      sawMalformedPrimary = true;
      continue;
    }
    // small=true is the title-generation stream — auxiliary, not primary.
    // It is ignored entirely, not malformed or authoritative.
    if (smallValue === "true") continue;

    // Now we have a primary candidate (small=false). Every required field
    // must be present and unique — missing or duplicate values in any field
    // (including level or mode) are malformed. This catches embedded keys like
    // foo.level=INFO (where level is absent) and duplicate contradictory fields
    // like level=DEBUG level=INFO or modelID=subs/grok modelID=subs/codex.
    let malformed = false;
    for (const key of REQUIRED_FIELDS) {
      const values = fields.get(key);
      if (!values || values.length === 0) {
        malformed = true;
        break;
      }
      if (values.length > 1) {
        malformed = true;
        break;
      }
      if (values[0].trim() === "") {
        malformed = true;
        break;
      }
    }
    if (malformed) {
      sawMalformedPrimary = true;
      continue;
    }
    // Only INFO-level records attest runtime identity. A single non-INFO
    // level on an otherwise-complete primary record is non-authoritative but
    // not malformed — it is simply ignored.
    if (fields.get("level")![0] !== "INFO") continue;
    // A non-primary mode is a different stream. Only primary records attest
    // the worker identity MeshFleet is about to bank.
    const modeValues = fields.get("mode");
    if (modeValues![0] !== "primary") continue;
    const provider = fields.get("providerID")![0];
    const model = fields.get("modelID")![0];
    const agent = fields.get("agent")![0];
    selections.push({ agent, model: `${provider}/${model}` });
  }
  if (sawMalformedPrimary) return { malformed: true };
  if (selections.length === 0) return undefined;
  const first = selections[0];
  if (
    !selections.every(
      (selection) => selection.agent === first.agent && selection.model === first.model
    )
  ) {
    return { conflict: true, selections };
  }
  return first;
}

function diagnosticAttribution(line: string): DiagnosticAttribution {
  const apiModel = line.match(/API\s+429\s+for\s+([^\s:]+)/i)?.[1];
  const missingModel = line.match(
    /\bProviderModelNotFoundError:\s*([a-z0-9][\w.-]*(?:\/[a-z0-9][\w.-]*)+)\b/i
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
  observedModel: string | undefined
): boolean {
  if (!observedModel) return true;
  const runtimeModel = observedModel.toLowerCase();
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
  // Parse modern evidence once. The result is reused for the malformed gate
  // and the conflict/identity checks below, so modernRuntimeSelection is not
  // called a second time.
  const plainStderr = input.stderr.replace(ANSI_ESCAPE, "");
  const modern = modernRuntimeSelection(plainStderr);

  // Track whether modern evidence is malformed. This is checked AFTER the
  // established exit-code/empty-stdout failures but BEFORE legacy fallback,
  // requested-model acceptance, or any diagnostic gate.
  const modernMalformed = modern && "malformed" in modern;

  // Derive the banner from modern evidence first, then legacy fallback. This
  // mirrors the previous runtimeBanner logic but reuses the already-parsed
  // modern result instead of re-running modernRuntimeSelection.
  let banner: { agent: string; model: string } | undefined;
  if (modern && !("conflict" in modern) && !("malformed" in modern)) {
    banner = modern;
  }
  // When modern evidence conflicts or is malformed, do not fall back to the
  // legacy banner for identity — the conflict/malformed is reported below.
  if (!banner && !(modern && ("conflict" in modern || "malformed" in modern))) {
    const match = plainStderr.match(/^\s*>\s*([^·]+?)\s*·\s*([^\s]+)\s*$/m);
    if (match) banner = { agent: match[1].trim(), model: match[2] };
  }

  // Evidence precedence: an independently observed runtime model (supplied by
  // the caller from the runtime's own artifacts) supplies observed identity
  // the same way the stderr banner does. The banner, when present, still wins
  // because it is the runtime's live self-report; any disagreement between
  // the two fails closed below via the same mismatch rule.
  const observedModel = banner?.model ?? input.runtimeModel;
  const runtimeMeta =
    banner || input.runtimeModel
      ? {
          ...(banner ? { runtime_agent: banner.agent } : {}),
          ...(observedModel ? { runtime_model: observedModel } : {}),
        }
      : {};
  const receipt = { stdout: input.stdout, stderr: input.stderr, ...runtimeMeta };

  // Established failures take precedence over malformed/conflicting identity
  // evidence: a nonzero exit code and empty stdout are reported before any
  // modern-evidence gate.
  if (input.exitCode !== 0) {
    return { ...receipt, success: false, error: `Spawn failed with exit code ${input.exitCode}` };
  }
  if (input.stdout.trim() === "") {
    return { ...receipt, success: false, error: "Spawn exited without output (empty stdout)" };
  }

  // Malformed modern primary evidence poisons classification before legacy
  // fallback, requested-model acceptance, or any diagnostic gate. The contract
  // requires fail-closed on conflicting, missing, or malformed runtime-model
  // evidence.
  if (modernMalformed) {
    return {
      ...receipt,
      success: false,
      error: "Malformed runtime-model evidence in primary INFO stream record",
    };
  }
  if (modern && "conflict" in modern) {
    const observed = [...new Set(modern.selections.map((selection) => `${selection.agent} · ${selection.model}`))];
    return {
      ...receipt,
      success: false,
      error: `Conflicting runtime selections observed: ${observed.join("; ")}`,
    };
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
  if (
    banner &&
    input.runtimeModel &&
    !runtimeModelsMatch(banner.model, input.runtimeModel)
  ) {
    return {
      ...receipt,
      success: false,
      error:
        `Conflicting runtime model evidence: banner reported ${banner.model} ` +
        `but persisted DB reported ${input.runtimeModel}`,
    };
  }
  if (input.requestedModel !== undefined && !observedModel) {
    return {
      ...receipt,
      success: false,
      error: "Requested model but runtime model banner is missing or unparsable",
    };
  }
  if (
    input.requestedModel !== undefined &&
    observedModel &&
    !runtimeModelsMatch(input.requestedModel, observedModel)
  ) {
    return {
      ...receipt,
      success: false,
      error: `Requested model ${input.requestedModel} but runtime model banner reported ${observedModel}`,
    };
  }
  const diagnostics = plainStderr
    .split("\n")
    .filter((line) => /^\s*Error:/i.test(line) || NO_CREDENTIALS.test(line) || PROVIDER_DIAGNOSTIC.test(line));
  const primaryError = diagnostics.find((line) =>
    isRuntimeDiagnostic(diagnosticAttribution(line), observedModel)
  );
  if (primaryError) {
    return { ...receipt, success: false, error: `Fatal primary provider error: ${primaryError.trim()}` };
  }
  if (diagnostics.length > 0) {
    return { ...receipt, success: true, warning: `Auxiliary provider warning: ${diagnostics.join("\n")}` };
  }
  return { ...receipt, success: true };
}
