/**
 * Phase 4 acceptance: storefront sharing.
 *
 * Three things the client asked for, each a real check rather than a UI
 * observation: publishing is gated on the server (not just on the button
 * being shown), publishing/unpublishing actually flips what an unauthenticated
 * caller can read, and the share link resolves to the correct real vendor —
 * never another one, never a non-discoverable one — with no account signed in.
 *
 * There is no dedicated "storefront share" callable. setVendorPublishStatus
 * toggles vendors/{vendorId}.isPublished; a Firestore trigger
 * (onVendorWrite) recomputes isDiscoverable from isPublished + verification +
 * vendorStatus + country availability; and the public read path is the
 * Firestore security rule itself (isDiscoverableVendor), the same rule
 * vendor-discovery-tests.js already exercises for browsing. The share link
 * the app builds (lib/storefront/shareStorefront.ts) is just that lookup by
 * username, so this tests the lookup directly against a client that never
 * signs in — the same shape a customer opening a shared link with no account
 * would make.
 *
 * Two vendors are registered fresh rather than reusing the seeded demo
 * vendor: the demo vendor (seed-demo-vendor.js) is verified but has no
 * catalog item, so it cannot actually be published under the real
 * publish-gate rule (business name + category + one approved item) — a
 * seed-script gap, not something to route around here. Vendor A is taken
 * all the way to eligible, published and (via a direct fixture write of
 * verificationStatus, since exercising the Storage-backed document-upload
 * flow is Phase 1's job, not this one's) verified. Vendor B stays
 * intentionally incomplete throughout, as the negative control.
 *
 * Run:  node phase4-storefront-tests.js   (with the emulator running; does
 *       not depend on seed-demo-vendor.js having been run first)
 */
process.env.GCLOUD_PROJECT = "demo-platform";
process.env.GOOGLE_CLOUD_PROJECT = "demo-platform";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const admin = require("firebase-admin");
const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, connectAuthEmulator } = require("firebase/auth");
const { getFunctions, httpsCallable, connectFunctionsEmulator } = require("firebase/functions");
const { getFirestore, connectFirestoreEmulator, collection, query, where, getDocs, doc, getDoc } = require("firebase/firestore");

if (!admin.apps.length) admin.initializeApp({ projectId: "demo-platform" });
const fdb = admin.firestore();

// One authenticated app, signed into in turn as each party (vendor A,
// vendor B, the admin, a plain customer) — same pattern phase2 uses.
const app = initializeApp({ apiKey: "demo", projectId: "demo-platform" }, `p4-${Date.now()}`);
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app);
connectFunctionsEmulator(fns, "127.0.0.1", 5001);

// A second app that never signs in. This is the "customer with no account"
// making the exact read a shared storefront link resolves through.
const publicApp = initializeApp({ apiKey: "demo", projectId: "demo-platform" }, `p4-public-${Date.now()}`);
const publicDb = getFirestore(publicApp);
connectFirestoreEmulator(publicDb, "127.0.0.1", 8080);

let pass = 0, fail = 0;
const check = (n, label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${n}. ${label}`); }
  else { fail++; console.log(`FAIL  ${n}. ${label}${detail !== undefined ? `  (${detail})` : ""}`); }
};

/**
 * The no-account lookup a shared link resolves through: find a vendor by
 * username with nobody signed in.
 *
 * Verified against a live emulator (see phase4 investigation notes in the
 * handover doc) that Firestore's list-query rule check is NOT evaluated
 * against the matched document's real field values the way a single-document
 * get() is — it is validated against the query's own filters. A plain
 * `where("username","==",x)` is rejected outright with permission-denied
 * REGARDLESS of whether the vendor is actually discoverable, because the
 * query gives the rules engine nothing to check isDiscoverableVendor()
 * against. Restating the rule's own three conditions as explicit filters
 * (exactly what vendor-discovery-tests.js already does for browsing) is what
 * makes the query provably safe and lets it return real results. This is the
 * one Firestore-sanctioned shape of this lookup; anything else denies
 * unconditionally, which is why "denied" and "resolved empty" are both
 * treated below as "this vendor is not reachable this way."
 */
async function publicLookupByUsername(username) {
  try {
    const snap = await getDocs(query(
      collection(publicDb, "vendors"),
      where("verificationStatus", "==", "approved"),
      where("vendorStatus", "==", "active"),
      where("isDiscoverable", "==", true),
      where("username", "==", username),
    ));
    return { resolved: !snap.empty, docs: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
  } catch (e) {
    return { resolved: false, denied: true, error: e.code };
  }
}
async function publicGetById(vendorId) {
  try {
    const snap = await getDoc(doc(publicDb, "vendors", vendorId));
    return { resolved: snap.exists() };
  } catch (e) {
    return { resolved: false, denied: true, error: e.code };
  }
}

async function registerVendor(label) {
  const email = `phase4.${label}.${Date.now()}@platform.test`;
  const cred = await createUserWithEmailAndPassword(auth, email, "DemoPass123!");
  for (let i = 0; i < 30; i++) {
    if ((await fdb.collection("users").doc(cred.user.uid).get()).exists) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const reg = await httpsCallable(fns, "completeRegistration")({
    role: "vendor", firstName: label, lastName: "Vendor",
    phoneNumber: `+234${Math.floor(1e9 + Math.random() * 8e9)}`, country: "Nigeria",
  });
  await auth.currentUser.getIdToken(true);
  const vendorId = reg.data.vendorId;
  const username = (await fdb.collection("vendors").doc(vendorId).get()).data().username;
  return { email, vendorId, username };
}

async function main() {
  const setPublish = httpsCallable(fns, "setVendorPublishStatus");

  // ── Setup: vendor A (will become eligible, published, verified) ──────────
  const vendorA = await registerVendor("a");

  // ── 1. Publishing is gated on the server, not on the client trusting the
  //      button was only shown when allowed ─────────────────────────────────
  let blocked = null;
  try { await setPublish({ isPublished: true }); } catch (e) { blocked = e; }
  check(1, "An incomplete vendor cannot publish, even calling the backend directly",
    blocked !== null && blocked.code?.includes("failed-precondition"),
    blocked?.message ?? "the call was allowed");

  // ── 2. No partial write happened on the rejected attempt ──────────────────
  const vendorAAfterReject = (await fdb.collection("vendors").doc(vendorA.vendorId).get()).data();
  check(2, "The rejected publish attempt left isPublished unchanged",
    vendorAAfterReject.isPublished === false, vendorAAfterReject.isPublished);

  // Complete the real requirements: business name, category, one approved item.
  await fdb.collection("vendors").doc(vendorA.vendorId).update({
    businessName: "Phase4 Test Kitchen", name: "Phase4 Test Kitchen",
    categoryId: "food_drinks", categoryName: "Food & Drinks",
  });
  const cat = await httpsCallable(fns, "createCatalogCategory")({ name: `P4 Category ${Date.now()}`, order: 0 });
  const item = await httpsCallable(fns, "createCatalogItem")({
    name: "Test Item", basePrice: 1000, categoryId: cat.data.categoryId, isAvailable: true, isHidden: false,
  });
  await signInWithEmailAndPassword(auth, "demo.admin@example.com", "DemoPass123!").catch(() => null);
  // If the shared demo admin doesn't exist in this emulator session yet
  // (seed-demo-vendor.js not run), create a throwaway one with the same access.
  if (!auth.currentUser) {
    const adminCred = await createUserWithEmailAndPassword(auth, `phase4.admin.${Date.now()}@platform.test`, "DemoPass123!");
    await admin.auth().setCustomUserClaims(adminCred.user.uid, { role: "admin", adminRoleIds: ["super_admin"], claimsVersion: 1 });
    await fdb.collection("adminUsers").doc(adminCred.user.uid).set({
      uid: adminCred.user.uid, email: adminCred.user.email, roleIds: ["super_admin"], status: "active",
      mfaRequired: false, mfaEnrolled: false, createdByAdminUid: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastLoginAt: null, revokedAt: null, lastMfaAt: null,
    });
    await adminCred.user.getIdToken(true);
  } else {
    await auth.currentUser.getIdToken(true);
  }
  await httpsCallable(fns, "approveCatalogItem")({ vendorId: vendorA.vendorId, itemId: item.data.itemId });
  await signInWithEmailAndPassword(auth, vendorA.email, "DemoPass123!");

  // ── 3. Now eligible, publishing succeeds ───────────────────────────────────
  const publishRes = await setPublish({ isPublished: true });
  const vendorAPublished = (await fdb.collection("vendors").doc(vendorA.vendorId).get()).data();
  check(3, "Once eligible, the same backend call publishes the storefront",
    publishRes.data.isPublished === true && vendorAPublished.isPublished === true,
    vendorAPublished.isPublished);

  // ── 4. Published but unverified is not the same as discoverable ───────────
  check(4, "A published-but-unverified vendor is still not discoverable",
    vendorAPublished.isDiscoverable === false, vendorAPublished.isDiscoverable);

  // ── 5. So the share link does not resolve for it yet ───────────────────────
  const lookupA1 = await publicLookupByUsername(vendorA.username);
  check(5, "An unauthenticated lookup by username does not resolve an unverified vendor",
    lookupA1.resolved === false, JSON.stringify(lookupA1));

  // Verification itself is Phase 1's flow (Storage uploads + admin review);
  // here it is only a fixture to reach "published AND verified" so the
  // publish/discoverability mechanic under test can actually be exercised.
  await fdb.collection("vendors").doc(vendorA.vendorId).update({
    verificationStatus: "approved", approvedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await new Promise((r) => setTimeout(r, 1000)); // let onVendorWrite recompute isVerified/isDiscoverable

  // ── 6. Verified + published + active + open country = discoverable ───────
  const vendorAVerified = (await fdb.collection("vendors").doc(vendorA.vendorId).get()).data();
  check(6, "Once verified, the published vendor becomes discoverable (onVendorWrite recompute)",
    vendorAVerified.isVerified === true && vendorAVerified.isDiscoverable === true,
    { isVerified: vendorAVerified.isVerified, isDiscoverable: vendorAVerified.isDiscoverable });

  // ── 7. The share link now resolves to THIS vendor's real record ───────────
  const lookupA2 = await publicLookupByUsername(vendorA.username);
  check(7, "With no account signed in, the share link resolves to the correct real vendor",
    lookupA2.resolved && lookupA2.docs.length === 1 &&
    lookupA2.docs[0].id === vendorA.vendorId &&
    lookupA2.docs[0].businessName === "Phase4 Test Kitchen",
    JSON.stringify(lookupA2.docs?.[0] ?? lookupA2));

  // ── 8. Unpublishing actually revokes public readability ───────────────────
  await setPublish({ isPublished: false });
  await new Promise((r) => setTimeout(r, 1000)); // let onVendorWrite recompute isDiscoverable
  const vendorAUnpublished = (await fdb.collection("vendors").doc(vendorA.vendorId).get()).data();
  check(8, "Unpublishing flips isPublished (and, via onVendorWrite, isDiscoverable) to false",
    vendorAUnpublished.isPublished === false && vendorAUnpublished.isDiscoverable === false,
    { isPublished: vendorAUnpublished.isPublished, isDiscoverable: vendorAUnpublished.isDiscoverable });

  const lookupA3 = await publicLookupByUsername(vendorA.username);
  check(9, "After unpublishing, the same no-account lookup no longer resolves the vendor",
    lookupA3.resolved === false, JSON.stringify(lookupA3));

  const directGet = await publicGetById(vendorA.vendorId);
  check(10, "A direct unauthenticated read by vendorId is refused too, not only the username lookup",
    directGet.resolved === false, JSON.stringify(directGet));

  // ── 9. Re-publishing restores visibility, still resolving correctly ───────
  await setPublish({ isPublished: true });
  await new Promise((r) => setTimeout(r, 1000)); // let onVendorWrite recompute isDiscoverable
  const lookupA4 = await publicLookupByUsername(vendorA.username);
  check(11, "Re-publishing restores the no-account lookup, still resolving to the correct vendor",
    lookupA4.resolved && lookupA4.docs[0]?.id === vendorA.vendorId,
    JSON.stringify(lookupA4.docs?.[0] ?? lookupA4));

  // ── 10. Cross-vendor isolation: vendor B is deliberately never published ──
  const vendorB = await registerVendor("b");
  const lookupB = await publicLookupByUsername(vendorB.username);
  check(12, "A separate, never-published vendor's link stays unresolvable while vendor A's works",
    lookupB.resolved === false, JSON.stringify(lookupB));

  // ── 11. The publish toggle is role-checked, not just UI-gated ─────────────
  const customerEmail = `phase4.customer.${Date.now()}@platform.test`;
  await createUserWithEmailAndPassword(auth, customerEmail, "DemoPass123!");
  await new Promise((r) => setTimeout(r, 1500));
  await httpsCallable(fns, "completeRegistration")({
    role: "customer", firstName: "P4", lastName: "Customer",
    phoneNumber: "+2348077776666", country: "Nigeria",
  });
  await auth.currentUser.getIdToken(true);
  let customerBlocked = null;
  try { await setPublish({ isPublished: true }); } catch (e) { customerBlocked = e; }
  check(13, "A signed-in customer (non-vendor) cannot call setVendorPublishStatus at all",
    customerBlocked !== null && customerBlocked.code?.includes("permission-denied"),
    customerBlocked?.message ?? "the call was allowed");

  console.log(`\n${fail === 0 ? "ALL PHASE 4 STOREFRONT TESTS PASSED" : `${fail} FAILURE(S)`}  (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
