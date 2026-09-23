import * as crypto from "crypto";
import * as admin from "firebase-admin";
import { https } from "firebase-functions/v2";
import { db, FieldValue } from "../admin";
import { InvoiceBrandingDoc, InvoiceDoc, InvoiceLineItem } from "../types4";
import { checkAppCheck } from "../utils/appCheck";
import { writeAuditLog } from "../utils/auditLog";
import { newRequestId } from "../utils/requestContext";
import { resolveEffectivePlan } from "../subscriptions/resolveEffectivePlan";
import { consumeInvoiceQuota } from "./invoiceQuota";
import { getNextInvoiceNumber } from "../orders/orderNumbers";
import { renderInvoicePdf, filterBrandingByPlan } from "./invoicePdf";
import { enforceRateLimit } from "../subscriptions/rateLimit";
import { resolveVendorCurrency } from "../vendors/vendorCurrency";
import { requireBillingEligibleVendor } from "../vendors/requireBillingEligible";

function requireVendor(request: https.CallableRequest<unknown>): { uid: string; vendorId: string } {
  if (!request.auth || request.auth.token.role !== "vendor") {
    throw new https.HttpsError("permission-denied", "Vendors only.");
  }
  const vendorId = request.auth.token.vendorId as string | undefined;
  if (!vendorId) throw new https.HttpsError("failed-precondition", "Vendor ID could not be determined.");
  return { uid: request.auth.uid, vendorId };
}

function buildLineItems(raw: unknown): { lineItems: InvoiceLineItem[]; subtotal: number } {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new https.HttpsError("invalid-argument", "lineItems must be a non-empty array.");
  }
  let subtotal = 0;
  const lineItems: InvoiceLineItem[] = raw.map((item: { description?: unknown; quantity?: unknown; unitPrice?: unknown }) => {
    const description = String(item.description ?? "").trim();
    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unitPrice);
    if (!description) throw new https.HttpsError("invalid-argument", "Each line item requires a description.");
    if (!Number.isFinite(quantity) || quantity <= 0) throw new https.HttpsError("invalid-argument", "Each line item requires a positive quantity.");
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new https.HttpsError("invalid-argument", "Each line item requires a non-negative unitPrice.");
    const total = quantity * unitPrice;
    subtotal += total;
    return { description, quantity, unitPrice, total };
  });
  return { lineItems, subtotal };
}

/**
 * createInvoice (Phase 4, Section 2.3). Gated by invoicesPerMonth, counted
 * against a UTC-calendar-month counter (invoiceQuota.ts), never a client-
 * supplied or server-computed-from-a-scan count.
 */
export const createInvoice = https.onCall(async (request) => {
  await enforceRateLimit(
    request.auth?.uid ?? `ip:${request.rawRequest?.ip ?? "unknown"}`,
    "createInvoice",
    20,
  );
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "createInvoice");
  const { uid, vendorId } = requireVendor(request);
  await requireBillingEligibleVendor(vendorId);

  // currency is deliberately not read from the request. A vendor invoices in
  // their own country's currency, which the server knows; taking it from the
  // caller meant an app sending a hardcoded "NGN" gave a vendor in the United
  // States naira invoices while their subscription correctly showed dollars.
  const { customerName, customerPhone, customerEmail, lineItems: rawItems, notes, customerId, conversationId, dueDate } = request.data ?? {};
  if (!customerName || typeof customerName !== "string" || !customerName.trim()) {
    throw new https.HttpsError("invalid-argument", "customerName is required.");
  }
  const { lineItems, subtotal } = buildLineItems(rawItems);

  const { limits: planLimits } = await resolveEffectivePlan(vendorId);
  await consumeInvoiceQuota(vendorId, planLimits.invoicesPerMonth);

  const vendorSnap = await db.collection("vendors").doc(vendorId).get();
  const vendor = vendorSnap.data();
  const invoiceNumber = await getNextInvoiceNumber(vendorId, vendor?.slug ?? vendor?.username ?? vendorId);

  const invoiceRef = db.collection("invoices").doc();
  const now = FieldValue.serverTimestamp();
  const invoice: InvoiceDoc = {
    invoiceId: invoiceRef.id,
    invoiceNumber,
    vendorId,
    /**
     * The bound Platform customer, when the vendor picked one.
     *
     * This was the literal `null`, while the Create Invoice screen has always
     * had a "Platform customer" mode with a customer picker that reads the
     * vendor's real chats. The screen collected a customerId and a
     * conversationId and the backend threw both away, so an invoice raised
     * against a real customer arrived indistinguishable from one typed by hand.
     * That is why the "Open chat" action on the detail screen could never fire:
     * chatId was never written by anything.
     *
     * Storing them does not by itself deliver an invoice into a chat — nothing
     * posts the invoice card yet, and that remains unbuilt. It does stop the
     * binding being lost, which is the part that made the feature impossible to
     * finish incrementally.
     *
     * Both are validated as strings and otherwise stored as given; ownership of
     * the conversation is checked when a card is actually posted into it, which
     * is where it matters.
     */
    customerId: typeof customerId === "string" && customerId.trim() ? customerId.trim() : null,
    conversationId:
      typeof conversationId === "string" && conversationId.trim() ? conversationId.trim() : null,
    customerName: customerName.trim(),
    customerPhone: customerPhone ?? null,
    customerEmail: customerEmail ?? null,
    lineItems,
    subtotal,
    currency: await resolveVendorCurrency(vendor ?? {}),
    notes: notes?.trim() ?? null,
    // Same field updateInvoice.ts already writes - create-invoice.tsx has
    // always collected a due date on this screen, but this callable never
    // accepted it, so it was silently dropped for every new invoice and only
    // ever recoverable by immediately editing the invoice right after.
    dueDate: typeof dueDate === "string" && dueDate.trim() ? dueDate.trim() : null,
    status: "unpaid",
    paidAt: null,
    cancelledAt: null,
    brandingSnapshot: null,
    hiddenFromHistory: false,
    shareToken: crypto.randomBytes(16).toString("hex"),
    createdAt: now,
    updatedAt: now,
  };
  await invoiceRef.set(invoice);

  await writeAuditLog({
    requestId,
    functionName: "createInvoice",
    actorUid: uid,
    actorRole: "vendor",
    actorType: "vendor",
    targetType: "invoice",
    targetId: invoiceRef.id,
    eventType: "invoice.created",
    after: { invoiceNumber, subtotal },
    appCheck,
  });

  return { success: true, invoiceId: invoiceRef.id, invoiceNumber };
});

/** listInvoices (Phase 4, Section 2.3) — search/filters are not gated;
 * the invoiceHistoryDays limit is enforced upstream by
 * cleanupExpiredInvoiceVisibility setting hiddenFromHistory, not here. */
export const listInvoices = https.onCall(async (request) => {
  checkAppCheck(request, "listInvoices");
  const { vendorId } = requireVendor(request);

  const { status } = (request.data as { status?: string } | undefined) ?? {};
  let query = db.collection("invoices").where("vendorId", "==", vendorId).where("hiddenFromHistory", "==", false);
  if (status) query = query.where("status", "==", status);

  const snap = await query.orderBy("createdAt", "desc").get();
  return { success: true, invoices: snap.docs.map((d) => d.data()) };
});

async function loadOwnedInvoice(vendorId: string, invoiceId: string): Promise<InvoiceDoc> {
  const snap = await db.collection("invoices").doc(invoiceId).get();
  if (!snap.exists) throw new https.HttpsError("not-found", "Invoice not found.");
  const invoice = snap.data() as InvoiceDoc;
  if (invoice.vendorId !== vendorId) throw new https.HttpsError("permission-denied", "You do not own this invoice.");
  return invoice;
}

/** downloadInvoicePdf (Phase 4, Section 2.3) — gated by canDownloadInvoicePdf.
 * A paid invoice always renders with its permanent brandingSnapshot; an
 * unpaid invoice renders with current branding filtered through the
 * vendor's CURRENT plan (Section 10 guarantee). */
export const downloadInvoicePdf = https.onCall(async (request) => {
  checkAppCheck(request, "downloadInvoicePdf");
  const { vendorId } = requireVendor(request);
  const { invoiceId } = request.data ?? {};
  if (!invoiceId) throw new https.HttpsError("invalid-argument", "invoiceId is required.");

  const { limits: planLimits } = await resolveEffectivePlan(vendorId);
  if (!planLimits.canDownloadInvoicePdf) {
    throw new https.HttpsError("permission-denied", "Downloading invoice PDFs is not available on your current plan.");
  }

  const invoice = await loadOwnedInvoice(vendorId, invoiceId);
  const branding = invoice.status === "paid" && invoice.brandingSnapshot
    ? invoice.brandingSnapshot
    : filterBrandingByPlan((await db.collection("invoiceBranding").doc(vendorId).get()).data(), planLimits);

  const pdfBuffer = await renderInvoicePdf(invoice, branding);
  return { success: true, pdfBase64: pdfBuffer.toString("base64"), fileName: `${invoice.invoiceNumber}.pdf` };
});

/** duplicateInvoice (Phase 4, Section 2.3) — gated by canDuplicateInvoice.
 * Counts against the same monthly quota as any other new invoice. */
export const duplicateInvoice = https.onCall(async (request) => {
  await enforceRateLimit(
    request.auth?.uid ?? `ip:${request.rawRequest?.ip ?? "unknown"}`,
    "duplicateInvoice",
    20,
  );
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "duplicateInvoice");
  const { uid, vendorId } = requireVendor(request);
  const { invoiceId } = request.data ?? {};
  if (!invoiceId) throw new https.HttpsError("invalid-argument", "invoiceId is required.");

  const { limits: planLimits } = await resolveEffectivePlan(vendorId);
  if (!planLimits.canDuplicateInvoice) {
    throw new https.HttpsError("permission-denied", "Duplicating invoices is not available on your current plan.");
  }

  const source = await loadOwnedInvoice(vendorId, invoiceId);
  await consumeInvoiceQuota(vendorId, planLimits.invoicesPerMonth);

  const vendorSnap = await db.collection("vendors").doc(vendorId).get();
  const vendor = vendorSnap.data();
  const invoiceNumber = await getNextInvoiceNumber(vendorId, vendor?.slug ?? vendor?.username ?? vendorId);

  const invoiceRef = db.collection("invoices").doc();
  const now = FieldValue.serverTimestamp();
  const invoice: InvoiceDoc = {
    ...source,
    invoiceId: invoiceRef.id,
    invoiceNumber,
    status: "unpaid",
    paidAt: null,
    cancelledAt: null,
    brandingSnapshot: null,
    hiddenFromHistory: false,
    shareToken: crypto.randomBytes(16).toString("hex"),
    createdAt: now,
    updatedAt: now,
  };
  await invoiceRef.set(invoice);

  await writeAuditLog({
    requestId,
    functionName: "duplicateInvoice",
    actorUid: uid,
    actorRole: "vendor",
    actorType: "vendor",
    targetType: "invoice",
    targetId: invoiceRef.id,
    eventType: "invoice.duplicated",
    metadata: { sourceInvoiceId: invoiceId },
    appCheck,
  });

  return { success: true, invoiceId: invoiceRef.id, invoiceNumber };
});

/** updateInvoiceStatus — marks an invoice paid (capturing a permanent
 * branding snapshot) or cancelled. Not an explicitly numbered Section 5
 * function in the spec, but required for the paid/cancelled states the
 * spec's own edge cases (brandingSnapshot, public link revocation) assume
 * are reachable. */
export const updateInvoiceStatus = https.onCall(async (request) => {
  await enforceRateLimit(
    request.auth?.uid ?? `ip:${request.rawRequest?.ip ?? "unknown"}`,
    "updateInvoiceStatus",
    30,
  );
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "updateInvoiceStatus");
  const { uid, vendorId } = requireVendor(request);
  const { invoiceId, status } = request.data ?? {};
  if (!invoiceId) throw new https.HttpsError("invalid-argument", "invoiceId is required.");

  /**
   * "paid" is no longer settable.
   *
   * Payment status is derived from the ledger now, so writing it directly would
   * put the invoice at odds with the payments behind it — an invoice marked
   * paid with nothing recorded against it, and revenue that disagrees with the
   * invoice list. Marking an invoice paid means recording the money that was
   * actually received.
   *
   * The client keeps its one-tap button; it calls recordPayment for the
   * outstanding balance instead of writing a status.
   *
   * "cancelled" stays, because that is a genuine status change rather than a
   * financial event.
   */
  if (status === "paid") {
    throw new https.HttpsError(
      "invalid-argument",
      "Invoices are marked paid by recording a payment. Call recordPayment with the outstanding balance."
    );
  }
  if (status !== "cancelled") {
    throw new https.HttpsError("invalid-argument", "status must be 'cancelled'.");
  }

  const invoiceRef = db.collection("invoices").doc(invoiceId);
  const invoice = await loadOwnedInvoice(vendorId, invoiceId);
  if (invoice.status !== "unpaid") {
    throw new https.HttpsError("failed-precondition", `Cannot transition an invoice from "${invoice.status}" to "${status}".`);
  }

  const now = FieldValue.serverTimestamp();

  // Cancellation is the only transition left here. Branding used to be
  // snapshotted on the "paid" branch; that moved to recomputeInvoiceFromLedger,
  // which is what decides an invoice is settled now.
  const updates: Record<string, unknown> = {
    status,
    cancelledAt: now,
    updatedAt: now,
  };

  await invoiceRef.update(updates);

  await writeAuditLog({
    requestId,
    functionName: "updateInvoiceStatus",
    actorUid: uid,
    actorRole: "vendor",
    actorType: "vendor",
    targetType: "invoice",
    targetId: invoiceId,
    eventType: `invoice.${status}`,
    appCheck,
  });

  return { success: true };
});

/** getPublicInvoice — the sanctioned read path behind "Share Invoice"
 * public links (not gated, all plans). Checks status before rendering
 * anything: a cancelled invoice returns access-revoked rather than its
 * content, per the spec's edge case. */
export const getPublicInvoice = https.onCall(async (request) => {
  checkAppCheck(request, "getPublicInvoice");
  const { shareToken } = request.data ?? {};
  if (!shareToken || typeof shareToken !== "string") {
    throw new https.HttpsError("invalid-argument", "shareToken is required.");
  }

  const snap = await db.collection("invoices").where("shareToken", "==", shareToken).limit(1).get();
  if (snap.empty) throw new https.HttpsError("not-found", "Invoice not found.");
  const invoice = snap.docs[0].data() as InvoiceDoc;

  if (invoice.status === "cancelled") {
    throw new https.HttpsError("failed-precondition", "This invoice has been cancelled and is no longer accessible.");
  }

  const { shareToken: _shareToken, ...publicSafe } = invoice;

  /**
   * Branding travels with the invoice.
   *
   * It lives in its own document, so a customer opening a shared link got an
   * unbranded page while the PDF of the same invoice carried the vendor's logo
   * and colours — the same document looking like two different businesses.
   *
   * A settled invoice uses the snapshot frozen when it was paid, so a receipt
   * keeps the look it had at the time and a later rebrand or downgrade cannot
   * restyle history. Anything unsettled uses current branding filtered through
   * the vendor's current plan, which is the same rule the PDF renderer applies.
   */
  const { limits } = await resolveEffectivePlan(invoice.vendorId);
  const branding =
    invoice.status === "paid" && invoice.brandingSnapshot
      ? invoice.brandingSnapshot
      : filterBrandingByPlan(
        (await db.collection("invoiceBranding").doc(invoice.vendorId).get()).data(),
        limits,
      );

  /**
   * The logo is stored as a path, not a URL, and Storage rules let only the
   * vendor read it. A customer's browser therefore cannot load it, and the
   * public page would render a broken image where a business logo should be.
   *
   * Signed here for a week. Long enough that a link mailed on Friday still
   * shows the logo when it is opened on Monday, short enough that a URL copied
   * out of the page stops working rather than becoming permanent hosting.
   *
   * A failure to sign is not a failure to show the invoice — the logo is
   * dropped and the rest renders.
   */
  let brandingForCustomer = branding ?? null;
  const logoPath = (brandingForCustomer as { logoUrl?: string } | null)?.logoUrl;
  if (logoPath && !logoPath.startsWith("http")) {
    try {
      const [signed] = await admin
        .storage()
        .bucket()
        .file(logoPath)
        .getSignedUrl({ action: "read", expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
      brandingForCustomer = { ...brandingForCustomer, logoUrl: signed };
    } catch {
      brandingForCustomer = { ...brandingForCustomer, logoUrl: null };
    }
  }

  return { success: true, invoice: publicSafe, branding: brandingForCustomer };
});
