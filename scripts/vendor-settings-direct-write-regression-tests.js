/**
 * Batch 2A.1 — vendors/{vendorId}/settings/{settingsDoc} write hardening.
 *
 * Regression tests for the rules change that replaced:
 *   allow write: if isVendorOwner(vendorId)
 *                && !(settingsDoc in ['notifications', 'chat', 'pickup']);
 * with:
 *   allow write: if false;
 *
 * Read-only audit found the old rule was a denylist naming only three
 * settingsDoc IDs, so a vendor-owner client could create, overwrite, or
 * delete a document under ANY OTHER settingsDoc name with arbitrary
 * content -- no format/allowlist constraint on the ID itself. Full-repo
 * evidence found zero legitimate direct client writes to any settingsDoc
 * ID, including 'notifications'/'chat'/'pickup' (each already has its own
 * dedicated `allow write: if false` block) and including 'storefront' (no
 * document with that ID is ever created or read by any Cloud Function).
 * This suite proves the new blanket denial holds for arbitrary IDs and for
 * the three named ones, that reads and the 'storefront' public-read
 * carve-out are unaffected, and that legitimate server-side (Admin SDK)
 * writes remain completely unaffected.
 *
 * Requires the emulator suite running first (Firestore + Auth only):
 *   firebase emulators:start --only firestore,auth --project demo-platform
 *
 * Usage:
 *   node vendor-settings-direct-write-regression-tests.js
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

// ── helpers (mirrors vendor-doc-direct-write-regression-tests.js exactly) ──
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
}

async function seedFixtureDocuments() {
  // Vendor doc seeded directly via the Admin SDK, same pattern the other
  // suites in this repo already use. isDiscoverable: true is needed for
  // the 'storefront' public-read carve-out test below.
  await fdb.collection("vendors").doc(vendorAId).set({
    vendorId: vendorAId,
    ownerUid: vendorAUid,
    username: uniq("vendorA-username"),
    name: "Test Vendor A",
    countryCode: "NG",
    country: "Nigeria",
    verificationStatus: "approved",
    vendorStatus: "active",
    isVerified: true,
    isPublished: true,
    isDiscoverable: true,
    plan: "basic",
    createdAt: admin.firestore.Timestamp.now(),
    updatedAt: admin.firestore.Timestamp.now(),
  });

  // Existing settings documents, seeded via Admin SDK -- exactly how the
  // real callables (updateVendorNotificationPreferences,
  // updateVendorChatSettings, updateVendorPickupSettings) create them.
  // Seeding here rather than weakening rules to create test state.
  await fdb.collection("vendors").doc(vendorAId).collection("settings").doc("notifications").set({
    securityAlerts: true, orderUpdates: true,
  });
  await fdb.collection("vendors").doc(vendorAId).collection("settings").doc("chat").set({
    greetingMessage: "Welcome!", awayMessage: "We're away.",
  });
  await fdb.collection("vendors").doc(vendorAId).collection("settings").doc("pickup").set({
    autoSendPickupDetailsEnabled: false, pickupAddress: { line1: "123 Test St" },
  });

  // An existing document under a non-special ID, to prove update/delete of
  // an already-existing arbitrary document is also denied, not just create.
  await fdb.collection("vendors").doc(vendorAId).collection("settings").doc("preexisting-arbitrary").set({
    seededBy: "admin-sdk-fixture",
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 1: Arbitrary settingsDoc IDs — must ALL be denied
// ─────────────────────────────────────────────────────────────────────────
async function sectionArbitraryIdsDenied() {
  console.log("\n📋 Arbitrary settingsDoc IDs — direct client write must be denied");

  await test("Vendor owner: create a brand-new arbitrary settingsDoc denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(setDoc(doc(db, "vendors", vendorAId, "settings", "anything-new"), { foo: "bar" }));
  });

  await test("Vendor owner: update an existing arbitrary settingsDoc denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(updateDoc(doc(db, "vendors", vendorAId, "settings", "preexisting-arbitrary"), { foo: "hacked" }));
  });

  await test("Vendor owner: delete an existing arbitrary settingsDoc denied", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    await assertDenied(deleteDoc(doc(db, "vendors", vendorAId, "settings", "preexisting-arbitrary")));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 2: The three named settingsDoc IDs — must remain fully denied
// ─────────────────────────────────────────────────────────────────────────
async function sectionNamedIdsDenied() {
  console.log("\n📋 notifications / chat / pickup — direct client write must remain denied");

  for (const settingsDoc of ["notifications", "chat", "pickup"]) {
    await test(`Vendor owner: create ${settingsDoc} (already exists) via setDoc denied`, async () => {
      await signInAs(vendorAEmail, PASSWORD);
      await assertDenied(setDoc(doc(db, "vendors", vendorAId, "settings", settingsDoc), { forged: true }));
    });

    await test(`Vendor owner: update ${settingsDoc} denied`, async () => {
      await signInAs(vendorAEmail, PASSWORD);
      await assertDenied(updateDoc(doc(db, "vendors", vendorAId, "settings", settingsDoc), { forged: true }));
    });

    await test(`Vendor owner: delete ${settingsDoc} denied`, async () => {
      await signInAs(vendorAEmail, PASSWORD);
      await assertDenied(deleteDoc(doc(db, "vendors", vendorAId, "settings", settingsDoc)));
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 3: Cross-vendor / unauthenticated denial
// ─────────────────────────────────────────────────────────────────────────
async function sectionCrossVendorAndUnauthDenied() {
  console.log("\n📋 Different vendor / unauthenticated — must be denied");

  await test("Different vendor (not the owner) denied", async () => {
    await signInAs(vendorBEmail, PASSWORD);
    await assertDenied(setDoc(doc(db, "vendors", vendorAId, "settings", "anything-new"), { foo: "bar" }));
  });

  await test("Unauthenticated client denied", async () => {
    await signOut(auth);
    await assertDenied(setDoc(doc(db, "vendors", vendorAId, "settings", "anything-new"), { foo: "bar" }));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 4: Read behavior unchanged (this fix touches write only)
// ─────────────────────────────────────────────────────────────────────────
async function sectionReadUnaffected() {
  console.log("\n📋 Read behavior sanity check — confirms the fix is surgical (read rule untouched)");

  await test("Vendor owner can still read settings/notifications", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    const snap = await getDoc(doc(db, "vendors", vendorAId, "settings", "notifications"));
    assert(snap.exists(), "Owner read of notifications should still succeed");
  });

  await test("Vendor owner can still read settings/chat", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    const snap = await getDoc(doc(db, "vendors", vendorAId, "settings", "chat"));
    assert(snap.exists(), "Owner read of chat should still succeed");
  });

  await test("Vendor owner can still read settings/pickup", async () => {
    await signInAs(vendorAEmail, PASSWORD);
    const snap = await getDoc(doc(db, "vendors", vendorAId, "settings", "pickup"));
    assert(snap.exists(), "Owner read of pickup should still succeed");
  });

  await test("Public settings/storefront read for a discoverable vendor is unchanged (no document exists, but the read itself is not denied by rules)", async () => {
    await signOut(auth);
    // No 'storefront' document is ever created in real usage; this confirms
    // the read RULE still permits the attempt (resolves to "not found", not
    // "permission-denied") for a discoverable vendor, exactly as before.
    const snap = await getDoc(doc(db, "vendors", vendorAId, "settings", "storefront"));
    assert(snap.exists() === false, "No storefront document exists; the read itself must not be denied by rules");
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 5: Legitimate server-side (Admin SDK) writes are unaffected
// ─────────────────────────────────────────────────────────────────────────
async function sectionServerSideWritesUnaffected() {
  console.log("\n📋 Server-side (Admin SDK) mutation — must remain completely unaffected by the client-rule change");

  await test("Admin SDK can still write settings/notifications, settings/chat, settings/pickup", async () => {
    const base = fdb.collection("vendors").doc(vendorAId).collection("settings");
    await base.doc("notifications").set({ securityAlerts: true, orderUpdates: false }, { merge: true });
    await base.doc("chat").set({ greetingMessage: "Updated via Admin SDK" }, { merge: true });
    await base.doc("pickup").set({ autoSendPickupDetailsEnabled: true }, { merge: true });

    const notifSnap = await base.doc("notifications").get();
    const chatSnap = await base.doc("chat").get();
    const pickupSnap = await base.doc("pickup").get();
    assert(notifSnap.get("orderUpdates") === false, "Admin SDK write to notifications should have succeeded");
    assert(chatSnap.get("greetingMessage") === "Updated via Admin SDK", "Admin SDK write to chat should have succeeded");
    assert(pickupSnap.get("autoSendPickupDetailsEnabled") === true, "Admin SDK write to pickup should have succeeded");
  });
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 PLATFORM — Batch 2A.1 vendors/{vendorId}/settings/{settingsDoc} write regression tests");
  console.log("=".repeat(60));

  await setupIdentities();
  await seedFixtureDocuments();

  await sectionArbitraryIdsDenied();
  await sectionNamedIdsDenied();
  await sectionCrossVendorAndUnauthDenied();
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
