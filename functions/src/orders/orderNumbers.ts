import { db, FieldValue } from "../admin";

export async function getNextOrderNumber(vendorId: string, slug: string, type: "internal" | "external"): Promise<string> {
  const seqRef = db.collection("vendorSequences").doc(vendorId);
  const field = type === "external" ? "externalOrderSequence" : "orderSequence";
  let nextSeq = 1;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(seqRef);
    const current = snap.exists ? (snap.data()?.[field] ?? 0) : 0;
    nextSeq = current + 1;
    if (snap.exists) {
      tx.update(seqRef, { [field]: nextSeq, updatedAt: FieldValue.serverTimestamp() });
    } else {
      tx.set(seqRef, { vendorId, orderSequence: type === "internal" ? nextSeq : 0, externalOrderSequence: type === "external" ? nextSeq : 0, receiptSequence: 0, updatedAt: FieldValue.serverTimestamp() });
    }
  });
  const upperSlug = slug.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  return type === "external" ? `${upperSlug}-EXT-${String(nextSeq).padStart(6, "0")}` : `${upperSlug}-${nextSeq}`;
}

export async function getNextReceiptNumber(vendorId: string, slug: string): Promise<string> {
  const seqRef = db.collection("vendorSequences").doc(vendorId);
  const upperSlug = slug.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  let nextSeq = 1;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(seqRef);
    const current = snap.exists ? (snap.data()?.receiptSequence ?? 0) : 0;
    nextSeq = current + 1;
    if (snap.exists) {
      tx.update(seqRef, { receiptSequence: nextSeq, updatedAt: FieldValue.serverTimestamp() });
    } else {
      tx.set(seqRef, { vendorId, orderSequence: 0, externalOrderSequence: 0, receiptSequence: nextSeq, updatedAt: FieldValue.serverTimestamp() });
    }
  });
  // {vendorSlug}-RCT-{seq}, no year, no zero-padding — matches order/invoice
  // numbering convention. Never uses a platform-branded prefix (the platform is
  // the platform, not the merchant). Sequence only ever increases, per
  // vendor, never reused (LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md Section
  // 4.4/13.7).
  return `${upperSlug}-RCT-${nextSeq}`;
}

export async function getNextInvoiceNumber(vendorId: string, slug: string): Promise<string> {
  const seqRef = db.collection("vendorSequences").doc(vendorId);
  const upperSlug = slug.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  let nextSeq = 1;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(seqRef);
    const current = snap.exists ? (snap.data()?.invoiceSequence ?? 0) : 0;
    nextSeq = current + 1;
    if (snap.exists) {
      tx.update(seqRef, { invoiceSequence: nextSeq, updatedAt: FieldValue.serverTimestamp() });
    } else {
      tx.set(seqRef, { vendorId, orderSequence: 0, externalOrderSequence: 0, receiptSequence: 0, invoiceSequence: nextSeq, updatedAt: FieldValue.serverTimestamp() });
    }
  });
  // {vendorSlug}-INV-{seq}, no year, no zero-padding — matches the order-ID
  // convention exactly (same 10-char slug truncation as getNextOrderNumber).
  // Immutable once issued: this is generated once, at invoice creation,
  // and never regenerated if the vendor later changes their slug.
  return `${upperSlug}-INV-${nextSeq}`;
}
