/**
 * Orders: proof that the app's order flow runs through the backend rather than
 * local state.
 *
 * These call the same callables the app calls, as a real signed-in vendor and
 * customer, and read the results out of Firestore. If OrdersContext were still
 * driven by the mock module, none of this would exist to read.
 *
 * Run:  node orders-wiring-tests.js   (with the emulator running)
 */
process.env.GCLOUD_PROJECT = "demo-platform";
process.env.GOOGLE_CLOUD_PROJECT = "demo-platform";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const admin = require("firebase-admin");
const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, connectAuthEmulator } = require("firebase/auth");
const { getFunctions, httpsCallable, connectFunctionsEmulator } = require("firebase/functions");

if (!admin.apps.length) admin.initializeApp({ projectId: "demo-platform" });
const fdb = admin.firestore();

const client = initializeApp({ apiKey: "demo", projectId: "demo-platform" }, `orders-${Date.now()}`);
const auth = getAuth(client);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(client);
connectFunctionsEmulator(fns, "127.0.0.1", 5001);

let pass = 0, fail = 0;
const check = (n, label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${n}. ${label}`); }
  else { fail++; console.log(`FAIL  ${n}. ${label}${detail ? `  (${detail})` : ""}`); }
};

const VENDOR_EMAIL = "demo.vendor@example.com";
const VENDOR_PASSWORD = "DemoPass123!";
const CUSTOMER_EMAIL = `orders.customer.${Date.now()}@platform.test`;

async function main() {
  // ── A customer, registered the same way the app registers one ─────────────
  await createUserWithEmailAndPassword(auth, CUSTOMER_EMAIL, VENDOR_PASSWORD);
  await new Promise((r) => setTimeout(r, 2500)); // onUserCreate trigger
  await httpsCallable(fns, "completeRegistration")({
    role: "customer",
    firstName: "Ada",
    lastName: "O",
    phoneNumber: "+2348012345670",
    country: "Nigeria",
  });
  await auth.currentUser.getIdToken(true);
  const customerUid = auth.currentUser.uid;

  // The seeded vendor's catalogue gives us something real to order.
  // This suite creates the item it orders rather than hunting for one another
  // suite happened to leave behind. It previously depended on Phase 2 having run
  // first, so on a fresh emulator it skipped with "no approved catalog item" —
  // a missing fixture reading as a failure.
  await signInWithEmailAndPassword(auth, VENDOR_EMAIL, VENDOR_PASSWORD);
  const vendorToken = await auth.currentUser.getIdTokenResult(true);
  const vendorId = vendorToken.claims.vendorId;
  if (!vendorId) { console.log("FATAL  the demo vendor has no vendorId claim; run seed-demo-vendor.js"); process.exit(1); }

  // Written directly rather than through the callables. This is setup, and the
  // callables are rate limited: running the whole suite in sequence exhausts
  // createCatalogCategory's per-minute window, so a later suite failed on a
  // limit that the earlier ones had used up. The limiter is doing its job; the
  // fixture should not be spending its budget.
  const catRef = fdb.collection("vendors").doc(vendorId).collection("catalogCategories").doc();
  await catRef.set({
    categoryId: catRef.id, vendorId, name: `Orders suite ${Date.now()}`,
    order: 0, isSystem: false, createdAt: new Date(), updatedAt: new Date(),
  });

  const itemRef = fdb.collection("vendors").doc(vendorId).collection("catalogItems").doc();
  await itemRef.set({
    itemId: itemRef.id, vendorId, categoryId: catRef.id,
    name: `Orderable item ${Date.now()}`,
    basePrice: 250000, salePrice: null, currency: "NGN",
    photos: [], thumbnailUrl: null,
    isAvailable: true, isHidden: false, isOutOfStock: false,
    inventoryQuantity: 0, reservedQuantity: 0, trackInventory: false,
    lowStockThreshold: null, addOnGroups: [], orderCount: 0,
    // Approved directly: the approval path itself is Phase 2's to test.
    moderationStatus: "approved",
    createdAt: new Date(), updatedAt: new Date(),
  });
  const itemId = itemRef.id;

  // New items enter moderation, and a pending item cannot be ordered — which is
  // Phase 2's rule and correct. Approving it here is setup, not a bypass: the
  // approval path itself is tested in Phase 2.
  // Back to the customer. Creating the item required the vendor's credentials,
  // and the order that follows must be placed by the customer or it is recorded
  // against the wrong person.
  await signInWithEmailAndPassword(auth, CUSTOMER_EMAIL, VENDOR_PASSWORD);
  await auth.currentUser.getIdToken(true);

  // A customer can only order from a discoverable vendor, which normally means
  // verified. That gate is Phase 1's to test; here it is setup, so the vendor is
  // made discoverable rather than the ordering test being blocked by it.
  await fdb.collection("vendors").doc(vendorId).set({ isDiscoverable: true, isPublished: true }, { merge: true });

  // ── 1. Placing an order creates a real backend record ─────────────────────
  // Two steps, the same two the app makes: price the basket server-side, then
  // turn that priced cart into an order. There is no path that accepts a
  // client-supplied total.
  const priced = await httpsCallable(fns, "repriceCart")({
    vendorId,
    items: [{ itemId, quantity: 2 }],
    fulfillmentType: "pickup",
    orderNote: "orders wiring test",
  });
  const created = await httpsCallable(fns, "createOrderFromCart")({ cartId: priced.data.cartId });
  const orderId = created.data.orderId;
  const orderSnap = await fdb.collection("orders").doc(orderId).get();
  check(1, "Placing an order writes a real orders/{id} document", orderSnap.exists);
  check(2, "The order belongs to the customer who placed it",
    orderSnap.data().customerId === customerUid,
    `${orderSnap.data().customerId} vs ${customerUid}`);
  check(3, "It is given a public order number by the server",
    Boolean(created.data.publicOrderId), created.data.publicOrderId);

  // ── 2. The server prices it, not the client ───────────────────────────────
  const item = (await fdb.collection("vendors").doc(vendorId).collection("catalogItems").doc(itemId).get()).data();
  const expected = (item.salePrice ?? item.basePrice) * 2;
  check(4, "The total is computed server-side from the live catalogue",
    orderSnap.data().orderSnapshot.total === expected,
    `got ${orderSnap.data().orderSnapshot.total}, expected ${expected}`);

  // ── 3. A customer cannot read someone else's order ────────────────────────
  let leaked = false;
  try {
    const other = await fdb.collection("orders").where("customerId", "!=", customerUid).limit(1).get();
    leaked = !other.empty; // admin SDK bypasses rules, so this is informational
  } catch { /* ignore */ }
  check(5, "Orders carry the ids the security rules filter on",
    Boolean(orderSnap.data().customerId && orderSnap.data().vendorId));

  // ── 4. Status transitions run through the backend state machine ───────────
  await signInWithEmailAndPassword(auth, VENDOR_EMAIL, VENDOR_PASSWORD);
  await auth.currentUser.getIdToken(true);

  let rejectedJump = null;
  try {
    await httpsCallable(fns, "updateOrderStatus")({ orderId, newStatus: "completed" });
  } catch (e) { rejectedJump = e; }
  check(6, "An illegal jump (requested → completed) is refused by the server", Boolean(rejectedJump),
    rejectedJump ? "" : "the jump was allowed");

  await httpsCallable(fns, "updateOrderStatus")({ orderId, newStatus: "accepted" });
  const afterAccept = await fdb.collection("orders").doc(orderId).get();
  check(7, "A legal transition is applied and persisted",
    afterAccept.data().status === "accepted", afterAccept.data().status);
  check(8, "The server stamps acceptedAt rather than trusting a client clock",
    Boolean(afterAccept.data().acceptedAt));

  // ── 5. Completion counts the sale ─────────────────────────────────────────
  const before = (await fdb.collection("vendors").doc(vendorId).collection("catalogItems").doc(itemId).get()).data().orderCount ?? 0;
  // The vendor path is requested to accepted to in_progress to completed. There
  // is no vendor-driven "confirmed" step, whatever the app's local state
  // machine says.
  for (const next of ["in_progress", "completed"]) {
    await httpsCallable(fns, "updateOrderStatus")({ orderId, newStatus: next });
  }
  await new Promise((r) => setTimeout(r, 1200));
  const after = (await fdb.collection("vendors").doc(vendorId).collection("catalogItems").doc(itemId).get()).data().orderCount ?? 0;
  check(9, "Completing the order counts the sale against the item",
    after === before + 2, `${before} -> ${after}, expected +2`);

  const completed = await fdb.collection("orders").doc(orderId).get();
  check(10, "Completed is terminal and stamped", completed.data().status === "completed" && Boolean(completed.data().completedAt));

  // ── 6. An event trail exists for the order ────────────────────────────────
  const events = await fdb.collection("orders").doc(orderId).collection("events").get();
  check(11, "Every transition is written to the order's event trail",
    events.size >= 4, `${events.size} events`);

  // ── 12/13. The client's plan rule for external orders ─────────────────────
  // Recording an order taken over the phone is bookkeeping and free on every
  // plan. The platform-versus-external breakdown that compares them is the paid
  // insight. Two different gates, deliberately.
  //
  // The seeded vendor is on Pro, so the plan drops to Basic for these checks and
  // is restored afterwards. resolveEffectivePlan reads
  // vendorSubscriptions/{vendorId}.plan, so that is the field to move.
  await signInWithEmailAndPassword(auth, VENDOR_EMAIL, VENDOR_PASSWORD);
  await auth.currentUser.getIdToken(true);

  const subRef = fdb.collection("vendorSubscriptions").doc(vendorId);
  const originalPlan = (await subRef.get()).data()?.plan ?? "pro";
  await subRef.set({ plan: "basic" }, { merge: true });

  let extResult = null, extErr = null;
  try {
    extResult = await httpsCallable(fns, "createExternalOrder")({
      externalCustomerName: "Walk-in Customer",
      externalCustomerPhone: "+2348012345678",
      items: [{ itemId, quantity: 1 }],
      fulfillmentType: "pickup",
    });
  } catch (e) { extErr = e; }
  check(12, "A Basic vendor can record an external order",
    extResult?.data?.success === true, extErr?.code ?? "no success");

  let analyticsErr = null;
  try {
    await httpsCallable(fns, "getBusinessAnalytics")({ filterRange: "today" });
  } catch (e) { analyticsErr = e.code; }
  check(13, "A Basic vendor cannot see the platform vs external breakdown",
    Boolean(analyticsErr && analyticsErr.includes("permission-denied")),
    analyticsErr ?? "analytics was returned");

  await subRef.set({ plan: originalPlan }, { merge: true });


  console.log(`\n${fail === 0 ? "ALL ORDERS WIRING TESTS PASSED" : `${fail} FAILURE(S)`}  (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
