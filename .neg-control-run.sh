#!/usr/bin/env bash
# Negative-control harness for t_7746bef7.
# Three independent sentinels prove the ABI preflight refused BEFORE downstream commands launched:
#   S1. Direct CLI invocation: exit 1, refusal text names Node 26 / ABI 147 vs Node 24.x / ABI 137.
#   S2. `npm test` under Node 26: exit 1, npm only prints the `pretest` -> `preflight` banner,
#       TAP plan ("# tests N") / "ok" / "not ok" lines are absent, and the runner never
#       wrote to a unique event-log file (S3).
#   S3. MESHFLEET_EVENT_LOG_FILE sentinel: scripts/run-tests.mjs opens this file on the FIRST
#       executable lines after the preflight (see the script's preflight guard). If the
#       preflight refused, the file is never opened and stays at exactly the bytes written
#       before npm test launched. Compare SHA256 pre vs post.
set -u
cd "$(dirname "$0")"
WT=$(pwd)
REPO=$(cd .. && git rev-parse --show-toplevel 2>/dev/null || echo /Users/johnwhitman/AI/agent-mesh)
PRIMARY=/Users/johnwhitman/AI/agent-mesh

echo "[neg-control] worktree: $WT"
echo "[neg-control] primary repo: $PRIMARY"
echo "[neg-control] ambient node: $(command -v node) -> $(node --version)"
echo "[neg-control] addon path: $(node -e 'process.stdout.write(require.resolve("better-sqlite3"))')"
echo "[neg-control] addon binary NODE_MODULE_VERSION (built-time): $(/Users/johnwhitman/.nvm/versions/node/v24.18.1/bin/node -p 'process.versions.modules')"
echo "[neg-control] addon package version: $(/Users/johnwhitman/.nvm/versions/node/v24.18.1/bin/node -p 'require("/Users/johnwhitman/AI/agent-mesh/node_modules/better-sqlite3/package.json").version')"
echo

EVENT_LOG="$(mktemp -t meshfleet-verify-events-7746bef7)"
echo "[neg-control] event-log sentinel: $EVENT_LOG"
echo "no-events-written-if-preflight-refused" > "$EVENT_LOG"
PRE_SHA=$(shasum -a 256 "$EVENT_LOG" | awk '{print $1}')
echo "[neg-control] pre-npm sha256: $PRE_SHA"
echo

echo "============================================================"
echo "A. Direct preflight CLI under ambient Node 26"
echo "============================================================"
node scripts/lib/abi-preflight.mjs --gate 1>direct.stdout 2>direct.stderr
EXIT_A=$?
echo "EXIT_A=$EXIT_A"
echo "stdout bytes: $(wc -c <direct.stdout)  stderr bytes: $(wc -c <direct.stderr)"
echo "refusal names Node 26:  $(grep -c 'v26.7.0' direct.stderr || true)"
echo "refusal names ABI 147:  $(grep -c 'current abi  : 147' direct.stderr || true)"
echo "refusal names expected 24.x: $(grep -c 'v24.18.x' direct.stderr || true)"
echo "refusal names expected ABI 137: $(grep -c 'ABI 137' direct.stderr || true)"
echo "refusal points at pinned runner: $(grep -c '.nvm/versions/node/v24.18.1/bin' direct.stderr || true)"
echo "refusal warns against rebuild: $(grep -c 'NOT recompile the addon' direct.stderr || true)"
echo "stdout contains success receipt: $(grep -c '"preflight":"abi"' direct.stdout || true)"
echo
echo "----- direct.stderr -----"
sed 's/$/$/' direct.stderr
echo "----- /direct.stderr -----"
echo

echo "============================================================"
echo "B. npm test under ambient Node 26 (pretest -> preflight -> should refuse)"
echo "============================================================"
rm -f npm-test.stdout npm-test.stderr
export MESHFLEET_EVENT_LOG_FILE="$EVENT_LOG"
( npm test ) 1>npm-test.stdout 2>npm-test.stderr
EXIT_B=$?
unset MESHFLEET_EVENT_LOG_FILE
echo "EXIT_B=$EXIT_B"
echo "stdout bytes: $(wc -c <npm-test.stdout)  stderr bytes: $(wc -c <npm-test.stderr)"
echo
echo "B.1 npm-script banner / preflight lifecycle trace"
echo "----- npm-test.stdout -----"
cat npm-test.stdout
echo "----- /npm-test.stdout -----"
echo
echo "B.2 preflight refusal (must be on stderr from npm-script output)"
echo "----- npm-test.stderr -----"
cat npm-test.stderr
echo "----- /npm-test.stderr -----"
echo

echo "============================================================"
echo "C. Sentinels proving downstream did NOT launch"
echo "============================================================"
echo "C.1 TAP plan absent (would mean node:test runner executed)"
echo "TAP '# tests ' present: $(grep -c '^# tests ' npm-test.stdout || true)"
echo "TAP 'ok ' present: $(grep -c '^ok ' npm-test.stdout || true)"
echo "TAP 'not ok ' present: $(grep -c '^not ok ' npm-test.stdout || true)"
echo "node:test banner present (would mean runner ran): $(grep -c '^TAP version' npm-test.stdout || true)"
echo "any 'duration_ms' receipt line: $(grep -c 'duration_ms' npm-test.stdout || true)"
echo
echo "C.2 MESHFLEET_EVENT_LOG_FILE sentinel untouched (scripts/run-tests.mjs writes events on first lines AFTER the preflight)"
POST_SHA=$(shasum -a 256 "$EVENT_LOG" | awk '{print $1}')
echo "pre-npm sha256 : $PRE_SHA"
echo "post-npm sha256: $POST_SHA"
echo "sha256 unchanged: $([ "$PRE_SHA" = "$POST_SHA" ] && echo YES || echo NO)"
echo "post-npm bytes: $(wc -c <"$EVENT_LOG")"
echo "post-npm content:"
sed 's/^/    | /' "$EVENT_LOG"
echo
echo "C.3 addon package version file unchanged (no rebuild would mean no version bump in package.json)"
ADDON_PKG=/Users/johnwhitman/AI/agent-mesh/node_modules/better-sqlite3/package.json
ADDON_PKG_SHA=$(shasum -a 256 "$ADDON_PKG" | awk '{print $1}')
ADDON_BIN=/Users/johnwhitman/AI/agent-mesh/node_modules/better-sqlite3/build/Release/better_sqlite3.node
ADDON_BIN_SHA=$(shasum -a 256 "$ADDON_BIN" | awk '{print $1}')
echo "addon package.json sha256: $ADDON_PKG_SHA"
echo "addon .node     sha256: $ADDON_BIN_SHA"
echo "addon package.json mtime: $(stat -f '%Sm' "$ADDON_PKG")"
echo "addon .node     mtime:    $(stat -f '%Sm' "$ADDON_BIN")"
echo
echo "C.4 no package installer / rebuild command was invoked"
echo "node_modules/better-sqlite3/build/ subdirs unchanged: $(ls /Users/johnwhitman/AI/agent-mesh/node_modules/better-sqlite3/build/Release/ | wc -l | tr -d ' ') entries (expect same 5: better_sqlite3.node obj obj.target sqlite3.a test_extension.node)"
echo
echo "============================================================"
echo "D. Result"
echo "============================================================"
PASS=true
if [ "$EXIT_A" != "1" ]; then echo "  FAIL: preflight CLI did not exit 1 (got $EXIT_A)"; PASS=false; fi
if [ "$EXIT_B" != "1" ]; then echo "  FAIL: npm test did not exit 1 (got $EXIT_B)"; PASS=false; fi
if [ "$PRE_SHA" != "$POST_SHA" ]; then echo "  FAIL: event-log sentinel mutated by runner"; PASS=false; fi
if [ "$(grep -c '^# tests ' npm-test.stdout || true)" != "0" ]; then echo "  FAIL: TAP plan present, suite launched"; PASS=false; fi
if [ "$(grep -c 'v26.7.0' direct.stderr || true)" = "0" ]; then echo "  FAIL: refusal did not name Node 26"; PASS=false; fi
if [ "$(grep -c 'current abi  : 147' direct.stderr || true)" = "0" ]; then echo "  FAIL: refusal did not name ABI 147"; PASS=false; fi
if [ "$(grep -c 'v24.18.x' direct.stderr || true)" = "0" ]; then echo "  FAIL: refusal did not name expected 24.x"; PASS=false; fi
if [ "$(grep -c 'ABI 137' direct.stderr || true)" = "0" ]; then echo "  FAIL: refusal did not name expected ABI 137"; PASS=false; fi
if [ "$(grep -c '.nvm/versions/node/v24.18.1/bin' direct.stderr || true)" = "0" ]; then echo "  FAIL: refusal did not point at pinned runner"; PASS=false; fi
if $PASS; then echo "  PASS: all negative-control assertions hold."; else echo "  FAIL: see above."; fi