#!/usr/bin/env bash
#
# Makes deployed callables actually reachable.
#
# A Firebase callable is a public HTTPS endpoint that authenticates inside the
# function body, so it needs an allUsers invoker binding to be reached at all.
# Firebase only applies that binding when a function is *created* — redeploying
# over an existing one leaves it exactly as it was. Any function created while
# the deploying account lacked cloudfunctions.functions.setIamPolicy is
# therefore unreachable until it is deleted and made again, and it reports
# successful deploys the whole time it is broken.
#
# Truth here is an HTTP request, not the deploy log. 403 is the Google Frontend
# refusing before the function runs; 200/401/400 all mean the request arrived.
#
#   bash scripts/fix-invokers.sh [project] [batch]
#
set -uo pipefail

PROJECT="${1:-platform-dev}"
BATCH="${2:-8}"
PAUSE=20
MAX_PASSES=8
REGION="us-central1"

BACKEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export FIREBASE_SUPPRESS_REGION_WARNING=true

# Scheduled jobs are invoked by Cloud Scheduler, never a client. A 403 on these
# is correct and must never be "fixed" — one deletes orphaned accounts, another
# expires subscriptions. A public invoker on those is a hole, not a repair.
SCHEDULED="cleanupOrphanedAccounts expireStaleSubscriptions gracePeriodReminder cleanupExpiredInvoiceVisibility"

is_scheduled() {
  case " $SCHEDULED " in *" $1 "*) return 0;; *) return 1;; esac
}

all_exports() {
  ( cd "$BACKEND/functions" \
    && GCLOUD_PROJECT="$PROJECT" GOOGLE_CLOUD_PROJECT="$PROJECT" \
       node -e "console.log(Object.keys(require('./lib/index.js')).join('\n'))" )
}

for pass in $(seq 1 "$MAX_PASSES"); do
  # Read into an array up front. Reading with `while read` from a file while
  # firebase runs inside the loop lets those commands consume the loop's stdin,
  # which silently skips most of the list and reports nothing wrong.
  mapfile -t ALL < <(all_exports)

  if [ "${#ALL[@]}" -lt 50 ]; then
    echo "ABORT: read only ${#ALL[@]} exports. Run 'npm --prefix functions run build'."
    exit 1
  fi

  BLOCKED=()
  for fn in "${ALL[@]}"; do
    [ -z "$fn" ] && continue
    is_scheduled "$fn" && continue
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST \
      -H 'Content-Type: application/json' -d '{"data":{}}' \
      "https://${REGION}-${PROJECT}.cloudfunctions.net/${fn}" </dev/null)
    [ "$code" = "403" ] && BLOCKED+=("$fn")
  done

  echo "PASS $pass: ${#BLOCKED[@]} unreachable of ${#ALL[@]} exports."
  if [ "${#BLOCKED[@]}" -eq 0 ]; then
    echo "Every callable is reachable. Scheduled jobs correctly stay closed:"
    for s in $SCHEDULED; do echo "  $s"; done
    exit 0
  fi

  i=0
  while [ "$i" -lt "${#BLOCKED[@]}" ]; do
    slice=("${BLOCKED[@]:i:BATCH}")
    only=$(printf 'functions:%s,' "${slice[@]}"); only="${only%,}"

    echo "  recreating ${#slice[@]}: ${slice[*]}"
    # </dev/null on both, for the same stdin reason as above.
    firebase functions:delete "${slice[@]}" --project "$PROJECT" --force </dev/null >/dev/null 2>&1
    created=$(firebase deploy --only "$only" --project "$PROJECT" --force </dev/null 2>&1 \
      | grep -cE "Successful create") || true
    echo "    created $created/${#slice[@]}"

    i=$((i + BATCH))
    sleep "$PAUSE"
  done
done

echo "Still unreachable after $MAX_PASSES passes."
exit 1
