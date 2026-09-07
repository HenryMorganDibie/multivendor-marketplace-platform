import { https } from "firebase-functions/v2";
import { db } from "../admin";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { enforceRateLimit } from "../subscriptions/rateLimit";

/**
 * deleteInvoice — removes a draft that was never issued.
 *
 * The app has offered "Delete Draft" all along with nothing behind it: it
 * filtered the local list while the screen rendered the backend list, so for a
 * real vendor the action neither deleted anything nor removed the row. It
 * looked broken because it was.
 *
 * Cancelling instead of deleting was the obvious shortcut, since
 * updateInvoiceStatus already does that. It is the wrong behaviour. A vendor
 * who starts an invoice, mistypes it and deletes it before sending expects it
 * gone, not a permanent cancelled row in their history. Cancellation is a real
 * event that happened to a real invoice someone received; a draft nobody ever
 * saw is not that.
 *
 * So this deletes, but only for an invoice that genuinely was never issued and
 * has no money against it:
 *
 *   - status must be unpaid — anything else has a ledger behind it
 *   - no payment rows at all, including reversed ones, since a reversal is
 *     still a record of something that happened
 *   - never delivered: no chat binding, no external share, never viewed
 *
 * Anything failing those is a document with history, and history is not
 * deletable — cancel it instead.
 *
 * The monthly quota is deliberately not refunded. It counts invoices created,
 * and one was. Refunding it would make the quota trivially avoidable by
 * creating and deleting in a loop.
 */
export const deleteInvoice = https.onCall(async (request) => {
  await enforceRateLimit(
    request.auth?.uid ?? `ip:${request.rawRequest?.ip ?? "unknown"}`,
    "deleteInvoice",
    20,
  );
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "deleteInvoice");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string | undefined;
  if (!vendorId) {
    throw new https.HttpsError("failed-precondition", "Vendor ID could not be determined.");
  }

  const { invoiceId } = (request.data ?? {}) as { invoiceId?: string };
  if (!invoiceId) throw new https.HttpsError("invalid-argument", "invoiceId is required.");

  const ref = db.collection("invoices").doc(invoiceId);
  const snap = await ref.get();
  if (!snap.exists) throw new https.HttpsError("not-found", "Invoice not found.");

  const invoice = snap.data() ?? {};
  // Ownership from the invoice, never from the request.
  if (invoice.vendorId !== vendorId) {
    throw new https.HttpsError("permission-denied", "You do not own this invoice.");
  }

  if (invoice.status !== "unpaid") {
    throw new https.HttpsError(
      "failed-precondition",
      `Only an unpaid draft can be deleted. This invoice is "${invoice.status}". Cancel it instead.`
    );
  }

  const issued = Boolean(
    invoice.chatId || invoice.sentInChatAt || invoice.sharedExternallyAt || invoice.viewedAt
  );
  if (issued) {
    throw new https.HttpsError(
      "failed-precondition",
      "This invoice has already been sent to a customer and cannot be deleted. Cancel it instead."
    );
  }

  // A single row is enough to refuse: it means money was recorded against this
  // invoice at some point, even if it was later reversed to zero.
  const ledger = await db.collection("payments").where("invoiceId", "==", invoiceId).limit(1).get();
  if (!ledger.empty) {
    throw new https.HttpsError(
      "failed-precondition",
      "This invoice has payments recorded against it and cannot be deleted. Cancel it instead."
    );
  }

  // Written before the delete so the record of what was removed survives it.
  await writeAuditLog({
    requestId,
    functionName: "deleteInvoice",
    actorUid: request.auth.uid,
    actorRole: "vendor",
    actorType: "vendor",
    targetType: "invoice",
    targetId: invoiceId,
    eventType: "invoice.deleted",
    before: {
      invoiceNumber: invoice.invoiceNumber,
      subtotal: invoice.subtotal,
      customerName: invoice.customerName,
    },
    appCheck,
  });

  await ref.delete();

  return { success: true, invoiceId };
});

/*
 * The invoice number is deliberately not reclaimed. Numbers come from a
 * per-vendor counter, and a gap is the honest record: number 7 was created and
 * removed. Reusing it would let two different documents have carried the same
 * number, which is the one thing an invoice number exists to prevent.
 */
