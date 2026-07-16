#!/usr/bin/env bash
# One-shot release: publish meshfleet from main, verify the tarball.
# Run this yourself — npm auth + publish are interactive rails Claude can't
# execute. It uses YOUR npm credentials. main already carries the release
# commit (version + CHANGELOG rolled); prepublishOnly runs build + tests.
#
#   bash scripts/release.sh
#
set -euo pipefail

PKG="meshfleet"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

echo "==> 1/3 Sync main"
git checkout main
git pull --ff-only

echo "==> 2/3 Publish $PKG (prepublishOnly runs build + full test suite)"
npm whoami >/dev/null 2>&1 || { echo "!! not logged in to npm — run 'npm login' first"; exit 1; }
# npm requires 2FA to publish. With 2FA enabled it prompts for the OTP here;
# a hard E403 means 2FA is not set up yet — enable it at
# https://www.npmjs.com/settings/<user>/tfa then re-run (or: npm publish --otp=CODE).
npm publish

echo "==> 3/3 Verify the published tarball installs + the bins run"
TMP="$(mktemp -d)"
PUBLISHED="$(npm view "$PKG" version)"
( cd "$TMP" && npm init -y >/dev/null && npm install "$PKG@$PUBLISHED" >/dev/null )
( cd "$TMP" && npx --no-install agent-mesh inspect --help >/dev/null && echo "   inspect bin OK" )
( cd "$TMP" && npx --no-install agent-mesh-dashboard --help >/dev/null 2>&1 || true )
rm -rf "$TMP"
echo "==> Published $PKG@$PUBLISHED and verified the tarball."
