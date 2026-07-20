/**
 * THE PLATFORM — Demo Data Seeder
 *
 * Creates a fully set-up demo vendor (verified, published, Pro plan active,
 * one paid invoice) and a demo Super-Admin, plus NG/US country pricing, so
 * the web app has something real to look at immediately — for showing
 * the client or anyone else the Vendor Portal/CMS without a blank-slate account.
 *
 * Not a test suite — no assertions, just seeds the emulator with real data
 * through the real callables, same way the acceptance tests do.
 *
 * Run: node seed-demo-vendor.js
 * Requires: firebase emulators:start --only auth,firestore,functions,storage --project demo-the platform
 */
const PROJECT_ID = "demo-the platform";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_STORAGE_EMULATOR_HOST = "127.0.0.1:9199";
process.env.FUNCTIONS_EMULATOR = "true";

const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID, storageBucket: `${PROJECT_ID}.appspot.com` });

const { initializeApp, getApps } = require("firebase/app");
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword } = require("firebase/auth");
const { getFirestore, connectFirestoreEmulator, doc, getDoc } = require("firebase/firestore");
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require("firebase/functions");
const { getStorage, connectStorageEmulator, ref, uploadBytes } = require("firebase/storage");

const clientApp = getApps().find((a) => a.name === "seed") || initializeApp({ apiKey: "demo", projectId: PROJECT_ID, storageBucket: `${PROJECT_ID}.appspot.com` }, "seed");
const auth = getAuth(clientApp), db = getFirestore(clientApp), fns = getFunctions(clientApp), storage = getStorage(clientApp);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
connectFirestoreEmulator(db, "127.0.0.1", 8080);
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
connectStorageEmulator(storage, "127.0.0.1", 9199);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PASSWORD = "DemoPass123!";
const VENDOR_EMAIL = "demo.vendor@the platform.com";
const ADMIN_EMAIL = "demo.admin@the platform.com";

async function waitFor(fn, retries = 15, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    const r = await fn();
    if (r) return r;
    await sleep(delay);
  }
  throw new Error("waitFor: condition never met");
}
async function signInAs(email) {
  const c = await signInWithEmailAndPassword(auth, email, PASSWORD);
  await c.user.getIdToken(true);
  return c;
}
function paystackSignature(bodyObj) {
  const crypto = require("crypto");
  return crypto.createHmac("sha512", "emulator_test_secret").update(JSON.stringify(bodyObj)).digest("hex");
}
async function postPaystackWebhook(bodyObj) {
  return fetch(`http://127.0.0.1:5001/${PROJECT_ID}/us-central1/handlePaystackWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-paystack-signature": paystackSignature(bodyObj) },
    body: JSON.stringify(bodyObj),
  });
}

async function seedCountryPricingAndProviders() {
  const now = admin.firestore.FieldValue.serverTimestamp();
  await admin.firestore().collection("subscriptionPricing").doc("NG").set({
    countryCode: "NG", currencyCode: "NGN",
    plans: { standard: { monthlyPriceMinorUnits: 100000 }, pro: { monthlyPriceMinorUnits: 250000 }, pro_plus: { monthlyPriceMinorUnits: 500000 } },
    status: "active", createdAt: now, updatedAt: now,
  });
  await admin.firestore().collection("providerPlanMapping").doc("NG-pro").set({
    countryCode: "NG", planId: "pro", paystack: { monthlyPlanCode: "PLN_pro_monthly_placeholder" },
  });
  await admin.firestore().collection("providerPlanMapping").doc("NG-standard").set({
    countryCode: "NG", planId: "standard", paystack: { monthlyPlanCode: "PLN_standard_monthly_placeholder" },
  });
  await admin.firestore().collection("providerPlanMapping").doc("NG-pro_plus").set({
    countryCode: "NG", planId: "pro_plus", paystack: { monthlyPlanCode: "PLN_pro_plus_monthly_placeholder" },
  });
  await admin.firestore().collection("subscriptionProviderConfig").doc("NG").set({
    countryCode: "NG", providerPriority: ["paystack"], status: "active", updatedAt: now,
  });
  await admin.firestore().collection("countryAvailability").doc("NG").set({
    countryCode: "NG", countryName: "Nigeria", status: "ACTIVE", updatedAt: now, updatedBy: "demo_seed",
  });
  console.log("Country pricing + provider config seeded for Nigeria.");
}

async function main() {
  console.log("Seeding demo data into the emulator...\n");

  await seedCountryPricingAndProviders();

  // --- Admin ---
  const ac = await createUserWithEmailAndPassword(auth, ADMIN_EMAIL, PASSWORD);
  const adminUid = ac.user.uid;
  await waitFor(async () => { const s = await getDoc(doc(db, "users", adminUid)); return s.exists() ? s : null; });
  await admin.auth().setCustomUserClaims(adminUid, { role: "admin", adminRoleIds: ["super_admin"], claimsVersion: 1 });
  await admin.firestore().collection("adminUsers").doc(adminUid).set({
    uid: adminUid, email: ADMIN_EMAIL, roleIds: ["super_admin"], status: "active",
    mfaRequired: false, mfaEnrolled: false, createdByAdminUid: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastLoginAt: null, revokedAt: null, lastMfaAt: null,
  });
  await admin.firestore().collection("users").doc(adminUid).update({ role: "admin" });
  console.log(`Admin ready:  ${ADMIN_EMAIL} / ${PASSWORD}  (log in at /cms)`);

  await signInAs(ADMIN_EMAIL);
  await httpsCallable(fns, "seedSubscriptionPlans")({});

  // --- Vendor ---
  const vc = await createUserWithEmailAndPassword(auth, VENDOR_EMAIL, PASSWORD);
  const vendorUid = vc.user.uid;
  await waitFor(async () => { const s = await getDoc(doc(db, "users", vendorUid)); return s.exists() ? s : null; });
  await signInAs(VENDOR_EMAIL);
  const rr = await httpsCallable(fns, "completeRegistration")({
    role: "vendor", businessName: "Lekki Spice Kitchen", username: `lekkispice_${Date.now()}`,
    fullName: "Demo Vendor", categoryId: "food_catering", categoryName: "Food & Catering",
    country: "Nigeria", state: "Lagos", area: "Lekki", plan: "basic",
  });
  const vendorId = rr.data.vendorId;
  await auth.currentUser.getIdToken(true);

  // Verify + publish so the storefront/plan screens look real.
  for (const type of ["business_info", "identity_document", "proof_of_address"]) {
    const path = `verificationDocuments/${vendorId}/${type}_demo.pdf`;
    await uploadBytes(ref(storage, path), new Uint8Array([0x25, 0x50, 0x44, 0x46]), { contentType: "application/pdf" });
    await httpsCallable(fns, "recordVerificationDocument")({ type, storagePath: path });
  }
  await httpsCallable(fns, "submitVendorVerification")({});
  await signInAs(ADMIN_EMAIL);
  await httpsCallable(fns, "approveVendorVerification")({ vendorId });

  // Activate a real Pro subscription via checkout + webhook, so the portal
  // shows an active plan, not just "Free" with nothing to look at.
  await signInAs(VENDOR_EMAIL);
  await httpsCallable(fns, "createSubscriptionCheckout")({ plan: "pro" });
  const webhookResp = await postPaystackWebhook({
    event: "subscription.create",
    data: {
      id: `evt_demo_seed_${Date.now()}`, created_at: new Date().toISOString(),
      metadata: { vendorId },
      subscription_code: "SUB_demo_seed", customer: { customer_code: "CUS_demo_seed" },
      plan: { plan_code: "PLN_pro_monthly_placeholder", plan_code_metadata: { planId: "pro" } },
      amount: 2500000, currency: "NGN",
    },
  });
  if (webhookResp.status !== 200) throw new Error(`Subscription webhook failed: ${webhookResp.status}`);
  await sleep(500);

  // Three invoices spanning all three real statuses, so /invoices has
  // something to filter/search across when demoing.
  const paidInvoice = await httpsCallable(fns, "createInvoice")({
    customerName: "Jane Doe",
    customerPhone: "+2348011112222",
    lineItems: [
      { description: "Jollof rice tray (large)", quantity: 2, unitPrice: 8500 },
      { description: "Delivery fee", quantity: 1, unitPrice: 1500 },
    ],
    notes: "Thank you for your order!",
  });
  await httpsCallable(fns, "updateInvoiceStatus")({ invoiceId: paidInvoice.data.invoiceId, status: "paid" });

  await httpsCallable(fns, "createInvoice")({
    customerName: "Tunde Bakare",
    customerPhone: "+2348022223333",
    lineItems: [
      { description: "Small chops (50 pcs)", quantity: 1, unitPrice: 12000 },
      { description: "Delivery fee", quantity: 1, unitPrice: 1500 },
    ],
    notes: "Payment on delivery, please.",
  });

  const cancelledInvoice = await httpsCallable(fns, "createInvoice")({
    customerName: "Ifeoma Chukwu",
    customerPhone: "+2348033334444",
    lineItems: [{ description: "Party pack (asoebi order)", quantity: 1, unitPrice: 45000 }],
    notes: "Cancelled — customer changed the event date.",
  });
  await httpsCallable(fns, "updateInvoiceStatus")({ invoiceId: cancelledInvoice.data.invoiceId, status: "cancelled" });

  console.log(`Vendor ready: ${VENDOR_EMAIL} / ${PASSWORD}  (log in at /portal — Pro plan active, 3 invoices: paid/unpaid/cancelled)`);
  console.log(`Vendor business name: Lekki Spice Kitchen, vendorId: ${vendorId}`);
  console.log("\nDone. Both accounts are ready to log into the web app right now.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
