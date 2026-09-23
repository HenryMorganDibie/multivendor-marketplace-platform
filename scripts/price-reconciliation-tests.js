/**
 * Detecting a stale provider plan.
 *
 * The client's scenario: Canada Pro is raised to CA$79.99 in pricing.json, but
 * the mapped Stripe plan still charges CA$64.99. A new subscriber checks out.
 * The app displays one amount and the card is charged another, every month,
 * with nothing to notice it.
 *
 * Verifying the mapping before charging needs the provider APIs and real
 * credentials. This is the detective half: every activation and renewal already
 * reports what was charged, so comparing it against the approved price turns a
 * silent, indefinite discrepancy into a flagged record.
 *
 * Run:  node price-reconciliation-tests.js   (with the emulator running)
 */
process.env.GCLOUD_PROJECT = "demo-platform";
process.env.GOOGLE_CLOUD_PROJECT = "demo-platform";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: "demo-platform" });
const fdb = admin.firestore();

let pass = 0, fail = 0;
const check = (n, label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${n}. ${label}`); }
  else { fail++; console.log(`FAIL  ${n}. ${label}${detail ? `  (${detail})` : ""}`); }
};

const { reconcileChargeAgainstApprovedPrice } = require("../functions/lib/subscriptions/priceReconciliation");

const CC = "CA";
const VENDOR = `recon_vendor_${Date.now()}`;

// CA$79.99 approved, CA$64.99 actually charged — the client's example exactly.
const APPROVED_MINOR = 7999;
const STALE_MINOR = 6499;

async function discrepancyFor(plan) {
  return (await fdb.collection("pricingDiscrepancies").doc(`${VENDOR}_${plan}`).get()).data();
}

async function main() {
  await fdb.collection("vendors").doc(VENDOR).set({
    vendorId: VENDOR, countryCode: CC, businessName: "Reconciliation Test",
  });

  await fdb.collection("subscriptionPricing").doc(CC).set({
    countryCode: CC,
    currencyCode: "CAD",
    plans: {
      standard: { monthlyPriceMinorUnits: 3999 },
      pro: { monthlyPriceMinorUnits: APPROVED_MINOR },
      pro_plus: { monthlyPriceMinorUnits: 11999 },
    },
    status: "active",
  });

  // ── 1. A correct charge is not flagged ────────────────────────────────────
  await reconcileChargeAgainstApprovedPrice({
    vendorId: VENDOR, plan: "pro",
    chargedMinorUnits: APPROVED_MINOR, chargedCurrency: "CAD",
    provider: "stripe", providerPlanId: "price_correct",
  });
  check(1, "A charge matching the approved price raises nothing",
    !(await discrepancyFor("pro")), "a correct charge was flagged");

  // ── 2. The stale plan is caught ───────────────────────────────────────────
  await reconcileChargeAgainstApprovedPrice({
    vendorId: VENDOR, plan: "pro",
    chargedMinorUnits: STALE_MINOR, chargedCurrency: "CAD",
    provider: "stripe", providerPlanId: "price_stale_6499",
  });

  const flagged = await discrepancyFor("pro");
  check(2, "A stale provider plan charging less than the approved price is flagged",
    Boolean(flagged), "no discrepancy recorded");
  check(3, "The record states both amounts",
    flagged?.chargedMinorUnits === STALE_MINOR && flagged?.expectedMinorUnits === APPROVED_MINOR,
    `charged=${flagged?.chargedMinorUnits} expected=${flagged?.expectedMinorUnits}`);
  check(4, "The shortfall is recorded, so the cost is visible without arithmetic",
    flagged?.differenceMinorUnits === STALE_MINOR - APPROVED_MINOR,
    `difference=${flagged?.differenceMinorUnits}`);
  check(5, "It names the provider plan, so the stale mapping can be found",
    flagged?.providerPlanId === "price_stale_6499", flagged?.providerPlanId);

  // ── 3. Repeats accumulate rather than pile up ─────────────────────────────
  // A stale mapping charges wrongly every month. One record per vendor and plan
  // keeps twenty distinct problems visible instead of burying them under a
  // hundred identical rows.
  await reconcileChargeAgainstApprovedPrice({
    vendorId: VENDOR, plan: "pro",
    chargedMinorUnits: STALE_MINOR, chargedCurrency: "CAD",
    provider: "stripe", providerPlanId: "price_stale_6499",
  });
  const repeated = await discrepancyFor("pro");
  check(6, "A recurring wrong charge increments the same record",
    repeated?.occurrences === 2, `occurrences=${repeated?.occurrences}`);

  const all = await fdb.collection("pricingDiscrepancies").where("vendorId", "==", VENDOR).get();
  check(7, "It stays one record per vendor and plan", all.size === 1, `${all.size} records`);

  // ── 4. A wrong currency is caught too ─────────────────────────────────────
  await reconcileChargeAgainstApprovedPrice({
    vendorId: VENDOR, plan: "standard",
    chargedMinorUnits: 3999, chargedCurrency: "USD",
    provider: "stripe", providerPlanId: "price_wrong_currency",
  });
  const currencyFlag = await discrepancyFor("standard");
  check(8, "Charging the right number in the wrong currency is flagged",
    currencyFlag?.reason === "CURRENCY_MISMATCH", currencyFlag?.reason ?? "not flagged");

  // ── 5. Case differences are not a discrepancy ─────────────────────────────
  await reconcileChargeAgainstApprovedPrice({
    vendorId: VENDOR, plan: "pro_plus",
    chargedMinorUnits: 11999, chargedCurrency: "cad",
    provider: "paystack", providerPlanId: "PLN_lowercase",
  });
  check(9, "A lowercase currency code is not treated as a mismatch",
    !(await discrepancyFor("pro_plus")), "case difference was flagged");

  // ── 6. A charge where nothing was ever approved ───────────────────────────
  const orphanVendor = `recon_orphan_${Date.now()}`;
  await fdb.collection("vendors").doc(orphanVendor).set({
    vendorId: orphanVendor, countryCode: "ZW", businessName: "Unpriced Country",
  });
  await reconcileChargeAgainstApprovedPrice({
    vendorId: orphanVendor, plan: "pro",
    chargedMinorUnits: 5000, chargedCurrency: "USD",
    provider: "stripe", providerPlanId: "price_unpriced",
  });
  const orphanFlag = (await fdb.collection("pricingDiscrepancies").doc(`${orphanVendor}_pro`).get()).data();
  check(10, "A charge in a country with no approved price is flagged",
    orphanFlag?.reason === "NO_APPROVED_PRICE", orphanFlag?.reason ?? "not flagged");

  // ── 7. The record is written where an admin can find it ───────────────────
  const audit = await fdb.collection("auditLogs")
    .where("eventType", "==", "subscription.price_mismatch").limit(1).get();
  check(11, "A mismatch is written to the audit trail", !audit.empty);

  await fdb.collection("vendors").doc(VENDOR).delete();
  await fdb.collection("vendors").doc(orphanVendor).delete();
  await fdb.collection("subscriptionPricing").doc(CC).delete();
  for (const d of (await fdb.collection("pricingDiscrepancies").get()).docs) {
    if (d.id.startsWith("recon_")) await d.ref.delete();
  }

  console.log(`\n${fail === 0 ? "ALL PRICE RECONCILIATION TESTS PASSED" : `${fail} FAILURE(S)`}  (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
