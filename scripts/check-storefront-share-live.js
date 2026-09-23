/**
 * Creates a real, throwaway, PUBLISHED-BUT-UNVERIFIED vendor on platform-dev,
 * then opens their corrected storefront share link in a real browser to
 * confirm what actually happens today.
 */
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp({ projectId: "platform-dev" });
const fdb = admin.firestore();

async function main() {
  const uid = `cga_share_${Date.now()}`;
  const vendorId = fdb.collection("vendors").doc().id;
  const username = `sharecheck${Date.now()}`.slice(0, 20);

  await admin.auth().createUser({ uid, email: `${uid}@platform-check.com`, password: "CheckShare123!" });
  await admin.auth().setCustomUserClaims(uid, { role: "vendor", vendorId, claimsVersion: 1 });

  await fdb.collection("vendors").doc(vendorId).set({
    vendorId, ownerUid: uid, businessName: "Share Check Vendor", username,
    countryCode: "NG", country: "Nigeria",
    isPublished: true,          // published
    isVerified: false,          // deliberately NOT verified
    verificationStatus: "not_started",
    isDiscoverable: false,      // must be false: unverified vendors are never discoverable
    vendorStatus: "active",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`Created unverified, published vendor: username=${username}, vendorId=${vendorId}`);
  console.log(`Share link would be: https://platform-dev.web.app/store/${username}`);
  console.log(`\nCleaning up in 5 minutes...`);

  await new Promise((r) => setTimeout(r, 5 * 60_000));

  await fdb.collection("vendors").doc(vendorId).delete();
  await admin.auth().deleteUser(uid);
  console.log("Cleaned up.");
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
