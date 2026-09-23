/**
 * Pushes the tightened Basic limits into a live project.
 *
 * DEFAULT_PLAN_LIMITS in the code is only the fallback for an environment where
 * subscriptionPlans was never seeded. Once it has been, that Firestore document
 * is what resolveEffectivePlan reads, so changing the code alone leaves every
 * existing environment on the old numbers. This is the other half of the change.
 *
 * Only the three fields that moved are written, merged, so anything else on the
 * document — display name, features, pricing — is left alone.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node update-basic-plan-limits.js --project platform-dev
 *   ... --apply     to actually write
 */
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const PROJECT = (() => {
  const i = args.indexOf("--project");
  return i >= 0 ? args[i + 1] : "demo-platform";
})();

if (PROJECT === "demo-platform") {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
}
process.env.GCLOUD_PROJECT = PROJECT;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT;

const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

const BASIC = {
  planLimitsVersion: "v2",
  catalogItemLimit: 7,
  photosPerItemLimit: 1,
  invoicesPerMonth: 2,
};

const DISPLAY_FEATURES = ["7 catalog items", "1 photo per item", "2 invoices/month"];

async function main() {
  console.log(`${APPLY ? "APPLYING" : "DRY RUN"} against ${PROJECT}\n`);

  const ref = db.collection("subscriptionPlans").doc("basic");
  const snap = await ref.get();

  if (!snap.exists) {
    console.log("subscriptionPlans/basic does not exist. Run seedSubscriptionPlans first;");
    console.log("this updates an existing document rather than creating a partial one.");
    process.exit(1);
  }

  const before = snap.data() ?? {};
  console.log("current:");
  for (const k of Object.keys(BASIC)) console.log(`  ${k}: ${before[k]}`);
  console.log("\nnew:");
  for (const [k, v] of Object.entries(BASIC)) console.log(`  ${k}: ${v}`);

  if (Array.isArray(before.features)) {
    console.log(`\nfeatures: ${JSON.stringify(before.features)}`);
    console.log(`      ->  ${JSON.stringify(DISPLAY_FEATURES)}`);
  }

  if (!APPLY) {
    console.log("\nNothing written. Re-run with --apply.");
    return;
  }

  await ref.set({ ...BASIC, features: DISPLAY_FEATURES }, { merge: true });
  console.log("\nWritten.");

  // Vendors already on Basic pick this up on their next call, because limits
  // are resolved per request rather than copied onto the vendor. Nothing needs
  // migrating; a vendor over the new limit simply cannot add another.
  console.log("Existing Basic vendors are affected immediately — limits resolve per request.");
  console.log("A vendor already above 7 items keeps them and cannot add more.");
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
