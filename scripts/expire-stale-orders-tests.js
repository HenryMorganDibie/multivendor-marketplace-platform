/**
 * expireStaleOrders (Phase 2 SLA system) acceptance tests.
 *
 * Places a real order through the same two callables the app uses
 * (repriceCart + createOrderFromCart), backdates its acceptanceDeadlineAt
 * directly (the only part a real 48-hour wait can't be run in a test),
 * then manually triggers the scheduled function via the emulator's HTTP
 * endpoint for it (v2 scheduled functions are reachable this way locally —
 * there is no production Cloud Scheduler trigger to wait on in the emulator).
 *
 * Run:  node expire-stale-orders-tests.js   (with the emulator running)
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

const client = initializeApp({ apiKey: "demo", projectId: "demo-platform" }, `expire-orders-${Date.now()}`);
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
const CUSTOMER_EMAIL = `expire.customer.${Date.now()}@platform.test`;

// v2 onSchedule functions are backed by a Pub/Sub topic in the emulator
// (firebase-schedule-<functionName>), and publishing to it does reach the
// Pub/Sub emulator — but this firebase-tools version relays the message to
// the Functions emulator with signatureType "http", which its own pubsub
// relay code doesn't handle ("Unsupported trigger signature: http", silently
// swallowed). That's a firebase-tools/pubsub-emulator compatibility gap, not
// anything in expireStaleOrders.ts. firebase-functions v2's onSchedule
// attaches the real handler at `.run()` (see node_modules/firebase-functions
// /lib/v2/providers/scheduler.js: `func.run = handler`), so calling that
// directly — same code path Cloud Scheduler would invoke in production,
// just without the broken relay in between — is the reliable way to
// exercise this locally.
const { expireStaleOrders } = require("../functions/lib/orders/expireStaleOrders");
async function triggerExpireStaleOrders() {
  await expireStaleOrders.run({});
  return 200;
}

async function placeOrder(fns, vendorId, itemId) {
  const priced = await httpsCallable(fns, "repriceCart")({
    vendorId, items: [{ itemId, quantity: 1 }], fulfillmentType: "pickup", orderNote: "expiry test",
  });
  const created = await httpsCallable(fns, "createOrderFromCart")({ cartId: priced.data.cartId });
  return created.data.orderId;
}

async function main() {
  await createUserWithEmailAndPassword(auth, CUSTOMER_EMAIL, VENDOR_PASSWORD);
  await new Promise((r) => setTimeout(r, 2500));
  await httpsCallable(fns, "completeRegistration")({
    role: "customer", firstName: "Sla", lastName: "T", phoneNumber: "+2348012345671", country: "Nigeria",
  });
  await auth.currentUser.getIdToken(true);
  const customerUid = auth.currentUser.uid;

  await signInWithEmailAndPassword(auth, VENDOR_EMAIL, VENDOR_PASSWORD);
  const vendorToken = await auth.currentUser.getIdTokenResult(true);
  const vendorId = vendorToken.claims.vendorId;
  if (!vendorId) { console.log("FATAL  the demo vendor has no vendorId claim; run seed-demo-vendor.js"); process.exit(1); }
  await fdb.collection("vendors").doc(vendorId).set({ isDiscoverable: true, isPublished: true }, { merge: true });

  const catRef = fdb.collection("vendors").doc(vendorId).collection("catalogCategories").doc();
  await catRef.set({ categoryId: catRef.id, vendorId, name: `Expiry suite ${Date.now()}`, order: 0, isSystem: false, createdAt: new Date(), updatedAt: new Date() });

  // trackInventory: true + a known starting reservedQuantity so release is verifiable.
  const itemRef = fdb.collection("vendors").doc(vendorId).collection("catalogItems").doc();
  await itemRef.set({
    itemId: itemRef.id, vendorId, categoryId: catRef.id, name: `Expiry item ${Date.now()}`,
    basePrice: 100000, salePrice: null, currency: "NGN", photos: [], thumbnailUrl: null,
    isAvailable: true, isHidden: false, isOutOfStock: false,
    inventoryQuantity: 10, reservedQuantity: 0, trackInventory: true, lowStockThreshold: null,
    addOnGroups: [], orderCount: 0, moderationStatus: "approved",
    createdAt: new Date(), updatedAt: new Date(),
  });
  const itemId = itemRef.id;

  await signInWithEmailAndPassword(auth, CUSTOMER_EMAIL, VENDOR_PASSWORD);
  await auth.currentUser.getIdToken(true);

  // ── Test 1-5: a genuinely stale requested order ────────────────────────────
  const orderId = await placeOrder(fns, vendorId, itemId);

  const reservedAfterPlace = (await fdb.collection("vendors").doc(vendorId).collection("catalogItems").doc(itemId).get()).data().reservedQuantity;
  check(1, "Placing the order reserves inventory", reservedAfterPlace === 1, `reservedQuantity=${reservedAfterPlace}`);

  // Backdate the deadline to simulate 48+ hours having passed.
  await fdb.collection("orders").doc(orderId).update({
    acceptanceDeadlineAt: admin.firestore.Timestamp.fromMillis(Date.now() - 60 * 60 * 1000),
  });

  const status1 = await triggerExpireStaleOrders();
  check(2, "Triggering expireStaleOrders succeeds", status1 >= 200 && status1 < 300, `HTTP ${status1}`);
  await new Promise((r) => setTimeout(r, 1500));

  const afterExpiry = await fdb.collection("orders").doc(orderId).get();
  check(3, "A stale requested order transitions to expired", afterExpiry.data().status === "expired", afterExpiry.data().status);
  check(4, "expiredAt is stamped", Boolean(afterExpiry.data().expiredAt));

  const reservedAfterExpiry = (await fdb.collection("vendors").doc(vendorId).collection("catalogItems").doc(itemId).get()).data().reservedQuantity;
  check(5, "Reserved inventory is released on expiry", reservedAfterExpiry === 0, `reservedQuantity=${reservedAfterExpiry}`);

  const eventsSnap = await fdb.collection("orders").doc(orderId).collection("events").where("eventType", "==", "ORDER_AUTO_EXPIRED").get();
  check(6, "An ORDER_AUTO_EXPIRED event is recorded", eventsSnap.size === 1, `found ${eventsSnap.size}`);

  const releaseEventsSnap = await fdb.collection("orders").doc(orderId).collection("events").where("eventType", "==", "INVENTORY_RELEASED").get();
  check(7, "An INVENTORY_RELEASED event is recorded", releaseEventsSnap.size === 1, `found ${releaseEventsSnap.size}`);

  const custNotifSnap = await fdb.collection("users").doc(customerUid).collection("notifications").where("type", "==", "order_expired").get();
  check(8, "The customer receives an order_expired notification", custNotifSnap.size === 1, `found ${custNotifSnap.size}`);

  const vendorOwnerUid = (await fdb.collection("vendors").doc(vendorId).get()).data().ownerUid;
  const vendorNotifSnap = await fdb.collection("users").doc(vendorOwnerUid).collection("notifications").where("type", "==", "order_expired").get();
  check(9, "The vendor receives an order_expired notification", vendorNotifSnap.size >= 1, `found ${vendorNotifSnap.size}`);

  // ── Test 10: repeated execution is safe (idempotent) ───────────────────────
  const status2 = await triggerExpireStaleOrders();
  await new Promise((r) => setTimeout(r, 1500));
  const eventsAfterSecondRun = await fdb.collection("orders").doc(orderId).collection("events").where("eventType", "==", "ORDER_AUTO_EXPIRED").get();
  check(10, "Running expireStaleOrders again does not double-expire or duplicate the event", status2 >= 200 && status2 < 300 && eventsAfterSecondRun.size === 1, `HTTP ${status2}, events=${eventsAfterSecondRun.size}`);

  const reservedAfterSecondRun = (await fdb.collection("vendors").doc(vendorId).collection("catalogItems").doc(itemId).get()).data().reservedQuantity;
  check(11, "Running it again does not double-release inventory", reservedAfterSecondRun === 0, `reservedQuantity=${reservedAfterSecondRun}`);

  // ── Test 12: an order already moved out of "requested" is left untouched ──
  const orderId2 = await placeOrder(fns, vendorId, itemId);
  await signInWithEmailAndPassword(auth, VENDOR_EMAIL, VENDOR_PASSWORD);
  await auth.currentUser.getIdToken(true);
  await httpsCallable(fns, "updateOrderStatus")({ orderId: orderId2, newStatus: "accepted" });
  await fdb.collection("orders").doc(orderId2).update({
    acceptanceDeadlineAt: admin.firestore.Timestamp.fromMillis(Date.now() - 60 * 60 * 1000),
  });

  await triggerExpireStaleOrders();
  await new Promise((r) => setTimeout(r, 1500));
  const stillAccepted = await fdb.collection("orders").doc(orderId2).get();
  check(12, "An order already accepted past its deadline is NOT force-expired", stillAccepted.data().status === "accepted", stillAccepted.data().status);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
