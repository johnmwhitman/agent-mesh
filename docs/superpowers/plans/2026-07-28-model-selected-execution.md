# Model-selected OpenCode execution implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `spawn_fleet` and `attach_agent` select an OpenCode `provider/model`, preserve that request across retries and Discussion wakeups, and fail closed against the observed runtime banner.

**Architecture:** Add one validated public `model` field and one immutable `Agent.requested_model` field. Thread it through legacy and durable `ExecutionSpec`, build a fixed `opencode run --model <value>` argv, and replace Discussion's raw process launch with a deferred proxy over the default `RuntimeAdapter`. Keep requested identity separate from observed `runtime_model`; preserve all omitted-model behavior.

**Tech Stack:** TypeScript, Node.js built-in test runner, MCP SDK, SQLite JSON projection, OpenCode CLI, MeshFleet RuntimeAdapter.

## Global Constraints

- Work only in the isolated `codex/model-selected-execution-20260728` worktree.
- Run each task sequentially: one builder, then contract review, then quality
  review, then controller verification.
- Write a failing test before each production change and record the exact RED
  signal before making it GREEN.
- MiniMax and Grok are implementation workers, not advisory-only reviewers.
- Validate `provider/model` syntax locally; allow additional slashes after the
  first slash; do not catalog-check or normalize.
- `undefined` alone means omitted. Do not use truthiness.
- Never infer selection from `Capability.model`.
- Keep `Agent.requested_model` immutable and
  `Agent.runtime_model` observed-only.
- Preserve `runtimeModelsMatch()` and classifier precedence.
- Discussion stays one-shot and keeps synchronous `SpawnFn`; bridge the async
  adapter with a cancellation-aware deferred proxy.
- Do not add SDKs, credentials, network probes, provider catalogs, generic
  argv, budget policy, templates, multi-host execution, npm publish, or deploy.
- Rebuild before conformance capture; never guess the catalog SHA.
- Full verifier:

```sh
npm run typecheck && npm run build && node scripts/run-tests.mjs
```

## File map

| File | Role |
|---|---|
| `src/spawn-config.ts` | Validate/build the fixed model-selection argv input. |
| `src/runtime/opencode.ts` | Put `ExecutionSpec.requestedModel` on default OpenCode argv. |
| `test/spawn-config.test.ts` | Exact argv contract and omission regression. |
| `test/runtime-adapter.test.ts` | Default adapter model selection and fail-closed result proof. |
| `src/core.ts` | Add durable `Agent.requested_model`. |
| `src/index.ts` | Advertise/validate public fields and wire legacy/durable spawns. |
| `src/lifecycle-execution.ts` | Persist and reconstruct selected model across durable recovery/retry. |
| `src/tool-args.ts` | Add a narrow provider/model validator if reuse is appropriate. |
| `test/spawn-contract.test.ts` | Reject invalid public selectors before writes; prove valid persistence. |
| `test/spawn-model-retry.test.ts` | Prove real legacy retries keep the selected argv. |
| `test/lifecycle-execution.test.ts` | Prove durable launch/recovery model preservation. |
| `src/verify.ts` | Detect terminal request/observation contradictions without attestation claims. |
| `test/verify.test.ts` | Pin selected complete-agent evidence consistency. |
| `src/discussion-store.ts` | Carry persisted launch config into `SpawnJob`. |
| `src/discussion-mcp.ts` | Bridge Discussion spawn/kill to the default RuntimeAdapter. |
| `test/discussion-reservation.test.ts` | Update the sole fake ledger for the launch-config lookup. |
| `test/discussion-mcp.test.ts` | Prove inherited selection and async cancel/result behavior. |
| `blackbox/a2a-conformance-v0.1/manifest.json` | Pin the rebuilt live catalog and `attach_agent.model`. |
| `docs/ADAPTER-CONTRACT.md` | Document selection versus observed evidence. |
| `ROADMAP.md` | Mark only this bounded public-selection gap complete. |

### Task 1: Select a model in the OpenCode runtime

**Builder:** MiniMax through OpenCode Go

**Contract reviewer:** Grok

**Quality reviewer:** controller

**Files:**
- Modify: `test/spawn-config.test.ts`
- Modify: `test/runtime-adapter.test.ts`
- Modify: `src/spawn-config.ts`
- Modify: `src/runtime/opencode.ts`

- [ ] **Step 1: Write exact failing argv tests**

Add:

```ts
test("buildRunArgs: requested model precedes the prompt", () => {
  assert.deepEqual(
    buildRunArgs({ prompt: "review", requestedModel: "opencode-go/minimax-m3" }),
    ["run", "--model", "opencode-go/minimax-m3", "review"],
  );
});

test("buildRunArgs: model precedes agent and prompt", () => {
  assert.deepEqual(
    buildRunArgs({
      prompt: "review",
      requestedModel: "kilo/kilo-auto/free",
      agentFile: "oracle",
    }),
    ["run", "--model", "kilo/kilo-auto/free", "--agent", "oracle", "review"],
  );
});
```

Keep the existing prompt-only and agent-only tests unchanged.

- [ ] **Step 2: Flip the obsolete adapter non-selection pin**

Replace the existing default-argv assertion that requires `--model` to be
absent. With an injected `spawnProcess`, assert:

```ts
assert.deepEqual(observedArgs, [
  "run",
  "--model",
  "openai/gpt-5",
  "--agent",
  "oracle",
  "review",
]);
```

Add an omitted-model case asserting the old exact vector.

- [ ] **Step 3: Run focused tests and capture RED**

```sh
node --test --import tsx test/spawn-config.test.ts test/runtime-adapter.test.ts
```

Expected RED: `RunArgsInput` rejects `requestedModel`, and the adapter's
captured argv omits `--model`.

- [ ] **Step 4: Implement the smallest argv change**

Add `requestedModel?: string` to `RunArgsInput`. In `buildRunArgs()`, append
`"--model", input.requestedModel` when it is not `undefined`, before the
existing optional agent flag. Change the default OpenCode builder to:

```ts
buildRunArgs({
  prompt: spec.prompt,
  requestedModel: spec.requestedModel,
  agentFile: spec.requestedAgent,
})
```

- [ ] **Step 5: Run focused tests and typecheck for GREEN**

```sh
node --test --import tsx test/spawn-config.test.ts test/runtime-adapter.test.ts test/spawn-result.test.ts
npm run typecheck
```

Expected GREEN: exact vectors pass; matching/mismatch classifier coverage stays
green; omitted model remains unchanged.

- [ ] **Step 6: Commit Task 1**

```sh
git add src/spawn-config.ts src/runtime/opencode.ts test/spawn-config.test.ts test/runtime-adapter.test.ts
git commit -m "feat(runtime): select requested OpenCode model"
```

### Task 2: Validate, persist, and retry the request

**Builder:** Grok Build

**Contract reviewer:** MiniMax

**Quality reviewer:** controller

**Files:**
- Modify: `src/core.ts`
- Modify: `src/index.ts`
- Modify: `src/lifecycle-execution.ts`
- Modify: `src/tool-args.ts`
- Modify: `test/spawn-contract.test.ts`
- Modify: `test/lifecycle-execution.test.ts`

- [ ] **Step 1: Write public-boundary RED tests**

Extend the stdio contract tests with isolated database profiles:

```ts
test("spawn_fleet persists a valid requested model", async () => {
  const res = await callTool(dir, "spawn_fleet", {
    agents: [{
      role: "builder",
      prompt: "build",
      model: "opencode-go/minimax-m3",
    }],
  }, "model-spawn");
  assert.equal(res.isError, undefined);
  assert.equal(Object.values(readLedger(dir).agents)[0]?.requested_model, "opencode-go/minimax-m3");
});
```

Add the equivalent `attach_agent` proof. Add a table for non-string, `null`,
empty, whitespace, no slash, empty provider, empty model, embedded whitespace,
and 257-character selectors. For every refusal assert zero new Agent rows and
no spawn observation. Add omission controls asserting no `requested_model`
property.

- [ ] **Step 2: Write a real legacy-retry RED test**

Create `test/spawn-model-retry.test.ts`. Launch the built stdio server with:

- an isolated database/event-log profile;
- a temporary executable `opencode` test double first on `PATH`;
- `MESHFLEET_RETRY_BASE_MS=1`; and
- legacy lifecycle mode.

The test double appends its argv as JSON Lines to a temporary file, emits a
parseable mismatching/failing banner, and exits non-zero. Call `spawn_fleet`
with `model: "opencode-go/minimax-m3"`, wait boundedly for three invocations,
then terminate the server and assert every recorded vector contains:

```ts
["run", "--model", "opencode-go/minimax-m3"]
```

in that order. The test must fail before implementation because all attempts
omit the selector; it must not reimplement `SpawnAgentInput` or the spec merge
inside the test.

- [ ] **Step 3: Write durable lifecycle RED tests**

Using the fake `RuntimeAdapter`, prove:

1. `createFleet()` persists `requested_model`;
2. the first `start(spec)` sees `requestedModel`;
3. a failed attempt followed by a durable retry sees the same value; and
4. reconstructing a coordinator from the existing ledger still reads the
   value from the Agent row.

- [ ] **Step 4: Run focused tests and capture RED**

```sh
npm run build
node --test --import tsx \
  test/spawn-contract.test.ts \
  test/spawn-model-retry.test.ts \
  test/lifecycle-execution.test.ts
```

Expected RED: public schemas/handlers ignore or reject `model`,
`Agent.requested_model` is absent, and runtime specs lack `requestedModel`.

- [ ] **Step 5: Add the selector validator**

Implement a side-effect-free validator returning the established argument error
format. It must reject unless:

```ts
typeof value === "string"
&& value.length <= 256
&& !/\s/u.test(value)
&& value.indexOf("/") > 0
&& value.indexOf("/") < value.length - 1
```

Do not trim or catalog-check.

- [ ] **Step 6: Wire the legacy path**

Add `requested_model?: string` to `Agent` and `requestedModel?: string` to
`SpawnAgentInput`. Advertise `model` in both MCP schemas. Validate before the
transaction. Persist `requested_model` in `_registerAgent()`, add it to the
`ExecutionSpec` built by `trySpawn()`, and preserve it in the input passed to
every retry.

- [ ] **Step 7: Wire the durable path**

Add `requestedModel?: string` to `DurableAgentSpec`. Persist it during
`createFleet()` and `attachAgent()`. In every durable launch construct:

```ts
requestedModel: state.agent.requested_model,
```

from the ledger row. Do not use only the original in-memory spec.

- [ ] **Step 8: Run focused tests and typecheck for GREEN**

```sh
npm run build
node --test --import tsx \
  test/spawn-contract.test.ts \
  test/spawn-model-retry.test.ts \
  test/lifecycle-execution.test.ts
npm run typecheck
```

Expected GREEN: all invalid inputs refuse before writes; valid selections
persist and reach first/recovered/retried execution specs.

- [ ] **Step 9: Commit Task 2**

```sh
git add src/core.ts src/index.ts src/lifecycle-execution.ts src/tool-args.ts test/spawn-contract.test.ts test/spawn-model-retry.test.ts test/lifecycle-execution.test.ts
git commit -m "feat(lifecycle): preserve requested model"
```

### Task 3: Unify Discussion execution and verify evidence

**Builder:** MiniMax through OpenCode Go

**Contract reviewer:** Grok

**Quality reviewer:** controller

**Files:**
- Modify: `src/discussion-store.ts`
- Modify: `src/discussion-mcp.ts`
- Modify: `src/verify.ts`
- Modify: `test/discussion-reservation.test.ts`
- Modify: `test/discussion-mcp.test.ts`
- Modify: `test/verify.test.ts`

- [ ] **Step 1: Add launch-config and verifier RED tests**

In the fake Discussion ledger, implement the proposed
`agentLaunchConfig(agentId, fleetId)` and assert a selected participant's
`SpawnJob` contains both stored request fields. Assert omission yields both
fields `undefined`.

Add verifier tests:

```ts
test("verify: complete selected agent requires observed runtime model", () => {
  // requested_model present, status complete, runtime_model absent
  assert.equal(
    report.findings.some((f) => f.check === "agent.requested_model_unobserved"),
    true,
  );
});

test("verify: complete selected agent rejects contradictory observation", () => {
  // requested_model opencode-go/minimax-m3, runtime_model openai/gpt-5
  assert.equal(
    report.findings.some((f) => f.check === "agent.requested_model_mismatch"),
    true,
  );
});
```

Add controls proving failed/interrupted agents may lack observation and a match
does not change evidence vocabulary.

- [ ] **Step 2: Add deferred-adapter RED tests**

Use a fake `RuntimeAdapter` whose `start()` promise is controlled. Prove:

- Discussion supplies stored `requestedAgent` and `requestedModel`;
- successful/mismatched runtime completion invokes `onExit` once;
- a deadman kill before `start()` resolves causes the late handle to be
  cancelled once;
- an adapter start rejection follows the existing failed-exit path;
- no automatic retry occurs; and
- omitted model remains absent from the spec.

- [ ] **Step 3: Run focused tests and capture RED**

```sh
node --test --import tsx \
  test/discussion-reservation.test.ts \
  test/discussion-mcp.test.ts \
  test/verify.test.ts
```

Expected RED: `LedgerTx` and `SpawnJob` lack launch config, production
Discussion bypasses `RuntimeAdapter`, and the verifier has no binding checks.

- [ ] **Step 4: Carry immutable config into SpawnJob**

Add:

```ts
agentLaunchConfig(
  agentId: string,
  fleetId: string,
): { requestedAgent?: string; requestedModel?: string } | undefined;
```

to `LedgerTx`. Implement it in `RealLedgerTx` and the one fake ledger. Read it
inside the reservation-to-start transaction. Obtain `fleetId` from the
canonical head message already returned by `tx.getMessage(headMessageId)`;
require that the Agent belongs to that fleet, then copy it into required
`SpawnJob.fleet_id` and copy the result into optional
`SpawnJob.requested_agent` and `SpawnJob.requested_model`. Treat a missing
launch config for an otherwise valid Agent as a failed start.

- [ ] **Step 5: Replace raw Discussion spawn with a deferred adapter proxy**

Inject or retrieve the default `RuntimeAdapter`. `makeSpawnFn()` must:

1. construct the Discussion prompt and this complete `ExecutionSpec`:

   ```ts
   {
     fleetId: job.fleet_id,
     agentId: job.agent_id,
     prompt: buildDiscussionPrompt(job),
     requestedAgent: job.requested_agent,
     requestedModel: job.requested_model,
     cwd: process.cwd(),
     timeoutMs: Math.max(1, job.deadline - Date.now()),
   }
   ```

2. call `runtime.start(spec)` without blocking the ledger transaction;
3. synchronously return a proxy `SpawnHandle`;
4. after start, honor any already-requested cancellation and still call
   `runtime.wait(handle)` to drain the runtime;
5. map success to code `0`, map failure, cancellation, timeout, and wait
   rejection to a non-zero/null code, and invoke `onExit` exactly once; and
6. expose a kill operation that records cancellation before a handle exists
   and calls `runtime.cancel(handle, "discussion deadline")` after it exists.

Keep the store's `SpawnFn` and `KillFn` types synchronous. Remove direct
`child_process.spawn`, `AGENT_SPAWN_STDIO`, and direct `buildRunArgs` usage
from production Discussion wiring.

- [ ] **Step 6: Add narrow verifier consistency checks**

Import and reuse `runtimeModelsMatch()`. Error only for a `complete` agent with
a selected model and missing/contradictory `runtime_model`. Do not alter
receipt scopes or evidence levels.

- [ ] **Step 7: Run focused tests and typecheck for GREEN**

```sh
node --test --import tsx \
  test/discussion-reservation.test.ts \
  test/discussion-mcp.test.ts \
  test/verify.test.ts
npm run typecheck
```

Expected GREEN: selection inheritance, deferred cancellation, terminal mapping,
and local evidence consistency all pass without Discussion retries.

- [ ] **Step 8: Commit Task 3**

```sh
git add src/discussion-store.ts src/discussion-mcp.ts src/verify.ts test/discussion-reservation.test.ts test/discussion-mcp.test.ts test/verify.test.ts
git commit -m "feat(discussion): inherit selected runtime model"
```

### Task 4: Re-pin conformance, correct claims, and verify live selection

**Builder:** Grok Build

**Contract reviewer:** MiniMax

**Quality reviewer:** controller

**Files:**
- Modify: `blackbox/a2a-conformance-v0.1/manifest.json`
- Modify: `docs/ADAPTER-CONTRACT.md`
- Modify: `ROADMAP.md`

- [ ] **Step 1: Run the pre-capture verifier**

```sh
npm run typecheck && npm run build && node scripts/run-tests.mjs
```

Expected: all repository tests pass before the manifest pin changes.

- [ ] **Step 2: Capture the rebuilt live catalog**

```sh
node blackbox/a2a-conformance-v0.1/runner.mjs --capture-baseline
```

Record the emitted SHA from the rebuilt `dist/index.js`. Update only
`expected_catalog_sha256` and add `"model"` to `attach_agent`'s advertised
input members. `spawn_fleet` keeps the top-level member `"agents"`; its nested
schema change is covered by the complete catalog digest.

- [ ] **Step 3: Re-run conformance normally**

```sh
node blackbox/a2a-conformance-v0.1/runner.mjs
```

Expected: both synthetic profiles and mutation canaries pass with the new pin.

- [ ] **Step 4: Correct bounded documentation claims**

Document:

- model is a caller-selected OpenCode execution input;
- request and observed banner are stored separately;
- matching is fail-closed observed evidence, not attestation;
- legacy, durable retry, and Discussion paths preserve selection; and
- automatic provider choice, budgets, direct Ollama Cloud, SDKs, publishing,
  and deployment remain future work.

- [ ] **Step 5: Run one live OpenCode Go and one Kilo smoke**

Use non-sensitive, bounded prompts. Invoke the real MCP spawn path once with an
installed `opencode-go/...` selector and once with an installed `kilo/...`
selector. For each, inspect the Agent row and require:

```text
requested_model == selected provider/model
runtime_model == compatible observed banner model
status == complete
```

If either provider is unavailable, preserve the exact failure receipt and do
not weaken unit or classifier gates.

- [ ] **Step 6: Run final verification**

```sh
git diff --check
npm run typecheck && npm run build && node scripts/run-tests.mjs
node blackbox/a2a-conformance-v0.1/runner.mjs
git status --short
```

Expected: all commands pass; only intended tracked changes remain.

- [ ] **Step 7: Commit Task 4**

```sh
git add blackbox/a2a-conformance-v0.1/manifest.json docs/ADAPTER-CONTRACT.md ROADMAP.md
git commit -m "docs: document model-selected execution"
```

### Task 5: Independent final review and handoff

**Files:**
- Modify only for review-proven defects.
- Modify the rolling MeshFleet handoff/receipt files required by repository
  convention after all code is stable.

- [ ] **Step 1: Build one bounded review package**

Include the approved design, plan, commits, exact diff against `origin/main`,
focused/full/conformance/live evidence, and explicit non-claims.

- [ ] **Step 2: Run independent reviews**

Ask Grok and MiniMax separately to find introduced P0-P3 defects. Neither
reviewer may rely on the other review or on controller conclusions.

- [ ] **Step 3: Adjudicate findings with tests**

For every accepted defect, add a RED test, implement the smallest fix, rerun
focused/full/conformance verification, and commit. Record rejected findings
with exact code/test evidence.

- [ ] **Step 4: Seal successor-ready state**

Update the MeshFleet handoff with branch, commits, worktree, tests, live-provider
receipts, limitations, and explicit no-publish/no-deploy status. Confirm no
process or material write remains before sending the requested Storage
quiescence receipt.
