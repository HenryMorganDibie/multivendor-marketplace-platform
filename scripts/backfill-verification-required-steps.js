/**
 * Backfills vendorVerification.requiredSteps from the old, universally-
 * unsatisfiable ["business_info", "identity_document", "proof_of_address"]
 * to ["identity_document", "other"] — the two document types the mobile
 * verification flow (upload-id -> selfie) actually ever produces.
 *
 * completeRegistration.ts wrote the old three-step list for every vendor
 * ever registered, so every existing not-yet-approved vendor is stuck the
 * same way new signups were before that function was fixed. This repairs
 * the ones already sitting in Firestore.
 *
 * Only touches vendors still in "not_started" or "pending_review" with the
 * exact old array — never touches an "approved" vendor, and never touches a
 * vendor whose requiredSteps has already been customized (e.g. via the
 * admin retry-with-custom-steps path), since disturbing an admin's explicit
 * choice there is out of scope for this fix.
 *
 *   node backfill-verification-required-steps.js                       # emulator, dry run
 *   node backfill-verification-required-steps.js --apply --live --project platform-dev
 */
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const LIVE = args.includes("--live");
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const PROJECT = argOf("project") ?? "demo-platform";

process.env.GCLOUD_PROJECT = PROJECT;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
if (!LIVE) process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

const OLD_STEPS = ["business_info", "identity_document", "proof_of_address"];
const NEW_STEPS = ["identity_document", "other"];
const sameArray = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

async function main() {
  console.log(`${APPLY ? "APPLYING" : "DRY RUN"} against ${LIVE ? `LIVE ${PROJECT}` : "the emulator"}\n`);

  const snap = await db.collection("vendorVerification").get();
  let matched = 0;
  let skippedStatus = 0;
  let skippedCustom = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const status = data.verificationStatus;

    if (status !== "not_started" && status !== "pending_review") {
      skippedStatus += 1;
      continue;
    }
    if (!sameArray(data.requiredSteps, OLD_STEPS)) {
      skippedCustom += 1;
      continue;
    }

    matched += 1;
    console.log(`  ${doc.id}: [${OLD_STEPS.join(", ")}] -> [${NEW_STEPS.join(", ")}] (status: ${status})`);
    if (APPLY) {
      await doc.ref.update({ requiredSteps: NEW_STEPS, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  }

  console.log(`\n${matched} matched (${APPLY ? "written" : "would write"}), ${skippedStatus} skipped (approved/rejected/other status), ${skippedCustom} skipped (already customized or no doc)`);
  if (!APPLY) console.log("\nDry run only — pass --apply to write.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
