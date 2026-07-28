# Route-Candidate Snapshot Compiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure offline compiler that projects a sanitized, versioned lane manifest and bounded caller observations into candidates accepted unchanged by `recommendRoute`.

**Architecture:** Keep compilation separate from recommendation. A shared candidate validator preserves one semantic contract, `compileRouteCandidates` performs closed-input validation and deterministic projection, and the additive MCP tool exposes that pure function without touching the ledger or provider gateways.

**Tech Stack:** TypeScript, Node.js test runner, JSON fixtures, MCP stdio contract tests, Markdown.

## Global Constraints

- Compiler version is exactly `meshfleet.route-candidates.v0.1`.
- The compiler never calls `recommendRoute`, scores, selects, dispatches, persists, authorizes, wakes, contacts providers, reads configuration, or accesses a clock.
- The manifest is the only source of static declared-fit traits and requested identity.
- Status labels alone never create budget numbers, outcomes, availability, freshness, identity, utilization, or score changes.
- Assumed evidence never becomes caller-asserted measured evidence.
- Budget remains neutral when unmeasured and can only demote or exclude inside the existing evaluator.
- Unknown field names fail closed at every supported nesting level; they are
  never stripped. This is not scalar-value secret detection.
- Provider catalogs, credentials, endpoints, authentication, retries, failover, live probes, raw prompts, and exact metering remain outside core.
- Existing `recommend_route` inputs, results, validation messages, scoring, and ordering remain compatible.
- All work remains local-only; no push, merge, publish, deploy, credentials, spend, or live-ledger mutation.

---

### Task 1: Shared route-candidate validation

**Files:**
- Create: `src/route-candidate-validation.ts`
- Create: `test/route-candidate-validation.test.ts`
- Modify: `src/recommend-route.ts`

**Interfaces:**
- Consumes: `RecommendRouteCandidate` from `src/recommend-route.ts` as a type-only import.
- Produces:

```ts
export interface RouteCandidateValidationOptions {
  errorPrefix: string;
  path: string;
}

export function assertRouteCandidates(
  value: unknown,
  options: RouteCandidateValidationOptions,
  fail?: (path: string, detail: string) => never,
): asserts value is RecommendRouteCandidate[];
```

- [ ] **Step 1: Run the absent-test red check**

Run:

```bash
node --import tsx --test test/route-candidate-validation.test.ts
```

Expected: FAIL because the test file does not exist.

- [ ] **Step 2: Write the shared-validator contract test**

Create `test/route-candidate-validation.test.ts` with one valid candidate and
table-driven invalid cases. The test imports the not-yet-created
`assertRouteCandidates`, verifies a custom prefix/path, and pins existing
candidate semantics:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRouteCandidates } from "../src/route-candidate-validation.js";

const valid = {
  candidate_id: "lane-a",
  capabilities: ["code"],
  privacy: "network_ok",
  locality: "any",
  budget: { measured: false },
};

test("assertRouteCandidates accepts a closed candidate and custom error context", () => {
  assert.doesNotThrow(() =>
    assertRouteCandidates([valid], {
      errorPrefix: "compile_route_candidates",
      path: "manifest.candidates",
    }),
  );

  assert.throws(
    () =>
      assertRouteCandidates([{ ...valid, provider: "forbidden" }], {
        errorPrefix: "compile_route_candidates",
        path: "manifest.candidates",
      }),
    /compile_route_candidates: 'manifest\.candidates\[0\]\.provider' is not allowed/,
  );
});
```

Add cases for empty/257-item arrays, duplicate IDs, invalid capabilities,
privacy/locality/coordination, non-finite context, malformed outcomes,
measured/unmeasured budgets, and both identity shapes. Expected paths must use
`manifest.candidates[index]`.

- [ ] **Step 3: Run the new test and observe the missing-module failure**

Run:

```bash
node --import tsx --test test/route-candidate-validation.test.ts
```

Expected: FAIL with module-not-found for
`src/route-candidate-validation.js`.

- [ ] **Step 4: Extract the candidate validator**

Create `src/route-candidate-validation.ts`. Move the candidate-array and nested
candidate validation rules from `validateRecommendRouteInput` into
`assertRouteCandidates`. Keep these exact limits:

```ts
const MAX_CANDIDATES = 256;
const MAX_TOKENS = 64;
const MAX_OUTCOME_COUNT = 1_000_000;
```

The default failure callback must call:

```ts
function invalid(
  options: RouteCandidateValidationOptions,
  path: string,
  detail: string,
): never {
  throw new Error(`${options.errorPrefix}: '${path}' ${detail}`);
}
```

Accepting a failure callback keeps the validator reusable without hard-coding
the evaluator's prefix. Use the supplied root path when constructing every
nested path. Preserve the
closed allowlist:

```ts
[
  "candidate_id",
  "capabilities",
  "privacy",
  "locality",
  "coordination_modes",
  "policy_tags",
  "context_window",
  "observed_outcomes",
  "budget",
  "requested_identity",
  "observed_identity",
]
```

- [ ] **Step 5: Rewire `recommendRoute` to the shared validator**

Import `assertRouteCandidates` into `src/recommend-route.ts`. Keep task and
`top_n` validation local. Replace only the candidate-array loop with:

```ts
assertRouteCandidates(input.candidates, {
  errorPrefix: "recommend_route",
  path: "candidates",
});
```

Do not alter scoring, filtering, identity comparison, sort order, result shape,
or existing public types.

- [ ] **Step 6: Run focused validation and router tests**

Run:

```bash
node --import tsx --test \
  test/route-candidate-validation.test.ts \
  test/recommend-route.test.ts \
  test/recommend-route-subscription-lanes.test.ts \
  test/recommend-route-mcp.test.ts
```

Expected: PASS. Existing `recommend_route` error text remains unchanged.

- [ ] **Step 7: Commit the shared validator**

```bash
git add src/route-candidate-validation.ts src/recommend-route.ts test/route-candidate-validation.test.ts
git commit -m "refactor(routing): share candidate validation"
```

### Task 2: Pure snapshot compiler and portable corpus

**Files:**
- Create: `src/compile-route-candidates.ts`
- Create: `test/compile-route-candidates.test.ts`
- Create: `test/fixtures/routing/route-candidate-snapshots/v0.1/corpus.json`

**Interfaces:**
- Consumes:
  - `assertRouteCandidates(value, options)` from Task 1.
  - `RecommendRouteCandidate`, `RoutePrivacy`, `RouteLocality`, and
    `RouteCoordination` from `src/recommend-route.ts`.
- Produces:

```ts
export const ROUTE_CANDIDATE_COMPILER_VERSION =
  "meshfleet.route-candidates.v0.1" as const;

export function compileRouteCandidates(
  input: CompileRouteCandidatesInput,
): CompileRouteCandidatesResult;
```

- [ ] **Step 1: Run the absent-test red check**

Run:

```bash
node --import tsx --test test/compile-route-candidates.test.ts
```

Expected: FAIL because the test file does not exist.

- [ ] **Step 2: Create the portable corpus**

Create
`test/fixtures/routing/route-candidate-snapshots/v0.1/corpus.json` with this
top-level shape:

```json
{
  "corpus_version": "meshfleet.route-candidates.v0.1",
  "claims": {
    "provider_availability": false,
    "authenticated_identity": false,
    "budget_freshness": false,
    "persisted": false,
    "executed": false,
    "authorized": false,
    "woke_agents": false,
    "contacted_providers": false
  },
  "manifest": {
    "version": "meshfleet.route-candidates.v0.1",
    "candidates": [
      {
        "candidate_id": "lane-c",
        "capabilities": ["code", "broad_model_choice"],
        "privacy": "network_ok",
        "locality": "any",
        "requested_identity": {
          "runtime": "opaque-runtime-c",
          "model": "opaque-model-c"
        }
      },
      {
        "candidate_id": "lane-a",
        "capabilities": ["code", "long_context_review"],
        "privacy": "network_ok",
        "locality": "any"
      },
      {
        "candidate_id": "lane-b",
        "capabilities": ["code", "fast_patch"],
        "privacy": "network_ok",
        "locality": "any"
      }
    ]
  }
}
```

Add cases named `missing-observations-are-neutral`,
`assumed-observation-is-neutral`, `measured-evidence-copies-exactly`, and
`exact-exhaustion-is-evidence`. Pin exact candidate and diagnostic outputs.
The measured case uses budget `{ "used": 6, "total": 10 }`, outcomes
`{ "successes": 7, "failures": 2 }`, and an observed identity with a source.
The exhaustion case uses `{ "used": 10, "total": 10 }` and status
`"exhausted"`.

- [ ] **Step 3: Write compiler tests before production code**

Create `test/compile-route-candidates.test.ts` importing the absent compiler.
Load the corpus and assert:

```ts
const first = compileRouteCandidates(input);
const second = compileRouteCandidates(structuredClone(input));
assert.deepEqual(first, second);
assert.deepEqual(input, before);
assert.deepEqual(
  first.candidates.map(({ candidate_id }) => candidate_id),
  ["lane-a", "lane-b", "lane-c"],
);
assert.deepEqual(first.effects, {
  persisted: false,
  executed: false,
  authorized: false,
  woke_agents: false,
  contacted_providers: false,
});
```

Feed the compiled candidates into `recommendRoute` with a sanitized task and
verify exact measured exhaustion becomes `BUDGET_EXHAUSTED` there, not inside
the compiler. Replace requested and observed identity strings and verify
non-identity candidate fields plus downstream components and order remain
unchanged.

Add table-driven invalid direct-call cases for:

- unknown fields at input, manifest, candidate, observation, budget, outcomes,
  requested identity, and observed identity;
- wrong version, empty/oversized manifest, malformed and duplicate candidate
  IDs;
- duplicate and unknown observation IDs;
- `unconfigured`;
- assumed observations carrying budget, outcomes, or identity;
- assumed `exhausted`;
- non-finite/negative budget numbers and non-positive totals;
- measured `exhausted` without exact `used >= total`; and
- measured `green`/`degraded` with `used >= total`.

Each case pins the exact first error path and verifies the prefix
`compile_route_candidates`.

- [ ] **Step 4: Run the compiler test and observe the missing-module failure**

Run:

```bash
node --import tsx --test test/compile-route-candidates.test.ts
```

Expected: FAIL with module-not-found for
`src/compile-route-candidates.js`.

- [ ] **Step 5: Implement closed validation and deterministic projection**

Create `src/compile-route-candidates.ts` with the exact interfaces from the
design spec. Use closed key sets for every input object. Validate manifest
candidate static traits by constructing candidate-shaped snapshots with
`budget: { measured: false }` and calling:

```ts
assertRouteCandidates(staticSnapshots, {
  errorPrefix: "compile_route_candidates",
  path: "manifest.candidates",
});
```

For each observation, validate record shape, allowed keys, candidate ID string
shape, duplicate/unknown ID, status/confidence, then nested evidence. Enforce
confidence/status cross-source rules after primitive shapes. Compile each
candidate into a fresh object, always emitting either exact caller-supplied
`budget: { measured: true, used, total }` or
`budget: { measured: false }`.

Use:

```ts
const byCandidateId = new Map(
  observations.map((observation) => [observation.candidate_id, observation]),
);
const orderedManifest = [...manifest.candidates].sort((left, right) =>
  left.candidate_id < right.candidate_id
    ? -1
    : left.candidate_id > right.candidate_id
      ? 1
      : 0,
);
```

Copy arrays and nested evidence objects so the result does not alias caller
input. Call `assertRouteCandidates` once more on the completed output before
returning it. Do not import or call `recommendRoute`.

- [ ] **Step 6: Run focused pure tests**

Run:

```bash
node --import tsx --test \
  test/route-candidate-validation.test.ts \
  test/compile-route-candidates.test.ts \
  test/recommend-route.test.ts \
  test/recommend-route-subscription-lanes.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the pure compiler**

```bash
git add \
  src/compile-route-candidates.ts \
  test/compile-route-candidates.test.ts \
  test/fixtures/routing/route-candidate-snapshots/v0.1/corpus.json
git commit -m "feat(routing): compile candidate snapshots"
```

### Task 3: Additive MCP compiler contract

**Files:**
- Create: `test/compile-route-candidates-mcp.test.ts`
- Modify: `src/index.ts`
- Modify: `test/dispatch-registry.test.ts`

**Interfaces:**
- Consumes: `compileRouteCandidates(input)` from Task 2.
- Produces: additive MCP tool `compile_route_candidates` with the same input
  and result shapes as the pure function.

- [ ] **Step 1: Write the MCP and registry tests before wiring**

Create `test/compile-route-candidates-mcp.test.ts` using the real
`StdioClientTransport` pattern from `test/recommend-route-mcp.test.ts`. Assert
that `listTools()` contains `compile_route_candidates`, every object schema has
`additionalProperties: false`, the exact manifest version is enumerated, and
required keys are:

```ts
{
  input: ["manifest"],
  manifest: ["version", "candidates"],
  candidate: ["candidate_id", "capabilities", "privacy", "locality"],
  observation: ["candidate_id", "status", "confidence"],
}
```

Call the absent tool with the portable corpus and pin its exact projection.
Snapshot the isolated data directory immediately before and after successful
and rejected calls; assert file names and bytes are identical.

Add a malicious-field table at top-level and every nested object for
`provider`, `subscription`, `authenticated`, `endpoint`, `credentials`,
`dispatch`, `availability`, `quota_reset_at`, `prompt`, `message`, `execute`,
and `wake_agent`. Each call must return a readable tool error naming the field,
not terminate the transport.

Update `test/dispatch-registry.test.ts` to expect 33 declared/registered tools
and assert the new tool name is present.

- [ ] **Step 2: Run the MCP tests and observe the absent-tool failures**

Run:

```bash
node --import tsx --test \
  test/compile-route-candidates-mcp.test.ts \
  test/dispatch-registry.test.ts
```

Expected: FAIL because the tool is neither advertised nor registered.

- [ ] **Step 3: Add the closed MCP schema**

Import `compileRouteCandidates` and `CompileRouteCandidatesInput` in
`src/index.ts`. Add `compile_route_candidates` immediately before
`recommend_route`. Its description must state that it is an offline projection
and does not persist, rank, execute, authorize, wake, or contact providers.

The JSON schema must mirror the design exactly. Use `additionalProperties:
false` on input, manifest, manifest candidate, observation, budget, outcomes,
requested identity, and observed identity. Keep array bounds aligned with core:
1..256 candidates, 0..256 observations, 1..64 capability/policy tokens,
1..2 coordination modes, candidate IDs at most 128 characters,
runtime/model/source strings at most 256 characters, and outcome counts at
most 1,000,000.

- [ ] **Step 4: Add the pure handler**

Register:

```ts
toolHandlers["compile_route_candidates"] = async (args) => {
  try {
    return jsonResult(
      compileRouteCandidates(args as unknown as CompileRouteCandidatesInput),
    );
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error));
  }
};
```

The handler must not call a ledger helper, `recommendRoute`, a provider
adapter, a clock, or any write function. Runtime compiler validation, not only
JSON Schema, remains the authority for closed nested input.

- [ ] **Step 5: Run focused MCP and routing tests**

Run:

```bash
node --import tsx --test \
  test/compile-route-candidates-mcp.test.ts \
  test/dispatch-registry.test.ts \
  test/recommend-route-mcp.test.ts \
  test/compile-route-candidates.test.ts
```

Expected: PASS. The portable projection can be supplied unchanged to a real
`recommend_route` call.

- [ ] **Step 6: Commit the additive MCP surface**

```bash
git add src/index.ts test/compile-route-candidates-mcp.test.ts test/dispatch-registry.test.ts
git commit -m "feat(routing): expose snapshot compiler"
```

### Task 4: Truthful operator documentation and receipts

**Files:**
- Modify: `docs/ADVISORY-ROUTING.md`
- Modify: `COMPATIBILITY.md`
- Modify: `ROADMAP.md`
- Modify: `docs/A2A-HANDOFF-CURRENT.md`

**Interfaces:**
- Consumes: passing pure/MCP implementation receipts from Tasks 1 through 3.
- Produces: public documentation that distinguishes offline compilation from
  routing, gateway health, provider availability, execution, and authority.

- [ ] **Step 1: Document candidate compilation**

Add a `Candidate compilation` subsection to `docs/ADVISORY-ROUTING.md` before
`Subscription-lane snapshots`. State:

- `compile_route_candidates` accepts a sanitized manifest and optional bounded
  caller observations;
- missing or assumed evidence remains unmeasured;
- caller-asserted measured values are copied without probing or normalization;
- status labels alone do not change ranking;
- the output may be passed unchanged to `recommend_route`; and
- gateways retain catalogs, credentials, health/freshness policy, execution,
  retry, failover, and metering.

Include one compact manifest/observation example using opaque lane IDs and no
provider claim.

- [ ] **Step 2: Update compatibility and roadmap claims**

Add an A2A conformance-registry row in `COMPATIBILITY.md` with status
`fixture-verified`. Its claim is only that the pure compiler and real MCP
contract deterministically project sanitized caller evidence without I/O or
authority. Cite the compiler source, corpus, and pure/MCP tests.

Update `ROADMAP.md` to say the subscription-lane program now has a versioned
offline compiler in addition to the corpus. Repeat that this is not provider
availability, authentication, budget freshness, execution, failover, or
metering evidence. Do not change release-version claims.

- [ ] **Step 3: Update the bounded branch handoff**

In `docs/A2A-HANDOFF-CURRENT.md`, record:

- the four compiler files and additive MCP tool;
- exact focused and full verification commands and counts;
- the explicit all-false effects;
- no provider/wrapper/RoutePlane integration claim; and
- no merge, push, publish, deploy, activation, or live-ledger mutation.

Use the actual commit IDs and test counts observed during execution.

- [ ] **Step 4: Run documentation and leak checks**

Run:

```bash
git diff --check
rg -n "TODO|TBD|implement later|provider_api_key|access_token|secret|password" \
  docs/ADVISORY-ROUTING.md COMPATIBILITY.md ROADMAP.md docs/A2A-HANDOFF-CURRENT.md
```

Expected: `git diff --check` succeeds. Any `rg` hit is inspected; no credential,
secret, private absolute path, or unfinished placeholder is introduced.

- [ ] **Step 5: Run the exact branch verifier**

Run:

```bash
npm run typecheck && npm run build && node scripts/run-tests.mjs
```

Expected: all three commands exit 0. Record the exact test/pass/fail/skip
counts rather than predicting them.

- [ ] **Step 6: Commit public documentation and receipts**

```bash
git add docs/ADVISORY-ROUTING.md COMPATIBILITY.md ROADMAP.md docs/A2A-HANDOFF-CURRENT.md
git commit -m "docs(routing): record compiler boundary"
```

### Task 5: Independent review and final branch verification

**Files:**
- Modify only files implicated by a confirmed review finding.

**Interfaces:**
- Consumes: Tasks 1 through 4 and their commits.
- Produces: review disposition, clean-tree evidence, and exact final verifier
  receipts.

- [ ] **Step 1: Request independent specification review**

Give a fresh reviewer the design spec, implementation plan, and commit range.
Ask it to check closed validation, status/confidence semantics, exact evidence
copying, compiler/router separation, authority leakage, compatibility, and test
coverage. The reviewer must return `APPROVE` or findings with file/line
evidence.

- [ ] **Step 2: Request independent implementation review**

Give a different fresh reviewer the source, corpus, MCP schema/handler, and
tests. Ask it to try to falsify no-write behavior, unmeasured neutrality,
determinism, identity non-scoring, error precedence, and recursive smuggling
rejection.

- [ ] **Step 3: Resolve findings test-first**

For each confirmed finding, add or tighten a failing focused test, run it to
observe the failure, apply the smallest implementation correction, rerun the
focused suite, and commit with a finding-specific conventional message. Record
rejected findings with concrete source/test evidence.

- [ ] **Step 4: Run final verifier and repository checks**

Run:

```bash
npm run typecheck && npm run build && node scripts/run-tests.mjs
git diff --check
git status --short
git log --oneline --decorate -12
```

Expected: typecheck/build/tests exit 0, no whitespace errors, and the isolated
worktree is clean. Record exact head, commit range, and test counts in the
private MeshFleet handoff and autonomy queue without staging those private
portfolio files in this public branch.
