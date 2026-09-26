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
  /**
   * Strict mode. When true, a requested model with no runtime-model evidence
   * from any source fails the spawn (the pre-v3 behaviour). Default false: the
   * run is judged by exit code, output and stderr diagnostics, and the receipt
   * carries `model_verified: false`.
   */
  requireModelEvidence?: boolean;
}

/**
 * Where the observed runtime model came from, most direct first:
 *   - `runtime-log`: OpenCode's own INFO `message=stream ... small=false
 *     mode=primary` record (1.17+, emitted under `--print-logs`);
 *   - `session-db`:  the opt-in OpenCode state-DB row joined by the session id
 *     the child emitted (`runtimeModel` input);
 *   - `banner`:      the legacy `> agent · model` line (pre-1.17 `run`);
 *   - `none`:        no source attested a model. Never inferred from the
 *     request, the argv or stderr diagnostics.
 */
export type ModelEvidenceSource = "runtime-log" | "session-db" | "banner" | "none";

export interface SpawnResultClassification {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  warning?: string;
  runtime_agent?: string;
  runtime_model?: string;
  /** True only when an independent source established `runtime_model`. */
  model_verified: boolean;
  model_evidence: ModelEvidenceSource;
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

/**
 * Strict whole-line logfmt tokenizer. `parseLogfmt` above is a lenient SCANNER:
 * it finds `key=value` pairs anywhere, including inside an unterminated quoted
 * value (`error.error="... providerID=anthropic ...` with no closing quote), so
 * a payload can smuggle fields to the top level. This tokenizer guarantees
 * field boundaries or refuses the line:
 *
 *   line   = ws* (pair (ws+ pair)*)? ws*
 *   pair   = key "=" value
 *   key    = [A-Za-z][A-Za-z0-9_.-]*
 *   value  = quoted | bare
 *   quoted = '"' ( [^"\\] | "\\" any )* '"'   then whitespace or end of line
 *   bare   = [^\s"]*                            (may be empty; no '"' allowed)
 *
 * An unterminated quote, a dangling escape, garbage after a closing quote, a
 * quote inside a bare value, or any non-pair word (free text) makes the WHOLE
 * line malformed (`null`). Pairs are returned in order so callers can reason
 * about position.
 */
function parseLogfmtStrict(line: string): Array<[string, string]> | null {
  const pairs: Array<[string, string]> = [];
  const n = line.length;
  const isWs = (c: string): boolean => /\s/.test(c);
  let i = 0;
  for (;;) {
    while (i < n && isWs(line[i])) i += 1;
    if (i >= n) return pairs;
    const keyMatch = /^[A-Za-z][A-Za-z0-9_.-]*=/.exec(line.slice(i));
    if (!keyMatch) return null;
    const key = keyMatch[0].slice(0, -1);
    i += keyMatch[0].length;
    let value = "";
    if (line[i] === '"') {
      i += 1;
      let closed = false;
      while (i < n) {
        const c = line[i];
        if (c === "\\") {
          if (i + 1 >= n) return null; // dangling escape
          value += line[i + 1];
          i += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }
        value += c;
        i += 1;
      }
      if (!closed) return null; // unterminated quote
      if (i < n && !isWs(line[i])) return null; // garbage after the closing quote
    } else {
      while (i < n && !isWs(line[i])) {
        if (line[i] === '"') return null; // quote inside a bare value
        value += line[i];
        i += 1;
      }
    }
    pairs.push([key, value]);
  }
}

function pairsToFields(pairs: ReadonlyArray<[string, string]>): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (const [key, value] of pairs) {
    const existing = fields.get(key);
    if (existing) existing.push(value);
    else fields.set(key, [value]);
  }
  return fields;
}

// The fields that a complete authoritative primary INFO record must carry, each
// exactly once. Missing or duplicate values in any of these make the record
// malformed rather than ignorable.
const REQUIRED_FIELDS = ["level", "message", "small", "mode", "providerID", "modelID", "agent"] as const;

function modernRuntimeSelection(stderr: string): ModernRuntimeResult {
  const selections: Array<{ agent: string; model: string }> = [];
  let sawMalformedPrimary = false;
  for (const line of stderr.replace(ANSI_ESCAPE, "").split("\n")) {
    let fields = parseLogfmt(line);
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
    // The lenient scanner found a candidate. Its fields are trusted only if
    // the WHOLE line tokenizes strictly: otherwise an unterminated quoted
    // payload could have supplied `message=stream providerID=...` itself.
    // An untrustworthy candidate poisons identity (fail closed).
    const strictPairs = parseLogfmtStrict(line);
    if (strictPairs === null) {
      sawMalformedPrimary = true;
      continue;
    }
    fields = pairsToFields(strictPairs);
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

// ---------------------------------------------------------------------------
// Model identity normalization for diagnostic attribution
// ---------------------------------------------------------------------------
//
// Attribution answers ONE question: does this stderr line affirmatively belong
// to a provider OTHER than the runtime on record? Anything short of a clear
// "different provider" is the primary runtime's failure. So normalization only
// ever makes two ids look MORE alike (aliases, gateway prefixes, family
// inference all add provider identities to a set that must be DISJOINT for a
// downgrade). It can never manufacture a sibling.

/** Spelling variants of one provider namespace. Extend only with evidence. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  "x-ai": "xai",
  "x.ai": "xai",
};

/**
 * Leaf-name families whose vendor is unambiguous. Used to give a bare id
 * (`claude-haiku-4-5`, `grok-4`) a provider identity; union-ed with any
 * explicit prefix, so it can only widen the overlap test.
 */
const MODEL_FAMILY_PROVIDERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^claude(?:-|$)/, "anthropic"],
  [/^grok(?:-|$)/, "xai"],
  [/^gemini(?:-|$)/, "google"],
  [/^gpt(?:-|$)/, "openai"],
  [/^kimi(?:-|$)/, "moonshotai"],
  [/^minimax(?:-|$)/, "minimax"],
  [/^glm(?:-|$)/, "z-ai"],
  [/^deepseek(?:-|$)/, "deepseek"],
];

interface ModelIdentity {
  /** Last path segment, lowercased (`grok-4.7`, `nemotron-3.5-lightning:free`). */
  leaf?: string;
  /** Every provider identity the id names or implies (gateways included). */
  providers: Set<string>;
}

/** Strip wrapping quotes/brackets and trailing sentence punctuation, lowercase. */
function cleanIdToken(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^["'`([{<]+/, "")
    .replace(/["'`)\]}>.,;:!?]+$/, "");
}

function normalizeProvider(raw: string): string {
  const cleaned = cleanIdToken(raw);
  return PROVIDER_ALIASES[cleaned] ?? cleaned;
}

function modelIdentity(raw: string): ModelIdentity | undefined {
  const segments = cleanIdToken(raw)
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return undefined;
  const leaf = segments[segments.length - 1];
  // Every prefix segment is a provider identity: `openrouter/x-ai/grok-4.7`
  // names the gateway (openrouter) AND the upstream (xai). Treating both as
  // identities is the conservative choice — sharing either one is overlap.
  const providers = new Set(segments.slice(0, -1).map(normalizeProvider));
  for (const [family, provider] of MODEL_FAMILY_PROVIDERS) {
    if (family.test(leaf)) providers.add(provider);
  }
  return { leaf, providers };
}

/**
 * A model token as it appears in free text: skip leading wrappers, then take
 * everything up to whitespace, a closing wrapper, or a list separator. Colons
 * are allowed inside (`kilo/x:free`); a trailing one is stripped by
 * `cleanIdToken`.
 */
const MODEL_TOKEN = String.raw`["'\x60(\[{<]*([a-z0-9@][^\s"'\x60)\]}>,;]*)`;
const API_429_MODEL = new RegExp(String.raw`API\s+429\s+for\s+` + MODEL_TOKEN, "i");
const MODEL_NOT_FOUND = new RegExp(String.raw`\bProviderModelNotFoundError:?\s*` + MODEL_TOKEN, "i");

/** Any field-shaped `key=` at line start or after whitespace, empty value included. */
const LOGFMT_KEY_BOUNDARY = /(?:^|\s)[A-Za-z_][A-Za-z0-9_.-]*=/;

function diagnosticAttribution(line: string): DiagnosticAttribution {
  // 1. A structured OpenCode 1.17 record (`level=ERROR message="stream error"
  //    providerID=... modelID=...`) attributes itself from its OWN fields, or
  //    not at all. Once a line is recognised as a structured record, its
  //    free-text payload (`error.error="... API 429 for anthropic/..."`) is
  //    never parsed for attribution: a missing, empty or duplicated
  //    providerID/modelID makes the record unattributed, which is FATAL. A
  //    payload may quote any model id, so falling back to it would let a
  //    malformed primary record downgrade itself.
  //
  //    WHICH lines are structured: ANY line carrying at least one logfmt
  //    `key=` boundary (whitespace- or start-anchored key, empty value
  //    included; see LOGFMT_KEY_BOUNDARY).
  //    Deliberately the widest rule, not a list of OpenCode keys, because
  //    the classification only ever REMOVES downgrades: a structured line can
  //    downgrade solely via one complete providerID + modelID pair, while a
  //    free-text line can downgrade via any model id it quotes. So every line
  //    wrongly counted as structured errs toward FATAL (fail closed), and
  //    every line wrongly counted as free text is a potential false
  //    downgrade. An allow-list of keys (level, message, session.id,
  //    error.*, ...) would re-open the hole for the next key OpenCode adds or
  //    omits; this rule has no key list to fall out of date. The
  //    human-facing diagnostics that free-text attribution exists for
  //    (`Error: API 429 for x`, `ProviderModelNotFoundError: x`, the Claude
  //    credential sentence) carry no `key=value` tokens and still take
  //    path 2. URL query strings (`?a=b`) are not fields: the key must
  //    follow whitespace or the line start.
  //
  //    Field BOUNDARIES must be guaranteed before any field is believed. The
  //    lenient scanner only decides whether a line is logfmt-shaped; the
  //    fields themselves come from the strict whole-line tokenizer. If that
  //    refuses the line (unterminated quote, dangling escape, garbage after a
  //    quote, free-text words), the line is malformed and unattributed: FATAL.
  //    Identity fields must also appear exactly once and BEFORE any `error` /
  //    `error.*` key: OpenCode writes providerID/modelID ahead of the error
  //    payload, so an identity field after it is indistinguishable from one
  //    the payload supplied.
  //
  //    The structured-line GATE is any field-shaped `key=` boundary, value or
  //    no value (`error.error= API 429 for ...` is structured). It must not
  //    be the lenient scanner, which needs a non-empty value and would hand
  //    such a line to free-text attribution. The gate's key class is wider
  //    than the strict tokenizer's (it admits a leading `_`), so any line the
  //    gate admits but the tokenizer cannot parse is malformed: FATAL.
  if (LOGFMT_KEY_BOUNDARY.test(line)) {
    const pairs = parseLogfmtStrict(line);
    if (pairs === null) return {};
    const firstErrorKey = pairs.findIndex(([key]) => key === "error" || key.startsWith("error."));
    const identity = (name: string): string | undefined => {
      const positions = pairs.flatMap(([key], index) => (key === name ? [index] : []));
      if (positions.length !== 1) return undefined;
      if (firstErrorKey !== -1 && positions[0] > firstErrorKey) return undefined;
      const value = pairs[positions[0]][1];
      return value.trim() === "" ? undefined : value;
    };
    const providerID = identity("providerID");
    const modelID = identity("modelID");
    if (providerID !== undefined && modelID !== undefined) {
      return { model: `${providerID}/${modelID}` };
    }
    return {};
  }

  // 2. Free-text model tokens.
  const apiModel = line.match(API_429_MODEL)?.[1];
  const missingModel = line.match(MODEL_NOT_FOUND)?.[1];
  const model = apiModel ?? missingModel;
  if (model !== undefined) return { model };

  // 3. Provider-only: the Claude Code credential sentence names Anthropic
  //    without naming a model. The bare `opencode-claude-auth` plugin tag is
  //    NOT attribution — the plugin logs on every run, whatever the primary
  //    provider, so its name says nothing about who failed.
  if (NO_CREDENTIALS.test(line)) return { provider: "anthropic" };
  return {};
}

/**
 * Is this diagnostic line the PRIMARY runtime's failure?
 *
 * Fail-closed. Returns false (auxiliary) only when the runtime model is
 * established by independent evidence AND the line affirmatively names a
 * provider set disjoint from the runtime's, after normalization. Everything
 * else is primary:
 *   - no observed runtime model (the requested model is a wish, not evidence);
 *   - a line that names nothing, or names a token with no provider identity;
 *   - the same leaf model under any prefix (`xai/grok-4.7` vs
 *     `openrouter/grok-4.7`);
 *   - a shared provider with a different model (`anthropic/claude-opus-4-8`
 *     runtime vs `API 429 for claude-haiku-4-5`): account-level limits, auth
 *     and billing are shared across a provider's models.
 */
function isRuntimeDiagnostic(
  attribution: DiagnosticAttribution,
  observedModel: string | undefined
): boolean {
  if (!observedModel) return true;
  const observed = modelIdentity(observedModel);
  if (!observed) return true;

  let named: ModelIdentity | undefined;
  if (attribution.model !== undefined) {
    named = modelIdentity(attribution.model);
  } else if (attribution.provider !== undefined) {
    named = { providers: new Set([normalizeProvider(attribution.provider)]) };
  }
  if (!named) return true;

  if (named.leaf !== undefined && named.leaf === observed.leaf) return true;
  if (named.providers.size === 0 || observed.providers.size === 0) return true;
  for (const provider of named.providers) {
    if (observed.providers.has(provider)) return true;
  }
  return false;
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
  let bannerSource: "runtime-log" | "banner" | undefined;
  if (modern && !("conflict" in modern) && !("malformed" in modern)) {
    banner = modern;
    bannerSource = "runtime-log";
  }
  // When modern evidence conflicts or is malformed, do not fall back to the
  // legacy banner for identity — the conflict/malformed is reported below.
  if (!banner && !(modern && ("conflict" in modern || "malformed" in modern))) {
    const match = plainStderr.match(/^\s*>\s*([^·]+?)\s*·\s*([^\s]+)\s*$/m);
    if (match) {
      banner = { agent: match[1].trim(), model: match[2] };
      bannerSource = "banner";
    }
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
  const modelEvidence: ModelEvidenceSource =
    bannerSource ?? (input.runtimeModel ? "session-db" : "none");
  const receipt = {
    stdout: input.stdout,
    stderr: input.stderr,
    ...runtimeMeta,
    model_verified: Boolean(observedModel),
    model_evidence: modelEvidence,
  };

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
  // A missing banner is not, by itself, a failed run: OpenCode 1.17 dropped the
  // banner, and a caller whose argv does not surface the INFO record (or whose
  // CLI emits none) would otherwise fail every healthy run. Without evidence,
  // the run is judged by exit code + output (above) and diagnostics (below,
  // all fatal), and the receipt says `model_verified: false`. Strict callers
  // keep the old hard failure.
  if (input.requireModelEvidence === true && input.requestedModel !== undefined && !observedModel) {
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
