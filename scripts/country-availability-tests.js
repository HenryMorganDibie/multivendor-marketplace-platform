/**
 * Country availability, and what it should reach.
 *
 * Switching a country off used to close the front door and leave the back one
 * open: orders and conversations were refused at creation, but every vendor in
 * that country stayed in the listings, searchable and openable. A customer
 * could browse them, fill a basket, and only be refused at checkout.
 *
 * Run:  node country-availability-tests.js   (with the emulator running)
 */
process.env.GCLOUD_PROJECT = "demo-platform";
process.env.GOOGLE_CLOUD_PROJECT = "demo-platform";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const admin = require("firebase-admin");
const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword, connectAuthEmulator } = require("firebase/auth");
const { getFirestore, doc: cdoc, updateDoc, connectFirestoreEmulator } = require("firebase/firestore");

if (!admin.apps.length) admin.initializeApp({ projectId: "demo-platform" });
const fdb = admin.firestore();

const client = initializeApp({ apiKey: "demo", projectId: "demo-platform" }, `ca-${Date.now()}`);
const cauth = getAuth(client);
connectAuthEmulator(cauth, "http://127.0.0.1:9099", { disableWarnings: true });
const cdb = getFirestore(client);
connectFirestoreEmulator(cdb, "127.0.0.1", 8080);

let pass = 0, fail = 0;
const check = (n, label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${n}. ${label}`); }
  else { fail++; console.log(`FAIL  ${n}. ${label}${detail ? `  (${detail})` : ""}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CC = "TG"; // a country nothing else in the suite touches

async function main() {
  const vendorRef = fdb.collection("vendors").doc(`country_test_vendor_${Date.now()}`);

  // A vendor who qualifies for discovery on their own merits.
  await vendorRef.set({
    vendorId: vendorRef.id,
    countryCode: CC,
    businessName: "Country Test Kitchen",
    username: `countrytest${Date.now()}`,
    isPublished: true,
    isVerified: true,
    verificationStatus: "approved",
    vendorStatus: "active",
    isDiscoverable: true,
  });

  // A vendor in the same country who does not qualify: unpublished.
  const unpublishedRef = fdb.collection("vendors").doc(`country_test_unpub_${Date.now()}`);
  await unpublishedRef.set({
    vendorId: unpublishedRef.id,
    countryCode: CC,
    businessName: "Not Published Yet",
    username: `notpub${Date.now()}`,
    isPublished: false,
    isVerified: true,
    verificationStatus: "approved",
    vendorStatus: "active",
    isDiscoverable: false,
  });

  await fdb.collection("countryAvailability").doc(CC).set({ countryCode: CC, status: "ACTIVE" });
  await wait(2500);

  check(1, "A qualifying vendor is discoverable while their country is open",
    (await vendorRef.get()).data().isDiscoverable === true);

  // ── Closing the country hides its vendors ─────────────────────────────────
  await fdb.collection("countryAvailability").doc(CC).set({ countryCode: CC, status: "DISABLED" });
  await wait(3500);

  check(2, "Closing a country hides its vendors from discovery",
    (await vendorRef.get()).data().isDiscoverable === false,
    `isDiscoverable is ${(await vendorRef.get()).data().isDiscoverable}`);

  // ── Reopening restores only those who qualify ─────────────────────────────
  await fdb.collection("countryAvailability").doc(CC).set({ countryCode: CC, status: "ACTIVE" });
  await wait(3500);

  check(3, "Reopening restores a vendor who qualifies",
    (await vendorRef.get()).data().isDiscoverable === true,
    `isDiscoverable is ${(await vendorRef.get()).data().isDiscoverable}`);

  check(4, "Reopening does not promote a vendor who does not qualify",
    (await unpublishedRef.get()).data().isDiscoverable === false,
    "an unpublished vendor was made discoverable");

  // ── An unrelated edit changes nothing ─────────────────────────────────────
  await fdb.collection("countryAvailability").doc(CC).set(
    { countryCode: CC, status: "ACTIVE", displayName: "Togo" }, { merge: true },
  );
  await wait(2500);
  check(5, "Editing a country without changing availability touches no vendor",
    (await vendorRef.get()).data().isDiscoverable === true);

  // ── A vendor cannot move themselves to an open country ────────────────────
  // Closing a country hides its vendors and blocks their orders, and both checks
  // read countryCode off the vendor document. If the owner could edit that field
  // they would simply set it to an open country, reappear in discovery and
  // resume trading, and would then also be missed by the sweep above, which
  // queries on countryCode.
  await signInWithEmailAndPassword(cauth, "demo.vendor@example.com", "DemoPass123!");
  const token = await cauth.currentUser.getIdTokenResult(true);
  const ownVendorId = token.claims.vendorId;

  let countryEditRefused = false;
  try {
    await updateDoc(cdoc(cdb, "vendors", ownVendorId), { countryCode: "GH" });
  } catch {
    countryEditRefused = true;
  }
  check(6, "A vendor cannot change their own countryCode", countryEditRefused,
    "the owner was able to move themselves to another country");

  const stillOriginal = (await fdb.collection("vendors").doc(ownVendorId).get()).data().countryCode;
  check(7, "The vendor's country is unchanged after the attempt",
    stillOriginal === "NG", `countryCode is now ${stillOriginal}`);

  await vendorRef.delete();
  await unpublishedRef.delete();
  await fdb.collection("countryAvailability").doc(CC).delete();

  console.log(`\n${fail === 0 ? "ALL COUNTRY AVAILABILITY TESTS PASSED" : `${fail} FAILURE(S)`}  (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
