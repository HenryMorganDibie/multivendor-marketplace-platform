import { https } from "firebase-functions/v2";
import { db, Timestamp } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { readVendorRevenueTotal } from "./vendorRevenueTotals";
import { sumLedger } from "./paymentLedger";

/**
 * Same guard the dashboard uses. Kept local rather than imported because that
 * one is a private helper inside dashboardAnalytics; lifting it into a shared
 * util is a tidy-up for its own commit, not something to fold into this one.
 */
async function requireVendorId(request: https.CallableRequest<unknown>): Promise<string> {
  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string | undefined;
  if (!vendorId) throw new https.HttpsError("failed-precondition", "Vendor ID could not be determined.");
  return vendorId;
}

/**
 * Reading the ledger.
 *
 * Revenue is the sum of one list, not two lists with a rule about which to
 * ignore. That is the whole point of the ledger, and it is why the double-count
 * problem disappears rather than being worked around: a payment recorded
 * against an invoice raised from an order is one row carrying both ids, so
 * however it is queried it is counted once.
 */

/** listPayments — the ledger for an invoice, an order, or the whole vendor. */
export const listPayments = https.onCall(async (request) => {
  checkAppCheck(request, "listPayments");
  const vendorId = await requireVendorId(request);

  const data = (request.data ?? {}) as Record<string, unknown>;
  const invoiceId = data.invoiceId as string | undefined;
  const orderId = data.orderId as string | undefined;

  let query = db.collection("payments").where("vendorId", "==", vendorId);
  if (invoiceId) query = query.where("invoiceId", "==", invoiceId);
  else if (orderId) query = query.where("orderId", "==", orderId);

  const snap = await query.orderBy("paidAt", "desc").limit(200).get();

  const payments = snap.docs.map((d) => {
    const p = d.data();
    return {
      paymentId: p.paymentId,
      amountMinorUnits: p.amountMinorUnits,
      currency: p.currency,
      type: p.type,
      status: p.status,
      method: p.method,
      reference: p.reference ?? null,
      orderId: p.orderId ?? null,
      invoiceId: p.invoiceId ?? null,
      reversesPaymentId: p.reversesPaymentId ?? null,
      reversalReason: p.reversalReason ?? null,
      recordedByRole: p.recordedByRole,
      paidAt: p.paidAt,
    };
  });

  return {
    success: true,
    payments,
    // Net of reversals, so it is what the vendor actually holds rather than
    // everything that was ever recorded.
    netMinorUnits: sumLedger(
      payments.map((p) => ({ amountMinorUnits: p.amountMinorUnits as number, type: p.type as "payment" | "reversal" }))
    ),
  };
});

/**
 * getVendorRevenue — ledger-backed totals for the dashboard.
 *
 * Phase 3 delivers correct totals. Analysis of them — comparisons, charts,
 * platform versus external — is Phase 5 and stays in getBusinessAnalytics,
 * behind its plan gate.
 */
export const getVendorRevenue = https.onCall(async (request) => {
  checkAppCheck(request, "getVendorRevenue");
  const vendorId = await requireVendorId(request);

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  /**
   * The lifetime total is read, not summed.
   *
   * This used to load every payment row the vendor had ever received on each
   * dashboard open. That is invisible at two hundred rows and a memory-limited
   * function at fifty thousand, so it degraded exactly as a vendor became
   * valuable. A limit() would have been the wrong fix — a truncated revenue
   * figure is wrong without looking wrong — so the total is maintained on the
   * vendor document by the two functions that write ledger rows.
   */
  const totalMinorUnits = await readVendorRevenueTotal(vendorId);

  // Today is still summed from rows, and that is fine: it is bounded by a date,
  // so it reads one day's payments rather than a lifetime of them.
  const todaySnap = await db
    .collection("payments")
    .where("vendorId", "==", vendorId)
    .where("paidAt", ">=", Timestamp.fromDate(startOfToday))
    .get();

  const todayRows = todaySnap.docs.map((d) => ({
    amountMinorUnits: d.data().amountMinorUnits as number,
    type: d.data().type as "payment" | "reversal",
    paidAt: d.data().paidAt as Timestamp | undefined,
    currency: d.data().currency as string | undefined,
  }));

  // Outstanding is what is still owed on live invoices, so cancelled ones are
  // excluded: a cancelled invoice is not a debt. Filtered in the query rather
  // than in memory, so a vendor with years of settled invoices reads only the
  // handful that are actually owed.
  const invoicesSnap = await db
    .collection("invoices")
    .where("vendorId", "==", vendorId)
    .where("status", "in", ["unpaid", "partial"])
    .get();

  // The status filter is in the query now, so every document here is owed.
  const outstandingMinorUnits = invoicesSnap.docs.reduce(
    (sum, d) => sum + ((d.data().balanceMinorUnits as number) ?? 0),
    0,
  );

  return {
    success: true,
    // A vendor trades in one currency, their country's, so a single code is
    // correct here rather than a per-row breakdown.
    currency: todayRows[0]?.currency ?? invoicesSnap.docs[0]?.data().currency ?? "NGN",
    todayMinorUnits: sumLedger(todayRows),
    totalMinorUnits,
    outstandingMinorUnits,
    // Today's count. The lifetime count would need the scan this change exists
    // to remove, and nothing displays it.
    paymentCount: todayRows.filter((r) => r.type === "payment").length,
  };
});
