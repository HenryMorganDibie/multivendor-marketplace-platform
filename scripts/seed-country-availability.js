/**
 * Populates countryAvailability for every country, per the Founder's decision
 * (2026-08-06): every country ACTIVE by default, except a specific sanctions
 * list held INACTIVE (North Korea, Iran, Cuba — the sub-national exclusions
 * in her list, Crimea/Donetsk/Luhansk/Zaporizhzhia/Kherson, are regions of
 * Ukraine and can't be represented here; countryAvailability is keyed by
 * ISO country code, one doc per country, so Ukraine itself stays ACTIVE and
 * those four regions are NOT excluded by this — see the flag raised
 * alongside this script).
 *
 * Before this ran, countryAvailability had zero documents at all, so
 * isCountryActive() failed closed for every country including Nigeria —
 * no vendor anywhere was discoverable or able to receive an order.
 *
 * Run: node seed-country-availability.js            (dry run)
 *      node seed-country-availability.js --apply     (writes for real)
 */
const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");
const INACTIVE_CODES = new Set(["KP", "IR", "CU"]); // North Korea, Iran, Cuba

if (!admin.apps.length) admin.initializeApp({ projectId: "platform-dev" });
const db = admin.firestore();

async function main() {
  const countriesSnap = await db.collection("countries").get();
  console.log(`Read ${countriesSnap.size} countries.`);

  let active = 0, inactive = 0;
  const batch = db.batch();
  for (const doc of countriesSnap.docs) {
    const code = doc.id;
    const name = doc.data().name ?? code;
    const status = INACTIVE_CODES.has(code) ? "INACTIVE" : "ACTIVE";
    if (status === "ACTIVE") active++; else inactive++;

    batch.set(db.collection("countryAvailability").doc(code), {
      countryCode: code,
      countryName: name,
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: "founder_decision_2026-08-06",
    }, { merge: true });
  }

  console.log(`${active} ACTIVE, ${inactive} INACTIVE (${[...INACTIVE_CODES].join(", ")}).`);
  console.log(APPLY ? "Applying..." : "DRY RUN — pass --apply to write");
  if (APPLY) {
    await batch.commit();
    console.log("Committed.");
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
