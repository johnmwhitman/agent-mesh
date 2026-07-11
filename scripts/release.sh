#!/usr/bin/env bash
# One-shot Phase 2 release: land PR #14, publish meshfleet, verify the tarball.
# Run this yourself — merge-to-main, npm publish, and npm auth are interactive
# rails Claude can't execute. It uses YOUR gh + npm credentials.
#
#   bash scripts/release.sh
#
set -euo pipefail

REPO="johnmwhitman/agent-mesh"
PKG="meshfleet"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

echo "==> 1/4 Land PR #14 (squash — carries the full phase 0→2 stack) + close #13"
gh pr merge 14 --repo "$REPO" --squash --delete-branch=false
gh pr close 13 --repo "$REPO" --comment "Superseded — landed via #14 (squashed)." || true

echo "==> 2/4 Sync main"
git checkout main
git pull --ff-only

echo "==> 3/4 Publish $PKG (prepublishOnly runs build + test)"
npm whoami >/dev/null 2>&1 || { echo "!! not logged in to npm — run 'npm login' first"; exit 1; }
npm publish

echo "==> 4/4 Verify the published tarball installs + the bins run"
TMP="$(mktemp -d)"
PUBLISHED="$(npm view "$PKG" version)"
( cd "$TMP" && npm init -y >/dev/null && npm install "$PKG@$PUBLISHED" >/dev/null )
node "$TMP/node_modules/$PKG/dist/bin/inspect.js" --help >/dev/null && echo "   inspect bin OK"
node -e "require('$TMP/node_modules/$PKG/package.json')" && echo "   package resolves OK"
rm -rf "$TMP"

echo "==> DONE — $PKG@$PUBLISHED published and verified."
echo "   Next: restart the HOOL agent-mesh instance once to migrate the live JSON ledger → SQLite"
echo "   (validated, fail-closed, keeps a .migrated backup)."
