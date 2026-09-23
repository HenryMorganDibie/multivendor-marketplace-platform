#!/usr/bin/env bash
#
# Deploys the backend to platform-dev and points the mobile app at it.
#
# Everything here is idempotent: rules and indexes converge, the seed scripts
# write by known document id, and the migration derives its id from the invoice.
# Running it twice does the same thing as running it once.
#
# Requires: firebase login  (interactive, browser — run it yourself first)
#
#   bash scripts/deploy-dev.sh
#
set -euo pipefail

PROJECT="platform-dev"
BACKEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE="$BACKEND/../multivendor-marketplace-mobile/expo"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# Deliberately not `projects:list`. That enumerates at organisation level and
# comes back empty for an account granted access to a single project directly,
# which is exactly how this one is set up — it reported nothing while every
# project-scoped call worked. Reading the project itself is the honest test of
# whether we can reach it.
say "Checking access to $PROJECT"
if ! firebase firestore:indexes --project "$PROJECT" >/dev/null 2>&1; then
  echo "Cannot reach $PROJECT. Run 'firebase login' in an interactive terminal,"
  echo "and confirm that account has at least Editor on the project."
  exit 1
fi
echo "OK ($(firebase login:list 2>/dev/null | head -1))"

# Rules and indexes go first, deliberately. If functions land first there is a
# window where new code runs against old rules, and a query whose index does not
# exist yet fails with FAILED_PRECONDITION rather than returning empty.
say "Deploying Firestore rules and indexes"
firebase deploy --only firestore:rules,firestore:indexes --project "$PROJECT" --force

# Storage is deployed separately and is allowed to fail.
#
# Its bucket has to be provisioned once from the console — there is no CLI for
# it — and until that happens this step errors. Bundled with the Firestore
# deploy it aborted the entire run, so a single unclicked button in the console
# blocked functions, seeds and everything after them. Nothing about rules for a
# bucket that does not exist yet should stop the rest of the backend shipping.
say "Deploying Storage rules"
STORAGE_OK=1
firebase deploy --only storage --project "$PROJECT" --force || STORAGE_OK=0
if [ "$STORAGE_OK" -eq 0 ]; then
  echo
  echo "Storage rules were NOT deployed: the bucket is not set up yet."
  echo "Set it up once at:"
  echo "  https://console.firebase.google.com/project/$PROJECT/storage"
  echo "then re-run this script, or just:"
  echo "  firebase deploy --only storage --project $PROJECT"
  echo
  echo "Vendor verification uploads and invoice logos need it. Everything else"
  echo "in this deploy is unaffected and continues below."
fi

# --force answers the prompts this would otherwise block on: the Artifact
# Registry cleanup policy it offers to set up on a first functions deploy, and
# the confirmation before removing functions that no longer exist in source.
# The second is worth understanding rather than waving through — it means source
# is authoritative and anything deployed by hand outside this repo gets removed.
# On a project being deployed to for the first time there is nothing to remove.
say "Deploying functions"
firebase deploy --only functions --project "$PROJECT" --force

# Indexes build asynchronously. A composite index on a small collection is
# usually ready in seconds, but the deploy returns before it is, so a smoke test
# run immediately can fail on an index that is merely still building.
say "Index build status"
firebase firestore:indexes --project "$PROJECT" >/dev/null 2>&1 \
  && echo "Indexes submitted. Check the console if a query reports FAILED_PRECONDITION." \
  || true

say "Seeding reference data (countries, then pricing)"
node "$BACKEND/scripts/import-locations.js" --live --project "$PROJECT"
node "$BACKEND/scripts/import-pricing.js" --live --project "$PROJECT"

# Dry run first, always. On a fresh dev project this finds nothing, which is the
# expected and correct outcome — it exists for when dev has real invoices.
say "Ledger migration (dry run)"
node "$BACKEND/scripts/migrate-invoices-to-ledger.js" --live --project "$PROJECT"
echo
echo "If the dry run listed invoices you want migrated, re-run it with --apply:"
echo "  node scripts/migrate-invoices-to-ledger.js --apply --live --project $PROJECT"

say "Writing the mobile app's dev config"
node "$BACKEND/scripts/write-dev-env.js" --project "$PROJECT" --mobile "$MOBILE"

say "Done"
cat <<EOF

Backend is live on $PROJECT.

Next, the build that actually ends the "there is no backend" conversation:

  cd $MOBILE
  eas build --profile android-dev --platform android

That profile points at $PROJECT rather than the emulator. Every existing
profile points at demo-platform, which is why every previous build looked
empty on anyone's phone but yours.
EOF
