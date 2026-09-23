/**
 * Copies the real countries catalogue from platform-dev into the local
 * Firestore emulator, so acceptance tests exercise real country data
 * (all 196 countries) instead of a couple of hand-typed fixtures.
 *
 * The emulator starts empty on every run — nothing persists it. Without
 * this, completeRegistration's validateLocation() rejects EVERY country
 * with "<code> is not an available country" (it checks countries/{code}
 * .status === "active", and that collection is empty on a fresh emulator).
 *
 * countryAvailability (a separate, real-commerce-availability flag used by
 * createOrder/repriceCart/chat) is deliberately NOT mirrored here — the real
 * platform-dev project has zero documents in that collection, so there is
 * nothing real to copy. That emptiness is itself worth a look (isCountryActive
 * fails closed by design), not something to fabricate fixtures around.
 *
 * Run once per emulator session, after the emulator is up and before any
 * acceptance test that registers a vendor/customer:
 *   node mirror-countries-to-emulator.js
 */
const admin = require("firebase-admin");

const REAL_PROJECT_ID = "platform-dev";
const EMULATOR_PROJECT_ID = "demo-platform";
const EMULATOR_HOST = "127.0.0.1:8080";
const BATCH_SIZE = 450;

// Two separate named apps in one process: the real app uses default
// (production) settings via GOOGLE_APPLICATION_CREDENTIALS, the emulator
// app is pointed at the local emulator explicitly via .settings(), so
// neither depends on (or fights over) the FIRESTORE_EMULATOR_HOST env var.
const realApp = admin.initializeApp({ projectId: REAL_PROJECT_ID }, "real");
const realDb = realApp.firestore();

const emuApp = admin.initializeApp({ projectId: EMULATOR_PROJECT_ID }, "emulator");
const emuDb = emuApp.firestore();
emuDb.settings({ host: EMULATOR_HOST, ssl: false });

async function main() {
  const snap = await realDb.collection("countries").get();
  console.log(`Read ${snap.size} countries from ${REAL_PROJECT_ID}.`);

  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = emuDb.batch();
    for (const d of docs.slice(i, i + BATCH_SIZE)) {
      batch.set(emuDb.collection("countries").doc(d.id), d.data());
    }
    await batch.commit();
  }
  console.log(`Mirrored ${docs.length} countries into the emulator at ${EMULATOR_HOST}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
