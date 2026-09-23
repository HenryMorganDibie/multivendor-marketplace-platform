/**
 * One-time migration: give every already-paid invoice a ledger row.
 *
 * Invoices marked paid before the ledger existed have no payments behind them.
 * Revenue now sums the ledger, so without this every historical figure would
 * read zero on the day this ships — a vendor opening the app would see a year
 * of trading vanish.
 *
 * Writes one payment per paid invoice: the invoice total, dated when it was
 * marked paid, recorded as system rather than as the vendor, since nobody
 * actually pressed a button for it. The reference says plainly that it was
 * migrated, so it is never mistaken for a payment somebody recorded.
 *
 * Rerun-safe. The document id is derived from the invoice, so running it twice
 * writes the same row rather than a second one.
 *
 *   node migrate-invoices-to-ledger.js            # emulator, dry run
 *   node migrate-invoices-to-ledger.js --apply    # emulator, writes
 *   node migrate-invoices-to-ledger.js --apply --live --project platform-staging
 */
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const LIVE = args.includes("--live");
const PROJECT = (() => {
  const i = args.indexOf("--project");
  return i >= 0 ? args[i + 1] : "demo-platform";
})();

process.env.GCLOUD_PROJECT = PROJECT;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
if (!LIVE) {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
}

const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

function migratedPaymentId(invoiceId) {
  return `migrated_${invoiceId}`.replace(/[/.#$[\]]/g, "_").slice(0, 400);
}

async function main() {
  console.log(`${APPLY ? "APPLYING" : "DRY RUN"} against ${LIVE ? `LIVE ${PROJECT}` : "the emulator"}\n`);

  const invoices = await db.collection("invoices").where("status", "==", "paid").get();
  if (invoices.empty) {
    console.log("No paid invoices to migrate.");
    return;
  }

  let written = 0;
  let skipped = 0;
  let totalMinorUnits = 0;

  for (const doc of invoices.docs) {
    const invoice = doc.data();
    const paymentId = migratedPaymentId(doc.id);
    const paymentRef = db.collection("payments").doc(paymentId);

    if ((await paymentRef.get()).exists) {
      skipped += 1;
      continue;
    }

    const amount = invoice.subtotal ?? 0;
    if (!amount) {
      console.log(`  skipping ${invoice.invoiceNumber ?? doc.id}: no amount`);
      skipped += 1;
      continue;
    }

    totalMinorUnits += amount;
    console.log(`  ${invoice.invoiceNumber ?? doc.id}  ${amount} ${invoice.currency ?? "NGN"}`);

    if (!APPLY) continue;

    await paymentRef.set({
      paymentId,
      vendorId: invoice.vendorId,
      customerId: invoice.customerId ?? null,
      amountMinorUnits: amount,
      currency: invoice.currency ?? "NGN",
      orderId: invoice.orderId ?? null,
      invoiceId: doc.id,
      method: "other",
      reference: "Migrated from an invoice marked paid before the ledger existed",
      recordedBy: "system",
      recordedByRole: "system",
      type: "payment",
      reversesPaymentId: null,
      reversalReason: null,
      status: "recorded",
      idempotencyKey: paymentId,
      // Dated when the invoice was actually settled, so historical revenue
      // lands in the period it belongs to rather than all on migration day.
      paidAt: invoice.paidAt ?? invoice.createdAt ?? admin.firestore.Timestamp.now(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await doc.ref.update({
      amountPaidMinorUnits: amount,
      balanceMinorUnits: 0,
      lastPaymentAt: invoice.paidAt ?? null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    written += 1;
  }

  console.log(
    `\n${APPLY ? "Wrote" : "Would write"} ${APPLY ? written : invoices.size - skipped} row(s), ` +
    `skipped ${skipped}, total ${totalMinorUnits} minor units.`
  );
  if (!APPLY) console.log("Nothing was written. Re-run with --apply.");
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
