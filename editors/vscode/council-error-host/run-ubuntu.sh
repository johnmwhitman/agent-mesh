#!/usr/bin/env bash
# Public Ubuntu invocation for Council-error Extension Host (in-tree harness).
# No patch apply — this branch already carries the accepted app/test postimages.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
EXTENSION_DIR=$(cd "$HERE/.." && pwd)
ROOT=${AGENT_MESH_ROOT:-$(cd "$EXTENSION_DIR/../.." && pwd)}
WORK=${WORK_DIR:-$(mktemp -d -t council-error-host-XXXXXX)}
PINNED_PARENT=ba64af08ca4cefa0009edffc8b82dd58c2680f40

git -C "$ROOT" rev-parse HEAD >/dev/null
# When CI sets GITHUB_SHA, require exact match to checkout HEAD.
if [[ -n "${GITHUB_SHA:-}" ]]; then
  git -C "$ROOT" rev-parse HEAD | grep -qx "$GITHUB_SHA"
fi
# Parent of this test commit must be the pinned tip (verified after commit; on tip itself allow equal).
PARENT=$(git -C "$ROOT" rev-parse HEAD^)
# Accept either: running ON the test commit (parent==PINNED_PARENT) or ON the tip before commit packaging.
if [[ "$PARENT" != "$PINNED_PARENT" ]]; then
  HEAD=$(git -C "$ROOT" rev-parse HEAD)
  if [[ "$HEAD" != "$PINNED_PARENT" ]]; then
    echo "unexpected parent=$PARENT head=$HEAD (want parent $PINNED_PARENT or head tip)" >&2
    exit 2
  fi
fi

if command -v xvfb-run >/dev/null 2>&1; then
  WRAP=(xvfb-run -a)
else
  WRAP=()
fi

export AGENT_MESH_ROOT="$ROOT"
export WORK_DIR="$WORK"
"${WRAP[@]}" node "$HERE/extension-host-regression.mjs"
echo "WORK_DIR=$WORK"
echo "REPORT=$WORK/REPORT.json"
