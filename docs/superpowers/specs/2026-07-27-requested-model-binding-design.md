# Requested-model binding design

## Decision

Add one narrow, fail-closed classifier/adapter binding for an explicitly
requested model. The existing OpenCode result classifier already captures an
observed runtime banner and rejects a requested-agent mismatch. This slice adds
the parallel check for `requestedModel`; it does not add a way for any public
caller to request, select, or configure a model.

The implementation boundary is limited to:

- `SpawnResultInput` gaining optional `requestedModel`;
- `classifySpawnResult()` enforcing a requested-versus-observed model check;
- `OpenCodeRuntimeAdapter` passing `ExecutionSpec.requestedModel` to that
  classifier; and
- focused classifier and adapter tests.

No MCP tool schema, Agent record, SQLite shape, lifecycle work item, template,
CLI output, provider catalog, OpenCode argv construction, execution behavior,
retry behavior, receipt vocabulary, or evidence level changes in this slice.

## Existing evidence and gap

The current classifier extracts an OpenCode stderr banner of the form
`> <agent> · <model>` and preserves its agent/model values as observed runtime
metadata. If a requested agent is supplied, a missing banner or a different
banner agent fails the run. `OpenCodeRuntimeAdapter` maps that metadata into a
`RuntimeResult` with `observed` evidence.

`ExecutionSpec` already has an optional `requestedModel`, documented as routing
input only. It is currently not supplied by either spawn path and has no
production consumer. `runtimeModelsMatch()` exists, but today it is only used
to decide whether a provider diagnostic belongs to the observed banner model.
Thus a model can be observed and persisted at terminal projection without a
requested model ever being represented or checked.

This design closes only the internal classifier/adapter half of that gap. It
does not make the ROADMAP item publicly complete: no current MCP input can
populate `ExecutionSpec.requestedModel`.

## Contract

```ts
interface SpawnResultInput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  requestedAgent?: string;
  requestedModel?: string;
}
```

`requestedModel` is absent only when it is exactly `undefined`. The
implementation must use `requestedModel !== undefined`, not truthiness. Empty
strings and ASCII or Unicode whitespace are explicit raw-label constraints;
they are passed unchanged to the existing normalizer and fail against a normal
parseable banner model. This slice does not trim, normalize Unicode, coerce, or
reinterpret a supplied value as absent.

When `requestedModel` is `undefined`, classification is behaviorally compatible
with the current path: it neither requires a banner nor adds a new failure.

When `requestedModel` is present, a successful classified result requires a
parseable banner and `runtimeModelsMatch(requestedModel, banner.model)` to be
true. Otherwise the classifier returns `success: false` while preserving the
captured stdout, stderr, and any observed banner fields:

- no parseable banner: `Requested model but runtime model banner is missing or
  unparsable`;
- parsed banner with non-matching model: `Requested model <requested> but
  runtime model banner reported <observed>`.

The existing normalizer is the binding rule, not a new identity parser:

- case is ignored;
- if both values are provider-qualified, provider and leaf must be identical;
- if exactly one side is unqualified, identical leaves match; and
- missing or empty values fail matching.

This is a provider-neutral requested-model **label** constraint, not a provider
identity comparison. The one-side-unqualified leaf match is existing
compatibility behavior, not evidence that the labels name the same provider.
The implementation must retain the current `runtimeModelsMatch()` semantics
exactly, including its case folding and its whole-string comparison when both
labels contain a slash. It must not add trimming, NFKC normalization, a new
grammar, or a different multi-slash interpretation.

The requested value remains a caller/runtime input and the banner remains
observed output. A matching pair means only that these two strings matched the
normalizer. It is not authentication, attestation, authorization, provider
availability, catalog proof, account/session proof, or evidence that a model
was selected by Agent Mesh.

`OpenCodeRuntimeAdapter` passes `spec.requestedModel` unchanged into
`classifySpawnResult`. It does not place that value in `buildRunArgs`, an
environment variable, a provider SDK call, a receipt, or a database write.
The default `buildRunArgs` receives only prompt and agent-file data and remains
unchanged. A caller-provided custom `buildArgs` still receives the complete
`ExecutionSpec`, including its raw `requestedModel`; this is existing adapter
extension behavior, not Agent Mesh model selection.

## Deterministic classification order

The classifier continues to parse the banner first so observed metadata is
available on every outcome. It then evaluates checks in this exact order:

1. non-zero exit code;
2. empty stdout;
3. explicit fallback text;
4. existing requested-agent missing-banner check;
5. existing requested-agent mismatch check;
6. requested-model missing-banner check;
7. requested-model mismatch check; and
8. existing primary-versus-auxiliary provider diagnostic classification.

An earlier failure wins. In particular, a non-zero exit, empty stdout, explicit
fallback, or requested-agent mismatch must retain its current result even when
a requested model also would not match. A model mismatch is checked before
diagnostic attribution so an explicit requested identity cannot be hidden by a
later warning or error classification.

## Compatibility and non-claims

- Existing callers that omit `requestedModel` keep their current success,
  failure, banner, diagnostic, and output behavior.
- Existing requested-agent behavior remains unchanged and continues to run
  before model binding.
- Provider diagnostic attribution continues to use `runtimeModelsMatch`; this
  slice does not change its normalization semantics.
- `requestedModel` is not a public runtime selector. Adding an MCP field or an
  OpenCode `--model` argument would require a separate reviewed adapter
  contract, evidence for the real CLI syntax, and explicit compatibility work.
- This slice makes no argv, selection, launch, provider-call, or execution
  change. It may nevertheless turn an otherwise successful child result into a
  failed classified result when an explicit label does not match the observed
  banner.
- Capability `model` remains routing self-description and cannot be copied into
  `requestedModel` or treated as runtime proof.
- The local observed banner remains `observed`, not `reported`, `attested`, or
  authenticated identity.
- This slice does not create an immutable request/response binding receipt or
  preserve an attempt-by-attempt identity history. Terminal agent projection,
  storage, durable lifecycle, retries, and inspection are explicitly out of
  scope.
- It deliberately adds no input grammar or validation because no public
  producer currently populates `requestedModel`; raw-label mismatch already
  fails closed. Any future producer must define and test its own validation
  deliberately rather than inheriting an accidental parser here.

## TDD matrix

Write the tests first, run them red, then implement only the classifier and
adapter plumbing.

| Test | Input | Required result |
|---|---|---|
| undefined regression | successful bannered and bannerless results with `requestedModel: undefined` | existing behavior is unchanged |
| explicit empty/whitespace | empty string, ASCII whitespace, and Unicode whitespace requested against a parseable banner model | each is a supplied constraint and fails matching; none is treated as absent |
| qualified exact match | `anthropic/claude-sonnet-4` requested and observed | success |
| case and one-side-qualified match | case variants; `claude-sonnet-4` requested and `anthropic/claude-sonnet-4` observed, and the converse | success under the existing case/leaf compatibility rule |
| multi-slash normalizer pin | labels containing multiple slashes | retain existing whole-string behavior whenever both labels contain a slash; do not infer a trailing leaf |
| qualified provider mismatch | `anthropic/claude-sonnet-4` requested and `openai/claude-sonnet-4` observed | fail closed with requested/observed model error |
| leaf mismatch | distinct model leaves | fail closed with requested/observed model error |
| missing banner | successful stdout and requested model, no parseable banner | fail closed with missing/unparseable model-banner error |
| existing precedence, bannered and bannerless | exit/empty/fallback/requested-agent failure plus requested model, with and without a parseable banner | original earlier failure remains the error; a parseable banner is still preserved as observed metadata |
| diagnostics precedence | an otherwise matching or mismatching requested model plus primary/auxiliary diagnostics | model mismatch wins before diagnostics; matching labels retain current diagnostic behavior |
| raw-output/meta preservation | a requested-model mismatch with banner, stdout, and stderr | fail result preserves raw stdout/stderr and parsed `runtime_agent`/`runtime_model` metadata |
| adapter plumbing | OpenCode test double receives `ExecutionSpec.requestedModel` and emits a matching or mismatching banner | matching result succeeds; mismatch result fails through normal adapter output |
| default argv unchanged | default OpenCode adapter with a supplied `requestedModel` | default `buildRunArgs` remains `run [--agent <file>] <prompt>`; no model argv is added |
| custom builder visibility | custom `buildArgs` test double | it receives the original raw `ExecutionSpec.requestedModel` without selection behavior being inferred |

The focused commands are:

```sh
node --test --import tsx test/spawn-result.test.ts test/runtime-adapter.test.ts
npm run typecheck
```

The exact full verifier is:

```sh
npm run typecheck && npm run build && node scripts/run-tests.mjs
```

No live provider, credential, network, or real ledger test is part of the
acceptance evidence.

## Deferred work and review record

A larger proposal suggested binding receipts that would retain requested and
resolved identities through storage and lifecycle projection. That is valuable
but crosses the deliberately excluded Agent, database, durable lifecycle,
retry, and receipt-vocabulary surfaces, so it is deferred rather than folded
into this collision-minimizing slice. The broader proposal is not evidence that
such receipts exist.

The Grok review input favored that larger receipt-oriented direction; it is
recorded here only as a deferred suggestion, not as acceptance or consensus.
The MiniMax review attempt timed out and supplies no review conclusion.

Future work that exposes a request source must first choose whether it is a
validation-only expected-model constraint or a true model-selection request.
Those are different contracts and must not be conflated.
