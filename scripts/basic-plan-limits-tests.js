/**
 * Basic plan limits are actually enforced.
 *
 * Basic was tightened from 10 catalogue items, 2 photos and 3 invoices to
 * 7 / 1 / 2, on the view that it was generous enough that nobody upgraded.
 * A limit that is only written in seed data is a number in a file; these check
 * the boundary is refused where a vendor would actually hit it.
 *
 * Each test proves the same shape: the last allowed one succeeds, the next is
 * refused. Testing only the refusal would pass just as well against a limit set
 * to zero.
 *
 * Run:  node basic-plan-limits-tests.js   (with the emulator running)
 */
process.env.GCLOUD_PROJECT = "demo-platform";
process.env.GOOGLE_CLOUD_PROJECT = "demo-platform";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const admin = require("firebase-admin");
const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword, connectAuthEmulator } = require("firebase/auth");
const { getFunctions, httpsCallable, connectFunctionsEmulator } = require("firebase/functions");

if (!admin.apps.length) admin.initializeApp({ projectId: "demo-platform" });
const fdb = admin.firestore();

const client = initializeApp({ apiKey: "demo", projectId: "demo-platform" }, `basic-${Date.now()}`);
const auth = getAuth(client);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(client);
connectFunctionsEmulator(fns, "127.0.0.1", 5001);

let pass = 0, fail = 0;
const check = (n, label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${n}. ${label}`); }
  else { fail++; console.log(`FAIL  ${n}. ${label}${detail ? `  (${detail})` : ""}`); }
};

async function main() {
  await signInWithEmailAndPassword(auth, "demo.vendor@example.com", "DemoPass123!");
  const token = await auth.currentUser.getIdTokenResult(true);
  const vendorId = token.claims.vendorId;

  /**
   * Basic is what a vendor with no subscription gets.
   *
   * The subscription lives at vendorSubscriptions/{vendorId} — the demo vendor
   * is seeded on Pro, so without removing it this measures Pro's limits and
   * passes or fails for the wrong reason.
   *
   * subscriptionPlans/{planId} in Firestore is the live source of limits, not
   * DEFAULT_PLAN_LIMITS in the code: the code is only the fallback for an
   * unseeded environment. So the seeded document has to carry the new numbers
   * too, which is what seedSubscriptionPlans does below.
   */
  await fdb.collection("vendors").doc(vendorId).set({ plan: "basic" }, { merge: true });
  const subRef = fdb.collection("vendorSubscriptions").doc(vendorId);
  const restoreSub = (await subRef.get()).data() ?? null;
  if (restoreSub) await subRef.delete();

  // Written directly rather than through seedSubscriptionPlans, which is
  // admin-only and this suite signs in as a vendor. Only the three fields
  // under test are touched, so the rest of the seeded document stands.
  await fdb.collection("subscriptionPlans").doc("basic").set({
    planLimitsVersion: "v2",
    catalogItemLimit: 7,
    photosPerItemLimit: 1,
    invoicesPerMonth: 2,
  }, { merge: true });

  const status = (await httpsCallable(fns, "getSubscriptionStatus")({})).data;
  check(1, "Basic reports 7 catalogue items, 1 photo, 2 invoices",
    status.planLimits.catalogItemLimit === 7 &&
    status.planLimits.photosPerItemLimit === 1 &&
    status.planLimits.invoicesPerMonth === 2,
    JSON.stringify({
      items: status.planLimits.catalogItemLimit,
      photos: status.planLimits.photosPerItemLimit,
      invoices: status.planLimits.invoicesPerMonth,
    }));

  // ── Catalogue: the eighth item ────────────────────────────────────────────
  const itemsRef = fdb.collection("vendors").doc(vendorId).collection("catalogItems");
  for (const d of (await itemsRef.get()).docs) await d.ref.delete();

  const category = await httpsCallable(fns, "createCatalogCategory")({ name: `Limits ${Date.now()}` });
  const categoryId = category.data.categoryId ?? category.data.id;

  let created = 0;
  for (let i = 1; i <= 7; i++) {
    await httpsCallable(fns, "createCatalogItem")({
      name: `Item ${i}`, basePrice: 100000, categoryId, isAvailable: true,
    });
    created += 1;
  }
  check(2, "Seven catalogue items are allowed", created === 7, `${created} created`);

  let eighth = null;
  try {
    await httpsCallable(fns, "createCatalogItem")({
      name: "Item 8", basePrice: 100000, categoryId, isAvailable: true,
    });
  } catch (e) { eighth = e.code; }
  check(3, "The eighth catalogue item is refused",
    Boolean(eighth?.includes("resource-exhausted")), eighth ?? "it was allowed");

  // ── Photos: the second on one item ────────────────────────────────────────
  const onePhoto = await httpsCallable(fns, "createCatalogItem")({
    name: "Photo test", basePrice: 100000, categoryId, isAvailable: true,
    photos: ["vendorMedia/x/photo1.jpg"],
  }).then(() => "allowed").catch((e) => e.code);
  // This vendor is already at the item limit, so a refusal here must be the
  // item limit rather than the photo one. Freeing a slot keeps the two apart.
  const firstItem = (await itemsRef.limit(1).get()).docs[0];
  if (firstItem) await firstItem.ref.delete();

  const single = await httpsCallable(fns, "createCatalogItem")({
    name: "One photo", basePrice: 100000, categoryId, isAvailable: true,
    photos: ["vendorMedia/x/photo1.jpg"],
  }).then(() => "allowed").catch((e) => e.code);
  check(4, "One photo per item is allowed", single === "allowed", String(single));

  const secondItem = (await itemsRef.limit(1).get()).docs[0];
  if (secondItem) await secondItem.ref.delete();

  let twoPhotos = null;
  try {
    await httpsCallable(fns, "createCatalogItem")({
      name: "Two photos", basePrice: 100000, categoryId, isAvailable: true,
      photos: ["vendorMedia/x/photo1.jpg", "vendorMedia/x/photo2.jpg"],
    });
  } catch (e) { twoPhotos = e.code; }
  check(5, "A second photo on an item is refused",
    Boolean(twoPhotos?.includes("resource-exhausted")), twoPhotos ?? "it was allowed");
  void onePhoto;

  // ── Invoices: the third this month ────────────────────────────────────────
  // The quota counts against a UTC-calendar-month counter, so it is cleared
  // rather than deleting invoices, which would not reset it.
  // invoiceCounters/{YYYY-MM}, not a "quotas" collection. The seed already
  // raises three invoices for this vendor, so without clearing this the first
  // invoice below is refused and the test measures the seed rather than the
  // limit.
  const counters = fdb.collection("vendors").doc(vendorId).collection("invoiceCounters");
  for (const d of (await counters.get()).docs) await d.ref.delete();

  let invoicesMade = 0;
  for (let i = 1; i <= 2; i++) {
    await httpsCallable(fns, "createInvoice")({
      customerName: `Customer ${i}`,
      lineItems: [{ description: "Item", quantity: 1, unitPrice: 100000 }],
    });
    invoicesMade += 1;
  }
  check(6, "Two invoices in a month are allowed", invoicesMade === 2, `${invoicesMade} created`);

  let third = null;
  try {
    await httpsCallable(fns, "createInvoice")({
      customerName: "Customer 3",
      lineItems: [{ description: "Item", quantity: 1, unitPrice: 100000 }],
    });
  } catch (e) { third = e.code; }
  check(7, "The third invoice in a month is refused",
    Boolean(third?.includes("resource-exhausted")), third ?? "it was allowed");

  // Put the demo vendor back on the plan the seed gave it, so running this
  // does not silently downgrade the account every other suite signs in as.
  if (restoreSub) await subRef.set(restoreSub);

  console.log(`\n${fail === 0 ? "ALL BASIC PLAN LIMIT TESTS PASSED" : `${fail} FAILURE(S)`}  (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
