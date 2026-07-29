# ArtCraft MeshFleet Media Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-neutral “Local Media via MeshFleet” workflow to ArtCraft that plans, confirms, submits, recovers, materializes, and displays local image/video jobs without Storyteller upload or a synthetic remote provider.

**Architecture:** A new Rust service namespace owns a fixed stdio bridge to the committed `meshfleet-media` CLI contract. MeshFleet executions live in dedicated task-database rows keyed by `execution_id`, not in `provider_job_id` and not in `GenerationProvider`. Tauri commands expose plan, confirm-submit, readiness, status, and cancellation to a thin frontend client. A startup reconciler content-copies admitted artifacts into ArtCraft-owned storage, settles the local row, and emits the existing typed completion events consumed by `useDesktopGenerationFeed`.

**Tech Stack:** Rust 2021, Tauri 2, Tokio, serde/serde_json, sqlx/SQLite, React 18, TypeScript, Zustand, Jest, existing ArtCraft Tauri APIs/events.

## Global Constraints

- Execute only after the MeshFleet core plan has committed the CLI schemas and fake executable fixtures.
- Create a fresh ArtCraft worktree from a reconciled remote base; the primary checkout is diverged and contains unrelated login-modal, realtime, frontend, and lockfile changes.
- Do not add MeshFleet to `GenerationProvider` in Rust or TypeScript.
- Do not edit `crates/desktop/tauri-realtime/**`, `frontend/apps/genhub/**`, or deprecated command/job trees.
- The production bridge executable path is an absolute build-time constant or trusted desktop-host configuration outside every renderer/request input; only tests may inject a fake executable. The production spawn validates the canonical path, regular-file type, expected owner, owner-execute bit, and absence of group/other write bits, rejects any submission-provided executable, argv, cwd, or env, and uses `env_clear()` plus an explicit locale allowlist. Non-interactive confirmation uses MeshFleet's internal ArtCraft trusted-host mode and a pre-opened anonymous confirmation descriptor created by the Tauri backend. The renderer cannot create, select, or populate that descriptor.
- Prompts and inputs cross the child boundary in bounded stdin JSON, never argv or environment.
- The renderer receives quotes, readiness facts, execution IDs, state, route truth, and ArtCraft-owned artifact locations; it never receives grants, credential fields, registered consumer roots, or arbitrary artifact paths.
- The first v1 image-to-video workflow accepts only a retained MeshFleet `MediaArtifactHandle` from a prior admitted local job. Existing ArtCraft/Storyteller URLs and arbitrary local files are not silently imported; the panel stays unavailable for those inputs until a separately designed input-admission contract exists.
- A UI confirmation can mint authority only for the exact persisted plan shown to the user.
- `interrupted_unknown` is terminal and never auto-regenerates.
- `needs_review` never emits a completion event.
- A MeshFleet `succeeded` state is not an ArtCraft completion until content-copy, hash verification, decode validation, and atomic rename have all succeeded.
- Keep the existing Storyteller, FAL, Sora, and Grok workflows unchanged.
- The empty Grok cookie allowlist must not produce an actionable MeshFleet login prompt.
- Offline implementation uses the fake MeshFleet bridge only; no provider call, live readiness probe, Storyteller upload, or spend is authorized.

## Baseline

Before Task 1, run from the isolated ArtCraft worktree:

```bash
git status --short --branch
cargo test -p sqlite_tasks
cargo test -p artcraft --lib
cd frontend
npm run --workspace=artcraft test -- --runInBand --passWithNoTests
npm run --workspace=artcraft typecheck
```

Record pre-existing failures before editing. Build the private desktop only at the release-quality gate, from `crates/desktop/artcraft/`, using the repository’s documented macOS command.

---

### Task 1: Fixed MeshFleet bridge protocol and truthful readiness

**Files:**
- Create: `crates/desktop/artcraft/src/services/meshfleet_media/mod.rs`
- Create: `crates/desktop/artcraft/src/services/meshfleet_media/contract.rs`
- Create: `crates/desktop/artcraft/src/services/meshfleet_media/bridge_config.rs`
- Create: `crates/desktop/artcraft/src/services/meshfleet_media/bridge.rs`
- Modify: `crates/desktop/artcraft/src/services/mod.rs`

**Interfaces:**
- Consumes: committed `meshfleet-media` JSON fixtures for `version`, `capabilities`, `plan`, `confirm`, `submit`, `status`, `artifacts`, `review`, `cancel`, and `worker --run-until-idle`.
- Produces: `MeshfleetMediaBridge`, `MeshfleetMediaBridgeConfig`, `MeshfleetReadiness`, `MeshfleetPlan`, `MeshfleetSubmission`, `MeshfleetJob`, `MeshfleetArtifactHandle`, `MeshfleetBridgeError`.

- [ ] **Step 1: Write failing Rust unit tests beside the new modules**

Use a temporary fake executable that records argv and stdin. Cover version mismatch, unknown JSON fields, stdout/stderr limits, timeout, non-zero exit, malformed JSON, secret-shaped output rejection, fixed argv, and `env_clear()`. Table-test every `BridgeCommand` mapping, including `Review -> ["review", "--json"]` and `WorkerRunUntilIdle -> ["worker", "--run-until-idle", "--json"]`; review stdin contains only execution/candidate IDs. Production-config tests reject a relative path, symlink, wrong owner, group/other-writable mode, non-file target, and any renderer/request executable field:

```rust
#[tokio::test]
async fn plan_sends_creative_input_only_on_stdin() {
  let fixture = FakeBridge::new("plan", PLAN_RESPONSE);
  let bridge = MeshfleetMediaBridge::for_test(fixture.config());
  let plan = bridge.plan(image_intent("private prompt")).await.unwrap();

  assert!(!plan.plan_id.is_empty());
  assert_eq!(fixture.argv(), vec!["plan", "--json"]);
  assert!(fixture.stdin_json().contains("private prompt"));
  assert!(!fixture.process_environment().values().any(|v| v.contains("private prompt")));
}
```

- [ ] **Step 2: Verify the test is red**

Run:

```bash
cargo test -p artcraft meshfleet_media::bridge
```

Expected: FAIL because `services::meshfleet_media` is absent.

- [ ] **Step 3: Implement the closed bridge**

Use closed serde contracts with `#[serde(deny_unknown_fields)]`. `bridge_config.rs` resolves one host-owned absolute executable path from a build-time constant or trusted desktop-host configuration that is never renderer/request input. Canonicalize it once; require a regular non-symlink executable owned by the current user, owner-executable, and not group/other-writable; spawn that exact path. Production construction uses `kill_on_drop(true)`, piped stdin/stdout/stderr, `env_clear()`, an explicit locale-only allowlist, a 30-second control timeout, and independent byte caps. Command selection is an internal enum:

```rust
enum BridgeCommand {
  Version,
  Capabilities,
  Plan,
  ArtcraftHostConfirm,
  Submit,
  Status,
  MaterializeArtifacts,
  Review,
  Cancel,
  WorkerRunUntilIdle,
}
```
Map every enum variant to the exact committed CLI fixture; `Review` uses only the generic execution/candidate selection contract and `WorkerRunUntilIdle` is the fixed listener-free wake command. Sprite-only PixelLab candidate UX remains in the PixelLab wrapper; ArtCraft exposes only the generic execution review projection. If `review_gated=true` requires provider-specific candidate UX unavailable in ArtCraft, planning fails before confirmation.

Map missing binary, incompatible version, malformed response, timeout, and non-dispatchable capability to distinct readiness reasons. The production `ArtcraftHostConfirm` spawn creates and passes the anonymous descriptor expected by MeshFleet; all other commands omit it. Do not translate `configured_unverified` into ready.

- [ ] **Step 4: Run focused tests and library check**

```bash
cargo test -p artcraft meshfleet_media::bridge
cargo check -p artcraft
```

Expected: PASS with no network listener and no provider process.

- [ ] **Step 5: Commit**

```bash
git add crates/desktop/artcraft/src/services
git commit -m "feat(artcraft): add fixed MeshFleet media bridge"
```

### Task 2: Dedicated durable MeshFleet job rows

**Files:**
- Create: `_database/sql/artcraft_migrations/20260729000000_create_meshfleet_media_jobs.sql`
- Modify: `crates/schema/database/sqlite_tasks/Cargo.toml`
- Create: `crates/schema/database/sqlite_tasks/src/queries/meshfleet_media_job.rs`
- Create: `crates/schema/database/sqlite_tasks/src/queries/meshfleet_media_jobs.rs`
- Modify: `crates/schema/database/sqlite_tasks/src/queries/mod.rs`
- Modify: `crates/schema/database/sqlite_tasks/src/lib.rs`

**Interfaces:**
- Consumes: ArtCraft `TaskDbConnection`, bridge execution and state contracts.
- Produces: `MeshfleetMediaJob`, `MeshfleetMediaState`, `create_meshfleet_media_job()`, `update_meshfleet_media_job()`, `get_meshfleet_media_job()`, `list_incomplete_meshfleet_media_jobs()`, `list_meshfleet_media_jobs_for_frontend()`.

- [ ] **Step 1: Write failing sqlx tests**

Add async tests in `meshfleet_media_jobs.rs` using workspace `tokio` and `tempfile` dev-dependencies plus `TaskDbConnection::connect_and_migrate()`. Prove:

- `execution_id` and `attempt_id` are distinct columns from `provider_job_id`;
- the row does not require or synthesize `GenerationProvider`;
- only the explicit state projection is accepted;
- requested and actual provider/model remain separate;
- the quote’s measured/unmeasured/unknown evidence survives reopen;
- incomplete listing excludes terminal rows.

```rust
assert_eq!(job.execution_id, "exec_01");
assert_eq!(job.provider_job_id, None);
assert_eq!(job.requested_provider.as_deref(), Some("gemini"));
assert_eq!(job.selected_provider.as_deref(), Some("gpt"));
```

- [ ] **Step 2: Verify red**

```bash
cargo test -p sqlite_tasks meshfleet_media
```

Expected: FAIL because the migration and query module do not exist.

- [ ] **Step 3: Implement schema and typed queries**

Add `tokio.workspace = true` and `tempfile.workspace = true` under dev-dependencies. The migration creates `meshfleet_media_jobs` with a local primary key, unique `execution_id`, nullable `attempt_id`, `media_kind`, state, immutable plan hash, requested route fields, selected route fields, quote evidence, stable reason code, retained admitted artifact ID/MIME/byte length/SHA-256, ArtCraft-owned relative artifact path, timestamps, and optional frontend subscriber data. Those retained handle facts are sufficient to construct a later image-to-video intent without importing a path. Add CHECK constraints for state and media kind. Never store prompt text, authority references, registered roots, or credentials. Use runtime `sqlx::query_as` plus explicit binds for this new table so the task does not depend on pre-populating `/tmp/tasks.sqlite` or guessing generated `.sqlx` query hashes.

- [ ] **Step 4: Run schema and compatibility tests**

```bash
cargo test -p sqlite_tasks meshfleet_media
cargo test -p sqlite_tasks
```

Expected: PASS; existing `tasks` rows and queries remain byte-for-byte compatible.

- [ ] **Step 5: Commit**

```bash
git add _database/sql/artcraft_migrations crates/schema/database/sqlite_tasks/Cargo.toml crates/schema/database/sqlite_tasks/src
git commit -m "feat(artcraft): persist MeshFleet media jobs separately"
```

### Task 3: Plan, human confirm, submit, status, and cancel Tauri commands

**Files:**
- Create: `crates/desktop/artcraft/src/services/meshfleet_media/commands.rs`
- Create: `crates/desktop/artcraft/src/services/meshfleet_media/state.rs`
- Modify: `crates/desktop/artcraft/src/services/meshfleet_media/mod.rs`
- Modify: `crates/desktop/artcraft/src/lib.rs`
- Create: `frontend/libs/tauri-api/src/lib/meshfleet/MeshfleetMedia.ts`
- Modify: `frontend/libs/tauri-api/src/index.ts`
- Create: `frontend/apps/artcraft/test/libs/tauri-api/MeshfleetMedia.test.ts`

**Interfaces:**
- Consumes: `MeshfleetMediaBridge`, `TaskDbConnection`, `MediaPlanIntent`, trusted Tauri window/principal context.
- Produces Tauri commands: `meshfleet_media_readiness_command`, `meshfleet_media_plan_command`, `meshfleet_media_confirm_submit_command`, `meshfleet_media_status_command`, `meshfleet_media_review_command`, `meshfleet_media_cancel_command`.
- Produces frontend functions: `GetMeshfleetMediaReadiness`, `PlanMeshfleetMedia`, `ConfirmSubmitMeshfleetMedia`, `GetMeshfleetMediaStatus`, `ReviewMeshfleetMedia`, `CancelMeshfleetMedia`.

- [ ] **Step 1: Write failing command tests**

Use a fake bridge and temporary task DB. Assert plan has no side effects, confirm-submit requires the exact plan hash, the renderer cannot supply `authority_ref`, double-clicking confirm returns the same execution, changed plan content conflicts, review accepts only execution/candidate IDs, and cancel preserves best-effort truth. After the durable submit transaction, prove exactly one worker wake is requested per successful call; concurrent calls may start competing fixed processes, but the committed Core fixture proves one SQLite lease winner and no duplicate provider dispatch:

```rust
assert!(serde_json::to_value(&request).unwrap().get("authority_ref").is_none());
let first = confirm_submit(app_state.clone(), trusted_window(), plan.plan_id.clone()).await?;
let second = confirm_submit(app_state, trusted_window(), plan.plan_id).await?;
assert_eq!(first.execution_id, second.execution_id);
```

- [ ] **Step 2: Verify red**

```bash
cargo test -p artcraft meshfleet_media::commands
```

Expected: FAIL because commands are absent.

- [ ] **Step 3: Implement the trusted host flow**

`plan` sends the closed intent and returns the persisted quote. `confirm_submit` accepts only `plan_id` plus the trusted Tauri invocation context, creates the anonymous confirmation descriptor, calls the bridge’s fixed internal `artcraft-host-confirm` mode, receives the opaque grant internally, submits IDs only, and creates one durable local row. Only after that transaction commits, start the fixed `WorkerRunUntilIdle` command detached from the renderer request; MeshFleet's SQLite singleton lease owns election. A wake failure leaves the row durably queued and returns truthful remediation rather than resubmitting. `review` sends only execution and selected-candidate IDs, then ensures the worker again. The descriptor carries no prompt, credential, approver name, or reusable token and closes immediately after the child exits. Register all six commands in `lib.rs`. Do not add a browser-accessible route or listener.

- [ ] **Step 4: Add and test the TypeScript wrappers**

Use explicit request/result unions and no generic invoke escape hatch. Add Jest tests beside `MeshfleetMedia.ts` that mock `invoke` and prove the confirm request contains only `plan_id` and review contains only `execution_id` plus `candidate_id`.

Run:

```bash
cargo test -p artcraft meshfleet_media::commands
cd frontend
npm run --workspace=artcraft test -- --runInBand test/libs/tauri-api/MeshfleetMedia.test.ts
npm run --workspace=artcraft typecheck
```

- [ ] **Step 5: Commit**

```bash
git add crates/desktop/artcraft/src frontend/libs/tauri-api/src frontend/apps/artcraft/test/libs/tauri-api/MeshfleetMedia.test.ts
git commit -m "feat(artcraft): add MeshFleet plan confirm submit commands"
```

### Task 4: Restart reconciliation and explicit state projection

**Files:**
- Create: `crates/desktop/artcraft/src/services/meshfleet_media/reconcile.rs`
- Create: `crates/desktop/artcraft/src/core/lifecycle/startup/tasks/start_meshfleet_media_reconciler.rs`
- Modify: `crates/desktop/artcraft/src/core/lifecycle/startup/tasks/mod.rs`
- Modify: `crates/desktop/artcraft/src/core/lifecycle/startup/handle_tauri_startup.rs`

**Interfaces:**
- Consumes: incomplete local rows and bridge `status`.
- Produces: `project_meshfleet_state()`, `reconcile_meshfleet_media_jobs()`, one bounded startup/background reconciliation loop.

- [ ] **Step 1: Write failing projection and recovery tests**

Table-test every approved projection. Add restart fixtures for durable async resume, missing synchronous child, `needs_review`, accepted review selection (`needs_review -> awaiting_artifact|succeeded`), rejected/expired review, and terminal rows:

```rust
assert_eq!(
  project_meshfleet_state(MeshfleetState::InterruptedUnknown),
  ArtcraftMeshfleetState::InterruptedUnknown,
);
assert_eq!(fake_bridge.submission_count(), 0);
```

- [ ] **Step 2: Verify red**

```bash
cargo test -p artcraft meshfleet_media::reconcile
```

- [ ] **Step 3: Implement reconciliation**

At startup, first invoke the fixed `WorkerRunUntilIdle` wake once, then list incomplete rows, query only by `execution_id`, and update projections. Concurrent app windows or submit/startup races are safe only because the Core SQLite singleton lease elects one polling worker; add a fake-plane race test for this exact path. Never call `plan`, `confirm`, or `submit` from reconciliation. A lost synchronous execution remains `interrupted_unknown`; only durable provider evidence may resume it. Poll with bounded backoff and shut down with the Tauri lifecycle.

- [ ] **Step 4: Run focused and startup tests**

```bash
cargo test -p artcraft meshfleet_media::reconcile
cargo test -p artcraft core::lifecycle::startup
```

- [ ] **Step 5: Commit**

```bash
git add crates/desktop/artcraft/src/services/meshfleet_media/reconcile.rs crates/desktop/artcraft/src/core/lifecycle/startup
git commit -m "feat(artcraft): reconcile MeshFleet media jobs on restart"
```

### Task 5: Provider-neutral local artifact commit and existing completion events

**Files:**
- Create: `crates/desktop/artcraft/src/services/meshfleet_media/materialize.rs`
- Create: `crates/desktop/artcraft/src/services/meshfleet_media/complete.rs`
- Modify: `crates/desktop/artcraft/src/services/meshfleet_media/reconcile.rs`
- Reference without provider-specific copying: `crates/desktop/artcraft/src/services/grok/threads/grok_image_websocket_thread/grok_image_websocket_thread.rs`
- Reference without provider-specific copying: `crates/desktop/artcraft/src/services/grok/threads/grok_video_task_polling/grok_video_task_polling_thread.rs`

**Interfaces:**
- Consumes: registered-consumer artifact materialization, expected SHA-256/MIME/size, ArtCraft data directory, existing typed image/video completion emitters.
- Produces: `commit_meshfleet_artifact()`, `complete_meshfleet_media_job()`.

- [ ] **Step 1: Write failing artifact tests**

Cover unknown artifact ID, symlink, path escape, hash mismatch, MIME mismatch, decode failure, oversize file, replacement race, late result, partial copy cleanup, existing identical destination, and image/video event selection. Assert Storyteller clients are never constructed.

- [ ] **Step 2: Verify red**

```bash
cargo test -p artcraft meshfleet_media::materialize
cargo test -p artcraft meshfleet_media::complete
```

- [ ] **Step 3: Implement content-copy and atomic settlement**

Ask the bridge's fixed `artifacts materialize` command to materialize an admitted artifact by handle for the registered `artcraft` consumer into a service-owned staging directory. Open without following symlinks where supported, hash exact bytes, validate declared MIME and media decode, fsync, rename atomically into the ArtCraft data directory, then settle the row and emit the existing `TextToImageGenerationCompleteEvent` or `VideoGenerationCompleteEvent`. Do not require a batch token, customer session, gallery expansion, or upload.

- [ ] **Step 4: Run focused and Grok regression tests**

```bash
cargo test -p artcraft meshfleet_media
cargo test -p artcraft grok_image
cargo test -p artcraft grok_video
```

Expected: local completion passes; existing Grok behavior is unchanged.

- [ ] **Step 5: Commit**

```bash
git add crates/desktop/artcraft/src/services/meshfleet_media
git commit -m "feat(artcraft): commit local MeshFleet artifacts atomically"
```

### Task 6: Active feed integration

**Files:**
- Create: `frontend/apps/artcraft/app/src/components/generation-feed/useMeshfleetMediaJobs.ts`
- Create: `frontend/apps/artcraft/test/app/components/generation-feed/useMeshfleetMediaJobs.test.tsx`
- Modify: `frontend/apps/artcraft/app/src/components/generation-feed/useDesktopGenerationFeed.ts`
- Modify: `frontend/libs/tauri-api/src/lib/meshfleet/MeshfleetMedia.ts`

**Interfaces:**
- Consumes: dedicated MeshFleet list/status command plus existing typed completion events.
- Produces: feed items for queued, processing, review-required, failed, unknown, cancelling, cancelled, and locally complete states.

- [ ] **Step 1: Write failing hook tests**

Mock both existing task queue and MeshFleet job listing. Prove jobs appear after restart, deduplicate by local job ID, do not disappear when no completion event arrives, and complete only when the event points to an ArtCraft-owned path. Worker election and queue-drain assertions remain backend/Core tests; the React hook never starts a process.

- [ ] **Step 2: Verify red**

```bash
cd frontend
npm run --workspace=artcraft test -- --runInBand test/app/components/generation-feed/useMeshfleetMediaJobs.test.tsx
```

- [ ] **Step 3: Implement additive feed composition**

Keep `GetTaskQueue` and the existing event listeners. Fetch the dedicated local jobs alongside them, project stable status text, merge without pretending they have a `GenerationProvider`, and reuse the existing gallery item/action shape.

- [ ] **Step 4: Run focused tests and typecheck**

```bash
cd frontend
npm run --workspace=artcraft test -- --runInBand test/app/components/generation-feed
npm run --workspace=artcraft typecheck
```

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/artcraft/app/src/components/generation-feed frontend/apps/artcraft/test/app/components/generation-feed frontend/libs/tauri-api/src/lib/meshfleet
git commit -m "feat(artcraft): feed MeshFleet jobs into desktop generation"
```

### Task 7: Local Media plan-confirm UI and readiness remediation

**Files:**
- Create: `frontend/apps/artcraft/app/src/components/meshfleet-media/LocalMediaPanel.tsx`
- Create: `frontend/apps/artcraft/test/app/components/meshfleet-media/LocalMediaPanel.test.tsx`
- Create: `frontend/apps/artcraft/app/src/components/meshfleet-media/meshfleetMediaStore.ts`
- Modify: `frontend/apps/artcraft/app/src/pages/PageImage/TextToImage.tsx`
- Modify: `frontend/apps/artcraft/app/src/pages/PageVideo/ImageToVideo.tsx`

**Interfaces:**
- Consumes: Tauri wrapper functions and capability/quote/route contracts.
- Produces: an explicit “Local Media via MeshFleet” panel for image generation and image-to-video.

- [ ] **Step 1: Write failing UI tests**

Cover readiness loading/error, no dispatchable capability, measured/unmeasured/unknown quote evidence, requested versus actual route, plan preview, exact confirmation, double-click suppression, failure recovery, review-required state, empty Grok auth admission, and refusal to construct image-to-video intent from a remote URL or local path without a retained MeshFleet artifact handle:

```tsx
expect(screen.queryByRole("button", { name: /log in to grok/i })).toBeNull();
expect(screen.getByText("Configured, not verified")).toBeVisible();
expect(screen.getByText(/no provider call has been made/i)).toBeVisible();
```

- [ ] **Step 2: Verify red**

```bash
cd frontend
npm run --workspace=artcraft test -- --runInBand test/app/components/meshfleet-media/LocalMediaPanel.test.tsx
```

- [ ] **Step 3: Implement the two-step UI**

The first action creates a plan only. Render the immutable quote, capability readiness, route request, and budget evidence. The second, visually distinct action confirms that exact `plan_id`. On success, append the durable local job to the active feed. Do not write to `TextToImageStore` or `ImageToVideoStore` as the only source of truth.

- [ ] **Step 4: Run frontend gates**

```bash
cd frontend
npm run --workspace=artcraft test -- --runInBand test/app/components/meshfleet-media test/app/components/generation-feed
npm run --workspace=artcraft typecheck
npm run --workspace=artcraft build
```

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/artcraft/app/src/components/meshfleet-media frontend/apps/artcraft/test/app/components/meshfleet-media frontend/apps/artcraft/app/src/pages/PageImage/TextToImage.tsx frontend/apps/artcraft/app/src/pages/PageVideo/ImageToVideo.tsx
git commit -m "feat(artcraft): add Local Media via MeshFleet workflow"
```

### Task 8: Full offline verification and factual handoff

**Files:**
- Create: `docs/ops/MESHFLEET-MEDIA-CLIENT-HANDOFF.md`

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: exact local evidence and remaining authority gates.

- [ ] **Step 1: Run all repository gates**

```bash
cargo test -p sqlite_tasks
cargo test -p artcraft --lib
cargo check -p artcraft
cd frontend
npm run --workspace=artcraft test -- --runInBand
npm run --workspace=artcraft typecheck
npm run --workspace=artcraft build
```

Run the documented private macOS production bundle without reinstalling dependencies:

```bash
cd frontend
VITE_ENVIRONMENT_TYPE=production npx nx build artcraft --skip-nx-cache
cd ../crates/desktop/artcraft
SQLX_OFFLINE=true cargo tauri build --config tauri.conf.json
```

Expected bundle: `target/release/bundle/macos/ArtCraft.app`. If dependencies are absent, record the install gate instead of running `npm install` without separate authorization.

- [ ] **Step 2: Run no-listener and secret checks**

Use the fake bridge black-box fixture. Prove no TCP/SSE listener is opened, no Storyteller upload is attempted, creative inputs appear only in stdin, and sentinel secrets do not appear in argv, environment snapshots, logs, SQLite, Tauri responses, or committed artifacts.

- [ ] **Step 3: Inspect compatibility**

```bash
git diff --check
git diff --stat
git diff -- frontend/libs/api-enums/src/lib/common/generation_provider.ts
```

Expected: clean diff check and no change to the provider enum.

- [ ] **Step 4: Obtain independent review**

Run specification-compliance review first, then code-quality review. A reviewer must explicitly inspect restart uncertainty, authority opacity, task/feed durability, artifact copying, and the disabled Grok login state.

- [ ] **Step 5: Write and commit the handoff**

Record branch/base/head, focused and full test outputs, build result, fake bridge version, provider calls `none`, uploads `none`, and remaining merge/push/provider-probe/spend/install/deploy gates.

```bash
git add docs/ops/MESHFLEET-MEDIA-CLIENT-HANDOFF.md
git commit -m "docs: hand off ArtCraft MeshFleet media client"
```
