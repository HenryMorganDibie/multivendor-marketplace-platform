/**
 * Phase 5/6 acceptance: Business Insights and the dashboard insight engine.
 *
 * Checks two things the client actually asked about, against the real
 * callables and real stored data rather than a screen:
 *
 *   1. A vendor with nothing recorded gets absence (null/zero/dataPending),
 *      never an invented number. Specifically re-verifies the three exact
 *      historical defects named in remaining-work.md do not reappear:
 *      newCustomersThisWeek: 3, lowStockCount: 2, avgResponseMinutes: 8 were
 *      all hardcoded at the call site before Phase 1; this asserts the live
 *      values for a fresh vendor are null, and that a vendor WITH real data
 *      produces figures that differ from those exact old constants (so a
 *      regression back to the hardcoded path would be caught, not hidden
 *      behind a coincidental match).
 *   2. getVendorDashboard / getBusinessAnalytics / getDashboardInsights
 *      compute strictly from the calling vendor's own orders and catalogue —
 *      a second vendor's order, created in the same run with a deliberately
 *      distinctive total, must never surface in the first vendor's numbers.
 *
 * Read against the current source (functions/src/vendors/dashboardAnalytics.ts,
 * dashboardInsights.ts) before writing any assertion here — the field shapes
 * asserted below are what the code actually returns today, not what an
 * earlier spec doc described.
 *
 * Run:  node phase5-6-insights-tests.js   (with the emulator running; needs
 *       seedSubscriptionPlans to have run at least once in this emulator
 *       session — seed-demo-vendor.js does this as a side effect — otherwise
 *       plan limits fall back to DEFAULT_PLAN_LIMITS, which is fine too)
 */
process.env.GCLOUD_PROJECT = "demo-platform";
process.env.GOOGLE_CLOUD_PROJECT = "demo-platform";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const admin = require("firebase-admin");
const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, connectAuthEmulator } = require("firebase/auth");
const { getFunctions, httpsCallable, connectFunctionsEmulator } = require("firebase/functions");

if (!admin.apps.length) admin.initializeApp({ projectId: "demo-platform" });
const fdb = admin.firestore();
const { Timestamp, FieldValue } = admin.firestore;

const app = initializeApp({ apiKey: "demo", projectId: "demo-platform" }, `p56-${Date.now()}`);
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(app);
connectFunctionsEmulator(fns, "127.0.0.1", 5001);

let pass = 0, fail = 0;
const check = (n, label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${n}. ${label}`); }
  else { fail++; console.log(`FAIL  ${n}. ${label}${detail !== undefined ? `  (${detail})` : ""}`); }
};
const key = () => `k_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

async function registerVendor(label) {
  const email = `phase56.${label}.${Date.now()}@platform.test`;
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
  return { email, vendorId: reg.data.vendorId };
}

/** Grants a vendor an active Pro subscription without going through the
 * checkout/webhook flow — that flow is exercised elsewhere (Milestone 4 /
 * seed-demo-vendor.js); here Pro is only a fixture so the plan-gated
 * callables (getBusinessAnalytics, the bestSeller/revenueCard widgets) can
 * actually be reached. */
async function grantProPlan(vendorId) {
  await fdb.collection("vendorSubscriptions").doc(vendorId).set({
    vendorId, provider: "manual_admin_override",
    providerSubscriptionId: "test_fixture", providerCustomerId: "test_fixture", providerPlanId: "pro",
    plan: "pro", status: "active", currency: "NGN", amountPaid: 2500000,
    billingInterval: "monthly",
    currentPeriodStart: Timestamp.now(),
    currentPeriodEnd: Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000),
    cancelAtPeriodEnd: false,
    lastEventType: "test_fixture", lastEventAt: Timestamp.now(), lastEventSequence: 1, lastEventPriority: 1,
    version: 1, createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
  });
}

async function main() {
  // ═══════════════════════════════════════════════════════════════════════
  // Section A — a brand-new vendor: zero orders, zero catalogue.
  // Everything must read as absence, never an invented figure.
  // ═══════════════════════════════════════════════════════════════════════
  const vendorC = await registerVendor("c");

  const insightsC = (await httpsCallable(fns, "getDashboardInsights")({})).data;
  check(1, "Fresh vendor: getDashboardInsights succeeds", insightsC.success === true, JSON.stringify(insightsC));
  check(2, "Fresh vendor: pendingPaymentCount is 0, not absent or invented",
    insightsC.pendingPaymentCount === 0, insightsC.pendingPaymentCount);
  check(3, "Fresh vendor: newCustomersThisWeek is null (the old hardcoded value was the literal number 3)",
    insightsC.newCustomersThisWeek === null, insightsC.newCustomersThisWeek);
  check(4, "Fresh vendor: lowStockCount is null (the old hardcoded value was the literal number 2)",
    insightsC.lowStockCount === null, insightsC.lowStockCount);
  check(5, "Fresh vendor: outOfStockCount is null", insightsC.outOfStockCount === null, insightsC.outOfStockCount);
  check(6, "Fresh vendor: bestSellerName/bestSellerCount are null, not a demo product",
    insightsC.bestSellerName === null && insightsC.bestSellerCount === null,
    JSON.stringify({ name: insightsC.bestSellerName, count: insightsC.bestSellerCount }));
  check(7, "Fresh vendor: avgResponseMinutes is null (the old hardcoded value was the literal number 8)",
    insightsC.avgResponseMinutes === null, insightsC.avgResponseMinutes);

  const dashC = (await httpsCallable(fns, "getVendorDashboard")({})).data;
  check(8, "Fresh vendor: getVendorDashboard reads zero orders and zero revenue, not another vendor's",
    dashC.ordersToday === 0 && dashC.pendingOrders === 0 && dashC.todayRevenue === 0 &&
    dashC.totalRevenue === 0 && dashC.outstandingRevenue === 0 && dashC.upcomingOrders === 0,
    JSON.stringify(dashC));
  check(9, "Fresh vendor: Basic plan does not receive the bestSeller/revenueCard widgets at all",
    dashC.bestSeller === undefined && dashC.revenueCard === undefined,
    JSON.stringify({ bestSeller: dashC.bestSeller, revenueCard: dashC.revenueCard }));

  let analyticsDenied = null;
  try { await httpsCallable(fns, "getBusinessAnalytics")({}); } catch (e) { analyticsDenied = e; }
  check(10, "Fresh (Basic-plan) vendor: getBusinessAnalytics is refused outright, not answered with empty data",
    analyticsDenied !== null && analyticsDenied.code?.includes("permission-denied"),
    analyticsDenied?.message ?? "the call was allowed");

  // ═══════════════════════════════════════════════════════════════════════
  // Section B — an active vendor (Pro plan, real orders and catalogue) and
  // a second, unrelated vendor whose data must never leak into the first's.
  // ═══════════════════════════════════════════════════════════════════════
  const vendorD = await registerVendor("d");
  const vendorE = await registerVendor("e");
  await grantProPlan(vendorD.vendorId);

  const now = Timestamp.now();

  // Vendor D: two completed internal orders (two distinct customers) and one
  // accepted-but-unpaid internal order reusing the first customer, so
  // distinct customers stays at 2 — deliberately not 3, the old hardcoded
  // newCustomersThisWeek value, so a coincidental match can't be mistaken
  // for a real computation.
  const orderD1 = fdb.collection("orders").doc();
  await orderD1.set({
    orderId: orderD1.id, vendorId: vendorD.vendorId, customerId: "custD1", orderSource: "internal",
    status: "completed", paymentStatus: "PAID", fulfillmentType: "pickup",
    items: [{ itemId: "iD1", name: "Widget A", quantity: 2, price_at_order: 5000 }],
    orderSnapshot: { subtotal: 10000, tax: 0, discount: 0, total: 10000, currency: "NGN" },
    createdAt: now,
  });
  const orderD2 = fdb.collection("orders").doc();
  await orderD2.set({
    orderId: orderD2.id, vendorId: vendorD.vendorId, customerId: "custD2", orderSource: "internal",
    status: "completed", paymentStatus: "PAID", fulfillmentType: "pickup",
    items: [{ itemId: "iD2", name: "Widget B", quantity: 1, price_at_order: 7000 }],
    orderSnapshot: { subtotal: 7000, tax: 0, discount: 0, total: 7000, currency: "NGN" },
    createdAt: now,
  });
  const orderD3 = fdb.collection("orders").doc();
  await orderD3.set({
    orderId: orderD3.id, vendorId: vendorD.vendorId, customerId: "custD1", orderSource: "internal",
    status: "accepted", paymentStatus: "UNPAID", fulfillmentType: "pickup",
    items: [{ itemId: "iD1", name: "Widget A", quantity: 1, price_at_order: 5000 }],
    orderSnapshot: { subtotal: 5000, tax: 0, discount: 0, total: 5000, currency: "NGN" },
    createdAt: now,
  });

  // Vendor D's catalogue: one low-stock item (not 2, the old hardcoded
  // lowStockCount value), one out-of-stock item, one item with a real
  // orderCount so bestSeller has something honest to report.
  const itemsD = fdb.collection("vendors").doc(vendorD.vendorId).collection("catalogItems");
  await itemsD.doc("itemLow").set({
    itemId: "itemLow", vendorId: vendorD.vendorId, name: "Low Stock Item", basePrice: 1000, currency: "NGN",
    isAvailable: true, isHidden: false, moderationStatus: "approved",
    trackInventory: true, inventoryQuantity: 3, lowStockThreshold: 5, orderCount: 0,
  });
  await itemsD.doc("itemOut").set({
    itemId: "itemOut", vendorId: vendorD.vendorId, name: "Out Of Stock Item", basePrice: 1000, currency: "NGN",
    isAvailable: true, isHidden: false, moderationStatus: "approved",
    trackInventory: true, inventoryQuantity: 0, lowStockThreshold: 5, orderCount: 0,
  });
  await itemsD.doc("itemPopular").set({
    itemId: "itemPopular", vendorId: vendorD.vendorId, name: "Popular Thing", basePrice: 1000, currency: "NGN",
    isAvailable: true, isHidden: false, moderationStatus: "approved",
    trackInventory: false, orderCount: 5,
  });

  // Vendor E: a large, distinctive, unrelated order and catalogue item that
  // must never appear anywhere in vendor D's figures.
  const orderE1 = fdb.collection("orders").doc();
  await orderE1.set({
    orderId: orderE1.id, vendorId: vendorE.vendorId, customerId: "custE_should_never_appear", orderSource: "internal",
    status: "completed", paymentStatus: "PAID", fulfillmentType: "pickup",
    items: [{ itemId: "iE1", name: "Vendor E Only Item", quantity: 1, price_at_order: 999999 }],
    orderSnapshot: { subtotal: 999999, tax: 0, discount: 0, total: 999999, currency: "NGN" },
    createdAt: now,
  });
  await fdb.collection("vendors").doc(vendorE.vendorId).collection("catalogItems").doc("itemE").set({
    itemId: "itemE", vendorId: vendorE.vendorId, name: "Vendor E Only Item", basePrice: 999999, currency: "NGN",
    isAvailable: true, isHidden: false, moderationStatus: "approved",
    trackInventory: true, inventoryQuantity: 1, lowStockThreshold: 5, orderCount: 999,
  });

  await signInWithEmailAndPassword(auth, vendorD.email, "DemoPass123!");
  await auth.currentUser.getIdToken(true);

  // ── getDashboardInsights: real figures for vendor D, and none of vendor
  //    E's data leaking in ─────────────────────────────────────────────────
  const insightsD = (await httpsCallable(fns, "getDashboardInsights")({})).data;
  check(11, "Active vendor: pendingPaymentCount counts the one accepted-unpaid internal order",
    insightsD.pendingPaymentCount === 1, insightsD.pendingPaymentCount);
  check(12, "Active vendor: newCustomersThisWeek is 2 (distinct customers), not the old hardcoded 3",
    insightsD.newCustomersThisWeek === 2, insightsD.newCustomersThisWeek);
  check(13, "Active vendor: lowStockCount is 1 (one item under its threshold), not the old hardcoded 2",
    insightsD.lowStockCount === 1, insightsD.lowStockCount);
  check(14, "Active vendor: outOfStockCount is 1, and vendor E's item is not counted",
    insightsD.outOfStockCount === 1, insightsD.outOfStockCount);
  check(15, "Active vendor: bestSeller is this vendor's own item by real orderCount, not vendor E's",
    insightsD.bestSellerName === "Popular Thing" && insightsD.bestSellerCount === 5,
    JSON.stringify({ name: insightsD.bestSellerName, count: insightsD.bestSellerCount }));
  check(16, "Active vendor: avgResponseMinutes is still honestly null, not restored to the old hardcoded 8",
    insightsD.avgResponseMinutes === null, insightsD.avgResponseMinutes);

  // ── getVendorDashboard: order counts, and the ledger-backed revenue on
  //    this specific endpoint, isolated to vendor D ───────────────────────
  const dashD1 = (await httpsCallable(fns, "getVendorDashboard")({})).data;
  check(17, "Active vendor: ordersToday counts exactly this vendor's 3 orders, not vendor E's 4th",
    dashD1.ordersToday === 3, dashD1.ordersToday);
  check(18, "Active vendor: pendingOrders/upcomingOrders count only the one accepted order",
    dashD1.pendingOrders === 1 && dashD1.upcomingOrders === 1,
    JSON.stringify({ pendingOrders: dashD1.pendingOrders, upcomingOrders: dashD1.upcomingOrders }));
  check(19, "Active (Pro) vendor: bestSeller widget reflects this vendor's completed-order items only",
    dashD1.bestSeller?.itemId === "iD1" && dashD1.bestSeller?.quantitySold === 2,
    JSON.stringify(dashD1.bestSeller));
  check(20, "Active (Pro) vendor: revenueCard totals only this vendor's two completed orders (17,000), not vendor E's 999,999",
    dashD1.revenueCard?.total === 17000 && dashD1.revenueCard?.orderCount === 2,
    JSON.stringify(dashD1.revenueCard));

  // Revenue on THIS endpoint is ledger-backed too (dashboardAnalytics.ts has
  // its own sumLedger read, separate from getVendorRevenue) — proven the same
  // way Phase 3 proves it: by delta, so it cannot pass by coincidence.
  const invD = await httpsCallable(fns, "createInvoice")({
    customerName: "Dashboard Revenue Check", lineItems: [{ description: "Item", quantity: 1, unitPrice: 12345 }],
  });
  await httpsCallable(fns, "recordPayment")({
    invoiceId: invD.data.invoiceId, amountMinorUnits: 12345, method: "cash", idempotencyKey: key(),
  });
  const dashD2 = (await httpsCallable(fns, "getVendorDashboard")({})).data;
  check(21, "getVendorDashboard's todayRevenue moves by exactly the payment just recorded, reading the ledger not the orders",
    dashD2.todayRevenue - dashD1.todayRevenue === 12345, dashD2.todayRevenue - dashD1.todayRevenue);

  // ── getBusinessAnalytics: figures derived from vendor D's own data ───────
  const analyticsD = (await httpsCallable(fns, "getBusinessAnalytics")({})).data;
  check(22, "getBusinessAnalytics succeeds for a Pro-plan vendor with real data", analyticsD.success === true, JSON.stringify(analyticsD));

  const todayKey = new Date().toISOString().slice(0, 10);
  const todayTrend = analyticsD.revenueTrend?.find((r) => r.date === todayKey);
  check(23, "revenueTrend for today sums only vendor D's two completed orders (17,000), not vendor E's 999,999",
    todayTrend?.total === 17000, JSON.stringify(analyticsD.revenueTrend));

  const customerIds = (analyticsD.topCustomers ?? []).map((c) => c.customerId);
  check(24, "topCustomers never contains vendor E's customer",
    !customerIds.includes("custE_should_never_appear"), JSON.stringify(analyticsD.topCustomers));
  check(25, "topCustomers matches vendor D's real per-customer totals exactly",
    analyticsD.topCustomers?.length === 2 &&
    analyticsD.topCustomers.some((c) => c.customerId === "custD1" && c.total === 10000) &&
    analyticsD.topCustomers.some((c) => c.customerId === "custD2" && c.total === 7000),
    JSON.stringify(analyticsD.topCustomers));

  check(26, "ordersBySource counts exactly vendor D's 3 internal orders, not vendor E's",
    analyticsD.ordersBySource?.internal === 3 && analyticsD.ordersBySource?.external === 0,
    JSON.stringify(analyticsD.ordersBySource));

  check(27, "repeatCustomerAnalytics is computed (not dataPending) with the right distinct/repeat counts",
    analyticsD.repeatCustomerAnalytics?.dataPending === undefined &&
    analyticsD.repeatCustomerAnalytics?.distinctCustomers === 2 &&
    analyticsD.repeatCustomerAnalytics?.repeatCustomers === 0,
    JSON.stringify(analyticsD.repeatCustomerAnalytics));

  check(28, "customerGrowth is computed (not dataPending) and counts vendor D's 2 distinct customers",
    analyticsD.customerGrowth?.dataPending === undefined && analyticsD.customerGrowth?.totalCustomers === 2,
    JSON.stringify(analyticsD.customerGrowth));

  check(29, "conversionFunnel/storefrontPerformance/customerSourceBreakdown stay honestly dataPending — nothing tracks storefront visits yet",
    analyticsD.conversionFunnel?.dataPending === true &&
    analyticsD.storefrontPerformance?.dataPending === true &&
    analyticsD.customerSourceBreakdown?.dataPending === true,
    JSON.stringify({
      conversionFunnel: analyticsD.conversionFunnel,
      storefrontPerformance: analyticsD.storefrontPerformance,
      customerSourceBreakdown: analyticsD.customerSourceBreakdown,
    }));

  console.log(`\n${fail === 0 ? "ALL PHASE 5/6 INSIGHTS TESTS PASSED" : `${fail} FAILURE(S)`}  (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
