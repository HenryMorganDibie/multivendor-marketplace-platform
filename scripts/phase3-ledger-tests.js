/**
 * Phase 3 acceptance: the payment ledger.
 *
 * Twelve checks, one per criterion the client set. The first is her exact
 * sequence: create an order, raise an invoice from that order, record one
 * payment, confirm revenue reports it once rather than twice. It asserts
 * against getVendorRevenue rather than a screen, so it cannot pass because two
 * displays happen to agree.
 *
 * Run:  node phase3-ledger-tests.js   (with the emulator running)
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

const client = initializeApp({ apiKey: "demo", projectId: "demo-platform" }, `p3-${Date.now()}`);
const auth = getAuth(client);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(client);
connectFunctionsEmulator(fns, "127.0.0.1", 5001);

let pass = 0, fail = 0;
const check = (n, label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${n}. ${label}`); }
  else { fail++; console.log(`FAIL  ${n}. ${label}${detail ? `  (${detail})` : ""}`); }
};
const key = () => `k_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

async function main() {
  await signInWithEmailAndPassword(auth, "demo.vendor@example.com", "DemoPass123!");
  const token = await auth.currentUser.getIdTokenResult(true);
  const vendorId = token.claims.vendorId;

  // A clean ledger, so totals are attributable to this run alone.
  for (const d of (await fdb.collection("payments").where("vendorId", "==", vendorId).get()).docs) {
    await d.ref.delete();
  }

  const before = (await httpsCallable(fns, "getVendorRevenue")({})).data;

  // ── 1. The double-count test, exactly as specified ────────────────────────
  const orderRef = fdb.collection("orders").doc();
  await orderRef.set({
    orderId: orderRef.id, vendorId, customerId: "cust_p3", orderSource: "internal",
    status: "completed", paymentStatus: "UNPAID", fulfillmentType: "pickup",
    items: [{ itemId: "i1", name: "Item", quantity: 1, price_at_order: 860000 }],
    orderSnapshot: { subtotal: 860000, tax: 0, discount: 0, total: 860000, currency: "NGN" },
    createdAt: admin.firestore.Timestamp.now(),
  });

  // An invoice raised from that order carries its id — this is what makes the
  // same money count once however it is recorded.
  const invoiceRef = fdb.collection("invoices").doc();
  await invoiceRef.set({
    invoiceId: invoiceRef.id, invoiceNumber: `P3-${Date.now()}`, vendorId,
    customerId: "cust_p3", customerName: "Ada Obi",
    lineItems: [{ description: "Item", quantity: 1, unitPrice: 860000 }],
    subtotal: 860000, currency: "NGN", status: "unpaid",
    orderId: orderRef.id, hiddenFromHistory: false, shareToken: `tok_${Date.now()}`,
    createdAt: admin.firestore.Timestamp.now(),
  });

  await httpsCallable(fns, "recordPayment")({
    invoiceId: invoiceRef.id, amountMinorUnits: 860000, method: "transfer", idempotencyKey: key(),
  });

  const afterOne = (await httpsCallable(fns, "getVendorRevenue")({})).data;
  const gain = afterOne.totalMinorUnits - before.totalMinorUnits;
  check(1, "One payment on an invoice raised from an order counts ONCE, not twice",
    gain === 860000, `revenue moved by ${gain}, expected 860000`);

  // ── 2. Idempotency ────────────────────────────────────────────────────────
  const sharedKey = key();
  const inv2 = fdb.collection("invoices").doc();
  await inv2.set({
    invoiceId: inv2.id, invoiceNumber: `P3B-${Date.now()}`, vendorId,
    customerName: "Retry Test", lineItems: [], subtotal: 500000, currency: "NGN",
    status: "unpaid", hiddenFromHistory: false, shareToken: `tok2_${Date.now()}`,
    createdAt: admin.firestore.Timestamp.now(),
  });

  const first = await httpsCallable(fns, "recordPayment")({
    invoiceId: inv2.id, amountMinorUnits: 500000, method: "cash", idempotencyKey: sharedKey,
  });
  const retry = await httpsCallable(fns, "recordPayment")({
    invoiceId: inv2.id, amountMinorUnits: 500000, method: "cash", idempotencyKey: sharedKey,
  });

  check(2, "The same idempotency key returns success rather than an error",
    retry.data.success === true && retry.data.alreadyRecorded === true);
  const rows2 = await fdb.collection("payments").where("invoiceId", "==", inv2.id).get();
  check(3, "A retry writes one row, not two", rows2.size === 1, `${rows2.size} rows`);

  // ── 3. Partial payment derives balance and status ─────────────────────────
  const inv3 = fdb.collection("invoices").doc();
  await inv3.set({
    invoiceId: inv3.id, invoiceNumber: `P3C-${Date.now()}`, vendorId,
    customerName: "Partial Test", lineItems: [], subtotal: 800000, currency: "NGN",
    status: "unpaid", hiddenFromHistory: false, shareToken: `tok3_${Date.now()}`,
    createdAt: admin.firestore.Timestamp.now(),
  });
  await httpsCallable(fns, "recordPayment")({
    invoiceId: inv3.id, amountMinorUnits: 300000, method: "cash", idempotencyKey: key(),
  });
  const partial = (await inv3.get()).data();
  check(4, "A partial payment derives the correct balance",
    partial.balanceMinorUnits === 500000, `balance ${partial.balanceMinorUnits}`);
  check(5, "A partial payment derives status 'partial'",
    partial.status === "partial", partial.status);

  // Paying the rest settles it.
  await httpsCallable(fns, "recordPayment")({
    invoiceId: inv3.id, amountMinorUnits: 500000, method: "cash", idempotencyKey: key(),
  });
  const settled = (await inv3.get()).data();
  check(6, "Paying the balance derives 'paid' and stamps paidAt",
    settled.status === "paid" && Boolean(settled.paidAt), `${settled.status}`);

  // ── 4. Overpayment is recorded, not refused ───────────────────────────────
  const inv4 = fdb.collection("invoices").doc();
  await inv4.set({
    invoiceId: inv4.id, invoiceNumber: `P3D-${Date.now()}`, vendorId,
    customerName: "Overpay Test", lineItems: [], subtotal: 860000, currency: "NGN",
    status: "unpaid", hiddenFromHistory: false, shareToken: `tok4_${Date.now()}`,
    createdAt: admin.firestore.Timestamp.now(),
  });
  await httpsCallable(fns, "recordPayment")({
    invoiceId: inv4.id, amountMinorUnits: 900000, method: "transfer", idempotencyKey: key(),
  });
  const over = (await inv4.get()).data();
  check(7, "An overpayment is recorded with a negative balance, not rejected",
    over.status === "overpaid" && over.balanceMinorUnits === -40000,
    `${over.status} balance ${over.balanceMinorUnits}`);

  // ── 5. Corrections are reversals, never deletions ─────────────────────────
  const paidRow = (await fdb.collection("payments").where("invoiceId", "==", inv4.id).limit(1).get()).docs[0];
  await httpsCallable(fns, "reversePayment")({
    paymentId: paidRow.id, reason: "recorded in error", idempotencyKey: key(),
  });

  check(8, "The original payment still exists after a reversal",
    (await paidRow.ref.get()).exists);
  const afterReversal = (await inv4.get()).data();
  check(9, "Reversing a payment returns the invoice to unpaid",
    afterReversal.status === "unpaid" && afterReversal.amountPaidMinorUnits === 0,
    `${afterReversal.status} paid ${afterReversal.amountPaidMinorUnits}`);

  // A reversal larger than what remains is refused.
  let tooMuch = null;
  try {
    await httpsCallable(fns, "reversePayment")({
      paymentId: paidRow.id, amountMinorUnits: 999999, reason: "too much", idempotencyKey: key(),
    });
  } catch (e) { tooMuch = e.code; }
  check(10, "A reversal larger than the remaining amount is refused",
    Boolean(tooMuch?.includes("failed-precondition")), tooMuch ?? "it was allowed");

  // ── 6. 'paid' can no longer be set by hand ────────────────────────────────
  let setPaid = null;
  try {
    await httpsCallable(fns, "updateInvoiceStatus")({ invoiceId: inv3.id, status: "paid" });
  } catch (e) { setPaid = e.code; }
  check(11, "updateInvoiceStatus refuses 'paid'",
    Boolean(setPaid?.includes("invalid-argument")), setPaid ?? "it was allowed");

  // ── 7. Another vendor's invoice is untouchable ────────────────────────────
  const foreign = fdb.collection("invoices").doc();
  await foreign.set({
    invoiceId: foreign.id, invoiceNumber: `FOREIGN-${Date.now()}`, vendorId: "some_other_vendor",
    customerName: "Not Yours", lineItems: [], subtotal: 100000, currency: "NGN",
    status: "unpaid", hiddenFromHistory: false, shareToken: `tokf_${Date.now()}`,
    createdAt: admin.firestore.Timestamp.now(),
  });
  let foreignDenied = null;
  try {
    await httpsCallable(fns, "recordPayment")({
      invoiceId: foreign.id, amountMinorUnits: 100000, method: "cash", idempotencyKey: key(),
    });
  } catch (e) { foreignDenied = e.code; }
  check(12, "A vendor cannot record a payment on another vendor's invoice",
    Boolean(foreignDenied?.includes("permission-denied")), foreignDenied ?? "it was allowed");

  await foreign.delete();

  console.log(`\n${fail === 0 ? "ALL PHASE 3 LEDGER TESTS PASSED" : `${fail} FAILURE(S)`}  (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
