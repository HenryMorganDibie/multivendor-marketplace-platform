#!/usr/bin/env bash
# Run this before any deploy from main. Checks every commit in the given
# range against the allowed author/committer list, and fails loudly if
# anything else is found.
#
# Always pass a range scoped to what's new since your last known-good
# deploy -- the repo's day-one history (mid-2026) has legitimate old commits
# from before this check existed, so checking "all of history" (the default,
# HEAD) will report those too. That's expected, not a bug: this script is
# for catching what changed recently, not auditing the whole repo.
#
# Usage:
#   scripts/verify-main-authors.sh <last-deployed-sha>..HEAD   # normal usage
#   scripts/verify-main-authors.sh                              # checks all of HEAD's history
set -euo pipefail

ALLOWED_EMAILS=(
  "you@example.com"
  "you@example.com"
)

RANGE="${1:-HEAD}"

FAILED=0
while IFS='|' read -r sha author_email committer_email subject; do
  author_ok=0
  committer_ok=0
  for allowed in "${ALLOWED_EMAILS[@]}"; do
    [[ "$author_email" == "$allowed" ]] && author_ok=1
    [[ "$committer_email" == "$allowed" ]] && committer_ok=1
  done

  if [[ "$author_ok" -eq 0 || "$committer_ok" -eq 0 ]]; then
    echo "UNRECOGNIZED: $sha \"$subject\" (author: $author_email, committer: $committer_email)"
    FAILED=1
  fi
done < <(git log "$RANGE" --format='%H|%ae|%ce|%s')

if [ "$FAILED" -eq 1 ]; then
  echo ""
  echo "Found commit(s) from an unrecognized identity in range: $RANGE"
  echo "Do not deploy until you've reviewed exactly what these commits do."
  exit 1
fi

echo "All commits in range \"$RANGE\" are from an allowed identity. Safe to proceed."
