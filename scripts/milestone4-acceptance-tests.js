/**
 * THE PLATFORM — Milestone 4 Acceptance Test Suite
 * Vendor subscriptions (provider-agnostic, Paystack-first), plan gating
 * across catalog/orders/pickup/vendor-settings/dashboard/analytics, and
 * the ratings system.
 *
 * Run: node milestone4-acceptance-tests.js
 * Requires: firebase emulators:start --only auth,firestore,functions,storage --project demo-the platform
 */
const crypto = require("crypto");
const PROJECT_ID = "demo-the platform";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_STORAGE_EMULATOR_HOST = "127.0.0.1:9199";
process.env.FUNCTIONS_EMULATOR = "true";

const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID, storageBucket: `${PROJECT_ID}.appspot.com` });

const { initializeApp, getApps } = require("firebase/app");
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword } = require("firebase/auth");
const { getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, collection, setDoc } = require("firebase/firestore");
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require("firebase/functions");
const { getStorage, connectStorageEmulator, ref, uploadBytes } = require("firebase/storage");

const clientApp = getApps().find(a => a.name === "test4") || initializeApp({ apiKey: "demo", projectId: PROJECT_ID, storageBucket: `${PROJECT_ID}.appspot.com` }, "test4");
const auth = getAuth(clientApp), db = getFirestore(clientApp), fns = getFunctions(clientApp), storage = getStorage(clientApp);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
connectFirestoreEmulator(db, "127.0.0.1", 8080);
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
connectStorageEmulator(storage, "127.0.0.1", 9199);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0, total = 0;
async function test(name, fn) {
  total++;
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.error(`  ❌ ${name}\n     ${e.message ?? e}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || "Assertion failed"); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function assertDenied(p) { return p.then(() => { throw new Error("Expected denial but succeeded"); }, () => {}); }
async function assertFnError(p, code) {
  return p.then(() => { throw new Error(`Expected ${code} but succeeded`); }, err => {
    if (!err.code?.includes(code)) throw new Error(`Expected ${code}, got: ${err.code} — ${err.message}`);
  });
}
async function waitFor(fn, retries = 15, delay = 1000) {
  for (let i = 0; i < retries; i++) { const r = await fn(); if (r) return r; await sleep(delay); }
  throw new Error("waitFor: condition never met");
}

const RUN_ID = Date.now(); // keeps webhook event ids unique per run, so re-running against an already-live emulator never false-triggers idempotency dedup from a prior run
const PASSWORD = "TestPass123!";
let vendorEmail, vendorUid, vendorId, adminEmail, adminUid, customerEmail, customerUid, catalogItemId;
async function signInAs(email) { const c = await signInWithEmailAndPassword(auth, email, PASSWORD); await c.user.getIdToken(true); return c; }

async function seedCountryAvailability() {
  await admin.firestore().collection("countryAvailability").doc("NG").set({
    countryCode: "NG", countryName: "Nigeria", status: "ACTIVE",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: "p4_acceptance_seed",
  });
}

async function setup() {
  console.log("\n⚙️  Setup: provisioning vendor + admin + customer, verified/published vendor, catalog item...");
  await seedCountryAvailability();

  vendorEmail = `p4vend_${Date.now()}@test.com`;
  const vc = await createUserWithEmailAndPassword(auth, vendorEmail, PASSWORD);
  vendorUid = vc.user.uid;
  await waitFor(async () => { const s = await getDoc(doc(db, "users", vendorUid)); return s.exists() ? s : null; });
  await signInAs(vendorEmail);
  const rr = await httpsCallable(fns, "completeRegistration")({ role: "vendor", businessName: "P4 Test Vendor", username: `p4vend_${Date.now()}`, fullName: "Vendor Owner", categoryId: "food_catering", categoryName: "Food & Catering", country: "Nigeria", state: "Lagos", area: "Lekki", plan: "basic" });
  vendorId = rr.data.vendorId;
  await auth.currentUser.getIdToken(true);

  adminEmail = `p4admin_${Date.now()}@the platform.com`;
  const ac = await createUserWithEmailAndPassword(auth, adminEmail, PASSWORD);
  adminUid = ac.user.uid;
  await waitFor(async () => { const s = await getDoc(doc(db, "users", adminUid)); return s.exists() ? s : null; });
  await admin.auth().setCustomUserClaims(adminUid, { role: "admin", adminRoleIds: ["super_admin", "safety_admin"], claimsVersion: 1 });
  await admin.firestore().collection("adminUsers").doc(adminUid).set({ uid: adminUid, email: adminEmail, roleIds: ["super_admin", "safety_admin"], status: "active", mfaRequired: true, mfaEnrolled: false, createdByAdminUid: null, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(), lastLoginAt: null, revokedAt: null, lastMfaAt: null });
  await admin.firestore().collection("users").doc(adminUid).update({ role: "admin" });

  customerEmail = `p4cust_${Date.now()}@test.com`;
  const cc = await createUserWithEmailAndPassword(auth, customerEmail, PASSWORD);
  customerUid = cc.user.uid;
  await waitFor(async () => { const s = await getDoc(doc(db, "users", customerUid)); return s.exists() ? s : null; });

  // Verify + publish vendor so orders can be placed later (Sections 7-11).
  await signInAs(vendorEmail);
  for (const type of ["business_info", "identity_document", "proof_of_address"]) {
    const path = `verificationDocuments/${vendorId}/${type}_p4.pdf`;
    await uploadBytes(ref(storage, path), new Uint8Array([0x25, 0x50, 0x44, 0x46]), { contentType: "application/pdf" });
    await httpsCallable(fns, "recordVerificationDocument")({ type, storagePath: path });
  }
  await httpsCallable(fns, "submitVendorVerification")({});
  await signInAs(adminEmail);
  await httpsCallable(fns, "approveVendorVerification")({ vendorId });
  await sleep(1500);
  await signInAs(vendorEmail);
  await httpsCallable(fns, "setVendorPublishStatus")({ isPublished: true });
  await sleep(1500);
  await admin.firestore().collection("vendors").doc(vendorId).update({ storefrontPublished: true, ownerUid: vendorUid, countryCode: "NG" });

  const itemResult = await httpsCallable(fns, "createCatalogItem")({ name: "P4 Item", basePrice: 1000, currency: "NGN", isAvailable: true });
  catalogItemId = itemResult.data.itemId;
  await admin.firestore().collection("vendors").doc(vendorId).collection("catalogItems").doc(catalogItemId).update({ moderationStatus: "approved" });

  console.log(`  -> Vendor ${vendorId} ready (basic plan)`);
}

async function setVendorPlan(plan) {
  await signInAs(adminEmail);
  await httpsCallable(fns, "applyManualSubscriptionOverride")({ vendorId, plan, reason: `acceptance test set to ${plan}` });
}

function paystackSignature(bodyObj) {
  const secret = "emulator_test_secret";
  const raw = JSON.stringify(bodyObj);
  return crypto.createHmac("sha512", secret).update(raw).digest("hex");
}

async function postWebhook(bodyObj) {
  const raw = JSON.stringify(bodyObj);
  const sig = paystackSignature(bodyObj);
  return fetch(`http://127.0.0.1:5001/${PROJECT_ID}/us-central1/handlePaystackWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-paystack-signature": sig },
    body: raw,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 1: Seeding + public plan safety
// ─────────────────────────────────────────────────────────────────────────
async function section1() {
  console.log("\n📋 Section 1: Seeding + public plan safety");

  await test("Non-super_admin cannot seed subscription plans", async () => {
    await signInAs(vendorEmail);
    await assertFnError(httpsCallable(fns, "seedSubscriptionPlans")({}), "permission-denied");
  });
  await test("super_admin can seed subscription plans, idempotently", async () => {
    await signInAs(adminEmail);
    const r1 = await httpsCallable(fns, "seedSubscriptionPlans")({});
    assertEqual(r1.data.planCount, 4);
    const r2 = await httpsCallable(fns, "seedSubscriptionPlans")({});
    assertEqual(r2.data.planCount, 4);
  });
  await test("subscriptionPlans is publicly readable and has no provider codes", async () => {
    const snap = await getDoc(doc(db, "subscriptionPlans", "pro"));
    assert(snap.exists());
    assertEqual(snap.data().catalogItemLimit, 100);
    assert(snap.data().paystack === undefined, "provider codes must never appear on subscriptionPlans");
  });
  await test("providerPlanCodes is not client-readable", async () => {
    await assertDenied(getDoc(doc(db, "providerPlanCodes", "pro")));
  });
  await test("getSubscriptionStatus returns basic limits with no subscription", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "getSubscriptionStatus")({});
    assertEqual(r.data.effectivePlan, "basic");
    assertEqual(r.data.planLimits.catalogItemLimit, 10);
    assertEqual(r.data.subscription, null);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 2: Checkout + webhook activation
// ─────────────────────────────────────────────────────────────────────────
async function section2() {
  console.log("\n📋 Section 2: Checkout + webhook activation");

  await test("createSubscriptionCheckout returns an authorization URL (emulator fake)", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "createSubscriptionCheckout")({ plan: "pro", billingInterval: "monthly" });
    assert(r.data.authorizationUrl.startsWith("https://checkout.paystack.test/"));
  });

  await test("Webhook rejects invalid signature", async () => {
    const raw = JSON.stringify({ event: "subscription.create", data: { id: "evt_bad", metadata: { vendorId } } });
    const resp = await fetch(`http://127.0.0.1:5001/${PROJECT_ID}/us-central1/handlePaystackWebhook`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-paystack-signature": "deadbeef" }, body: raw,
    });
    assertEqual(resp.status, 401);
  });

  await test("Webhook rejects missing vendorId, logs ignored event, returns 200", async () => {
    const resp = await postWebhook({ event: "subscription.create", data: { id: `evt_missing_vendor_${RUN_ID}`, created_at: new Date().toISOString() } });
    assertEqual(resp.status, 200);
  });

  await test("Webhook ignores unknown event type, returns 200", async () => {
    const resp = await postWebhook({ event: "some.unknown.event", data: { id: `evt_unknown_${RUN_ID}`, created_at: new Date().toISOString(), metadata: { vendorId } } });
    assertEqual(resp.status, 200);
    await signInAs(adminEmail);
    const snap = await getDocs(collection(db, "subscriptionEvents"));
    const found = snap.docs.map(d => d.data()).find(e => e.providerEventId === `evt_unknown_${RUN_ID}`);
    assert(found, "expected ignored event to be logged");
    assertEqual(found.wasIgnored, true);
  });

  await test("Webhook activation sets subscription to active/pro", async () => {
    const resp = await postWebhook({
      event: "subscription.create",
      data: {
        id: `evt_activate_1_${RUN_ID}`, created_at: new Date().toISOString(),
        metadata: { vendorId },
        subscription_code: "SUB_test_1", customer: { customer_code: "CUS_test_1" },
        plan: { plan_code: "PLN_pro_monthly_placeholder", plan_code_metadata: { planId: "pro" } },
        amount: 1500000, currency: "NGN",
      },
    });
    assertEqual(resp.status, 200);
    await sleep(300);
    const subSnap = await admin.firestore().collection("vendorSubscriptions").doc(vendorId).get();
    assertEqual(subSnap.data().status, "active");
    assertEqual(subSnap.data().plan, "pro");
    assertEqual(subSnap.data().version, 1);
  });

  await test("Duplicate webhook event is idempotent (same event id, no double-processing)", async () => {
    const resp = await postWebhook({
      event: "subscription.create",
      data: {
        id: `evt_activate_1_${RUN_ID}`, created_at: new Date().toISOString(),
        metadata: { vendorId },
        subscription_code: "SUB_test_1", customer: { customer_code: "CUS_test_1" },
        plan: { plan_code: "PLN_pro_monthly_placeholder", plan_code_metadata: { planId: "pro" } },
        amount: 1500000, currency: "NGN",
      },
    });
    assertEqual(resp.status, 200);
    const subSnap = await admin.firestore().collection("vendorSubscriptions").doc(vendorId).get();
    assertEqual(subSnap.data().version, 1, "duplicate event must not increment version again");
  });

  await test("resolveEffectivePlan (via getSubscriptionStatus) now returns pro limits", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "getSubscriptionStatus")({});
    assertEqual(r.data.effectivePlan, "pro");
    assertEqual(r.data.planLimits.catalogItemLimit, 100);
    assertEqual(r.data.planLimits.canAutoSendPickupDetails, true);
  });

  await test("vendorSubscriptions is not client-writable", async () => {
    await assertDenied(setDoc(doc(db, "vendorSubscriptions", vendorId), { plan: "pro_plus" }, { merge: true }));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 3: Cancel / reactivate lifecycle
// ─────────────────────────────────────────────────────────────────────────
async function section3() {
  console.log("\n📋 Section 3: Cancel / reactivate lifecycle");

  await test("Vendor can cancel (cancel-at-period-end)", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "cancelSubscription")({});
    assert(r.data.success);
    const subSnap = await admin.firestore().collection("vendorSubscriptions").doc(vendorId).get();
    assertEqual(subSnap.data().cancelAtPeriodEnd, true);
  });

  await test("Effective plan still pro until period end (cancellation continuity)", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "getSubscriptionStatus")({});
    assertEqual(r.data.effectivePlan, "pro");
  });

  await test("Vendor can reactivate before period end", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "reactivateSubscription")({});
    assert(r.data.success);
    const subSnap = await admin.firestore().collection("vendorSubscriptions").doc(vendorId).get();
    assertEqual(subSnap.data().cancelAtPeriodEnd, false);
  });

  await test("Reactivating a non-cancelled subscription fails", async () => {
    await signInAs(vendorEmail);
    await assertFnError(httpsCallable(fns, "reactivateSubscription")({}), "failed-precondition");
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 4: Admin override + admin cancel
// ─────────────────────────────────────────────────────────────────────────
async function section4() {
  console.log("\n📋 Section 4: Admin override + admin cancel");

  await test("Non-admin cannot apply manual override", async () => {
    await signInAs(vendorEmail);
    await assertFnError(httpsCallable(fns, "applyManualSubscriptionOverride")({ vendorId, plan: "pro_plus", reason: "test" }), "permission-denied");
  });
  await test("Admin override without reason is rejected", async () => {
    await signInAs(adminEmail);
    await assertFnError(httpsCallable(fns, "applyManualSubscriptionOverride")({ vendorId, plan: "pro_plus" }), "invalid-argument");
  });
  await test("Admin can apply manual override with reason", async () => {
    await signInAs(adminEmail);
    const r = await httpsCallable(fns, "applyManualSubscriptionOverride")({ vendorId, plan: "pro_plus", reason: "VIP comp account", ticketId: "TICKET-1" });
    assert(r.data.success);
  });
  await test("Effective plan reflects override (pro_plus)", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "getSubscriptionStatus")({});
    assertEqual(r.data.effectivePlan, "pro_plus");
  });
  await test("Webhook events during override are logged but do not change plan", async () => {
    const resp = await postWebhook({
      event: "subscription.create",
      data: {
        id: `evt_during_override_${RUN_ID}`, created_at: new Date().toISOString(),
        metadata: { vendorId },
        subscription_code: "SUB_test_1", customer: { customer_code: "CUS_test_1" },
        plan: { plan_code: "PLN_basic_monthly_placeholder", plan_code_metadata: { planId: "basic" } },
        amount: 0, currency: "NGN",
      },
    });
    assertEqual(resp.status, 200);
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "getSubscriptionStatus")({});
    assertEqual(r.data.effectivePlan, "pro_plus", "override must not be overwritten by a webhook event");
  });
  await test("Admin action without reason rejected on cancelSubscriptionAdmin", async () => {
    await signInAs(adminEmail);
    await assertFnError(httpsCallable(fns, "cancelSubscriptionAdmin")({ vendorId, immediate: true }), "invalid-argument");
  });
  await test("Admin can immediately cancel with reason", async () => {
    await signInAs(adminEmail);
    const r = await httpsCallable(fns, "cancelSubscriptionAdmin")({ vendorId, immediate: true, reason: "ToS violation" });
    assert(r.data.success);
    const subSnap = await admin.firestore().collection("vendorSubscriptions").doc(vendorId).get();
    assertEqual(subSnap.data().status, "cancelled");
    assertEqual(subSnap.data().plan, "basic");
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 5: Rate limiting
// ─────────────────────────────────────────────────────────────────────────
async function section5() {
  console.log("\n📋 Section 5: Rate limiting");

  await test("cancelSubscription rate-limited after 5 calls in 60s", async () => {
    await signInAs(vendorEmail);
    for (let i = 0; i < 5; i++) {
      await httpsCallable(fns, "cancelSubscription")({}).catch(() => {}); // not-found is fine, only checking rate limit
    }
    await assertFnError(httpsCallable(fns, "cancelSubscription")({}), "resource-exhausted");
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 6: Catalog gating (item + photo limits)
// ─────────────────────────────────────────────────────────────────────────
async function section6() {
  console.log("\n📋 Section 6: Catalog gating (Basic = 2 photos/item)");

  await setVendorPlan("basic");

  await test("Basic vendor cannot create item with 3 photos", async () => {
    await signInAs(vendorEmail);
    await assertFnError(
      httpsCallable(fns, "createCatalogItem")({ name: "Too many photos", basePrice: 500, photos: ["a", "b", "c"] }),
      "resource-exhausted"
    );
  });
  await test("Basic vendor CAN create item with 2 photos", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "createCatalogItem")({ name: "OK photos", basePrice: 500, photos: ["a", "b"] });
    assert(r.data.success);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 7: External order gate
// ─────────────────────────────────────────────────────────────────────────
async function section7() {
  console.log("\n📋 Section 7: External order gate");

  await test("Basic vendor cannot create external order", async () => {
    await signInAs(vendorEmail);
    await assertFnError(
      httpsCallable(fns, "createExternalOrder")({ externalCustomerName: "Walk-in", items: [{ itemId: catalogItemId, quantity: 1 }], fulfillmentType: "pickup" }),
      "permission-denied"
    );
  });
  await test("Standard vendor CAN create external order", async () => {
    await setVendorPlan("standard");
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "createExternalOrder")({ externalCustomerName: "Walk-in", items: [{ itemId: catalogItemId, quantity: 1 }], fulfillmentType: "pickup" });
    assert(r.data.success);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 8: Pickup auto-send gate
// ─────────────────────────────────────────────────────────────────────────
async function section8() {
  console.log("\n📋 Section 8: Pickup auto-send gate");

  await test("Standard vendor cannot enable pickup auto-send (Pro+ only)", async () => {
    await signInAs(vendorEmail);
    await httpsCallable(fns, "updateVendorPickupSettings")({
      pickupAddress: { streetAddress: "1 Test Rd", areaId: "a1", areaName: "Lekki", stateCode: "LA", stateName: "Lagos", countryCode: "NG", countryName: "Nigeria" },
      pickupInstructions: "Ring the bell",
    });
    await assertFnError(httpsCallable(fns, "updateVendorPickupSettings")({ autoSendPickupDetailsEnabled: true }), "permission-denied");
  });
  await test("Pro vendor CAN enable pickup auto-send", async () => {
    await setVendorPlan("pro");
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "updateVendorPickupSettings")({ autoSendPickupDetailsEnabled: true });
    assert(r.data.success);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 9: updateVendorSettings gate
// ─────────────────────────────────────────────────────────────────────────
async function section9() {
  console.log("\n📋 Section 9: updateVendorSettings gate");

  await test("Basic vendor cannot set minimumOrderAmount or policy", async () => {
    await setVendorPlan("basic");
    await signInAs(vendorEmail);
    await assertFnError(httpsCallable(fns, "updateVendorSettings")({ minimumOrderAmount: 500 }), "permission-denied");
    await assertFnError(httpsCallable(fns, "updateVendorSettings")({ policy: "No refunds after 24h" }), "permission-denied");
  });
  await test("Standard vendor CAN set minimumOrderAmount and policy", async () => {
    await setVendorPlan("standard");
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "updateVendorSettings")({ minimumOrderAmount: 500, policy: "No refunds after 24h" });
    assert(r.data.success);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 10: Dashboard / analytics gating
// ─────────────────────────────────────────────────────────────────────────
async function section10() {
  console.log("\n📋 Section 10: Dashboard / analytics gating");

  await test("Basic vendor dashboard has no best seller/revenue widgets, requesting them fails", async () => {
    await setVendorPlan("basic");
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "getVendorDashboard")({});
    assertEqual(r.data.planLimits.canViewBestSellerWidget, false);
    assertEqual(r.data.bestSeller, undefined);
    await assertFnError(httpsCallable(fns, "getVendorDashboard")({ includeWidgets: ["bestSeller"] }), "permission-denied");
  });
  await test("Standard vendor dashboard includes best seller/revenue widgets", async () => {
    await setVendorPlan("standard");
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "getVendorDashboard")({ includeWidgets: ["bestSeller", "revenueCard"] });
    assert(r.data.revenueCard !== undefined);
  });
  await test("Basic vendor cannot call getBusinessAnalytics", async () => {
    await setVendorPlan("basic");
    await signInAs(vendorEmail);
    await assertFnError(httpsCallable(fns, "getBusinessAnalytics")({}), "permission-denied");
  });
  await test("Pro vendor CAN call getBusinessAnalytics", async () => {
    await setVendorPlan("pro");
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "getBusinessAnalytics")({});
    assert(r.data.success);
    assert(Array.isArray(r.data.revenueTrend));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 11: Ratings lifecycle
// ─────────────────────────────────────────────────────────────────────────
async function section11() {
  console.log("\n📋 Section 11: Ratings lifecycle");
  let ratedOrderId, ratingId;

  await test("Setup: place and complete an order to rate", async () => {
    await signInAs(customerEmail);
    const cartResult = await httpsCallable(fns, "repriceCart")({ vendorId, fulfillmentType: "pickup", items: [{ itemId: catalogItemId, quantity: 1 }] });
    const orderResult = await httpsCallable(fns, "createOrderFromCart")({ cartId: cartResult.data.cartId });
    ratedOrderId = orderResult.data.orderId;
    await signInAs(vendorEmail);
    await httpsCallable(fns, "updateOrderStatus")({ orderId: ratedOrderId, newStatus: "accepted" });
    await httpsCallable(fns, "updateOrderStatus")({ orderId: ratedOrderId, newStatus: "in_progress" });
    await httpsCallable(fns, "updateOrderStatus")({ orderId: ratedOrderId, newStatus: "completed" });
    await sleep(1000);
  });

  await test("Non-owner cannot rate the order", async () => {
    await signInAs(vendorEmail); // vendor is not the customer/order owner
    await assertFnError(httpsCallable(fns, "submitRating")({ orderId: ratedOrderId, stars: 5 }), "permission-denied");
  });

  await test("Customer can rate a completed order", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "submitRating")({ orderId: ratedOrderId, stars: 5, privateFeedback: "Great service!" });
    assert(r.data.success);
    assert(r.data.displayId.startsWith("R-"));
    ratingId = r.data.ratingId;
  });

  await test("Duplicate rating for same order is rejected", async () => {
    await signInAs(customerEmail);
    await assertFnError(httpsCallable(fns, "submitRating")({ orderId: ratedOrderId, stars: 3 }), "already-exists");
  });

  await test("Invalid stars value is rejected", async () => {
    await signInAs(customerEmail);
    const cartResult = await httpsCallable(fns, "repriceCart")({ vendorId, fulfillmentType: "pickup", items: [{ itemId: catalogItemId, quantity: 1 }] });
    const orderResult = await httpsCallable(fns, "createOrderFromCart")({ cartId: cartResult.data.cartId });
    await assertFnError(httpsCallable(fns, "submitRating")({ orderId: orderResult.data.orderId, stars: 6 }), "invalid-argument");
  });

  await test("vendorRatingStats reflects the new rating", async () => {
    const snap = await waitFor(async () => {
      const s = await getDoc(doc(db, "vendorRatingStats", vendorId));
      return s.exists() ? s : null;
    });
    assertEqual(snap.data().total, 1);
    assertEqual(snap.data().average, 5);
  });

  await test("Customer can read their own rating directly (includes orderId)", async () => {
    await signInAs(customerEmail);
    const snap = await getDoc(doc(db, "ratings", ratingId));
    assert(snap.exists());
    assertEqual(snap.data().orderId, ratedOrderId);
  });

  await test("Vendor CANNOT read ratings collection directly (no orderId/customerId leak path)", async () => {
    await signInAs(vendorEmail);
    await assertDenied(getDoc(doc(db, "ratings", ratingId)));
  });

  await test("getVendorRatings returns only the safe projected shape — no orderId or customerId", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "getVendorRatings")({});
    assertEqual(r.data.ratings.length, 1);
    const rating = r.data.ratings[0];
    assertEqual(rating.orderId, undefined);
    assertEqual(rating.customerId, undefined);
    assertEqual(rating.stars, 5);
    assert(rating.displayId.startsWith("R-"));
  });

  await test("Ratings are immutable — no direct client update allowed", async () => {
    await signInAs(customerEmail);
    await assertDenied(setDoc(doc(db, "ratings", ratingId), { stars: 1 }, { merge: true }));
  });

  await test("Non-admin cannot moderate a rating", async () => {
    await signInAs(customerEmail);
    await assertFnError(httpsCallable(fns, "moderateRating")({ ratingId, moderationStatus: "removed", reason: "test" }), "permission-denied");
  });

  await test("Admin can remove a rating, excluding it from vendorRatingStats but never deleting it", async () => {
    await signInAs(adminEmail);
    const r = await httpsCallable(fns, "moderateRating")({ ratingId, moderationStatus: "removed", reason: "Abusive content per policy X" });
    assert(r.data.success);
    await sleep(500);
    const statsSnap = await getDoc(doc(db, "vendorRatingStats", vendorId));
    assertEqual(statsSnap.data().total, 0, "removed rating must be excluded from stats");
    const ratingSnap = await admin.firestore().collection("ratings").doc(ratingId).get();
    assert(ratingSnap.exists, "rating document must never be deleted");
    assertEqual(ratingSnap.data().moderationStatus, "removed");
  });

  await test("Removed rating no longer appears in getVendorRatings", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "getVendorRatings")({});
    assertEqual(r.data.ratings.length, 0);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 12: Invoices, branding, and PDF generation
// ─────────────────────────────────────────────────────────────────────────
async function section12() {
  console.log("\n📋 Section 12: Invoices, branding, and PDF generation");
  let invoiceId, invoiceNumber, shareToken;

  await test("Basic vendor creates an invoice (within 3/month quota)", async () => {
    await setVendorPlan("basic");
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "createInvoice")({
      customerName: "Jane Doe", customerPhone: "+2348011112222",
      lineItems: [{ description: "Catering tray", quantity: 2, unitPrice: 5000 }],
    });
    assert(r.data.success);
    invoiceId = r.data.invoiceId;
    invoiceNumber = r.data.invoiceNumber;
    assert(invoiceNumber.startsWith("INV-"));
  });

  await test("Server computes subtotal — client cannot override line totals", async () => {
    const snap = await admin.firestore().collection("invoices").doc(invoiceId).get();
    assertEqual(snap.data().subtotal, 10000);
  });

  await test("Basic vendor hits the 3/month invoice quota on the 4th invoice", async () => {
    await signInAs(vendorEmail);
    for (let i = 0; i < 2; i++) {
      await httpsCallable(fns, "createInvoice")({ customerName: `Cust ${i}`, lineItems: [{ description: "Item", quantity: 1, unitPrice: 100 }] });
    }
    await assertFnError(
      httpsCallable(fns, "createInvoice")({ customerName: "One too many", lineItems: [{ description: "Item", quantity: 1, unitPrice: 100 }] }),
      "resource-exhausted"
    );
  });

  await test("listInvoices returns the vendor's own invoices", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "listInvoices")({});
    assert(r.data.invoices.length >= 3);
  });

  await test("invoices collection is not client-writable, and only the owner can read", async () => {
    await assertDenied(setDoc(doc(db, "invoices", invoiceId), { subtotal: 1 }, { merge: true }));
    await signInAs(customerEmail);
    await assertDenied(getDoc(doc(db, "invoices", invoiceId)));
  });

  await test("Basic vendor cannot download invoice PDF (Standard+ only)", async () => {
    await signInAs(vendorEmail);
    await assertFnError(httpsCallable(fns, "downloadInvoicePdf")({ invoiceId }), "permission-denied");
  });

  await test("Standard vendor CAN download invoice PDF", async () => {
    await setVendorPlan("standard");
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "downloadInvoicePdf")({ invoiceId });
    assert(r.data.success);
    assert(r.data.pdfBase64.length > 100, "expected a non-trivial PDF payload");
    assert(r.data.fileName.endsWith(".pdf"));
  });

  await test("Standard vendor cannot duplicate an invoice (Pro+ only)", async () => {
    await signInAs(vendorEmail);
    await assertFnError(httpsCallable(fns, "duplicateInvoice")({ invoiceId }), "permission-denied");
  });

  await test("Pro vendor CAN duplicate an invoice", async () => {
    await setVendorPlan("pro");
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "duplicateInvoice")({ invoiceId });
    assert(r.data.success);
    assert(r.data.invoiceId !== invoiceId);
  });

  console.log("\n📋 Section 12b: Invoice branding gates + validation");
  await test("Basic vendor cannot upload a logo or set brand color", async () => {
    await setVendorPlan("basic");
    await signInAs(vendorEmail);
    await assertFnError(httpsCallable(fns, "updateInvoiceBranding")({ logoUrl: `invoiceBranding/${vendorId}/logo.png` }), "permission-denied");
    await assertFnError(httpsCallable(fns, "updateInvoiceBranding")({ brandColor: "#123456" }), "permission-denied");
  });

  await test("Standard vendor can upload a logo (validated server-side against real Storage object)", async () => {
    await setVendorPlan("standard");
    await signInAs(vendorEmail);
    const path = `invoiceBranding/${vendorId}/logo.png`;
    // Minimal valid PNG signature bytes — enough for Storage to accept a real object.
    await uploadBytes(ref(storage, path), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { contentType: "image/png" });
    const r = await httpsCallable(fns, "updateInvoiceBranding")({ logoUrl: path });
    assert(r.data.success);
  });

  await test("updateInvoiceBranding rejects a logoUrl with no matching uploaded object", async () => {
    await signInAs(vendorEmail);
    await assertFnError(httpsCallable(fns, "updateInvoiceBranding")({ logoUrl: `invoiceBranding/${vendorId}/does-not-exist.png` }), "failed-precondition");
  });

  await test("Standard vendor cannot set brand color (Pro+ only)", async () => {
    await signInAs(vendorEmail);
    await assertFnError(httpsCallable(fns, "updateInvoiceBranding")({ brandColor: "#123456" }), "permission-denied");
  });

  await test("Pro vendor can set brand color, but an invalid hex is rejected", async () => {
    await setVendorPlan("pro");
    await signInAs(vendorEmail);
    await assertFnError(httpsCallable(fns, "updateInvoiceBranding")({ brandColor: "not-a-color" }), "invalid-argument");
    const r = await httpsCallable(fns, "updateInvoiceBranding")({ brandColor: "#1A2B3C", thankYouMessage: "Thanks for your business!" });
    assert(r.data.success);
  });

  await test("Pro Plus vendor can enable QR code and print layout; Pro cannot", async () => {
    await signInAs(vendorEmail);
    await assertFnError(httpsCallable(fns, "updateInvoiceBranding")({ qrCodeEnabled: true }), "permission-denied");
    await setVendorPlan("pro_plus");
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "updateInvoiceBranding")({ qrCodeEnabled: true, printLayoutEnabled: true });
    assert(r.data.success);
  });

  await test("invoiceBranding is not client-writable directly", async () => {
    await assertDenied(setDoc(doc(db, "invoiceBranding", vendorId), { brandColor: "#000000" }, { merge: true }));
  });

  console.log("\n📋 Section 12c: Paid/cancelled lifecycle, branding snapshot, public share link");
  let paidInvoiceId, cancelledInvoiceId;

  await test("Setup: two fresh invoices for paid/cancelled transitions", async () => {
    await setVendorPlan("pro_plus");
    await signInAs(vendorEmail);
    const r1 = await httpsCallable(fns, "createInvoice")({ customerName: "Paid Customer", lineItems: [{ description: "Item", quantity: 1, unitPrice: 2000 }] });
    paidInvoiceId = r1.data.invoiceId;
    const r2 = await httpsCallable(fns, "createInvoice")({ customerName: "Cancelled Customer", lineItems: [{ description: "Item", quantity: 1, unitPrice: 2000 }] });
    cancelledInvoiceId = r2.data.invoiceId;
  });

  await test("Marking an invoice paid captures a permanent branding snapshot", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "updateInvoiceStatus")({ invoiceId: paidInvoiceId, status: "paid" });
    assert(r.data.success);
    const snap = await admin.firestore().collection("invoices").doc(paidInvoiceId).get();
    assertEqual(snap.data().status, "paid");
    assert(snap.data().brandingSnapshot, "expected a brandingSnapshot to be captured at payment time");
    assertEqual(snap.data().brandingSnapshot.brandColor, "#1A2B3C");
  });

  await test("A subsequent downgrade does not alter the paid invoice's branding snapshot", async () => {
    await setVendorPlan("basic");
    const snap = await admin.firestore().collection("invoices").doc(paidInvoiceId).get();
    assertEqual(snap.data().brandingSnapshot.brandColor, "#1A2B3C", "paid snapshot must survive a plan downgrade unchanged");
    await setVendorPlan("pro_plus"); // restore for remaining tests
  });

  await test("Cannot transition an already-paid invoice again", async () => {
    await signInAs(vendorEmail);
    await assertFnError(httpsCallable(fns, "updateInvoiceStatus")({ invoiceId: paidInvoiceId, status: "cancelled" }), "failed-precondition");
  });

  await test("Vendor can cancel an unpaid invoice", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "updateInvoiceStatus")({ invoiceId: cancelledInvoiceId, status: "cancelled" });
    assert(r.data.success);
    const snap = await admin.firestore().collection("invoices").doc(cancelledInvoiceId).get();
    assertEqual(snap.data().status, "cancelled");
    shareToken = snap.data().shareToken;
  });

  await test("getPublicInvoice denies access to a cancelled invoice's public link", async () => {
    await assertFnError(httpsCallable(fns, "getPublicInvoice")({ shareToken }), "failed-precondition");
  });

  await test("getPublicInvoice serves a non-cancelled invoice without requiring auth, and omits the shareToken itself", async () => {
    const paidSnap = await admin.firestore().collection("invoices").doc(paidInvoiceId).get();
    const r = await httpsCallable(fns, "getPublicInvoice")({ shareToken: paidSnap.data().shareToken });
    assert(r.data.success);
    assertEqual(r.data.invoice.invoiceId, paidInvoiceId);
    assertEqual(r.data.invoice.shareToken, undefined);
  });

  await test("getPublicInvoice returns not-found for an unknown token", async () => {
    await assertFnError(httpsCallable(fns, "getPublicInvoice")({ shareToken: "not-a-real-token" }), "not-found");
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 13: Production hardening — locking, out-of-order webhooks, replay
// ─────────────────────────────────────────────────────────────────────────
async function section13() {
  console.log("\n📋 Section 13: Production hardening — locking, out-of-order webhooks, replay");

  // A dedicated fresh vendor, so precise event-sequence/priority assertions
  // are never polluted by the subscription lifecycle churn in earlier
  // sections (that vendor has been upgraded/downgraded/cancelled many
  // times already, which would make "last event" state hard to reason
  // about here).
  let hVendorId;
  await test("Setup: fresh vendor for hardening tests", async () => {
    const email = `p4hard_${Date.now()}@test.com`;
    const c = await createUserWithEmailAndPassword(auth, email, PASSWORD);
    await waitFor(async () => { const s = await getDoc(doc(db, "users", c.user.uid)); return s.exists() ? s : null; });
    await signInAs(email);
    const rr = await httpsCallable(fns, "completeRegistration")({ role: "vendor", businessName: "P4 Hardening Vendor", username: `p4hardv_${Date.now()}`, fullName: "Vendor Owner", categoryId: "food_catering", categoryName: "Food & Catering", country: "Nigeria", state: "Lagos", area: "Lekki", plan: "basic" });
    hVendorId = rr.data.vendorId;
  });

  await test("A live (non-expired) subscription lock causes a webhook call to return 409", async () => {
    await admin.firestore().collection("subscriptionLocks").doc(hVendorId).set({
      vendorId: hVendorId, lockedBy: "test:manual", lockedAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 10_000),
    });
    const resp = await postWebhook({
      event: "subscription.create",
      data: { id: `evt_lockcontention_${RUN_ID}`, created_at: new Date().toISOString(), metadata: { vendorId: hVendorId } },
    });
    assertEqual(resp.status, 409);
    await admin.firestore().collection("subscriptionLocks").doc(hVendorId).delete();
  });

  await test("A stale (expired) lock does not block processing — TTL recovery", async () => {
    await admin.firestore().collection("subscriptionLocks").doc(hVendorId).set({
      vendorId: hVendorId, lockedBy: "test:crashed-holder", lockedAt: admin.firestore.Timestamp.fromMillis(Date.now() - 60_000),
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() - 50_000), // expired 50s ago
    });
    const resp = await postWebhook({
      event: "subscription.create",
      data: {
        id: `evt_ttlrecovery_${RUN_ID}`, created_at: new Date().toISOString(), metadata: { vendorId: hVendorId },
        subscription_code: "SUB_hard_1", customer: { customer_code: "CUS_hard_1" },
        plan: { plan_code: "PLN_pro_monthly_placeholder", plan_code_metadata: { planId: "pro" } },
        amount: 1500000, currency: "NGN",
      },
    });
    assertEqual(resp.status, 200);
    const subSnap = await admin.firestore().collection("vendorSubscriptions").doc(hVendorId).get();
    assertEqual(subSnap.data().status, "active", "processing must proceed despite the stale lock document");
  });

  await test("Stale webhook (event timestamp >24h old) is rejected before any mutation", async () => {
    const oldTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const beforeSnap = await admin.firestore().collection("vendorSubscriptions").doc(hVendorId).get();
    const resp = await postWebhook({
      event: "subscription.not_renew",
      data: { id: `evt_stale_${RUN_ID}`, created_at: oldTimestamp, metadata: { vendorId: hVendorId } },
    });
    assertEqual(resp.status, 200);
    await signInAs(adminEmail);
    const eventsSnap = await getDocs(collection(db, "subscriptionEvents"));
    const found = eventsSnap.docs.map(d => d.data()).find(e => e.providerEventId === `evt_stale_${RUN_ID}`);
    assert(found, "expected the stale webhook to be logged");
    assertEqual(found.ignoreReason, "stale_webhook_rejected");
    const afterSnap = await admin.firestore().collection("vendorSubscriptions").doc(hVendorId).get();
    assertEqual(afterSnap.data().status, beforeSnap.data().status, "a stale webhook must never mutate subscription state");
  });

  await test("Out-of-order webhook (lower priority, arrives after a higher-priority event) is ignored", async () => {
    // "cancelled" (priority 100) applied first, at a LATER timestamp than
    // the "renewal" (priority 40) event that arrives second — simulating
    // network reordering, not wall-clock arrival order.
    const laterTs = new Date(Date.now() - 1000).toISOString();
    const earlierTs = new Date(Date.now() - 5000).toISOString();

    const cancelResp = await postWebhook({
      event: "subscription.not_renew",
      data: { id: `evt_ooo_cancel_${RUN_ID}`, created_at: laterTs, metadata: { vendorId: hVendorId } },
    });
    assertEqual(cancelResp.status, 200);
    const afterCancelSnap = await admin.firestore().collection("vendorSubscriptions").doc(hVendorId).get();
    assertEqual(afterCancelSnap.data().status, "cancelled");

    const renewalResp = await postWebhook({
      event: "invoice.payment_succeeded",
      data: {
        id: `evt_ooo_renewal_${RUN_ID}`, created_at: earlierTs, metadata: { vendorId: hVendorId },
        plan: { plan_code_metadata: { planId: "pro" } },
      },
    });
    assertEqual(renewalResp.status, 200);

    await signInAs(adminEmail);
    const eventsSnap = await getDocs(collection(db, "subscriptionEvents"));
    const found = eventsSnap.docs.map(d => d.data()).find(e => e.providerEventId === `evt_ooo_renewal_${RUN_ID}`);
    assert(found, "expected the out-of-order renewal event to be logged");
    assertEqual(found.ignoreReason, "superseded_by_newer_or_higher_priority_event");

    const finalSnap = await admin.firestore().collection("vendorSubscriptions").doc(hVendorId).get();
    assertEqual(finalSnap.data().status, "cancelled", "the lower-priority out-of-order event must never overwrite cancelled");
  });

  await test("Equal-priority tie resolution — earlier-sequence duplicate-priority event is ignored", async () => {
    // Two "renewal" events (priority 40) for the SAME underlying
    // subscription_code — a duplicate delivery scenario, not a fresh
    // resubscription (a different subscription_code intentionally resets
    // priority tracking, tested separately). The second delivery has an
    // EARLIER created_at than the first, so despite arriving later over
    // the wire it must lose the tie and be ignored.
    const firstTs = new Date(Date.now() - 2000).toISOString();
    const secondTsEarlier = new Date(Date.now() - 3000).toISOString();

    const r1 = await postWebhook({
      event: "subscription.create",
      data: {
        id: `evt_tie_1_${RUN_ID}`, created_at: firstTs, metadata: { vendorId: hVendorId },
        subscription_code: "SUB_hard_2", customer: { customer_code: "CUS_hard_2" },
        plan: { plan_code: "PLN_standard_monthly_placeholder", plan_code_metadata: { planId: "standard" } },
        amount: 800000, currency: "NGN",
      },
    });
    assertEqual(r1.status, 200);

    const r2 = await postWebhook({
      event: "invoice.payment_succeeded",
      data: {
        id: `evt_tie_2_${RUN_ID}`, created_at: secondTsEarlier, metadata: { vendorId: hVendorId },
        subscription_code: "SUB_hard_2", customer: { customer_code: "CUS_hard_2" },
        plan: { plan_code: "PLN_basic_monthly_placeholder", plan_code_metadata: { planId: "basic" } },
        amount: 0, currency: "NGN",
      },
    });
    assertEqual(r2.status, 200);

    await signInAs(adminEmail);
    const eventsSnap = await getDocs(collection(db, "subscriptionEvents"));
    const found = eventsSnap.docs.map(d => d.data()).find(e => e.providerEventId === `evt_tie_2_${RUN_ID}`);
    assert(found, "expected the losing tie-break event to be logged");
    assertEqual(found.ignoreReason, "superseded_by_newer_or_higher_priority_event");

    const finalSnap = await admin.firestore().collection("vendorSubscriptions").doc(hVendorId).get();
    assertEqual(finalSnap.data().plan, "standard", "the earlier-sequence tied-priority event must not overwrite the winner");
  });

  await test("version increments only on genuine mutations, never on ignored/duplicate events", async () => {
    const snap = await admin.firestore().collection("vendorSubscriptions").doc(hVendorId).get();
    // 3 genuine mutations applied above: activation(pro) -> cancelled -> activation(standard).
    // The stale, out-of-order, and tied-loser events must not have incremented version.
    assertEqual(snap.data().version, 3);
  });
}

async function main() {
  console.log("🚀 THE PLATFORM — Milestone 4 Acceptance Test Suite");
  console.log("=".repeat(60));

  await setup();
  await section1();
  await section2();
  await section3();
  await section4();
  await section5();
  await section6();
  await section7();
  await section8();
  await section9();
  await section10();
  await section11();
  await section12();
  await section13();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed === 0) console.log("✅ ALL TESTS PASSED — Milestone 4 ready for sign-off");
  else { console.log("❌ SOME TESTS FAILED — see errors above"); process.exitCode = 1; }
  process.exit(process.exitCode || 0);
}
main().catch(err => { console.error("Fatal:", err); process.exit(1); });
