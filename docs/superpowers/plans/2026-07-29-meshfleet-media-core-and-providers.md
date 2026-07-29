# MeshFleet Media Core and Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an isolated, durable, authority-gated media execution service to MeshFleet with honest provider readiness, validated local artifacts, CLI/MCP access, and offline-verifiable adapters for the complete named media suite.

**Architecture:** New code lives under `src/media-execution/` and uses its own SQLite database and artifact root. A pure contract and fake adapter plane land first; fixed provider adapters and thin CLI/MCP surfaces build on the same `MediaExecutionService` without importing the fleet-coupled `core.ts` or `RuntimeAdapter`.

**Tech Stack:** Node.js 20+, TypeScript ES2022, `node:test`, better-sqlite3 12.x, MCP SDK 1.29.x, fixed child processes with `shell: false`, bounded JSON/NDJSON.

## Global Constraints

- Start from a fresh isolated worktree created from the current `origin/main` at execution time, then cherry-pick the approved design + plan commits onto that base. Dynamically determine the pre-media MCP tool count from the reconciled base commit (do not hardcode 36 or any literal). Record the exact observed `origin/main` SHA and MCP count in the worktree log before Task 1. The planning branch may be one commit ahead; always reconcile against live `origin/main`.
- Preserve the existing MCP tools (count observed from base) until the additive media registration task.
- Use `test/`, not `tests/`; use `node:test` and `node:assert/strict`.
- Do not add Zod or another validation dependency; follow the repository's closed manual validation pattern.
- Keep media storage separate from `src/db.ts` and from fleet, agent, message, receipt, lifecycle, and A2A tables.
- Default database: `~/.config/meshfleet/media-execution.db`.
- Default artifact root: `~/.config/meshfleet/media-artifacts`.
- Request version: `meshfleet.media-request.v1`.
- Adapter request version: `meshfleet.media-adapter-request.v1`.
- Adapter event version: `meshfleet.media-adapter-event.v1`.
- Worker defaults: 60-second singleton/execution lease, 20-second renewal, 30 idle seconds.
- Every offline test uses fake adapters or fake executables and must prove it made no provider contact.
- Never accept arbitrary executables, argv, environment variables, working directories, credential paths, output roots, or shell strings from requests or MCP.
- The standalone `confirm` command remains interactive. ArtCraft machine confirmation uses a distinct internal trusted-host mode that requires a pre-opened anonymous confirmation descriptor from the Tauri process, accepts no approver identity from argv/stdin/environment, and is absent from MCP.
- Do not edit `/Users/johnwhitman/AI/Tools/*` in this plan. Existing tools may be invoked only after a fixed machine protocol is proven; otherwise their capabilities stay non-dispatchable.
- Registration is not readiness; `wrapper_present` and `configured_unverified` are non-dispatchable.
- No automatic fanout or fallback; default route is one attempt and no provider change.

---

### Task 1: Closed media contract and canonical request identity

**Files:**
- Create: `src/media-execution/contract/operations.ts`
- Create: `src/media-execution/contract/requests.ts`
- Create: `src/media-execution/contract/results.ts`
- Create: `src/media-execution/contract/errors.ts`
- Create: `test/media-contract.test.ts`

**Interfaces:**
- Consumes: no new source interfaces.
- Produces: `MediaPlanIntentBase` (with `MediaClientContext`, `MediaOutputPolicy`, `MediaRoutePolicy`), `MediaSubmission`, `ResolvedMediaRequest`, `MediaArtifactHandle`, `MediaError`, `parseMediaPlanIntent()`, `parseMediaSubmission()`, `canonicalMediaIntentSha256()`. All pixel inputs require `license_declaration`. Unknown keys, missing/invalid fields, and invalid license declarations are rejected by closed validation + tests.

- [ ] **Step 1: Write the failing contract tests**

Add table-driven tests that accept all twelve operations, reject unknown members, reject mismatched operation/input pairs, and prove JSON member order does not change the semantic hash:

```ts
test("canonical media intent identity ignores JSON member order", () => {
  const left = parseMediaPlanIntent(validImageIntent());
  const right = parseMediaPlanIntent({
    input: left.input,
    operation: left.operation,
    output: left.output,
    route: left.route,
    submitted_by: left.submitted_by,
    idempotency_key: left.idempotency_key,
    version: left.version,
  });
  assert.equal(canonicalMediaIntentSha256(left), canonicalMediaIntentSha256(right));
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run:

```bash
node --import tsx --test test/media-contract.test.ts
```

Expected: FAIL because `src/media-execution/contract/requests.ts` does not exist.

- [ ] **Step 3: Implement the closed types and parsers**

Define the exact discriminants:

```ts
export const MEDIA_REQUEST_VERSION = "meshfleet.media-request.v1" as const;

export type MediaOperation =
  | "image.generate"
  | "image.edit"
  | "video.generate"
  | "video.image_to_video"
  | "audio.tts"
  | "audio.music"
  | "pixel.image"
  | "pixel.character"
  | "pixel.rotate8"
  | "pixel.tileset"
  | "pixel.state"
  | "pixel.animation";

export interface MediaSubmission {
  version: typeof MEDIA_REQUEST_VERSION;
  plan_id: string;
  authority_ref: string;
}
```

Implement a closed-key helper and use it at every object layer:

```ts
export function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    throw new MediaError("invalid_request", `${path}.${unexpected}`);
  }
}
```

Canonicalize recursively by sorting object keys, preserving array order, and hashing UTF-8 JSON with `createHash("sha256")`.

- [ ] **Step 4: Run focused and type checks**

Run:

```bash
node --import tsx --test test/media-contract.test.ts
npm run typecheck
```

Expected: PASS; no provider modules or processes are loaded.

- [ ] **Step 5: Commit the contract**

```bash
git add src/media-execution/contract test/media-contract.test.ts
git commit -m "feat(media): add closed execution contract"
```

### Task 2: Separate durable media store

**Files:**
- Create: `src/media-execution/config.ts`
- Create: `src/media-execution/store.ts`
- Create: `test/helpers/with-temp-media-store.ts`
- Create: `test/media-config.test.ts`
- Create: `test/media-store.test.ts`

**Interfaces:**
- Consumes: contract IDs and hashes from Task 1.
- Produces: `MediaExecutionConfig`, `loadMediaExecutionConfig()`, `MediaStore`, `MediaStoreTransaction`, `closeMediaStore()`, execution/attempt/event/plan/grant/artifact persistence methods.

- [ ] **Step 1: Write failing storage tests**

In `test/media-config.test.ts`, cover default and explicit `MESHFLEET_MEDIA_DB_FILE`/`MESHFLEET_MEDIA_ARTIFACT_ROOT`, absolute-path requirements, symlink/root refusal, closed registered-consumer config, and proof that request JSON cannot override any host path. In the store test, cover fresh schema creation, reopen, wrong schema version, immutable plan/attempt rows, ordered events, unique idempotency tuple, separate DB path, and zero writes to the legacy ledger:

```ts
test("media storage is separate from the legacy ledger", () => {
  const fixture = withTempMediaStore();
  try {
    fixture.store.createPlan(planFixture());
    assert.equal(existsSync(fixture.mediaDbFile), true);
    assert.equal(existsSync(fixture.legacyDbFile), false);
  } finally {
    fixture.cleanup();
  }
});
```

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
node --import tsx --test test/media-config.test.ts test/media-store.test.ts
```

Expected: FAIL because `MediaExecutionConfig` and `MediaStore` are missing.

- [ ] **Step 3: Implement the SQLite schema and transaction seam**

Load the two approved environment names into an immutable config before opening storage. Resolve registered consumer roots from the host-owned `~/.config/meshfleet/media-consumers.json` file or an injected test map; consumer IDs and roots never come from media requests or MCP. Create a schema version table plus:

```sql
CREATE TABLE media_plans (
  plan_id TEXT PRIMARY KEY,
  request_sha256 TEXT NOT NULL,
  plan_sha256 TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  readiness_json TEXT NOT NULL,
  quote_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE media_executions (
  execution_id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  state TEXT NOT NULL,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  UNIQUE(principal, submitted_by, idempotency_key)
);
```

Add attempts, authority grants/decisions, readiness evidence, ordered events, artifacts, bundle entries, review candidates, and worker leases. Use `BEGIN IMMEDIATE` for every mutation and triggers that refuse UPDATE/DELETE on immutable plan, attempt-settlement, authority-decision, and event rows.

- [ ] **Step 4: Run focused tests twice**

Run:

```bash
node --import tsx --test test/media-config.test.ts test/media-store.test.ts
node --import tsx --test test/media-config.test.ts test/media-store.test.ts
```

Expected: both runs PASS with fresh temporary paths and no state leakage.

- [ ] **Step 5: Commit the store**

```bash
git add src/media-execution/config.ts src/media-execution/store.ts test/helpers/with-temp-media-store.ts test/media-config.test.ts test/media-store.test.ts
git commit -m "feat(media): add isolated durable store"
```

### Task 3: Capability registry and fail-closed readiness

**Files:**
- Create: `src/media-execution/capabilities/registry.ts`
- Create: `src/media-execution/capabilities/readiness.ts`
- Create: `test/media-capabilities.test.ts`

**Interfaces:**
- Consumes: `MediaOperation`, `MediaError`.
- Produces: `MediaCapability`, `MediaReadinessEvidence`, `MediaCapabilityRegistry`, `selectMediaCapability()`, `assertDispatchable()`.

- [ ] **Step 1: Write failing readiness tests**

Assert that only unexpired `probe_verified` or safe `degraded` evidence with `dispatchable: true` can plan or launch. Assert pinned Grok cannot bypass readiness and Codex requires an exact pin:

```ts
assert.throws(
  () => registry.select(intent({ pinned_provider: "grok" }), evidence("configured_unverified", false)),
  (error: unknown) => isMediaError(error, "capability_not_dispatchable"),
);
```

- [ ] **Step 2: Verify red**

Run:

```bash
node --import tsx --test test/media-capabilities.test.ts
```

Expected: FAIL because the registry is absent.

- [ ] **Step 3: Implement deterministic selection**

Use this eligibility predicate:

```ts
export function isDispatchableEvidence(
  evidence: MediaReadinessEvidence,
  nowMs: number,
): boolean {
  if (!evidence.dispatchable || evidence.expires_at_ms === undefined) return false;
  if (evidence.expires_at_ms <= nowMs) return false;
  if (evidence.state === "probe_verified") return true;
  return evidence.state === "degraded"
    && !evidence.reason_codes.some((code) => BLOCKING_DEGRADED_CODES.has(code));
}
```

Sort eligible capabilities by explicit pin, preferred provider, adapter ID, model ID, and capability ID. Never infer provider privacy, cost, or auth from names.

- [ ] **Step 4: Run focused tests and typecheck**

```bash
node --import tsx --test test/media-capabilities.test.ts
npm run typecheck
```

Expected: PASS, including expired and false-dispatchable red paths.

- [ ] **Step 5: Commit**

```bash
git add src/media-execution/capabilities test/media-capabilities.test.ts
git commit -m "feat(media): add honest capability readiness"
```

### Task 4: Planning, quotes, authority, and atomic idempotency

**Files:**
- Create: `src/media-execution/authority/quotes.ts`
- Create: `src/media-execution/authority/grants.ts`
- Create: `src/media-execution/authority/decisions.ts`
- Create: `test/media-authority.test.ts`

**Interfaces:**
- Consumes: Task 1 hashes, Task 2 transactions, Task 3 selected capability/readiness.
- Produces: `MediaQuote`, `MediaAuthorityGrant`, `MediaProbeAuthorityGrant`, `MediaAuthorityDecision`, `planMediaIntent()`, `confirmMediaPlan()`, `submitAuthorizedMedia()`, `authorizeMediaAttempt()`, `authorizeReadinessProbe()`.

- [ ] **Step 1: Write failing authority tests**

Cover missing/expired/mutated grants, exact model membership, principal mismatch, cumulative numeric ceiling, null unmeasured amount, one-use grant consumption, concurrent same-key submit, changed-hash conflict, retries, provider changes, and probe/execution grant substitution.

```ts
test("concurrent identical submission creates one execution", async () => {
  const [left, right] = await Promise.all([
    submitAuthorizedMedia(store, submission, principal),
    submitAuthorizedMedia(store, submission, principal),
  ]);
  assert.equal(left.execution_id, right.execution_id);
  assert.equal(store.countExecutions(), 1);
});
```

- [ ] **Step 2: Verify red**

```bash
node --import tsx --test test/media-authority.test.ts
```

Expected: FAIL because authority modules are missing.

- [ ] **Step 3: Implement plan-confirm-submit**

Use an injected trusted confirmation context:

```ts
export interface TrustedConfirmationContext {
  principal: string;
  approved_by: string;
  evidence: "reported" | "observed" | "attested";
  now_ms: number;
}
```

At submit, one `BEGIN IMMEDIATE` transaction must:

```text
load immutable plan
resolve grant
verify principal, plan hash, request hash, provider, model, unit, ceiling, attempts, expiry
look up (principal, submitted_by, idempotency_key)
return existing execution when hash matches
fail on changed hash
consume grant
insert execution and reserved attempt
append allowed authority decision
```

Numeric grants sum every previously allowed estimate under the grant. Missing numeric estimate fails closed.

- [ ] **Step 4: Run focused and concurrency tests**

```bash
node --import tsx --test test/media-authority.test.ts
npm run typecheck
```

Expected: PASS with one execution under concurrent identical submissions.

- [ ] **Step 5: Commit**

```bash
git add src/media-execution/authority test/media-authority.test.ts
git commit -m "feat(media): gate plans and attempts with authority"
```

### Task 5: Closed lifecycle, fake adapters, and listener-free recovery worker

**Files:**
- Create: `src/media-execution/lifecycle/state-machine.ts`
- Create: `src/media-execution/lifecycle/coordinator.ts`
- Create: `src/media-execution/lifecycle/recovery.ts`
- Create: `src/media-execution/worker.ts`
- Create: `test/media-lifecycle.test.ts`
- Create: `test/helpers/fake-media-adapter.ts`

**Interfaces:**
- Consumes: `MediaStore`, authority decisions, capability registry.
- Produces: `MediaLifecycleCoordinator`, `MediaWorker`, `claimDueExecution()`, `renewMediaLease()`, `runMediaWorkerUntilIdle()`, `FakeMediaAdapter`.

- [ ] **Step 1: Write failing state-machine tests**

Cover every allowed transition, every forbidden transition, terminality, settled-attempt-before-retry, uncertain launch, review selection/reject/expiry, cancellation, late settlement, and worker lease generation.

- [ ] **Step 2: Write failing fake-plane recovery tests**

The fake adapter must simulate:

```ts
type FakeScenario =
  | { kind: "sync_success"; artifacts: string[] }
  | { kind: "async_resume"; provider_job_id: string; polls_before_ready: number }
  | { kind: "needs_review"; candidates: string[] }
  | { kind: "uncertain_without_continuation" }
  | { kind: "late_after_cancel"; artifact: string };
```

Prove MiniMax-style detach/restart, PixelLab-style review, and `interrupted_unknown`.

- [ ] **Step 3: Verify red**

```bash
node --import tsx --test test/media-lifecycle.test.ts
```

Expected: FAIL because coordinator and worker modules are missing.

- [ ] **Step 4: Implement state/attempt tables and worker election**

Use a SQLite worker-singleton lease. Competing starters exit without polling. Execution writes require matching lease generation. Requeue only after the prior attempt is durably `settled_failure` and fenced.

- [ ] **Step 5: Run the focused race matrix**

```bash
node --import tsx --test test/media-lifecycle.test.ts
```

Expected: PASS for sync, async, review, cancellation, restart, and race cases.

- [ ] **Step 6: Commit**

```bash
git add src/media-execution/lifecycle src/media-execution/worker.ts test/media-lifecycle.test.ts test/helpers/fake-media-adapter.ts
git commit -m "feat(media): add durable execution worker"
```

### Task 6: Artifact admission, bundles, and trusted materialization

**Files:**
- Create: `src/media-execution/artifacts/types.ts`
- Create: `src/media-execution/artifacts/admission.ts`
- Create: `src/media-execution/artifacts/store.ts`
- Create: `test/helpers/media-fixtures.ts`
- Create: `test/media-artifacts.test.ts`

**Interfaces:**
- Consumes: execution/attempt IDs and store transaction.
- Produces: `MediaArtifactHandle`, `MediaBundleHandle`, `admitMediaArtifacts()`, `materializeMediaArtifactForConsumer()`.

- [ ] **Step 1: Write failing adversarial artifact tests**

Generate deterministic tiny valid PNG/WAV bytes and malformed fixtures through `test/helpers/media-fixtures.ts`. Cover traversal, absolute path, symlink, replacement race, directory, FIFO where supported, excess bytes/count, MIME mismatch, decode bomb headers, duplicate commit, and late files. Do not depend on provider-produced or user media.

- [ ] **Step 2: Verify red**

```bash
node --import tsx --test test/media-artifacts.test.ts
```

Expected: FAIL because artifact admission is missing.

- [ ] **Step 3: Implement canonical containment and atomic commit**

Reject any source whose `lstat` is not a regular file. Open with no-follow semantics where available, hash the opened descriptor, validate magic bytes and bounded metadata, and rename into a content-addressed destination with no-clobber semantics.

For bundles:

```ts
export interface MediaBundleEntry {
  relative_name: string;
  mime_type: string;
  byte_length: number;
  sha256: string;
}
```

Validate every entry first, then commit the set and database rows in one transaction.

- [ ] **Step 4: Implement registered-consumer materialization**

Resolve only a host-configured consumer ID. Copy to a generated content-addressed destination under that root, verify the copied hash, and return no path through MCP.

- [ ] **Step 5: Run artifact tests**

```bash
node --import tsx --test test/media-artifacts.test.ts
```

Expected: PASS on valid image/audio/bundle and all hostile-path cases.

- [ ] **Step 6: Commit**

```bash
git add src/media-execution/artifacts test/helpers/media-fixtures.ts test/media-artifacts.test.ts
git commit -m "feat(media): admit and materialize artifacts safely"
```

### Task 7: Fixed process boundary and NDJSON protocol

**Files:**
- Create: `src/media-execution/adapters/types.ts`
- Create: `src/media-execution/adapters/process.ts`
- Create: `test/media-process-adapter.test.ts`
- Create: `test/helpers/fake-media-executable.mjs`

**Interfaces:**
- Consumes: `ResolvedMediaRequest`, `MediaAttemptContext`, artifact staging token.
- Produces: `MediaProviderAdapter`, `FixedMediaProcessAdapter`, bounded adapter event parser.

- [ ] **Step 1: Write failing protocol tests**

Cover accepted-first, one terminal, no post-terminal events, bounded stdout/stderr, malformed JSON, mixed usage units, prompt absent from argv, scrubbed environment, fixed cwd, timeout, and process-tree cancellation.

- [ ] **Step 2: Verify red**

```bash
node --import tsx --test test/media-process-adapter.test.ts
```

Expected: FAIL because the fixed process adapter is missing.

- [ ] **Step 3: Implement fixed spawning**

The constructor owns every launch value:

```ts
export interface FixedMediaProgram {
  executable: string;
  fixed_args: readonly string[];
  fixed_cwd: string;
  allowed_env_keys: readonly string[];
  timeout_ms: number;
  max_stdout_bytes: number;
  max_stderr_bytes: number;
}
```

Spawn with `shell: false`, a new process group where supported, bounded stdin JSON, and an explicit environment built from the allowlist.

- [ ] **Step 4: Implement closed NDJSON state validation**

Accept exactly:

```text
accepted
(progress | usage | artifact)*
terminal
EOF
```

Exit without terminal is `adapter_protocol_failure`.

- [ ] **Step 5: Run focused platform tests**

```bash
node --import tsx --test test/media-process-adapter.test.ts
npm run typecheck
```

Expected: PASS; unsupported full-tree cancellation is reported as unsupported, never confirmed.

- [ ] **Step 6: Commit**

```bash
git add src/media-execution/adapters/types.ts src/media-execution/adapters/process.ts test/media-process-adapter.test.ts test/helpers/fake-media-executable.mjs
git commit -m "feat(media): add fixed adapter process protocol"
```

### Task 8: Service and complete fake-plane CLI (includes receipts)

**Files (additive to prior tasks):**
- Create: `src/media-execution/receipts/events.ts`
- Create: `src/media-execution/receipts/projection.ts`
- Create: `src/media-execution/service.ts`
- Create: `src/media-execution/trusted-host.ts`
- Create: `src/bin/media.ts`
- Create: `test/media-service.test.ts`
- Create: `test/media-trusted-host.test.ts`
- Create: `test/media-cli.test.ts`
- Create: `test/media-receipts.test.ts`

**Interfaces:**
- Consumes: Tasks 1-7.
- Produces: `MediaExecutionService`, `runMediaCli()`, executable `meshfleet-media`, plus first-class receipt events (`none` | `reported` | `observed` | `attested`) and projection. Self-report is never `observed`; artifact hash is never provider authorship; requested/selected/observed remain distinct.

- [ ] **Step 1: Write failing service tests**

Exercise capabilities, readiness, plan, trusted confirm, submit, status, cancel, artifacts, registered-consumer materialization, review, and worker. Confirm cannot be called through a non-interactive context.

- [ ] **Step 2: Write failing CLI black-box tests**

Spawn `src/bin/media.ts` with `--import tsx`. Assert one JSON document, exit classes 0/2/3/4/5/6/7, bounded stdin, no prompt on argv, and no provider contact. In `test/media-trusted-host.test.ts`, prove `artcraft-host-confirm` refuses an ordinary shell, a missing/wrong/closed inherited descriptor, caller-supplied approver fields, and every principal other than the fixed ArtCraft host; prove one valid pre-opened descriptor is consumed once and cannot be replayed.

- [ ] **Step 3: Verify red**

```bash
node --import tsx --test test/media-service.test.ts test/media-trusted-host.test.ts test/media-cli.test.ts
```

Expected: FAIL because the service and bin do not exist.

- [ ] **Step 4: Implement service composition and CLI grammar**

Export:

```ts
export class MediaExecutionService {
  listCapabilities(): MediaCapability[];
  checkReadiness(): MediaReadinessEvidence[];
  plan(intent: MediaPlanIntent, principal: string): MediaPlan;
  confirm(planId: string, context: TrustedConfirmationContext): MediaAuthorityGrant;
  confirmFromTrustedArtcraftHost(planId: string, hostEvidence: VerifiedHostEvidence): MediaAuthorityGrant;
  submit(submission: MediaSubmission, principal: string): MediaExecution;
  status(executionId: string, principal: string): MediaExecutionProjection;
  cancel(executionId: string, principal: string, reasonCode: string): MediaExecutionProjection;
  review(executionId: string, principal: string, candidateId: string): MediaExecutionProjection;
  materializeForConsumer(
    executionId: string,
    artifactIds: readonly string[],
    consumerId: string,
    principal: string,
  ): MaterializedArtifactReceipt[];
}
```

The interactive CLI confirm path must require a TTY and must never accept `approved_by` from JSON. Add an internal `artcraft-host-confirm` mode that succeeds only when `verifyTrustedArtcraftHost()` consumes the fixed pre-opened anonymous descriptor supplied by the ArtCraft Tauri process. The mode reads only `plan_id`, fixes principal/channel/evidence in source, and refuses when invoked from an ordinary shell, fake renderer, MCP, or without the descriptor. Add `artifacts materialize` with fixed registered consumer IDs; it accepts execution/artifact IDs on stdin, returns only generated relative names and hashes to the trusted host, and never accepts or returns a consumer root through the request/MCP surface.

- [ ] **Step 5: Run focused tests (black-box grammar lock)**

Black-box test the full approved grammar: `capabilities`, `readiness`, `plan`, `confirm`, `submit`, `status`, `cancel`, `artifacts`, `review`, `worker --run-until-idle` plus exit classes (success, usage, invalid, auth, conflict, timeout). Lock the grammar surface before Task 9.

```bash
node --import tsx --test test/media-service.test.ts test/media-trusted-host.test.ts test/media-cli.test.ts
npm run build
```

Expected: PASS with fake adapters only.

- [ ] **Step 6: Commit**

```bash
git add src/media-execution/service.ts src/media-execution/trusted-host.ts src/bin/media.ts test/media-service.test.ts test/media-trusted-host.test.ts test/media-cli.test.ts
git commit -m "feat(media): expose fake-plane service and CLI"
```

### Task 9: Complete provider registry and fixed adapters

**Files:**
- Create: `src/media-execution/adapters/minimax.ts`
- Create: `src/media-execution/adapters/pixellab.ts`
- Create: `src/media-execution/adapters/gemini-image.ts`
- Create: `src/media-execution/adapters/google-audio.ts`
- Create: `src/media-execution/adapters/codex-image.ts`
- Create: `src/media-execution/adapters/grok.ts`
- Create: `src/media-execution/adapters/sora.ts`
- Create: `src/media-execution/adapters/fal.ts`
- Create: `src/media-execution/adapters/artcraft-backend.ts`
- Create: `test/media-provider-adapters.test.ts`

**Interfaces:**
- Consumes: `MediaProviderAdapter`, fixed process boundary, capability registry, and the committed fleet machine-wrapper protocol conformance fixtures.
- Produces: the complete named provider registry with honest readiness.

- [ ] **Step 1: Write common adapter contract tests**

Each adapter must pass registration, closed validation, local readiness, quote, submit/poll/collect/cancel support declaration, malformed child output, timeout, and secret-redaction fixtures. The PixelLab, Gemini image, Google audio, Codex image, and MiniMax tests invoke fake copies of their fixed `--meshfleet-machine` modes.

- [ ] **Step 2: Pin the wrapper commit and encode readiness truth**

Use these non-negotiable starting points:

```text
MiniMax: fixed MCP stdio bridge code exists; unavailable until literal minimax-media-mcp and its required tools pass a separately authorized probe.
PixelLab: fixed machine mode supports its validated operations; wrapper_present/configured_unverified until separately authorized probe evidence.
Gemini/Imagen: fixed machine mode supports generation/edit; Imagen references reject; wrapper_present/configured_unverified until probe evidence.
Google audio/Lyria: fixed machine mode reports actual format and estimate evidence; wrapper_present/configured_unverified until probe evidence.
Codex image: fixed invocation-isolated machine mode; explicit_only and never automatic, even after probe evidence.
Grok: adapter targets only the literal grok-media-machine --stdio protocol; configured_unverified or unavailable; never dispatchable without executable, auth admission, artifact, and live first-flight evidence.
Sora/FAL/ArtCraft backend: describe/readiness only while Storyteller-coupled.
```

- [ ] **Step 3: Implement adapters without duplicating credentials**

Pin the wrapper source commit in compatibility evidence. Each fixed adapter launches only its named executable and `--meshfleet-machine`, sends `meshfleet.media-adapter-request.v1` on stdin, and consumes closed events on stdout. The Grok adapter recognizes only the fixed `grok-media-machine --stdio` host bridge and remains unavailable while it is absent; the request cannot supply an alternative. Readiness stays non-dispatchable until separately authorized, unexpired probe evidence exists; once it exists, PixelLab, Gemini/Imagen, Google audio, and available MiniMax operations may dispatch. Codex additionally requires an exact explicit pin. If the current host lacks the fixed wrapper commit, MiniMax MCP executable, or Grok machine bridge, `submit()` fails closed with `capability_not_dispatchable`.

- [ ] **Step 4: Add provider-specific offline fixtures**

Prove MiniMax task-ID resume, PixelLab operation-specific continuation/review, Imagen reference rejection, Google format truth, Codex concurrent-output isolation, and hard refusal for Grok/Sora/FAL/ArtCraft backend.

- [ ] **Step 5: Run provider tests**

```bash
node --import tsx --test test/media-provider-adapters.test.ts
npm run typecheck
```

Expected: PASS without executing `/Users/johnwhitman/AI/Tools/*` or contacting a provider.

- [ ] **Step 6: Commit**

```bash
git add src/media-execution/adapters test/media-provider-adapters.test.ts
git commit -m "feat(media): register complete provider suite honestly"
```

### Task 10: Additive MCP tools, package surface, and release evidence

**Files:**
- Modify: `src/index.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/mcp-registry.md`
- Modify: `COMPATIBILITY.md`
- Create: `test/media-mcp.test.ts`
- Create: `test/media-package.test.ts`

**Interfaces:**
- Consumes: `MediaExecutionService`.
- Produces: eight additive MCP tools, `meshfleet-media` package bin, library exports, exact documentation/tool-count evidence.

- [ ] **Step 1: Reconcile with upstream public-boundary documentation**

Run:

```bash
git show origin/main:README.md >/tmp/meshfleet-media-readme-upstream
git diff HEAD..origin/main -- README.md COMPATIBILITY.md docs/mcp-registry.md package.json src/recommend-route.ts test/recommend-route-package.test.ts
```

Expected: upstream documentation and package-export changes are reconciled before editing public claims; the `recommend-route` export and package test remain intact.

- [ ] **Step 2: Write failing MCP tests**

Assert exact schemas and behavior for:

```text
list_media_capabilities_v1
check_media_readiness_v1
plan_media_job_v1
submit_media_job_v1
get_media_job_v1
cancel_media_job_v1
list_media_artifacts_v1
review_media_job_v1
```

`submit_media_job_v1` accepts `plan_id`, resolves exactly one unconsumed grant for the authenticated transport principal, and never accepts `authority_ref`.

- [ ] **Step 3: Write failing package tests**

Assert:

```ts
assert.equal(pkg.bin["meshfleet-media"], "dist/bin/media.js");
assert.equal(pkg.exports["./media-execution"], "./dist/media-execution/service.js");
```

Also assert built `dist/`, packed tarball contents, existing tool schemas, and the pre-media 36-tool compatibility fixture.

- [ ] **Step 4: Register thin MCP handlers and package entries**

Keep parsing at the boundary and delegate to one service instance. Do not return binary bytes or store paths.

- [ ] **Step 5: Update public truth from observed output**

Run the built server's `tools/list`, count the exact resulting tools, and update README, MCP registry, compatibility, and package tests from that observed document.

- [ ] **Step 6: Run the release-quality local gate**

```bash
npm run build
npm test
npm run typecheck
npm pack --dry-run
git diff --check
```

Expected: all green; no provider call, installation, publication, or deployment.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts package.json README.md docs/mcp-registry.md COMPATIBILITY.md test/media-mcp.test.ts test/media-package.test.ts
git commit -m "feat(media): publish additive CLI and MCP surface"
```

### Task 11: Independent exact-diff review

**Files:**
- Create after implementation: `docs/handoffs/MESHFLEET-MEDIA-CORE-CURRENT.md`

**Interfaces:**
- Consumes: exact diff against reconciled `origin/main`.
- Produces: factual findings disposition and local-only handoff.

- [ ] **Step 1: Run secret and whitespace checks**

```bash
git diff --check
gitleaks git --no-banner
```

- [ ] **Step 2: Dispatch clean-room reviews**

Use MeshFleet MiniMax for mechanical completeness and Grok for adversarial authority/lifecycle/artifact review. Supply the exact diff and set `NO_MEMORY=1` when using direct wrappers.

- [ ] **Step 3: Verify every finding locally**

Fix only findings reproducible from source or tests. Rerun the focused test and full local gate after each repair.

- [ ] **Step 4: Write and commit the handoff**

Record exact commands, pass counts, unsupported/non-dispatchable providers, and every remaining provider-call/spend/merge/push/install/publish/deploy gate.

```bash
git add docs/handoffs/MESHFLEET-MEDIA-CORE-CURRENT.md
git commit -m "docs: record MeshFleet media execution evidence"
```
