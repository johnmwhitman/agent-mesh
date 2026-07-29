# RoutePlane Model-Catalog Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded host-side adapter and CLI that read RoutePlane's live loopback model catalog and safely project caller-owned policies into MeshFleet advisory candidates.

**Architecture:** Keep network access outside the MCP server. A focused module fetches, normalizes, fingerprints and validates RoutePlane's catalog; a pure compiler joins exact advertised model IDs to caller-supplied policy and delegates final candidate validation to the existing route-candidate compiler. A separate CLI exposes snapshot collection without credentials, arbitrary endpoints or persistence.

**Tech Stack:** Node.js 20 built-in `fetch`, Web Streams and `node:crypto`; TypeScript; Node test runner; existing MeshFleet route-candidate compiler.

## Global Constraints

- RoutePlane remains the authority for catalog, credentials, health, execution, retries and failover.
- The only v1 endpoint is `http://127.0.0.1:4356/v1/models`.
- No MCP tool, daemon, persistent cache, credential, caller header, redirect or arbitrary endpoint.
- Catalog presence is identity evidence only, never availability or authority.
- Provider labels never infer capabilities, privacy, locality, budget or execution.
- Production code follows a witnessed red-green TDD cycle.

---

### Task 1: Pure catalog normalization and validation

**Files:**
- Create: `src/routeplane-catalog.ts`
- Create: `test/routeplane-catalog.test.ts`

**Interfaces:**
- Produces: `normalizeRoutePlaneCatalog(payload, fetchedAtMs, ttlMs): RoutePlaneCatalogSnapshot`
- Produces: `ROUTEPLANE_CATALOG_SNAPSHOT_VERSION`

- [ ] **Step 1: Write failing tests for a live-shaped catalog, normalization, digest stability, duplicate IDs, unknown fields and bounds**

Use the exact response shape `{object:"list",data:[{id,object:"model",providers}]}` and assert deterministic model/provider ordering plus SHA-256 equality for reordered inputs.

- [ ] **Step 2: Run the focused test and verify it fails because `src/routeplane-catalog.ts` does not exist**

Run: `node --import tsx --test test/routeplane-catalog.test.ts`

- [ ] **Step 3: Implement the minimal closed validator, canonical serializer and snapshot types**

Use `createHash("sha256")`, exact allowed-key checks, the limits in the design, and `fetched_at_ms + ttl_ms` for expiry.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --import tsx --test test/routeplane-catalog.test.ts`

- [ ] **Step 5: Commit the pure snapshot boundary**

```bash
git add src/routeplane-catalog.ts test/routeplane-catalog.test.ts
git commit -m "feat: validate RoutePlane catalog snapshots"
```

### Task 2: Bounded loopback fetch

**Files:**
- Modify: `src/routeplane-catalog.ts`
- Modify: `test/routeplane-catalog.test.ts`

**Interfaces:**
- Produces: `fetchRoutePlaneCatalog(options?): Promise<RoutePlaneCatalogSnapshot>`
- Consumes: `normalizeRoutePlaneCatalog`

- [ ] **Step 1: Add failing tests for no headers, redirect refusal, timeout signal, non-2xx, invalid JSON and the 1 MiB body cap**

Inject a `fetch_impl` only as a library-test seam; the production endpoint remains a literal constant.

- [ ] **Step 2: Run the focused test and verify the fetch tests fail because the function is absent**

Run: `node --import tsx --test test/routeplane-catalog.test.ts`

- [ ] **Step 3: Implement bounded body reading and typed `RoutePlaneCatalogError` failures**

Call `fetch(ROUTEPLANE_MODELS_ENDPOINT, {method:"GET", redirect:"error", signal})`;
send no headers and cancel the reader once the response exceeds 1 MiB.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --import tsx --test test/routeplane-catalog.test.ts`

- [ ] **Step 5: Commit the host fetch**

```bash
git add src/routeplane-catalog.ts test/routeplane-catalog.test.ts
git commit -m "feat: fetch RoutePlane catalog on loopback"
```

### Task 3: Policy-to-candidate compilation

**Files:**
- Modify: `src/routeplane-catalog.ts`
- Modify: `test/routeplane-catalog.test.ts`

**Interfaces:**
- Produces: `compileRoutePlaneCandidates(input): RoutePlaneCandidateCompilation`
- Consumes: `compileRouteCandidates()` and its observation type

- [ ] **Step 1: Add failing tests for exact model membership, stale/future snapshots, absent-model diagnostics, zero eligible candidates and provider-label non-authority**

Assert every emitted candidate has requested runtime `routeplane`, exact model
identity, caller-owned traits and no fabricated observed identity.

- [ ] **Step 2: Run the focused test and verify it fails because compilation is absent**

Run: `node --import tsx --test test/routeplane-catalog.test.ts`

- [ ] **Step 3: Implement the minimal pure join and delegate candidate validation to `compileRouteCandidates()`**

Return deterministic `MODEL_NOT_ADVERTISED` diagnostics for excluded policies.
For zero eligible policies return an empty compilation with the existing false
effect flags instead of invoking a compiler that requires one candidate.

- [ ] **Step 4: Run focused routing tests**

Run: `node --import tsx --test test/routeplane-catalog.test.ts test/compile-route-candidates.test.ts test/recommend-route.test.ts`

- [ ] **Step 5: Commit candidate compilation**

```bash
git add src/routeplane-catalog.ts test/routeplane-catalog.test.ts
git commit -m "feat: compile RoutePlane models into route candidates"
```

### Task 4: CLI and package surface

**Files:**
- Create: `src/bin/routeplane-catalog.ts`
- Create: `test/routeplane-catalog-cli.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: package export `meshfleet/routeplane-catalog`
- Produces: executable `meshfleet-routeplane-catalog`

- [ ] **Step 1: Write failing CLI tests for valid JSON output, strict arguments and failure-without-stdout**

Run a child Node process against the TypeScript entry point with a local injected
test server only through a test-only environment seam that the production CLI
does not accept as a public argument.

- [ ] **Step 2: Run the focused CLI test and verify it fails because the entry point and package bin are absent**

Run: `node --import tsx --test test/routeplane-catalog-cli.test.ts`

- [ ] **Step 3: Implement strict argument parsing and JSON output; add package export and bin entries**

The CLI accepts only `--ttl-ms` and `--timeout-ms`. Errors go to stderr and set
non-zero `process.exitCode`; no partial snapshot is printed.

- [ ] **Step 4: Build and run the CLI/package tests**

Run: `npm run build && node --test test/routeplane-catalog-cli.test.ts`

- [ ] **Step 5: Commit the host-facing surface**

```bash
git add src/bin/routeplane-catalog.ts test/routeplane-catalog-cli.test.ts package.json
git commit -m "feat: expose RoutePlane catalog snapshot CLI"
```

### Task 5: Documentation, conformance and release truth

**Files:**
- Create: `docs/ROUTEPLANE-CATALOG.md`
- Modify: `README.md`
- Modify: `ROADMAP.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Documents the exact authority and freshness boundary.

- [ ] **Step 1: Document usage, output, failure behavior and non-goals**

State that this ships catalog discovery and policy projection, not automatic
execution or token-pool policy.

- [ ] **Step 2: Update roadmap and handoff claims without changing the 34-tool MCP catalog**

Move only RoutePlane catalog discovery from future to shipped; leave automatic
selection and token-pool draining open.

- [ ] **Step 3: Run documentation and registry guards**

Run: `npm test`

- [ ] **Step 4: Run complete release verification**

Run: `npm run typecheck && npm run build && npm run release:verify`

- [ ] **Step 5: Commit factual documentation**

```bash
git add docs/ROUTEPLANE-CATALOG.md README.md ROADMAP.md HANDOFF.md
git commit -m "docs: explain RoutePlane catalog authority"
```

### Task 6: Independent review and integration

**Files:**
- Modify only evidence-backed defects found by review.

**Interfaces:**
- Produces: review verdicts and clean integration evidence.

- [ ] **Step 1: Send the exact diff to Grok and MiniMax/Ollama for independent correctness and boundary review**

Require introduced findings only, with file/line evidence and a merge verdict.

- [ ] **Step 2: Reproduce every actionable finding and repair through a new red-green cycle**

Do not accept review text as evidence by itself.

- [ ] **Step 3: Re-run full verification, `git diff --check`, package dry-run and live loopback snapshot smoke**

The live smoke must emit the current RoutePlane catalog without credentials.

- [ ] **Step 4: Commit any repair and final handoff updates**

Stage exact paths only.

- [ ] **Step 5: Push, integrate under current authority, verify remote/main and remove the operator lock only after the worktree is quiescent**

No force push or destructive cleanup.
