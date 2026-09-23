/**
 * Backfills the running revenue total onto every vendor.
 *
 * getVendorRevenue used to sum every payment row on each call. It now reads a
 * maintained figure, which recordPayment and reversePayment move as rows are
 * written. Vendors whose payments predate that field have no figure to read.
 *
 * readVendorRevenueTotal already rebuilds on a miss, so nothing breaks without
 * this — the first dashboard open after deploy pays for one scan and the field
 * exists from then on. This does that work up front instead, so no vendor pays
 * for it at the moment they are looking at a screen.
 *
 * Safe to rerun. It recomputes from the rows, which are canonical, so running
 * it twice writes the same figure. That also makes it the repair tool if a
 * total is ever doubted — rows are never edited or deleted, so a recomputation
 * is always authoritative.
 *
 *   node backfill-vendor-revenue-totals.js                       # emulator, dry run
 *   node backfill-vendor-revenue-totals.js --apply               # emulator, writes
 *   node backfill-vendor-revenue-totals.js --apply --live --project platform-dev
 *   node backfill-vendor-revenue-totals.js --apply --live --project platform-dev --vendor <id>
 */
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const LIVE = args.includes("--live");
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const PROJECT = argOf("project") ?? "demo-platform";
const ONLY_VENDOR = argOf("vendor");

process.env.GCLOUD_PROJECT = PROJECT;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
if (!LIVE) process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

async function totalFor(vendorId) {
  const snap = await db.collection("payments").where("vendorId", "==", vendorId).get();
  return snap.docs.reduce((sum, d) => {
    const amount = (d.data().amountMinorUnits ?? 0);
    // Reversals are stored positive and subtracted by type.
    return d.data().type === "reversal" ? sum - amount : sum + amount;
  }, 0);
}

async function main() {
  console.log(`${APPLY ? "APPLYING" : "DRY RUN"} against ${LIVE ? `LIVE ${PROJECT}` : "the emulator"}\n`);

  const vendors = ONLY_VENDOR
    ? [await db.collection("vendors").doc(ONLY_VENDOR).get()]
    : (await db.collection("vendors").get()).docs;

  let written = 0;
  let unchanged = 0;
  let corrected = 0;

  for (const doc of vendors) {
    if (!doc.exists) { console.log(`  ${ONLY_VENDOR}: no such vendor`); continue; }

    const stored = doc.data()?.revenueTotalMinorUnits;
    const actual = await totalFor(doc.id);

    if (stored === actual) { unchanged += 1; continue; }

    // A stored figure that disagrees with the rows is worth saying out loud
    // rather than silently overwriting: it means something moved the total
    // without going through the ledger.
    if (typeof stored === "number") {
      corrected += 1;
      console.log(`  ${doc.id}: stored ${stored} but rows say ${actual}  <-- corrected`);
    } else {
      console.log(`  ${doc.id}: ${actual}`);
    }

    if (!APPLY) continue;

    await doc.ref.set(
      {
        revenueTotalMinorUnits: actual,
        revenueUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    written += 1;
  }

  console.log(
    `\n${APPLY ? "Wrote" : "Would write"} ${APPLY ? written : vendors.length - unchanged}, ` +
    `already correct ${unchanged}, disagreed with rows ${corrected}.`
  );
  if (!APPLY) console.log("Nothing was written. Re-run with --apply.");
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
