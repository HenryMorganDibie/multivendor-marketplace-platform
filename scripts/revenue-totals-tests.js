/**
 * The maintained revenue total.
 *
 * getVendorRevenue used to sum every payment row a vendor had ever received on
 * each call. It now reads a figure the ledger writers keep up to date, so these
 * check the thing that actually matters about a cache: that it still agrees
 * with the rows it caches, under retries and reversals.
 *
 * Run:  node revenue-totals-tests.js   (with the emulator running)
 */
process.env.GCLOUD_PROJECT = "demo-platform";
process.env.GOOGLE_CLOUD_PROJECT = "demo-platform";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const admin = require("firebase-admin");
const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword, connectAuthEmulator } = require("firebase/auth");
const { getFunctions, httpsCallable, connectFunctionsEmulator } = require("firebase/functions");

if (!admin.apps.length) admin.initializeApp({ projectId: "demo-platform" });
const fdb = admin.firestore();

const client = initializeApp({ apiKey: "demo", projectId: "demo-platform" }, `rev-${Date.now()}`);
const auth = getAuth(client);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(client);
connectFunctionsEmulator(fns, "127.0.0.1", 5001);

let pass = 0, fail = 0;
const check = (n, label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${n}. ${label}`); }
  else { fail++; console.log(`FAIL  ${n}. ${label}${detail ? `  (${detail})` : ""}`); }
};
const key = () => `rk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

async function storedTotal(vendorId) {
  return (await fdb.collection("vendors").doc(vendorId).get()).data()?.revenueTotalMinorUnits;
}

async function rowsTotal(vendorId) {
  const snap = await fdb.collection("payments").where("vendorId", "==", vendorId).get();
  return snap.docs.reduce((sum, d) => {
    const a = d.data().amountMinorUnits ?? 0;
    return d.data().type === "reversal" ? sum - a : sum + a;
  }, 0);
}

async function makeInvoice(vendorId, amount) {
  const ref = fdb.collection("invoices").doc();
  await ref.set({
    invoiceId: ref.id, invoiceNumber: `RT-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    vendorId, customerName: "Total Test", lineItems: [{ description: "x", quantity: 1, unitPrice: amount }],
    subtotal: amount, currency: "NGN", status: "unpaid",
    hiddenFromHistory: false, shareToken: `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: admin.firestore.Timestamp.now(),
  });
  return ref;
}

async function main() {
  await signInWithEmailAndPassword(auth, "demo.vendor@example.com", "DemoPass123!");
  const token = await auth.currentUser.getIdTokenResult(true);
  const vendorId = token.claims.vendorId;

  const before = (await storedTotal(vendorId)) ?? 0;

  // ── A payment moves the total by exactly its amount ────────────────────────
  const inv1 = await makeInvoice(vendorId, 700000);
  await httpsCallable(fns, "recordPayment")({
    invoiceId: inv1.id, amountMinorUnits: 700000, method: "cash", idempotencyKey: key(),
  });
  check(1, "A payment moves the stored total by its amount",
    (await storedTotal(vendorId)) === before + 700000,
    `${await storedTotal(vendorId)} vs ${before + 700000}`);

  // ── A retry must not move it again ─────────────────────────────────────────
  const sharedKey = key();
  const inv2 = await makeInvoice(vendorId, 300000);
  await httpsCallable(fns, "recordPayment")({
    invoiceId: inv2.id, amountMinorUnits: 300000, method: "cash", idempotencyKey: sharedKey,
  });
  const afterFirst = await storedTotal(vendorId);
  await httpsCallable(fns, "recordPayment")({
    invoiceId: inv2.id, amountMinorUnits: 300000, method: "cash", idempotencyKey: sharedKey,
  });
  check(2, "Replaying the same payment does not move the total twice",
    (await storedTotal(vendorId)) === afterFirst,
    `${await storedTotal(vendorId)} vs ${afterFirst}`);

  // ── A reversal takes it back ───────────────────────────────────────────────
  const row = (await fdb.collection("payments").where("invoiceId", "==", inv2.id).limit(1).get()).docs[0];
  const beforeReversal = await storedTotal(vendorId);
  await httpsCallable(fns, "reversePayment")({
    paymentId: row.id, reason: "test", idempotencyKey: key(),
  });
  check(3, "A reversal takes its amount back out of the total",
    (await storedTotal(vendorId)) === beforeReversal - 300000,
    `${await storedTotal(vendorId)} vs ${beforeReversal - 300000}`);

  // ── The cache still agrees with the rows ───────────────────────────────────
  check(4, "The stored total equals the sum of the rows it caches",
    (await storedTotal(vendorId)) === (await rowsTotal(vendorId)),
    `stored ${await storedTotal(vendorId)}, rows ${await rowsTotal(vendorId)}`);

  // ── getVendorRevenue reports the stored figure ─────────────────────────────
  const reported = (await httpsCallable(fns, "getVendorRevenue")({})).data;
  check(5, "getVendorRevenue reports the maintained total",
    reported.totalMinorUnits === (await storedTotal(vendorId)),
    `${reported.totalMinorUnits} vs ${await storedTotal(vendorId)}`);

  // ── A vendor with no stored figure gets one computed rather than zero ──────
  await fdb.collection("vendors").doc(vendorId).update({
    revenueTotalMinorUnits: admin.firestore.FieldValue.delete(),
  });
  const rebuilt = (await httpsCallable(fns, "getVendorRevenue")({})).data;
  check(6, "A missing total is rebuilt from the rows, not reported as zero",
    rebuilt.totalMinorUnits === (await rowsTotal(vendorId)) && rebuilt.totalMinorUnits !== 0,
    `${rebuilt.totalMinorUnits} vs ${await rowsTotal(vendorId)}`);

  check(7, "The rebuild is written back, so the next call is cheap",
    typeof (await storedTotal(vendorId)) === "number",
    `${await storedTotal(vendorId)}`);

  // ── The dashboard must agree with the ledger ──────────────────────────────
  // The regression worth pinning. getVendorDashboard summed the totals of
  // orders completed today, which is finished work rather than money received,
  // and the screen showed that alongside the ledger figure — two different
  // numbers on one dashboard, both labelled today's revenue.
  const dash = (await httpsCallable(fns, "getVendorDashboard")({})).data;
  const ledger = (await httpsCallable(fns, "getVendorRevenue")({})).data;

  check(8, "Dashboard today's revenue equals the ledger's today figure",
    dash.todayRevenue === ledger.todayMinorUnits,
    `dashboard ${dash.todayRevenue}, ledger ${ledger.todayMinorUnits}`);

  check(9, "Dashboard lifetime revenue equals the maintained total",
    dash.totalRevenue === ledger.totalMinorUnits,
    `dashboard ${dash.totalRevenue}, ledger ${ledger.totalMinorUnits}`);

  check(10, "Dashboard outstanding equals the ledger's outstanding",
    dash.outstandingRevenue === ledger.outstandingMinorUnits,
    `dashboard ${dash.outstandingRevenue}, ledger ${ledger.outstandingMinorUnits}`);

  console.log(`\n${fail === 0 ? "ALL REVENUE TOTAL TESTS PASSED" : `${fail} FAILURE(S)`}  (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
