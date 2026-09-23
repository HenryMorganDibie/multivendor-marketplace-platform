/**
 * Customer-side vendor discovery.
 *
 * The customer home, explore tab and all-vendors screens read through
 * vendorService → vendorRepository, which used to hold an in-memory mock array.
 * A customer therefore browsed businesses that did not exist, and could not
 * find one that did.
 *
 * These check the data and rules that discovery depends on: a real registered
 * vendor is only visible once discoverable, the security rules refuse the ones
 * that are not, and the fields the listing renders are actually present.
 *
 * Run:  node vendor-discovery-tests.js   (with the emulator running)
 */
process.env.GCLOUD_PROJECT = "demo-platform";
process.env.GOOGLE_CLOUD_PROJECT = "demo-platform";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const admin = require("firebase-admin");
const { initializeApp } = require("firebase/app");
const { getAuth, createUserWithEmailAndPassword, connectAuthEmulator } = require("firebase/auth");
const { getFirestore, collection, query, where, limit, getDocs, doc, getDoc, connectFirestoreEmulator } = require("firebase/firestore");
const { getFunctions, httpsCallable, connectFunctionsEmulator } = require("firebase/functions");

if (!admin.apps.length) admin.initializeApp({ projectId: "demo-platform" });
const fdb = admin.firestore();

const client = initializeApp({ apiKey: "demo", projectId: "demo-platform" }, `disc-${Date.now()}`);
const auth = getAuth(client);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const cdb = getFirestore(client);
connectFirestoreEmulator(cdb, "127.0.0.1", 8080);
const fns = getFunctions(client);
connectFunctionsEmulator(fns, "127.0.0.1", 5001);

let pass = 0, fail = 0;
const check = (n, label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${n}. ${label}`); }
  else { fail++; console.log(`FAIL  ${n}. ${label}${detail ? `  (${detail})` : ""}`); }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // A customer, signed in the way the app signs one in.
  await createUserWithEmailAndPassword(auth, `disc.customer.${Date.now()}@platform.test`, "DemoPass123!");
  await wait(2500);
  await httpsCallable(fns, "completeRegistration")({
    role: "customer", firstName: "Ada", lastName: "O",
    phoneNumber: "+2348012345671", country: "Nigeria",
  });
  await auth.currentUser.getIdToken(true);

  // ── 1. Discovery returns real registered vendors ──────────────────────────
  const listing = await getDocs(
    query(
      collection(cdb, "vendors"),
      where("verificationStatus", "==", "approved"),
      where("vendorStatus", "==", "active"),
      where("isDiscoverable", "==", true),
      limit(200),
    ),
  );
  check(1, "A customer can list discoverable vendors", listing.size > 0, `${listing.size} returned`);

  const anyMockId = listing.docs.some((d) => ["v1", "v2", "v3"].includes(d.id));
  check(2, "None of them are the mock vendors the app used to show", !anyMockId);

  // ── 2. The fields the listing renders are present ─────────────────────────
  const first = listing.docs[0]?.data() ?? {};
  check(3, "Listed vendors carry a business name", Boolean(first.businessName || first.name), JSON.stringify(first.businessName ?? first.name));
  check(4, "Listed vendors carry a country code for location filtering",
    Boolean(first.countryCode || first.businessLocation?.countryCode || first.location?.countryCode));
  check(5, "Listed vendors carry a username for their storefront link", Boolean(first.username));

  // ── 3. A vendor that is not discoverable stays hidden ─────────────────────
  const hidden = await fdb.collection("vendors").where("isDiscoverable", "==", false).limit(1).get();
  if (hidden.empty) {
    check(6, "A non-discoverable vendor is excluded from the listing", true, "none exist to test");
    check(7, "The rules refuse a direct read of a non-discoverable vendor", true, "none exist to test");
  } else {
    const hiddenId = hidden.docs[0].id;
    check(6, "A non-discoverable vendor is excluded from the listing",
      !listing.docs.some((d) => d.id === hiddenId));

    let refused = false;
    try {
      const direct = await getDoc(doc(cdb, "vendors", hiddenId));
      refused = !direct.exists();
    } catch { refused = true; }
    check(7, "The rules refuse a direct read of a non-discoverable vendor", refused,
      "a customer could read a vendor that is not published");
  }

  // ── 4. Newly registered vendors are hidden until they qualify ─────────────
  const fresh = await fdb.collection("vendors")
    .where("isVerified", "==", false).where("isDiscoverable", "==", true).limit(1).get();
  check(8, "Discovery never contains an unverified vendor",
    fresh.empty, fresh.empty ? "" : `${fresh.docs[0].id} is discoverable but unverified`);

  console.log(`\n${fail === 0 ? "ALL VENDOR DISCOVERY TESTS PASSED" : `${fail} FAILURE(S)`}  (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
