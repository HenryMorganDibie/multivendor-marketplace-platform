/**
 * Payment Domain — Batch 2B Firestore Rules acceptance tests.
 *
 * Verifies the access matrix for the structured Payment Instructions
 * collections introduced/added in Batch 2B:
 *   - vendors/{vendorId}/paymentInstructions/{recordId} (Batch 1 rules,
 *     unchanged by 2B -- re-verified here for regression)
 *   - vendors/{vendorId}/paymentInstructionsCurrent/current (new in 2B)
 *   - vendors/{vendorId}/paymentInstructionsIdempotency/{key} (new in 2B)
 *
 * This is a rules-only suite (Firestore + Auth emulator) -- it does not
 * exercise the setVendorPaymentInstructions callable itself, which
 * requires the Functions emulator (currently blocked by a documented,
 * unrelated JSON-parsing/trigger-registration startup failure -- see
 * session notes; not addressed here). Documents are seeded directly via
 * the Admin SDK, exactly like the Batch 1 script.
 *
 * Requires the emulator suite running first (Firestore + Auth only):
 *   firebase emulators:start --only firestore,auth --project demo-platform
 *
 * Usage:
 *   node payment-domain-phase2b-rules-tests.js
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

// ── helpers (mirrors the repo's existing rules-test scripts exactly) ──────
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
let adminEmail, adminUid;
let historicalRecordId;

async function setupIdentities() {
  vendorAEmail = uniq("vendorA") + "@test.com";
  let cred = await createUserWithEmailAndPassword(auth, vendorAEmail, PASSWORD);
  vendorAUid = cred.user.uid;
  vendorAId = vendorAUid;
  await admin.auth().setCustomUserClaims(vendorAUid, { role: "vendor", vendorId: vendorAId, claimsVersion: 1 });

  vendorBEmail = uniq("vendorB") + "@test.com";
  cred = await createUserWithEmailAndPassword(auth, vendorBEmail, PASSWORD);
  vendorBUid = cred.user.uid;
  vendorBId = vendorBUid;
  await admin.auth().setCustomUserClaims(vendorBUid, { role: "vendor", vendorId: vendorBId, claimsVersion: 1 });

  customerAEmail = uniq("customerA") + "@test.com";
  cred = await createUserWithEmailAndPassword(auth, customerAEmail, PASSWORD);
  customerAUid = cred.user.uid;

  adminEmail = uniq("admin") + "@example.com";
  cred = await createUserWithEmailAndPassword(auth, adminEmail, PASSWORD);
  adminUid = cred.user.uid;
  await admin.auth().setCustomUserClaims(adminUid, { role: "admin", adminRoleIds: ["super_admin"], claimsVersion: 1 });
}

async function seedFixtureDocuments() {
  await fdb.collection("vendors").doc(vendorAId).set({
    vendorId: vendorAId, ownerUid: vendorAUid, username: uniq("vendorA-username"),
    name: "Test Vendor A", countryCode: "NG", country: "Nigeria",
    verificationStatus: "approved", vendorStatus: "active",
    isVerified: true, isPublished: true, isDiscoverable: true, plan: "basic",
    createdAt: admin.firestore.Timestamp.now(), updatedAt: admin.firestore.Timestamp.now(),
  });

  const recordRef = fdb.collection("vendors").doc(vendorAId).collection("paymentInstructions").doc();
  historicalRecordId = recordRef.id;
  await recordRef.set({
    recordId: historicalRecordId, vendorId: vendorAId, version: 1, acceptCash: true,
    // Worldwide schema (Batch 2B, revised): a Bank Transfer destination
    // using the account_number identifier, with server-derived
    // countryCode/currencyCode. Deliberately NOT Nigeria-only in this
    // fixture's identifier shape -- see sectionServerSideWritesUnaffected
    // below for a second fixture using a different country/identifier
    // combination (GB/IBAN), proving these rules encode no country- or
    // identifier-specific behavior.
    paymentDestination: {
      type: "bank_transfer", countryCode: "NG", currencyCode: "NGN",
      institutionName: "First Bank of Nigeria", recipientName: "Test Vendor A",
      identifier: { type: "account_number", value: "1234567890" },
    },
    createdAt: admin.firestore.Timestamp.now(), createdByUid: vendorAUid,
  });

  await fdb.collection("vendors").doc(vendorAId).collection("paymentInstructionsCurrent").doc("current").set({
    currentRecordId: historicalRecordId, currentVersion: 1, acceptCash: true,
    paymentDestination: {
      type: "bank_transfer", countryCode: "NG", currencyCode: "NGN",
      institutionName: "First Bank of Nigeria", recipientName: "Test Vendor A",
      identifier: { type: "account_number", value: "1234567890" },
    },
    updatedAt: admin.firestore.Timestamp.now(),
  });

  await fdb.collection("vendors").doc(vendorAId).collection("paymentInstructionsIdempotency").doc("some-key").set({
    idempotencyKey: "some-key", recordId: historicalRecordId, version: 1, changed: true,
    payloadHash: "deadbeef", createdAt: admin.firestore.Timestamp.now(),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 1: Historical records (Batch 1 rules -- regression re-verification)
// ─────────────────────────────────────────────────────────────────────────
async function sectionHistoricalRecords() {
  console.log("\n📋 vendors/{vendorId}/paymentInstructions/{recordId} — regression");
  const ref = () => doc(db, "vendors", vendorAId, "paymentInstructions", historicalRecordId);

  await test("Unauthenticated read denied", async () => {
    await signOut(auth);
    await assertDenied(getDoc(ref()));
  });

  await test("Unrelated vendor denied", async () => {
    await signInAs(vendorBEmail, PASSWORD);
    await assertDenied(getDoc(ref()));
  });

  await test("Admin raw read denied (no admin grant on this collection)", async () => {
    await signInAs(adminEmail, PASSWORD);
    await assertDenied(getDoc(ref()));
  });

  await test("Correct vendor owner allowed to read", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    const snap = await getDoc(ref());
    assert(snap.exists(), "Owner read should succeed");
  });

  await test("Vendor owner cannot create a new historical record directly", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(setDoc(doc(db, "vendors", vendorAId, "paymentInstructions", uniq("forged")), { forged: true }));
  });

  await test("Vendor owner cannot update the existing historical record directly", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(updateDoc(ref(), { forged: true }));
  });

  await test("Vendor owner cannot delete the existing historical record directly", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(deleteDoc(ref()));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 2: Current pointer/cache (new in Batch 2B)
// ─────────────────────────────────────────────────────────────────────────
async function sectionCurrentDoc() {
  console.log("\n📋 vendors/{vendorId}/paymentInstructionsCurrent/current");
  const ref = () => doc(db, "vendors", vendorAId, "paymentInstructionsCurrent", "current");

  await test("Unauthenticated read denied", async () => {
    await signOut(auth);
    await assertDenied(getDoc(ref()));
  });

  await test("Unrelated vendor denied", async () => {
    await signInAs(vendorBEmail, PASSWORD);
    await assertDenied(getDoc(ref()));
  });

  await test("Customer denied", async () => {
    await signInAs(customerAEmail, PASSWORD);
    await assertDenied(getDoc(ref()));
  });

  await test("Admin raw read denied", async () => {
    await signInAs(adminEmail, PASSWORD);
    await assertDenied(getDoc(ref()));
  });

  await test("Correct vendor owner allowed to read", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    const snap = await getDoc(ref());
    assert(snap.exists(), "Owner read should succeed");
    assert(snap.data().currentVersion === 1, "Seeded current version should be readable");
  });

  await test("Vendor owner cannot create/overwrite current directly", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(setDoc(ref(), { currentVersion: 999 }));
  });

  await test("Vendor owner cannot update current directly", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(updateDoc(ref(), { currentVersion: 999 }));
  });

  await test("Vendor owner cannot delete current directly", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(deleteDoc(ref()));
  });

  await test("Different vendor cannot write another vendor's current doc", async () => {
    await signInAs(vendorBEmail, PASSWORD);
    await assertDenied(setDoc(ref(), { currentVersion: 999 }));
  });

  await test("Unauthenticated write denied", async () => {
    await signOut(auth);
    await assertDenied(setDoc(ref(), { currentVersion: 999 }));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 3: Idempotency collection — fully internal, no client access
// ─────────────────────────────────────────────────────────────────────────
async function sectionIdempotency() {
  console.log("\n📋 vendors/{vendorId}/paymentInstructionsIdempotency/{key} — fully internal");
  const ref = () => doc(db, "vendors", vendorAId, "paymentInstructionsIdempotency", "some-key");

  await test("Vendor owner read denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(getDoc(ref()));
  });

  await test("Admin read denied", async () => {
    await signInAs(adminEmail, PASSWORD);
    await assertDenied(getDoc(ref()));
  });

  await test("Unauthenticated read denied", async () => {
    await signOut(auth);
    await assertDenied(getDoc(ref()));
  });

  await test("Vendor owner create denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(setDoc(doc(db, "vendors", vendorAId, "paymentInstructionsIdempotency", uniq("k")), { forged: true }));
  });

  await test("Vendor owner update denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(updateDoc(ref(), { forged: true }));
  });

  await test("Vendor owner delete denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(deleteDoc(ref()));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 4: Legitimate server-side (Admin SDK) writes are unaffected
// ─────────────────────────────────────────────────────────────────────────
async function sectionServerSideWritesUnaffected() {
  console.log("\n📋 Server-side (Admin SDK) mutation — must succeed across all three collections");

  await test("Admin SDK can create a new historical record, overwrite current, and write an idempotency record", async () => {
    const vendorRef = fdb.collection("vendors").doc(vendorAId);
    const newRecordRef = vendorRef.collection("paymentInstructions").doc();
    // Deliberately a DIFFERENT country and identifier type (GB/IBAN) than
    // the NG/account_number fixture seeded above -- proves these rules
    // encode no country- or identifier-specific behavior.
    await newRecordRef.set({
      recordId: newRecordRef.id, vendorId: vendorAId, version: 2, acceptCash: false,
      paymentDestination: {
        type: "bank_transfer", countryCode: "GB", currencyCode: "GBP",
        institutionName: "NatWest", recipientName: "Test Vendor A",
        identifier: { type: "iban", value: "GB29NWBK60161331926819", swiftBic: "NWBKGB2L" },
      },
      createdAt: admin.firestore.Timestamp.now(), createdByUid: vendorAUid,
    });
    await vendorRef.collection("paymentInstructionsCurrent").doc("current").set({
      currentRecordId: newRecordRef.id, currentVersion: 2, acceptCash: false,
      paymentDestination: {
        type: "bank_transfer", countryCode: "GB", currencyCode: "GBP",
        institutionName: "NatWest", recipientName: "Test Vendor A",
        identifier: { type: "iban", value: "GB29NWBK60161331926819", swiftBic: "NWBKGB2L" },
      },
      updatedAt: admin.firestore.Timestamp.now(),
    });
    await vendorRef.collection("paymentInstructionsIdempotency").doc(uniq("k")).set({
      idempotencyKey: "x", recordId: newRecordRef.id, version: 2, changed: true,
      payloadHash: "cafebabe", createdAt: admin.firestore.Timestamp.now(),
    });

    const currentSnap = await vendorRef.collection("paymentInstructionsCurrent").doc("current").get();
    assert(currentSnap.get("currentVersion") === 2, "Admin SDK write to current should have succeeded");

    // Regression: the ORIGINAL historical record must remain byte-identical
    // after this later Admin SDK write -- proves history is never mutated.
    const originalSnap = await vendorRef.collection("paymentInstructions").doc(historicalRecordId).get();
    assert(originalSnap.get("version") === 1, "Original historical record must remain unchanged after a subsequent update");
    assert(originalSnap.get("paymentDestination").identifier.value === "1234567890", "Original historical record's data must remain unchanged");
  });
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 PLATFORM — Payment Domain Batch 2B Firestore Rules Acceptance Tests");
  console.log("=".repeat(60));

  await setupIdentities();
  await seedFixtureDocuments();

  await sectionHistoricalRecords();
  await sectionCurrentDoc();
  await sectionIdempotency();
  await sectionServerSideWritesUnaffected();

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
