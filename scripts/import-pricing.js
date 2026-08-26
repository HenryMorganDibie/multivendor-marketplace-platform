/**
 * THE PLATFORM — Subscription Pricing Importer
 * Writes subscription-pricing/pricing.json and
 * subscription-pricing/providerPlanMapping.json to Firestore's
 * `subscriptionPricing` and `providerPlanMapping` collections.
 *
 * Always validates first (refuses to import invalid data). Rerun-safe:
 * createdAt preserved, updatedAt only touched on a real field change,
 * nothing ever deleted (orphaned records are flagged, not removed).
 *
 * Defaults to the local Firestore emulator (127.0.0.1:8080), matching
 * every other script in this folder. Pass --live to write to a real
 * project instead (requires GOOGLE_APPLICATION_CREDENTIALS or
 * `gcloud auth application-default login`, and --project <id>).
 *
 * Run: node import-pricing.js
 * Run against a real project: node import-pricing.js --live --project <id>
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const args = process.argv.slice(2);
const isLive = args.includes("--live");
const projectArgIdx = args.indexOf("--project");
const projectId = projectArgIdx !== -1 ? args[projectArgIdx + 1] : "demo-platform";

if (!isLive) {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  console.log(`Target: Firestore EMULATOR (${process.env.FIRESTORE_EMULATOR_HOST}), project "${projectId}"`);
} else {
  console.log(`Target: LIVE Firestore, project "${projectId}"`);
  console.log("⚠  This will write to a real project. Ctrl+C now to abort.\n");
}

console.log("Running validate-pricing.js first...\n");
try {
  execFileSync(process.execPath, [path.join(__dirname, "validate-pricing.js")], { stdio: "inherit" });
} catch {
  console.error("\nValidation failed — aborting import. Fix the errors above and rerun.");
  process.exit(1);
}
console.log("");

const ROOT = path.join(__dirname, "..");
const pricing = JSON.parse(fs.readFileSync(path.join(ROOT, "subscription-pricing", "pricing.json"), "utf8"));
const mapping = JSON.parse(fs.readFileSync(path.join(ROOT, "subscription-pricing", "providerPlanMapping.json"), "utf8"));

const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

async function upsert(collection, docId, seed) {
  const ref = db.collection(collection).doc(docId);
  try {
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({ ...seed, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      return "created";
    }
    const existing = snap.data();
    const changed = Object.keys(seed).some((key) => JSON.stringify(existing[key]) !== JSON.stringify(seed[key]));
    if (!changed) return "skipped";
    await ref.set({ ...seed, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return "updated";
  } catch (err) {
    console.error(`  FAILED ${collection}/${docId}: ${err.message}`);
    return "failed";
  }
}

async function importCollection(label, collection, records, idFn) {
  const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const seedIds = new Set();
  for (const record of records) {
    const docId = idFn(record);
    seedIds.add(docId);
    const result = await upsert(collection, docId, record);
    counts[result]++;
  }
  const existingSnap = await db.collection(collection).get();
  const orphaned = existingSnap.docs.map((d) => d.id).filter((id) => !seedIds.has(id));
  console.log(`${label}: ${counts.created} created, ${counts.updated} updated, ${counts.skipped} skipped, ${counts.failed} failed`);
  if (orphaned.length > 0) {
    console.log(`  ⚠  ${orphaned.length} existing ${collection} doc(s) not present in seed files (NOT deleted, review manually):`);
    for (const id of orphaned) console.log(`     - ${id}`);
  }
}

(async () => {
  console.log("Importing...\n");
  await importCollection("Subscription pricing", "subscriptionPricing", pricing, (r) => r.countryCode);
  await importCollection("Provider plan mappings", "providerPlanMapping", mapping, (r) => `${r.countryCode}-${r.planId}`);
  console.log("\nDone.");
  process.exit(0);
})().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
