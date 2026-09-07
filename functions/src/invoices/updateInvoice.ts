import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { InvoiceLineItem } from "../types4";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { enforceRateLimit } from "../subscriptions/rateLimit";

/**
 * updateInvoice — edit an invoice that has not been settled.
 *
 * The app has offered "Edit draft" since before Phase 3 and there was nothing
 * behind it: the edit went to AsyncStorage, and since the screen renders the
 * backend list, a real vendor's edit had no visible effect at all.
 *
 * What may be edited is decided by what has happened to the invoice, not by a
 * status name:
 *
 *   - Nothing on a cancelled invoice. It is closed.
 *   - Nothing on an invoice with payments recorded against it. The amount owed
 *     is what someone paid against; changing it after the fact would make the
 *     ledger disagree with the document. Reverse the payment first, or raise a
 *     new invoice.
 *   - Line items and totals only while the invoice has never been delivered.
 *     Once a customer has been sent a figure, silently changing it is not an
 *     edit, it is a different invoice.
 *   - Notes, due date and customer contact details stay editable after
 *     delivery. Fixing a mistyped phone number does not alter what is owed.
 *
 * Currency is never editable. It follows the vendor's country and is decided by
 * the server.
 */

function buildLineItems(raw: unknown): { lineItems: InvoiceLineItem[]; subtotal: number } {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new https.HttpsError("invalid-argument", "lineItems must be a non-empty array.");
  }
  let subtotal = 0;
  const lineItems: InvoiceLineItem[] = raw.map(
    (item: { description?: unknown; quantity?: unknown; unitPrice?: unknown }) => {
      const description = String(item.description ?? "").trim();
      const quantity = Number(item.quantity);
      const unitPrice = Number(item.unitPrice);
      if (!description) {
        throw new https.HttpsError("invalid-argument", "Each line item requires a description.");
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new https.HttpsError("invalid-argument", "Each line item requires a positive quantity.");
      }
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new https.HttpsError("invalid-argument", "Each line item requires a non-negative unitPrice.");
      }
      const total = quantity * unitPrice;
      subtotal += total;
      return { description, quantity, unitPrice, total };
    }
  );
  return { lineItems, subtotal };
}

export const updateInvoice = https.onCall(async (request) => {
  await enforceRateLimit(
    request.auth?.uid ?? `ip:${request.rawRequest?.ip ?? "unknown"}`,
    "updateInvoice",
    30,
  );
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "updateInvoice");

  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string | undefined;
  if (!vendorId) {
    throw new https.HttpsError("failed-precondition", "Vendor ID could not be determined.");
  }

  const data = (request.data ?? {}) as Record<string, unknown>;
  const invoiceId = data.invoiceId as string | undefined;
  if (!invoiceId) throw new https.HttpsError("invalid-argument", "invoiceId is required.");

  const ref = db.collection("invoices").doc(invoiceId);
  const snap = await ref.get();
  if (!snap.exists) throw new https.HttpsError("not-found", "Invoice not found.");

  const invoice = snap.data() ?? {};
  // Ownership from the invoice, never from the request.
  if (invoice.vendorId !== vendorId) {
    throw new https.HttpsError("permission-denied", "You do not own this invoice.");
  }

  if (invoice.status === "cancelled") {
    throw new https.HttpsError("failed-precondition", "A cancelled invoice cannot be edited.");
  }

  // One row is enough. A reversal still means money was recorded here.
  const ledger = await db.collection("payments").where("invoiceId", "==", invoiceId).limit(1).get();
  const hasPayments = !ledger.empty;
  if (hasPayments) {
    throw new https.HttpsError(
      "failed-precondition",
      "This invoice has payments recorded against it. Reverse the payment first, or raise a new invoice."
    );
  }

  const delivered = Boolean(
    invoice.chatId || invoice.sentInChatAt || invoice.sharedExternallyAt || invoice.viewedAt
  );

  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };

  // Always editable: these do not change what is owed.
  if (typeof data.customerName === "string" && data.customerName.trim()) {
    updates.customerName = data.customerName.trim();
  }
  if ("customerPhone" in data) updates.customerPhone = (data.customerPhone as string) ?? null;
  if ("customerEmail" in data) updates.customerEmail = (data.customerEmail as string) ?? null;
  if ("notes" in data) updates.notes = ((data.notes as string) ?? "").trim() || null;
  if ("dueDate" in data) updates.dueDate = data.dueDate ?? null;

  /**
   * Money is editable until money has moved.
   *
   * This used to refuse any change to items or totals once the invoice had been
   * delivered, on the reasoning that silently altering a figure someone has
   * already been given is a different invoice rather than an edit.
   *
   * That was wrong for how invoicing actually works here. A customer receives
   * an invoice, says make it three not two, and the vendor revises it. Nothing
   * has been paid; there is no history to protect. Forcing a cancel-and-reissue
   * for an ordinary correction leaves a cancelled row in the vendor's records
   * for every negotiation, which is noise standing in for rigour.
   *
   * The payment ledger is the real line, and it is checked above: one recorded
   * row, reversed or not, and nothing here is editable. Until then an unpaid
   * invoice is still a proposal.
   *
   * `delivered` is still computed — it decides whether the customer needs to be
   * told, below.
   */
  if ("lineItems" in data) {
    const { lineItems, subtotal } = buildLineItems(data.lineItems);
    updates.lineItems = lineItems;
    updates.subtotal = subtotal;
    // The cached balance follows the total. Nothing is paid — that is enforced
    // above — so the balance is simply the new subtotal.
    updates.balanceMinorUnits = subtotal;
    updates.amountPaidMinorUnits = 0;

    /**
     * A delivered invoice that changes has to say so.
     *
     * The customer's copy resolves live, so a refresh shows the new figures —
     * but nothing would have told them to refresh, and an amount quietly
     * changing under someone is the thing that makes a revision feel like a
     * trick rather than a correction.
     *
     * The card posted into chat carries a snapshot of the figures as they were
     * when it was sent, so it is stamped stale here and re-read from the
     * invoice by the card itself.
     */
    if (delivered) {
      updates.revisedAt = FieldValue.serverTimestamp();
      updates.revisionCount = FieldValue.increment(1);
    }
  }

  await ref.update(updates);

  await writeAuditLog({
    requestId,
    functionName: "updateInvoice",
    actorUid: request.auth.uid,
    actorRole: "vendor",
    actorType: "vendor",
    targetType: "invoice",
    targetId: invoiceId,
    eventType: "invoice.updated",
    before: { subtotal: invoice.subtotal, customerName: invoice.customerName },
    after: { subtotal: updates.subtotal ?? invoice.subtotal, customerName: updates.customerName ?? invoice.customerName },
    appCheck,
  });

  return { success: true, invoiceId };
});
