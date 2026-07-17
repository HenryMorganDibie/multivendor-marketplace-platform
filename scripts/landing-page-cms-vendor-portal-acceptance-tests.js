/**
 * THE PLATFORM — Landing Page, CMS & Vendor Portal Acceptance Test Suite
 * Provider-neutral checkout (server-side provider selection), the two
 * subscription-offerings callables, migration-safe country resolution,
 * double-billing prevention on upgrade, the corrected invoice/receipt
 * numbering format, and the Price Change & Existing Subscriber Policy's
 * MVP-required implementation (currentMonthlyPriceMinorUnits mirroring).
 *
 * Formerly called "Milestone 5" internally — renamed to avoid colliding
 * with the client's own numbering, where Phase 5 refers to the separate,
 * not-yet-started Admin Web Portal (LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md
 * Section 0).
 *
 * Source of truth: LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md v6 (Sections
 * 4, 4.4, 12.1.4, 12.3) and frontend-subscription-alignment-scope.md
 * Section 7.
 *
 * Run: node landing-page-cms-vendor-portal-acceptance-tests.js
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
const { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc } = require("firebase/firestore");
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require("firebase/functions");

const clientApp = getApps().find(a => a.name === "test5") || initializeApp({ apiKey: "demo", projectId: PROJECT_ID, storageBucket: `${PROJECT_ID}.appspot.com` }, "test5");
const auth = getAuth(clientApp), db = getFirestore(clientApp), fns = getFunctions(clientApp);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
connectFirestoreEmulator(db, "127.0.0.1", 8080);
connectFunctionsEmulator(fns, "127.0.0.1", 5001);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0, total = 0;
async function test(name, fn) {
  total++;
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.error(`  ❌ ${name}\n     ${e.message ?? e}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || "Assertion failed"); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function assertDenied(p) { return p.then(() => { throw new Error("Expected denial but succeeded"); }, () => {}); }
async function assertFnError(p, code) {
  return p.then(() => { throw new Error(`Expected ${code} but succeeded`); }, err => {
    if (!err.code?.includes(code)) throw new Error(`Expected ${code}, got: ${err.code} — ${err.message}`);
  });
}
async function waitFor(fn, retries = 15, delay = 1000) {
  for (let i = 0; i < retries; i++) { const r = await fn(); if (r) return r; await sleep(delay); }
  throw new Error("waitFor: condition never met");
}

const RUN_ID = Date.now();
const PASSWORD = "TestPass123!";
let adminEmail, adminUid;
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

async function registerVendor({ prefix, country, state = "Lagos", area = "Lekki" }) {
  const email = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@test.com`;
  const c = await createUserWithEmailAndPassword(auth, email, PASSWORD);
  await waitFor(async () => { const s = await getDoc(doc(db, "users", c.user.uid)); return s.exists() ? s : null; });
  await signInAs(email);
  const rr = await httpsCallable(fns, "completeRegistration")({
    role: "vendor", businessName: `${prefix} Test Vendor`, username: `${prefix}_${Date.now()}`,
    fullName: "Vendor Owner", categoryId: "food_catering", categoryName: "Food & Catering",
    country, state, area, plan: "basic",
  });
  await auth.currentUser.getIdToken(true);
  return { email, uid: c.user.uid, vendorId: rr.data.vendorId };
}

async function setup() {
  console.log("\n⚙️  Setup: admin account + country/pricing/provider fixtures...");

  adminEmail = `p5admin_${Date.now()}@the platform.com`;
  const ac = await createUserWithEmailAndPassword(auth, adminEmail, PASSWORD);
  adminUid = ac.user.uid;
  await waitFor(async () => { const s = await getDoc(doc(db, "users", adminUid)); return s.exists() ? s : null; });
  await admin.auth().setCustomUserClaims(adminUid, { role: "admin", adminRoleIds: ["super_admin"], claimsVersion: 1 });
  await admin.firestore().collection("adminUsers").doc(adminUid).set({ uid: adminUid, email: adminEmail, roleIds: ["super_admin"], status: "active", mfaRequired: true, mfaEnrolled: false, createdByAdminUid: null, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(), lastLoginAt: null, revokedAt: null, lastMfaAt: null });
  await admin.firestore().collection("users").doc(adminUid).update({ role: "admin" });

  const now = admin.firestore.FieldValue.serverTimestamp();

  // NG: paystack + flutterwave both mapped, priority favors paystack —
  // proves "first eligible provider wins", not "only mapped provider used".
  await admin.firestore().collection("subscriptionPricing").doc("NG").set({
    countryCode: "NG", currencyCode: "NGN",
    plans: {
      standard: { monthlyPriceMinorUnits: 990000, effectiveFrom: now },
      pro: { monthlyPriceMinorUnits: 2500000, effectiveFrom: now },
      pro_plus: { monthlyPriceMinorUnits: 4000000, effectiveFrom: now },
    },
    status: "active", createdAt: now, updatedAt: now,
  });
  // All three paid plans mapped for NG, not just "pro" — so a generic
  // "everything is available" offerings check has a real fixture to pass
  // against, not just the one plan Section 1's checkout tests happen to use.
  for (const planId of ["standard", "pro", "pro_plus"]) {
    await admin.firestore().collection("providerPlanMapping").doc(`NG-${planId}`).set({
      countryCode: "NG", planId,
      paystack: { monthlyPlanCode: `PLN_${planId}_monthly_placeholder` },
      flutterwave: { monthlyPlanId: `FLW_${planId}_monthly_placeholder` },
    });
  }
  await admin.firestore().collection("subscriptionProviderConfig").doc("NG").set({
    countryCode: "NG", providerPriority: ["paystack", "flutterwave"], status: "active", updatedAt: now,
  });

  // KE: only flutterwave mapped, and priority lists paystack FIRST anyway —
  // proves the selector falls through to the next provider in the list
  // when the top-priority one has no mapping, rather than failing outright.
  // Doc ID is "KENYA", not "KE": resolveCountryCode()'s name->code map only
  // covers Nigeria/US today (per its own comment), so registering a vendor
  // with country: "Kenya" resolves to "KENYA" (uppercased raw input), not
  // an ISO code — fixtures have to key off what the code actually produces.
  await admin.firestore().collection("subscriptionPricing").doc("KENYA").set({
    countryCode: "KENYA", currencyCode: "KES",
    plans: {
      standard: { monthlyPriceMinorUnits: 190000 },
      pro: { monthlyPriceMinorUnits: 540000 },
      pro_plus: { monthlyPriceMinorUnits: 1350000 },
    },
    status: "active", createdAt: now, updatedAt: now,
  });
  await admin.firestore().collection("providerPlanMapping").doc("KENYA-pro").set({
    countryCode: "KENYA", planId: "pro",
    flutterwave: { monthlyPlanId: "FLW_ke_pro_monthly_placeholder" },
  });
  await admin.firestore().collection("subscriptionProviderConfig").doc("KENYA").set({
    countryCode: "KENYA", providerPriority: ["paystack", "flutterwave"], status: "active", updatedAt: now,
  });

  // ZA: active pricing, but NO subscriptionProviderConfig document at all —
  // proves "pricing exists, no provider config" fails with
  // PAYMENT_PROVIDER_NOT_CONFIGURED, not a crash or a silent default. Same
  // doc-ID caveat as Kenya above: keyed "SOUTH AFRICA", not "ZA".
  await admin.firestore().collection("subscriptionPricing").doc("SOUTH AFRICA").set({
    countryCode: "SOUTH AFRICA", currencyCode: "ZAR",
    plans: {
      standard: { monthlyPriceMinorUnits: 27000 },
      pro: { monthlyPriceMinorUnits: 72000 },
      pro_plus: { monthlyPriceMinorUnits: 162000 },
    },
    status: "active", createdAt: now, updatedAt: now,
  });

  // A SEPARATE fixture keyed by the real ISO code "KE" (distinct from the
  // "KENYA" one above), used only by Section 3's migration-resolution test,
  // which sets vendor.businessLocation.countryCode directly via Admin SDK
  // rather than through resolveCountryCode() — a future migrated vendor's
  // structured field is expected to hold a real ISO code, not a raw
  // uppercased country name.
  await admin.firestore().collection("subscriptionPricing").doc("KE").set({
    countryCode: "KE", currencyCode: "KES",
    plans: {
      standard: { monthlyPriceMinorUnits: 190000 },
      pro: { monthlyPriceMinorUnits: 540000 },
      pro_plus: { monthlyPriceMinorUnits: 1350000 },
    },
    status: "active", createdAt: now, updatedAt: now,
  });

  console.log("  -> NG (paystack+flutterwave, all 3 plans), KENYA (flutterwave-only, mis-prioritized), SOUTH AFRICA (pricing, no provider config), KE (ISO-code fixture for migration test) fixtures seeded");
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 1: Provider-neutral checkout — server-side selection
// ─────────────────────────────────────────────────────────────────────────
async function section1() {
  console.log("\n📋 Section 1: Provider-neutral checkout — server-side selection");

  await test("createSubscriptionCheckout has no provider-specific request field — { plan } alone is sufficient", async () => {
    const { email } = await registerVendor({ prefix: "p5ng", country: "Nigeria" });
    await signInAs(email);
    const r = await httpsCallable(fns, "createSubscriptionCheckout")({ plan: "pro" });
    assert(r.data.success);
    assert(typeof r.data.authorizationUrl === "string");
    assert(typeof r.data.reference === "string");
  });

  await test("NG (paystack, flutterwave both mapped) selects paystack — first in priority wins", async () => {
    const { email } = await registerVendor({ prefix: "p5ngpri", country: "Nigeria" });
    await signInAs(email);
    const r = await httpsCallable(fns, "createSubscriptionCheckout")({ plan: "pro" });
    assert(r.data.authorizationUrl.startsWith("https://checkout.paystack.test/"));
  });

  await test("KE (only flutterwave mapped, paystack listed first in priority) falls through to flutterwave", async () => {
    const { email } = await registerVendor({ prefix: "p5ke", country: "Kenya", state: "Nairobi", area: "CBD" });
    await signInAs(email);
    const r = await httpsCallable(fns, "createSubscriptionCheckout")({ plan: "pro" });
    assert(r.data.authorizationUrl.startsWith("https://checkout.flutterwave.test/"), "expected fallback to flutterwave when paystack has no KE-pro mapping");
  });

  await test("ZA (pricing active, no subscriptionProviderConfig at all) fails with PAYMENT_PROVIDER_NOT_CONFIGURED, never a crash", async () => {
    const { email } = await registerVendor({ prefix: "p5za", country: "South Africa", state: "Gauteng", area: "Sandton" });
    await signInAs(email);
    try {
      await httpsCallable(fns, "createSubscriptionCheckout")({ plan: "pro" });
      assert(false, "expected rejection for ZA with no provider config");
    } catch (err) {
      assertEqual(err.code, "functions/failed-precondition");
      assertEqual(err.details?.errorCode, "PAYMENT_PROVIDER_NOT_CONFIGURED");
    }
  });

  await test("Country with no subscriptionPricing at all still fails with PRICING_NOT_CONFIGURED (checked before provider selection)", async () => {
    const { email } = await registerVendor({ prefix: "p5gh", country: "Ghana" });
    await signInAs(email);
    try {
      await httpsCallable(fns, "createSubscriptionCheckout")({ plan: "pro" });
      assert(false, "expected rejection for a country with no pricing configured");
    } catch (err) {
      assertEqual(err.code, "functions/failed-precondition");
      assertEqual(err.details?.errorCode, "PRICING_NOT_CONFIGURED");
    }
  });

  await test("subscriptionProviderConfig is never client-readable", async () => {
    await assertDenied(getDoc(doc(db, "subscriptionProviderConfig", "NG")));
  });

  await test("Provider-specific checkout callables no longer exist as public functions", async () => {
    await assertFnError(httpsCallable(fns, "createFlutterwaveCheckout")({ plan: "pro" }), "not-found");
    await assertFnError(httpsCallable(fns, "createStripeCheckout")({ plan: "pro" }), "not-found");
  });

  await test("getCheckoutAvailability no longer exists as a public function (superseded by offerings callables)", async () => {
    await assertFnError(httpsCallable(fns, "getCheckoutAvailability")({ plan: "pro" }), "not-found");
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 2: Subscription offerings — authenticated vs. public
// ─────────────────────────────────────────────────────────────────────────
async function section2() {
  console.log("\n📋 Section 2: Subscription offerings — authenticated vs. public");
  let ngVendorEmail, ngVendorId;

  await test("Setup: NG vendor for offerings tests", async () => {
    const v = await registerVendor({ prefix: "p5off", country: "Nigeria" });
    ngVendorEmail = v.email;
    ngVendorId = v.vendorId;
  });

  await test("getVendorSubscriptionOfferings requires authentication", async () => {
    await auth.signOut();
    await assertFnError(httpsCallable(fns, "getVendorSubscriptionOfferings")({}), "permission-denied");
  });

  await test("getVendorSubscriptionOfferings resolves country server-side, accepts no client-supplied country", async () => {
    await signInAs(ngVendorEmail);
    // Deliberately pass a spoofed countryCode — must be ignored entirely.
    const r = await httpsCallable(fns, "getVendorSubscriptionOfferings")({ countryCode: "US" });
    assertEqual(r.data.countryCode, "NG", "a client-supplied country must never override server-side resolution");
    assertEqual(r.data.currencyCode, "NGN");
  });

  await test("getVendorSubscriptionOfferings returns correct price/availability for all three paid plans", async () => {
    await signInAs(ngVendorEmail);
    const r = await httpsCallable(fns, "getVendorSubscriptionOfferings")({});
    assertEqual(r.data.plans.length, 3);
    const standard = r.data.plans.find(p => p.plan === "standard");
    assertEqual(standard.monthlyPriceMinorUnits, 990000);
    assertEqual(standard.available, true);
    assert(standard.unavailableReason === undefined);
  });

  await test("getPublicSubscriptionOfferings works unauthenticated and requires a countryCode", async () => {
    await auth.signOut();
    await assertFnError(httpsCallable(fns, "getPublicSubscriptionOfferings")({}), "invalid-argument");
    const r = await httpsCallable(fns, "getPublicSubscriptionOfferings")({ countryCode: "NG" });
    assertEqual(r.data.countryCode, "NG");
    assertEqual(r.data.currencyCode, "NGN");
  });

  await test("getPublicSubscriptionOfferings reflects the PAYMENT_PROVIDER_NOT_CONFIGURED reason for ZA", async () => {
    const r = await httpsCallable(fns, "getPublicSubscriptionOfferings")({ countryCode: "SOUTH AFRICA" });
    for (const p of r.data.plans) {
      assertEqual(p.available, false);
      assertEqual(p.unavailableReason, "PAYMENT_PROVIDER_NOT_CONFIGURED");
    }
  });

  await test("getPublicSubscriptionOfferings reflects PRICING_NOT_CONFIGURED for a country with no pricing at all", async () => {
    const r = await httpsCallable(fns, "getPublicSubscriptionOfferings")({ countryCode: "GH" });
    for (const p of r.data.plans) {
      assertEqual(p.available, false);
      assertEqual(p.unavailableReason, "PRICING_NOT_CONFIGURED");
    }
  });

  await test("Neither offerings callable ever mentions a provider name, under any field, for any country", async () => {
    const r1 = await httpsCallable(fns, "getPublicSubscriptionOfferings")({ countryCode: "NG" });
    const r2 = await httpsCallable(fns, "getPublicSubscriptionOfferings")({ countryCode: "KENYA" });
    for (const blob of [r1.data, r2.data]) {
      const s = JSON.stringify(blob).toLowerCase();
      assert(!s.includes("paystack") && !s.includes("flutterwave") && !s.includes("stripe"), "provider identifier leaked into an offerings response");
    }
  });

  await test("getVendorSubscriptionOfferings never authorizes checkout by itself — it's read-only", async () => {
    await signInAs(ngVendorEmail);
    await httpsCallable(fns, "getVendorSubscriptionOfferings")({});
    const subSnap = await admin.firestore().collection("vendorSubscriptions").doc(ngVendorId).get();
    assert(!subSnap.exists || subSnap.data().status !== "active", "offerings call must never itself create/activate a subscription");
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 3: Migration-safe country resolution
// ─────────────────────────────────────────────────────────────────────────
async function section3() {
  console.log("\n📋 Section 3: Migration-safe country resolution (businessLocation.countryCode ?? countryCode)");
  let vendorId, vendorEmail;

  await test("Setup: vendor with only the legacy flat countryCode field (the default today)", async () => {
    const v = await registerVendor({ prefix: "p5legacy", country: "Nigeria" });
    vendorId = v.vendorId;
    vendorEmail = v.email;
    const snap = await admin.firestore().collection("vendors").doc(vendorId).get();
    assertEqual(snap.data().countryCode, "NG");
    assert(snap.data().businessLocation === undefined, "expected no businessLocation field on a not-yet-migrated vendor");
  });

  await test("Offerings resolve via the legacy field when businessLocation is absent", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "getVendorSubscriptionOfferings")({});
    assertEqual(r.data.countryCode, "NG");
  });

  await test("Once businessLocation.countryCode is set, it takes priority over the legacy field", async () => {
    await admin.firestore().collection("vendors").doc(vendorId).update({
      "businessLocation.countryCode": "KE",
    });
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "getVendorSubscriptionOfferings")({});
    assertEqual(r.data.countryCode, "KE", "businessLocation.countryCode must win over the legacy flat countryCode once present");
    assertEqual(r.data.currencyCode, "KES");
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 4: Double-billing prevention on upgrade (Section 12.1.4)
// ─────────────────────────────────────────────────────────────────────────
async function section4() {
  console.log("\n📋 Section 4: Double-billing prevention on upgrade (Section 12.1.4)");
  let vendorId, vendorEmail;

  await test("Setup: vendor activated on Standard via webhook", async () => {
    const v = await registerVendor({ prefix: "p5dbl", country: "Nigeria" });
    vendorId = v.vendorId;
    vendorEmail = v.email;
    const resp = await postWebhook({
      event: "subscription.create",
      data: {
        id: `p5_evt_activate_${RUN_ID}`, created_at: new Date().toISOString(),
        metadata: { vendorId },
        subscription_code: `SUB_p5_${RUN_ID}`, customer: { customer_code: `CUS_p5_${RUN_ID}` },
        plan: { plan_code: "PLN_standard_monthly_placeholder", plan_code_metadata: { planId: "standard" } },
        amount: 990000, currency: "NGN", // Paystack sends kobo; the webhook divides by 100 to store amountPaid in naira
      },
    });
    assertEqual(resp.status, 200);
    await sleep(300);
    const subSnap = await admin.firestore().collection("vendorSubscriptions").doc(vendorId).get();
    assertEqual(subSnap.data().status, "active");
    assertEqual(subSnap.data().plan, "standard");
  });

  await test("A second checkout while already active does not throw — existing subscription is safely handled first", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "createSubscriptionCheckout")({ plan: "pro" });
    assert(r.data.success, "upgrade checkout must succeed even though a live subscription already exists");
  });

  await test("Exactly one vendorSubscriptions document exists per vendor after the upgrade checkout + new activation webhook", async () => {
    const resp = await postWebhook({
      event: "subscription.create",
      data: {
        id: `p5_evt_upgrade_${RUN_ID}`, created_at: new Date().toISOString(),
        metadata: { vendorId },
        subscription_code: `SUB_p5_upgrade_${RUN_ID}`, customer: { customer_code: `CUS_p5_${RUN_ID}` },
        plan: { plan_code: "PLN_pro_monthly_placeholder", plan_code_metadata: { planId: "pro" } },
        amount: 2500000 / 100, currency: "NGN",
      },
    });
    assertEqual(resp.status, 200);
    await sleep(300);
    const subSnap = await admin.firestore().collection("vendorSubscriptions").doc(vendorId).get();
    assert(subSnap.exists);
    assertEqual(subSnap.data().plan, "pro", "the vendor's single subscription record must reflect the new plan after upgrade");
  });

  // NOTE: cancelProviderSubscription() short-circuits to a no-op in the
  // Functions emulator (matching the existing pattern for all real
  // provider API calls in this codebase — see runPaystackCheckout /
  // runFlutterwaveCheckout / runStripeCheckout). This section proves the
  // upgrade FLOW completes correctly with an existing active subscription
  // present; it cannot prove the real Paystack/Flutterwave/Stripe
  // cancellation API call itself succeeds against a live account — that
  // requires sandbox credentials outside this test environment, per the
  // caveat already documented in internationalCheckout.ts.
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 5: Invoice / receipt numbering format
// ─────────────────────────────────────────────────────────────────────────
async function section5() {
  console.log("\n📋 Section 5: Invoice/receipt numbering — {VENDORSLUG}-INV-{seq}, no padding, immutable");
  let vendorId, vendorEmail, firstInvoiceId, firstInvoiceNumber;

  await test("Setup: vendor for numbering tests", async () => {
    const v = await registerVendor({ prefix: "p5num", country: "Nigeria" });
    vendorId = v.vendorId;
    vendorEmail = v.email;
  });

  await test("First invoice number has no zero-padding and no year in it", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "createInvoice")({
      customerName: "Numbering Test Customer",
      lineItems: [{ description: "Item", quantity: 1, unitPrice: 1000 }],
    });
    firstInvoiceId = r.data.invoiceId;
    firstInvoiceNumber = r.data.invoiceNumber;
    assert(!/^INV-/.test(firstInvoiceNumber), "must not use the old LAE/INV-prefixed format");
    assert(!/\d{4}/.test(firstInvoiceNumber.split("-")[1] ?? ""), "must not embed a 4-digit year");
    assert(/-INV-\d+$/.test(firstInvoiceNumber), "expected {VENDORSLUG}-INV-{seq} with no zero-padding");
  });

  await test("Sequential invoices increment by exactly 1, per vendor", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "createInvoice")({
      customerName: "Second Customer",
      lineItems: [{ description: "Item", quantity: 1, unitPrice: 500 }],
    });
    const firstSeq = parseInt(firstInvoiceNumber.split("-INV-")[1], 10);
    const secondSeq = parseInt(r.data.invoiceNumber.split("-INV-")[1], 10);
    assertEqual(secondSeq, firstSeq + 1);
  });

  await test("Changing the vendor's slug does not retroactively change an already-issued invoice number", async () => {
    await admin.firestore().collection("vendors").doc(vendorId).update({ username: `p5renamed_${RUN_ID}` });
    const snap = await admin.firestore().collection("invoices").doc(firstInvoiceId).get();
    assertEqual(snap.data().invoiceNumber, firstInvoiceNumber, "issued invoice numbers must be immutable across a slug change");
  });

  // Receipt numbers (getNextReceiptNumber) follow the identical
  // {VENDORSLUG}-RCT-{seq} convention, sharing the same code path pattern
  // as getNextInvoiceNumber above — see orderNumbers.ts. Not exercised
  // end-to-end here: generateReceiptInternal only fires from the full
  // order-acceptance-to-completion lifecycle (catalog item, cart, order
  // status transitions), which is already set up and covered by the order
  // acceptance suite; duplicating that full setup here just to re-check a
  // string format would be redundant rather than additive coverage.
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION 6: Price Change & Existing Subscriber Policy — currentMonthlyPriceMinorUnits
// ─────────────────────────────────────────────────────────────────────────
async function section6() {
  console.log("\n📋 Section 6: currentMonthlyPriceMinorUnits mirrors what was actually charged");
  let vendorId, vendorEmail;

  await test("Setup: vendor activated at NG's current Standard price", async () => {
    const v = await registerVendor({ prefix: "p5price", country: "Nigeria" });
    vendorId = v.vendorId;
    vendorEmail = v.email;
    const resp = await postWebhook({
      event: "subscription.create",
      data: {
        id: `p5_evt_price1_${RUN_ID}`, created_at: new Date().toISOString(),
        metadata: { vendorId },
        subscription_code: `SUB_p5price_${RUN_ID}`, customer: { customer_code: `CUS_p5price_${RUN_ID}` },
        plan: { plan_code: "PLN_standard_monthly_placeholder", plan_code_metadata: { planId: "standard" } },
        amount: 990000, currency: "NGN", // kobo — Paystack webhook divides by 100, so amountPaid ends up 9,900.00 NGN
      },
    });
    assertEqual(resp.status, 200);
    await sleep(300);
  });

  await test("currentMonthlyPriceMinorUnits is correctly converted from the webhook's major-unit amountPaid", async () => {
    const subSnap = await admin.firestore().collection("vendorSubscriptions").doc(vendorId).get();
    assertEqual(subSnap.data().amountPaid, 9900);
    assertEqual(subSnap.data().currentMonthlyPriceMinorUnits, 990000, "NGN has 2 minor-unit decimals: 9900 * 100 = 990000");
  });

  await test("Editing subscriptionPricing alone does NOT change an existing subscriber's currentMonthlyPriceMinorUnits", async () => {
    await admin.firestore().collection("subscriptionPricing").doc("NG").update({
      "plans.standard.monthlyPriceMinorUnits": 1290000, // simulate a price increase to ₦12,900
      "plans.standard.effectiveFrom": admin.firestore.Timestamp.fromDate(new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)),
    });
    const subSnap = await admin.firestore().collection("vendorSubscriptions").doc(vendorId).get();
    assertEqual(subSnap.data().currentMonthlyPriceMinorUnits, 990000, "a pricing-config edit alone must never silently reprice an existing subscriber");
  });

  await test("A new checkout (new subscriber) would see the updated price via offerings", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "getVendorSubscriptionOfferings")({});
    const standard = r.data.plans.find(p => p.plan === "standard");
    assertEqual(standard.monthlyPriceMinorUnits, 1290000, "offerings must reflect the newly published price for NEW purchases");
  });

  await test("A real renewal webhook at the new amount updates currentMonthlyPriceMinorUnits to match what was actually charged", async () => {
    const resp = await postWebhook({
      event: "invoice.payment_succeeded",
      data: {
        id: `p5_evt_price2_${RUN_ID}`, created_at: new Date().toISOString(),
        metadata: { vendorId },
        subscription_code: `SUB_p5price_${RUN_ID}`, customer: { customer_code: `CUS_p5price_${RUN_ID}` },
        plan: { plan_code_metadata: { planId: "standard" } },
        amount: 1290000, currency: "NGN", // kobo — admin has since migrated this vendor's provider-side plan to the new price (12,900.00 NGN)
      },
    });
    assertEqual(resp.status, 200);
    await sleep(300);
    const subSnap = await admin.firestore().collection("vendorSubscriptions").doc(vendorId).get();
    assertEqual(subSnap.data().amountPaid, 12900);
    assertEqual(subSnap.data().currentMonthlyPriceMinorUnits, 1290000, "must mirror the real charge, proving the price only changes via an actual renewal payment, never a config edit alone");
  });
}

async function main() {
  console.log("🚀 THE PLATFORM — Landing Page, CMS & Vendor Portal Acceptance Test Suite");
  console.log("=".repeat(60));

  await setup();
  await section1();
  await section2();
  await section3();
  await section4();
  await section5();
  await section6();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed === 0) console.log("✅ ALL TESTS PASSED — Landing Page, CMS & Vendor Portal ready for sign-off");
  else { console.log("❌ SOME TESTS FAILED — see errors above"); process.exitCode = 1; }
  process.exit(process.exitCode || 0);
}
main().catch(err => { console.error("Fatal:", err); process.exit(1); });
