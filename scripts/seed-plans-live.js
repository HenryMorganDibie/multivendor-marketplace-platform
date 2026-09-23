/**
 * Seeds subscriptionPlans into a live project from the compiled defaults.
 *
 * platform-dev had no subscriptionPlans documents at all, so every limit was
 * being served by DEFAULT_PLAN_LIMITS — the fallback meant for an unseeded
 * environment. That works, but it means limits can only be changed by
 * redeploying, and it is not how this is intended to run: Firestore is the live
 * source precisely so a limit can be adjusted without shipping code.
 *
 * Merged rather than overwritten, so a plan document edited in the console
 * keeps anything not named here.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node seed-plans-live.js --project platform-dev --apply
 */
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const projectIndex = args.indexOf("--project");
const PROJECT = projectIndex >= 0 ? args[projectIndex + 1] : "demo-platform";

process.env.GCLOUD_PROJECT = PROJECT;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
if (PROJECT === "demo-platform") {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
}

const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

const {
  DEFAULT_PLAN_LIMITS,
  DEFAULT_PLAN_DISPLAY,
} = require("../functions/lib/subscriptions/planLimitsSeedData.js");

async function main() {
  console.log(`${APPLY ? "APPLYING" : "DRY RUN"} against ${PROJECT}\n`);

  for (const [planId, limits] of Object.entries(DEFAULT_PLAN_LIMITS)) {
    const display = DEFAULT_PLAN_DISPLAY[planId] ?? {};
    console.log(
      `${planId.padEnd(9)} ${String(limits.catalogItemLimit).padStart(3)} items  ` +
      `${limits.photosPerItemLimit} photos  ${String(limits.invoicesPerMonth).padStart(3)} invoices`
    );
    if (Array.isArray(display.features)) console.log(`          ${display.features.join("  |  ")}`);

    if (!APPLY) continue;
    await db.collection("subscriptionPlans").doc(planId).set(
      { ...limits, ...display, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true },
    );
  }

  console.log(APPLY ? "\nSeeded." : "\nNothing written. Re-run with --apply.");
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
