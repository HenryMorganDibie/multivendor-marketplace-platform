/**
 * THE PLATFORM — Milestone 4 Workflow Demo
 * Not a test suite (no assertions) — walks through the exact real-world
 * workflow end to end, printing real request/response payloads, so the
 * output can be read as a narrative demo rather than a pass/fail list.
 *
 * Run: node milestone4-workflow-demo.js
 * Requires: firebase emulators:start --only auth,firestore,functions,storage --project demo-the platform
 */
const crypto = require("crypto");
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

const clientApp = getApps().find(a => a.name === "demo4") || initializeApp({ apiKey: "demo", projectId: PROJECT_ID }, "demo4");
const auth = getAuth(clientApp), db = getFirestore(clientApp), fns = getFunctions(clientApp);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
connectFirestoreEmulator(db, "127.0.0.1", 8080);
connectFunctionsEmulator(fns, "127.0.0.1", 5001);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PASSWORD = "TestPass123!";

function log(title) { console.log(`\n${"=".repeat(70)}\n${title}\n${"=".repeat(70)}`); }
function show(label, data) { console.log(`\n--- ${label} ---`); console.log(JSON.stringify(data, null, 2)); }

async function waitFor(fn, retries = 15, delay = 1000) {
  for (let i = 0; i < retries; i++) { const r = await fn(); if (r) return r; await sleep(delay); }
  throw new Error("waitFor: condition never met");
}
async function signInAs(email) { const c = await signInWithEmailAndPassword(auth, email, PASSWORD); await c.user.getIdToken(true); return c; }

function paystackSignature(bodyObj) {
  const raw = JSON.stringify(bodyObj);
  return crypto.createHmac("sha512", "emulator_test_secret").update(raw).digest("hex");
}
async function postWebhook(bodyObj) {
  const raw = JSON.stringify(bodyObj);
  return fetch(`http://127.0.0.1:5001/${PROJECT_ID}/us-central1/handlePaystackWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-paystack-signature": paystackSignature(bodyObj) },
    body: raw,
  });
}

async function main() {
  log("SETUP — provisioning a vendor and admin account");
  const vendorEmail = `demo_vend_${Date.now()}@test.com`;
  const vc = await createUserWithEmailAndPassword(auth, vendorEmail, PASSWORD);
  const vendorUid = vc.user.uid;
  await waitFor(async () => { const s = await getDoc(doc(db, "users", vendorUid)); return s.exists() ? s : null; });
  await signInAs(vendorEmail);
  const rr = await httpsCallable(fns, "completeRegistration")({ role: "vendor", businessName: "Demo Vendor", username: `demovend_${Date.now()}`, fullName: "Vendor Owner", categoryId: "food_catering", categoryName: "Food & Catering", country: "Nigeria", state: "Lagos", area: "Lekki", plan: "basic" });
  const vendorId = rr.data.vendorId;
  await auth.currentUser.getIdToken(true);
  console.log(`Vendor created: ${vendorId} (${vendorEmail})`);

  const adminEmail = `demo_admin_${Date.now()}@the platform.com`;
  const ac = await createUserWithEmailAndPassword(auth, adminEmail, PASSWORD);
  const adminUid = ac.user.uid;
  await waitFor(async () => { const s = await getDoc(doc(db, "users", adminUid)); return s.exists() ? s : null; });
  await admin.auth().setCustomUserClaims(adminUid, { role: "admin", adminRoleIds: ["super_admin"], claimsVersion: 1 });
  await admin.firestore().collection("adminUsers").doc(adminUid).set({ uid: adminUid, email: adminEmail, roleIds: ["super_admin"], status: "active", mfaRequired: true, mfaEnrolled: false, createdByAdminUid: null, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(), lastLoginAt: null, revokedAt: null, lastMfaAt: null });
  await admin.firestore().collection("users").doc(adminUid).update({ role: "admin" });
  console.log(`Admin created: ${adminUid} (${adminEmail})`);

  await signInAs(adminEmail);
  const seedResult = await httpsCallable(fns, "seedSubscriptionPlans")({});
  show("seedSubscriptionPlans response", seedResult.data);

  log("STEP 1 — Vendor starts on Basic (no subscription yet)");
  await signInAs(vendorEmail);
  const status0 = await httpsCallable(fns, "getSubscriptionStatus")({});
  show("getSubscriptionStatus (before any subscription)", { effectivePlan: status0.data.effectivePlan, reason: status0.data.reason, catalogItemLimit: status0.data.planLimits.catalogItemLimit, canAccessExternalOrders: status0.data.planLimits.canAccessExternalOrders });

  log("STEP 2 — Upgrade Basic → Pro (checkout + simulated Paystack webhook)");
  const checkout = await httpsCallable(fns, "createSubscriptionCheckout")({ plan: "pro", billingInterval: "monthly" });
  show("createSubscriptionCheckout response", checkout.data);

  const webhookResp = await postWebhook({
    event: "subscription.create",
    data: {
      id: `evt_demo_${Date.now()}`, created_at: new Date().toISOString(),
      metadata: { vendorId },
      subscription_code: "SUB_demo_1", customer: { customer_code: "CUS_demo_1" },
      plan: { plan_code: "PLN_pro_monthly", plan_code_metadata: { planId: "pro" } },
      amount: 1500000, currency: "NGN",
    },
  });
  console.log(`\nWebhook HTTP status: ${webhookResp.status} (this is what Paystack would receive back)`);
  await sleep(500);

  const status1 = await httpsCallable(fns, "getSubscriptionStatus")({});
  show("getSubscriptionStatus (after webhook activation)", { effectivePlan: status1.data.effectivePlan, reason: status1.data.reason, catalogItemLimit: status1.data.planLimits.catalogItemLimit, canAccessExternalOrders: status1.data.planLimits.canAccessExternalOrders, canDownloadInvoicePdf: status1.data.planLimits.canDownloadInvoicePdf });

  log("STEP 3 — Create an invoice (Pro plan, 100/month quota)");
  const invoiceResult = await httpsCallable(fns, "createInvoice")({
    customerName: "Jane Doe", customerPhone: "+2348011112222",
    lineItems: [
      { description: "Jollof rice tray (large)", quantity: 2, unitPrice: 8500 },
      { description: "Delivery fee", quantity: 1, unitPrice: 1500 },
    ],
    notes: "Thank you for your order!",
  });
  show("createInvoice response", invoiceResult.data);

  const invoiceSnap = await admin.firestore().collection("invoices").doc(invoiceResult.data.invoiceId).get();
  show("The actual invoice document in Firestore (server-computed subtotal)", { subtotal: invoiceSnap.data().subtotal, lineItems: invoiceSnap.data().lineItems, status: invoiceSnap.data().status });

  log("STEP 4 — Download the invoice as a PDF");
  const pdfResult = await httpsCallable(fns, "downloadInvoicePdf")({ invoiceId: invoiceResult.data.invoiceId });
  const pdfBytes = Buffer.from(pdfResult.data.pdfBase64, "base64");
  console.log(`\nfileName: ${pdfResult.data.fileName}`);
  console.log(`PDF size: ${pdfBytes.length} bytes`);
  console.log(`First 8 bytes (PDF magic header check): ${pdfBytes.slice(0, 8).toString("ascii")}`);

  log("STEP 5 — Cancel the subscription (cancel-at-period-end)");
  const cancelResult = await httpsCallable(fns, "cancelSubscription")({});
  show("cancelSubscription response", cancelResult.data);
  const statusAfterCancel = await httpsCallable(fns, "getSubscriptionStatus")({});
  show("getSubscriptionStatus (right after cancelling — still Pro until period end)", { effectivePlan: statusAfterCancel.data.effectivePlan, reason: statusAfterCancel.data.reason, cancelAtPeriodEnd: statusAfterCancel.data.subscription?.cancelAtPeriodEnd });

  log("STEP 6 — Reactivate before period end");
  const reactivateResult = await httpsCallable(fns, "reactivateSubscription")({});
  show("reactivateSubscription response", reactivateResult.data);
  const statusAfterReactivate = await httpsCallable(fns, "getSubscriptionStatus")({});
  show("getSubscriptionStatus (after reactivation)", { effectivePlan: statusAfterReactivate.data.effectivePlan, reason: statusAfterReactivate.data.reason, cancelAtPeriodEnd: statusAfterReactivate.data.subscription?.cancelAtPeriodEnd });

  log("STEP 7 — Admin override (support comp to Pro Plus)");
  await signInAs(adminEmail);
  const overrideResult = await httpsCallable(fns, "applyManualSubscriptionOverride")({ vendorId, plan: "pro_plus", reason: "Customer support goodwill credit", ticketId: "SUPPORT-4821" });
  show("applyManualSubscriptionOverride response", overrideResult.data);

  await signInAs(vendorEmail);
  const statusAfterOverride = await httpsCallable(fns, "getSubscriptionStatus")({});
  show("getSubscriptionStatus (after admin override)", { effectivePlan: statusAfterOverride.data.effectivePlan, reason: statusAfterOverride.data.reason, canUsePremiumTemplates: statusAfterOverride.data.planLimits.canUsePremiumTemplates, canAddQrCode: statusAfterOverride.data.planLimits.canAddQrCode });

  log("DEMO COMPLETE");
  console.log("Every step above ran against the real Cloud Functions emulator, real Firestore, and a real simulated Paystack webhook — no mocked responses.");
  process.exit(0);
}
main().catch(err => { console.error("Fatal:", err); process.exit(1); });
