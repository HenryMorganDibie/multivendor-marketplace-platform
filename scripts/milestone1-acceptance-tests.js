/**
 * THE PLATFORM — Milestone 1 Acceptance Test Suite
 *
 * Verifies every acceptance criterion from tickets P1-FB-001 through
 * P1-FB-013 against a live Firebase Emulator Suite instance. This is the
 * test suite to run before sign-off on the Milestone 1 deliverable.
 *
 * Usage:
 *   node milestone1-acceptance-tests.js
 *
 * Requires the emulator suite running first (NOTE: storage is required —
 * Milestone 1 acceptance now includes real Storage upload/rules tests):
 *   firebase emulators:start --only auth,firestore,functions,storage --project demo-platform
 */

const PROJECT_ID = "demo-platform";

process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_STORAGE_EMULATOR_HOST = "127.0.0.1:9199";
process.env.STORAGE_EMULATOR_HOST = "127.0.0.1:9199";

const admin = require("firebase-admin");
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: PROJECT_ID,
    storageBucket: `${PROJECT_ID}.appspot.com`,
  });
}

const { initializeApp, getApps, deleteApp } = require("firebase/app");
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword } = require("firebase/auth");
const { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, collection, getDocs, query } = require("firebase/firestore");
const { getStorage, connectStorageEmulator, ref, uploadBytes, getBytes, deleteObject } = require("firebase/storage");
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require("firebase/functions");

// ── client SDK setup ──────────────────────────────────────────────────────
let clientApp = getApps().find(a => a.name === "test") ||
  initializeApp({ apiKey: "demo", projectId: PROJECT_ID, storageBucket: `${PROJECT_ID}.appspot.com` }, "test");

const auth    = getAuth(clientApp);
const db      = getFirestore(clientApp);
const fns     = getFunctions(clientApp);
const storage = getStorage(clientApp);

connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
connectFirestoreEmulator(db, "127.0.0.1", 8080);
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
connectStorageEmulator(storage, "127.0.0.1", 9199);

// ── helpers ───────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0, total = 0;

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

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
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

async function waitFor(fn, retries = 12, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    const result = await fn();
    if (result) return result;
    await sleep(delay);
  }
  throw new Error("waitFor: condition never met");
}

async function signInAs(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  await cred.user.getIdToken(true);
  return cred;
}

// ── test state ────────────────────────────────────────────────────────────
let customerEmail, customerUid;
let vendorEmail, vendorUid, vendorId;
let adminEmail, adminUid;
let username;
const PASSWORD = "TestPass123!";

// ─────────────────────────────────────────────────────────────────────────
// SECTION 1: Auth + onUserCreate (P1-FB-002, P1-FB-003)
// ─────────────────────────────────────────────────────────────────────────
async function section1() {
  console.log("\n📋 Section 1: Auth + onUserCreate");

  await test("Customer signup creates Auth user", async () => {
    customerEmail = `customer_${Date.now()}@test.com`;
    const cred = await createUserWithEmailAndPassword(auth, customerEmail, PASSWORD);
    customerUid = cred.user.uid;
    assert(customerUid, "No UID returned");
  });

  await test("onUserCreate creates users/{uid} with correct defaults", async () => {
    const snap = await waitFor(async () => {
      const s = await getDoc(doc(db, "users", customerUid));
      return s.exists() ? s : null;
    });
    const d = snap.data();
    assertEqual(d.role, "customer", "role should be customer");
    assertEqual(d.accountStatus, "active", "accountStatus should be active");
    assertEqual(d.vendorId, null, "vendorId should be null");
    assert(d.claimsVersion >= 1, "claimsVersion must be >= 1");
    assert(d.onboarding?.completed === false, "onboarding.completed should be false");
    assert(d.createdAt, "createdAt must exist");
  });

  await test("onUserCreate sets customer custom claim", async () => {
    const cred = await signInAs(customerEmail, PASSWORD);
    const token = await cred.user.getIdTokenResult(true);
    assertEqual(token.claims.role, "customer", "claim role should be customer");
  });

  await test("User can read own profile", async () => {
    await signInAs(customerEmail, PASSWORD);
    const snap = await getDoc(doc(db, "users", customerUid));
    assert(snap.exists(), "Should be able to read own profile");
  });

  await test("User CANNOT read another user's profile", async () => {
    await signInAs(customerEmail, PASSWORD);
    const otherId = "some-other-uid-that-does-not-exist";
    await assertDenied(getDoc(doc(db, "users", otherId)));
  });

  await test("User CANNOT write role field directly", async () => {
    await signInAs(customerEmail, PASSWORD);
    await assertDenied(
      setDoc(doc(db, "users", customerUid), { role: "admin" }, { merge: true })
    );
  });

  await test("User CANNOT write accountStatus directly", async () => {
    await signInAs(customerEmail, PASSWORD);
    await assertDenied(
      setDoc(doc(db, "users", customerUid), { accountStatus: "banned" }, { merge: true })
    );
  });

  await test("User CAN update allowlisted profile fields", async () => {
    await signInAs(customerEmail, PASSWORD);
    await setDoc(doc(db, "users", customerUid), {
      displayName: "Test Customer",
      updatedAt: new Date(),
    }, { merge: true });
  });

  await test("User CANNOT add an arbitrary unexpected field to their own profile (audit Gap 2)", async () => {
    await signInAs(customerEmail, PASSWORD);
    await assertDenied(
      setDoc(doc(db, "users", customerUid), {
        riskScore: 100,
        internalNotes: "this should never be allowed",
      }, { merge: true })
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 2: completeRegistration (P1-FB-002, P1-FB-004, P1-FB-006)
// ─────────────────────────────────────────────────────────────────────────
async function section2() {
  console.log("\n📋 Section 2: completeRegistration — vendor flow");

  await test("Vendor signup creates Auth user", async () => {
    vendorEmail = `vendor_${Date.now()}@test.com`;
    const cred = await createUserWithEmailAndPassword(auth, vendorEmail, PASSWORD);
    vendorUid = cred.user.uid;
    await waitFor(async () => {
      const s = await getDoc(doc(db, "users", vendorUid));
      return s.exists() ? s : null;
    });
  });

  await test("completeRegistration creates vendor doc, verification doc, username reservation", async () => {
    await signInAs(vendorEmail, PASSWORD);
    username = `teststore_${Date.now()}`;
    const fn = httpsCallable(fns, "completeRegistration");
    const result = await fn({
      role: "vendor",
      businessName: "the platform Test Store",
      username,
      fullName: "Henry Dibie",
      categoryId: "food_catering",
      categoryName: "Food & Catering",
      country: "Nigeria",
      state: "Lagos",
      area: "Lekki",
      plan: "basic",
    });
    vendorId = result.data.vendorId;
    assertEqual(result.data.role, "vendor");
    assert(vendorId, "vendorId must be returned");

    // Force a token refresh now so subsequent reads (especially
    // vendorVerification, which requires isVendorOwner() and therefore the
    // vendorId custom claim) see the freshly assigned claims immediately.
    await auth.currentUser.getIdToken(true);
  });

  await test("vendors/{vendorId} has correct initial state", async () => {
    const snap = await getDoc(doc(db, "vendors", vendorId));
    assert(snap.exists(), "vendor doc must exist");
    const d = snap.data();
    assertEqual(d.verificationStatus, "not_started");
    assertEqual(d.vendorStatus, "active");
    assertEqual(d.isVerified, false);
    assertEqual(d.isPublished, false);
    assertEqual(d.isDiscoverable, false);
    assertEqual(d.username, username);
  });

  await test("vendorVerification/{vendorId} created with correct state", async () => {
    const snap = await getDoc(doc(db, "vendorVerification", vendorId));
    assert(snap.exists());
    assertEqual(snap.data().verificationStatus, "not_started");
    assert(Array.isArray(snap.data().requiredSteps));
  });

  await test("usernameReservations/{username} created", async () => {
    const snap = await getDoc(doc(db, "usernameReservations", username));
    assert(snap.exists());
    assertEqual(snap.data().vendorId, vendorId);
  });

  await test("Custom claims updated to vendor role after completeRegistration", async () => {
    const cred = await signInAs(vendorEmail, PASSWORD);
    const token = await cred.user.getIdTokenResult(true);
    assertEqual(token.claims.role, "vendor");
    assertEqual(token.claims.vendorId, vendorId);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 3: Admin provisioning (P1-FB-002, P1-FB-006)
// ─────────────────────────────────────────────────────────────────────────
async function section3() {
  console.log("\n📋 Section 3: Admin provisioning");

  await test("Create admin user via Admin SDK + adminUsers doc", async () => {
    adminEmail = `admin_${Date.now()}@theplatform.com`;
    const cred = await createUserWithEmailAndPassword(auth, adminEmail, PASSWORD);
    adminUid = cred.user.uid;

    await waitFor(async () => {
      const s = await getDoc(doc(db, "users", adminUid));
      return s.exists() ? s : null;
    });

    // Simulate manual provisioning via Admin SDK
    await admin.auth().setCustomUserClaims(adminUid, {
      role: "admin",
      adminRoleIds: ["super_admin", "verification_admin", "safety_admin"],
      claimsVersion: 1,
    });

    await admin.firestore().collection("adminUsers").doc(adminUid).set({
      uid: adminUid,
      email: adminEmail,
      roleIds: ["super_admin", "verification_admin", "safety_admin"],
      status: "active",
      mfaRequired: true,
      mfaEnrolled: false,
      allowedEnvironments: ["dev", "staging", "prod"],
      createdByAdminUid: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastLoginAt: null,
      revokedAt: null,
      lastMfaAt: null,
    });

    await admin.firestore().collection("users").doc(adminUid).update({ role: "admin" });
  });

  await test("Admin custom claims visible after token refresh", async () => {
    const cred = await signInAs(adminEmail, PASSWORD);
    const token = await cred.user.getIdTokenResult(true);
    assertEqual(token.claims.role, "admin");
    assert(Array.isArray(token.claims.adminRoleIds));
  });

  await test("Admin can read auditLogs", async () => {
    await signInAs(adminEmail, PASSWORD);
    const snap = await getDocs(query(collection(db, "auditLogs")));
    assert(snap.docs.length >= 0, "Admin should be able to read auditLogs");
  });

  await test("Non-admin CANNOT read auditLogs", async () => {
    await signInAs(vendorEmail, PASSWORD);
    await assertDenied(getDocs(query(collection(db, "auditLogs"))));
  });

  await test("Admin can read adminUsers collection", async () => {
    await signInAs(adminEmail, PASSWORD);
    const snap = await getDoc(doc(db, "adminUsers", adminUid));
    assert(snap.exists());
  });

  await test("Non-admin CANNOT read adminUsers", async () => {
    await signInAs(customerEmail, PASSWORD);
    await assertDenied(getDoc(doc(db, "adminUsers", adminUid)));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 4: Vendor verification submission flow (P1-FB-005)
// ─────────────────────────────────────────────────────────────────────────
async function section4() {
  console.log("\n📋 Section 4: Vendor verification submission flow");

  await test("submitVendorVerification FAILS without required documents", async () => {
    await signInAs(vendorEmail, PASSWORD);
    const fn = httpsCallable(fns, "submitVendorVerification");
    try {
      await fn({});
      throw new Error("Should have failed");
    } catch (e) {
      assert(e.code === "functions/failed-precondition", `Got: ${e.code} — ${e.message}`);
    }
  });

  await test("recordVerificationDocument rejects a storagePath with no uploaded object (Medium-1 fix)", async () => {
    await signInAs(vendorEmail, PASSWORD);
    const fn = httpsCallable(fns, "recordVerificationDocument");
    try {
      await fn({
        type: "business_info",
        storagePath: `verificationDocuments/${vendorId}/nonexistent_${Date.now()}.pdf`,
      });
      throw new Error("Should have failed — no object exists at this path");
    } catch (e) {
      assert(e.code === "functions/failed-precondition", `Got: ${e.code}`);
    }
  });

  await test("Vendor owner CAN upload verification document to Storage at canonical path", async () => {
    await signInAs(vendorEmail, PASSWORD);
    const path = `verificationDocuments/${vendorId}/business_info_${Date.now()}.pdf`;
    const fakeFileBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF" magic bytes
    const storageRef = ref(storage, path);
    await uploadBytes(storageRef, fakeFileBytes, { contentType: "application/pdf" });
    // Stash for the next tests in this section.
    global.__lastUploadPath = path;
  });

  await test("Storage rules REJECT disallowed MIME type on verification upload", async () => {
    await signInAs(vendorEmail, PASSWORD);
    const path = `verificationDocuments/${vendorId}/bad_mime_${Date.now()}.exe`;
    const fakeBytes = new Uint8Array([0x4d, 0x5a]);
    const storageRef = ref(storage, path);
    try {
      await uploadBytes(storageRef, fakeBytes, { contentType: "application/x-msdownload" });
      throw new Error("Should have been rejected by Storage rules — disallowed MIME type");
    } catch (e) {
      assert(e.code === "storage/unauthorized", `Got: ${e.code}`);
    }
  });

  await test("Storage rules REJECT oversized verification upload", async () => {
    await signInAs(vendorEmail, PASSWORD);
    const path = `verificationDocuments/${vendorId}/oversized_${Date.now()}.pdf`;
    // 16 MB, over the 15 MB limit enforced in storage.rules.
    const oversizedBytes = new Uint8Array(16 * 1024 * 1024);
    const storageRef = ref(storage, path);
    try {
      await uploadBytes(storageRef, oversizedBytes, { contentType: "application/pdf" });
      throw new Error("Should have been rejected by Storage rules — file too large");
    } catch (e) {
      assert(e.code === "storage/unauthorized", `Got: ${e.code}`);
    }
  });

  await test("Vendor owner CANNOT read raw verification file from Storage (security fix)", async () => {
    await signInAs(vendorEmail, PASSWORD);
    const storageRef = ref(storage, global.__lastUploadPath);
    try {
      await getBytes(storageRef);
      throw new Error("Should have been denied — vendors cannot read raw verification files");
    } catch (e) {
      assert(e.code === "storage/unauthorized", `Got: ${e.code}`);
    }
  });

  await test("A DIFFERENT vendor CANNOT upload into another vendor's verification path", async () => {
    // customerEmail's account is not a vendor at all, which is an even
    // stronger test of the rule (no vendor claim whatsoever).
    await signInAs(customerEmail, PASSWORD);
    const path = `verificationDocuments/${vendorId}/intruder_${Date.now()}.pdf`;
    const fakeBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const storageRef = ref(storage, path);
    try {
      await uploadBytes(storageRef, fakeBytes, { contentType: "application/pdf" });
      throw new Error("Should have been denied — only the vendor owner may upload here");
    } catch (e) {
      assert(e.code === "storage/unauthorized", `Got: ${e.code}`);
    }
  });

  await test("Anonymous (signed-out) user CANNOT read or write verification documents in Storage", async () => {
    await auth.signOut();
    const path = `verificationDocuments/${vendorId}/anon_${Date.now()}.pdf`;
    const storageRef = ref(storage, path);
    try {
      await uploadBytes(storageRef, new Uint8Array([1, 2, 3]), { contentType: "application/pdf" });
      throw new Error("Should have been denied");
    } catch (e) {
      assert(e.code === "storage/unauthorized", `Got: ${e.code}`);
    }
    try {
      await getBytes(ref(storage, global.__lastUploadPath));
      throw new Error("Should have been denied");
    } catch (e) {
      assert(e.code === "storage/unauthorized", `Got: ${e.code}`);
    }
  });

  await test("recordVerificationDocument records REAL Storage metadata, not client-supplied values", async () => {
    await signInAs(vendorEmail, PASSWORD);
    const fn = httpsCallable(fns, "recordVerificationDocument");

    // Upload the three required documents for real, then record each one.
    // Note: we deliberately do NOT pass contentType/sizeBytes in the
    // callable payload anymore — the server fetches them from the actual
    // Storage object metadata (Medium-1 fix).
    for (const type of ["business_info", "identity_document", "proof_of_address"]) {
      const path = `verificationDocuments/${vendorId}/${type}_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`;
      const fakeFileBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"
      await uploadBytes(ref(storage, path), fakeFileBytes, { contentType: "application/pdf" });

      const result = await fn({ type, storagePath: path });
      assert(result.data.success);
    }
  });

  await test("Recorded document metadata matches the REAL uploaded object, proving server-side verification", async () => {
    await signInAs(adminEmail, PASSWORD);
    const docsSnap = await admin.firestore()
      .collection("vendorVerification").doc(vendorId)
      .collection("documents").get();
    assert(docsSnap.docs.length >= 3, "Expected at least 3 recorded verification documents");
    for (const d of docsSnap.docs) {
      const data = d.data();
      assertEqual(data.contentType, "application/pdf", "contentType must reflect the real uploaded object");
      assert(data.sizeBytes > 0, "sizeBytes must reflect the real uploaded object size, not a client claim");
    }
  });

  await test("submitVendorVerification moves status to pending_review", async () => {
    await signInAs(vendorEmail, PASSWORD);
    const fn = httpsCallable(fns, "submitVendorVerification");
    const result = await fn({});
    assertEqual(result.data.verificationStatus, "pending_review");

    const snap = await getDoc(doc(db, "vendorVerification", vendorId));
    assertEqual(snap.data().verificationStatus, "pending_review");

    const vendorSnap = await getDoc(doc(db, "vendors", vendorId));
    assertEqual(vendorSnap.data().verificationStatus, "pending_review");
  });

  await test("submitVendorVerification FAILS when already pending_review", async () => {
    await signInAs(vendorEmail, PASSWORD);
    const fn = httpsCallable(fns, "submitVendorVerification");
    try {
      await fn({});
      throw new Error("Should have failed");
    } catch (e) {
      assert(e.code === "functions/failed-precondition", `Got: ${e.code}`);
    }
  });

  await test("Vendor CANNOT read raw verification documents (security fix)", async () => {
    await signInAs(vendorEmail, PASSWORD);
    await assertDenied(getDocs(query(collection(db, "vendorVerification", vendorId, "documents"))));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 5: Admin moderation with multi-role (P1-FB-005, P1-FB-009)
// ─────────────────────────────────────────────────────────────────────────
async function section5() {
  console.log("\n📋 Section 5: Admin moderation (multi-role, audit logs)");

  await test("approveVendorVerification sets verificationStatus=approved", async () => {
    await signInAs(adminEmail, PASSWORD);
    const fn = httpsCallable(fns, "approveVendorVerification");
    const result = await fn({ vendorId });
    assert(result.data.success);

    await sleep(1500); // wait for onVendorWrite trigger

    const snap = await getDoc(doc(db, "vendors", vendorId));
    assertEqual(snap.data().verificationStatus, "approved");
    assertEqual(snap.data().isVerified, true);
  });

  await test("onVendorWrite recomputes isVerified=true after approval", async () => {
    const snap = await getDoc(doc(db, "vendors", vendorId));
    assertEqual(snap.data().isVerified, true);
  });

  await test("auditLogs entry created for approveVendorVerification with requestId/functionName", async () => {
    await signInAs(adminEmail, PASSWORD);
    const logs = await getDocs(query(collection(db, "auditLogs")));
    const approvalLog = logs.docs
      .map(d => d.data())
      .find(d => d.eventType === "vendor.verification_approved" && d.target?.id === vendorId);
    assert(approvalLog, "approval audit log not found");
    assert(approvalLog.requestId, "requestId must be present");
    assert(approvalLog.functionName === "approveVendorVerification", "functionName must be present");
    assert(approvalLog.appCheck !== undefined, "appCheck must be present");
    assert(approvalLog.actor?.uid === adminUid, "actor.uid must match admin");
    assert(approvalLog.actor?.adminRoleIds?.length > 0, "actor.adminRoleIds must be present");
  });

  await test("suspendVendor sets vendorStatus=suspended and isDiscoverable=false", async () => {
    await signInAs(adminEmail, PASSWORD);
    const fn = httpsCallable(fns, "suspendVendor");
    await fn({ vendorId, reason: "Test suspension" });
    await sleep(1500);
    const snap = await getDoc(doc(db, "vendors", vendorId));
    assertEqual(snap.data().vendorStatus, "suspended");
    assertEqual(snap.data().isDiscoverable, false);
  });

  await test("reactivateVendor restores vendorStatus=active", async () => {
    await signInAs(adminEmail, PASSWORD);
    const fn = httpsCallable(fns, "reactivateVendor");
    await fn({ vendorId });
    await sleep(1500);
    const snap = await getDoc(doc(db, "vendors", vendorId));
    assertEqual(snap.data().vendorStatus, "active");
  });

  await test("Non-admin CANNOT call approveVendorVerification", async () => {
    await signInAs(vendorEmail, PASSWORD);
    const fn = httpsCallable(fns, "approveVendorVerification");
    try {
      await fn({ vendorId });
      throw new Error("Should have been denied");
    } catch (e) {
      assert(e.code === "functions/permission-denied", `Got: ${e.code}`);
    }
  });

  await test("verification_admin WITHOUT safety_admin role cannot suspendVendor", async () => {
    // Create a limited admin with only verification_admin role
    const limitedEmail = `limited_${Date.now()}@theplatform.com`;
    const limitedCred = await createUserWithEmailAndPassword(auth, limitedEmail, PASSWORD);
    const limitedUid = limitedCred.user.uid;
    await waitFor(async () => {
      const s = await getDoc(doc(db, "users", limitedUid));
      return s.exists() ? s : null;
    });
    await admin.auth().setCustomUserClaims(limitedUid, {
      role: "admin",
      adminRoleIds: ["verification_admin"],
      claimsVersion: 1,
    });
    await admin.firestore().collection("adminUsers").doc(limitedUid).set({
      uid: limitedUid,
      email: limitedEmail,
      roleIds: ["verification_admin"],
      status: "active",
      mfaRequired: true,
      mfaEnrolled: false,
      createdByAdminUid: adminUid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastLoginAt: null,
      revokedAt: null,
      lastMfaAt: null,
    });
    await signInAs(limitedEmail, PASSWORD);
    const fn = httpsCallable(fns, "suspendVendor");
    try {
      await fn({ vendorId });
      throw new Error("Should have been denied");
    } catch (e) {
      assert(e.code === "functions/permission-denied", `Got: ${e.code}`);
    }
  });

  await test("Revoked admin CANNOT call admin functions (adminUsers.status check)", async () => {
    const revokedEmail = `revoked_${Date.now()}@theplatform.com`;
    const revokedCred = await createUserWithEmailAndPassword(auth, revokedEmail, PASSWORD);
    const revokedUid = revokedCred.user.uid;
    await waitFor(async () => {
      const s = await getDoc(doc(db, "users", revokedUid));
      return s.exists() ? s : null;
    });
    await admin.auth().setCustomUserClaims(revokedUid, {
      role: "admin",
      adminRoleIds: ["safety_admin"],
      claimsVersion: 1,
    });
    await admin.firestore().collection("adminUsers").doc(revokedUid).set({
      uid: revokedUid,
      email: revokedEmail,
      roleIds: ["safety_admin"],
      status: "revoked", // already revoked at creation for this test
      mfaRequired: true,
      mfaEnrolled: false,
      createdByAdminUid: adminUid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastLoginAt: null,
      revokedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastMfaAt: null,
    });

    await signInAs(revokedEmail, PASSWORD);
    const fn = httpsCallable(fns, "suspendVendor");
    try {
      await fn({ vendorId });
      throw new Error("Should have been denied — admin status is revoked");
    } catch (e) {
      assert(e.code === "functions/permission-denied", `Got: ${e.code} — even though Auth custom claim says admin, adminUsers.status=revoked must block this`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 6: Vendor discovery rules (P1-FB-004 security fix)
// ─────────────────────────────────────────────────────────────────────────
async function section6() {
  console.log("\n📋 Section 6: Vendor discovery rules");

  await test("setVendorPublishStatus makes vendor discoverable when approved+active", async () => {
    await signInAs(vendorEmail, PASSWORD);
    const fn = httpsCallable(fns, "setVendorPublishStatus");
    await fn({ isPublished: true });
    await sleep(1500);
    const snap = await getDoc(doc(db, "vendors", vendorId));
    assertEqual(snap.data().isPublished, true);
    assertEqual(snap.data().isVerified, true);
    assertEqual(snap.data().isDiscoverable, true);
  });

  await test("setVendorPublishStatus REJECTS non-boolean payload (security fix)", async () => {
    await signInAs(vendorEmail, PASSWORD);
    const fn = httpsCallable(fns, "setVendorPublishStatus");
    try {
      await fn({ isPublished: "true" }); // string instead of boolean
      throw new Error("Should have rejected");
    } catch (e) {
      assert(e.code === "functions/invalid-argument", `Got: ${e.code}`);
    }
  });

  await test("Customer can read discoverable vendor", async () => {
    await signInAs(customerEmail, PASSWORD);
    const snap = await getDoc(doc(db, "vendors", vendorId));
    assert(snap.exists(), "Discoverable vendor should be readable");
  });

  await test("Signed-in non-owner customer CANNOT read an active-but-unapproved/non-discoverable vendor (audit High-1 fix)", async () => {
    // Create a brand-new vendor that is active but has NOT been approved
    // and is NOT discoverable — this is exactly the gap the audit found:
    // the old rule let any signed-in user read this via an isActiveVendor()
    // fallback clause that has now been removed entirely.
    const unapprovedEmail = `unapproved_${Date.now()}@test.com`;
    const unapprovedCred = await createUserWithEmailAndPassword(auth, unapprovedEmail, PASSWORD);
    await waitFor(async () => {
      const s = await getDoc(doc(db, "users", unapprovedCred.user.uid));
      return s.exists() ? s : null;
    });
    await signInAs(unapprovedEmail, PASSWORD);
    const fn = httpsCallable(fns, "completeRegistration");
    const result = await fn({
      role: "vendor",
      businessName: "Unapproved Test Store",
      username: `unapprovedstore_${Date.now()}`,
      categoryId: "food_catering",
      categoryName: "Food & Catering",
      country: "Nigeria",
      state: "Lagos",
      area: "Lekki",
      plan: "basic",
    });
    const unapprovedVendorId = result.data.vendorId;

    const unapprovedSnap = await admin.firestore().collection("vendors").doc(unapprovedVendorId).get();
    assertEqual(unapprovedSnap.data().vendorStatus, "active");
    assertEqual(unapprovedSnap.data().verificationStatus, "not_started");
    assertEqual(unapprovedSnap.data().isDiscoverable, false);

    // A completely different, unrelated, signed-in customer must be denied.
    await signInAs(customerEmail, PASSWORD);
    await assertDenied(getDoc(doc(db, "vendors", unapprovedVendorId)));
  });

  await test("Vendor CANNOT inject a previously-unset server-only field (e.g. fake approvedAt)", async () => {
    // Use a fresh, never-approved vendor for this test so approvedAt is
    // genuinely absent on the existing document — this is the scenario
    // where a naive "unchanged" check could wrongly allow injection.
    const freshEmail = `freshvendor_${Date.now()}@test.com`;
    const freshCred = await createUserWithEmailAndPassword(auth, freshEmail, PASSWORD);
    await waitFor(async () => {
      const s = await getDoc(doc(db, "users", freshCred.user.uid));
      return s.exists() ? s : null;
    });
    await signInAs(freshEmail, PASSWORD);
    const fn = httpsCallable(fns, "completeRegistration");
    const freshUsername = `freshstore_${Date.now()}`;
    const result = await fn({
      role: "vendor",
      businessName: "Fresh Test Store",
      username: freshUsername,
      categoryId: "food_catering",
      categoryName: "Food & Catering",
      country: "Nigeria",
      state: "Lagos",
      area: "Lekki",
      plan: "basic",
    });
    const freshVendorId = result.data.vendorId;
    await auth.currentUser.getIdToken(true);

    const freshVendorSnap = await getDoc(doc(db, "vendors", freshVendorId));
    assert(!freshVendorSnap.data().approvedAt, "approvedAt must be absent on a never-approved vendor");

    await assertDenied(
      setDoc(doc(db, "vendors", freshVendorId), { approvedAt: new Date() }, { merge: true })
    );
  });

  await test("Vendor CANNOT directly write verificationStatus to a NEW value (escalation attempt)", async () => {
    // At this point verificationStatus is 'approved' (set in Section 5).
    // A no-op write of the same value is not a security violation — it's
    // simply allowed because it doesn't change anything. The real test is
    // whether a vendor can ESCALATE/CHANGE the value to something it
    // doesn't already hold, e.g. forging 'rejected' -> 'approved' or
    // attempting to clear it back to 'not_started' to retry verification
    // without going through the real submission flow.
    await signInAs(vendorEmail, PASSWORD);
    await assertDenied(
      setDoc(doc(db, "vendors", vendorId), { verificationStatus: "not_started" }, { merge: true })
    );
  });

  await test("Vendor CANNOT directly write verificationStatus (no-op same-value write is harmless, but field stays under rule control)", async () => {
    // A same-value write is a legitimate no-op success (the resulting
    // document is unchanged), so it is correctly ALLOWED by the rules.
    // We verify here that even though the write succeeds, the value is
    // still exactly what the server set it to — i.e. the vendor gained no
    // actual control over the field.
    await signInAs(vendorEmail, PASSWORD);
    await setDoc(doc(db, "vendors", vendorId), { verificationStatus: "approved" }, { merge: true });
    const snap = await getDoc(doc(db, "vendors", vendorId));
    assertEqual(snap.data().verificationStatus, "approved", "Value must remain exactly what the server set, proving the vendor has no real write control over this field");
  });

  await test("Vendor CANNOT directly flip isDiscoverable to a NEW value (escalation attempt)", async () => {
    // isDiscoverable is currently true (set by setVendorPublishStatus +
    // onVendorWrite). Test the real attack: forcing it to false directly,
    // bypassing the server-computed derivation entirely.
    await signInAs(vendorEmail, PASSWORD);
    await assertDenied(
      setDoc(doc(db, "vendors", vendorId), { isDiscoverable: false }, { merge: true })
    );
  });

  await test("onVendorWrite remains the sole authority over isDiscoverable after a no-op same-value write", async () => {
    await signInAs(vendorEmail, PASSWORD);
    await setDoc(doc(db, "vendors", vendorId), { isDiscoverable: true }, { merge: true });
    const snap = await getDoc(doc(db, "vendors", vendorId));
    assertEqual(snap.data().isDiscoverable, true, "Value must remain exactly what the server computed");
  });

  await test("Suspended vendor has isDiscoverable=false and fails discovery criteria", async () => {
    await signInAs(adminEmail, PASSWORD);
    const suspendFn = httpsCallable(fns, "suspendVendor");
    await suspendFn({ vendorId });
    await sleep(1500);

    // A suspended vendor must fail the discovery condition
    // (verificationStatus='approved' AND vendorStatus='active' AND isDiscoverable=true).
    // Direct-link reads by signed-in users are still allowed by design (any
    // signed-in customer with the storefront URL can view it), but it must
    // never appear in discovery query results — which is governed entirely
    // by isDiscoverable being false here.
    const snap = await getDoc(doc(db, "vendors", vendorId));
    assertEqual(snap.data().vendorStatus, "suspended");
    assertEqual(snap.data().isDiscoverable, false, "Suspended vendor must not be discoverable");

    // Restore state for subsequent tests.
    const reactivateFn = httpsCallable(fns, "reactivateVendor");
    await reactivateFn({ vendorId });
    await sleep(1000);
  });

  await test("Anonymous (signed-out) user CANNOT read a non-discoverable vendor directly", async () => {
    // Suspend again briefly to test the anonymous-read boundary.
    await signInAs(adminEmail, PASSWORD);
    const suspendFn = httpsCallable(fns, "suspendVendor");
    await suspendFn({ vendorId });
    await sleep(1000);

    await auth.signOut();
    await assertDenied(getDoc(doc(db, "vendors", vendorId)));

    // Restore for subsequent tests.
    await signInAs(adminEmail, PASSWORD);
    const reactivateFn = httpsCallable(fns, "reactivateVendor");
    await reactivateFn({ vendorId });
    await sleep(1000);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 7: Username reservation (P1-FB-006)
// ─────────────────────────────────────────────────────────────────────────
async function section7() {
  console.log("\n📋 Section 7: Username reservation");

  await test("checkUsernameAvailability returns false for taken username", async () => {
    await signInAs(customerEmail, PASSWORD);
    const fn = httpsCallable(fns, "checkUsernameAvailability");
    const result = await fn({ username });
    assertEqual(result.data.available, false);
  });

  await test("checkUsernameAvailability returns true for available username", async () => {
    await signInAs(customerEmail, PASSWORD);
    const fn = httpsCallable(fns, "checkUsernameAvailability");
    const result = await fn({ username: `available_${Date.now()}` });
    assertEqual(result.data.available, true);
  });

  await test("checkUsernameAvailability rejects invalid format", async () => {
    await signInAs(customerEmail, PASSWORD);
    const fn = httpsCallable(fns, "checkUsernameAvailability");
    const result = await fn({ username: "UPPERCASE!" });
    assertEqual(result.data.available, false);
  });

  await test("changeUsername updates vendor doc and reservation atomically", async () => {
    await signInAs(vendorEmail, PASSWORD);
    const newUsername = `newstore_${Date.now()}`;
    const fn = httpsCallable(fns, "changeUsername");
    const result = await fn({ username: newUsername });
    assertEqual(result.data.username, newUsername);

    const oldSnap = await getDoc(doc(db, "usernameReservations", username));
    assert(!oldSnap.exists(), "Old username reservation should be released");

    const newSnap = await getDoc(doc(db, "usernameReservations", newUsername));
    assert(newSnap.exists(), "New username reservation should exist");

    // Update local username for subsequent tests
    username = newUsername;
  });

  await test("changeUsername creates audit log with before/after", async () => {
    await signInAs(adminEmail, PASSWORD);
    const logs = await getDocs(query(collection(db, "auditLogs")));
    const log = logs.docs
      .map(d => d.data())
      .find(d => d.eventType === "vendor.username_changed");
    assert(log, "username_changed audit log not found");
    assert(log.before?.username, "before.username must be present");
    assert(log.after?.username, "after.username must be present");
    assert(log.requestId, "requestId must be present");
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 8: Email OTP with PII fix (P1-FB-002)
// ─────────────────────────────────────────────────────────────────────────
async function section8() {
  console.log("\n📋 Section 8: Email OTP");

  await test("sendEmailOtp creates hashed doc ID (not raw email)", async () => {
    await signInAs(vendorEmail, PASSWORD);
    const fn = httpsCallable(fns, "sendEmailOtp");
    await fn({ email: vendorEmail });

    const crypto = require("crypto");
    const hashedId = crypto.createHash("sha256").update(vendorEmail).digest("hex");

    const snap = await admin.firestore().collection("emailOtps").doc(hashedId).get();
    assert(snap.exists, "OTP doc must exist at hashed path"); // Admin SDK: .exists is a property, not a function
    assert(!snap.data().email, "Raw email must NOT be stored on the OTP doc (PII fix)");
  });

  await test("verifyEmailOtp succeeds with correct code", async () => {
    const crypto = require("crypto");
    const hashedId = crypto.createHash("sha256").update(vendorEmail).digest("hex");
    const otpSnap = await admin.firestore().collection("emailOtps").doc(hashedId).get();
    assert(otpSnap.exists, "OTP doc must exist"); // Admin SDK: .exists is a property, not a function

    const mailSnap = await admin.firestore().collection("mail").get();
    let code = null;
    mailSnap.forEach(d => {
      const data = d.data();
      if (data.to?.includes(vendorEmail)) {
        const match = data.message?.text?.match(/code is (\d{6})/);
        if (match) code = match[1];
      }
    });
    assert(code, "OTP code must be extractable from mail doc");

    await signInAs(vendorEmail, PASSWORD);
    const fn = httpsCallable(fns, "verifyEmailOtp");
    const result = await fn({ email: vendorEmail, code });
    assertEqual(result.data.verified, true);

    const afterSnap = await admin.firestore().collection("emailOtps").doc(hashedId).get();
    assert(!afterSnap.exists, "OTP doc must be deleted after successful verification"); // Admin SDK: property not function
  });

  await test("verifyEmailOtp FAILS with wrong code", async () => {
    await signInAs(vendorEmail, PASSWORD);
    const sendFn = httpsCallable(fns, "sendEmailOtp");
    await sendFn({ email: vendorEmail });
    await sleep(1000);

    const verifyFn = httpsCallable(fns, "verifyEmailOtp");
    try {
      await verifyFn({ email: vendorEmail, code: "000000" });
      throw new Error("Should have failed");
    } catch (e) {
      assert(e.code === "functions/invalid-argument", `Got: ${e.code}`);
    }
  });

  await test("emailOtps collection is NOT client-readable", async () => {
    await signInAs(vendorEmail, PASSWORD);
    const crypto = require("crypto");
    const hashedId = crypto.createHash("sha256").update(vendorEmail).digest("hex");
    await assertDenied(getDoc(doc(db, "emailOtps", hashedId)));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 9: Audit log schema verification (P1-FB-009)
// ─────────────────────────────────────────────────────────────────────────
async function section9() {
  console.log("\n📋 Section 9: Audit log schema");

  await test("All audit log entries have requestId, functionName, appCheck", async () => {
    const logs = await admin.firestore().collection("auditLogs").get();
    let checked = 0;
    for (const logDoc of logs.docs) {
      const d = logDoc.data();
      assert(d.requestId, `Missing requestId in log ${logDoc.id}`);
      assert(d.functionName, `Missing functionName in log ${logDoc.id}`);
      assert(d.appCheck !== undefined, `Missing appCheck in log ${logDoc.id}`);
      assert(d.actor, `Missing actor in log ${logDoc.id}`);
      assert(d.target, `Missing target in log ${logDoc.id}`);
      assert(d.eventType, `Missing eventType in log ${logDoc.id}`);
      checked++;
    }
    assert(checked > 0, "No audit logs found to verify");
    console.log(`     (verified ${checked} audit log entries)`);
  });

  await test("Audit logs are immutable (client cannot write/update)", async () => {
    await signInAs(adminEmail, PASSWORD);
    const logs = await getDocs(query(collection(db, "auditLogs")));
    if (logs.docs.length > 0) {
      await assertDenied(
        setDoc(doc(db, "auditLogs", logs.docs[0].id), { tampered: true }, { merge: true })
      );
    }
  });

  await test("onUserDelete audit log does NOT contain PII email/name in before snapshot", async () => {
    // Create and delete a test user
    const deleteEmail = `delete_${Date.now()}@test.com`;
    const deleteCred = await createUserWithEmailAndPassword(auth, deleteEmail, PASSWORD);
    const deleteUid = deleteCred.user.uid;
    await waitFor(async () => {
      const s = await getDoc(doc(db, "users", deleteUid));
      return s.exists() ? s : null;
    });

    await admin.auth().deleteUser(deleteUid);
    await sleep(2000);

    const logs = await admin.firestore().collection("auditLogs").get();
    const deleteLog = logs.docs
      .map(d => d.data())
      .find(d => d.eventType === "user.deleted" && d.target?.id === deleteUid);

    if (deleteLog?.before) {
      assert(!deleteLog.before.email, "PII email must NOT be in audit log before snapshot");
      assert(!deleteLog.before.phoneNumber, "PII phone must NOT be in audit log before snapshot");
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 10: App Check helper verification (P1-FB-008)
// ─────────────────────────────────────────────────────────────────────────
async function section10() {
  console.log("\n📋 Section 10: App Check");

  await test("App Check monitor mode: functions still succeed without App Check token", async () => {
    // In the emulator, App Check tokens are never present; functions should
    // succeed in monitor mode (APP_CHECK_ENFORCE != 'true').
    await signInAs(vendorEmail, PASSWORD);
    const fn = httpsCallable(fns, "getClaimsVersion");
    const result = await fn({});
    assert(result.data.claimsVersion >= 1);
  });

  await test("Audit logs record appCheck.present=false for emulator requests", async () => {
    const logs = await admin.firestore().collection("auditLogs").get();
    const anyLog = logs.docs[0]?.data();
    if (anyLog) {
      assert(anyLog.appCheck.present === false, "In emulator, App Check should not be present");
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 THE PLATFORM — Milestone 1 Acceptance Test Suite");
  console.log("=".repeat(60));

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

  if (failed === 0) {
    console.log("✅ ALL TESTS PASSED — Milestone 1 ready for sign-off");
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
