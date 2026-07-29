# MeshFleet Media Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved MeshFleet media execution suite, then connect ArtCraft and Sprite Factory without weakening provider truth, authority, artifact, provenance, or review boundaries.

**Architecture:** The program is split into four repository-scoped plans. MeshFleet lands the closed contract, fake plane, durable service, and process boundary; the fleet Tools lane implements the shared machine wrapper protocol; MeshFleet then binds honest adapters and the CLI/MCP package surface. ArtCraft and Sprite Factory consume only committed versioned interfaces from isolated worktrees.

**Tech Stack:** Node.js 20+, TypeScript ES2022, `node:test`, better-sqlite3, MCP SDK 1.29.x, Rust/Tauri, React/TypeScript, Python 3.10+, Pillow, pytest.

## Global Constraints

- The approved design at `docs/superpowers/specs/2026-07-29-meshfleet-media-execution-design.md` is normative.
- Do not send a provider request, run a live readiness probe, consume quota, upload media, or expose creative inputs during offline implementation.
- Do not copy credentials into MeshFleet; preserve the existing credential owners.
- Do not use `spawn_fleet`, OpenCode agents, or a generic command runner as the media execution boundary.
- Do not add an unauthenticated TCP, SSE, or renderer-accessible listener.
- All first attempts, retries, provider changes, and readiness probes remain behind their approved authority types.
- Existing MeshFleet public behavior and the existing 36 MCP tools remain unchanged until the additive media registration task.
- ArtCraft does not add MeshFleet to `GenerationProvider`.
- Sprite Factory retains licensing, provenance, exact-byte review, deterministic completion, and engine-validation authority.
- Tests and receipts prove local behavior only; they do not authorize merge, push, install, provider execution, publication, or deployment.
- Each repository, including the portfolio root for `Tools/`, must use a fresh isolated worktree after recording an `OPERATOR-LOCK.md` row; never implement in the dirty primary checkouts.

---

## Plan set and dependency order

1. `docs/superpowers/plans/2026-07-29-meshfleet-media-core-and-providers.md`
   - Repository: `agent-mesh`
   - Phase A, Tasks 1–8 produce: `meshfleet.media-request.v1`, durable media storage/worker, authority, artifacts, fixed process protocol, and the fake-plane `meshfleet-media` CLI.
   - Phase B, Tasks 9–11 consume the wrapper commit and produce: provider registry/adapters, additive MCP tools, package/build compatibility, and review.
2. `docs/superpowers/plans/2026-07-29-fleet-media-machine-wrappers.md`
   - Repository: portfolio root `/Users/johnwhitman/AI`, bounded to `Tools/` plus its named handoff.
   - Consumes: MeshFleet Phase A adapter fixtures.
   - Produces: fixed stdin/NDJSON modes for PixelLab, Gemini/Imagen, Google audio, Codex image, and a fixed MiniMax MCP stdio bridge.
3. `docs/superpowers/plans/2026-07-29-artcraft-meshfleet-media-client.md`
   - Repository: `artcraft`
   - Consumes: the built `meshfleet-media` CLI and its contract fixtures.
   - Produces: local plan-confirm-submit, restart reconciliation, content-copy, truthful readiness UI, and active-feed completion.
4. `docs/superpowers/plans/2026-07-29-sprite-factory-meshfleet-intake.md`
   - Repository: `sprite-factory`
   - Consumes: admitted artifact and `sprite-factory.meshfleet-intake.v1` fixtures.
   - Produces: fail-closed intake, provenance binding, review-gated handoff, and existing engine validation.

Execute MeshFleet Tasks 1–8, then the fleet wrapper plan, then MeshFleet Tasks 9–11. ArtCraft and Sprite Factory may proceed in parallel only after the resulting CLI/package fixtures are committed. Provider activation remains a separate, explicitly authorized operation after all offline plans are green.

### Task 1: Reconcile moving repository tips before execution

**Files:**
- Reference: `docs/superpowers/specs/2026-07-29-meshfleet-media-execution-design.md`
- Reference: `/Users/johnwhitman/AI/OPERATOR-LOCK.md`

**Interfaces:**
- Consumes: approved design commit `4d20f3f416318f1d73d6e76da374da16feca3c1b`.
- Produces: four clean worktrees with recorded bases and no borrowed dirty bytes.

- [ ] **Step 1: Verify the planning branch and upstream drift**

Run:

```bash
git fetch origin
git log --oneline --left-right HEAD...origin/main
git status --short --branch
```

Expected: the design commit is present; any newer `origin/main` commits are named explicitly before rebasing or recreating an execution worktree.

- [ ] **Step 2: Inspect collision state**

Run:

```bash
~/AI/Tools/lock-triage
git -C /Users/johnwhitman/AI status --short --branch
git -C /Users/johnwhitman/AI/agent-mesh status --short --branch
git -C /Users/johnwhitman/AI/artcraft status --short --branch
git -C /Users/johnwhitman/AI/sprite-factory status --short --branch
```

Expected: dirty primary bytes remain in place and are not copied into the execution branches.

- [ ] **Step 3: Create exact isolated worktrees**

Use `superpowers:using-git-worktrees`, record one lock row per repository, and create branches with the `codex/` prefix from the exact approved bases. Create a portfolio-root worktree bounded to the named `Tools/` and handoff paths; do not borrow its dirty primary bytes. Do not reuse the current `/private/tmp/agent-mesh-codex-media-execution-suite-20260729` planning worktree for implementation if it cannot be cleanly reconciled with `origin/main`.

- [ ] **Step 4: Run repository baselines**

Run the baseline named at the start of each child plan. Record failures as pre-existing or repair blockers before implementing a task.

- [ ] **Step 5: Commit only reconciliation documentation if needed**

If the upstream reconciliation changes the approved spec or any task interface, stop and amend the design before implementation. Otherwise, make no program-level source commit.

### Task 2: Execute and review each repository plan

**Files:**
- Reference: the four child plans listed above.
- Create at release-quality gate: `docs/handoffs/MESHFLEET-MEDIA-EXECUTION-CURRENT.md`

**Interfaces:**
- Consumes: each child plan's committed output.
- Produces: one factual, local-only handoff with exact commit IDs, commands, pass/fail results, and remaining authority gates.

- [ ] **Step 1: Execute MeshFleet Phase A**

Execute Tasks 1–8 with a fresh subagent per task and run specification-compliance review before code-quality review. Commit the exact adapter fixtures before starting wrapper work.

- [ ] **Step 2: Execute wrapper protocol and MeshFleet Phase B**

Execute the fleet wrapper plan in its isolated portfolio-root worktree. Feed only the committed wrapper commit ID and protocol fixtures back to the MeshFleet worktree, then execute MeshFleet Tasks 9–11. No live readiness probe or provider call occurs.

- [ ] **Step 3: Execute consumer plans**

Run ArtCraft and Sprite Factory plans in parallel isolated worktrees. Cross-repository communication is limited to committed schema/fixture bytes and commit IDs.

- [ ] **Step 4: Run the combined offline gate**

Run:

```bash
npm run build
npm test
npm run typecheck
npm pack --dry-run
```

Then run the exact ArtCraft and Sprite Factory commands named in their plans.

Also run the exact Tools wrapper conformance commands named in its plan.

- [ ] **Step 5: Write the handoff**

The handoff must list:

```text
repository
branch
base commit
head commit
focused tests
full-suite tests
package/build evidence
provider calls performed: none
remaining gates: provider probe, spend, merge, push, install, publish, deploy
```

- [ ] **Step 6: Commit the handoff**

```bash
git add docs/handoffs/MESHFLEET-MEDIA-EXECUTION-CURRENT.md
git commit -m "docs: hand off MeshFleet media execution suite"
```
