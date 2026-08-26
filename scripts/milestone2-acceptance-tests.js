/**
 * THE PLATFORM — Milestone 2 Acceptance Test Suite
 * 53 tests across: Catalog, Cart, Orders, Inventory, External Orders,
 * Change Requests, Payment Proofs, Receipts, Security Rules
 *
 * Run: node milestone2-acceptance-tests.js
 * Requires: firebase emulators:start --only auth,firestore,functions,storage --project demo-platform
 */
const PROJECT_ID = "demo-platform";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_STORAGE_EMULATOR_HOST = "127.0.0.1:9199";
process.env.FUNCTIONS_EMULATOR = "true";

const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID, storageBucket: `${PROJECT_ID}.appspot.com` });

const { initializeApp, getApps } = require("firebase/app");
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword } = require("firebase/auth");
const { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, collection, getDocs, query } = require("firebase/firestore");
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require("firebase/functions");
const { getStorage, connectStorageEmulator, ref, uploadBytes } = require("firebase/storage");

const clientApp = getApps().find(a => a.name === "test2") || initializeApp({ apiKey: "demo", projectId: PROJECT_ID, storageBucket: `${PROJECT_ID}.appspot.com` }, "test2");
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
async function assertDenied(p) {
  return p.then(() => { throw new Error("Expected denial but succeeded"); }, err => {
    if (!err.code?.includes("permission-denied") && !err.message?.includes("permission-denied") && !err.code?.includes("PERMISSION_DENIED") && !err.code?.includes("failed-precondition")) throw new Error(`Expected denial, got: ${err.code} — ${err.message}`);
  });
}
async function assertFnError(p, code) {
  return p.then(() => { throw new Error(`Expected ${code} but succeeded`); }, err => {
    if (!err.code?.includes(code)) throw new Error(`Expected ${code}, got: ${err.code} — ${err.message}`);
  });
}
async function waitFor(fn, retries = 15, delay = 1000) {
  for (let i = 0; i < retries; i++) { const r = await fn(); if (r) return r; await sleep(delay); }
  throw new Error("waitFor: condition never met");
}

const PASSWORD = "TestPass123!";
let vendorEmail, vendorUid, vendorId, customerEmail, customerUid, adminEmail, adminUid;
let catalogItemId, catalogItem2Id, categoryId, cartId, orderId, publicOrderId, externalOrderId;

async function signInAs(email) { const c = await signInWithEmailAndPassword(auth, email, PASSWORD); await c.user.getIdToken(true); return c; }

async function seedCountryAvailability() {
  // Phase 3 added a countryAvailability gate on createOrder/createCommerceConversation
  // (functions/src/orders/createOrder.ts) that this script predates and was
  // never updated for. Without this, every order-creation test in this file
  // fails with "the platform is not currently available in this vendor's region"
  // when run standalone (i.e. not preceded by milestone3/4, which happen to
  // seed this same fixture themselves). Matches milestone3's exact seed.
  await admin.firestore().collection("countryAvailability").doc("NG").set({
    countryCode: "NG", countryName: "Nigeria", status: "ACTIVE",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: "p2_acceptance_seed",
  });
}

async function setup() {
  console.log("\n⚙️  Setup: provisioning test accounts...");
  await seedCountryAvailability();
  customerEmail = `p2cust_${Date.now()}@test.com`;
  const cc = await createUserWithEmailAndPassword(auth, customerEmail, PASSWORD);
  customerUid = cc.user.uid;
  await waitFor(async () => { const s = await getDoc(doc(db, "users", customerUid)); return s.exists() ? s : null; });

  vendorEmail = `p2vend_${Date.now()}@test.com`;
  const vc = await createUserWithEmailAndPassword(auth, vendorEmail, PASSWORD);
  vendorUid = vc.user.uid;
  await waitFor(async () => { const s = await getDoc(doc(db, "users", vendorUid)); return s.exists() ? s : null; });
  await signInAs(vendorEmail);
  const rr = await httpsCallable(fns, "completeRegistration")({ role: "vendor", businessName: "Spicy Restaurant", username: `spicyrest_${Date.now()}`, fullName: "Vendor Owner", categoryId: "food_catering", categoryName: "Food & Catering", country: "Nigeria", state: "Lagos", area: "Lekki", plan: "basic" });
  vendorId = rr.data.vendorId;
  await auth.currentUser.getIdToken(true);

  adminEmail = `p2admin_${Date.now()}@theplatform.com`;
  const ac = await createUserWithEmailAndPassword(auth, adminEmail, PASSWORD);
  adminUid = ac.user.uid;
  await waitFor(async () => { const s = await getDoc(doc(db, "users", adminUid)); return s.exists() ? s : null; });
  await admin.auth().setCustomUserClaims(adminUid, { role: "admin", adminRoleIds: ["super_admin","verification_admin","safety_admin"], claimsVersion: 1 });
  await admin.firestore().collection("adminUsers").doc(adminUid).set({ uid: adminUid, email: adminEmail, roleIds: ["super_admin","verification_admin","safety_admin"], status: "active", mfaRequired: true, mfaEnrolled: false, createdByAdminUid: null, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(), lastLoginAt: null, revokedAt: null, lastMfaAt: null });
  await admin.firestore().collection("users").doc(adminUid).update({ role: "admin" });

  // Approve vendor
  await signInAs(vendorEmail);
  for (const type of ["business_info","identity_document","proof_of_address"]) {
    const path = `verificationDocuments/${vendorId}/${type}_setup.pdf`;
    await uploadBytes(ref(storage, path), new Uint8Array([0x25,0x50,0x44,0x46]), { contentType: "application/pdf" });
    await httpsCallable(fns, "recordVerificationDocument")({ type, storagePath: path });
  }
  await httpsCallable(fns, "submitVendorVerification")({});
  await signInAs(adminEmail);
  await httpsCallable(fns, "approveVendorVerification")({ vendorId });
  await sleep(1500);
  await signInAs(vendorEmail);
  await httpsCallable(fns, "setVendorPublishStatus")({ isPublished: true });
  await sleep(1500);
  console.log(`  -> Vendor ${vendorId} approved and discoverable`);
}

async function section1() {
  console.log("\n📋 Section 1: Catalog management");
  await test("Vendor can create a catalog category", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "createCatalogCategory")({ name: "Main Dishes", order: 1 });
    assert(r.data.success); categoryId = r.data.categoryId; assert(categoryId);
  });
  await test("Vendor can create catalog item with correct server defaults", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "createCatalogItem")({ name: "Jollof Rice", basePrice: 2500, currency: "NGN", categoryId, isAvailable: true, trackInventory: true, inventoryQuantity: 10 });
    assert(r.data.success); catalogItemId = r.data.itemId;
    const s = await admin.firestore().collection("vendors").doc(vendorId).collection("catalogItems").doc(catalogItemId).get();
    assertEqual(s.data().moderationStatus, "pending", "New items start as pending");
    assertEqual(s.data().reservedQuantity, 0, "reservedQuantity starts at 0");
    assertEqual(s.data().orderCount, 0, "orderCount starts at 0");
  });
  await test("Vendor can create second catalog item", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "createCatalogItem")({ name: "Fried Chicken", basePrice: 1800, currency: "NGN", categoryId, isAvailable: true, trackInventory: true, inventoryQuantity: 20 });
    assert(r.data.success); catalogItem2Id = r.data.itemId;
  });
  await test("Plan limit enforced — basic plan max 10 items", async () => {
    await signInAs(vendorEmail);
    let hitLimit = false;
    for (let i = 3; i <= 11; i++) {
      try { await httpsCallable(fns, "createCatalogItem")({ name: `Item ${i}`, basePrice: 100, currency: "NGN", isAvailable: true }); }
      catch (e) { if (e.code === "functions/resource-exhausted") { hitLimit = true; break; } throw e; }
    }
    assert(hitLimit, "Basic plan limit of 10 items must be enforced");
  });
  await test("Vendor can update item (allowed fields only)", async () => {
    await signInAs(vendorEmail);
    await httpsCallable(fns, "updateCatalogItem")({ itemId: catalogItemId, name: "Jollof Rice (Party Size)", basePrice: 3000 });
    const s = await admin.firestore().collection("vendors").doc(vendorId).collection("catalogItems").doc(catalogItemId).get();
    assertEqual(s.data().basePrice, 3000);
  });
  await test("reservedQuantity cannot be changed via updateCatalogItem", async () => {
    await signInAs(vendorEmail);
    await httpsCallable(fns, "updateCatalogItem")({ itemId: catalogItemId, reservedQuantity: 999 });
    const s = await admin.firestore().collection("vendors").doc(vendorId).collection("catalogItems").doc(catalogItemId).get();
    assertEqual(s.data().reservedQuantity, 0, "reservedQuantity must remain 0");
  });
  await test("Customer CANNOT directly write catalog item", async () => {
    await signInAs(customerEmail);
    await assertDenied(setDoc(doc(db, "vendors", vendorId, "catalogItems", catalogItemId), { basePrice: 1 }, { merge: true }));
  });
  await test("Customer can read approved visible catalog item", async () => {
    await admin.firestore().collection("vendors").doc(vendorId).collection("catalogItems").doc(catalogItemId).update({ moderationStatus: "approved" });
    await signInAs(customerEmail);
    const s = await getDoc(doc(db, "vendors", vendorId, "catalogItems", catalogItemId));
    assert(s.exists(), "Customer should read approved visible items");
  });
  await test("Customer CANNOT read hidden catalog item", async () => {
    await admin.firestore().collection("vendors").doc(vendorId).collection("catalogItems").doc(catalogItemId).update({ isHidden: true });
    await signInAs(customerEmail);
    await assertDenied(getDoc(doc(db, "vendors", vendorId, "catalogItems", catalogItemId)));
    await admin.firestore().collection("vendors").doc(vendorId).collection("catalogItems").doc(catalogItemId).update({ isHidden: false });
  });
}

async function section2() {
  console.log("\n📋 Section 2: Cart repricing");
  await test("repriceCart computes totals server-side", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "repriceCart")({ vendorId, fulfillmentType: "pickup", items: [{ itemId: catalogItemId, quantity: 2 }, { itemId: catalogItem2Id, quantity: 1 }] });
    assert(r.data.success); cartId = r.data.cartId;
    assertEqual(r.data.subtotal, 7800, "3000x2 + 1800x1 = 7800");
  });
  await test("repriceCart rejects unknown item", async () => {
    await signInAs(customerEmail);
    await assertFnError(httpsCallable(fns, "repriceCart")({ vendorId, fulfillmentType: "pickup", items: [{ itemId: "nonexistent", quantity: 1 }] }), "not-found");
  });
  await test("Customer CANNOT directly write to carts", async () => {
    await signInAs(customerEmail);
    await assertDenied(setDoc(doc(db, "carts", "fake_cart"), { customerId: customerUid, total: 9999 }, { merge: true }));
  });
  await test("Customer can read their own cart", async () => {
    await signInAs(customerEmail);
    const s = await getDoc(doc(db, "carts", cartId));
    assert(s.exists()); assertEqual(s.data().customerId, customerUid);
  });
}

async function section3() {
  console.log("\n📋 Section 3: Order creation and inventory reservation");
  // "createOrderFromCart requires conversationId" removed: per Phase 3
  // (createOrder.ts's own comment), conversationId is no longer accepted
  // as client input at all — the server computes it deterministically
  // (`commerce_${customerId}_${vendorId}`). Calling without one used to be
  // rejected; now it's just a normal, valid call, so the old rejection
  // assertion here was itself testing pre-Phase-3 behavior that no longer
  // exists — and worse, silently consumed the cart the next test needed.
  await test("createOrderFromCart creates order and reserves inventory", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "createOrderFromCart")({ cartId, conversationId: `conv_${Date.now()}` });
    assert(r.data.success); orderId = r.data.orderId; publicOrderId = r.data.publicOrderId;
    assert(publicOrderId.toUpperCase().includes("SPICY"), `publicOrderId should contain slug: ${publicOrderId}`);
  });
  await test("Order has correct initial state", async () => {
    const s = await admin.firestore().collection("orders").doc(orderId).get();
    assertEqual(s.data().status, "requested");
    assertEqual(s.data().paymentStatus, "UNPAID");
    assert(s.data().acceptanceDeadlineAt, "SLA deadline must be set");
    assert(s.data().conversationId, "conversationId must be present");
    assert(s.data().customerSnapshot.displayName, "customerSnapshot must have displayName");
  });
  await test("Inventory was reserved atomically", async () => {
    const s1 = await admin.firestore().collection("vendors").doc(vendorId).collection("catalogItems").doc(catalogItemId).get();
    assertEqual(s1.data().reservedQuantity, 2, "2 units of Jollof Rice should be reserved");
    const s2 = await admin.firestore().collection("vendors").doc(vendorId).collection("catalogItems").doc(catalogItem2Id).get();
    assertEqual(s2.data().reservedQuantity, 1, "1 unit of Fried Chicken should be reserved");
  });
  await test("Cart is deleted after order creation", async () => {
    const s = await admin.firestore().collection("carts").doc(cartId).get();
    assert(!s.exists, "Cart must be deleted after order creation");
  });
  await test("ORDER_CREATED event written", async () => {
    const s = await admin.firestore().collection("orders").doc(orderId).collection("events").get();
    assert(s.docs.some(d => d.data().eventType === "ORDER_CREATED"), "ORDER_CREATED event must exist");
  });
  await test("Customer can read their own order", async () => {
    await signInAs(customerEmail);
    const s = await getDoc(doc(db, "orders", orderId));
    assert(s.exists());
  });
  await test("Vendor can read their order", async () => {
    await signInAs(vendorEmail);
    const s = await getDoc(doc(db, "orders", orderId));
    assert(s.exists());
  });
  await test("Different customer CANNOT read this order", async () => {
    const e = `other_${Date.now()}@test.com`;
    const c = await createUserWithEmailAndPassword(auth, e, PASSWORD);
    await waitFor(async () => { const s = await getDoc(doc(db, "users", c.user.uid)); return s.exists() ? s : null; });
    await signInAs(e);
    await assertDenied(getDoc(doc(db, "orders", orderId)));
  });
  await test("Customer CANNOT directly update order status", async () => {
    await signInAs(customerEmail);
    await assertDenied(setDoc(doc(db, "orders", orderId), { status: "completed" }, { merge: true }));
  });
  await test("Concurrent orders: only 1 succeeds when stock=1", async () => {
    const lRef = await admin.firestore().collection("vendors").doc(vendorId).collection("catalogItems").add({ itemId: "tmp", vendorId, categoryId: null, name: "Limited", description: null, basePrice: 500, salePrice: null, currency: "NGN", photos: [], thumbnailUrl: null, isAvailable: true, isHidden: false, isOutOfStock: false, inventoryQuantity: 1, reservedQuantity: 0, trackInventory: true, lowStockThreshold: null, addOnGroups: [], orderCount: 0, moderationStatus: "approved", createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    await lRef.update({ itemId: lRef.id });
    await signInAs(customerEmail);
    const c1 = await httpsCallable(fns, "repriceCart")({ vendorId, fulfillmentType: "pickup", items: [{ itemId: lRef.id, quantity: 1 }] });
    const c2 = await httpsCallable(fns, "repriceCart")({ vendorId, fulfillmentType: "pickup", items: [{ itemId: lRef.id, quantity: 1 }] });
    const results = await Promise.allSettled([
      httpsCallable(fns, "createOrderFromCart")({ cartId: c1.data.cartId, conversationId: `conv_cc_${Date.now()}` }),
      httpsCallable(fns, "createOrderFromCart")({ cartId: c2.data.cartId, conversationId: `conv_cc_${Date.now()}` }),
    ]);
    assertEqual(results.filter(r => r.status === "fulfilled").length, 1, "Exactly 1 should succeed");
    assertEqual(results.filter(r => r.status === "rejected").length, 1, "Exactly 1 should fail");
  });
}

async function section4() {
  console.log("\n📋 Section 4: Order lifecycle");
  await test("Vendor can accept a requested order", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "updateOrderStatus")({ orderId, newStatus: "accepted" });
    assert(r.data.success);
    const s = await admin.firestore().collection("orders").doc(orderId).get();
    assertEqual(s.data().status, "accepted"); assert(s.data().acceptedAt);
  });
  await test("Customer cannot skip to completed", async () => {
    await signInAs(customerEmail);
    await assertFnError(httpsCallable(fns, "updateOrderStatus")({ orderId, newStatus: "completed" }), "failed-precondition");
  });
  await test("Vendor moves to in_progress", async () => {
    await signInAs(vendorEmail);
    await httpsCallable(fns, "updateOrderStatus")({ orderId, newStatus: "in_progress" });
  });
  await test("Completing order generates receipt and adjusts inventory", async () => {
    await signInAs(vendorEmail);
    await httpsCallable(fns, "updateOrderStatus")({ orderId, newStatus: "completed" });
    await sleep(1500);
    const rs = await admin.firestore().collection("orders").doc(orderId).collection("receipts").get();
    assert(rs.docs.length > 0, "Receipt must be generated");
    assert(/-RCT-\d+$/.test(rs.docs[0].data().receiptNumber), `expected {VENDORSLUG}-RCT-{seq}, got "${rs.docs[0].data().receiptNumber}"`);
    const s = await admin.firestore().collection("vendors").doc(vendorId).collection("catalogItems").doc(catalogItemId).get();
    assertEqual(s.data().reservedQuantity, 0, "Reserved quantity must be 0 after completion");
    assert(s.data().inventoryQuantity < 10, "inventoryQuantity must decrease");
  });
  await test("Rejected order releases inventory", async () => {
    await signInAs(customerEmail);
    const rr = await httpsCallable(fns, "repriceCart")({ vendorId, fulfillmentType: "pickup", items: [{ itemId: catalogItem2Id, quantity: 1 }] });
    const or = await httpsCallable(fns, "createOrderFromCart")({ cartId: rr.data.cartId, conversationId: `conv_rej_${Date.now()}` });
    const before = (await admin.firestore().collection("vendors").doc(vendorId).collection("catalogItems").doc(catalogItem2Id).get()).data().reservedQuantity;
    await signInAs(vendorEmail);
    await httpsCallable(fns, "updateOrderStatus")({ orderId: or.data.orderId, newStatus: "rejected" });
    await sleep(500);
    const after = (await admin.firestore().collection("vendors").doc(vendorId).collection("catalogItems").doc(catalogItem2Id).get()).data().reservedQuantity;
    assert(after < before, "Inventory must be released after rejection");
  });
}

async function section5() {
  console.log("\n📋 Section 5: External orders");
  await test("Setup: upgrade vendor to Standard (external orders are Standard+ only per Milestone 4's plan gating, added after this script was written)", async () => {
    await signInAs(adminEmail);
    await httpsCallable(fns, "applyManualSubscriptionOverride")({ vendorId, plan: "standard", reason: "milestone2 external-order test fixture" });
  });
  await test("Vendor can create external order with EXT in publicOrderId", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "createExternalOrder")({ externalCustomerName: "Chidi Okeke", externalCustomerPhone: "+2348012345678", conversationId: `conv_ext_${Date.now()}`, fulfillmentType: "pickup", items: [{ itemId: catalogItem2Id, quantity: 1 }] });
    assert(r.data.success); externalOrderId = r.data.orderId;
    assert(r.data.publicOrderId.includes("EXT"), `Expected EXT in publicOrderId: ${r.data.publicOrderId}`);
  });
  // "External order requires conversationId" removed: createExternalOrder
  // (createOrder.ts) only ever validates externalCustomerName and items —
  // conversationId was never a required client field here either; the
  // server always derives its own (`external_${orderRef.id}`). Same stale
  // pre-Phase-3 assumption as the internal-order test above.
  await test("Customer CANNOT create external order", async () => {
    await signInAs(customerEmail);
    await assertFnError(httpsCallable(fns, "createExternalOrder")({ externalCustomerName: "Fake", conversationId: "c", items: [{ itemId: catalogItemId, quantity: 1 }] }), "permission-denied");
  });
}

async function section6() {
  console.log("\n📋 Section 6: Change requests");
  let crOrderId, crId;
  await test("Setup: create order for change request tests", async () => {
    await signInAs(customerEmail);
    const rr = await httpsCallable(fns, "repriceCart")({ vendorId, fulfillmentType: "pickup", items: [{ itemId: catalogItem2Id, quantity: 1 }] });
    const or = await httpsCallable(fns, "createOrderFromCart")({ cartId: rr.data.cartId, conversationId: `conv_cr_${Date.now()}` });
    crOrderId = or.data.orderId; assert(crOrderId);
  });
  await test("Vendor can propose change request on requested order", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "handleChangeRequest")({ orderId: crOrderId, action: "create", message: "Can we substitute the item?" });
    assert(r.data.success); crId = r.data.changeRequestId; assert(crId);
  });
  await test("Customer can reject a change request", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "handleChangeRequest")({ orderId: crOrderId, action: "reject", changeRequestId: crId });
    assertEqual(r.data.status, "REJECTED");
  });
  await test("Customer CANNOT propose a change request", async () => {
    await signInAs(customerEmail);
    await assertFnError(httpsCallable(fns, "handleChangeRequest")({ orderId: crOrderId, action: "create", message: "Give me discount" }), "permission-denied");
  });
  await test("Change requests blocked after order is accepted", async () => {
    await signInAs(vendorEmail);
    await httpsCallable(fns, "updateOrderStatus")({ orderId: crOrderId, newStatus: "accepted" });
    await assertFnError(httpsCallable(fns, "handleChangeRequest")({ orderId: crOrderId, action: "create", message: "Too late" }), "failed-precondition");
  });
}

async function section7() {
  console.log("\n📋 Section 7: Payment proofs");
  let proofOrderId, proofId;
  await test("Setup: create order for payment proof tests", async () => {
    await signInAs(customerEmail);
    const rr = await httpsCallable(fns, "repriceCart")({ vendorId, fulfillmentType: "pickup", items: [{ itemId: catalogItem2Id, quantity: 1 }] });
    const or = await httpsCallable(fns, "createOrderFromCart")({ cartId: rr.data.cartId, conversationId: `conv_proof_${Date.now()}` });
    proofOrderId = or.data.orderId; assert(proofOrderId);
  });
  await test("Customer can submit payment proof", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "submitPaymentProof")({ orderId: proofOrderId, images: [{ storagePath: "paymentProofs/p1.jpg" }], notes: "Bank transfer" });
    assert(r.data.success); proofId = r.data.proofId;
    const s = await admin.firestore().collection("orders").doc(proofOrderId).get();
    assertEqual(s.data().paymentStatus, "PROOF_SUBMITTED");
  });
  await test("Cannot submit another proof while one is under review", async () => {
    await signInAs(customerEmail);
    await assertFnError(httpsCallable(fns, "submitPaymentProof")({ orderId: proofOrderId, images: [{ storagePath: "p2.jpg" }] }), "failed-precondition");
  });
  await test("Max 3 images enforced", async () => {
    await signInAs(customerEmail);
    const rr = await httpsCallable(fns, "repriceCart")({ vendorId, fulfillmentType: "pickup", items: [{ itemId: catalogItem2Id, quantity: 1 }] });
    const or = await httpsCallable(fns, "createOrderFromCart")({ cartId: rr.data.cartId, conversationId: `conv_img_${Date.now()}` });
    await assertFnError(httpsCallable(fns, "submitPaymentProof")({ orderId: or.data.orderId, images: [{ storagePath: "p1.jpg" }, { storagePath: "p2.jpg" }, { storagePath: "p3.jpg" }, { storagePath: "p4.jpg" }] }), "invalid-argument");
  });
  await test("Vendor rejects proof with reason", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "reviewPaymentProof")({ orderId: proofOrderId, proofId, decision: "reject", reviewReason: "Image blurry" });
    assertEqual(r.data.status, "REJECTED");
  });
  await test("Customer can resubmit after rejection (attempt 2)", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "submitPaymentProof")({ orderId: proofOrderId, images: [{ storagePath: "clear.jpg" }] });
    assertEqual(r.data.submissionCount, 2); proofId = r.data.proofId;
  });
  await test("Vendor accepts proof", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "reviewPaymentProof")({ orderId: proofOrderId, proofId, decision: "accept" });
    assertEqual(r.data.status, "REVIEWED");
    const s = await admin.firestore().collection("orders").doc(proofOrderId).get();
    assertEqual(s.data().paymentStatus, "PROOF_ACCEPTED");
  });
  await test("Vendor CANNOT reject without reason", async () => {
    await signInAs(customerEmail);
    const rr = await httpsCallable(fns, "repriceCart")({ vendorId, fulfillmentType: "pickup", items: [{ itemId: catalogItem2Id, quantity: 1 }] });
    const or = await httpsCallable(fns, "createOrderFromCart")({ cartId: rr.data.cartId, conversationId: `conv_nr_${Date.now()}` });
    const pr = await httpsCallable(fns, "submitPaymentProof")({ orderId: or.data.orderId, images: [{ storagePath: "p.jpg" }] });
    await signInAs(vendorEmail);
    await assertFnError(httpsCallable(fns, "reviewPaymentProof")({ orderId: or.data.orderId, proofId: pr.data.proofId, decision: "reject" }), "invalid-argument");
  });
  await test("After 2 rejections proof is LOCKED (abuse prevention)", async () => {
    await signInAs(customerEmail);
    const rr = await httpsCallable(fns, "repriceCart")({ vendorId, fulfillmentType: "pickup", items: [{ itemId: catalogItem2Id, quantity: 1 }] });
    const or = await httpsCallable(fns, "createOrderFromCart")({ cartId: rr.data.cartId, conversationId: `conv_lock_${Date.now()}` });
    const lockId = or.data.orderId;
    const p1 = await httpsCallable(fns, "submitPaymentProof")({ orderId: lockId, images: [{ storagePath: "p1.jpg" }] });
    await signInAs(vendorEmail);
    await httpsCallable(fns, "reviewPaymentProof")({ orderId: lockId, proofId: p1.data.proofId, decision: "reject", reviewReason: "Blurry" });
    await signInAs(customerEmail);
    const p2 = await httpsCallable(fns, "submitPaymentProof")({ orderId: lockId, images: [{ storagePath: "p2.jpg" }] });
    await signInAs(vendorEmail);
    await httpsCallable(fns, "reviewPaymentProof")({ orderId: lockId, proofId: p2.data.proofId, decision: "reject", reviewReason: "Wrong amount" });
    await signInAs(customerEmail);
    await assertFnError(httpsCallable(fns, "submitPaymentProof")({ orderId: lockId, images: [{ storagePath: "p3.jpg" }] }), "resource-exhausted");
  });
}

async function section8() {
  console.log("\n📋 Section 8: Receipts");
  await test("getReceipt returns receipt after completion", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "getReceipt")({ orderId });
    assert(r.data.success);
    assert(/-RCT-\d+$/.test(r.data.receipt.receiptNumber), `expected {VENDORSLUG}-RCT-{seq}, got "${r.data.receipt.receiptNumber}"`);
    assert(r.data.receipt.total > 0);
  });
  await test("Receipt is immutable — client CANNOT write", async () => {
    await signInAs(customerEmail);
    const rs = await admin.firestore().collection("orders").doc(orderId).collection("receipts").get();
    await assertDenied(setDoc(doc(db, "orders", orderId, "receipts", rs.docs[0].id), { total: 0 }, { merge: true }));
  });
  await test("Receipt number format is {VENDORSLUG}-RCT-{seq}", async () => {
    // Corrected per LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md Section 4.4:
    // no more LVT-{year}-{code}-{padded} — matches the order/invoice
    // numbering convention now (no platform-branded prefix, no year, no
    // zero-padding).
    const rs = await admin.firestore().collection("orders").doc(orderId).collection("receipts").get();
    const receiptNumber = rs.docs[0].data().receiptNumber;
    assert(/-RCT-\d+$/.test(receiptNumber), `expected {VENDORSLUG}-RCT-{seq}, got "${receiptNumber}"`);
  });
  await test("Another user CANNOT get this receipt", async () => {
    const e = `recother_${Date.now()}@test.com`;
    const c = await createUserWithEmailAndPassword(auth, e, PASSWORD);
    await waitFor(async () => { const s = await getDoc(doc(db, "users", c.user.uid)); return s.exists() ? s : null; });
    await signInAs(e);
    await assertFnError(httpsCallable(fns, "getReceipt")({ orderId }), "permission-denied");
  });
}

async function section9() {
  console.log("\n📋 Section 9: Phone OTP");
  await test("sendPhoneOtp accepts Nigerian formats (08012345678)", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "sendPhoneOtp")({ phoneNumber: "08012345678" });
    assert(r.data.success);
  });
  await test("sendPhoneOtp accepts E.164 format (+2348012345678)", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "sendPhoneOtp")({ phoneNumber: "+2348099887766" });
    assert(r.data.success);
  });
  await test("sendPhoneOtp rejects invalid phone number", async () => {
    await signInAs(customerEmail);
    await assertFnError(httpsCallable(fns, "sendPhoneOtp")({ phoneNumber: "notaphone" }), "invalid-argument");
  });
  await test("verifyPhoneOtp succeeds with correct code from smsQueue", async () => {
    await signInAs(customerEmail);
    const phone = "+2347011223344";
    await httpsCallable(fns, "sendPhoneOtp")({ phoneNumber: phone });
    await sleep(1000);
    // Filtered + limited to exactly this phone's single most recent entry —
    // scanning the last 5 unfiltered docs and letting a plain forEach
    // overwrite `code` on every match actually picks the OLDEST of those 5
    // (desc order means later loop iterations are older), which silently
    // verifies a stale code from a prior run against the same emulator
    // session instead of the one just sent.
    const smsSnap = await admin.firestore().collection("smsQueue")
      .where("to", "==", phone).orderBy("createdAt", "desc").limit(1).get();
    const code = smsSnap.empty ? null : smsSnap.docs[0].data()._emulatorCode;
    assert(code, "OTP code must be in smsQueue doc (_emulatorCode field)");
    const r = await httpsCallable(fns, "verifyPhoneOtp")({ phoneNumber: phone, code });
    assertEqual(r.data.verified, true);
    const userSnap = await admin.firestore().collection("users").doc(customerUid).get();
    assertEqual(userSnap.data().phoneNumber, phone, "phoneNumber must be updated on user doc");
  });
  await test("verifyPhoneOtp FAILS with wrong code", async () => {
    await signInAs(customerEmail);
    await httpsCallable(fns, "sendPhoneOtp")({ phoneNumber: "+2347000000001" });
    await sleep(500);
    await assertFnError(httpsCallable(fns, "verifyPhoneOtp")({ phoneNumber: "+2347000000001", code: "000000" }), "invalid-argument");
  });
  await test("phoneOtps collection is NOT client-readable", async () => {
    await signInAs(customerEmail);
    const crypto = require("crypto");
    const hash = crypto.createHash("sha256").update("+2348012345678").digest("hex");
    await assertDenied(getDoc(doc(db, "phoneOtps", hash)));
  });
}

async function section10() {
  console.log("\n📋 Section 10: Security rules");
  await test("Order events are immutable", async () => {
    await signInAs(customerEmail);
    await assertDenied(setDoc(doc(db, "orders", orderId, "events", "fake"), { eventType: "FAKE" }, { merge: true }));
  });
  await test("vendorSequences are never client-accessible", async () => {
    await signInAs(vendorEmail);
    await assertDenied(getDoc(doc(db, "vendorSequences", vendorId)));
    await assertDenied(setDoc(doc(db, "vendorSequences", vendorId), { orderSequence: 9999 }));
  });
  await test("smsQueue is never client-accessible", async () => {
    await signInAs(customerEmail);
    await assertDenied(getDoc(doc(db, "smsQueue", "any")));
  });
  await test("phoneOtps is never client-writable", async () => {
    await signInAs(customerEmail);
    await assertDenied(setDoc(doc(db, "phoneOtps", "fakehash"), { codeHash: "x" }));
  });
  await test("Price immutability: order snapshot unchanged after catalog price change", async () => {
    const before = (await admin.firestore().collection("orders").doc(orderId).get()).data().orderSnapshot.total;
    await admin.firestore().collection("vendors").doc(vendorId).collection("catalogItems").doc(catalogItemId).update({ basePrice: 99999 });
    const after = (await admin.firestore().collection("orders").doc(orderId).get()).data().orderSnapshot.total;
    assertEqual(after, before, "Snapshot total must not change when catalog price changes");
  });
}

async function main() {
  console.log("🚀 THE PLATFORM — Milestone 2 Acceptance Test Suite");
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
  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed === 0) console.log("✅ ALL TESTS PASSED — Milestone 2 ready for sign-off");
  else { console.log("❌ SOME TESTS FAILED — see errors above"); process.exitCode = 1; }
  process.exit(process.exitCode || 0);
}
main().catch(err => { console.error("Fatal:", err); process.exit(1); });
