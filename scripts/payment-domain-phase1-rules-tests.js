/**
 * Payment Domain — Batch 1 Firestore Rules acceptance tests.
 *
 * Verifies the access matrix for the five new payment-domain collections
 * introduced in Batch 1 (types + rules scaffolding only — see the approved
 * Payment Domain implementation plan): vendor Payment Instructions,
 * Confirmed Direct Payments, Refunds, Payment Disputes, and Payment
 * Instruction Change Events. No Cloud Function or mobile behavior exists
 * yet for any of these — every document here is seeded directly via the
 * Admin SDK (bypassing rules, exactly like the existing acceptance
 * scripts' order/invoice fixtures), and every assertion is a client-SDK
 * Firestore read/write attempt against the rules alone.
 *
 * Vendor test identities are assigned their {role, vendorId} custom claims
 * directly via admin.auth().setCustomUserClaims(), the same mechanism the
 * existing milestone1-acceptance-tests.js uses for its admin test user
 * (see its Section 3) — this keeps the suite fast and focused on rules
 * behavior without depending on the completeRegistration callable/Functions
 * emulator, which nothing in this batch touches.
 *
 * Requires the emulator suite running first (Firestore + Auth only — no
 * Functions/Storage needed, since this batch adds no callable):
 *   firebase emulators:start --only firestore,auth --project demo-platform
 *
 * Usage:
 *   node payment-domain-phase1-rules-tests.js
 */

const PROJECT_ID = "demo-platform";

process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const admin = require("firebase-admin");
if (!admin.apps.length) {
  admin.initializeApp({ projectId: PROJECT_ID });
}
const fdb = admin.firestore();

const { initializeApp, getApps } = require("firebase/app");
const {
  getAuth, connectAuthEmulator, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut,
} = require("firebase/auth");
const {
  getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, updateDoc, deleteDoc,
} = require("firebase/firestore");

const clientApp = getApps().find(a => a.name === "test") ||
  initializeApp({ apiKey: "demo", projectId: PROJECT_ID }, "test");

const auth = getAuth(clientApp);
const db = getFirestore(clientApp);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
connectFirestoreEmulator(db, "127.0.0.1", 8080);

// ── helpers (mirrors milestone1-acceptance-tests.js exactly) ──────────────
let passed = 0, failed = 0, total = 0;
const PASSWORD = "TestPass123!";

async function test(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message || e}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

function assertDenied(promise) {
  return promise.then(
    () => { throw new Error("Expected permission-denied but request succeeded"); },
    err => {
      if (!err.code?.includes("permission-denied") && !err.code?.includes("PERMISSION_DENIED") && !err.message?.includes("PERMISSION_DENIED")) {
        throw new Error(`Expected permission-denied, got: ${err.code} ${err.message}`);
      }
    }
  );
}

async function assertReadable(refPromiseFactory) {
  const snap = await getDoc(refPromiseFactory());
  assert(snap.exists(), "Expected the document to be readable and exist");
}

async function signInAs(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  await cred.user.getIdToken(true);
  return cred;
}

const uniq = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// ── fixtures ────────────────────────────────────────────────────────────
let vendorAEmail, vendorAUid, vendorAId;
let vendorBEmail, vendorBUid, vendorBId;
let customerAEmail, customerAUid;
let customerBEmail, customerBUid;
let adminEmail, adminUid;
let orderId, paymentInstructionRecordId, confirmedPaymentId, refundId, disputeId, changeEventId;
let spoofedPaymentId, spoofedRefundId;

async function setupIdentities() {
  vendorAEmail = uniq("vendorA") + "@test.com";
  let cred = await createUserWithEmailAndPassword(auth, vendorAEmail, PASSWORD);
  vendorAUid = cred.user.uid;
  vendorAId = vendorAUid; // vendorId need not differ from uid for rules purposes
  await admin.auth().setCustomUserClaims(vendorAUid, { role: "vendor", vendorId: vendorAId, claimsVersion: 1 });

  vendorBEmail = uniq("vendorB") + "@test.com";
  cred = await createUserWithEmailAndPassword(auth, vendorBEmail, PASSWORD);
  vendorBUid = cred.user.uid;
  vendorBId = vendorBUid;
  await admin.auth().setCustomUserClaims(vendorBUid, { role: "vendor", vendorId: vendorBId, claimsVersion: 1 });

  customerAEmail = uniq("customerA") + "@test.com";
  cred = await createUserWithEmailAndPassword(auth, customerAEmail, PASSWORD);
  customerAUid = cred.user.uid;
  // onUserCreate already assigns role:'customer' by default (see
  // milestone1-acceptance-tests.js Section 1) — no explicit claim needed.

  customerBEmail = uniq("customerB") + "@test.com";
  cred = await createUserWithEmailAndPassword(auth, customerBEmail, PASSWORD);
  customerBUid = cred.user.uid;

  adminEmail = uniq("admin") + "@example.com";
  cred = await createUserWithEmailAndPassword(auth, adminEmail, PASSWORD);
  adminUid = cred.user.uid;
  await admin.auth().setCustomUserClaims(adminUid, { role: "admin", adminRoleIds: ["super_admin"], claimsVersion: 1 });
}

async function seedFixtureDocuments() {
  orderId = uniq("order");
  await fdb.collection("orders").doc(orderId).set({
    orderId, vendorId: vendorAId, customerId: customerAUid, orderSource: "internal",
    status: "accepted", paymentStatus: "UNPAID", fulfillmentType: "pickup",
    conversationId: uniq("conv"), createdByVendor: false,
    items: [], orderSnapshot: { subtotal: 0, tax: 0, discount: 0, total: 0, currency: "NGN" },
    createdAt: admin.firestore.Timestamp.now(), updatedAt: admin.firestore.Timestamp.now(),
  });

  paymentInstructionRecordId = uniq("pir");
  await fdb.collection("vendors").doc(vendorAId).collection("paymentInstructions").doc(paymentInstructionRecordId).set({
    recordId: paymentInstructionRecordId, vendorId: vendorAId,
    bankName: "First Bank of Nigeria", accountNumber: "1234567890", accountName: "Test Vendor Ltd",
    ownershipAttestedAt: admin.firestore.Timestamp.now(), ownershipAttestedByUid: vendorAUid,
    isActive: true, createdAt: admin.firestore.Timestamp.now(),
  });

  confirmedPaymentId = uniq("cdp");
  await fdb.collection("orders").doc(orderId).collection("confirmedDirectPayments").doc(confirmedPaymentId).set({
    paymentId: confirmedPaymentId, orderId, vendorId: vendorAId, customerId: customerAUid,
    requestId: null, method: "cash", source: "cash_vendor_confirmed", amount: 5000, currency: "NGN",
    confirmedByUid: vendorAUid, confirmedAt: admin.firestore.Timestamp.now(),
    customerAcknowledgement: "pending",
  });

  // Spoofed sibling: same order, but its OWN internal customerId/vendorId
  // fields falsely claim vendorB/customerB are participants. Authorization
  // must still derive from the real parent order (vendorA/customerA), so
  // vendorB must still be denied despite the spoofed fields.
  spoofedPaymentId = uniq("cdp-spoof");
  await fdb.collection("orders").doc(orderId).collection("confirmedDirectPayments").doc(spoofedPaymentId).set({
    paymentId: spoofedPaymentId, orderId, vendorId: vendorBId, customerId: customerBUid,
    requestId: null, method: "cash", source: "cash_vendor_confirmed", amount: 1, currency: "NGN",
    confirmedByUid: vendorBUid, confirmedAt: admin.firestore.Timestamp.now(),
    customerAcknowledgement: "pending",
  });

  refundId = uniq("refund");
  await fdb.collection("orders").doc(orderId).collection("refunds").doc(refundId).set({
    refundId, orderId, vendorId: vendorAId, customerId: customerAUid,
    amount: 1000, currency: "NGN", method: "cash", reason: "Test refund",
    relatedPaymentIds: [confirmedPaymentId], type: "partial",
    attestedAt: admin.firestore.Timestamp.now(), attestedByUid: vendorAUid,
    customerConfirmation: "pending",
  });

  spoofedRefundId = uniq("refund-spoof");
  await fdb.collection("orders").doc(orderId).collection("refunds").doc(spoofedRefundId).set({
    refundId: spoofedRefundId, orderId, vendorId: vendorBId, customerId: customerBUid,
    amount: 1, currency: "NGN", method: "cash", reason: "Spoof",
    relatedPaymentIds: [], type: "partial",
    attestedAt: admin.firestore.Timestamp.now(), attestedByUid: vendorBUid,
    customerConfirmation: "pending",
  });

  disputeId = uniq("dispute");
  await fdb.collection("paymentDisputes").doc(disputeId).set({
    disputeId, orderId, vendorId: vendorAId, customerId: customerAUid,
    raisedByUid: customerAUid, raisedByRole: "customer",
    category: "payment", reasonCode: "PAID_VENDOR_SAYS_NOT_RECEIVED",
    status: "open", createdAt: admin.firestore.Timestamp.now(),
  });

  changeEventId = uniq("pice");
  await fdb.collection("paymentInstructionChangeEvents").doc(changeEventId).set({
    eventId: changeEventId, vendorId: vendorAId, actorUid: vendorAUid,
    changedAt: admin.firestore.Timestamp.now(), previousRecordId: null,
    newRecordId: paymentInstructionRecordId, riskLevel: "normal",
    accountNumberMaskedOld: null, accountNumberMaskedNew: "•••┢7890",
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 1: Vendor Payment Instructions
// ─────────────────────────────────────────────────────────────────────────
async function sectionPaymentInstructions() {
  console.log("\n📋 Payment Instructions — vendors/{vendorId}/paymentInstructions/{recordId}");
  const ref = () => doc(db, "vendors", vendorAId, "paymentInstructions", paymentInstructionRecordId);

  await test("Unauthenticated read denied", async () => {
    await signOut(auth);
    await assertDenied(getDoc(ref()));
  });

  await test("Unrelated customer denied (including one with an order from this vendor)", async () => {
    await signInAs(customerAEmail, PASSWORD); // customerA HAS an order with vendorA
    await assertDenied(getDoc(ref()));
  });

  await test("Unrelated vendor denied", async () => {
    await signInAs(vendorBEmail, PASSWORD);
    await assertDenied(getDoc(ref()));
  });

  await test("Correct vendor owner allowed", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertReadable(ref);
  });

  await test("Authenticated Admin raw read denied (masking is a callable-layer concern, not a rules-level grant)", async () => {
    await signInAs(adminEmail, PASSWORD);
    await assertDenied(getDoc(ref()));
  });

  await test("Client create denied (even by the vendor owner)", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(setDoc(doc(db, "vendors", vendorAId, "paymentInstructions", uniq("new")), {
      recordId: "x", vendorId: vendorAId, bankName: "X", accountNumber: "1", accountName: "X",
      isActive: true,
    }));
  });

  await test("Client update denied (even by the vendor owner)", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(updateDoc(ref(), { bankName: "Hacked Bank" }));
  });

  await test("Client delete denied (even by the vendor owner)", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(deleteDoc(ref()));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 2: Confirmed Direct Payments
// ─────────────────────────────────────────────────────────────────────────
async function sectionConfirmedDirectPayments() {
  console.log("\n📋 Confirmed Direct Payments — orders/{orderId}/confirmedDirectPayments/{paymentId}");
  const ref = () => doc(db, "orders", orderId, "confirmedDirectPayments", confirmedPaymentId);
  const spoofRef = () => doc(db, "orders", orderId, "confirmedDirectPayments", spoofedPaymentId);

  await test("Unauthenticated denied", async () => {
    await signOut(auth);
    await assertDenied(getDoc(ref()));
  });

  await test("Unrelated authenticated user denied", async () => {
    await signInAs(customerBEmail, PASSWORD);
    await assertDenied(getDoc(ref()));
  });

  await test("Correct order customer allowed", async () => {
    await signInAs(customerAEmail, PASSWORD);
    await assertReadable(ref);
  });

  await test("Correct order vendor allowed", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertReadable(ref);
  });

  await test("Client create denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(setDoc(doc(db, "orders", orderId, "confirmedDirectPayments", uniq("new")), {
      paymentId: "x", orderId, vendorId: vendorAId, customerId: customerAUid,
      requestId: null, method: "cash", source: "cash_vendor_confirmed", amount: 1, currency: "NGN",
      customerAcknowledgement: "pending",
    }));
  });

  await test("Client update denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(updateDoc(ref(), { amount: 999999 }));
  });

  await test("Client delete denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(deleteDoc(ref()));
  });

  await test("Malicious child document cannot grant access by spoofing customerId/vendorId fields", async () => {
    // spoofedPaymentId's OWN fields claim vendorB/customerB, but it lives
    // under the SAME real order (vendorA/customerA). vendorB must still be
    // denied, because authorization derives from the parent order via
    // get(), never from this child document's own fields.
    await signInAs(vendorBEmail, PASSWORD);
    await assertDenied(getDoc(spoofRef()));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 3: Refunds
// ─────────────────────────────────────────────────────────────────────────
async function sectionRefunds() {
  console.log("\n📋 Refunds — orders/{orderId}/refunds/{refundId}");
  const ref = () => doc(db, "orders", orderId, "refunds", refundId);
  const spoofRef = () => doc(db, "orders", orderId, "refunds", spoofedRefundId);

  await test("Unauthenticated denied", async () => {
    await signOut(auth);
    await assertDenied(getDoc(ref()));
  });

  await test("Unrelated authenticated user denied", async () => {
    await signInAs(customerBEmail, PASSWORD);
    await assertDenied(getDoc(ref()));
  });

  await test("Correct order customer allowed", async () => {
    await signInAs(customerAEmail, PASSWORD);
    await assertReadable(ref);
  });

  await test("Correct order vendor allowed", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertReadable(ref);
  });

  await test("Client create denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(setDoc(doc(db, "orders", orderId, "refunds", uniq("new")), {
      refundId: "x", orderId, vendorId: vendorAId, customerId: customerAUid,
      amount: 1, currency: "NGN", method: "cash", reason: "x", relatedPaymentIds: [], type: "partial",
      customerConfirmation: "pending",
    }));
  });

  await test("Client update denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(updateDoc(ref(), { amount: 999999 }));
  });

  await test("Client delete denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(deleteDoc(ref()));
  });

  await test("Malicious child document cannot grant access by spoofing customerId/vendorId fields", async () => {
    await signInAs(vendorBEmail, PASSWORD);
    await assertDenied(getDoc(spoofRef()));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 4: Payment Disputes
// ─────────────────────────────────────────────────────────────────────────
async function sectionPaymentDisputes() {
  console.log("\n📋 Payment Disputes — paymentDisputes/{disputeId}");
  const ref = () => doc(db, "paymentDisputes", disputeId);

  await test("Unauthenticated denied", async () => {
    await signOut(auth);
    await assertDenied(getDoc(ref()));
  });

  await test("Unrelated user denied", async () => {
    await signInAs(customerBEmail, PASSWORD);
    await assertDenied(getDoc(ref()));
  });

  await test("Direct participant raw-document read DENIED in this batch (even the customer who raised it)", async () => {
    await signInAs(customerAEmail, PASSWORD);
    await assertDenied(getDoc(ref()));
  });

  await test("Direct participant raw-document read DENIED in this batch (the order's vendor too)", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(getDoc(ref()));
  });

  await test("Client create denied", async () => {
    await signInAs(customerAEmail, PASSWORD);
    await assertDenied(setDoc(doc(db, "paymentDisputes", uniq("new")), {
      disputeId: "x", orderId, vendorId: vendorAId, customerId: customerAUid,
      raisedByUid: customerAUid, raisedByRole: "customer",
      category: "payment", reasonCode: "OTHER", status: "open",
    }));
  });

  await test("Client update denied", async () => {
    await signInAs(customerAEmail, PASSWORD);
    await assertDenied(updateDoc(ref(), { status: "resolved" }));
  });

  await test("Client delete denied", async () => {
    await signInAs(customerAEmail, PASSWORD);
    await assertDenied(deleteDoc(ref()));
  });

  await test("Only the intended existing Admin path is allowed (matches auditLogs/moderationEvents convention)", async () => {
    await signInAs(adminEmail, PASSWORD);
    await assertReadable(ref);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 5: Payment Instruction Change Events
// ─────────────────────────────────────────────────────────────────────────
async function sectionPaymentInstructionChangeEvents() {
  console.log("\n📋 Payment Instruction Change Events — paymentInstructionChangeEvents/{eventId}");
  const ref = () => doc(db, "paymentInstructionChangeEvents", changeEventId);

  await test("Unauthenticated denied", async () => {
    await signOut(auth);
    await assertDenied(getDoc(ref()));
  });

  await test("Customer denied", async () => {
    await signInAs(customerAEmail, PASSWORD);
    await assertDenied(getDoc(ref()));
  });

  await test("Unrelated vendor denied", async () => {
    await signInAs(vendorBEmail, PASSWORD);
    await assertDenied(getDoc(ref()));
  });

  await test("Correct vendor owner allowed", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertReadable(ref);
  });

  await test("Admin allowed", async () => {
    await signInAs(adminEmail, PASSWORD);
    await assertReadable(ref);
  });

  await test("Client create denied, including an attempt to spoof vendor ownership via the vendorId field", async () => {
    // vendorB tries to create an event claiming vendorId: vendorBId (i.e.
    // spoofing THEIR OWN ownership onto a brand-new doc) — must still be
    // denied outright; this collection has no client write path at all.
    await signInAs(vendorBEmail, PASSWORD);
    await assertDenied(setDoc(doc(db, "paymentInstructionChangeEvents", uniq("new")), {
      eventId: "x", vendorId: vendorBId, actorUid: vendorBUid,
      previousRecordId: null, newRecordId: "x", riskLevel: "normal",
      accountNumberMaskedOld: null, accountNumberMaskedNew: "•••┢1111",
    }));
  });

  await test("Client update denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(updateDoc(ref(), { riskLevel: "elevated" }));
  });

  await test("Client delete denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(deleteDoc(ref()));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 PLATFORM — Payment Domain Batch 1 Firestore Rules Acceptance Tests");
  console.log("=".repeat(60));

  await setupIdentities();
  await seedFixtureDocuments();

  await sectionPaymentInstructions();
  await sectionConfirmedDirectPayments();
  await sectionRefunds();
  await sectionPaymentDisputes();
  await sectionPaymentInstructionChangeEvents();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);

  if (failed === 0) {
    console.log("✅ ALL TESTS PASSED");
  } else {
    console.log("❌ SOME TESTS FAILED — see errors above");
    process.exitCode = 1;
  }

  process.exit(process.exitCode || 0);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
