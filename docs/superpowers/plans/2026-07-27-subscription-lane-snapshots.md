# Subscription-Lane Snapshot Conformance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that opaque Ollama Cloud, OpenCode Go, and Kilo Pass candidate snapshots can be prioritized by the existing advisory router without adding provider-specific schema, authority, availability, or execution semantics.

**Architecture:** Keep `recommend_route` and its scoring implementation unchanged. Add a portable corpus and pure/MCP conformance tests around the existing closed snapshot contract, then document the wrapper-owned provider boundary and explicit non-claims.

**Tech Stack:** TypeScript, Node test runner, JSON fixtures, MCP stdio contract tests, Markdown.

## Global Constraints

- Do not add provider, subscription, availability, authentication, quota-clock, credential, endpoint, execution, or dispatch fields to core.
- Do not add provider or model catalogs, enums, SDKs, live probes, retry logic, persistence, or a `DeliveryPort`.
- Raw prompts, messages, files, and bodies remain outside `recommend_route`.
- Budget can only demote or exclude; unmeasured remains neutral.
- Requested and observed runtime/model identity remain caller evidence and never affect score.
- All work remains local-only; no push, merge, publish, deploy, credentials, spend, or live-ledger mutation.

---

### Task 1: Portable subscription-lane conformance corpus

**Files:**
- Create: `test/fixtures/routing/subscription-lanes/v0.1/corpus.json`
- Create: `test/recommend-route-subscription-lanes.test.ts`

**Interfaces:**
- Consumes: `recommendRoute(input: RecommendRouteInput): RecommendRouteResult` from `src/recommend-route.ts`.
- Produces: a provider-neutral JSON corpus with `corpus_version`, `claims`, `candidate_templates`, and `cases`; executable proof that task-fit tokens, not lane labels, determine rank.

- [ ] **Step 1: Add the absent-test red check**

Run:

```bash
node --import tsx --test test/recommend-route-subscription-lanes.test.ts
```

Expected: FAIL because the test file does not exist.

- [ ] **Step 2: Write the portable corpus**

Create three candidate templates with opaque ids and requested identity strings:

```json
{
  "candidate_id": "lane-a",
  "capabilities": ["code", "long_context_review"],
  "privacy": "network_ok",
  "locality": "any",
  "budget": { "measured": false },
  "requested_identity": {
    "runtime": "ollama-cloud",
    "model": "caller-selected-model"
  }
}
```

Create analogous `lane-b` and `lane-c` candidates whose unique optional strengths are
`fast_patch` and `broad_model_choice`. Add three task cases that all require `code` and
request one optional strength. Pin the expected ranked ids. Include only these false
claims:

```json
{
  "provider_availability": false,
  "authenticated_identity": false,
  "budget_freshness": false,
  "persisted": false,
  "executed": false,
  "authorized": false,
  "woke_agents": false,
  "contacted_providers": false
}
```

- [ ] **Step 3: Write the corpus conformance tests**

The test must:

```ts
for (const fixture of corpus.cases) {
  const result = recommendRoute({
    task: fixture.task,
    candidates: corpus.candidate_templates,
    top_n: corpus.candidate_templates.length,
  });
  assert.deepEqual(
    result.ranked.map(({ candidate_id }) => candidate_id),
    fixture.expected_ranked,
    fixture.id,
  );
}
```

It must also clone the corpus, strip or replace all requested identity strings, rerun
each case, and assert identical `components`, `candidate_id`, and `rank`. Assert exact
false effect flags, all corpus claims false, input immutability, deterministic repeated
results, and equal scores for unmeasured versus measured-healthy otherwise-identical
candidates before the `candidate_id` tie-break.

- [ ] **Step 4: Run the focused pure tests**

Run:

```bash
node --import tsx --test test/recommend-route.test.ts test/recommend-route-subscription-lanes.test.ts
```

Expected: PASS with no production source change.

- [ ] **Step 5: Commit the portable proof**

```bash
git add test/fixtures/routing/subscription-lanes/v0.1/corpus.json test/recommend-route-subscription-lanes.test.ts
git commit -m "test(routing): prove opaque subscription lane ranking"
```

### Task 2: MCP authority rejection and operator contract

**Files:**
- Modify: `test/recommend-route-mcp.test.ts`
- Modify: `docs/ADVISORY-ROUTING.md`
- Modify: `COMPATIBILITY.md`
- Modify: `ROADMAP.md`
- Modify: `docs/A2A-HANDOFF-CURRENT.md`

**Interfaces:**
- Consumes: the unchanged `recommend_route` MCP input schema and handler in `src/index.ts`.
- Produces: executable rejection of provider/control-plane smuggling and a documented wrapper/core boundary.

- [ ] **Step 1: Add MCP red assertions for the new attack matrix**

Extend the existing `recommend_route refuses raw-prompt and authority-shaped fields`
fixture list with candidate-level keys:

```ts
for (const key of [
  "provider",
  "subscription",
  "availability",
  "authenticated",
  "quota_reset_at",
  "endpoint",
  "credentials",
  "dispatch",
]) {
  cases.push({
    name: key,
    arguments: {
      ...base,
      candidates: [{ ...base.candidates[0], [key]: "forbidden" }],
    },
    expected: new RegExp(key),
  });
}
```

Add nested variants under `budget` and `requested_identity` for `fresh`,
`availability`, and `authenticated`. Run the focused MCP test and confirm the new
fixtures pass against the already closed handler/core validation. This is a
characterization test; no schema change is expected.

- [ ] **Step 2: Add the positive MCP subscription-lane call**

Call `recommend_route` with the three corpus-shaped candidates. Assert:

```ts
assert.deepEqual(body.effects, {
  persisted: false,
  executed: false,
  authorized: false,
  woke_agents: false,
  contacted_providers: false,
});
assert.deepEqual(body.ranked.map(({ candidate_id }) => candidate_id), [
  "lane-b",
  "lane-a",
  "lane-c",
]);
assert.deepEqual(snapshot(), filesBefore);
```

Also assert identity rows carry `evidence_only: true` and do not add availability or
authentication fields.

- [ ] **Step 3: Document the provider-neutral boundary**

Add a `Subscription-lane snapshots` section to `docs/ADVISORY-ROUTING.md` stating:

- wrappers supply one sanitized candidate per selectable lane/model pairing;
- capabilities/context/policy describe fit;
- provider/runtime/model strings are opaque evidence and never score;
- unknown budget is correct when freshness cannot be established;
- gateways retain catalogs, credentials, execution, failover, and metering; and
- the portable corpus is evidence of offline snapshot conformance only.

Update the compatibility, roadmap, and rolling handoff entries to cite the corpus and
tests without changing the existing advisory-only maturity claim.

- [ ] **Step 4: Run the routing bands and structural checks**

Run:

```bash
node --import tsx --test test/recommend-route.test.ts test/recommend-route-subscription-lanes.test.ts test/recommend-route-mcp.test.ts
npm run typecheck
npm run build
git diff --check
```

Expected: all pass.

- [ ] **Step 5: Commit the contract evidence**

```bash
git add test/recommend-route-mcp.test.ts docs/ADVISORY-ROUTING.md COMPATIBILITY.md ROADMAP.md docs/A2A-HANDOFF-CURRENT.md
git commit -m "docs(routing): define subscription lane boundary"
```

### Task 3: Independent review and complete verification

**Files:**
- Review all paths changed by Tasks 1 and 2.

**Interfaces:**
- Consumes: the two implementation commits.
- Produces: an independent verdict, full verification receipt, and private handoff update.

- [ ] **Step 1: Dispatch independent review**

Ask a fresh reviewer to inspect label-opacity, outcome/budget neutrality, MCP
fail-closed coverage, side-effect evidence, compatibility claims, and any accidental
provider coupling. Require exact file/line findings or `APPROVE`.

- [ ] **Step 2: Fix findings red-first**

For each accepted finding, add a focused failing assertion, run it to observe failure,
make the smallest correction, and rerun the focused routing band.

- [ ] **Step 3: Run full verification with normal host access**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: zero failures and zero skipped tests. If sandbox restrictions block localhost
SSE or the user-config event log, rerun unchanged with normal host access and record both
results accurately.

- [ ] **Step 4: Secret scan and final commit if review caused changes**

```bash
git add COMPATIBILITY.md ROADMAP.md docs/A2A-HANDOFF-CURRENT.md docs/ADVISORY-ROUTING.md test/recommend-route-mcp.test.ts test/recommend-route-subscription-lanes.test.ts test/fixtures/routing/subscription-lanes/v0.1/corpus.json
gitleaks git --staged --no-banner
git diff --cached --check
git commit -m "test(routing): harden subscription lane conformance"
```

- [ ] **Step 5: Refresh private state**

Update `SUCCESSION/MESHFLEET-AUTONOMY-QUEUE.md`,
`SUCCESSION/MESHFLEET-HANDOFF-2026-07-27.md`, and `CHRONICLE.md` with exact commits,
test counts, review verdict, external-lane participation, rejected suggestions, and
unchanged human gates. Run the portfolio conductor validator.
