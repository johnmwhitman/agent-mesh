---
name: meshfleet
description: Activate autonomous MeshFleet development — cold-start, orient, orchestrate fleet, iterate. One command to start building.
triggers:
  - meshfleet
  - autonomous
  - keep going
  - build meshfleet
  - start building
  - iterate
---

# /meshfleet — autonomous development with fleet orchestration

One command activates the full loop. No pasting prompts, no setup ceremony.

## What it does

1. **Cold start** — read HANDOFF.md, verify suite/conformance/git state
2. **Orient** — identify the highest-value next slice from the done-test queue
3. **Orchestrate** — dispatch bulk work to the fleet before doing anything yourself
4. **Build** — implement, test, commit, push
5. **Iterate** — pick the next slice, repeat until context fills
6. **Hand off** — emit a /handoff prompt before stopping so the next session continues

## Activation

When this skill is invoked, follow these instructions exactly:

### Step 1: Cold start (do this EVERY time, even back-to-back)

```
cd ~/AI/agent-mesh
cat HANDOFF.md                    # ground truth — read the CONTENT
git log --oneline -1              # verify commit matches HANDOFF
npm test 2>&1 | tail -8           # must show 0 fail
git branch                        # should be main only
git stash list                    # check for WIP from prior sessions
```

If the suite is red, fix it before anything else. If there's a stash, evaluate
whether to pop or drop it (read its description).

### Step 2: Orient — pick the next done-test

Read HANDOFF.md's "What to build next" section. Pick the first non-struck item.
Name it explicitly: "Starting done-test N: [description]."

The rolling done-test queue (update HANDOFF.md as items complete):

1. Discussion witness deeper expansion (fork, discontinuity, three-turn, fuzz)
2. Discussion MCP blackbox tests (ask_peer, wake_agent, reply_discussion, get_discussion)
3. New wire fault vectors (unique classifications only)
4. New capability (highest-value missing tool/feature from witness evidence)
5. meshfleet-app: surface A2A coverage and falsification corpus on the docs page
6. meshfleet-app stays in sync after any tool/test count change

If the queue is empty, run a rotating adversarial lens:
- Point it at assumptions, definitions, or instruments — not just code
- Rotate the target each pass (don't audit the same thing twice)
- An empty queue post-lens is a SUCCESS — state it plainly, don't invent busywork

### Step 3: Orchestrate — dispatch BEFORE doing

Check fleet budgets: `~/AI/Tools/fleetbudget`

Route by lane:
- `~/AI/Tools/grk "..."` — adversarial review, evaluator drafts, second opinions (unlimited)
- `~/AI/Tools/mmx "..."` — bulk text, corpus generation, Python evaluators (cheap)
- `~/AI/Tools/cdx "..."` — final verdicts and merge-safety decisions (scalpel, not engine)
- `~/AI/Tools/agx "..."` — design review, UX judgment, long-context reading

**The red flag is "I'll just do this one myself."** If the task is bulk, dispatch it.
Claude context is for orchestration, synthesis, verification, and merge decisions.

Self-contained prompts — delegated models see NONE of your context. Inline the inputs.
Fleet output is a draft — verify before acting.

### Step 4: Build — implement, test, commit

- Push only when full suite passes
- Rebuild dist/ and re-pin conformance catalog after any inputSchema edit
- Probe live server for schema ground truth (never grep for discussion tool schemas)
- Every commit: `Co-Authored-By: Claude <model> <noreply@anthropic.com>`
- Every merge: `--no-ff` with summary

### Step 5: Iterate

After each done-test completes:
1. Update HANDOFF.md (commit + push)
2. Sync meshfleet-app if tool/test count changed
3. Pick the next done-test
4. Report: DID / VERIFIED / LEARNED / NEWLY QUEUED / BLOCKED / GOT WRONG

Never stop because a done-test is "finished" — pick the next one.

### Step 6: Hand off when context fills

Before stopping, emit a single paste-ready /goal prompt with:
- The current HANDOFF.md commit SHA
- Which done-test to START HERE
- What state the work is in (stashed? partially committed? clean?)

## Standing rules

- **npm publish — NEVER** (Tier C, John only)
- **No gates, deadlines, or kill codes** — build momentum, not ceremonies
- **Stay public** — the repo's credibility depends on inspectability
- **Salvage before discard** on any branch that appears
- **Fleet work must be bounded and merge within session** — no parking lanes
  (earned anti-pattern: 307 abandoned branches from long-lived fleet lanes)
- **No provider wrappers or catalogs in core** (standing repo policy)

## Scars (earned — do not ignore)

- **Probe, don't predict.** Wire fault classifications, MCP tool output shapes, and
  schema members all failed when predicted from names/docs. Probe the live server first.
- **Corpus vectors must use ops-from-baseline format.** Standalone fixture files fail the
  minimality check. Use `d-` prefixed IDs, the baseline's own agents.
- **Auto-conflict resolution is fragile.** Restore main + re-apply by hand.
- **Conformance manifest members must be probed from the live server.** Discussion tools
  register schemas in `src/discussion-mcp.ts`, not `src/index.ts`.
