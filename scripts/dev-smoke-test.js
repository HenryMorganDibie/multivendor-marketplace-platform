/**
 * End-to-end smoke test against the real platform-dev project.
 *
 * Not the emulator. This registers a genuine account through the deployed
 * callables, writes real documents, and reads the figures back the way the app
 * does — which is the only thing that actually answers "is there a backend".
 * A passing emulator suite has never settled that question for anyone.
 *
 * It walks the path that matters commercially: a vendor signs up, lists
 * something, invoices a customer, takes a payment, and looks at their numbers.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node dev-smoke-test.js
 *
 * Leaves its test data behind on purpose — dev is meant to have something in it
 * to look at, and the account is obviously named.
 */
const admin = require("firebase-admin");
const { initializeApp } = require("firebase/app");
const { getAuth, createUserWithEmailAndPassword } = require("firebase/auth");
const { getFunctions, httpsCallable } = require("firebase/functions");

const PROJECT = "platform-dev";
const API_KEY = process.env.DEV_API_KEY;

if (!API_KEY) {
  console.error("Set DEV_API_KEY to the platform-dev web API key.");
  process.exit(1);
}

if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
const fdb = admin.firestore();

const client = initializeApp(
  { apiKey: API_KEY, authDomain: `${PROJECT}.firebaseapp.com`, projectId: PROJECT },
  `smoke-${Date.now()}`
);
const auth = getAuth(client);
const fns = getFunctions(client);

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`); }
};

async function main() {
  const stamp = Date.now();
  const email = `smoke.vendor.${stamp}@platform-dev.test`;

  console.log(`\nAgainst LIVE ${PROJECT}\n`);

  // ── The account ───────────────────────────────────────────────────────────
  console.log("Registration");
  await createUserWithEmailAndPassword(auth, email, "SmokePass123!");

  // onUserCreate writes the profile that completeRegistration then fills in,
  // and it is a background trigger — on a real project it lands a second or two
  // after signup rather than instantly like it appears to on the emulator.
  // Calling straight through fails with "User profile not found", which is a
  // race rather than a fault. Worth knowing the app has to tolerate the same
  // gap; this waits for it explicitly so a slow trigger cannot be mistaken for
  // a broken backend.
  for (let i = 0; i < 15; i++) {
    const uid = auth.currentUser.uid;
    if ((await fdb.collection("users").doc(uid).get()).exists) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const reg = await httpsCallable(fns, "completeRegistration")({
    role: "vendor",
    firstName: "Smoke", lastName: "Test",
    phoneNumber: `+23480${String(stamp).slice(-8)}`,
    country: "Nigeria",
  });
  check("Vendor registers through the deployed callable", reg.data.success === true);

  const vendorId = reg.data.vendorId;
  check("A vendor document exists in Firestore", Boolean(vendorId), vendorId);

  // The claim is what every other callable authorises against, so a token
  // without it means everything downstream fails in a way that looks unrelated.
  await auth.currentUser.getIdToken(true);
  const token = await auth.currentUser.getIdTokenResult();
  check("Custom claims carry role=vendor and the vendorId",
    token.claims.role === "vendor" && token.claims.vendorId === vendorId,
    `role=${token.claims.role} vendorId=${token.claims.vendorId}`);

  // ── Reference data actually landed ────────────────────────────────────────
  console.log("\nSeeded reference data");
  const countries = await httpsCallable(fns, "listCountries")({});
  check("listCountries returns the seeded countries",
    Array.isArray(countries.data.countries) && countries.data.countries.length > 100,
    `${countries.data.countries?.length} countries`);

  // ── Something to sell ─────────────────────────────────────────────────────
  console.log("\nCatalogue");
  // An item needs a category — the backend refuses an uncategorised one rather
  // than filing it under a default, which is the right call for a storefront
  // customers browse by category.
  const category = await httpsCallable(fns, "createCatalogCategory")({ name: `Food ${stamp}` });
  check("Catalogue category created", category.data.success === true,
    JSON.stringify(category.data).slice(0, 120));

  const item = await httpsCallable(fns, "createCatalogItem")({
    name: "Smoke Test Jollof", description: "Proof the catalogue writes.",
    basePrice: 850000, currency: "NGN", isAvailable: true,
    categoryId: category.data.categoryId ?? category.data.id,
  });
  check("Catalogue item created", item.data.success === true, JSON.stringify(item.data).slice(0, 120));

  // ── The money path ────────────────────────────────────────────────────────
  console.log("\nInvoice and payment");
  const before = (await httpsCallable(fns, "getVendorRevenue")({})).data;

  const invoice = await httpsCallable(fns, "createInvoice")({
    customerName: "Smoke Customer",
    lineItems: [{ description: "Smoke Test Jollof", quantity: 2, unitPrice: 850000 }],
    currency: "NGN",
  });
  check("Invoice created", invoice.data.success === true, JSON.stringify(invoice.data).slice(0, 120));

  const invoiceId = invoice.data.invoiceId;

  await httpsCallable(fns, "recordPayment")({
    invoiceId, amountMinorUnits: 1700000, method: "transfer",
    idempotencyKey: `smoke_${stamp}`,
  });

  const after = (await httpsCallable(fns, "getVendorRevenue")({})).data;
  const moved = after.totalMinorUnits - before.totalMinorUnits;
  check("Revenue moves by exactly the amount paid, counted once",
    moved === 1700000, `moved ${moved}, expected 1700000`);

  const invDoc = (await fdb.collection("invoices").doc(invoiceId).get()).data();
  check("Invoice derives status 'paid' from the ledger",
    invDoc.status === "paid", invDoc.status);
  check("Invoice balance is zero", invDoc.balanceMinorUnits === 0, invDoc.balanceMinorUnits);

  // A retry must not double-count. This is the failure the ledger exists to
  // prevent, so it is worth proving on real infrastructure and not only locally.
  await httpsCallable(fns, "recordPayment")({
    invoiceId, amountMinorUnits: 1700000, method: "transfer",
    idempotencyKey: `smoke_${stamp}`,
  });
  const afterRetry = (await httpsCallable(fns, "getVendorRevenue")({})).data;
  check("Replaying the same payment does not double-count",
    afterRetry.totalMinorUnits === after.totalMinorUnits,
    `${afterRetry.totalMinorUnits} vs ${after.totalMinorUnits}`);

  // ── Phase 6, the reason any of this was rebuilt ───────────────────────────
  console.log("\nDashboard insights");
  const insights = (await httpsCallable(fns, "getDashboardInsights")({})).data;

  // The old build hardcoded 3 here for every vendor alive. One order from one
  // person must read as one.
  check("newCustomersThisWeek reflects real orders, not the old hardcoded 3",
    insights.newCustomersThisWeek === null || insights.newCustomersThisWeek <= 1,
    `got ${insights.newCustomersThisWeek}`);
  check("avgResponseMinutes is null rather than the old hardcoded 8",
    insights.avgResponseMinutes === null, `got ${insights.avgResponseMinutes}`);
  check("Plan gating flags are returned for the client to use",
    typeof insights.canViewRevenueCard === "boolean",
    `canViewRevenueCard=${insights.canViewRevenueCard}`);

  console.log(`\n${fail === 0 ? "SMOKE TEST PASSED" : `${fail} FAILURE(S)`}  (${pass} passed)`);
  console.log(`Test vendor: ${email}  /  SmokePass123!`);
  console.log(`Vendor id:   ${vendorId}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nFATAL:", e.message);
  process.exit(1);
});
