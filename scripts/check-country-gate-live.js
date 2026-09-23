/**
 * One-shot check: is the deployed repriceCart actually blocking real orders
 * right now because countryAvailability is empty on platform-dev? Creates a
 * throwaway real vendor + customer, gives the vendor one catalog item, and
 * calls the real repriceCart callable to see the real, live error.
 */
const admin = require("firebase-admin");
const { initializeApp } = require("firebase/app");
const { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword } = require("firebase/auth");
const { getFunctions, httpsCallable } = require("firebase/functions");

if (!admin.apps.length) admin.initializeApp({ projectId: "platform-dev" });
const fdb = admin.firestore();

const client = initializeApp({
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "platform-dev.firebaseapp.com",
  projectId: "platform-dev",
}, `cga-${Date.now()}`);
const auth = getAuth(client);
const fns = getFunctions(client);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PASSWORD = "CheckGate123!";

async function main() {
  const vendorEmail = `cga_vendor_${Date.now()}@platform-check.com`;
  const vc = await createUserWithEmailAndPassword(auth, vendorEmail, PASSWORD);
  const vendorUid = vc.user.uid;

  const vendorId = fdb.collection("vendors").doc().id;
  await fdb.collection("vendors").doc(vendorId).set({
    vendorId, ownerUid: vendorUid, businessName: "CGA Check Vendor",
    countryCode: "NG", country: "Nigeria",
    isPublished: true, isDiscoverable: true, isVerified: true,
    verificationStatus: "approved", vendorStatus: "active",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await fdb.collection("users").doc(vendorUid).set({
    uid: vendorUid, email: vendorEmail, role: "vendor", vendorId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  await admin.auth().setCustomUserClaims(vendorUid, { role: "vendor", vendorId, claimsVersion: 1 });

  const itemRef = fdb.collection("vendors").doc(vendorId).collection("catalogItems").doc();
  await itemRef.set({
    itemId: itemRef.id, vendorId, name: "Check Item", basePrice: 1000, currency: "NGN",
    isAvailable: true, isHidden: false, moderationStatus: "approved",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const customerEmail = `cga_customer_${Date.now()}@platform-check.com`;
  await createUserWithEmailAndPassword(auth, customerEmail, PASSWORD);
  await sleep(2000); // let onUserCreate-style triggers (if any) settle
  await signInWithEmailAndPassword(auth, customerEmail, PASSWORD);
  await auth.currentUser.getIdToken(true);

  console.log(`Vendor ${vendorId} (NG, published/discoverable/verified) ready.`);
  console.log(`Calling repriceCart as a fresh real customer...`);

  try {
    const repriceCart = httpsCallable(fns, "repriceCart");
    const r = await repriceCart({ vendorId, fulfillmentType: "pickup", items: [{ itemId: itemRef.id, quantity: 1 }] });
    console.log("SUCCESS — repriceCart did NOT block on country availability:", JSON.stringify(r.data));
  } catch (err) {
    console.log("REJECTED —", err.code, "—", err.message);
  }

  // Cleanup: remove the throwaway vendor/item/users so this doesn't linger in real data.
  await itemRef.delete();
  await fdb.collection("vendors").doc(vendorId).delete();
  await fdb.collection("users").doc(vendorUid).delete();
  await admin.auth().deleteUser(vendorUid);
  const customerRecord = await admin.auth().getUserByEmail(customerEmail);
  await admin.auth().deleteUser(customerRecord.uid);
  await fdb.collection("users").doc(customerRecord.uid).delete().catch(() => {});
  console.log("Cleaned up throwaway test accounts/data.");
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
