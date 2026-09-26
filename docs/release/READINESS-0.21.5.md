# Release readiness: `meshfleet` 0.21.5 vs. npm 0.21.1

Prepared 2026-09-26 by an automated readiness sweep. Read-only: no publish,
no merge, no PR branch was touched. Every number below carries the exact
command that produced it — re-run any of them to check this doc for drift.

## 1. The gap (positive control)

```
$ git log -1 --oneline origin/main
b3fc42c Stop retrying deterministic runtime contract failures (#196)

$ npm view meshfleet version
0.21.1

$ grep -m1 '"version"' package.json     # on origin/main
  "version": "0.21.5",
```

- **npm's published `meshfleet` is `0.21.1`.**
- **`package.json` on `origin/main` says `0.21.5`.**
- There *is* a `v0.21.5` git tag, but it is **not** current `origin/main` HEAD —
  it sits 11 commits behind:

  ```
  $ git log --oneline v0.21.5..origin/main
  b3fc42c Stop retrying deterministic runtime contract failures (#196)
  975eca6 feat(runtime): add explicit Grok text adapter (#195)
  45ff3d9 feat: add opt-in compact MCP catalog (#194)
  2d26971 fix: refresh patched transitive dependencies
  65ee2ee docs: pin HANDOFF suite baseline to the measured 1918 tests
  cf904f7 fix: ship one spawn path; gate durable/shadow as unfinished
  8ea61e9 Stop teaching bare npx agent-mesh on first-use paths.
  3969eab VERIFIED: unique 0.21.5 isolated identity ...
  2e02810 VERIFIED: chaos-durability race/provenance hardening ...
  08eac1e VERIFIED: chaos-durability — orphaned workers survive ...
  ed8f394 VERIFIED: unique 0.21.4 portable identity ...
  ```
  (11 commits; `3969eab`/`2e02810`/`08eac1e`/`ed8f394` are the tail of the
  0.21.4/0.21.5 work itself, the top 7 are genuinely new: Grok adapter,
  opt-in compact catalog, a dependency refresh, a HANDOFF count bump, the
  "one shipped spawn path" lifecycle change, and a first-use docs fix.)

  So `package.json` reading `0.21.5` is **itself stale** — it hasn't been
  bumped since the `v0.21.5` tag even though 7 substantive commits landed
  after it. There is no "0.21.6" (or similar) version anywhere in the repo.
  **No open PR bumps the version.** This is the first item on the checklist
  below.

- No git tag is missing a source explanation for the 0.21.1→0.21.5 gap:
  `CHANGELOG.md` documents `0.21.2` (2026-09-06) and `0.21.5` (2026-09-14)
  fully, and folds `0.21.3`/`0.21.4` in as nested sub-sections under the
  `0.21.5` entry. Its own `[Unreleased]` section (sitting, oddly, *between*
  the `0.21.2` and `0.21.5` entries in file order — a documentation nit)
  already drafts 2 of the 7 new post-tag commits (the compact catalog and
  the "one shipped spawn path" change) but **omits** the Grok adapter
  (#195), the dependency refresh, the HANDOFF count bump, and the
  `#196` retry-contract fix. See §4 for a complete draft.

## 2. `npm pack` audit — what would actually ship

```
$ npm ci && npm run build && npm pack --dry-run
```

Building from a clean `npm ci` is required first: this checkout ships no
`node_modules`/`dist`, and a bare `npx tsc` on this image silently resolves
to a global TypeScript 6.0.2 (not the pinned `^5.0.0` in `package.json`),
which then fails on `tsconfig.json`'s `moduleResolution: node` as a hard
`TS5107` error. That is an environment artifact of this sweep, not a defect
in the repo — `npm ci` installs the correct local TypeScript 5.9.3 and the
build is clean. Flagging it here only so a future release run doesn't
mistake it for a real build break.

**Files that would ship (`package.json` `"files"` allowlist):**
```
dist, mcp.json, README.md, LICENSE, AGENT-MESH-SPEC.md, SPEC-P2P.md, SPEC-COUNCILS.md
```

**Flag — `dist/` ships its own test suite and duplicate output.** With a real
build, `npm pack --dry-run` reports **365 files / 4.7 MB unpacked** (vs. 7
files / 64 kB with no `dist`). Of those 365 files:

```
$ npm pack --dry-run --json | node -e "..." # counts below
- 197 files under dist/test/  (the entire compiled test suite)
- 80 files under dist/src/    (every src file compiled a second time,
                                alongside its dist/<name>.js original)
```

Root cause: `tsconfig.test.json` sets `"rootDir": "."` and
`"include": ["src/**/*", "test/**/*"]`, so `npm run build`'s second `tsc`
pass (`tsc -p tsconfig.test.json`) re-emits every `src/*.ts` file a second
time (now under `dist/src/`, because rootDir moved) and additionally emits
the whole `test/` directory into `dist/test/`. `package.json`'s `"files"`
allowlist includes all of `dist` with no exclusion, so all of this ships.

**This is pre-existing, not a regression** — verified by pulling the actual
published tarball:
```
$ npm pack meshfleet@0.21.1   # downloads the real published tgz
$ tar tzf meshfleet-0.21.1.tgz | wc -l         # 344
$ tar tzf meshfleet-0.21.1.tgz | grep -c test/  # 181
```
0.21.1 already ships the same test bloat and duplicate `dist/src/*`. It is
not a 0.21.5 blocker, but it is a real correctness/hygiene issue worth
fixing before a Show HN invites people to look closely at the package
contents (`npm view meshfleet dist` / unpacking the tarball is a common
first move). No open PR touches this.

**No personal names, emails, local paths, or `.env`-like files ship.**
Checked the seven top-level shipped docs (`README.md`, `AGENT-MESH-SPEC.md`,
`SPEC-P2P.md`, `SPEC-COUNCILS.md`, `LICENSE`, `mcp.json`, `package.json`)
with:
```
$ grep -rnE "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}" <those files>   # no matches
$ grep -rnE "/home/[a-zA-Z0-9_-]+|/Users/[a-zA-Z0-9_-]+" <those files>       # no matches
```
Did not re-scan the 350 `dist/**` files individually (they're a 1:1
transpile of `src/`/`test/`, already source-reviewed on GitHub) beyond the
grep above, which does cover the always-shipped docs.

**Repo-hygiene note (not a packaging issue, since these paths are outside
`"files"` and don't ship):** open PR #192 removes a committed `.scratch/`
probe file, a 1.1 MB duplicate corpus fixture, and one-off health-check
JSON dumps from the *repository* (not the npm package). Doesn't affect the
tarball, but affects what a Show HN visitor sees browsing the GitHub repo.
See §5.

## 3. README vs. the actual MCP tool registry

```
$ awk '/server.setRequestHandler\(ListToolsRequestSchema/,0' src/index.ts \
    | grep -c '^\s*name: "'
40
```
`README.md` claims: *"Default stdio `tools/list` remains the compatible
**40-tool** catalog. Set `MESHFLEET_COMPACT_CATALOG=1` to advertise a
**36-tool** compact catalog... Within compact mode,
`MESHFLEET_ROUTE_ADVISOR=1` restores the three advisory tools for a
**39-tool** catalog."`

Verified directly against `src/index.ts`:
- 40 tools are registered (`grep` above).
- `toolAdvertised()` (src/index.ts:177-184) filters by
  `MESHFLEET_COMPACT_CATALOG` and, within compact mode, by
  `MESHFLEET_ROUTE_ADVISOR`, dropping exactly
  `ADVISORY_ROUTE_TOOL_NAMES` = `{compile_route_candidates,
  plan_speculative_backlog, recommend_route}` (3 tools) and
  `DEPRECATED_DEFAULT_CATALOG_TOOL_NAMES` = `{verify_ledger_v2}` (1 tool)
  when compact and not route-advisor-restored → 40 − 4 = **36**; with the
  advisor restored → 40 − 1 = **39**.

**The README's tool-count claims are accurate against source.** No
discrepancy found here.

Quickstart commands in the README (`npx -y --package=meshfleet -- agent-mesh
...`, `mcp.json`'s `npx -y meshfleet`) match `package.json`'s `"bin"` map
(`meshfleet` → `dist/bin/meshfleet.js`) and the `0.21.2` CHANGELOG fix that
retired the squatted-`agent-mesh`-placeholder bug. No discrepancy found.

## 4. CHANGELOG draft, 0.21.2 → next

Range used: **`v0.21.1..origin/main`** (`git log v0.21.1..origin/main` = 84
commits). `v0.21.1` is the git tag matching the currently-published npm
version (confirmed: `git merge-base --is-ancestor v0.21.1 origin/main` →
true; its dereferenced commit is `200802e`, the last commit that bumped
`package.json` to `0.21.1`). There is no earlier commit closer to npm's
published state, and no better range exists: the repo *is* fully
unshallowed in this checkout (`git rev-parse --is-shallow-repository` →
`false`) and all of `v0.21.0`–`v0.21.3`/`v0.21.5` are real, ancestor tags
(there is no `v0.21.4` tag; that release was explicitly marked "not a tag"
in its own CHANGELOG entry).

`CHANGELOG.md` already carries hand-written entries for `0.21.2` and
`0.21.5` (with `0.21.3`/`0.21.4` nested inside the `0.21.5` entry). The only
**undocumented** slice is the 7 substantive commits after the `v0.21.5` tag
(§1). Draft entry to append (version number is the maintainer's call —
`0.21.6` is used here only as a placeholder since `0.21.5` is already
spoken for by the tag):

```markdown
## [0.21.6] - unreleased

### Added
- `feat(runtime): add explicit Grok text adapter` (#195).
- Opt-in compact MCP catalog: `MESHFLEET_COMPACT_CATALOG=1` advertises the
  36-tool catalog (`MESHFLEET_ROUTE_ADVISOR=1` restores the 3 advisory
  tools for 39); default stdio `tools/list` is unchanged at 40 (#194).

### Changed
- One shipped fleet-spawn path: new fleets use the in-memory coordinator.
  Durable/shadow lifecycle modes are gated behind
  `MESHFLEET_UNFINISHED_LIFECYCLE_MODE`; `MESHFLEET_LIFECYCLE_MODE` is no
  longer a public three-mode switch. No behavior change for existing
  in-memory users.
- First-use docs/examples no longer teach bare `npx agent-mesh` (squatted
  placeholder risk); all point at `npx -y --package=meshfleet -- agent-mesh`.
- Deterministic runtime contract failures are no longer retried (#196).

### Fixed
- Refreshed patched transitive dependencies.

### Internal
- HANDOFF.md suite baseline pinned to the measured 1918-test count.
```

This is a draft for the maintainer to edit, not a claim that it's final —
commit subjects were used verbatim where they were already changelog-grade;
the two `feat`/opt-in-catalog bullets duplicate what `[Unreleased]` already
had, extended with the 4 items that section was missing.

## 5. Open PR triage (39 open, all from the owner)

```
$ gh api / mcp__github__list_pull_requests  state=open, base=main → 39 results
```
For each: head SHA + CI conclusion via `get_check_runs` on that exact head;
merge-cleanliness via `git merge-tree --write-tree origin/main <head>` (repo
fully unshallowed first — a shallow merge-tree falsely reports "refusing to
merge unrelated histories" for every PR); files touched via
`git diff --name-only <merge-base> <head>`. No PR branch was pushed to,
rebased, or merged.

| PR | Title | Head SHA | CI (Node 20/22/24) | Merges clean onto main? | Files touched | Class |
|---|---|---|---|---|---|---|
| #192 | Drop committed leftovers: .scratch probe, 1.1MB corpus twin, one-off health dumps | `6a972e65` | SUCCESS | Yes | 8 files | **SAFE-TO-LAND** |
| #190 | Shrink default MCP tools/list catalog to 36 core tools | `9bf9349c` | SUCCESS | No (conflict) | 13 files | **STALE** |
| #188 | VERIFIED: verify_ledger_v2 MCP stdio contract pin (fresh, no conflicts) | `e0ee6063` | FAILURE | Yes | test/verify-ledger-v2-mcp-contract.test.ts | **NEEDS-OWNER** |
| #186 | VERIFIED: spawn_from_template MCP stdio contract pin | `6a43d6e9` | SUCCESS | No (conflict) | HANDOFF.md, test/spawn-from-template-mcp-contract.test.ts | **NEEDS-OWNER** |
| #185 | VERIFIED: record_routing_outcome MCP stdio contract pin | `c8917583` | FAILURE | Yes | test/record-routing-outcome-mcp-contract.test.ts | **NEEDS-OWNER** |
| #184 | VERIFIED: wake_agent MCP stdio contract pin | `19838cb3` | FAILURE | Yes | test/wake-agent-mcp-contract.test.ts | **NEEDS-OWNER** |
| #183 | VERIFIED: verify_ledger_v3 MCP stdio honesty-pattern pin | `c3a2be03` | FAILURE | Yes | test/verify-ledger-v3-honesty-mcp-contract.test.ts | **NEEDS-OWNER** |
| #182 | VERIFIED: verify_ledger MCP stdio contract pin | `db82f37f` | FAILURE | Yes | test/verify-ledger-mcp-contract.test.ts | **NEEDS-OWNER** |
| #181 | VERIFIED: tally_ratification MCP stdio honesty-pattern pin | `26275fed` | FAILURE | Yes | test/tally-ratification-mcp-contract.test.ts | **NEEDS-OWNER** |
| #180 | VERIFIED: sweep_ratifications MCP stdio honesty-pattern pin | `02490c04` | FAILURE | Yes | test/sweep-ratifications-mcp-contract.test.ts | **NEEDS-OWNER** |
| #179 | VERIFIED: subscribe_inbox MCP stdio contract pin | `cfb4633d` | FAILURE | Yes | test/subscribe-inbox-mcp-contract.test.ts | **NEEDS-OWNER** |
| #178 | VERIFIED: subscribe_events MCP stdio contract pin | `f51929e4` | FAILURE | Yes | test/subscribe-events-mcp-contract.test.ts | **NEEDS-OWNER** |
| #177 | VERIFIED: spawn_fleet MCP stdio honesty-pattern pin | `029adaeb` | FAILURE | Yes | test/spawn-fleet-mcp-contract.test.ts | **NEEDS-OWNER** |
| #176 | VERIFIED: set_fleet_timeout MCP stdio honesty-pattern pin | `88a7ddf9` | FAILURE | Yes | test/set-fleet-timeout-mcp-contract.test.ts | **NEEDS-OWNER** |
| #175 | VERIFIED: send_messages MCP stdio pin | `d3ed4c6f` | FAILURE | Yes | test/send-messages-mcp-contract.test.ts | **NEEDS-OWNER** |
| #174 | VERIFIED: send_message MCP stdio contract pin | `4bda7127` | FAILURE | Yes | test/send-message-mcp-contract.test.ts | **NEEDS-OWNER** |
| #173 | VERIFIED: save_fleet_template MCP stdio contract pin | `387e8e35` | FAILURE | Yes | test/save-fleet-template-mcp-contract.test.ts | **NEEDS-OWNER** |
| #172 | VERIFIED: route_work MCP stdio honesty-pattern pin | `692b517e` | FAILURE | Yes | test/route-work-mcp-contract.test.ts | **NEEDS-OWNER** |
| #171 | VERIFIED: reply_discussion MCP stdio contract pin | `afcc3651` | FAILURE | Yes | test/reply-discussion-mcp-contract.test.ts | **NEEDS-OWNER** |
| #170 | VERIFIED: register_capability MCP stdio honesty-pattern pin | `4e963633` | FAILURE | Yes | test/register-capability-mcp-contract.test.ts | **NEEDS-OWNER** |
| #169 | VERIFIED: receipt MCP stdio honesty-pattern pin | `8303ecf6` | FAILURE | Yes | test/receipt-mcp-contract.test.ts | **NEEDS-OWNER** |
| #168 | VERIFIED: plan_speculative_backlog MCP stdio contract pin | `1c865863` | FAILURE | Yes | test/plan-speculative-backlog-mcp-contract.test.ts | **NEEDS-OWNER** |
| #167 | VERIFIED: ping MCP stdio contract pin | `1b99096a` | FAILURE | Yes | test/ping-mcp-contract.test.ts | **NEEDS-OWNER** |
| #166 | VERIFIED: open_ratification MCP stdio honesty-pattern pin | `26bda435` | FAILURE | Yes | test/open-ratification-mcp-contract.test.ts | **NEEDS-OWNER** |
| #165 | VERIFIED: list_fleet_templates MCP stdio contract pin | `f180e255` | FAILURE | Yes | test/list-fleet-templates-mcp-contract.test.ts | **NEEDS-OWNER** |
| #164 | VERIFIED: list_agents MCP stdio contract pin | `64722bb7` | FAILURE | Yes | test/list-agents-mcp-contract.test.ts | **NEEDS-OWNER** |
| #163 | VERIFIED: get_receipts MCP stdio contract pin | `0f4996c3` | FAILURE | Yes | test/get-receipts-mcp-contract.test.ts | **NEEDS-OWNER** |
| #162 | VERIFIED: get_inbox MCP stdio contract pin | `5f076574` | FAILURE | Yes | test/get-inbox-mcp-contract.test.ts | **NEEDS-OWNER** |
| #161 | VERIFIED: get_discussion MCP stdio contract pin | `04d1ed04` | FAILURE | Yes | test/get-discussion-mcp-contract.test.ts | **NEEDS-OWNER** |
| #160 | VERIFIED: compile_route_candidates MCP stdio contract pin | `f5939908` | FAILURE | Yes | test/compile-route-candidates-mcp-contract.test.ts | **NEEDS-OWNER** |
| #159 | VERIFIED: collect_results MCP stdio contract pin | `3b056f48` | FAILURE | Yes | test/collect-results-mcp-contract.test.ts | **NEEDS-OWNER** |
| #158 | VERIFIED: cast_vote MCP stdio honesty-pattern pin | `69787c62` | FAILURE | Yes | test/cast-vote-mcp-contract.test.ts | **NEEDS-OWNER** |
| #157 | VERIFIED: ask_peer MCP stdio contract pin | `b464cdf6` | FAILURE | Yes | test/ask-peer-mcp-contract.test.ts | **NEEDS-OWNER** |
| #156 | VERIFIED: attach_agent MCP stdio contract pin | `431fdfc1` | FAILURE | Yes | test/attach-agent-mcp-contract.test.ts | **NEEDS-OWNER** |
| #155 | VERIFIED: ack_message MCP stdio honesty-pattern pin | `de03d890` | FAILURE | Yes | test/ack-message-honesty-mcp-contract.test.ts | **NEEDS-OWNER** |
| #154 | list_fleets MCP stdio contract pin | `f29754ac` | FAILURE | Yes | test/list-fleets-mcp-contract.test.ts | **NEEDS-OWNER** |
| #153 | get_health MCP stdio contract pin | `5ab353d1` | FAILURE | Yes | test/get-health-mcp-contract.test.ts | **NEEDS-OWNER** |
| #152 | fleet_status MCP stdio contract pin | `9989a786` | FAILURE | Yes | test/fleet-status-mcp-contract.test.ts | **NEEDS-OWNER** |
| #151 | recommend_route MCP stdio contract pin | `6732da62` | FAILURE | Yes | test/recommend-route-mcp-contract.test.ts | **NEEDS-OWNER** |

**Class counts: 1 SAFE-TO-LAND, 1 STALE, 37 NEEDS-OWNER, 0 RELEASE-BLOCKER.**

### Why 0 RELEASE-BLOCKER

None of the 39 open PRs touch the actual gap identified in §1 (the version
number) or the packaging bug in §2 (test bloat in `dist/`). Landing every
open PR today would not by itself make `0.21.5` (or whatever version comes
next) publishable and honest — that requires the checklist in §6
regardless of PR state.

### The 37-PR "NEEDS-OWNER" family — one root cause

36 of the 37 are single-file "VERIFIED: `<tool>` MCP stdio contract pin"
PRs (#151–#188, minus #186 and #190), each adding exactly one new
`test/*-mcp-contract.test.ts` file, all forked from the same base commit
`8433dcb8` (dated 2026-09-06; the PRs themselves were opened 2026-09-12).
All 36 fail CI identically on Node 20/22/24 (the
`copilot-pull-request-reviewer` check passes on all of them). Root cause,
read directly from a failing job's log (PR #170, run `34716272095`, job
`103613973993`):

```
# tests 1816
# pass 1816
# fail 0
Published baseline is stale.
  HANDOFF.md publishes: 1809/1809 tests
  This run measured:    1816 collected, 1816 passing, 0 failing, 0 skipped
Update HANDOFF.md to the MEASURED figure. ...
##[error]Process completed with exit code 1.
```

**Every test in every one of these 36 PRs actually passes.** The CI failure
is `scripts/run-tests.mjs`'s self-consistency guard (documented in
`HANDOFF.md` itself: *"fails if this line disagrees with it"*) tripping
because each PR adds one new test without bumping `HANDOFF.md`'s published
count, compounded by the branches being 28 commits / ~18 days behind
current `origin/main` (`git log --oneline 8433dcb8..origin/main`; main's
own count has since moved from 1809 past 1918 — see §4). `git merge-tree`
reports these 36 as clean (no textual
conflict), so a rebase + one-line `HANDOFF.md` bump would very likely turn
each one green individually. Whether to do that 36 times, squash them into
one contract-pin sweep, or abandon them in favor of a fresh pass against
current `main` is a process call outside this doc's scope — hence
NEEDS-OWNER rather than SAFE-TO-LAND or STALE.

#188 (`verify_ledger_v2` contract pin) shares the identical failure and is
grouped with this family despite its title claiming "fresh, no conflicts"
— that claim is about git conflicts (true — merge-tree is clean) and does
not cover the HANDOFF-count CI failure (still red).

#186 also shares the same base and *would* likely share the same fix path,
but is listed separately because its CI is currently green on its own
branch (it must have bumped its own local HANDOFF count) — only the
merge against current `main` conflicts (HANDOFF.md only).

### #190 in detail (STALE)

Diffed directly (`git diff 7880bc1 9bf9349c -- src/index.ts`): #190
implements the compact-catalog idea as an **unconditional default**
(`toolAdvertised()` has no `compactCatalogEnabled` gate at all) and sets
`{ capabilities: { tools: { listChanged: true } } }`. The version that
actually landed on `main` (commit `45ff3d9`, PR #194, merged 2026-09-20)
keeps the 40-tool catalog as the default and requires
`MESHFLEET_COMPACT_CATALOG=1` to opt in, with no `listChanged` capability
advertised (`HANDOFF.md`: *"the selected catalog is fixed at process
startup, so MeshFleet does not advertise runtime `tools/list_changed`
notifications"*). Landing #190 over the current `main` would be a design
regression, not just a merge conflict.

## 6. Minimal ordered checklist to publish honestly

1. **Decide and bump the version.** `package.json` already reads `0.21.5`
   but that value is stale by 7 real commits (§1) and the `v0.21.5` tag
   already points at an earlier commit — reusing `0.21.5` for different
   tree content breaks tag/version immutability. Bump to the next patch
   (e.g. `0.21.6`), update `package-lock.json`, and tag it once decided.
2. **Finish the CHANGELOG.** Reorder so `[Unreleased]`/the new version sits
   at the top (currently it's sandwiched between `0.21.2` and `0.21.5`),
   and complete it with the 4 missing items from §4 (Grok adapter,
   dependency refresh, HANDOFF bump, retry-contract fix).
3. **Fix the packaging bug (§2).** Stop `dist/test/**` and the duplicate
   `dist/src/**` tree from being emitted or shipped — either give
   `tsconfig.test.json` its own out-of-tree `outDir` (e.g. `dist-test/`,
   not under `files`), or add an `.npmignore`/adjust `"files"` to exclude
   `dist/test` and `dist/src`. Not a 0.21.5-only blocker (0.21.1 already
   ships it) but worth fixing before a Show HN invites tarball inspection.
4. **Land or dismiss #192** (repo hygiene: `.scratch/` probe, corpus twin,
   health dumps) — SAFE-TO-LAND, green, clean, contained, improves what a
   Show HN visitor sees browsing the repo.
5. **Decide on the 37-PR contract-pin backlog (§5).** Not required to
   publish, but 37 open, same-author, single-purpose PRs sitting red is
   itself a signal worth resolving one way or another before inviting
   outside contributors — a rebase-and-bump sweep, a squash, or a closure
   with an explanation are all reasonable; leaving them as-is is not a
   blocker either way.
6. **Re-run `npm run build && npm test && npm pack --dry-run`** (i.e.
   `npm run release:verify`, already defined in `package.json`) against the
   final commit before `npm publish`, and diff the pack file list against
   §2 one more time.
7. **Publish**, then verify `npm view meshfleet version` matches the tag
   and that a fresh `npx -y meshfleet` matches the README's quickstart.

---
_Generated by [Claude Code](https://claude.ai/code)_
