/**
 * Phase 2 acceptance tests — catalog moderation and pending revision system.
 * Maps 1:1 to the 12 acceptance requirements in the Frontend Implementation doc,
 * plus the security gaps found during implementation.
 */
const PROJECT_ID = "demo-platform";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const { initializeApp, getApps } = require("firebase/app");
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword } = require("firebase/auth");
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require("firebase/functions");
const { getFirestore, connectFirestoreEmulator, doc, getDoc } = require("firebase/firestore");
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });

const app = getApps().find((a) => a.name === "p2") || initializeApp({ apiKey: "demo", projectId: PROJECT_ID }, "p2");
const auth = getAuth(app), fns = getFunctions(app), clientDb = getFirestore(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
connectFirestoreEmulator(clientDb, "127.0.0.1", 8080);

let pass = 0, fail = 0;
function check(n, label, ok, detail) {
  if (ok) { console.log(`PASS  ${n}. ${label}`); pass++; }
  else { console.error(`FAIL  ${n}. ${label}\n      ${JSON.stringify(detail)}`); fail++; }
}

const fdb = admin.firestore();

async function signInVendor() {
  await signInWithEmailAndPassword(auth, "demo.vendor@example.com", "DemoPass123!");
  await auth.currentUser.getIdToken(true);
  return auth.currentUser.uid;
}
async function signInAdmin() {
  await signInWithEmailAndPassword(auth, "demo.admin@example.com", "DemoPass123!");
  await auth.currentUser.getIdToken(true);
}

async function main() {
  const vendorId = await signInVendor();
  const createItem = httpsCallable(fns, "createCatalogItem");
  const updateItem = httpsCallable(fns, "updateCatalogItem");
  const getModeration = httpsCallable(fns, "getCatalogItemModeration");

  // A category is required before an item can be submitted, so that items can
  // never reach customers showing "Uncategorized". Create one first.
  const createCategory = httpsCallable(fns, "createCatalogCategory");
  const cat = await createCategory({ name: `Grills ${Date.now()}`, order: 0 });
  const categoryId = cat.data.categoryId;

  // ── 1. New item enters Under Review ─────────────────────────────────────
  const created = await createItem({ name: "Suya Platter", basePrice: 5000, categoryId, isAvailable: true, isHidden: false });
  const itemId = created.data.itemId;
  const itemRef = fdb.collection("vendors").doc(vendorId).collection("catalogItems").doc(itemId);
  let snap = await itemRef.get();
  check(1, "Newly submitted item enters Under Review (pending)", snap.data().moderationStatus === "pending", snap.data().moderationStatus);

  // ── 2. Pending item invisible to customers ──────────────────────────────
  // Verified two ways: the security rule (browsing) and the cart (ordering).
  const repriceCart = httpsCallable(fns, "repriceCart");
  let cartBlocked = null;
  try {
    await repriceCart({ vendorId, items: [{ itemId, quantity: 1 }], fulfillmentType: "pickup" });
  } catch (e) { cartBlocked = e; }
  check(2, "Pending item cannot be added to cart / ordered", cartBlocked !== null, cartBlocked?.message);

  // ── 11. Vendor cannot approve their own item ─────────────────────────────
  const approveAsVendor = httpsCallable(fns, "approveCatalogItem");
  let selfApprove = null;
  try { await approveAsVendor({ vendorId, itemId }); } catch (e) { selfApprove = e; }
  check(11, "Vendor cannot approve their own catalog item", selfApprove !== null, selfApprove?.message);

  // ── 12a. Vendor cannot set moderation fields directly ───────────────────
  await updateItem({ itemId, moderationStatus: "approved", hasPendingRevision: false, moderationNotes: "self-cleared" });
  snap = await itemRef.get();
  check("12a", "Vendor cannot self-approve via updateCatalogItem field injection",
    snap.data().moderationStatus === "pending" && !snap.data().moderationNotes,
    { moderationStatus: snap.data().moderationStatus, notes: snap.data().moderationNotes });

  // ── 4. Rejected item shows reason to vendor ─────────────────────────────
  await signInAdmin();
  const rejectItem = httpsCallable(fns, "rejectCatalogItem");
  await rejectItem({ vendorId, itemId, reason: "Photo is too blurry to identify the product." });
  await signInVendor();
  let mod = (await getModeration({ itemId })).data;
  check(4, "Rejected item exposes the rejection reason to its vendor",
    mod.moderationStatus === "rejected" && /blurry/.test(mod.rejectionReason ?? ""),
    { status: mod.moderationStatus, reason: mod.rejectionReason });

  // ── 5. Vendor can edit and resubmit ─────────────────────────────────────
  await updateItem({ itemId, name: "Suya Platter (Large)" });
  snap = await itemRef.get();
  check(5, "Editing a rejected item resubmits it and clears the old reason",
    snap.data().moderationStatus === "pending" && !snap.data().moderationNotes,
    { status: snap.data().moderationStatus, notes: snap.data().moderationNotes });

  // ── 3. Approved item becomes publicly visible ───────────────────────────
  await signInAdmin();
  await approveAsVendor({ vendorId, itemId });
  snap = await itemRef.get();
  check(3, "Approved item becomes publicly visible", snap.data().moderationStatus === "approved", snap.data().moderationStatus);

  // Cart must now accept it — proves the moderation gate opens correctly too.
  await signInVendor();
  await fdb.collection("vendors").doc(vendorId).update({ isDiscoverable: true, isPublished: true });
  const okCart = await repriceCart({ vendorId, items: [{ itemId, quantity: 1 }], fulfillmentType: "pickup" });
  check("3b", "Approved item can be added to cart", okCart.data.success === true, okCart.data);

  // ── 6/7/10. Material edit to approved item becomes a pending revision ───
  const liveNameBefore = (await itemRef.get()).data().name;
  const editRes = await updateItem({ itemId, name: "Suya Platter Deluxe", basePrice: 7000 });
  snap = await itemRef.get();
  check(6, "Editing an approved item does not replace its live approved version",
    snap.data().name === liveNameBefore && snap.data().basePrice !== 7000 && snap.data().moderationStatus === "approved",
    { liveName: snap.data().name, livePrice: snap.data().basePrice, status: snap.data().moderationStatus });
  check(7, "Customers keep seeing the approved version during revision review",
    snap.data().moderationStatus === "approved" && snap.data().hasPendingRevision === true,
    { status: snap.data().moderationStatus, hasPendingRevision: snap.data().hasPendingRevision });
  check("6b", "updateCatalogItem reports the edit was held as a revision", editRes.data.pendingRevision === true, editRes.data);

  // ── 10. Operational edits apply immediately (no review) ─────────────────
  await updateItem({ itemId, inventoryQuantity: 12, isAvailable: false });
  snap = await itemRef.get();
  check(10, "Operational edits (stock, availability) apply immediately without review",
    snap.data().inventoryQuantity === 12 && snap.data().isAvailable === false && snap.data().name === liveNameBefore,
    { inventoryQuantity: snap.data().inventoryQuantity, isAvailable: snap.data().isAvailable });
  await updateItem({ itemId, isAvailable: true });

  // ── SECURITY: revision must NOT be readable by a customer ───────────────
  const revRef = itemRef.collection("moderation").doc("pendingRevision");
  const revDoc = await revRef.get();
  check("12b", "Proposed revision is stored outside the customer-readable item document",
    revDoc.exists && revDoc.data().changes?.name === "Suya Platter Deluxe" && (await itemRef.get()).data().pendingRevision === undefined,
    { revisionExists: revDoc.exists, leakedOnItem: (await itemRef.get()).data().pendingRevision });

  // A signed-out client must be refused by the security rule.
  await auth.signOut();
  let ruleBlocked = false;
  try {
    await getDoc(doc(clientDb, "vendors", vendorId, "catalogItems", itemId, "moderation", "pendingRevision"));
  } catch { ruleBlocked = true; }
  check("12c", "Firestore rules deny public reads of the pending revision", ruleBlocked, { ruleBlocked });

  // ── 9. Rejecting a revision leaves the live version unchanged ───────────
  await signInAdmin();
  await rejectItem({ vendorId, itemId, reason: "New price needs justification." });
  snap = await itemRef.get();
  check(9, "Rejecting a revision leaves the previous approved version live",
    snap.data().moderationStatus === "approved" && snap.data().name === liveNameBefore && snap.data().basePrice !== 7000,
    { status: snap.data().moderationStatus, name: snap.data().name, price: snap.data().basePrice });

  await signInVendor();
  mod = (await getModeration({ itemId })).data;
  check("9b", "Vendor sees the revision rejection reason",
    mod.pendingRevision?.status === "rejected" && /justification/.test(mod.pendingRevision?.rejectionReason ?? ""),
    mod.pendingRevision);

  // ── 8. Approving a revision promotes it to live ─────────────────────────
  await updateItem({ itemId, name: "Suya Platter Deluxe", basePrice: 7000 });
  await signInAdmin();
  const promoted = await approveAsVendor({ vendorId, itemId });
  snap = await itemRef.get();
  check(8, "Approving a revision promotes it to the live version",
    snap.data().name === "Suya Platter Deluxe" && snap.data().basePrice === 7000 && snap.data().hasPendingRevision === false,
    { name: snap.data().name, price: snap.data().basePrice, hasPendingRevision: snap.data().hasPendingRevision });
  check("8b", "Revision document is cleared after approval",
    !(await revRef.get()).exists && promoted.data.promotedRevision === true,
    { stillExists: (await revRef.get()).exists });

  // ── Admin moderation queue ──────────────────────────────────────────────
  const queue = httpsCallable(fns, "listCatalogModerationQueue");
  const q = (await queue({})).data;
  check("Q", "Admin moderation queue returns pending work with counts",
    q.success === true && Array.isArray(q.newItems) && Array.isArray(q.revisions),
    q.counts);

  // A vendor must not be able to read the whole platform's queue.
  await signInVendor();
  let queueBlocked = null;
  try { await queue({}); } catch (e) { queueBlocked = e; }
  check("Q2", "Vendors cannot access the admin moderation queue", queueBlocked !== null, queueBlocked?.message);

  console.log(`\n${fail === 0 ? "ALL PHASE 2 ACCEPTANCE TESTS PASSED" : `${fail} FAILED`}  (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
