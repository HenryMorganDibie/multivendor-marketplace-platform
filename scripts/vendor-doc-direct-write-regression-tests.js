/**
 * Batch 2A — vendors/{vendorId} direct-client-write security fix.
 *
 * Regression tests for the rules change that replaced:
 *   allow update: if (isVendorOwner(vendorId) && vendorOwnerUpdateAllowed());
 * with:
 *   allow update: if false;
 *
 * Full-repo audit (mobile app, twice-checked commits, plus the Operations
 * Console web admin app) found zero legitimate direct client writes to a
 * vendor document — every real mutation goes through a Cloud Functions
 * callable or a Firestore trigger, both of which use the Admin SDK and
 * bypass these rules entirely. The old vendorOwnerUpdateAllowed() denylist
 * had no `.keys().hasOnly(...)` bound, so any field NOT explicitly named
 * there (paymentInstructions, isPublished, verificationStatus,
 * ratingAverage, minimumOrderAmount, etc.) could be forged directly by a
 * vendor-owner client. This suite proves that gap is closed, that create/
 * delete remain denied as before, and that a legitimate server-side
 * (Admin SDK) write to the same document is completely unaffected by the
 * client-rule change, since Admin SDK writes never go through these rules.
 *
 * Requires the emulator suite running first (Firestore + Auth only):
 *   firebase emulators:start --only firestore,auth --project demo-platform
 *
 * Usage:
 *   node vendor-doc-direct-write-regression-tests.js
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

// ── helpers (mirrors payment-domain-phase1-rules-tests.js exactly) ────────
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
  // onUserCreate already assigns role:'customer' by default.
}

async function seedFixtureDocuments() {
  // Seeded directly via the Admin SDK, exactly like completeRegistration
  // would produce it — this suite is about the rules, not the callable.
  await fdb.collection("vendors").doc(vendorAId).set({
    vendorId: vendorAId,
    ownerUid: vendorAUid,
    username: uniq("vendorA-username"),
    name: "Test Vendor A",
    businessName: "Test Vendor A Ltd",
    countryCode: "NG",
    country: "Nigeria",
    verificationStatus: "approved",
    vendorStatus: "active",
    isVerified: true,
    isPublished: true,
    isDiscoverable: true,
    plan: "basic",
    ratingAverage: 4.5,
    ratingCount: 10,
    paymentInstructionsEnabled: true,
    paymentInstructions: "Original, legitimately-set instructions",
    createdAt: admin.firestore.Timestamp.now(),
    updatedAt: admin.firestore.Timestamp.now(),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 1: Direct client UPDATE — every case must now be denied
// ─────────────────────────────────────────────────────────────────────────
async function sectionDirectUpdateDenied() {
  console.log("\n📋 Direct client update of vendors/{vendorId} — must ALL be denied");
  const ref = () => doc(db, "vendors", vendorAId);

  await test("Vendor owner: forging paymentInstructions denied (the original exploit)", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(updateDoc(ref(), { paymentInstructions: "FORGED BANK DETAILS" }));
  });

  await test("Vendor owner: forging isPublished denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(updateDoc(ref(), { isPublished: false }));
  });

  await test("Vendor owner: forging verificationStatus denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(updateDoc(ref(), { verificationStatus: "approved" }));
  });

  await test("Vendor owner: forging ratingAverage denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(updateDoc(ref(), { ratingAverage: 5 }));
  });

  await test("Vendor owner: forging minimumOrderAmount denied (legitimate-but-callable-only field)", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(updateDoc(ref(), { minimumOrderAmount: 500 }));
  });

  await test("Vendor owner: empty-object update denied (no bypass via a no-op write)", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(updateDoc(ref(), {}));
  });

  await test("Different authenticated vendor (not the owner) denied", async () => {
    await signInAs(vendorBEmail, PASSWORD);
    await assertDenied(updateDoc(ref(), { paymentInstructions: "vendorB trying to overwrite vendorA" }));
  });

  await test("Different authenticated customer denied", async () => {
    await signInAs(customerAEmail, PASSWORD);
    await assertDenied(updateDoc(ref(), { paymentInstructions: "customer trying to overwrite vendorA" }));
  });

  await test("Unauthenticated client denied", async () => {
    await signOut(auth);
    await assertDenied(updateDoc(ref(), { paymentInstructions: "anonymous write" }));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 2: Direct client CREATE / DELETE — must remain denied (unchanged)
// ─────────────────────────────────────────────────────────────────────────
async function sectionCreateDeleteStillDenied() {
  console.log("\n📋 Direct client create/delete of vendors/{vendorId} — regression guard (unchanged by this fix)");

  await test("Unauthenticated create denied", async () => {
    await signOut(auth);
    const fakeId = uniq("fake-vendor");
    await assertDenied(setDoc(doc(db, "vendors", fakeId), { vendorId: fakeId, ownerUid: "nobody" }));
  });

  await test("Authenticated vendor creating an arbitrary new vendor doc denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    const fakeId = uniq("fake-vendor");
    await assertDenied(setDoc(doc(db, "vendors", fakeId), { vendorId: fakeId, ownerUid: vendorAUid }));
  });

  await test("Vendor owner deleting their own vendor doc denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(deleteDoc(doc(db, "vendors", vendorAId)));
  });

  await test("Unauthenticated delete denied", async () => {
    await signOut(auth);
    await assertDenied(deleteDoc(doc(db, "vendors", vendorAId)));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 3: Read behavior unchanged (this fix touches update only)
// ─────────────────────────────────────────────────────────────────────────
async function sectionReadUnaffected() {
  console.log("\n📋 Read behavior sanity check — confirms the fix is surgical (read rule untouched)");

  await test("Vendor owner can still read their own vendor doc", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    const snap = await getDoc(doc(db, "vendors", vendorAId));
    assert(snap.exists(), "Owner read should still succeed");
  });

  await test("Discoverable vendor doc still publicly readable (unauthenticated)", async () => {
    await signOut(auth);
    const snap = await getDoc(doc(db, "vendors", vendorAId));
    assert(snap.exists(), "Discoverable vendor should still be readable while unauthenticated");
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 4: Legitimate server-side (Admin SDK) writes are unaffected
// ─────────────────────────────────────────────────────────────────────────
// This does not invoke or modify any production callable -- it proves the
// underlying mechanism every real callable relies on (the Admin SDK bypasses
// Firestore Rules entirely) is untouched by this change, using the same
// direct Admin SDK write pattern this suite already uses for fixture
// seeding above.
async function sectionServerSideWritesUnaffected() {
  console.log("\n📋 Server-side (Admin SDK) mutation — must remain completely unaffected by the client-rule change");

  await test("Admin SDK can still update the exact fields denied to clients above", async () => {
    const vendorRef = fdb.collection("vendors").doc(vendorAId);
    await vendorRef.update({
      paymentInstructions: "Updated via Admin SDK (simulates a real callable)",
      isPublished: false,
      verificationStatus: "pending_review",
      ratingAverage: 3.2,
      minimumOrderAmount: 1000,
      updatedAt: admin.firestore.Timestamp.now(),
    });
    const snap = await vendorRef.get();
    assert(snap.get("paymentInstructions") === "Updated via Admin SDK (simulates a real callable)", "Admin SDK write should have succeeded and be readable back");
    assert(snap.get("isPublished") === false, "Admin SDK write of isPublished should have succeeded");
    assert(snap.get("minimumOrderAmount") === 1000, "Admin SDK write of minimumOrderAmount should have succeeded");
  });
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 PLATFORM — Batch 2A vendors/{vendorId} direct-write regression tests");
  console.log("=".repeat(60));

  await setupIdentities();
  await seedFixtureDocuments();

  await sectionDirectUpdateDenied();
  await sectionCreateDeleteStillDenied();
  await sectionReadUnaffected();
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
