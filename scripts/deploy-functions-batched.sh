#!/usr/bin/env bash
#
# Deploys functions in batches, reconciling against what is actually live.
#
# A single `firebase deploy --only functions` on this codebase asks the
# Cloud Functions API to create ~120 functions at once and trips its per-minute
# create quota. The failures come back as "Failed to make request", which reads
# like a permissions or network problem and is neither — it is rate limiting.
#
# So: work out what is missing by comparing source exports against the deployed
# list, deploy that set in small batches, pause between them, and repeat. Each
# pass re-reads the live list rather than assuming the previous pass worked,
# which means a partial failure is simply picked up by the next pass instead of
# needing anyone to work out where it stopped.
#
#   bash scripts/deploy-functions-batched.sh [project] [batch-size]
#
set -uo pipefail

PROJECT="${1:-platform-dev}"
BATCH="${2:-12}"
PAUSE=45
MAX_PASSES=12

BACKEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export FIREBASE_SUPPRESS_REGION_WARNING=true

live_list() {
  firebase functions:list --project "$PROJECT" 2>/dev/null \
    | sed 's/\x1b\[[0-9;]*m//g' \
    | python -c "
import sys, re
for line in sys.stdin:
    parts=[p.strip() for p in line.split('│') if p.strip()]
    if len(parts)>=3 and re.match(r'^[a-zA-Z]\w*\$', parts[0]) and parts[0]!='Function':
        print(parts[0])
"
}

# Runs from inside functions/ and requires a relative path on purpose. Passing
# an absolute one built by `pwd` hands node an MSYS path like /c/... which it
# cannot resolve on Windows. That failed silently: the list came back empty, the
# comparison found nothing missing, and the script reported everything deployed
# while 108 functions were absent. A wrong answer that looks like success.
source_list() {
  ( cd "$BACKEND/functions" && GCLOUD_PROJECT="$PROJECT" GOOGLE_CLOUD_PROJECT="$PROJECT" \
      node -e "console.log(Object.keys(require('./lib/index.js')).join('\n'))" )
}

for pass in $(seq 1 "$MAX_PASSES"); do
  src=$(source_list | sort -u)
  src_count=$(printf '%s\n' "$src" | grep -c . || true)

  # An empty source list can only mean the require failed. Without this guard
  # that reads as "nothing is missing" and the script exits reporting success.
  if [ "$src_count" -lt 50 ]; then
    echo "ABORT: read only $src_count exports from functions/lib/index.js."
    echo "Expected ~120. Run 'npm --prefix functions run build' and try again."
    exit 1
  fi

  missing=$(comm -23 <(printf '%s\n' "$src") <(live_list | sort -u))
  count=$(printf '%s\n' "$missing" | grep -c . || true)

  if [ "$count" -eq 0 ]; then
    echo "PASS $pass: everything in source is deployed."
    exit 0
  fi

  echo "PASS $pass: $count function(s) missing."

  n=0
  batch=""
  while read -r fn; do
    [ -z "$fn" ] && continue
    batch="${batch}${batch:+,}functions:${fn}"
    n=$((n + 1))
    if [ "$n" -ge "$BATCH" ]; then
      echo "  deploying: $batch"
      firebase deploy --only "$batch" --project "$PROJECT" --force 2>&1 \
        | grep -E "Successful create|Successful update|Failed to create" || true
      batch=""; n=0
      sleep "$PAUSE"
    fi
  done <<< "$missing"

  if [ -n "$batch" ]; then
    echo "  deploying: $batch"
    firebase deploy --only "$batch" --project "$PROJECT" --force 2>&1 \
      | grep -E "Successful create|Successful update|Failed to create" || true
    sleep "$PAUSE"
  fi
done

# Falling out of the loop means passes stopped making progress. Report what is
# still missing rather than exiting quietly as though it worked.
echo
echo "Still missing after $MAX_PASSES passes:"
comm -23 <(source_list | sort -u) <(live_list | sort -u)
exit 1
