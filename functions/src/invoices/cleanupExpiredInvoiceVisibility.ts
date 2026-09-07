import { onSchedule } from "firebase-functions/v2/scheduler";
import { db, FieldValue, Timestamp } from "../admin";
import { InvoiceDoc } from "../types4";
import { resolveEffectivePlan } from "../subscriptions/resolveEffectivePlan";
import { logOperationalEvent } from "../utils/operationalLogging";

/**
 * cleanupExpiredInvoiceVisibility (Phase 4, Section 10).
 *
 * invoiceHistoryDays governs how long an invoice stays visible via
 * listInvoices, not a deletion deadline — a paid invoice is a financial record
 * and an automatic job must never destroy one. Documents past their plan's
 * window are marked hiddenFromHistory rather than removed.
 *
 * Bounded, deliberately. This used to read every not-yet-hidden invoice on the
 * platform into memory in one query, then update matches one at a time. That is
 * fine at a few thousand and becomes a function that times out and a bill that
 * grows with the whole invoice collection rather than with the work actually
 * needing doing.
 *
 * Three things fix that:
 *
 *   - The query only asks for invoices old enough to possibly qualify. The
 *     longest window any plan grants bounds it, so a recent invoice is never
 *     read at all.
 *   - Results are paged, so memory is one page rather than the collection.
 *   - Updates are batched instead of a round trip each.
 *
 * The per-invoice plan check stays: the coarse filter only rules out invoices
 * too new for any plan, and a vendor on a shorter window still needs theirs
 * applied.
 */

const PAGE_SIZE = 500;
const BATCH_SIZE = 400;

/**
 * The most generous invoiceHistoryDays across all plans, read once per run.
 *
 * An invoice younger than this cannot have expired under any plan, so it does
 * not need reading. Falls back to a year if plans cannot be read — wide enough
 * to be safe, since being too generous only means scanning more, while being
 * too tight would silently skip invoices that should have been hidden.
 */
async function longestHistoryWindowDays(): Promise<number> {
  try {
    const snap = await db.collection("subscriptionPlans").get();
    const windows = snap.docs
      .map((d) => Number(d.data().invoiceHistoryDays))
      .filter((n) => Number.isFinite(n) && n > 0);
    return windows.length ? Math.max(...windows) : 365;
  } catch {
    return 365;
  }
}

export const cleanupExpiredInvoiceVisibility = onSchedule("every day 04:00", async () => {
  const maxWindowDays = await longestHistoryWindowDays();
  const cutoff = Timestamp.fromMillis(Date.now() - maxWindowDays * 24 * 60 * 60 * 1000);

  const planWindowCache = new Map<string, number>();
  let hiddenCount = 0;
  let examined = 0;
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  for (;;) {
    let query = db
      .collection("invoices")
      .where("hiddenFromHistory", "==", false)
      .where("createdAt", "<", cutoff)
      .orderBy("createdAt", "asc")
      .limit(PAGE_SIZE);

    if (cursor) query = query.startAfter(cursor);

    const page = await query.get();
    if (page.empty) break;

    let batch = db.batch();
    let pending = 0;

    for (const doc of page.docs) {
      examined += 1;
      const invoice = doc.data() as InvoiceDoc;

      let historyDays = planWindowCache.get(invoice.vendorId);
      if (historyDays === undefined) {
        const { limits } = await resolveEffectivePlan(invoice.vendorId);
        historyDays = limits.invoiceHistoryDays;
        planWindowCache.set(invoice.vendorId, historyDays);
      }

      const createdAtMs =
        invoice.createdAt && "toMillis" in invoice.createdAt
          ? (invoice.createdAt as Timestamp).toMillis()
          : 0;

      if (Date.now() - createdAtMs > historyDays * 24 * 60 * 60 * 1000) {
        batch.update(doc.ref, {
          hiddenFromHistory: true,
          updatedAt: FieldValue.serverTimestamp(),
        });
        hiddenCount += 1;
        pending += 1;

        if (pending >= BATCH_SIZE) {
          await batch.commit();
          batch = db.batch();
          pending = 0;
        }
      }
    }

    if (pending > 0) await batch.commit();

    cursor = page.docs[page.docs.length - 1];
    if (page.size < PAGE_SIZE) break;
  }

  logOperationalEvent({
    functionName: "cleanupExpiredInvoiceVisibility",
    event: "scheduled_run_complete",
    severity: "WARNING",
    metadata: { examined, hiddenCount, maxWindowDays },
  });
});
