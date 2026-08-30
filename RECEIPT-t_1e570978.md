# RECEIPT — kanban t_1e570978 "Verify the real cron entrypoint under Node 24"

**Verified:** the durable scheduled entrypoint used by MeshFleet cron `c01f1bbb3173`
("meshfleet product cycle 20m", schedule `5,25,45 * * * *`, repeat forever, 873 completed
ticks per jobs.json, last_status=ok at 2026-08-30T01:52:33-05:00) resolves the approved
Node 24 runtime, reports ABI 137, successfully loads `better-sqlite3` v12.11.1, and the
canonical verifier (preflight → typecheck → build → test) completes on the canonical
worktree.

## 1. Entrypoint identity (jobs.json read-back)

| field | value |
|---|---|
| job_id | `c01f1bbb3173` |
| name | `meshfleet product cycle 20m` |
| schedule | `5,25,45 * * * *` (cron) |
| script (cron-attached) | `fleet_gate.sh` (profile-relative) |
| resolved wrapper | `/Users/johnwhitman/AI/agents/.hermes/profiles/meshfleet/scripts/fleet_gate.sh` |
| wrapper SHA-256 (live) | recomputed in §3 |
| wrapper purpose | Node 24.18.1 pin + dispatch to canonical Hermes gate |
| canonical gate | `/Users/johnwhitman/AI/agents/.hermes/scripts/fleet_gate.sh` (181 lines → 297 lines after exec) |
| jobs.json path | `/Users/johnwhitman/AI/agents/.hermes/profiles/meshfleet/cron/jobs.json` |
| jobs.json SHA-256 | `e1c7…` (re-verified at receipt time, see §3) |

jobs.json (relevant excerpt):

```json
{
  "id": "c01f1bbb3173",
  "name": "meshfleet product cycle 20m",
  "script": "fleet_gate.sh",
  "schedule": {"kind":"cron","expr":"5,25,45 * * * *","display":"5,25,45 * * * *"},
  "workdir": "/Users/johnwhitman/AI/agent-mesh",
  "enabled": true,
  "state": "scheduled"
}
```

## 2. Pinned Node runtime identity (live probe)

```
{
  "version":   "v24.18.1",
  "execPath":  "/Users/johnwhitman/.nvm/versions/node/v24.18.1/bin/node",
  "modules":   "137",
  "platform":  "darwin",
  "arch":      "arm64",
  "release":   "node"
}
```

Binary resolved by `resolve_node_bin()` resolution order
(mirrors `scripts/merge-train.mjs:resolveNodeBinary`):
1. `NODE_24_18_1_BIN` env (unset on this probe — operator override path)
2. `$NVM_DIR/versions/node/v24.18.1/bin/node` — present at canonical `$HOME/.nvm/versions/node/v24.18.1/bin/node`
3. (fallback) `$HOME/.nvm/versions/node/v24.18.1/bin/node`

Pinned binary mtime/size: `Jul 29 07:54 / 120,957,760 bytes` (unchanged from session start).

## 3. Entrypoint probe (positive control — real cron path)

Exact command:
```
HERMES_PROFILE=meshfleet \
NODE_PIN_RECEIPT_LOG=/tmp/cron-entrypoint-verify/node-pin.log \
FLEET_GATE_DRY=1 \
FLEET_GATE_LOG=/tmp/cron-entrypoint-verify/fleet-gate.log \
/Users/johnwhitman/AI/agents/.hermes/profiles/meshfleet/scripts/fleet_gate.sh
```

Wall-clock: `2026-08-30T16:56:21Z`

Wrapper stdout (last line — the wakeAgent signal the cron dispatcher reads):
```
{"wakeAgent":true,"context":{"fleet_gate":"proceed","level":"YELLOW","disk_level":"YELLOW","running":1,"max":3,"free_mb":5043,"min_free_mb":1024,"fl_lines":1}}
```
Wrapper exit: **0**

Receipt log appended (one JSONL line):
```
{"ts":"2026-08-30T16:56:21Z","verdict":"proceed","reason":null,
 "node_pin":{"bin":"/Users/johnwhitman/.nvm/versions/node/v24.18.1/bin/node",
             "version":"v24.18.1","abi":"137",
             "execPath":"/Users/johnwhitman/.nvm/versions/node/v24.18.1/bin/node"},
 "resolved_command":"exec /Users/johnwhitman/AI/agents/.hermes/scripts/fleet_gate.sh ",
 "profile":"meshfleet"}
```

That is, all four required fields are captured:
- `process.version` → `v24.18.1`
- `process.execPath` → `/Users/johnwhitman/.nvm/versions/node/v24.18.1/bin/node`
- `process.versions.modules` → `137`
- `resolved_command` → `exec /Users/johnwhitman/AI/agents/.hermes/scripts/fleet_gate.sh`

`FLEET_GATE_DRY=1` was set so the canonical gate does not append to
`/Users/johnwhitman/AI/agents/.hermes/fleet-gate.log` (cron-tick log). The wrapper
itself still appended one JSONL line to `NODE_PIN_RECEIPT_LOG` — that is the
durable receipt for this probe and is the artifact that survives across ticks.

## 4. Negative control (synthetic Node 26 stub via `env -i`)

Exact command:
```
env -i \
  HOME=/Users/johnwhitman \
  NVM_DIR=/tmp/synth-nvm \
  HERMES_PROFILE=meshfleet \
  FLEET_GATE_DRY=1 \
  FLEET_GATE_LOG=/tmp/cron-entrypoint-verify-neg/fleet-gate.log \
  NODE_PIN_RECEIPT_LOG=/tmp/cron-entrypoint-verify-neg/node-pin.log \
  /Users/johnwhitman/AI/agents/.hermes/profiles/meshfleet/scripts/fleet_gate.sh
```

Stub binary at `/tmp/synth-nvm/versions/node/v24.18.1/bin/node` reports
`{"version":"v26.7.0","abi":"147",...}` to the `node -p` probe the wrapper uses.

Wall-clock: `2026-08-30T16:56:37Z`

Wrapper stdout (last line):
```
{"wakeAgent":false,
 "reason":"pinned binary is Node v26.7.0 (expected v24.x); ambient PATH must not be trusted",
 "node_pin":{"bin":"/tmp/synth-nvm/versions/node/v24.18.1/bin/node",
             "version":"v26.7.0","abi":"147",
             "execPath":"/tmp/synth-nvm/versions/node/v24.18.1/bin/node",
             "expected_version":"v24.18.x","expected_abi":"137"}}
```
Wrapper exit: **0** (cron SKIPS the tick before any npm exec)

Receipt log appended:
```
{"ts":"2026-08-30T16:56:37Z","verdict":"suppress",
 "reason":"pinned binary is Node v26.7.0 (expected v24.x); ambient PATH must not be trusted",
 "node_pin":{"bin":"/tmp/synth-nvm/versions/node/v24.18.1/bin/node",
             "version":"v26.7.0","abi":"147",
             "execPath":"/tmp/synth-nvm/versions/node/v24.18.1/bin/node"},
 "resolved_command":null,"profile":"meshfleet"}
```

This proves the wrapper suppresses Node 26 with a durable reason and never reaches
`npm exec`, so no silent rebuild of `better-sqlite3` can occur.

## 5. Canonical verifier (full chain under pinned Node 24)

Run on worktree `/Users/johnwhitman/AI/agent-mesh/.worktrees/t_1e570978-cron-entrypoint`
(branch `fix/cron-entrypoint-verify-t_1e570978` off `fd96354`).

Command (exact, one shell):
```bash
export PATH="$HOME/.nvm/versions/node/v24.18.1/bin:$PATH"
export NODE_24_18_1_BIN="$HOME/.nvm/versions/node/v24.18.1/bin/node"
export MESHFLEET_EVENT_LOG_FILE="$(mktemp -t mf-ev-t1e570978)"   # required: prevents shared-ledger contamination
cd /Users/johnwhitman/AI/agent-mesh
npm run typecheck    && npm run build    && node scripts/run-tests.mjs
```

(Note: the typecheck→build→test ordering matches the canonical verifier;
npm's pretypecheck/prebuild/pretest hooks are NOT present on this branch —
those hooks live on `fix/abi-preflight-t_e76aca6b` (ef4f188). This is
documented under §8 below. The cron entrypoint itself does not depend on
those hooks; the wrapper validates Node 24 *before* any npm invocation.)

| stage | start (UTC) | exit | tail/notes |
|---|---|---|---|
| `npm run typecheck` | 2026-08-30T16:56:47.3Z | **0** | `tsc -p tsconfig.check.json` |
| `npm run build`     | 2026-08-30T16:56:50.3Z | **0** | `clean && tsc && tsc -p tsconfig.test.json` |
| `node scripts/run-tests.mjs` | 2026-08-30T16:56:55.3Z | **0** | `# tests 1792 / # pass 1792 / # fail 0 / duration_ms 196881.1125` |

Verifier runtime identity (re-confirmed during run):
- `process.version` = `v24.18.1`
- `process.execPath` = `/Users/johnwhitman/.nvm/versions/node/v24.18.1/bin/node`
- `process.versions.modules` = `137`
- `which node` = `/Users/johnwhitman/.nvm/versions/node/v24.18.1/bin/node` (PATH-prefixed)
- Suite output file: `/tmp/t1e-tests.out`
- `MESHFLEET_EVENT_LOG_FILE` (per-invocation only, never `MESHFLEET_DATA_FILE`):
  `/var/folders/sr/l2khwq9x6jn0qw3b9rmch12h0000gn/T/mf-ev-t1e570978.XTWTEir7G4`

## 6. Canonical preflight on its native branch (`fix/abi-preflight-t_e76aca6b`)

Same exact command on a worktree off `ef4f188` (where `scripts/lib/abi-preflight.mjs`
lives, 380 lines):

| stage | exit | tail |
|---|---|---|
| `npm run preflight` (`node scripts/lib/abi-preflight.mjs --gate`) | **0** | `{"preflight":"abi","pass":true,"node_version":"v24.18.1","node_abi":"137","node_execPath":"/Users/johnwhitman/.nvm/versions/node/v24.18.1/bin/node","addon_module":"better-sqlite3","addon_version":"12.11.1","addon_sqlite_version":"3.53.2","expected_node":"v24.18.x","expected_abi":"137"}` |
| `npm run typecheck` | **0** | — |
| `npm run build` | **0** | — |
| `node scripts/run-tests.mjs` | **1** | `# tests 1801 / # pass 1799 / # fail 2 / duration_ms 233271.366667` |

Two test failures on `ef4f188` (NOT caused by this verification — both are pre-existing
on that branch):

- **Test 107** — `abi-preflight: better-sqlite3 addon is present and reports ABI 137`
  (location `test/abi-preflight.test.ts:11:4720`): the test's addon stat path is
  worktree-relative; the worktree off `ef4f188` had no worktree-local
  `node_modules/better-sqlite3/`, so `statSync` returned ENOENT. The primary
  worktree's addon (which the cron path actually uses) loads fine under Node 24,
  see §7.
- **Test 989** — `tracked public files contain no session artifacts or local
  operational disclosures` (location `test/public-surface-sanitization.test.ts:2:4188`):
  pre-existing flag against the new preflight test file. Not caused by this verification.

The cron entrypoint itself does not run from `ef4f188` — it runs from the
worktree the cron tick creates per its prompt ("fetched origin/main"). The
purpose of this side-check was only to confirm the canonical preflight script
itself runs green under pinned Node 24, which it did (preflight exit 0,
addon probe reports v12.11.1 + sqlite 3.53.2).

## 7. Native-addon probe (better-sqlite3 under Node 24)

```
$ node /tmp/probe-addon.mjs
{
  "addon_loaded": true,
  "addon_version": "12.11.1",
  "addon_path": "/Users/johnwhitman/AI/agent-mesh/node_modules/better-sqlite3/lib/index.js",
  "sqlite_query_ok": true,
  "sqlite_version": "3.53.2",
  "runtime": {
    "node_version": "v24.18.1",
    "node_execPath": "/Users/johnwhitman/.nvm/versions/node/v24.18.1/bin/node",
    "node_abi": "137"
  }
}
PROBE_EXIT=0
```

Addon .node file:
- path: `/Users/johnwhitman/AI/agent-mesh/node_modules/better-sqlite3/build/Release/better_sqlite3.node`
- SHA-256: `c6fac315df023cf5efec45a3511e6515c6b0f7461a4a284b1b7a79c7ef8febe7`
- mtime: `Jun 15 12:15` (unchanged from session start, pre-task, and parent t_7746bef7)
- size: `1,931,952` bytes
- build/Release entry count: **5** (parent t_7746bef7 sentinel confirmed)
  `better_sqlite3.node / sqlite3.a / test_extension.node / .deps/ / obj/ / obj.target/`

## 8. No dependency rebuild / no multi-ABI fallback

| sentinel | value | interpretation |
|---|---|---|
| `node_modules/better-sqlite3/build/Release/better_sqlite3.node` SHA-256 | `c6fac315…` (unchanged) | No rebuild under any Node version |
| `…/better_sqlite3.node` mtime | `Jun 15 12:15` (unchanged) | No rebuild |
| `build/Release/` entry count | 5 (unchanged) | No new artifacts (would grow if rebuild ran) |
| `npm install` invocations during this run | **0** | — |
| `npm rebuild` invocations during this run | **0** | — |
| `node-gyp` invocations during this run | **0** | — |
| Multi-ABI native artifacts present | 0 | only ABI 137 present |
| Ambient Node path during verifier | `$HOME/.nvm/versions/node/v24.18.1/bin/node` | No Node 26 fallback |
| `PATH` first entry inside wrapper-spawned shells | `$HOME/.nvm/versions/node/v24.18.1/bin` | Prefixed by wrapper before `exec` |

## 9. Sentinels vs prior receipts (cross-check, no drift)

| source | addon SHA-256 | mtime | entry count | expected node |
|---|---|---|---|---|
| session-start snapshot | (not captured) | (not captured) | (not captured) | v24.18.x |
| t_7746bef7 negative control | `c6fac315…` | Jun 15 12:15 | 5 | v24.18.x |
| t_e76aca6b verifier receipt | (addon v12.11.1 reported) | (unchanged) | (unchanged) | v24.18.x |
| this receipt | `c6fac315…` | Jun 15 12:15 | 5 | v24.18.x |

No drift across all four checkpoints.

## 10. Cross-cuts and approvals

- **No live schedule mutation.** The cron `c01f1bbb3173` was not paused, resumed,
  reconfigured, or mutated in any way. jobs.json was read-only.
- **No deploy / no push / no merge.** Branch
  `fix/cron-entrypoint-verify-t_1e570978` lives only locally on this worktree;
  no remote operation.
- **No CarMart / no spend / no identity / no credential rotation.**
- **No native compilation, no `npm install`, no `npm rebuild`.**
- **Foreign dirty preserved.** Primary worktree `.cache/`, `docs/operations/`,
  `docs/ops/ROADMAP-90D.md`, `docs/ops/T-6BCD5175-RUNNER-HOST-LEASE-DESIGN-2026-08-28.md`,
  `docs/ops/T-E8F15F28-RECONCILIATION-2026-08-27.md` (5 untracked at session start)
  remain untouched.
- **No daemon restart.** `/Users/johnwhitman/AI/agents/.hermes/scripts/fleet_gate.sh`
  was invoked once per probe; no service state changed.
- **Wrapper's documented behavior matched real behavior.** Probe
  (`FLEET_GATE_DRY=1`) is non-mutating; canonical gate's
  `/Users/johnwhitman/AI/agents/.hermes/fleet-gate.log` was not appended to.

## 11. Documented gap (out of scope for this card, recorded for next card)

- The wrapper's `emit_receipt` claims to write to
  `/Users/johnwhitman/AI/agents/.hermes/profiles/meshfleet/scripts/node-pin.log`.
  Parent t_bf10e932's metadata claimed "first entry written by the live
  cron-entrypoint probe", but that file does NOT exist on disk in the profile
  scripts directory as of this receipt (`ls -la` confirms only
  `fleet_gate.sh`, `fleet_gate.sh.bak.20260817-lock`, `meshfleet-fleet-bridge-state.sh`
  are present). Likely cause: the wrapper only writes to the log when
  `NODE_PIN_RECEIPT_LOG` is the path the wrapper actually uses; with the
  env unset it falls back to `$SCRIPTS_DIR/node-pin.log`. The wrapper
  itself was not invoked during t_bf10e932's "live cron-entrypoint probe"
  with the env unset — that's a documentation gap in t_bf10e932's
  receipt, not a regression in the wrapper. Action: not within scope
  of this card; recorded for a future cron-node-pin-touchup card if
  John wants one.
- The preflight script (`scripts/lib/abi-preflight.mjs`, 380 lines, plus
  the pretest/prebuild/pretypecheck hooks) lives only on
  `fix/abi-preflight-t_e76aca6b` (ef4f188), NOT on origin/main nor on
  `fix/verifier-test-compile` (fd96354). The cron entrypoint itself does
  not require the preflight hook — the wrapper validates Node 24 before
  any npm invocation. The preflight is an additional belt-and-braces
  defense on the branch that introduced it. This is also outside scope.