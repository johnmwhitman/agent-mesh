# GOAL-PROMPT — operating law for this repo

Operate meshfleet autonomously. Keep it healthy and keep its claim true: **"Your agents did
the work. Prove it."** This repo is public; the npm package is `meshfleet`.

---

## 🔴 READ FIRST — this repo is PUBLIC

Kill bars, gate dates, unpushed-commit counts, local ledger paths, John's decision queue, and
fleet composition **must never be committed here.** They live in
the maintainer's PRIVATE operations journal, outside this repo. That journal is the lane's
real queue and boot state; this file deliberately does not name its path.

That file is the queue. This file is the law. Read both; write back to the queue, not to this.

This inverts the usual "state lives in the repo" invariant on purpose: the invariant exists so
knowledge survives the next turn, and a private file satisfies it. Committing gates to a public
repo would satisfy the letter and break the product. (A 2026-07-16 public-surface scrub already
had to remove exactly this class of material once; a 2026-07-23 doc shipped a live quota reading
and the operator's entire AI-subscription roster before being caught in review.)

## What "good" means, in priority order

1. **Nobody loses anything silently** — a message, a receipt, a vote, a capability, a ledger.
   Silent is the operative word: a loud failure is a bug, a silent one is a betrayal of the claim.
2. **The audit is true.** `verify_ledger` reporting `ok: true` about a ledger that contradicts
   itself is the worst defect this repo can ship. It has happened three times (a forged ack, a
   keyless receipt, a capability naming no agent) and each was found from the *outside*.
3. **The published contract is real.** A tool's `inputSchema`, its description, and its behaviour
   must be the same thing. Three tools have shipped promising what they did not do.
4. Everything else.

## The loop

**One item per iteration**, named against the priority list above before starting. If you cannot
say which of 1–4 it serves, it is not eligible.

**Cold start every iteration**, even back-to-back:
- date from two sources (`date`, and the last commit's timestamp)
- read file CONTENT, not just `git log`
- the private operations journal: its queue, its verified-state table, and its traps section —
  every trap there cost a wrong answer before it was written down
- the operator lock file (a row older than 4h is stale)
- `git fetch` FIRST — the local `main` ref going stale made every ahead/behind figure in the
  queue wrong for an entire session

**End every iteration with:** a queue write-back (§6 + §7 + a §9 line), a commit whose message is
a receipt, and a green verifier. A run that changes the repo but not the queue has failed, however
green its tests.

## The verifier — the only definition of green

```
npm run typecheck && npm run build && node scripts/run-tests.mjs
```

**Build BEFORE test.** `mcp-stdio.test.ts` packs this package and asserts the tarball contains
`dist/index.js`. `release.yml` lacked that step, so the release job could not pass on any runner
and **the publish path could never have shipped** — undetected because no release had ever been
cut through it (fixed 2026-07-23).

## 🔴 Isolation law — violating this destroys the operator's data

Any run that spawns the server or opens a ledger sets **BOTH**:

```
MESHFLEET_DB_FILE=<temp>   MESHFLEET_DATA_FILE=<temp>
```

`MESHFLEET_DB_FILE` alone is **NOT** isolation. The two paths resolve from independent overrides,
and the startup migrator pairs a redirected destination with a defaulted source — so a "sandboxed"
run imports the operator's real JSON ledger into the temp db and **renames the real file**. This
ate the live ledger twice on 2026-07-23, once from a test written to verify the isolation guard.

Never write to `~/.config/opencode/` — it is shared live state that Codex and Antigravity read,
and the harness classifier blocks it anyway. Audit it read-only via `readLedgerFile()`, which
works on a private temp copy by construction.

## Rotating adversarial lens (when the queue looks empty)

Rotate the target each pass; point it at assumptions and instruments, not just code.

1. **Contract** — pick tools that have never been driven over real MCP stdio with their *published*
   field names, including violations (omit a required field, send the wrong type). The SDK enforces
   neither `required` nor `type`, and `toolHandlers` is typed `(args: any)`.
2. **The audit's blind spots** — construct a ledger that lies in a way `verify_ledger` does not yet
   check, then decide whether it should. Fixing a writer does nothing for a ledger that already
   holds the bad row, which is exactly what the audit is for.
3. **Guards that cannot see their own source** — this repo has been bitten three times: a flat test
   runner that never ran `test/config/` (including a secret-rejection suite), a check-id enumerator
   whose regex missed multi-line calls, and a regression test that passed *with* the bug present.
   Ask of every guard: what can it not see? Then prove the answer.
4. **Claims** — README, tool descriptions, CHANGELOG, `--explain` text, the site. Does the artifact
   do what the sentence says? Free tier is UNSIGNED consistency checking; it must never imply
   tamper-evidence.
5. **Failure modes under real conditions** — two instances sharing a ledger, a taken port, a slow
   consumer, a killed process mid-write.

Only after a lens pass may you call the queue empty — and an **empty queue is a success to state
plainly**, never busywork to paper over. This product's constraint is demand, not commits.

## Standards

- **Fleet output is a draft.** Verify every claim yourself against source before acting. Models
  have fabricated a test directory, a config suite, and product facts in copy. Six models agreeing
  on something *you* asserted in the brief is an echo, not corroboration.
- **A guard you have not watched fail is decoration.** New regression tests get proven
  red-on-revert. Where the failure mode is destructive (it would eat a real ledger), say so
  explicitly in the test header instead of running it — and make the assertion pin something only
  the fix can produce.
- **Two failed blind fixes → instrument, never a third.**
- **Verification before completion**: "deployed" ≠ "committed"; "published" is what the registry
  says, not what the publish command printed.
- **When two reviewers contradict each other**, check whether they are describing different *sides*
  of one seam before picking a winner. On 2026-07-23 one demanded path-inequality and the other
  override-presence; each was right about a different half, and either verdict alone shipped a bug.

## Hard gates — John only, never inferred

- **npm credentials and publishing.** Token creation needs his npmjs.com login; publish needs his
  2FA. A publish `E404` on `PUT /meshfleet` means **NOT LOGGED IN** — npm reports failed publish
  auth as 404, not 401. **Check `npm whoami` FIRST** before diagnosing token scope; getting this
  backwards cost two wasted token round-trips.
- **Mutating the live ledger** at `~/.config/opencode/` (also classifier-blocked).
- Real-money spend · John-identity output · destructive ops · new prod infra.
- **Anything that loosens a gate.** Tightening is in-authority; loosening never is. Flag any change
  that moves a measured number in the flattering direction — including making `verify_ledger`
  quieter. A finding downgraded to keep a pipeline green is the failure this product exists to
  prevent.

## Concurrency

Other sessions work this repo. One held `feat/verify-states-its-scope` and checked it out *under*
this session mid-run. Take an operator-lock row before repo work; work `main` or your own branch; never absorb another session's unattributed commit. Multi-commit work goes in a dedicated worktree,
not a temp dir (a worktree has no `node_modules` — symlink it, and make sure the
symlink is ignored, not committed).

## Report — ≤10 lines per iteration

did / verified (not believed) / newly queued / blocked on John / got wrong.

The "got wrong" line is not optional. Every genuinely useful iteration in this lane's history has
had one.

## Stop when

- all remaining work is John-gated
- two consecutive iterations fail
- a fabrication reached published output
- you cannot say why the current task matters
- the queue is truly empty after a lens pass — say so plainly and stop
