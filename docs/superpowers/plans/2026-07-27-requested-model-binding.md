# Requested Model Banner Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fail an internal OpenCode runtime result when an explicitly supplied requested-model label does not match the observed runtime banner model, without selecting a model or expanding any public API.

**Architecture:** Keep the decision at the existing result-classification boundary. `classifySpawnResult()` gains a raw optional `requestedModel` constraint and evaluates it after the established requested-agent checks but before provider-diagnostic attribution; `OpenCodeRuntimeAdapter` forwards `ExecutionSpec.requestedModel` unchanged. The adapter continues to build its default argv only from prompt and requested agent, so this creates no CLI model-selection behavior.

**Tech Stack:** TypeScript, Node.js built-in test runner, tsx loader, OpenCode process adapter.

## Global Constraints

- Modify tests only in `test/spawn-result.test.ts` and `test/runtime-adapter.test.ts`.
- Modify implementation only in `src/spawn-result.ts` and `src/runtime/opencode.ts`.
- `requestedModel` is absent only when it is exactly `undefined`; empty strings and ASCII or Unicode whitespace are supplied raw-label constraints.
- Preserve `runtimeModelsMatch()` exactly: case-insensitive; compare full strings if both values contain `/`; otherwise compare final slash-separated leaves; no trimming, Unicode normalization, coercion, or new parser.
- Parse the banner before classification so raw stdout/stderr and observed banner metadata remain available on every outcome.
- Keep this exact classifier precedence: exit code, empty stdout, explicit fallback, requested-agent missing banner, requested-agent mismatch, requested-model missing banner, requested-model mismatch, then provider diagnostics.
- The missing-banner error is exactly `Requested model but runtime model banner is missing or unparsable`.
- The mismatch error is exactly `Requested model <requested> but runtime model banner reported <observed>`.
- Do not add an MCP field, database field, receipt, lifecycle change, environment variable, provider call, or OpenCode `--model` argv.
- Default OpenCode argv remains `run [--agent <file>] <prompt>`; a custom `buildArgs` remains free to observe the complete raw `ExecutionSpec`.
- If documentation is updated, it must say this is only an internal requested-versus-observed label check; it must not mark the public requested-versus-resolved binding gap complete.
- Use the exact full verifier: `npm run typecheck && npm run build && node scripts/run-tests.mjs`.

---

## File map

| File | Role in this change |
|---|---|
| `test/spawn-result.test.ts` | Defines the requested-model classifier contract, error precedence, raw-output preservation, and normalizer regression pins before implementation changes. |
| `src/spawn-result.ts` | Adds `requestedModel` to the private classifier input and enforces the supplied-label check without changing banner parsing or model matching. |
| `test/runtime-adapter.test.ts` | Proves the adapter forwards the raw label, maps a mismatch to normal failure output, and leaves default/custom argv behavior unchanged. |
| `src/runtime/opencode.ts` | Forwards `spec.requestedModel` to the classifier only. |
| `docs/ADAPTER-CONTRACT.md` | Final, optional claim correction: observed banner matching is not runtime selection, authentication, or attestation. |
| `ROADMAP.md` | Final, optional claim correction: the internal classifier check exists, while a public producer and durable requested/resolved binding remain future work. |

### Task 1: Specify and implement fail-closed requested-model classification

**Files:**
- Modify: `test/spawn-result.test.ts:5-13, after the requested-agent tests, and after diagnostic-attribution tests`
- Modify: `src/spawn-result.ts:1-6, 78-116`

**Interfaces:**
- Consumes: `classifySpawnResult(input: SpawnResultInput): SpawnResultClassification` and the existing `runtimeModelsMatch(expected?: string, observed?: string): boolean`.
- Produces: `SpawnResultInput.requestedModel?: string`, plus classification results that preserve `stdout`, `stderr`, `runtime_agent`, and `runtime_model` on requested-model failures.

- [ ] **Step 1: Write the failing classifier tests**

Add compact table-driven tests and one preservation assertion to `test/spawn-result.test.ts`. Keep each requested value literal so the test proves no truthiness, trim, or Unicode normalization behavior is introduced.

```ts
test('spawn result: requested-model binding distinguishes undefined from supplied blank labels', () => {
  const banner = '> oracle · anthropic/claude-sonnet-4\n';
  for (const requestedModel of [undefined, '', '   ', '\u2003']) {
    const result = classifySpawnResult({
      exitCode: 0,
      stdout: 'answer',
      stderr: banner,
      requestedModel,
    });
    assert.equal(result.success, requestedModel === undefined);
    if (requestedModel !== undefined) {
      assert.equal(
        result.error,
        `Requested model ${requestedModel} but runtime model banner reported anthropic/claude-sonnet-4`,
      );
    }
  }
});

test('spawn result: requested-model binding preserves existing matcher semantics', () => {
  const cases = [
    ['ANTHROPIC/CLAUDE-SONNET-4', 'anthropic/claude-sonnet-4', true],
    ['claude-sonnet-4', 'anthropic/claude-sonnet-4', true],
    ['anthropic/claude-sonnet-4', 'claude-sonnet-4', true],
    ['vendor/a/leaf', 'vendor/a/leaf', true],
    ['vendor/a/leaf', 'other/a/leaf', false],
    ['anthropic/claude-sonnet-4', 'openai/claude-sonnet-4', false],
    ['claude-sonnet-4', 'grok-4.5', false],
  ] as const;
  for (const [requestedModel, observedModel, expectedSuccess] of cases) {
    const result = classifySpawnResult({
      exitCode: 0,
      stdout: 'answer',
      stderr: `> oracle · ${observedModel}\n`,
      requestedModel,
    });
    assert.equal(result.success, expectedSuccess, `${requestedModel} / ${observedModel}`);
  }
});
```

Also add explicit tests for the missing-banner error; exit, empty-stdout, fallback, and requested-agent-mismatch precedence with a supplied mismatching model; a matching model retaining the existing auxiliary-diagnostic warning; a mismatching model winning before a primary diagnostic; and a mismatch preserving raw stdout/stderr plus `runtime_agent` and `runtime_model`.

```ts
test('spawn result: requested-model mismatch wins before diagnostics and preserves observed receipt data', () => {
  const stdout = 'partial answer\n';
  const stderr = [
    '> oracle · anthropic/claude-sonnet-4',
    'Error: API 429 for anthropic/claude-sonnet-4',
  ].join('\n');
  const result = classifySpawnResult({
    exitCode: 0,
    stdout,
    stderr,
    requestedAgent: 'oracle',
    requestedModel: 'openai/gpt-5',
  });
  assert.equal(result.success, false);
  assert.equal(result.error, 'Requested model openai/gpt-5 but runtime model banner reported anthropic/claude-sonnet-4');
  assert.equal(result.stdout, stdout);
  assert.equal(result.stderr, stderr);
  assert.equal(result.runtime_agent, 'oracle');
  assert.equal(result.runtime_model, 'anthropic/claude-sonnet-4');
});
```

- [ ] **Step 2: Run the classifier test file to verify RED**

Run:

```sh
node --test --import tsx test/spawn-result.test.ts
```

Expected: FAIL because `SpawnResultInput` does not accept `requestedModel`, or because the new requested-model success/failure assertions do not yet hold.

- [ ] **Step 3: Add the minimal classifier implementation**

In `src/spawn-result.ts`, add the optional field without changing `runtimeModelsMatch()`:

```ts
export interface SpawnResultInput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  requestedAgent?: string;
  requestedModel?: string;
}
```

After the existing requested-agent mismatch return and before `diagnostics`, add exactly these two checks:

```ts
if (input.requestedModel !== undefined && !banner) {
  return {
    ...receipt,
    success: false,
    error: 'Requested model but runtime model banner is missing or unparsable',
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
```

Do not trim, normalize, validate, interpolate into argv, or alter the existing provider-diagnostic call sites.

- [ ] **Step 4: Run the classifier tests to verify GREEN**

Run:

```sh
node --test --import tsx test/spawn-result.test.ts
npm run typecheck
```

Expected: both commands exit `0`; all prior requested-agent and diagnostic-attribution tests still pass.

- [ ] **Step 5: Commit the classifier slice**

```sh
git add test/spawn-result.test.ts src/spawn-result.ts
git commit -m "feat(runtime): bind requested model to observed banner"
```

### Task 2: Thread the label through OpenCode without changing launch arguments

**Files:**
- Modify: `test/runtime-adapter.test.ts:269-285`
- Modify: `src/runtime/opencode.ts:61-65, 89-110`

**Interfaces:**
- Consumes: `ExecutionSpec.requestedModel?: string`, the Task 1 classifier contract, and `OpenCodeRuntimeAdapterOptions.buildArgs?: (spec: ExecutionSpec) => string[]`.
- Produces: adapter `RuntimeResult` failures carrying the classifier’s requested-model error and observed identity metadata; unchanged default argv behavior.

- [ ] **Step 1: Write the failing adapter tests**

Extend the OpenCode test-double coverage so it executes both matching and mismatching requested labels, verifies the received custom-builder spec, and captures default spawn args through a `spawnProcess` double. Keep the model input raw in the custom-builder assertion.

```ts
test('OpenCode adapter forwards requested-model labels and preserves observed identity on mismatch', async () => {
  let customBuilderSpec: ExecutionSpec | undefined;
  const adapter = new OpenCodeRuntimeAdapter({
    command: process.execPath,
    buildArgs: (request) => {
      customBuilderSpec = request;
      return [FIXTURE, 'opencode', request.prompt];
    },
  });
  const matching = await execute(adapter, spec({ requestedModel: 'claude-sonnet-4' }));
  assert.equal(matching.status, 'success');
  assert.equal(customBuilderSpec?.requestedModel, 'claude-sonnet-4');

  const mismatching = await execute(adapter, spec({ requestedModel: 'openai/gpt-5' }));
  assert.equal(mismatching.status, 'failure');
  assert.equal(mismatching.error, 'Requested model openai/gpt-5 but runtime model banner reported anthropic/claude-sonnet-4');
  assert.deepEqual(mismatching.identity, {
    adapterId: 'opencode-cli',
    agent: 'oracle',
    model: 'anthropic/claude-sonnet-4',
    evidence: 'observed',
  });
});
```

Add a second test whose injected `spawnProcess` records the default argument vector while replacing the actual child command with the existing deterministic runtime fixture. This proves the adapter's default builder without launching `opencode`:

```ts
test('OpenCode adapter keeps default argv free of requested-model selection', async () => {
  let observedArgs: string[] | undefined;
  const adapter = new OpenCodeRuntimeAdapter({
    command: process.execPath,
    spawnProcess: (_command, args, options) => {
      observedArgs = [...args];
      return spawn(process.execPath, [FIXTURE, 'opencode', 'review'], options);
    },
  });
  const result = await execute(adapter, spec({
    prompt: 'review',
    requestedAgent: 'oracle',
    requestedModel: 'openai/gpt-5',
  }));
  assert.equal(result.status, 'failure');
  assert.deepEqual(observedArgs, ['run', '--agent', 'oracle', 'review']);
  assert.equal(observedArgs?.includes('--model'), false);
  assert.equal(observedArgs?.includes('openai/gpt-5'), false);
});
```

The wrapper must return the real deterministic fixture child shown above; do not invoke the real `opencode` binary.

- [ ] **Step 2: Run the focused adapter test file to verify RED**

Run:

```sh
node --test --import tsx test/runtime-adapter.test.ts
```

Expected: the mismatch assertion fails because `OpenCodeRuntimeAdapter` does not yet pass `spec.requestedModel` to `classifySpawnResult`; default-argv assertions should describe the existing no-model behavior and protect it from the implementation step.

- [ ] **Step 3: Add the one-field adapter plumbing change**

In the `classifySpawnResult` call inside `OpenCodeRuntimeAdapter.start()`, add only this property:

```ts
requestedModel: spec.requestedModel,
```

Keep the default builder exactly equivalent to:

```ts
(spec) => buildRunArgs({ prompt: spec.prompt, agentFile: spec.requestedAgent })
```

Do not change `buildRunArgs`, `ExecutionSpec`, child environment construction, command selection, adapter identity evidence, storage, or diagnostics mapping.

- [ ] **Step 4: Run focused classifier and adapter tests to verify GREEN**

Run:

```sh
node --test --import tsx test/spawn-result.test.ts test/runtime-adapter.test.ts
npm run typecheck
```

Expected: both commands exit `0`; match returns `status: 'success'`, mismatch returns normal adapter `status: 'failure'` with observed identity, default argv contains no model argument, and custom builders receive the untouched raw label.

- [ ] **Step 5: Commit the adapter plumbing slice**

```sh
git add test/runtime-adapter.test.ts src/runtime/opencode.ts
git commit -m "feat(runtime): enforce requested model banner binding"
```

### Task 3: Correct only the public claim boundary and complete verification

**Files:**
- Modify: `docs/ADAPTER-CONTRACT.md:99-105`
- Modify: `ROADMAP.md:147-149`

**Interfaces:**
- Consumes: the focused GREEN evidence from Tasks 1 and 2.
- Produces: documentation that distinguishes an internal raw-label-to-observed-banner classifier check from public model selection and durable requested/resolved identity binding.

- [ ] **Step 1: Make the narrow documentation correction**

Add this sentence after the `Outbound worker launch` row in the runtime-boundary table:

```md
An explicitly supplied internal `ExecutionSpec.requestedModel` may fail-close classification when it does not match the observed OpenCode banner model. This is a raw-label check only: it does not select a model, expose a public runtime input, authenticate a provider, or attest runtime identity.
```

Replace the P1 Roadmap bullet with this bounded status language:

```md
- P1 spawn receipts: resolved runtime agent/model banner capture is implemented. The internal OpenCode classifier can fail-close an explicitly supplied requested-model label against that observed banner, without selecting a model or exposing a public model input. Capability `model` remains routing self-description, not proof of runtime identity; public request production and durable requested-versus-resolved receipt binding remain future work.
```

Do not move the item to “Recently shipped,” do not use “complete,” and do not alter the A2A 4C-1 or public-runtime-selection status.

- [ ] **Step 2: Run the exact full verifier**

Run:

```sh
npm run typecheck && npm run build && node scripts/run-tests.mjs
```

Expected: exit `0` with the full suite passing. Do not substitute `npm test`; the command above is the required exact verifier.

- [ ] **Step 3: Inspect the scoped diff and scan staged content for secrets**

Run:

```sh
git diff --check HEAD~2
git diff HEAD~2 -- docs/ADAPTER-CONTRACT.md ROADMAP.md src/spawn-result.ts src/runtime/opencode.ts test/spawn-result.test.ts test/runtime-adapter.test.ts
git add docs/ADAPTER-CONTRACT.md ROADMAP.md
gitleaks git --staged --no-banner
```

Expected: no whitespace errors, only the six planned files changed across the implementation commits plus the two bounded claim-correction docs, and gitleaks exits `0`.

- [ ] **Step 4: Obtain an independent exact-diff review**

Give the reviewer the staged final range from `git diff HEAD~2` (which includes both committed implementation slices and the staged documentation correction) and these non-negotiables: `undefined` versus empty/whitespace, case and multi-slash matcher preservation, classifier precedence, banner-reported wording, raw metadata preservation, default argv unchanged, custom-builder visibility, and no public model-selection claim. Resolve any substantive finding before the documentation commit.

- [ ] **Step 5: Commit the claim correction after review**

```sh
git add docs/ADAPTER-CONTRACT.md ROADMAP.md
git commit -m "docs(runtime): bound requested model banner claims"
```

## Review checklist

- [ ] `requestedModel: undefined` remains banner-optional and behaviorally identical to prior callers.
- [ ] `''`, ASCII whitespace, and Unicode whitespace remain supplied labels and fail only through the existing matcher.
- [ ] Case-insensitive, one-side-qualified leaf matching and both-qualified whole-string/multi-slash behavior are unchanged.
- [ ] Earlier exit, empty-output, fallback, and requested-agent failures win; requested-model mismatches win before provider diagnostics.
- [ ] Requested-model failure preserves raw stdout/stderr and parsed observed banner metadata.
- [ ] Default OpenCode argv and child environment contain no requested-model selection behavior; custom `buildArgs` still sees the complete raw spec.
- [ ] Docs do not claim a public input, selection, authentication, attestation, durable receipt binding, or Roadmap completion.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-27-requested-model-binding.md`. Execute it task-by-task with `superpowers:executing-plans`, keeping the three commits isolated for classifier behavior, adapter plumbing, and bounded claim correction.
