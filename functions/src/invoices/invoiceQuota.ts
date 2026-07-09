import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { InvoiceMonthlyCounterDoc } from "../types4";

/** UTC calendar month boundary, explicitly not the vendor's local timezone
 * — PHASE_4_COLLECTION_MAPPING v10 Section 10 calls this out specifically
 * to remove ambiguity in the counter reset logic. */
function currentMonthKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * consumeInvoiceQuota — atomically checks the vendor's current-month
 * invoice count against their plan's invoicesPerMonth limit and, if under
 * it, increments the counter. Throws resource-exhausted otherwise. A
 * monthly counter sub-document rather than a collection scan, for
 * performance at scale (Section 10, "Invoice creation limit reached").
 */
export async function consumeInvoiceQuota(vendorId: string, invoicesPerMonth: number): Promise<void> {
  const monthKey = currentMonthKey();
  const counterRef = db.collection("vendors").doc(vendorId).collection("invoiceCounters").doc(monthKey);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const current = snap.exists ? (snap.data() as InvoiceMonthlyCounterDoc).count : 0;
    if (current >= invoicesPerMonth) {
      throw new https.HttpsError(
        "resource-exhausted",
        `Your plan allows up to ${invoicesPerMonth} invoices per month. You have reached that limit for this month.`
      );
    }
    const doc: InvoiceMonthlyCounterDoc = { vendorId, monthKey, count: current + 1, updatedAt: FieldValue.serverTimestamp() };
    tx.set(counterRef, doc, { merge: true });
  });
}
