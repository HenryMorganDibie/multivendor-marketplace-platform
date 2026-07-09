import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, FieldValue, Timestamp } from "../admin";
import { InvoiceDoc } from "../types4";
import { resolveEffectivePlan } from "../subscriptions/resolveEffectivePlan";
import { logOperationalEvent } from "../utils/operationalLogging";

/**
 * cleanupExpiredInvoiceVisibility (Phase 4, Section 10).
 *
 * invoiceHistoryDays governs how long an invoice remains visible via
 * listInvoices, NOT a hard deletion deadline — paid invoices are
 * financial records that must never be destroyed by an automatic job.
 * Marks documents past their plan's invoiceHistoryDays window with
 * hiddenFromHistory: true rather than deleting them.
 */
export const cleanupExpiredInvoiceVisibility = onSchedule("every day 04:00", async () => {
  const candidatesSnap = await db.collection("invoices").where("hiddenFromHistory", "==", false).get();

  let hiddenCount = 0;
  const planLimitsCache = new Map<string, number>();

  for (const doc of candidatesSnap.docs) {
    const invoice = doc.data() as InvoiceDoc;
    let historyDays = planLimitsCache.get(invoice.vendorId);
    if (historyDays === undefined) {
      const { limits } = await resolveEffectivePlan(invoice.vendorId);
      historyDays = limits.invoiceHistoryDays;
      planLimitsCache.set(invoice.vendorId, historyDays);
    }

    const createdAtMs = invoice.createdAt && "toMillis" in invoice.createdAt ? (invoice.createdAt as Timestamp).toMillis() : 0;
    const ageMs = Date.now() - createdAtMs;
    if (ageMs > historyDays * 24 * 60 * 60 * 1000) {
      await doc.ref.update({ hiddenFromHistory: true, updatedAt: FieldValue.serverTimestamp() });
      hiddenCount++;
    }
  }

  logOperationalEvent({
    functionName: "cleanupExpiredInvoiceVisibility",
    event: "scheduled_run_complete",
    severity: "WARNING",
    metadata: { candidateCount: candidatesSnap.size, hiddenCount },
  });
});
