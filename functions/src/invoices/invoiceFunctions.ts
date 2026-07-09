import * as crypto from "crypto";
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
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "createInvoice");
  const { uid, vendorId } = requireVendor(request);

  const { customerName, customerPhone, customerEmail, lineItems: rawItems, notes, currency } = request.data ?? {};
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
    customerId: null,
    customerName: customerName.trim(),
    customerPhone: customerPhone ?? null,
    customerEmail: customerEmail ?? null,
    lineItems,
    subtotal,
    currency: currency ?? "NGN",
    notes: notes?.trim() ?? null,
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
  const requestId = newRequestId();
  const appCheck = checkAppCheck(request, "updateInvoiceStatus");
  const { uid, vendorId } = requireVendor(request);
  const { invoiceId, status } = request.data ?? {};
  if (!invoiceId) throw new https.HttpsError("invalid-argument", "invoiceId is required.");
  if (status !== "paid" && status !== "cancelled") {
    throw new https.HttpsError("invalid-argument", "status must be 'paid' or 'cancelled'.");
  }

  const invoiceRef = db.collection("invoices").doc(invoiceId);
  const invoice = await loadOwnedInvoice(vendorId, invoiceId);
  if (invoice.status !== "unpaid") {
    throw new https.HttpsError("failed-precondition", `Cannot transition an invoice from "${invoice.status}" to "${status}".`);
  }

  const now = FieldValue.serverTimestamp();
  const updates: Record<string, unknown> = { status, updatedAt: now };

  if (status === "paid") {
    const { limits: planLimits } = await resolveEffectivePlan(vendorId);
    const brandingDoc = (await db.collection("invoiceBranding").doc(vendorId).get()).data() as InvoiceBrandingDoc | undefined;
    updates.brandingSnapshot = filterBrandingByPlan(brandingDoc, planLimits);
    updates.paidAt = now;
  } else {
    updates.cancelledAt = now;
  }

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
  return { success: true, invoice: publicSafe };
});
