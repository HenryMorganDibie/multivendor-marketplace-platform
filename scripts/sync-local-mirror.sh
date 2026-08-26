#!/usr/bin/env bash
# Manually-run mirror sync — pulls the current tracked content of
# platform-backend, platform-website, and platform-vendor-portal into this
# sandbox repo's working tree. Nothing here runs unattended or auto-pushes
# anywhere; run it whenever you want your local mirror refreshed, review
# the diff, and commit/push yourself if you want it saved to GitHub too.
#
# Assumes the three source repos are cloned as siblings of this repo, i.e.
# ../platform-backend, ../platform-website, ../platform-vendor-portal — adjust
# the paths below if yours live elsewhere.
set -euo pipefail

SANDBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_SRC="${1:-$SANDBOX_DIR/../platform-backend}"
WEBSITE_SRC="${2:-$SANDBOX_DIR/../platform-website}"
VENDOR_PORTAL_SRC="${3:-$SANDBOX_DIR/../platform-vendor-portal}"

cd "$SANDBOX_DIR"

echo "Syncing platform-backend from $BACKEND_SRC ..."
find . -mindepth 1 -maxdepth 1 ! -name '.git' ! -name 'website' ! -name 'vendor-portal' ! -name 'scripts' -exec rm -rf {} +
(cd "$BACKEND_SRC" && git archive HEAD) | tar -x -C "$SANDBOX_DIR"

echo "Syncing platform-website from $WEBSITE_SRC ..."
rm -rf website && mkdir website
(cd "$WEBSITE_SRC" && git archive HEAD) | tar -x -C "$SANDBOX_DIR/website"

echo "Syncing platform-vendor-portal from $VENDOR_PORTAL_SRC ..."
rm -rf vendor-portal && mkdir vendor-portal
(cd "$VENDOR_PORTAL_SRC" && git archive HEAD) | tar -x -C "$SANDBOX_DIR/vendor-portal"

echo ""
echo "Done. Review with 'git status' / 'git diff', then commit and push yourself if you want it saved."
