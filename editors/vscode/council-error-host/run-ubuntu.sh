#!/usr/bin/env bash
# Public Ubuntu invocation for Council-error Extension Host (in-tree harness).
# No patch apply — this branch already carries the accepted app/test postimages.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
EXTENSION_DIR=$(cd "$HERE/.." && pwd)
ROOT=${AGENT_MESH_ROOT:-$(cd "$EXTENSION_DIR/../.." && pwd)}
WORK=${WORK_DIR:-$(mktemp -d -t council-error-host-XXXXXX)}
# Tip parent is retained package; package parent is public tip ba64af08.
PINNED_PARENT=1fe6e01548a79540cef45db787169e122511a98d
PINNED_ROOT=ba64af08ca4cefa0009edffc8b82dd58c2680f40

git -C "$ROOT" rev-parse HEAD >/dev/null
if [[ -n "${GITHUB_SHA:-}" ]]; then
  git -C "$ROOT" rev-parse HEAD | grep -qx "$GITHUB_SHA"
fi
HEAD=$(git -C "$ROOT" rev-parse HEAD)
PARENT=$(git -C "$ROOT" rev-parse HEAD^)
if [[ "$HEAD" == "$PINNED_PARENT" ]]; then
  # Running on retained package commit itself.
  test "$PARENT" = "$PINNED_ROOT"
elif [[ "$PARENT" == "$PINNED_PARENT" ]]; then
  # Running on prelaunch tip whose parent is retained 1fe6e015.
  :
elif [[ "$HEAD" == "$PINNED_ROOT" ]]; then
  :
else
  echo "unexpected head=$HEAD parent=$PARENT (want parent $PINNED_PARENT or head $PINNED_PARENT/$PINNED_ROOT)" >&2
  exit 2
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
